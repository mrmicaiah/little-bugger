// Content script. Runs in every claude.ai tab. Owns:
//   - block detection (MutationObserver + debounce + streaming-completion check)
//   - dispatch to daemon
//   - polling for results
//   - injecting the worker result back into the chat input
//
// State lives in this script's globals — lost on tab refresh, which is the
// intended behavior per SPEC §"What's out of scope for v0".
//
// DISPATCH TAG: blocks tagged ```PROMPT (case-insensitive) are dispatched.
// See selectors.ts for the rationale behind the tag choice.

import {
  findMessageStream,
  findAssistantMessages,
  findBuggerBlocks,
  extractBlockContent,
  findContainingMessage,
  isMessageStillStreaming,
  findInputTextarea,
  findSendButton,
} from "./lib/selectors.js";
import * as daemon from "./lib/daemonClient.js";
import type { Job, JobPhase } from "./lib/daemonClient.js";
import * as statusPill from "./lib/statusPill.js";

// --- module-level state -----------------------------------------------------

const DEBOUNCE_MS = 500;
const STREAM_WAIT_MAX_MS = 30_000;

// Dispatched block ids → in-flight job ids. Prevents re-dispatching the same
// block when MO fires multiple times for it.
const dispatchedBlocks = new Map<string, string>();

// Debounce timers keyed by the block DOM node.
const blockDebouncers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

// Content-level dedupe by hash-of-content. claude.ai re-renders chat history
// elements; each re-render produces a fresh DOM element with no
// data-bugger-handled attribute. The element-level mark is therefore not a
// reliable dedupe across re-renders. Content-level dedupe is. Set is
// per-content-script (per-tab), reset on tab reload.
const dispatchedContent = new Set<string>();

// Single-flight gate.
let dispatchInFlight = false;

// Monotonic counter for assigning ordinals to assistant messages we observe.
let messageOrdinalCounter = 0;

let myTabBinding: string | null = null;
let autoSubmit = true;

// Init-scan flag.
let initScanComplete = false;

// --- bootstrap --------------------------------------------------------------

async function init(): Promise<void> {
  // Get binding and settings from the service worker. This was the original
  // working path. An earlier refactor tried reading storage directly and
  // broke the binding path entirely — restored.
  try {
    const bindingResp = await chrome.runtime.sendMessage({ type: "getBindingForMe" });
    myTabBinding = bindingResp?.project ?? null;
  } catch {
    myTabBinding = null;
  }
  try {
    const settingsResp = await chrome.runtime.sendMessage({ type: "getSettings" });
    autoSubmit = settingsResp?.autoSubmit ?? true;
  } catch {
    autoSubmit = true;
  }

  // Listen for binding / settings updates and popup-driven requests.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "bindingChanged") {
      myTabBinding = msg.project ?? null;
      return;
    }
    if (msg?.type === "settingsChanged") {
      autoSubmit = msg.autoSubmit ?? true;
      return;
    }
    if (msg?.type === "checkInputClear") {
      const input = findInputTextarea();
      if (!input) {
        sendResponse({ clear: false, error: "input not found" });
        return;
      }
      const clear = readEditorContent(input).trim().length === 0;
      sendResponse({ clear });
      return;
    }
    if (msg?.type === "injectPending") {
      void (async () => {
        try {
          const ok = await injectResult(msg.job as Job);
          sendResponse(ok ? { ok: true } : { ok: false, error: "injection aborted" });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true; // async response
    }
  });

  // Wait for the message stream container to appear (claude.ai's SPA).
  const stream = await waitForMessageStream();
  if (!stream) {
    console.warn("[bugger] message stream container not found after 30s; extension idle");
    return;
  }

  // Wait for DOM to actually have content before scanning. claude.ai is an
  // SPA — at document_idle, the page shell may exist but message history
  // hasn't hydrated yet.
  await waitForBlocksToRender();

  // Initial scan: mark all pre-existing PROMPT blocks as seen so we never
  // re-dispatch historical content on extension reload or tab restore.
  scanInitial();
  initScanComplete = true;

  // Attach the observer AFTER initScanComplete is set.
  const observer = new MutationObserver(handleMutations);
  observer.observe(stream, { childList: true, subtree: true, characterData: true });

  console.log(
    `[bugger] content script ready (observing <${stream.tagName.toLowerCase()}>, ` +
      `binding=${myTabBinding ?? "(unbound)"})`,
  );
}

async function waitForBlocksToRender(): Promise<void> {
  // Wait up to 5 seconds for at least one PROMPT block to appear, OR for
  // claude.ai's chat surface to have ANY assistant message rendered.
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const hasPromptBlocks =
      document.querySelector('[aria-label="PROMPT code" i]') !== null;
    const hasAssistantMessages = findAssistantMessages().length > 0 ||
      document.querySelector("[data-test-render-count]") !== null;
    if (hasPromptBlocks || hasAssistantMessages) return;
    await sleep(100);
  }
}

async function waitForMessageStream(): Promise<Element | null> {
  const start = Date.now();
  while (Date.now() - start < STREAM_WAIT_MAX_MS) {
    const stream = findMessageStream();
    if (stream) return stream;
    await sleep(500);
  }
  return null;
}

function scanInitial(): void {
  // Global scan: every PROMPT block in the document gets marked as seen,
  // regardless of whether it lives inside a [data-is-streaming] wrapper.
  // claude.ai does NOT put data-is-streaming on completed historical turns,
  // so the prior version (which only iterated findAssistantMessages())
  // missed every block in chat history. On extension reload that caused
  // historical blocks to re-dispatch via MutationObserver.
  //
  // Also pre-populate dispatchedContent so content-level dedupe catches
  // re-renders of the same prompt.
  const allBlocks = document.querySelectorAll<HTMLElement>(
    '[aria-label="PROMPT code" i], pre code[class*="language-PROMPT" i]',
  );
  let markedCount = 0;
  for (const candidate of allBlocks) {
    const block = candidate.matches('[aria-label="PROMPT code" i]')
      ? candidate
      : (candidate.closest('[aria-label="PROMPT code" i]') ?? candidate.closest("pre") ?? candidate);
    if (block.getAttribute("data-bugger-handled")) continue;
    block.setAttribute("data-bugger-handled", "init-scan");
    markedCount++;
    const content = extractBlockContent(block).replace(/\s+$/, "");
    if (content) dispatchedContent.add(content);
  }

  const messages = findAssistantMessages();
  for (const msg of messages) {
    getOrAssignMessageOrdinal(msg);
  }

  console.log(
    `[bugger] init scan: ${markedCount} historical PROMPT block(s) marked as seen, ` +
      `${messages.length} streaming-wrapper message(s) found`,
  );
}

// --- mutation handling ------------------------------------------------------

function handleMutations(mutations: MutationRecord[]): void {
  const blocksToCheck = new Set<Element>();

  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      const newMessages = isAssistantMessage(el) ? [el] : findAssistantMessages(el);
      for (const m of newMessages) getOrAssignMessageOrdinal(m);
      const newBlocks = isCodeBlock(el)
        ? findBuggerBlocksMatchingNode(el)
        : findBuggerBlocksIn(el);
      for (const b of newBlocks) blocksToCheck.add(b);
    }
    if (mut.target.nodeType === Node.ELEMENT_NODE) {
      const target = mut.target as Element;
      const wrapper = target.closest('[aria-label="PROMPT code" i]');
      if (wrapper) blocksToCheck.add(wrapper);
    }
  }

  for (const block of blocksToCheck) {
    scheduleBlockCheck(block);
  }
}

function isAssistantMessage(el: Element): boolean {
  return el.matches?.("[data-is-streaming]") || false;
}

function isCodeBlock(el: Element): boolean {
  return el.tagName === "PRE" || el.tagName === "CODE";
}

function findBuggerBlocksIn(root: Element): Element[] {
  return findBuggerBlocks(root);
}

function findBuggerBlocksMatchingNode(el: Element): Element[] {
  const message = findContainingMessage(el);
  const scope = message ?? el.parentElement ?? el;
  const blocks = findBuggerBlocks(scope);
  return blocks.filter((b) => b === el || b.contains(el) || el.contains(b));
}

function scheduleBlockCheck(block: Element): void {
  if (block.getAttribute("data-bugger-handled")) return;

  // Init-scan race guard.
  if (!initScanComplete) {
    const existing = blockDebouncers.get(block);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      blockDebouncers.delete(block);
      scheduleBlockCheck(block);
    }, 100);
    blockDebouncers.set(block, timer);
    return;
  }

  const existing = blockDebouncers.get(block);
  if (existing) clearTimeout(existing);

  const message = findContainingMessage(block);
  const fastPath = message && !isMessageStillStreaming(message);
  const delay = fastPath ? 100 : DEBOUNCE_MS;

  const timer = setTimeout(() => {
    blockDebouncers.delete(block);
    void tryDispatch(block);
  }, delay);
  blockDebouncers.set(block, timer);
}

// --- dispatch precondition + fire ------------------------------------------

async function tryDispatch(block: Element): Promise<void> {
  if (block.getAttribute("data-bugger-handled")) return;

  const content = extractBlockContent(block).replace(/\s+$/, "");
  if (!content) return;

  if (dispatchedContent.has(content)) {
    block.setAttribute("data-bugger-handled", "duplicate-content");
    return;
  }

  const message = findContainingMessage(block);
  if (!message) {
    block.setAttribute("data-bugger-handled", "historical-no-wrapper");
    dispatchedContent.add(content);
    return;
  }

  if (isMessageStillStreaming(message)) {
    scheduleBlockCheck(block);
    return;
  }

  if (!myTabBinding) {
    console.warn("[bugger] block detected but tab not bound to any project; ignoring");
    block.setAttribute("data-bugger-handled", "unbound");
    return;
  }

  if (dispatchInFlight) {
    scheduleBlockCheck(block);
    return;
  }
  dispatchInFlight = true;
  dispatchedContent.add(content);
  statusPill.show("Worker dispatched");

  try {
    const ordinal = getOrAssignMessageOrdinal(message);
    const blockIndex = indexOfBlockInMessage(block, message);
    const blockId = await computeBlockId(content, blockIndex, ordinal);

    if (dispatchedBlocks.has(blockId)) {
      block.setAttribute("data-bugger-handled", "duplicate");
      return;
    }

    block.setAttribute("data-bugger-handled", "dispatching");
    dispatchedBlocks.set(blockId, "pending");

    await chrome.runtime.sendMessage({ type: "dispatchStart" }).catch(() => {});

    const dispatchResult = await daemon.dispatch(myTabBinding, content);
    if (daemon.isDaemonError(dispatchResult)) {
      await chrome.runtime.sendMessage({ type: "dispatchEnd" }).catch(() => {});
      await injectErrorMessage(dispatchResult.error, dispatchResult.status);
      block.setAttribute("data-bugger-handled", "dispatch-failed");
      return;
    }

    const jobId = dispatchResult.jobId;
    dispatchedBlocks.set(blockId, jobId);

    let lastPhaseKey: string | undefined;
    const job = await pollJob(jobId, (snapshot) => {
      const phaseKey = `${snapshot.phase ?? ""}|${snapshot.phaseDetail ?? ""}`;
      if (phaseKey === lastPhaseKey) return;
      lastPhaseKey = phaseKey;
      statusPill.show(formatPhase(snapshot.phase, snapshot.phaseDetail));
    });
    await chrome.runtime.sendMessage({ type: "dispatchEnd" }).catch(() => {});

    if (!job) {
      await injectErrorMessage("daemon unreachable while polling job", 0);
      block.setAttribute("data-bugger-handled", "poll-failed");
      return;
    }

    if (daemon.isDaemonError(job)) {
      await injectErrorMessage(job.error, job.status);
      block.setAttribute("data-bugger-handled", "poll-error");
      return;
    }

    await injectResult(job);
    block.setAttribute("data-bugger-handled", "completed");
  } finally {
    dispatchInFlight = false;
    statusPill.hideAfter(2000);
  }
}

function formatPhase(phase: JobPhase | undefined, detail: string | undefined): string {
  switch (phase) {
    case "started":         return "Worker dispatched";
    case "reading":         return detail ? `Worker reading ${detail}...` : "Worker reading files...";
    case "editing":         return detail ? `Worker editing ${detail}...` : "Worker editing files...";
    case "running_command": return detail ? `Worker running ${detail}...` : "Worker running command...";
    case "thinking":        return "Worker thinking...";
    case "done":            return "Worker done";
    default:                return "Worker working...";
  }
}

function getOrAssignMessageOrdinal(messageNode: Element): number {
  const existing = messageNode.getAttribute("data-bugger-msg-ordinal");
  if (existing !== null) {
    const parsed = parseInt(existing, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ordinal = messageOrdinalCounter++;
  messageNode.setAttribute("data-bugger-msg-ordinal", String(ordinal));
  return ordinal;
}

function indexOfBlockInMessage(block: Element, messageNode: Element): number {
  const all = findBuggerBlocks(messageNode);
  return all.indexOf(block);
}

async function computeBlockId(
  content: string,
  blockIndex: number,
  messageOrdinal: number,
): Promise<string> {
  const data = new TextEncoder().encode(`${content} ${blockIndex} ${messageOrdinal}`);
  const buf = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- polling ----------------------------------------------------------------

async function pollJob(
  jobId: string,
  onSnapshot?: (job: Job) => void,
): Promise<Job | daemon.DaemonError | null> {
  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    const delay = elapsed < 10_000 ? 1000 : 3000;
    await sleep(delay);
    const result = await daemon.getJob(jobId);
    if (result === null) return null;
    if (daemon.isDaemonError(result)) return result;
    if (onSnapshot) onSnapshot(result);
    if (result.status === "succeeded" || result.status === "failed") return result;
  }
}

// --- result formatting ------------------------------------------------------

function formatResult(job: Job): string {
  const parts: string[] = ["Worker result:", ""];
  if (job.status === "failed") {
    parts.push(`Status: FAILED (exit ${job.exitCode ?? "n/a"})`);
    if (job.error) parts.push(`Error: ${job.error}`);
    parts.push("");
  }
  if (job.output) parts.push(job.output);
  if (job.diffSummary) {
    parts.push("");
    parts.push("Diff:");
    parts.push(job.diffSummary);
  }
  return parts.join("\n");
}

function formatErrorInjection(message: string, status: number): string {
  return `Worker dispatch failed: ${message}${status ? ` (HTTP ${status})` : ""}`;
}

// --- injection --------------------------------------------------------------

async function injectResult(job: Job): Promise<boolean> {
  return await injectText(formatResult(job), {
    allowAutoSubmit: true,
    pending: { jobId: job.id, project: job.project },
  });
}

async function injectErrorMessage(message: string, status: number): Promise<void> {
  await injectText(formatErrorInjection(message, status), { allowAutoSubmit: false });
}

async function injectText(
  text: string,
  opts: { allowAutoSubmit: boolean; pending?: { jobId: string; project: string } },
): Promise<boolean> {
  const input = findInputTextarea();
  if (!input) {
    console.warn("[bugger] cannot inject result — input textarea not found");
    return false;
  }

  const existing = readEditorContent(input).trim();
  if (existing.length > 0) {
    console.warn(
      `[bugger] inject aborted — input has existing text (${existing.length} chars); ` +
        `clear the input manually before the next dispatch`,
    );
    if (opts.pending) {
      await chrome.runtime
        .sendMessage({
          type: "pendingResult",
          jobId: opts.pending.jobId,
          project: opts.pending.project,
        })
        .catch(() => {});
    }
    return false;
  }

  if (!performInject(input, text)) {
    return false;
  }

  if (autoSubmit && opts.allowAutoSubmit) {
    await sleep(100);
    const send = findSendButton();
    if (!send) {
      console.warn("[bugger] auto-submit on but send button not found; user will need to click Send");
      return true;
    }
    send.click();
  }
  return true;
}

function performInject(input: HTMLElement, text: string): boolean {
  input.focus();
  try {
    const isTextarea = input.tagName === "TEXTAREA" || input.tagName === "INPUT";
    if (isTextarea) {
      const ta = input as HTMLTextAreaElement;
      const proto = Object.getPrototypeOf(ta);
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(ta, (ta.value ?? "") + text);
      } else {
        ta.value = (ta.value ?? "") + text;
      }
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection.addRange(range);
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: "insertText",
        }),
      );
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: "insertText",
        }),
      );
    }
    return true;
  } catch (err) {
    console.warn(`[bugger] injection failed: ${(err as Error).message}`);
    return false;
  }
}

function readEditorContent(input: HTMLElement): string {
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    return (input as HTMLTextAreaElement).value ?? "";
  }
  return input.innerText ?? input.textContent ?? "";
}

// --- utilities --------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- go ---------------------------------------------------------------------

init().catch((err) => {
  console.error(`[bugger] init failed: ${(err as Error).stack ?? (err as Error).message}`);
});

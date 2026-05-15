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
const BINDING_WAIT_MAX_MS = 10_000;

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

// Single-flight gate. With body-level MO + claude.ai's heavy streaming
// re-renders, dozens of tryDispatch promises can stack up — even with
// content dedupe, slight text variations across renders sneak past it.
// This gate ensures at most one dispatch is being processed at a time;
// late arrivals reschedule and re-evaluate after the current one finishes.
let dispatchInFlight = false;

// Monotonic counter for assigning ordinals to assistant messages we observe.
// Pre-existing messages get sequential ordinals during init; new messages get
// the next one when first encountered.
let messageOrdinalCounter = 0;

let myTabBinding: string | null = null;
let myTabId: number | null = null;
let autoSubmit = true;

// Init-scan flag. After scanInitial runs, this stays true forever. We use it
// as the "did we already complete the initial sweep?" signal. Any PROMPT
// block tryDispatch ever sees must have either been seen by scanInitial
// (marked init-scan) OR appeared in a mutation after init. If neither — i.e.
// we see an unmarked block BEFORE init completes — we defer rather than
// dispatch, so the init scan can sweep and mark it as historical.
let initScanComplete = false;

// --- bootstrap --------------------------------------------------------------

async function init(): Promise<void> {
  // Get our own tab id from the SW (we need it as a chrome.storage.session key).
  // Tab id never changes during a tab's lifetime, so cache once.
  try {
    const tabResp = await chrome.runtime.sendMessage({ type: "whoAmI" });
    myTabId = typeof tabResp?.tabId === "number" ? tabResp.tabId : null;
  } catch {
    myTabId = null;
  }

  // Read binding and settings DIRECTLY from chrome.storage.session — no SW
  // round-trip. The earlier SW-mediated path failed silently if the SW was
  // asleep at script init, leaving myTabBinding as null indefinitely (the
  // user would see "Bound to: X" in the popup but the content script
  // wouldn't dispatch).
  await loadBindingFromStorage();
  await loadSettingsFromStorage();

  // Watch storage so the content script reflects changes immediately even
  // if the popup or SW updated them while we weren't looking.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (myTabId !== null) {
      const bindingKey = `binding:${myTabId}`;
      if (bindingKey in changes) {
        const newValue = changes[bindingKey]?.newValue;
        myTabBinding = typeof newValue === "string" ? newValue : null;
        console.log(`[bugger] binding updated from storage: ${myTabBinding ?? "(unbound)"}`);
      }
    }
    if ("settings" in changes) {
      const s = changes["settings"]?.newValue;
      if (s && typeof s === "object") {
        autoSubmit = (s as { autoSubmit?: boolean }).autoSubmit ?? true;
      }
    }
  });

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
  // hasn't hydrated yet. Without this wait, scanInitial runs while the DOM
  // is empty of PROMPT blocks, marks zero, and the eventual hydration
  // surfaces every historical block as "new" via MutationObserver.
  await waitForBlocksToRender();

  // Initial scan: mark all pre-existing PROMPT blocks as seen so we never
  // re-dispatch historical content on extension reload or tab restore.
  scanInitial();
  initScanComplete = true;

  // Attach the observer AFTER initScanComplete is set, so any mutation
  // firing in the same tick doesn't race the init scan.
  const observer = new MutationObserver(handleMutations);
  observer.observe(stream, { childList: true, subtree: true, characterData: true });

  console.log(
    `[bugger] content script ready (observing <${stream.tagName.toLowerCase()}>, ` +
      `binding=${myTabBinding ?? "(unbound)"}, tabId=${myTabId})`,
  );
}

async function loadBindingFromStorage(): Promise<void> {
  if (myTabId === null) {
    myTabBinding = null;
    return;
  }
  try {
    const key = `binding:${myTabId}`;
    const result = await chrome.storage.session.get(key);
    const value = result[key];
    myTabBinding = typeof value === "string" ? value : null;
  } catch {
    myTabBinding = null;
  }
}

async function loadSettingsFromStorage(): Promise<void> {
  try {
    const result = await chrome.storage.session.get("settings");
    const value = result["settings"];
    if (value && typeof value === "object") {
      autoSubmit = (value as { autoSubmit?: boolean }).autoSubmit ?? true;
    } else {
      autoSubmit = true;
    }
  } catch {
    autoSubmit = true;
  }
}

async function waitForBlocksToRender(): Promise<void> {
  // Wait up to 5 seconds for at least one PROMPT block to appear, OR for
  // claude.ai's chat surface to have ANY assistant message rendered.
  // Either signal indicates the page has hydrated enough that scanInitial
  // can find what's there. If we time out, scanInitial will just mark
  // nothing — and MutationObserver picks up everything that arrives after.
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
  // Two-pass scan, both global:
  //
  // Pass 1: every PROMPT block in the document gets marked as seen, regardless
  // of whether it lives inside a [data-is-streaming] message wrapper. claude.ai
  // does NOT put data-is-streaming on completed historical turns, so the prior
  // version of this function (which only iterated findAssistantMessages())
  // missed every block in chat history. On extension reload that produced the
  // exact bug we're fixing here: historical PROMPT blocks went unmarked, then
  // the first mutation surfaced them as "new" and the dispatch path fired.
  //
  // Pass 2: also iterate by-message to assign ordinals. Messages that exist
  // at init time get sequential ordinals starting from 0; new messages added
  // later get the next ordinal when first encountered.
  //
  // Also: pre-populate dispatchedContent with the content of every existing
  // block. That way even if a re-render produces a *new* DOM element for the
  // same prompt (without our data-bugger-handled marker), the content-based
  // dedupe still catches it. THIS IS THE LOAD-BEARING DEFENSE because
  // claude.ai DOES re-render elements (React reconciliation churn), and
  // every re-render produces a fresh element with no data-bugger-handled.
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
    // Added nodes: could be a new message OR new content within a message.
    for (const node of mut.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      // If a new assistant message appeared, assign its ordinal now.
      const newMessages = isAssistantMessage(el) ? [el] : findAssistantMessages(el);
      for (const m of newMessages) getOrAssignMessageOrdinal(m);
      // Any new PROMPT blocks inside?
      const newBlocks = isCodeBlock(el)
        ? findBuggerBlocksMatchingNode(el)
        : findBuggerBlocksIn(el);
      for (const b of newBlocks) blocksToCheck.add(b);
    }
    // CharacterData / subtree changes: re-check the containing PROMPT
    // wrapper, IF this mutation is inside one.
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

  // Content-level dedupe: if we've already dispatched (or marked as seen) a
  // block with this exact content in this tab, skip.
  if (dispatchedContent.has(content)) {
    block.setAttribute("data-bugger-handled", "duplicate-content");
    return;
  }

  const message = findContainingMessage(block);
  if (!message) {
    // No streaming wrapper. claude.ai puts data-is-streaming only on
    // actively-rendering turns; completed historical turns don't have it.
    // If this block is also INSIDE chat history (above the input bar), it's
    // historical and must not dispatch. Mark seen and bail.
    block.setAttribute("data-bugger-handled", "historical-no-wrapper");
    dispatchedContent.add(content);
    return;
  }

  // If still streaming, re-arm and wait.
  if (isMessageStillStreaming(message)) {
    scheduleBlockCheck(block);
    return;
  }

  // Binding wait: if the SW round-trip hadn't populated myTabBinding by
  // dispatch time, give it a moment in case storage just updated. This
  // avoids the "unbound; ignoring" path firing on a block that lands
  // milliseconds before binding propagates.
  if (!myTabBinding) {
    await waitForBinding();
  }

  if (!myTabBinding) {
    console.warn("[bugger] block detected but tab not bound to any project; ignoring");
    block.setAttribute("data-bugger-handled", "unbound");
    return;
  }

  // Single-flight gate.
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

async function waitForBinding(): Promise<void> {
  // Poll storage every 200ms for up to BINDING_WAIT_MAX_MS. The
  // chrome.storage.onChanged listener also updates myTabBinding live, but
  // polling here is a belt+suspenders fallback for environments where the
  // listener races.
  const start = Date.now();
  while (Date.now() - start < BINDING_WAIT_MAX_MS) {
    await loadBindingFromStorage();
    if (myTabBinding) return;
    await sleep(200);
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

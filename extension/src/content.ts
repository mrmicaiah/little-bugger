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

// Content-level dedupe. claude.ai sometimes renders the same PROMPT block
// as multiple DOM elements (edit history, regenerated responses,
// virtualization clones). Each DOM copy is a distinct Element so the
// per-block data-bugger-handled marker doesn't dedupe across them, and
// the blockId-based dedupe varies because blockIndex/ordinal differ per
// copy. Hashing the prompt content alone fixes both — same prompt in this
// tab dispatches exactly once. Set is per-content-script (per-tab), reset
// on tab reload, which is the intended behavior.
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
  // Get binding and settings from the service worker.
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

  // Initial scan: mark all pre-existing PROMPT blocks as seen so we never
  // re-dispatch historical content on extension reload or tab restore.
  scanInitial();
  initScanComplete = true;

  // Attach the observer AFTER initScanComplete is set, so any mutation
  // firing in the same tick doesn't race the init scan.
  const observer = new MutationObserver(handleMutations);
  observer.observe(stream, { childList: true, subtree: true, characterData: true });

  console.log(`[bugger] content script ready (observing <${stream.tagName.toLowerCase()}>)`);
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
  // dedupe still catches it.
  const allBlocks = document.querySelectorAll<HTMLElement>(
    '[aria-label="PROMPT code" i], pre code[class*="language-PROMPT" i]',
  );
  let markedCount = 0;
  for (const candidate of allBlocks) {
    // If the candidate is a <code> inside a <pre>, normalize to the wrapper
    // (so we mark and dedupe on the same element type that mutation handling
    // works against).
    const block = candidate.matches('[aria-label="PROMPT code" i]')
      ? candidate
      : (candidate.closest('[aria-label="PROMPT code" i]') ?? candidate.closest("pre") ?? candidate);
    if (block.getAttribute("data-bugger-handled")) continue;
    block.setAttribute("data-bugger-handled", "init-scan");
    markedCount++;
    const content = extractBlockContent(block).replace(/\s+$/, "");
    if (content) dispatchedContent.add(content);
  }

  // Assign ordinals to existing streaming-wrapper messages (if any). New
  // messages get assigned when first encountered by handleMutations.
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
    // wrapper, IF this mutation is inside one. Earlier this used
    // closest("pre") which matched any of the 300+ code blocks on the
    // page — every keystroke churn re-fired the dispatch path on
    // unrelated pres.
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
  // claude.ai marks each assistant turn with data-is-streaming (value
  // "true" or "false"). selectors.ts uses the same anchor.
  return el.matches?.("[data-is-streaming]") || false;
}

function isCodeBlock(el: Element): boolean {
  return el.tagName === "PRE" || el.tagName === "CODE";
}

function findBuggerBlocksIn(root: Element): Element[] {
  // Search the whole subtree of the added node for PROMPT blocks. Earlier
  // versions narrowed via root.closest("[data-is-streaming]") first, but
  // that drops the search when claude.ai re-renders content in containers
  // that don't have a streaming wrapper.
  return findBuggerBlocks(root);
}

function findBuggerBlocksMatchingNode(el: Element): Element[] {
  // The added node IS a pre/code — check if it's a PROMPT block.
  // First try the streaming wrapper; if absent (historical/restored content),
  // search the broader subtree the node lives in.
  const message = findContainingMessage(el);
  const scope = message ?? el.parentElement ?? el;
  const blocks = findBuggerBlocks(scope);
  return blocks.filter((b) => b === el || b.contains(el) || el.contains(b));
}

function scheduleBlockCheck(block: Element): void {
  if (block.getAttribute("data-bugger-handled")) return; // already dispatched or seen

  // Init-scan race guard: if a mutation fires before scanInitial has marked
  // historical blocks, defer briefly and recheck. Without this, an unmarked
  // historical block could slip into tryDispatch in the narrow window
  // between MutationObserver attach and scanInitial completion. (We attach
  // the observer AFTER scanInitial, but DOM events can fire synchronously
  // during the same tick — be defensive.)
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

  // Speed-up: if the containing message is no longer streaming, we can
  // dispatch sooner. Still wait one short tick to let DOM settle.
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

  // Defensive: if init scan somehow missed this block AND it's already in
  // dispatchedContent from a prior life of the content script, treat as
  // duplicate. This is the belt+suspenders to the init-scan marking.
  const content = extractBlockContent(block).replace(/\s+$/, "");
  if (!content) return;
  if (dispatchedContent.has(content)) {
    block.setAttribute("data-bugger-handled", "duplicate-content");
    return;
  }

  const message = findContainingMessage(block);
  if (!message) {
    // Historical block (no streaming wrapper). If we got this far without
    // init-scan having marked it, treat as seen — historical content must
    // never re-dispatch.
    block.setAttribute("data-bugger-handled", "historical-no-wrapper");
    dispatchedContent.add(content);
    return;
  }

  // If still streaming, re-arm and wait.
  if (isMessageStillStreaming(message)) {
    scheduleBlockCheck(block);
    return;
  }

  // If the block is the LAST element in the message and streaming just
  // stopped, we still want a brief settle window in case another mutation
  // arrives. The fast-path delay in scheduleBlockCheck (100ms) provides this.

  if (!myTabBinding) {
    // Not bound — surface in console, don't auto-inject (could confuse user
    // mid-conversation). Popup will surface this state.
    console.warn("[bugger] block detected but tab not bound to any project; ignoring");
    block.setAttribute("data-bugger-handled", "unbound");
    return;
  }

  // Single-flight gate. If something is already being dispatched,
  // reschedule this block and let the in-flight one finish first.
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

    // Live status updates: re-render the pill whenever the daemon's reported
    // phase changes. Same text → no DOM update; the show() helper skips it.
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
    // Pill stays visible briefly after the result lands, then fades.
    // Guaranteed to fire even on early-return or thrown paths.
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
  // Refinement C: sha1(content + indexOfBlockWithinMessage + sequentialMessageOrdinal).
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
    if (result === null) return null; // daemon unreachable
    if (daemon.isDaemonError(result)) return result;
    if (onSnapshot) onSnapshot(result);
    if (result.status === "succeeded" || result.status === "failed") return result;
    // queued / running — keep polling
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
  // Successful worker results may auto-submit (if the user has the toggle on).
  // Pass jobId+project so the guard path can record a pending result.
  return await injectText(formatResult(job), {
    allowAutoSubmit: true,
    pending: { jobId: job.id, project: job.project },
  });
}

async function injectErrorMessage(message: string, status: number): Promise<void> {
  // Errors NEVER auto-submit. The user should see and acknowledge a
  // dispatch failure before it goes back to the manager — otherwise
  // transient failures (daemon restart, network blip) flood the chat
  // with noise the manager has to talk past.
  // No pending param: error-path injections never create pending state.
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

  // Safety: don't stomp the user's draft text. If the input has any
  // non-whitespace content (a worker result already sitting there, or
  // typing in progress), abort. The user clears the input on their own
  // terms and can ask the manager to re-dispatch if needed.
  const existing = readEditorContent(input).trim();
  if (existing.length > 0) {
    console.warn(
      `[bugger] inject aborted — input has existing text (${existing.length} chars); ` +
        `clear the input manually before the next dispatch`,
    );
    if (opts.pending) {
      // Surface the orphaned result so the user can retrieve it from the popup.
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
    return false; // performInject already logged the failure
  }

  if (autoSubmit && opts.allowAutoSubmit) {
    await sleep(100); // let React reconcile state
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
  // Single-path injection. We used to also run an execCommand fallback when
  // a 75ms verification check decided the InputEvent path "didn't take" —
  // but that check produced false negatives, the fallback fired anyway, and
  // ProseMirror absorbed BOTH insertions (the modern one as inline-collapsed
  // text + the execCommand one as a real multi-line code block), submitting
  // the worker result doubled in a single message. The modern path is
  // verified to work end-to-end on production claude.ai; if it ever stops
  // working, add a real retry — don't pre-emptively double-inject.
  input.focus();
  try {
    const isTextarea = input.tagName === "TEXTAREA" || input.tagName === "INPUT";
    if (isTextarea) {
      // For native textareas, set value via the native setter (bypasses React
      // value tracker) then fire input event.
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
      // Contenteditable (ProseMirror): insert at end via Range API and
      // dispatch beforeinput + input events so the editor's state controller
      // sees the change.
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

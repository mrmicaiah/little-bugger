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

  // Listen for binding / settings updates from the SW.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "bindingChanged") {
      myTabBinding = msg.project ?? null;
    } else if (msg?.type === "settingsChanged") {
      autoSubmit = msg.autoSubmit ?? true;
    }
  });

  // Wait for the message stream container to appear (claude.ai's SPA).
  const stream = await waitForMessageStream();
  if (!stream) {
    console.warn("[bugger] message stream container not found after 30s; extension idle");
    return;
  }

  // Initial scan: assign ordinals and mark all pre-existing PROMPT blocks as
  // seen so we never re-dispatch historical content.
  scanInitial();

  // Attach the observer.
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
  const messages = findAssistantMessages();
  for (const msg of messages) {
    getOrAssignMessageOrdinal(msg);
    for (const block of findBuggerBlocks(msg)) {
      // Mark as seen WITHOUT dispatching — these are history.
      block.setAttribute("data-bugger-handled", "init-scan");
    }
  }
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
  // root might be a message turn, a wrapper, anything — defer to selector lib.
  const candidate = root.closest("[data-is-streaming]") ?? root;
  return findBuggerBlocks(candidate);
}

function findBuggerBlocksMatchingNode(el: Element): Element[] {
  // The added node IS a pre/code — check if it's a PROMPT block.
  const message = findContainingMessage(el);
  if (!message) return [];
  const blocks = findBuggerBlocks(message);
  return blocks.filter((b) => b === el || b.contains(el) || el.contains(b));
}

function scheduleBlockCheck(block: Element): void {
  if (block.getAttribute("data-bugger-handled")) return; // already dispatched or seen

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

  const message = findContainingMessage(block);
  if (!message) {
    // Can't compute an id without a containing message; defer.
    scheduleBlockCheck(block);
    return;
  }

  // Refinement A precondition (1): block content must be non-empty and look
  // like a closed code block. claude.ai strips the literal ``` fences during
  // markdown rendering, so the structural signal is: the <pre> element exists
  // with content, and the message turn either has more content AFTER the
  // block OR has stopped streaming. The 500ms debounce (in scheduleBlockCheck)
  // is the load-bearing piece — this content check is the cheap pre-filter.
  const content = extractBlockContent(block).replace(/\s+$/, "");
  if (!content) return;

  // Refinement A precondition (2): if still streaming, re-arm and wait.
  if (isMessageStillStreaming(message)) {
    scheduleBlockCheck(block);
    return;
  }

  // If the block is the LAST element in the message and streaming just
  // stopped, we still want a brief settle window in case another mutation
  // arrives. The fast-path delay above (100ms) provides this.

  if (!myTabBinding) {
    // Not bound — surface in console, don't auto-inject (could confuse user
    // mid-conversation). Popup will surface this state.
    console.warn("[bugger] block detected but tab not bound to any project; ignoring");
    block.setAttribute("data-bugger-handled", "unbound");
    return;
  }

  // Content-level dedupe. Synchronous check+add: no await between them,
  // so concurrent tryDispatches for DOM copies of the same prompt can't
  // race past this guard. See comment on `dispatchedContent` above.
  if (dispatchedContent.has(content)) {
    block.setAttribute("data-bugger-handled", "duplicate-content");
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

async function injectResult(job: Job): Promise<void> {
  // Successful worker results may auto-submit (if the user has the toggle on).
  await injectText(formatResult(job), { allowAutoSubmit: true });
}

async function injectErrorMessage(message: string, status: number): Promise<void> {
  // Errors NEVER auto-submit. The user should see and acknowledge a
  // dispatch failure before it goes back to the manager — otherwise
  // transient failures (daemon restart, network blip) flood the chat
  // with noise the manager has to talk past.
  await injectText(formatErrorInjection(message, status), { allowAutoSubmit: false });
}

async function injectText(text: string, opts: { allowAutoSubmit: boolean }): Promise<void> {
  const input = findInputTextarea();
  if (!input) {
    console.warn("[bugger] cannot inject result — input textarea not found");
    return;
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
    return;
  }

  if (!performInject(input, text)) {
    return; // performInject already logged the failure
  }

  if (autoSubmit && opts.allowAutoSubmit) {
    await sleep(100); // let React reconcile state
    const send = findSendButton();
    if (!send) {
      console.warn("[bugger] auto-submit on but send button not found; user will need to click Send");
      return;
    }
    send.click();
  }
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

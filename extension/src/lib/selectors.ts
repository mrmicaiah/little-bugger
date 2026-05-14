// claude.ai DOM selectors. THIS IS THE SINGLE HIGHEST-RISK MAINTENANCE FILE
// in the extension. When claude.ai redesigns, this file is what breaks.
//
// Each find function tries multiple selectors in order, from most-specific
// to most-generic. On total miss, it logs a clear console.warn so a future
// debugger can see which find failed. No throws; graceful degradation.
//
// Selector ground truth captured via scripts/inspect-claude-dom.js on a live
// claude.ai conversation. Anchors used:
//   - input          : data-testid="chat-input" on a contenteditable div
//   - input wrapper  : [data-chat-input-container="true"]
//   - assistant turn : div[data-is-streaming] (value "true" while streaming)
//   - turn card      : div[data-test-render-count] (each rendered turn)
//   - code block     : <pre> inside [role="group"][aria-label="<lang> code"],
//                      with <code class="language-<lang>">

type SelectorAttempt = {
  description: string;
  selector: string;
};

function firstMatch<T extends Element>(
  root: ParentNode,
  attempts: SelectorAttempt[],
  label: string,
): T | null {
  for (const attempt of attempts) {
    try {
      const el = root.querySelector<T>(attempt.selector);
      if (el) return el;
    } catch {
      // Invalid CSS selector — skip.
    }
  }
  console.warn(`[bugger] selector miss: ${label} (tried ${attempts.length} strategies)`);
  return null;
}

// The container that holds the streaming message turns. We attach the
// MutationObserver here. claude.ai wraps each turn in its own
// content-visibility virtualization div, so the first turn's parent is
// NOT the container of subsequent turns — going up one level only would
// cause us to miss every new turn added after init. Walk up to the
// lowest common ancestor of all turn cards instead.
export function findMessageStream(): Element | null {
  const turnCards = document.querySelectorAll<HTMLElement>("[data-test-render-count]");
  if (turnCards.length >= 2) {
    let candidate: Element | null = turnCards[0]!.parentElement;
    while (candidate) {
      let containsAll = true;
      for (const tc of turnCards) {
        if (!candidate.contains(tc)) {
          containsAll = false;
          break;
        }
      }
      if (containsAll) return candidate;
      candidate = candidate.parentElement;
    }
  }
  // Fall back to body when we can't determine the LCA (zero or one turn
  // card visible). Body is a stable always-present ancestor; the cost is
  // extra mutation events to scan, which is fine for a single user.
  return firstMatch(document, [
    { description: "role=main",    selector: "[role='main']" },
    { description: "main element", selector: "main" },
    { description: "body",         selector: "body" },
  ], "message stream container");
}

// Assistant messages: the element with data-is-streaming (any value).
export function findAssistantMessages(root: ParentNode = document): Element[] {
  return Array.from(root.querySelectorAll<Element>("[data-is-streaming]"));
}

// Within an assistant message, find bugger code blocks. The wrapper is a
// plain DIV with aria-label="bugger code" (no role attribute, despite what
// the inspection script suggested earlier — that was inferred from another
// language's block, but the bugger-language block doesn't get role="group").
export function findBuggerBlocks(messageNode: Element): Element[] {
  // Strategy 1: aria-label on the wrapper DIV.
  const byAria = messageNode.querySelectorAll<HTMLElement>('[aria-label="bugger code" i]');
  if (byAria.length > 0) return Array.from(byAria);

  // Strategy 2: <code class="language-bugger"> in case Prism ever recognizes
  // "bugger" as a syntax-highlighter language. Returns the <pre> ancestor.
  const byClass = messageNode.querySelectorAll<Element>(
    'pre code.language-bugger, pre code[class*="language-bugger" i]',
  );
  if (byClass.length > 0) {
    return Array.from(byClass).map((c) => c.closest("pre") ?? c);
  }

  return [];
}

// Extract the prompt text from a bugger block. Because Prism doesn't
// recognize "bugger" as a language, claude.ai renders the raw markdown
// fences as visible text inside the <pre>. Strip the leading ```bugger\n
// and trailing \n``` so the daemon receives just the prompt body.
export function extractBlockContent(block: Element): string {
  // Find the <pre> with the rendered content. block may be the wrapper DIV
  // (aria-label="bugger code") or already the <pre> itself.
  const pre =
    block.matches("pre")
      ? block
      : (block.querySelector("pre.code-block__code") ?? block.querySelector("pre"));
  const source = pre ?? block;
  const text = (source.textContent ?? "")
    .replace(/^```bugger\r?\n/, "")
    .replace(/\r?\n```\s*$/, "");
  return text;
}

// True if the message containing this node is still streaming.
// claude.ai sets data-is-streaming="true" while a turn is in flight,
// then flips to "false" when it completes.
export function isMessageStillStreaming(messageNode: Element): boolean {
  const wrapper = messageNode.matches("[data-is-streaming]")
    ? messageNode
    : messageNode.closest("[data-is-streaming]");
  if (!wrapper) return false;
  return wrapper.getAttribute("data-is-streaming") === "true";
}

// Find the nearest assistant message element containing a block.
export function findContainingMessage(block: Element): Element | null {
  return block.closest("[data-is-streaming]");
}

// The chat input. claude.ai uses ProseMirror via a contenteditable div
// tagged with data-testid="chat-input".
export function findInputTextarea(): HTMLElement | null {
  return firstMatch<HTMLElement>(document, [
    { description: "data-testid chat-input",   selector: "[data-testid='chat-input']" },
    { description: "ProseMirror role textbox", selector: 'div[contenteditable="true"][role="textbox"]' },
    { description: "any contenteditable",      selector: 'div[contenteditable="true"]' },
    { description: "fallback textarea",        selector: "textarea" },
  ], "chat input");
}

// The send button. claude.ai hides/lazy-renders this when the input is
// empty, so first-load scans may return null until the user (or our
// injection) has put text in the input. Scope to the input container so
// we don't match unrelated send-like buttons elsewhere in the UI.
export function findSendButton(): HTMLElement | null {
  return firstMatch<HTMLElement>(document, [
    { description: "send within chat-input-container",
      selector: '[data-chat-input-container] button[aria-label*="Send" i]' },
    { description: "aria-label send (any)",
      selector: 'button[aria-label*="Send" i]' },
    { description: "submit button in input container",
      selector: '[data-chat-input-container] button[type="submit"]' },
    { description: "submit button anywhere",
      selector: 'button[type="submit"]' },
  ], "send button");
}

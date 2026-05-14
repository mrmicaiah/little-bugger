// Floating "worker activity" status pill. Fixed bottom-right of the
// viewport, paper-ink palette, low-key italic monospace. Whisper, not shout.
//
// Lifecycle:
//   show(text)        — create or update the pill in place
//   hideAfter(ms)     — schedule removal; resets if show() is called again
//   hideNow()         — remove immediately (e.g. on content-script teardown)

const PILL_ID = "bugger-status-pill";

let pillEl: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function ensurePill(): HTMLElement {
  if (pillEl && document.body.contains(pillEl)) return pillEl;
  const existing = document.getElementById(PILL_ID);
  if (existing instanceof HTMLElement) {
    pillEl = existing;
    return existing;
  }
  const el = document.createElement("div");
  el.id = PILL_ID;
  el.setAttribute("aria-hidden", "true");
  // Inline styles so claude.ai's stylesheet cascade can't override us.
  el.style.cssText = [
    "position: fixed",
    "bottom: 16px",
    "right: 16px",
    "z-index: 2147483647",
    "padding: 5px 11px",
    "background: rgb(252, 250, 245)",
    "color: rgb(60, 55, 50)",
    "border: 1px solid rgba(120, 110, 100, 0.25)",
    "border-radius: 4px",
    "font-family: 'JetBrains Mono', 'SF Mono', Consolas, 'Liberation Mono', monospace",
    "font-size: 12px",
    "font-style: italic",
    "letter-spacing: 0.01em",
    "box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06)",
    "pointer-events: none",
    "user-select: none",
    "max-width: 380px",
    "overflow: hidden",
    "text-overflow: ellipsis",
    "white-space: nowrap",
    "opacity: 0",
    "transition: opacity 150ms ease-out",
  ].join(";");
  document.body.appendChild(el);
  pillEl = el;
  // Force a layout frame before fading in, so the transition runs.
  requestAnimationFrame(() => {
    if (pillEl) pillEl.style.opacity = "1";
  });
  return el;
}

export function show(text: string): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const el = ensurePill();
  if (el.textContent !== text) el.textContent = text;
  el.style.opacity = "1";
}

export function hideAfter(ms: number): void {
  if (!pillEl) return;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (!pillEl) return;
    pillEl.style.opacity = "0";
    const toRemove = pillEl;
    setTimeout(() => {
      if (toRemove.parentNode) toRemove.parentNode.removeChild(toRemove);
      if (pillEl === toRemove) pillEl = null;
    }, 200);
  }, ms);
}

export function hideNow(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (pillEl) {
    if (pillEl.parentNode) pillEl.parentNode.removeChild(pillEl);
    pillEl = null;
  }
}

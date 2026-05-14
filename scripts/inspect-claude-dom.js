// Paste this entire IIFE into the DevTools console on a claude.ai tab that
// has a manager conversation visible (ideally one with a ```bugger``` block).
// The output is logged AND copied to clipboard. Paste it back to the agent.

(() => {
  const lines = [];
  const log = (s) => lines.push(s);

  const summarize = (el) => {
    if (!el) return "null";
    const attrs = [...el.attributes]
      .filter(a => a.name !== "style")
      .map(a => `${a.name}="${a.value.length > 80 ? a.value.slice(0, 80) + '…' : a.value}"`)
      .slice(0, 8)
      .join(" ");
    return `<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>`;
  };

  // 1. Input textarea
  const input =
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector("textarea");
  log("INPUT: " + summarize(input));

  // 2. Send button
  const send =
    document.querySelector('button[aria-label*="Send" i]') ||
    document.querySelector('[data-testid*="send" i]') ||
    document.querySelector('button[type="submit"]');
  log("SEND:  " + summarize(send));

  // 3. Ancestors of input — helps locate the chat container above it
  log("\nINPUT ANCESTORS (parent → root):");
  if (input) {
    let cur = input.parentElement;
    let depth = 0;
    while (cur && depth < 10) {
      log(`  [${depth}] ${summarize(cur)}`);
      cur = cur.parentElement;
      depth++;
    }
  }

  // 4. Code blocks (need at least one bugger block on screen for this to be useful)
  const pres = [...document.querySelectorAll("pre")];
  log(`\nCODE BLOCKS (${pres.length} total, showing up to 3):`);
  for (const pre of pres.slice(0, 3)) {
    const code = pre.querySelector("code");
    log(`  pre:    ${summarize(pre)}`);
    if (code) log(`    code: ${summarize(code)}`);
    log(`    parent: ${summarize(pre.parentElement)}`);
    const nearbyText =
      pre.previousElementSibling?.textContent?.trim().slice(0, 40) ||
      pre.querySelector(":scope > div")?.textContent?.trim().slice(0, 40) ||
      "";
    if (nearbyText) log(`    nearby header text: "${nearbyText}"`);
  }

  // 5. Ancestors of the first <pre> — locates the message turn container
  log("\nFIRST PRE ANCESTORS (parent → root):");
  if (pres[0]) {
    let cur = pres[0].parentElement;
    let depth = 0;
    while (cur && depth < 12) {
      log(`  [${depth}] ${summarize(cur)}`);
      cur = cur.parentElement;
      depth++;
    }
  }

  // 6. Probable message containers via known patterns
  const candidates = new Set();
  [
    '[data-testid*="message" i]',
    '[data-testid*="turn" i]',
    '[data-testid*="assistant" i]',
    '[role="article"]',
    '[data-test-render-count]',
    '[aria-label*="assistant" i]',
    '[data-is-streaming]',
  ].forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => candidates.add(el));
  });
  log(`\nCANDIDATE MESSAGE CONTAINERS (${candidates.size}):`);
  [...candidates].slice(0, 6).forEach((c) => log(`  ${summarize(c)}`));

  // 7. Streaming indicators
  log("\nSTREAMING SIGNALS:");
  const ariaBusy = [...document.querySelectorAll("[aria-busy]")];
  log(`  aria-busy nodes: ${ariaBusy.length}`);
  ariaBusy.slice(0, 2).forEach((e) => log(`    ${summarize(e)}`));
  log(`  stop button: ${summarize(document.querySelector('button[aria-label*="stop" i]'))}`);
  log(`  any [data-is-streaming]: ${summarize(document.querySelector("[data-is-streaming]"))}`);

  const out = lines.join("\n");
  console.log(out);
  try {
    navigator.clipboard.writeText(out);
    console.log("\n(output copied to clipboard)");
  } catch {}
  return out;
})();

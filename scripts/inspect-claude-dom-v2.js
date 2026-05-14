// v2: focused on the message-stream-container ancestry chain.
// Paste into DevTools console on a claude.ai tab with >=2 visible turns.
// Output is logged AND attempted to clipboard. If clipboard fails (focus
// issues), select-all + copy from the console output.

(() => {
  const out = [];
  const log = (s) => out.push(s);

  const fmt = (el) => {
    if (!el) return "null";
    const dataAttrs = [];
    const ariaAttrs = [];
    const otherAttrs = [];
    for (const a of el.attributes) {
      const v = a.value.length > 100 ? a.value.slice(0, 100) + "…" : a.value;
      if (a.name.startsWith("data-")) dataAttrs.push(`${a.name}="${v}"`);
      else if (a.name.startsWith("aria-")) ariaAttrs.push(`${a.name}="${v}"`);
      else if (a.name === "role" || a.name === "id") otherAttrs.push(`${a.name}="${v}"`);
    }
    const cls = el.classList.length > 0 ? `class="${[...el.classList].join(" ").slice(0, 200)}"` : "";
    const parts = [`<${el.tagName.toLowerCase()}`, ...otherAttrs, ...dataAttrs, ...ariaAttrs, cls].filter(Boolean);
    return parts.join(" ") + ">";
  };

  const detailReport = (el, label) => {
    if (!el) { log(`${label}: NOT FOUND`); return; }
    log(`${label}:`);
    log(`  self    : ${fmt(el)}`);
    if (el.parentElement) log(`  parent  : ${fmt(el.parentElement)}`);
    if (el.parentElement?.parentElement) log(`  grandpa : ${fmt(el.parentElement.parentElement)}`);
  };

  // ---- 1. Enumerate visible turn candidates -----------------------------
  // claude.ai marks user messages with data-testid="user-message" and
  // assistant turns with [data-is-streaming]. Together these are "turns".
  const userTurns = [...document.querySelectorAll('[data-testid="user-message"]')];
  const asstTurns = [...document.querySelectorAll('[data-is-streaming]')];
  const turnCards = [...document.querySelectorAll('[data-test-render-count]')];

  log(`TURN COUNTS:`);
  log(`  data-testid="user-message" : ${userTurns.length}`);
  log(`  [data-is-streaming]        : ${asstTurns.length}`);
  log(`  [data-test-render-count]   : ${turnCards.length}`);
  log("");

  // ---- 2. Walk up from one turn until ancestor contains ALL turns -------
  const allTurns = new Set([...userTurns, ...asstTurns]);
  log(`STREAM CONTAINER SEARCH (target: ancestor containing all ${allTurns.size} turns):`);
  const startFrom = asstTurns[0] || userTurns[0] || turnCards[0];
  if (!startFrom) {
    log("  no turns found — open a conversation with at least one message");
  } else {
    log(`  starting from: ${fmt(startFrom)}`);
    let cur = startFrom.parentElement;
    let depth = 1;
    let lca = null;
    while (cur && depth < 20) {
      let contained = 0;
      for (const t of allTurns) if (cur.contains(t)) contained++;
      log(`  [${depth}] contains=${contained}/${allTurns.size} : ${fmt(cur)}`);
      if (contained === allTurns.size && !lca) {
        lca = cur;
      }
      cur = cur.parentElement;
      depth++;
      // Stop after a couple of levels past the LCA so we see context
      if (lca && depth > 14) break;
    }
    log("");
    log(`LCA (lowest common ancestor of all turns):`);
    detailReport(lca, "  LCA");
  }

  log("");

  // ---- 3. One assistant turn detail -------------------------------------
  log("ASSISTANT TURN SAMPLE:");
  detailReport(asstTurns[0] || null, "  asst-turn");

  log("");

  // ---- 4. One code block detail -----------------------------------------
  const pres = [...document.querySelectorAll("pre")];
  log(`CODE BLOCK SAMPLE (${pres.length} total):`);
  if (pres[0]) {
    const code = pres[0].querySelector("code");
    detailReport(pres[0], "  pre");
    log(`  pre's code child  : ${fmt(code)}`);
    log(`  pre.closest('[role=\"group\"]'): ${fmt(pres[0].closest('[role="group"]'))}`);
  }

  // ---- 5. Try clipboard ------------------------------------------------
  const text = out.join("\n");
  console.log(text);
  navigator.clipboard.writeText(text).then(
    () => console.log("\n(copied to clipboard ✓)"),
    () => console.log("\n(clipboard write blocked — select the output above manually)"),
  );
  return text;
})();

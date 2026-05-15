// Popup UI. States: daemon-unreachable, unbound, bound-disarmed, bound-armed,
// pending-result, settings.

type Settings = { autoSubmit: boolean };
type DaemonConfig = { projects: string[] };
type DaemonError = { error: string; status?: number };
type PendingResult = { jobId: string; project: string; timestamp: number };
type Job = {
  id: string;
  project: string;
  status: string;
  output?: string;
  diffSummary?: string;
  error?: string;
  exitCode?: number;
};

const contentEl = document.getElementById("content")!;
const settingsToggleBtn = document.getElementById("settings-toggle")! as HTMLButtonElement;

let showingSettings = false;
let activeTabId: number | null = null;

async function send<T>(msg: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function refresh(): Promise<void> {
  if (showingSettings) {
    await renderSettings();
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    render(`<div class="banner warn">No active tab.</div>`);
    return;
  }
  activeTabId = tab.id;

  const { reachable } = await send<{ reachable: boolean }>({ type: "isDaemonReachable", force: true });
  if (!reachable) {
    renderDaemonUnreachable();
    return;
  }

  const isClaudeTab = tab.url?.startsWith("https://claude.ai/") ?? false;
  if (!isClaudeTab) {
    render(`
      <div class="banner warn">
        Open <code>claude.ai</code> to bind a manager tab.
      </div>
    `);
    return;
  }

  const [bindingResp, configResp, pending, armedResp] = await Promise.all([
    send<{ project: string | null }>({ type: "getBinding", tabId: tab.id }),
    send<DaemonConfig | DaemonError>({ type: "getDaemonConfig" }),
    send<PendingResult | null>({ type: "getPendingForTab", tabId: tab.id }),
    send<{ armed: boolean }>({ type: "getArmed", tabId: tab.id }),
  ]);

  if ("error" in configResp) {
    renderDaemonUnreachable(configResp.error);
    return;
  }

  if (pending) {
    renderPending(tab.id, pending);
    return;
  }

  if (bindingResp.project) {
    renderBound(tab.id, bindingResp.project, configResp, armedResp.armed);
  } else {
    renderUnbound(tab.id, configResp);
  }
}

function renderPending(tabId: number, pending: PendingResult): void {
  render(`
    <div class="banner pending">
      <strong>Pending worker result</strong>
      <div class="muted">Result from <code>${escape(pending.project)}</code>, ready to inject.</div>
    </div>
    <div id="pending-status"></div>
    <div class="controls">
      <button id="retrieve-btn" class="primary">Retrieve and inject</button>
    </div>
  `);
  const btn = document.getElementById("retrieve-btn") as HTMLButtonElement;
  btn.addEventListener("click", () => void retrievePending(tabId, pending));
}

async function retrievePending(tabId: number, pending: PendingResult): Promise<void> {
  const statusEl = document.getElementById("pending-status")!;
  const btn = document.getElementById("retrieve-btn") as HTMLButtonElement;
  statusEl.innerHTML = "";
  btn.disabled = true;

  const resp = await send<{ job?: Job; error?: string }>({ type: "retrievePending", tabId });
  if (resp.error || !resp.job) {
    statusEl.innerHTML = `
      <div class="banner error">
        ${escape(resp.error ?? "unknown error")}
        <div class="controls" style="margin-top:6px;">
          <button id="retry-btn">Retry</button>
        </div>
      </div>
    `;
    document.getElementById("retry-btn")!.addEventListener("click", () => void refresh());
    btn.disabled = false;
    return;
  }
  const job = resp.job;

  let clearResp: { clear?: boolean; error?: string };
  try {
    clearResp = await chrome.tabs.sendMessage(tabId, { type: "checkInputClear" });
  } catch (err) {
    statusEl.innerHTML = `
      <div class="banner error">
        Could not reach the content script: ${escape((err as Error).message)}.
      </div>
    `;
    btn.disabled = false;
    return;
  }

  if (!clearResp?.clear) {
    statusEl.innerHTML = `
      <div class="banner warn">
        There's text in your chat input. Send it or delete it, then click Retrieve again.
      </div>
    `;
    btn.disabled = false;
    return;
  }

  let injectResp: { ok?: boolean; error?: string };
  try {
    injectResp = await chrome.tabs.sendMessage(tabId, { type: "injectPending", job });
  } catch (err) {
    statusEl.innerHTML = `
      <div class="banner error">
        Injection failed: ${escape((err as Error).message)}.
      </div>
    `;
    btn.disabled = false;
    return;
  }

  if (!injectResp?.ok) {
    statusEl.innerHTML = `
      <div class="banner error">
        Injection failed: ${escape(injectResp?.error ?? "unknown error")}.
      </div>
    `;
    btn.disabled = false;
    return;
  }

  await send({ type: "pendingRetrieved", tabId });
  window.close();
}

function render(html: string): void {
  contentEl.innerHTML = html;
}

function renderDaemonUnreachable(detail?: string): void {
  render(`
    <div class="banner error">
      <strong>Daemon not reachable.</strong>
      ${detail ? `<div class="muted">${escape(detail)}</div>` : ""}
    </div>
    <div class="muted">Start it with:</div>
    <pre class="banner"><code>node daemon/dist/index.js</code></pre>
    <div class="controls">
      <button id="retry" class="primary">Retry connection</button>
    </div>
  `);
  document.getElementById("retry")!.addEventListener("click", () => void refresh());
}

function renderUnbound(tabId: number, config: DaemonConfig): void {
  if (config.projects.length === 0) {
    render(`
      <div class="banner warn">
        Daemon is up, but no projects are configured.
        Add one to <code>~/.bugger/config.json</code> (or
        <code>%APPDATA%\\bugger\\config.json</code>) and the dropdown will populate live.
      </div>
    `);
    return;
  }
  render(`
    <div class="row">
      <div class="label">This tab</div>
      <div class="value">Not bound to a project.</div>
    </div>
    <div class="row">
      <div class="label">Bind to</div>
      <select id="project-select">
        ${config.projects.map((p) => `<option value="${escape(p)}">${escape(p)}</option>`).join("")}
      </select>
    </div>
    <div class="controls">
      <button id="bind-btn" class="primary">Bind this tab</button>
    </div>
  `);
  document.getElementById("bind-btn")!.addEventListener("click", async () => {
    const select = document.getElementById("project-select") as HTMLSelectElement;
    const project = select.value;
    await send({ type: "setBinding", tabId, project });
    await refresh();
  });
}

function renderBound(
  tabId: number,
  project: string,
  config: DaemonConfig,
  armed: boolean,
): void {
  const missing = !config.projects.includes(project);
  const projectsForDropdown = missing ? [project, ...config.projects] : config.projects;

  // Arm state is the primary visual cue. Big primary button.
  const armButton = armed
    ? `<button id="disarm-btn" class="primary danger">DISARM</button>`
    : `<button id="arm-btn" class="primary">ARM</button>`;

  const armBanner = armed
    ? `<div class="banner armed"><strong>ARMED</strong> — next PROMPT block dispatches.</div>`
    : `<div class="banner"><strong>Disarmed</strong> — PROMPT blocks are ignored. Click ARM to enable.</div>`;

  render(`
    ${armBanner}
    <div class="row">
      <div class="label">Bound to</div>
      <div class="value ${missing ? "missing" : ""}">${escape(project)}${missing ? " (missing from daemon config)" : ""}</div>
    </div>
    ${missing ? `<div class="banner warn">This project is no longer in the daemon's config. Rebind or restore it before dispatching.</div>` : ""}
    <div class="row">
      <div class="label">Switch to</div>
      <select id="project-select">
        ${projectsForDropdown.map((p) => `<option value="${escape(p)}" ${p === project ? "selected" : ""}>${escape(p)}${p === project && missing ? " (missing)" : ""}</option>`).join("")}
      </select>
    </div>
    <div class="controls">
      ${armButton}
      <button id="stop-btn" class="danger">Stop</button>
    </div>
    <div class="controls" style="margin-top:6px;">
      <button id="rebind-btn">Rebind</button>
      <button id="ping-btn" ${missing ? "disabled" : ""}>Ping worker</button>
    </div>
    <div id="ping-result" class="muted" style="margin-top:8px;"></div>
    <div id="stop-result" class="muted" style="margin-top:4px;"></div>
  `);

  if (armed) {
    document.getElementById("disarm-btn")!.addEventListener("click", async () => {
      await send({ type: "setArmed", tabId, armed: false });
      await refresh();
    });
  } else {
    document.getElementById("arm-btn")!.addEventListener("click", async () => {
      await send({ type: "setArmed", tabId, armed: true });
      await refresh();
    });
  }

  document.getElementById("stop-btn")!.addEventListener("click", async () => {
    const resEl = document.getElementById("stop-result")!;
    resEl.textContent = "Stopping…";
    const resp = await send<{ ok?: boolean; error?: string; killed?: number; cleared?: number }>({
      type: "stopAll",
      tabId,
    });
    if (resp.ok) {
      resEl.textContent = `Stopped. Cancelled ${resp.cleared ?? 0} job(s).`;
    } else {
      resEl.textContent = `Stop failed: ${resp.error ?? "unknown error"}`;
    }
    // Refresh to flip the arm button back.
    await refresh();
  });

  // Rebind always writes — see commit history for why the early-return
  // was removed.
  document.getElementById("rebind-btn")!.addEventListener("click", async () => {
    const select = document.getElementById("project-select") as HTMLSelectElement;
    const next = select.value;
    await send({ type: "setBinding", tabId, project: next });
    await refresh();
  });

  document.getElementById("ping-btn")!.addEventListener("click", async () => {
    await runPing(project);
  });
}

async function runPing(project: string): Promise<void> {
  const resultEl = document.getElementById("ping-result")!;
  const button = document.getElementById("ping-btn") as HTMLButtonElement;
  button.disabled = true;
  resultEl.textContent = "Pinging…";
  const t0 = Date.now();
  const pingResp = await send<{ jobId?: string; error?: string; status?: number }>({ type: "ping", project });
  if (pingResp.error || !pingResp.jobId) {
    resultEl.textContent = `Ping failed: ${pingResp.error ?? "unknown"}${pingResp.status ? ` (HTTP ${pingResp.status})` : ""}`;
    button.disabled = false;
    return;
  }
  const jobId = pingResp.jobId;
  while (true) {
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, elapsed < 10_000 ? 1000 : 3000));
    const job = (await send({ type: "getJob", jobId })) as { status?: string; error?: string; createdAt?: number; endedAt?: number };
    if (job.error) {
      resultEl.textContent = `Ping failed: ${job.error}`;
      break;
    }
    if (job.status === "succeeded" || job.status === "failed") {
      const rtt = (job.endedAt ?? Date.now()) - (job.createdAt ?? t0);
      resultEl.textContent = `${job.status === "succeeded" ? "✓" : "✗"} round-trip ${rtt}ms`;
      break;
    }
  }
  button.disabled = false;
}

async function renderSettings(): Promise<void> {
  const settings = await send<Settings>({ type: "getSettings" });
  render(`
    <div class="row">
      <div class="label">Settings</div>
    </div>
    <div class="setting-row">
      <div>
        <div>Auto-submit injected results</div>
        <div class="muted">Off = type into chat input, don't click Send.</div>
      </div>
      <button id="autosubmit-toggle" class="toggle">${settings.autoSubmit ? "On" : "Off"}</button>
    </div>
    <div class="controls" style="margin-top:12px;">
      <button id="back-btn">Back</button>
    </div>
  `);
  document.getElementById("autosubmit-toggle")!.addEventListener("click", async () => {
    const next = !settings.autoSubmit;
    await send({ type: "setSettings", settings: { autoSubmit: next } });
    await renderSettings();
  });
  document.getElementById("back-btn")!.addEventListener("click", () => {
    showingSettings = false;
    void refresh();
  });
}

settingsToggleBtn.addEventListener("click", () => {
  showingSettings = !showingSettings;
  void refresh();
});

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

window.addEventListener("focus", () => void refresh());

void refresh();

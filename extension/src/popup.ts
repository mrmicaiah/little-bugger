// Popup UI. Four states: daemon-unreachable, unbound, bound-idle,
// bound-dispatching. Plus an inline settings pane (auto-submit toggle).

type Settings = { autoSubmit: boolean };
type DaemonConfig = { projects: string[] };
type DaemonError = { error: string; status?: number };

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

  // Check daemon reachability first — gates everything else.
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

  const [bindingResp, configResp] = await Promise.all([
    send<{ project: string | null }>({ type: "getBinding", tabId: tab.id }),
    send<DaemonConfig | DaemonError>({ type: "getDaemonConfig" }),
  ]);

  if ("error" in configResp) {
    renderDaemonUnreachable(configResp.error);
    return;
  }

  if (bindingResp.project) {
    renderBound(tab.id, bindingResp.project, configResp);
  } else {
    renderUnbound(tab.id, configResp);
  }
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

function renderBound(tabId: number, project: string, config: DaemonConfig): void {
  const missing = !config.projects.includes(project);
  const projectsForDropdown = missing ? [project, ...config.projects] : config.projects;

  render(`
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
      <button id="rebind-btn">Rebind</button>
      <button id="ping-btn" ${missing ? "disabled" : ""}>Ping worker</button>
    </div>
    <div id="ping-result" class="muted" style="margin-top:8px;"></div>
  `);

  document.getElementById("rebind-btn")!.addEventListener("click", async () => {
    const select = document.getElementById("project-select") as HTMLSelectElement;
    const next = select.value;
    if (next === project) return;
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
  // Poll the job. Adaptive backoff matches content script.
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

// Re-render whenever the popup regains focus.
window.addEventListener("focus", () => void refresh());

void refresh();

// Service worker. Kept deliberately small — MV3's SW sleeps after ~30s idle.
// Responsibilities:
//   - icon updates per tab (binding state × daemon reachability × dispatch state × arm state)
//   - proxy daemon endpoints the popup needs (config, ping, clear)
//   - tab cleanup on close (storage hygiene)
//   - light /health cache (10s TTL) to avoid hammering the daemon

import * as daemon from "./lib/daemonClient.js";
import {
  getBinding,
  setBinding,
  clearBinding,
  getSettings,
  setSettings,
  addDispatchingTab,
  removeDispatchingTab,
  getDispatchingTabs,
  getPendingResult,
  setPendingResult,
  clearPendingResult,
  getArmed,
  setArmed,
  type Settings,
} from "./lib/tabBinding.js";

const HEALTH_CACHE_TTL = 10_000;
let healthCache: { ok: boolean; timestamp: number } | null = null;

async function isDaemonReachable(force = false): Promise<boolean> {
  if (!force && healthCache && Date.now() - healthCache.timestamp < HEALTH_CACHE_TTL) {
    return healthCache.ok;
  }
  const h = await daemon.health();
  healthCache = { ok: h !== null, timestamp: Date.now() };
  return healthCache.ok;
}

type IconState = "gray" | "green" | "orange" | "purple";

async function resolveIconState(tabId: number): Promise<IconState> {
  const dispatching = await getDispatchingTabs();
  if (dispatching.has(tabId)) return "orange";
  const pending = await getPendingResult(tabId);
  if (pending) return "purple";
  const binding = await getBinding(tabId);
  const reachable = await isDaemonReachable();
  if (binding && reachable) return "green";
  return "gray";
}

async function updateBadge(tabId: number, state: IconState): Promise<void> {
  let text = "";
  let color = "#00000000";
  if (state === "orange") {
    text = "...";
    color = "#d97706";
  } else if (state === "purple") {
    text = "!";
    color = "#7c4dff";
  } else if (state === "green") {
    // Show arm state on the green icon: "ARM" badge means armed (ready to fire),
    // no badge means disarmed (the safe default). The wording is
    // counterintuitive at first — "ARM" sounds like a warning — but it matches
    // the popup button label so the meaning carries over.
    const armed = await getArmed(tabId);
    if (armed) {
      text = "ARM";
      color = "#16a34a"; // green-600
    }
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Tab may have closed; harmless.
  }
}

async function updateIcon(tabId: number): Promise<void> {
  const state = await resolveIconState(tabId);
  try {
    await chrome.action.setIcon({
      tabId,
      path: {
        16: `icons/bug-${state}-16.png`,
        32: `icons/bug-${state}-32.png`,
        48: `icons/bug-${state}-48.png`,
        128: `icons/bug-${state}-128.png`,
      },
    });
  } catch {
    // Tab may have closed between the state lookup and the icon set; harmless.
  }
  await updateBadge(tabId, state);
}

async function updateAllVisibleIcons(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  for (const tab of tabs) {
    if (tab.id !== undefined) await updateIcon(tab.id);
  }
}

// --- lifecycle hooks --------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updateIcon(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
  if (tab.url && tab.url.startsWith("https://claude.ai/")) {
    void updateIcon(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearBinding(tabId);
  void removeDispatchingTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void updateAllVisibleIcons();
});

chrome.runtime.onStartup.addListener(() => {
  void updateAllVisibleIcons();
});

// --- message handling -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => {
      console.error(`[bugger:sw] handler error: ${(err as Error).message}`);
      sendResponse({ error: (err as Error).message });
    });
  return true; // async response
});

async function handleMessage(
  msg: { type?: string } & Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (msg?.type) {
    case "getBindingForMe": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { project: null };
      return { project: await getBinding(tabId) };
    }

    case "getBinding": {
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      if (tabId === undefined) return { project: null };
      return { project: await getBinding(tabId) };
    }

    case "setBinding": {
      const tabId = msg["tabId"] as number;
      const project = msg["project"] as string;
      if (typeof tabId !== "number" || typeof project !== "string") {
        return { error: "tabId and project required" };
      }
      await setBinding(tabId, project);
      await updateIcon(tabId);
      chrome.tabs.sendMessage(tabId, { type: "bindingChanged", project }).catch(() => {});
      return { ok: true };
    }

    case "getDaemonConfig": {
      const config = await daemon.getConfig();
      if (!config) {
        healthCache = { ok: false, timestamp: Date.now() };
        return { error: "daemon unreachable" };
      }
      healthCache = { ok: true, timestamp: Date.now() };
      return config;
    }

    case "isDaemonReachable": {
      const force = msg["force"] === true;
      return { reachable: await isDaemonReachable(force) };
    }

    case "ping": {
      const project = msg["project"] as string;
      if (typeof project !== "string") return { error: "project required" };
      return await daemon.ping(project);
    }

    case "getJob": {
      const jobId = msg["jobId"] as string;
      if (typeof jobId !== "string") return { error: "jobId required" };
      return await daemon.getJob(jobId);
    }

    case "dispatchStart": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      await addDispatchingTab(tabId);
      await updateIcon(tabId);
      return { ok: true };
    }

    case "dispatchEnd": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      await removeDispatchingTab(tabId);
      await updateIcon(tabId);
      return { ok: true };
    }

    case "getSettings": {
      return await getSettings();
    }

    case "setSettings": {
      const patch = msg["settings"] as Partial<Settings>;
      await setSettings(patch);
      const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
      const merged = await getSettings();
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          chrome.tabs
            .sendMessage(tab.id, { type: "settingsChanged", autoSubmit: merged.autoSubmit })
            .catch(() => {});
        }
      }
      return { ok: true };
    }

    // --- ARM / DISARM / STOP -----------------------------------------------

    case "forceDisarmMe": {
      // Called by content script on init. Always wipe stored arm state for
      // this tab so a reload starts disarmed.
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      await setArmed(tabId, false);
      await updateIcon(tabId);
      return { ok: true };
    }

    case "getArmed": {
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      if (tabId === undefined) return { armed: false };
      return { armed: await getArmed(tabId) };
    }

    case "setArmed": {
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      const armed = msg["armed"] === true;
      if (tabId === undefined) return { error: "tabId required" };
      await setArmed(tabId, armed);
      await updateIcon(tabId);
      chrome.tabs.sendMessage(tabId, { type: "armChanged", armed }).catch(() => {});
      return { ok: true };
    }

    case "stopAll": {
      // Big red button: clear daemon job queue + disarm current tab.
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      const clearResult = await daemon.clearJobs();
      if (tabId !== undefined) {
        await setArmed(tabId, false);
        await updateIcon(tabId);
        chrome.tabs.sendMessage(tabId, { type: "armChanged", armed: false }).catch(() => {});
      }
      if (daemon.isDaemonError(clearResult)) {
        return { ok: false, error: clearResult.error };
      }
      return { ok: true, killed: clearResult.killed, cleared: clearResult.cleared };
    }

    // --- Pending result ----------------------------------------------------

    case "pendingResult": {
      const tabId = sender.tab?.id;
      const jobId = msg["jobId"];
      const project = msg["project"];
      if (tabId === undefined || typeof jobId !== "string" || typeof project !== "string") {
        return { error: "tabId, jobId, project required" };
      }
      await setPendingResult(tabId, jobId, project);
      await updateIcon(tabId);
      return { ok: true };
    }

    case "getPendingForTab": {
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      if (tabId === undefined) return null;
      return await getPendingResult(tabId);
    }

    case "retrievePending": {
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      if (tabId === undefined) return { error: "tabId required" };
      const pending = await getPendingResult(tabId);
      if (!pending) return { error: "no pending result" };
      const job = await daemon.getJob(pending.jobId);
      if (job === null) {
        return { error: "daemon unreachable" };
      }
      if (daemon.isDaemonError(job)) {
        await clearPendingResult(tabId);
        await updateIcon(tabId);
        return { error: job.error };
      }
      return { job };
    }

    case "pendingRetrieved": {
      const tabId = typeof msg["tabId"] === "number" ? (msg["tabId"] as number) : sender.tab?.id;
      if (tabId === undefined) return { error: "tabId required" };
      await clearPendingResult(tabId);
      await updateIcon(tabId);
      return { ok: true };
    }

    default:
      return { error: `unknown message type: ${msg?.type}` };
  }
}

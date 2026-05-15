// Tab → project bindings, persisted in chrome.storage.session.
// Session storage clears on browser restart, which matches the SPEC: a tab's
// binding lives as long as the tab is open, lost on restart, fresh decision.

const STORAGE_KEY_PREFIX = "binding:";
const PENDING_KEY_PREFIX = "pending:";
const ARMED_KEY_PREFIX = "armed:";
const SETTINGS_KEY = "settings";
const DISPATCHING_TABS_KEY = "dispatching-tabs";

export type PendingResult = {
  jobId: string;
  project: string;
  timestamp: number;
};

export type Settings = {
  autoSubmit: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  autoSubmit: true,
};

function bindingKey(tabId: number): string {
  return `${STORAGE_KEY_PREFIX}${tabId}`;
}

function pendingKey(tabId: number): string {
  return `${PENDING_KEY_PREFIX}${tabId}`;
}

function armedKey(tabId: number): string {
  return `${ARMED_KEY_PREFIX}${tabId}`;
}

export async function getBinding(tabId: number): Promise<string | null> {
  const key = bindingKey(tabId);
  const result = await chrome.storage.session.get(key);
  const value = result[key];
  return typeof value === "string" ? value : null;
}

export async function setBinding(tabId: number, project: string): Promise<void> {
  await chrome.storage.session.set({ [bindingKey(tabId)]: project });
}

export async function clearBinding(tabId: number): Promise<void> {
  await chrome.storage.session.remove([bindingKey(tabId), pendingKey(tabId), armedKey(tabId)]);
}

export async function getPendingResult(tabId: number): Promise<PendingResult | null> {
  const key = pendingKey(tabId);
  const result = await chrome.storage.session.get(key);
  const value = result[key];
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PendingResult).jobId === "string" &&
    typeof (value as PendingResult).project === "string" &&
    typeof (value as PendingResult).timestamp === "number"
  ) {
    return value as PendingResult;
  }
  return null;
}

export async function setPendingResult(
  tabId: number,
  jobId: string,
  project: string,
): Promise<void> {
  const pending: PendingResult = { jobId, project, timestamp: Date.now() };
  await chrome.storage.session.set({ [pendingKey(tabId)]: pending });
}

export async function clearPendingResult(tabId: number): Promise<void> {
  await chrome.storage.session.remove(pendingKey(tabId));
}

// --- Arm state -------------------------------------------------------------
//
// Armed = the tab will dispatch when PROMPT blocks are detected.
// Disarmed = PROMPT blocks are detected and ignored.
//
// DEFAULT IS DISARMED. Every page load starts disarmed. The user must
// explicitly click "Arm" in the popup before any dispatch fires. This is
// the central design choice: no more guessing whether a re-rendered block
// is historical or new — the system just doesn't fire unless armed.
//
// Armed state is keyed by tab id and stored in chrome.storage.session, so it
// survives within the same browser session if the user navigates within the
// tab, but a hard reload of the tab re-creates the same tab id and the state
// IS preserved — which is FINE, because content script init does NOT trust
// the stored armed state; it explicitly clears it on init. See content.ts.

export async function getArmed(tabId: number): Promise<boolean> {
  const key = armedKey(tabId);
  const result = await chrome.storage.session.get(key);
  return result[key] === true;
}

export async function setArmed(tabId: number, armed: boolean): Promise<void> {
  await chrome.storage.session.set({ [armedKey(tabId)]: armed });
}

// --- Settings --------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.session.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY];
  if (typeof stored !== "object" || stored === null) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function setSettings(s: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.session.set({ [SETTINGS_KEY]: { ...current, ...s } });
}

// Tabs currently mid-dispatch. We store the set so the icon stays orange
// across SW sleep/wake.
export async function getDispatchingTabs(): Promise<Set<number>> {
  const result = await chrome.storage.session.get(DISPATCHING_TABS_KEY);
  const stored = result[DISPATCHING_TABS_KEY];
  if (!Array.isArray(stored)) return new Set();
  return new Set(stored.filter((x): x is number => typeof x === "number"));
}

export async function addDispatchingTab(tabId: number): Promise<void> {
  const set = await getDispatchingTabs();
  set.add(tabId);
  await chrome.storage.session.set({ [DISPATCHING_TABS_KEY]: [...set] });
}

export async function removeDispatchingTab(tabId: number): Promise<void> {
  const set = await getDispatchingTabs();
  set.delete(tabId);
  await chrome.storage.session.set({ [DISPATCHING_TABS_KEY]: [...set] });
}

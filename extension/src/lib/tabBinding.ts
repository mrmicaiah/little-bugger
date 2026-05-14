// Tab → project bindings, persisted in chrome.storage.session.
// Session storage clears on browser restart, which matches the SPEC: a tab's
// binding lives as long as the tab is open, lost on restart, fresh decision.

const STORAGE_KEY_PREFIX = "binding:";
const SETTINGS_KEY = "settings";
const DISPATCHING_TABS_KEY = "dispatching-tabs";

export type Settings = {
  autoSubmit: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  autoSubmit: true,
};

function bindingKey(tabId: number): string {
  return `${STORAGE_KEY_PREFIX}${tabId}`;
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
  await chrome.storage.session.remove(bindingKey(tabId));
}

// chrome.storage.session also persists settings across SW restarts within a
// session. Settings reset to defaults on browser restart, which is fine —
// they're trivial.
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

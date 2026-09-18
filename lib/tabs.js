function isPanelWindow(win) {
  if (!win) return false;
  if (win.type === "popup") return true;
  return (win.tabs || []).some((tab) => /\/panel\/panel\.html/.test(tab.url || ""));
}

export async function findBrowserWindowId() {
  const windows = await chrome.windows.getAll({ populate: true });
  const pool = windows.filter((win) => win.type === "normal" && !isPanelWindow(win));
  return (pool.find((win) => win.focused) || pool[0])?.id ?? null;
}

export async function findPanelWindowId() {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows.find(isPanelWindow)?.id ?? null;
}

export async function findXClientTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!tabs.length) return null;
  const panelId = await findPanelWindowId();
  const ranked = tabs
    .filter((tab) => tab.windowId !== panelId)
    .filter((tab) => !/\/i\/jf\//.test(tab.url || ""))
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return ranked[0] || tabs.find((tab) => tab.windowId !== panelId) || tabs[0];
}

export async function openInBrowser(url, { active = true, reuseXTab = true } = {}) {
  const windowId = await findBrowserWindowId();
  if (windowId == null) {
    const win = await chrome.windows.create({ url, type: "normal", focused: active });
    return win.tabs?.[0] || null;
  }
  if (reuseXTab) {
    const tabs = await chrome.tabs.query({ windowId, url: ["https://x.com/*", "https://twitter.com/*"] });
    const tab = tabs.find((item) => item.active) || tabs[0];
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url, active: true });
      if (active) await chrome.windows.update(windowId, { focused: true });
      return tab;
    }
  }
  const tab = await chrome.tabs.create({ url, windowId, active });
  if (active) await chrome.windows.update(windowId, { focused: true });
  return tab;
}

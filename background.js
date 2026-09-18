chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE" && message.payload) {
    chrome.storage.local.get("captured").then(({ captured }) => {
      const next = { ...(captured || {}), ...message.payload };
      if (message.payload.queryIds) {
        next.queryIds = { ...(captured?.queryIds || {}), ...message.payload.queryIds };
      }
      return chrome.storage.local.set({ captured: next });
    });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.__xtool === "CAPTURE") {
    chrome.runtime.sendMessage({ type: "CAPTURE", payload: event.data.payload }).catch(() => {});
  }
  if (event.data?.__xtool === "CREATOR_GQL") {
    chrome.runtime.sendMessage({
      type: "CREATOR_GQL",
      operation: event.data.operation,
      json: event.data.json,
    }).catch(() => {});
  }
});

function readViewerFromDom() {
  const img =
    document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] img') ||
    document.querySelector('[data-testid="AppTabBar_Profile_Link"] img');
  const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const href = link?.getAttribute("href") || "";
  const handle = href.replace(/^\//, "").split("/")[0];
  const blocked = new Set(["home", "explore", "i", "notifications", "messages", "search"]);
  return {
    avatar: img?.currentSrc || img?.src || "",
    name: img?.alt || "",
    screenName: handle && !blocked.has(handle) ? handle : "",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "REQUEST_CAPTURE") {
    window.postMessage({ __xtool: "REQUEST_CAPTURE" }, "*");
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "GET_VIEWER") {
    sendResponse(readViewerFromDom());
    return false;
  }

  if (message?.type === "SCRAPE_REWARDS") {
    sendResponse(scrapeCreatorRewards());
    return false;
  }

  if (message?.type === "PAGE_FETCH") {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      sendResponse({ ok: false, status: 0, error: "timeout" });
    }, 20000);

    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.data?.__xtool !== "FETCH_RESULT" || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      sendResponse(event.data);
    };

    window.addEventListener("message", onMsg);
    window.postMessage(
      {
        __xtool: "FETCH",
        id,
        url: message.url,
        headers: message.headers,
        method: message.method || "GET",
        body: message.body ?? null,
      },
      "*"
    );
    return true;
  }

  return false;
});

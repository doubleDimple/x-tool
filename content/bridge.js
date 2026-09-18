window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.__xtool !== "CAPTURE") return;
  chrome.runtime.sendMessage({ type: "CAPTURE", payload: event.data.payload }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "REQUEST_CAPTURE") {
    window.postMessage({ __xtool: "REQUEST_CAPTURE" }, "*");
    sendResponse({ ok: true });
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
      { __xtool: "FETCH", id, url: message.url, headers: message.headers },
      "*"
    );
    return true;
  }

  return false;
});

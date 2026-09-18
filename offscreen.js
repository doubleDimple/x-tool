import { runFollow, runUnfollow } from "./lib/scan.js";

let abort = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_START") {
    abort?.abort();
    abort = new AbortController();
    const run = message.kind === "follow" ? runFollow : runUnfollow;
    run(message.users, {
      signal: abort.signal,
      onProgress: (progress) => {
        chrome.runtime.sendMessage({ type: "FRIENDSHIP_PROGRESS", kind: message.kind, progress }).catch(() => {});
      },
    })
      .then((result) => {
        chrome.runtime.sendMessage({ type: "FRIENDSHIP_DONE", kind: message.kind, result }).catch(() => {});
      })
      .catch((error) => {
        chrome.runtime.sendMessage({
          type: "FRIENDSHIP_DONE",
          kind: message.kind,
          error: { name: error.name, message: error.message, code: error.code },
        }).catch(() => {});
      });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "OFFSCREEN_STOP") {
    abort?.abort();
    sendResponse({ ok: true });
  }
  return false;
});

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});

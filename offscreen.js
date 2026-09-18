import { setCapturedOverride } from "./lib/api.js";
import { runFollow, runUnfollow } from "./lib/scan.js";

const JOB_KEY = "friendshipJob";
let abort = null;

async function readJob() {
  try {
    if (!chrome?.storage?.local) return null;
    const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
    return job || null;
  } catch {
    return null;
  }
}

async function loadUsers(message) {
  if (Array.isArray(message?.users) && message.users.length) return message.users;
  if (message?.users && message.users.id) return [message.users];
  const job = await readJob();
  if (Array.isArray(job?.users) && job.users.length) return job.users;
  return [];
}

function emitDone(kind, token, payload) {
  chrome.runtime
    .sendMessage({
      type: "FRIENDSHIP_DONE",
      kind,
      token,
      ...payload,
    })
    .catch(() => {});
}

async function startJob(message) {
  abort?.abort();
  abort = new AbortController();
  const job = await readJob();
  const kind = message.kind || job?.kind;
  const token = message.token || job?.token;
  const users = await loadUsers(message);
  const run = kind === "follow" ? runFollow : runUnfollow;
  setCapturedOverride(message.captured);
  try {
    const result = await run(users, {
      signal: abort.signal,
      auth: message.auth,
      onProgress: (progress) => {
        chrome.runtime.sendMessage({ type: "FRIENDSHIP_PROGRESS", kind, progress }).catch(() => {});
      },
    });
    emitDone(kind, token, { result, total: users.length });
  } catch (error) {
    emitDone(kind, token, {
      error: { name: error.name, message: error.message, code: error.code },
      total: users.length,
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_START") {
    sendResponse({ ok: true });
    startJob(message).catch((error) => {
      emitDone(message.kind, message.token, {
        error: { name: error.name, message: error.message, code: error.code },
      });
    });
    return false;
  }
  if (message?.type === "OFFSCREEN_STOP") {
    abort?.abort();
    sendResponse({ ok: true });
  }
  return false;
});

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});

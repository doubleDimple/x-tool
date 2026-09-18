import {
  REWARD_ALARM,
  REWARD_HOUR,
  hasTodaySnapshot,
  pullRewards,
  syncRewardAlarm,
} from "./lib/rewards.js";
import { applyFollowed, applyUnfollowed, persistable } from "./lib/graph.js";
import { jobDoneText, jobSuccessText, notifyCurrentPage } from "./lib/notify.js";
import { runFollow, runUnfollow } from "./lib/scan.js";

const JOB_KEY = "friendshipJob";
let offscreenReadyWait = null;
let swAbort = null;
let launching = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return Boolean(contexts?.length);
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  offscreenReadyWait = Promise.withResolvers ? Promise.withResolvers() : null;
  let ready = offscreenReadyWait?.promise;
  if (!offscreenReadyWait) {
    let resolve;
    ready = new Promise((r) => {
      resolve = r;
    });
    offscreenReadyWait = { resolve, promise: ready };
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_SCRAPING"],
      justification: "Keep follow and unfollow running after the window is closed",
    });
  } catch (error) {
    if (!/already|single/i.test(String(error.message))) throw error;
  }
  await Promise.race([ready, wait(2500)]);
  offscreenReadyWait = null;
  return hasOffscreen();
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* none */
  }
}

async function saveJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function applyProgress(kind, progress) {
  const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
  if (!job) return;
  const prevDone = job.doneCount || 0;
  const nextDone = progress?.doneCount || 0;
  await saveJob({
    ...job,
    status: "running",
    ...progress,
    ok: job.ok,
    fail: job.fail,
  });
  if (nextDone > prevDone && progress?.user) {
    notifyCurrentPage(jobSuccessText(kind || job.kind, progress), {
      title: (kind || job.kind) === "follow" ? "X-Tool 关注" : "X-Tool 取关",
    }).catch(() => {});
  }
}

async function finishJob(kind, payload, { broadcast = true } = {}) {
  const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
  const result = payload.result || { ok: [], fail: [] };
  if (result.ok?.length) {
    await patchResult(kind || job?.kind, result.ok);
    if ((kind || job?.kind) === "unfollow") {
      const day = new Date().toISOString().slice(0, 10);
      const { unfollowDay } = await chrome.storage.local.get("unfollowDay");
      const count = (unfollowDay?.day === day ? unfollowDay.count : 0) + result.ok.length;
      await chrome.storage.local.set({ unfollowDay: { day, count } });
    }
  }
  await saveJob({
    ...(job || {}),
    kind: kind || job?.kind,
    status: payload.error?.name === "AbortError" ? "stopped" : "done",
    doneCount: result.ok?.length || 0,
    failCount: result.fail?.length || 0,
    ok: result.ok || [],
    fail: result.fail || [],
    error: payload.error || null,
    total: job?.total || (result.ok?.length || 0) + (result.fail?.length || 0),
  });
  await closeOffscreen();
  notifyCurrentPage(jobDoneText(kind || job?.kind, result, payload.error), {
    title: (kind || job?.kind) === "follow" ? "X-Tool 关注" : "X-Tool 取关",
  }).catch(() => {});
  if (broadcast) {
    chrome.runtime.sendMessage({
      type: "FRIENDSHIP_DONE",
      kind: kind || job?.kind,
      result,
      error: payload.error,
    }).catch(() => {});
  }
}

async function runJobInSw(kind, users) {
  swAbort?.abort();
  swAbort = new AbortController();
  const run = kind === "follow" ? runFollow : runUnfollow;
  try {
    const result = await run(users, {
      signal: swAbort.signal,
      onProgress: (progress) => {
        applyProgress(kind, progress);
        chrome.runtime.sendMessage({ type: "FRIENDSHIP_PROGRESS", kind, progress }).catch(() => {});
      },
    });
    await finishJob(kind, { result });
  } catch (error) {
    await finishJob(kind, {
      result: { ok: [], fail: [] },
      error: { name: error.name, message: error.message, code: error.code },
    });
  }
}

function newJob(kind, users) {
  return {
    kind,
    status: "running",
    total: users.length,
    doneCount: 0,
    failCount: 0,
    ok: [],
    fail: [],
    user: users[0] || null,
  };
}

async function sendOffscreenStart(kind, users) {
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_START", kind, users });
    return true;
  } catch (error) {
    return !/Receiving end does not exist/i.test(String(error?.message || error));
  }
}

async function launchFriendship(kind, users) {
  launching = true;
  try {
    const ready = await ensureOffscreen();
    if (ready) {
      let started = await sendOffscreenStart(kind, users);
      if (!started) {
        await wait(200);
        started = await sendOffscreenStart(kind, users);
      }
      if (started) return;
    }
    await runJobInSw(kind, users);
  } catch {
    await runJobInSw(kind, users);
  } finally {
    launching = false;
  }
}

async function patchResult(kind, okUsers) {
  if (!okUsers?.length) return;
  const { lastResult } = await chrome.storage.local.get("lastResult");
  if (!lastResult) return;
  const next = kind === "follow" ? applyFollowed(lastResult, okUsers) : applyUnfollowed(lastResult, okUsers);
  await chrome.storage.local.set({ lastResult: persistable(next) });
}

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
  if (message?.type === "CREATOR_GQL" && message.json) {
    chrome.storage.local.set({
      creatorGql: { operation: message.operation, json: message.json, at: Date.now() },
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "SET_REWARD_AUTO") {
    chrome.storage.local.set({ rewardAuto: Boolean(message.enabled) }).then(async () => {
      const when = await syncRewardAlarm(Boolean(message.enabled));
      sendResponse({ ok: true, when });
    });
    return true;
  }
  if (message?.type === "OFFSCREEN_READY") {
    offscreenReadyWait?.resolve?.(true);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "START_FRIENDSHIP") {
    const { kind, users } = message;
    saveJob(newJob(kind, users))
      .then(() => {
        sendResponse({ ok: true });
        setTimeout(() => {
          launchFriendship(kind, users).catch(() => {});
        }, 0);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "STOP_FRIENDSHIP") {
    swAbort?.abort();
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
    chrome.storage.local.get(JOB_KEY).then(async ({ [JOB_KEY]: job }) => {
      if (job) await saveJob({ ...job, status: "stopped" });
      await closeOffscreen();
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "GET_FRIENDSHIP_JOB") {
    chrome.storage.local.get(JOB_KEY).then(async ({ [JOB_KEY]: job }) => {
      if (job?.status === "running" && !launching && !(await hasOffscreen()) && !swAbort) {
        job.status = "stopped";
        await saveJob(job);
      }
      sendResponse({ job: job || null });
    });
    return true;
  }
  if (message?.type === "FRIENDSHIP_PROGRESS") {
    applyProgress(message.kind, message.progress || {}).catch(() => {});
    return false;
  }
  if (message?.type === "FRIENDSHIP_DONE") {
    finishJob(message.kind, { result: message.result, error: message.error }, { broadcast: false }).catch(() => {});
    return false;
  }
  if (message?.type === "GET_REWARD_AUTO") {
    chrome.storage.local.get("rewardAuto").then(async ({ rewardAuto }) => {
      const alarm = await chrome.alarms.get(REWARD_ALARM);
      sendResponse({ enabled: Boolean(rewardAuto), when: alarm?.scheduledTime || null });
    });
    return true;
  }
  return false;
});

async function runDailyRewards() {
  const { rewardAuto } = await chrome.storage.local.get("rewardAuto");
  if (!rewardAuto) return;
  try {
    await pullRewards({ background: true });
  } catch {
    /* try again next alarm / startup */
  }
  await syncRewardAlarm(true);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REWARD_ALARM) runDailyRewards();
});

async function bootSchedule() {
  const { rewardAuto } = await chrome.storage.local.get("rewardAuto");
  if (!rewardAuto) {
    await syncRewardAlarm(false);
    return;
  }
  await syncRewardAlarm(true);
  if (new Date().getHours() >= REWARD_HOUR && !(await hasTodaySnapshot())) {
    await runDailyRewards();
  }
}

let panelWindowId = null;

async function openPanelWindow() {
  if (panelWindowId != null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch {
      panelWindowId = null;
    }
  }
  const { panelBounds } = await chrome.storage.local.get("panelBounds");
  const create = {
    url: chrome.runtime.getURL("panel/panel.html"),
    type: "popup",
    focused: true,
    width: Math.max(320, panelBounds?.width || 380),
    height: Math.max(480, panelBounds?.height || 640),
  };
  if (Number.isFinite(panelBounds?.left)) create.left = panelBounds.left;
  if (Number.isFinite(panelBounds?.top)) create.top = panelBounds.top;
  const win = await chrome.windows.create(create);
  panelWindowId = win.id ?? null;
}

chrome.action.onClicked.addListener(() => {
  openPanelWindow();
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

let boundsTimer = 0;
chrome.windows.onBoundsChanged?.addListener((win) => {
  if (win.id !== panelWindowId) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    chrome.storage.local.set({
      panelBounds: { width: win.width, height: win.height, left: win.left, top: win.top },
    });
  }, 250);
});

chrome.runtime.onInstalled.addListener(() => {
  bootSchedule();
});
chrome.runtime.onStartup.addListener(() => {
  bootSchedule();
});
bootSchedule();

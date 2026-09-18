import {
  REWARD_ALARM,
  REWARD_HOUR,
  hasTodaySnapshot,
  pullRewards,
  syncRewardAlarm,
} from "./lib/rewards.js";
import { applyFollowed, applyUnfollowed, persistable } from "./lib/graph.js";

const JOB_KEY = "friendshipJob";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts?.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_SCRAPING"],
    justification: "Keep follow and unfollow running after the window is closed",
  });
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
  if (message?.type === "START_FRIENDSHIP") {
    ensureOffscreen()
      .then(async () => {
        const job = {
          kind: message.kind,
          status: "running",
          total: message.users.length,
          doneCount: 0,
          failCount: 0,
          ok: [],
          fail: [],
          user: message.users[0] || null,
        };
        await saveJob(job);
        await new Promise((r) => setTimeout(r, 150));
        chrome.runtime.sendMessage({ type: "OFFSCREEN_START", kind: message.kind, users: message.users }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "STOP_FRIENDSHIP") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
    chrome.storage.local.get(JOB_KEY).then(({ [JOB_KEY]: job }) => {
      if (job) saveJob({ ...job, status: "stopped" });
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "GET_FRIENDSHIP_JOB") {
    chrome.storage.local.get(JOB_KEY).then(({ [JOB_KEY]: job }) => sendResponse({ job: job || null }));
    return true;
  }
  if (message?.type === "FRIENDSHIP_PROGRESS") {
    chrome.storage.local.get(JOB_KEY).then(({ [JOB_KEY]: job }) => {
      if (!job) return;
      saveJob({
        ...job,
        status: "running",
        ...message.progress,
        ok: job.ok,
        fail: job.fail,
      });
    });
    return false;
  }
  if (message?.type === "FRIENDSHIP_DONE") {
    (async () => {
      const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
      const result = message.result || { ok: [], fail: [] };
      if (result.ok?.length) {
        await patchResult(message.kind || job?.kind, result.ok);
        if ((message.kind || job?.kind) === "unfollow") {
          const day = new Date().toISOString().slice(0, 10);
          const { unfollowDay } = await chrome.storage.local.get("unfollowDay");
          const count = (unfollowDay?.day === day ? unfollowDay.count : 0) + result.ok.length;
          await chrome.storage.local.set({ unfollowDay: { day, count } });
        }
      }
      await saveJob({
        ...(job || {}),
        kind: message.kind || job?.kind,
        status: message.error?.name === "AbortError" ? "stopped" : "done",
        doneCount: result.ok?.length || 0,
        failCount: result.fail?.length || 0,
        ok: result.ok || [],
        fail: result.fail || [],
        error: message.error || null,
        total: job?.total || (result.ok?.length || 0) + (result.fail?.length || 0),
      });
      await closeOffscreen();
    })();
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

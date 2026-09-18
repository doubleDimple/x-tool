import {
  REWARD_ALARM,
  REWARD_HOUR,
  hasTodaySnapshot,
  pullRewards,
  syncRewardAlarm,
} from "./lib/rewards.js";

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

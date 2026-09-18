import { getAuth, graphqlRequest } from "./api.js";
import { openInBrowser } from "./tabs.js";

const IMPRESSION_GOAL = 500_000;
const VERIFIED_FOLLOWER_GOAL = 500;
const REWARDS_PAGE = "https://x.com/i/jf/creators/original_content_rewards";
const STUDIO_URLS = [
  REWARDS_PAGE,
  "https://x.com/i/jf/creators/studio",
  "https://x.com/i/monetization",
];

export { IMPRESSION_GOAL, VERIFIED_FOLLOWER_GOAL, STUDIO_URLS, REWARDS_PAGE };

export function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function formatCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}K`.replace(".0K", "K");
  return String(Math.round(v));
}

export function parseCompact(text) {
  if (text == null) return null;
  const m = String(text)
    .replace(/,/g, "")
    .trim()
    .match(/^([\d.]+)\s*([KMB万千K])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || "").toUpperCase();
  if (u === "K" || u === "千") return Math.round(n * 1000);
  if (u === "M") return Math.round(n * 1_000_000);
  if (u === "万") return Math.round(n * 10_000);
  if (u === "B") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

function looksLikeImpressionTotal(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 50_000_000 && n !== 90 && n !== 500 && n !== 18 && n !== 50;
}

function pickCurrentAgainstGoal(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const nums = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "number") nums[key.toLowerCase()] = value;
  }
  const target = nums.target ?? nums.goal ?? nums.threshold ?? nums.required ?? nums.limit ?? nums.requirement;
  const current =
    nums.current ??
    nums.currentvalue ??
    nums.currentcount ??
    nums.progressvalue ??
    nums.count ??
    nums.value ??
    nums.impressions ??
    nums.impressioncount;
  if (target === IMPRESSION_GOAL && typeof current === "number" && current !== IMPRESSION_GOAL) return current;
  const hasGoal = Object.values(nums).includes(IMPRESSION_GOAL);
  if (hasGoal && typeof nums.progress === "number" && nums.progress > 0 && nums.progress < 1) {
    return Math.round(nums.progress * IMPRESSION_GOAL);
  }
  return null;
}

export function parseCreatorPayload(json) {
  const found = {
    impressions90d: null,
    verifiedFollowers: null,
    premium: null,
    ageOk: null,
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const paired = pickCurrentAgainstGoal(node);
    if (paired != null && looksLikeImpressionTotal(paired) && found.impressions90d == null) {
      found.impressions90d = paired;
    }
    for (const [key, value] of Object.entries(node)) {
      const k = key.toLowerCase();
      if (typeof value === "number") {
        if (/verifiedfollower/i.test(k) && value >= 0 && value < 10_000_000) found.verifiedFollowers = value;
      }
      if (typeof value === "boolean") {
        if (/premium|subscribed|is_blue/i.test(k) && found.premium == null) found.premium = value;
        if (/age|eighteen|is_18/i.test(k) && found.ageOk == null) found.ageOk = value;
      }
      if (typeof value === "string" && /eligib|home[_ ]?timeline|qualifiedimpression/i.test(k)) {
        const compact = value.replace(/\s+/g, "");
        if (/^\d+\.\d+[Kk]$/.test(compact) && found.impressions90d == null) {
          const n = parseCompact(compact);
          if (n != null && looksLikeImpressionTotal(n) && n !== IMPRESSION_GOAL) found.impressions90d = n;
        }
      }
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(json);
  return found;
}

async function creatorOperationNames() {
  const { queryIds, captured } = await chrome.storage.local.get(["queryIds", "captured"]);
  const names = new Set([
    "CreatorStudioTabBarItemQuery",
    ...Object.keys(queryIds || {}),
    ...Object.keys(captured?.queryIds || {}),
  ]);
  return [...names].filter((name) =>
    /CreatorStudioTabBarItemQuery|Eligib|Monetiz|Reward|OriginalContent|CreatorStudio|Jetfuel/i.test(name)
  );
}

async function fetchRewardsFromApi() {
  const auth = await getAuth();
  if (!auth.csrf || !auth.authToken) return null;
  const ops = await creatorOperationNames();
  let best = null;
  for (const op of ops) {
    try {
      const json = await graphqlRequest(op, {});
      const parsed = parseCreatorPayload(json);
      if (parsed.impressions90d != null) return parsed;
      if (!best && (parsed.premium != null || parsed.verifiedFollowers != null)) best = parsed;
    } catch {
      /* try next operation */
    }
  }
  return best;
}

export async function loadHistory() {
  const { rewardHistory } = await chrome.storage.local.get("rewardHistory");
  return Array.isArray(rewardHistory) ? rewardHistory : [];
}

export async function saveSnapshot(entry) {
  const history = await loadHistory();
  const date = entry.date || todayKey();
  const next = {
    date,
    capturedAt: Date.now(),
    impressions90d: entry.impressions90d ?? null,
    verifiedFollowers: entry.verifiedFollowers ?? null,
    premium: entry.premium ?? null,
    ageOk: entry.ageOk ?? null,
    source: entry.source || "scrape",
  };
  const idx = history.findIndex((row) => row.date === date);
  if (idx >= 0) history[idx] = { ...history[idx], ...next };
  else history.push(next);
  history.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = history.slice(-120);
  await chrome.storage.local.set({ rewardHistory: trimmed, rewardLatest: next });
  return next;
}

export function withDeltas(history) {
  return history.map((row, i) => {
    const prev = history[i - 1];
    const delta =
      row.impressions90d != null && prev?.impressions90d != null
        ? row.impressions90d - prev.impressions90d
        : null;
    return { ...row, delta };
  });
}

function isRewardsPage(url = "") {
  return /\/i\/jf\/creators\/original_content_rewards/i.test(url);
}

function studioTab(tab) {
  const url = tab.url || "";
  return /x\.com|twitter\.com/.test(url);
}

async function scrapeTab(tab) {
  if (!tab?.id) return null;
  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_REWARDS" });
    return data ? { ...data, tabUrl: tab.url } : null;
  } catch {
    return null;
  }
}

export async function scrapeOpenXTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const preferred = [
    ...tabs.filter((tab) => isRewardsPage(tab.url)),
    ...tabs.filter((tab) => /\/i\/jf\/creators/i.test(tab.url || "")),
    ...tabs,
  ];
  let fallback = null;
  for (const tab of preferred) {
    if (!studioTab(tab)) continue;
    const data = await scrapeTab(tab);
    if (data?.impressions90d != null) return data;
    if (!fallback && data && (data.premium != null || data.ageOk != null)) fallback = data;
  }
  return fallback;
}

async function loadRewardsPageAndScrape() {
  const existing = (await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] })).find((tab) =>
    isRewardsPage(tab.url)
  );
  if (existing?.id) {
    await new Promise((r) => setTimeout(r, 800));
    const data = await scrapeTab(existing);
    if (data?.impressions90d != null) return data;
  }

  const tab = await openInBrowser(REWARDS_PAGE, { active: false, reuseXTab: false });
  if (tab.id) await waitLoaded(tab.id);
  await new Promise((r) => setTimeout(r, 5000));
  return scrapeTab(tab);
}

function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 8000);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export const REWARD_ALARM = "xtool-daily-rewards";
export const REWARD_HOUR = 9;

export function nextRewardTime(hour = REWARD_HOUR) {
  const now = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime() + 15_000) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export async function syncRewardAlarm(enabled, hour = REWARD_HOUR) {
  await chrome.alarms.clear(REWARD_ALARM);
  if (!enabled) return null;
  const when = nextRewardTime(hour);
  await chrome.alarms.create(REWARD_ALARM, { when });
  return when;
}

export async function hasTodaySnapshot() {
  const history = await loadHistory();
  const day = todayKey();
  return history.some((row) => row.date === day && row.impressions90d != null);
}

export async function pullRewards() {
  const auth = await getAuth();
  if (!auth.csrf || !auth.authToken) {
    return { date: todayKey(), impressions90d: null, source: "none", error: "NOT_AUTHENTICATED" };
  }

  let scraped = await scrapeOpenXTabs();
  if (!scraped?.impressions90d) {
    try {
      scraped = await loadRewardsPageAndScrape();
    } catch {
      /* stay silent */
    }
  }
  const fromApi = await fetchRewardsFromApi();
  const { creatorGql } = await chrome.storage.local.get("creatorGql");
  const fromLive =
    creatorGql?.json && Date.now() - (creatorGql.at || 0) < 30 * 60 * 1000
      ? parseCreatorPayload(creatorGql.json)
      : null;

  const merged = {
    date: todayKey(),
    impressions90d: scraped?.impressions90d ?? fromApi?.impressions90d ?? fromLive?.impressions90d ?? null,
    verifiedFollowers:
      fromApi?.verifiedFollowers ?? scraped?.verifiedFollowers ?? fromLive?.verifiedFollowers ?? null,
    premium: fromApi?.premium ?? scraped?.premium ?? fromLive?.premium ?? null,
    ageOk: fromApi?.ageOk ?? scraped?.ageOk ?? fromLive?.ageOk ?? true,
    source: scraped?.impressions90d != null ? "studio" : fromApi?.impressions90d != null ? "api" : fromLive?.impressions90d != null ? "gql" : "none",
  };

  if (merged.impressions90d != null || merged.premium != null) {
    await saveSnapshot(merged);
  }
  return merged;
}

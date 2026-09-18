const IMPRESSION_GOAL = 500_000;
const VERIFIED_FOLLOWER_GOAL = 500;
const STUDIO_URLS = [
  "https://x.com/i/monetization",
  "https://x.com/i/premium",
  "https://x.com/i/creator-studio",
  "https://x.com/settings/monetization",
];

export { IMPRESSION_GOAL, VERIFIED_FOLLOWER_GOAL, STUDIO_URLS };

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
  return typeof n === "number" && n >= 0 && n < 50_000_000 && n !== 90 && n !== 500 && n !== 18;
}

export function parseCreatorPayload(json) {
  const found = {
    impressions90d: null,
    verifiedFollowers: null,
    premium: null,
    ageOk: null,
  };
  const walk = (node, path = "") => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const p = `${path}.${key}`;
      const k = key.toLowerCase();
      if (typeof value === "number") {
        if (
          /verified.*impression|home[_]?timeline.*impression|qualifiedimpression|eligibilityimpression/i.test(k) &&
          looksLikeImpressionTotal(value) &&
          found.impressions90d == null
        ) {
          found.impressions90d = value;
        }
        if (/verifiedfollower/i.test(k) && value >= 0 && value < 10_000_000) {
          found.verifiedFollowers = value;
        }
      }
      if (typeof value === "boolean") {
        if (/premium|subscribed|is_blue/i.test(k)) found.premium = value;
        if (/age|eighteen|is_18/i.test(k)) found.ageOk = value;
      }
      if (
        typeof value === "string" &&
        /verified.*impression|home[_]?timeline.*impression|qualifiedimpression/i.test(k)
      ) {
        const n = parseCompact(value);
        if (n != null && looksLikeImpressionTotal(n) && found.impressions90d == null) {
          found.impressions90d = n;
        }
      }
      if (value && typeof value === "object") walk(value, p);
    }
  };
  walk(json);
  return found;
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

function studioTab(tab) {
  const url = tab.url || "";
  return /x\.com|twitter\.com/.test(url);
}

export async function scrapeOpenXTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const preferred = [
    ...tabs.filter((tab) => /monetization|premium|creator|analytic|studio|original/i.test(tab.url || "")),
    ...tabs,
  ];
  let fallback = null;
  for (const tab of preferred) {
    if (!studioTab(tab) || !tab.id) continue;
    try {
      const data = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_REWARDS" });
      if (data?.impressions90d != null) return { ...data, tabUrl: tab.url };
      if (!fallback && data && (data.premium != null || data.ageOk != null)) {
        fallback = { ...data, tabUrl: tab.url };
      }
    } catch {
      /* tab has no content script yet */
    }
  }
  return fallback;
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

export async function openStudioAndScrape() {
  const existing = await scrapeOpenXTabs();
  if (existing?.impressions90d != null) return existing;

  const tab = await chrome.tabs.create({ url: STUDIO_URLS[0], active: true });
  if (tab.id) await waitLoaded(tab.id);
  await new Promise((r) => setTimeout(r, 2200));
  if (!tab.id) return existing;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_REWARDS" });
  } catch {
    return existing;
  }
}

export async function pullRewards() {
  const { creatorGql } = await chrome.storage.local.get("creatorGql");
  let fromGql = null;
  if (creatorGql?.json && Date.now() - (creatorGql.at || 0) < 10 * 60 * 1000) {
    fromGql = parseCreatorPayload(creatorGql.json);
  }

  let scraped = await scrapeOpenXTabs();
  if (!scraped?.impressions90d) {
    scraped = await openStudioAndScrape();
  }

  const merged = {
    date: todayKey(),
    impressions90d: scraped?.impressions90d ?? fromGql?.impressions90d ?? null,
    verifiedFollowers: scraped?.verifiedFollowers ?? fromGql?.verifiedFollowers ?? null,
    premium: scraped?.premium ?? fromGql?.premium ?? null,
    ageOk: scraped?.ageOk ?? fromGql?.ageOk ?? null,
    source: scraped?.impressions90d != null ? "studio" : fromGql?.impressions90d != null ? "gql" : "none",
  };

  if (merged.impressions90d != null || merged.premium != null) {
    await saveSnapshot(merged);
  }
  return merged;
}

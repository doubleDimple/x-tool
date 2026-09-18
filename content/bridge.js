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

function parseCompact(text) {
  const m = String(text || "")
    .replace(/,/g, "")
    .trim()
    .match(/^([\d.]+)\s*([KMB万千])?$/i);
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

function rowChecked(text) {
  if (/[✓✔]|已完成|已订阅|已满足/.test(text) && !/未完成|未满足/.test(text)) return true;
  if (/[✕×✗]|未完成|未满足/.test(text)) return false;
  return null;
}

function scrapeCreatorRewards() {
  const body = document.body?.innerText || "";
  const result = {
    impressions90d: null,
    verifiedFollowers: null,
    premium: null,
    ageOk: null,
  };

  const impressionNeedles = [
    "已验证首页时间线曝光",
    "首页时间线曝光",
    "Home Timeline impressions",
    "verified Home Timeline",
  ];
  const nodes = [...document.querySelectorAll("span, div, p, li, h2, h3")];
  const impressionNode = nodes.find((el) => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length < 220 && impressionNeedles.some((n) => t.includes(n));
  });
  const impressionBlock = impressionNode
    ? (impressionNode.closest("li, [role='listitem'], section, div") || impressionNode.parentElement || impressionNode)
    : null;
  const impressionText = impressionBlock?.innerText || body;
  const compactHits = [...impressionText.matchAll(/(\d+(?:\.\d+)?)\s*([KMB万千])/gi)];
  for (const hit of compactHits) {
    const value = parseCompact(hit[0]);
    if (value && value !== 500_000 && value !== 500 && value !== 90 && value < 5_000_000) {
      result.impressions90d = value;
      break;
    }
  }
  if (result.impressions90d == null) {
    const raw = impressionText.match(/(\d{1,3}(?:,\d{3})+|\d{4,7})/);
    if (raw) {
      const value = Number(raw[1].replace(/,/g, ""));
      if (value !== 500_000 && value < 5_000_000) result.impressions90d = value;
    }
  }

  const followerNode = nodes.find((el) => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length < 180 && (t.includes("已验证粉丝") || t.includes("verified followers"));
  });
  const followerText = followerNode?.closest("li, [role='listitem'], div")?.innerText || "";
  const fv = followerText.match(/(\d[\d,]*)/);
  if (fv) result.verifiedFollowers = Number(fv[1].replace(/,/g, ""));

  const premiumText =
    nodes.find((el) => /订阅 Premium|Subscribe to Premium|Premium\+|Premium Business/.test(el.textContent || ""))
      ?.closest("li, [role='listitem'], div")?.innerText || "";
  const ageText =
    nodes.find((el) => /年满\s*18|at least 18|18岁/.test(el.textContent || ""))
      ?.closest("li, [role='listitem'], div")?.innerText || "";
  result.premium = rowChecked(premiumText);
  result.ageOk = rowChecked(ageText);

  if (result.premium == null && /订阅 Premium/.test(body) && /✓|✔/.test(body)) result.premium = true;
  if (result.ageOk == null && /年满\s*18|至少年满18/.test(body) && /✓|✔/.test(body)) result.ageOk = true;

  return result;
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

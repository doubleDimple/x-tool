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

function findRow(el) {
  return el?.closest("li, [role='listitem']") || el?.parentElement || el;
}

function rowHasMeter(root) {
  if (!root) return false;
  return Boolean(root.querySelector("[role='progressbar'], progress, meter"));
}

function rowChecked(root, text) {
  if (rowHasMeter(root)) return false;
  const svg = root?.querySelector?.("svg")?.outerHTML || "";
  if (/9\.64 18\.952|l-5\.55-4\.861|checkmark|Check/i.test(svg)) return true;
  if (/[✓✔]|已完成|已订阅|已满足/.test(text) && !/未完成|未满足/.test(text)) return true;
  if (/[✕×✗]|未完成|未满足/.test(text)) return false;
  return null;
}

function isThresholdNumber(n) {
  return n === 500_000 || n === 50_000 || n === 500 || n === 90 || n === 18 || n === 50 || n === 0;
}

function readShortCompact(el) {
  const t = (el.textContent || "").replace(/\s+/g, "").trim();
  if (!t || t.length > 12) return null;
  if (!/[Kk千MB万]/.test(t) && !/^\d+(\.\d+)?$/.test(t)) return null;
  const n = parseCompact(t);
  if (n == null || isThresholdNumber(n) || n >= 500_000) return null;
  return { n, hasSuffix: /[Kk千MB万]/.test(t), t };
}

function findImpressions90d() {
  const needles = ["已验证首页时间线曝光", "首页时间线曝光", "Home Timeline impressions", "verified Home Timeline"];
  const nodes = [...document.querySelectorAll("span, div, p, li, h2, h3, strong")];
  const label = nodes.find((el) => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length < 220 && needles.some((n) => t.includes(n));
  });
  if (!label) return null;

  let scope = label;
  for (let depth = 0; depth < 16 && scope; depth += 1, scope = scope.parentElement) {
    const hits = [];
    for (const el of scope.querySelectorAll("span, div, p, strong, b, em")) {
      if (el.contains(label) && el !== label) continue;
      const hit = readShortCompact(el);
      if (hit && hit.n >= 1000) hits.push(hit);
    }
    const withK = hits.filter((h) => h.hasSuffix && /[KkK]/.test(h.t));
    if (withK.length) return withK[withK.length - 1].n;
    const textHits = [...(scope.innerText || "").matchAll(/(\d+(?:\.\d+)?)\s*[KkK]/g)]
      .map((m) => parseCompact(m[0]))
      .filter((n) => n && !isThresholdNumber(n) && n < 500_000);
    if (textHits.length) return textHits[textHits.length - 1];
    if (hits.length && depth >= 3) return hits[hits.length - 1].n;
  }
  return null;
}

function scrapeCreatorRewards() {
  const result = {
    impressions90d: findImpressions90d(),
    verifiedFollowers: null,
    premium: null,
    ageOk: null,
  };

  const nodes = [...document.querySelectorAll("span, div, p, li, h2, h3")];

  const followerNode = nodes.find((el) => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length < 180 && (t.includes("已验证粉丝") || t.includes("verified followers"));
  });
  const followerText = followerNode?.closest("li, [role='listitem'], div")?.innerText || "";
  const fv = followerText.match(/(\d[\d,]*)/);
  if (fv) result.verifiedFollowers = Number(fv[1].replace(/,/g, ""));

  const premiumEl = nodes.find((el) =>
    /订阅 Premium|Subscribe to Premium|Premium\+|Premium Business/.test(el.textContent || "")
  );
  const ageEl = nodes.find((el) => /年满\s*18|至少年满18|at least 18/.test(el.textContent || ""));
  const premiumRow = findRow(premiumEl);
  const ageRow = findRow(ageEl);
  const followerRow = findRow(followerNode);
  result.premium = rowChecked(premiumRow, premiumRow?.innerText || "");
  result.ageOk = rowChecked(ageRow, ageRow?.innerText || "");
  const followersChecked = rowChecked(followerRow, followerRow?.innerText || "");

  if (result.impressions90d != null) {
    if (result.premium == null && premiumEl && !rowHasMeter(premiumRow)) result.premium = true;
    if (result.ageOk == null && ageEl && !rowHasMeter(ageRow)) result.ageOk = true;
    if (followersChecked === true || (followersChecked == null && followerNode && !rowHasMeter(followerRow))) {
      if (result.verifiedFollowers == null || result.verifiedFollowers < 500) result.verifiedFollowers = 500;
    }
  }

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

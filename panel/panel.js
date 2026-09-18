import { detectLang, t } from "../lib/i18n.js";
import { getAuth, verifyCredentials } from "../lib/api.js";
import { runScan } from "../lib/scan.js";

const $ = (id) => document.getElementById(id);

const state = {
  lang: "zh",
  tab: "notBack",
  result: null,
  scanning: false,
  abort: null,
};

function applyI18n() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(state.lang, el.dataset.i18n);
  });
  $("langBtn").textContent = t(state.lang, "langToggle");
  $("search").placeholder = t(state.lang, "search");
}

function setStatus(text, kind = "") {
  $("status").textContent = text || "";
  $("status").className = `status ${kind}`.trim();
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(state.lang === "zh" ? "zh-CN" : "en");
}

function setAccount(me, loggedIn) {
  const img = $("avatar");
  if (me?.avatar) {
    img.src = me.avatar;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  $("displayName").textContent = me?.name || (loggedIn ? t(state.lang, "loggedIn") : "—");
  $("handle").textContent = me?.screenName
    ? `@${me.screenName}`
    : loggedIn
      ? t(state.lang, "loggedIn")
      : t(state.lang, "needLogin");
}

function withDerived(result) {
  if (!result) return null;
  return {
    ...result,
    following: result.following || [...(result.mutual || []), ...(result.notBack || [])],
    followers: result.followers || [...(result.mutual || []), ...(result.fansOnly || [])],
  };
}

function currentRows() {
  const result = state.result;
  if (!result) return [];
  return result[state.tab] || [];
}

function renderStats() {
  const counts = state.result?.counts;
  $("stats").hidden = !counts;
  $("toolbar").hidden = !counts;
  if (!counts) return;
  $("cFollowing").textContent = counts.following;
  $("cFollowers").textContent = counts.followers;
  $("cMutual").textContent = counts.mutual;
  $("cNotBack").textContent = counts.notBack;
  $("cFansOnly").textContent = counts.fansOnly;
  document.querySelectorAll(".stat").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.tab === state.tab);
  });
}

function renderList() {
  const box = $("list");
  if (!state.result) {
    box.innerHTML = `<p class="empty">${t(state.lang, "empty")}</p>`;
    return;
  }
  const q = $("search").value.trim().toLowerCase();
  const rows = currentRows().filter((u) => {
    if (!q) return true;
    return `${u.name} ${u.screenName} ${u.bio}`.toLowerCase().includes(q);
  });
  if (!rows.length) {
    box.innerHTML = `<p class="empty">${t(state.lang, "emptyTab")}</p>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const user of rows) {
    const a = document.createElement("a");
    a.className = "card";
    a.href = `https://x.com/${user.screenName}`;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.innerHTML = `
      ${user.avatar ? `<img src="${user.avatar}" alt="">` : `<div class="ph"></div>`}
      <div>
        <div class="name">${escapeHtml(user.name || "")}</div>
        <div class="mono">@${escapeHtml(user.screenName || "")}</div>
        ${user.bio ? `<p class="bio">${escapeHtml(user.bio)}</p>` : ""}
      </div>
      ${user.verified ? `<span class="badge">${t(state.lang, "verified")}</span>` : ""}
    `;
    frag.appendChild(a);
  }
  box.replaceChildren(frag);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderResult() {
  renderStats();
  renderList();
  $("stamp").textContent = state.result?.scannedAt
    ? `${t(state.lang, "lastScan")} ${formatTime(state.result.scannedAt)}`
    : "";
}

function setProgress(loaded, expected) {
  $("progressWrap").hidden = false;
  const pct = expected ? Math.max(4, Math.min(100, Math.round((loaded / expected) * 100))) : 8;
  $("bar").style.width = `${pct}%`;
}

function download(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(result) {
  const lines = [["type", "id", "screen_name", "name", "bio", "followers", "following", "verified"]];
  const push = (type, users) => {
    for (const u of users) {
      lines.push([
        type,
        u.id,
        u.screenName,
        csvCell(u.name),
        csvCell(u.bio),
        u.followers,
        u.following,
        u.verified ? "1" : "0",
      ]);
    }
  };
  push("not_following_back", result.notBack);
  push("mutual", result.mutual);
  push("fans_only", result.fansOnly);
  return lines.map((row) => row.join(",")).join("\n");
}

function csvCell(value) {
  const text = String(value ?? "").replaceAll('"', '""');
  return `"${text}"`;
}

async function hydrate() {
  const stored = await chrome.storage.local.get(["lang", "lastResult"]);
  state.lang = stored.lang || detectLang();
  state.result = withDerived(stored.lastResult || null);
  applyI18n();
  renderResult();

  try {
    const auth = await getAuth();
    if (!auth.csrf || !auth.authToken) {
      setAccount(state.result?.me, false);
      setStatus(t(state.lang, "needLogin"), "warn");
      return;
    }
    if (state.result?.me) {
      setAccount(state.result.me, true);
    } else {
      const me = await verifyCredentials(auth.csrf);
      setAccount(me, true);
    }
    if (!state.result) setStatus(t(state.lang, "hint"));
  } catch {
    setAccount(state.result?.me, false);
    setStatus(t(state.lang, "needLogin"), "warn");
  }
}

async function startScan() {
  if (state.scanning) return;
  state.scanning = true;
  state.abort = new AbortController();
  $("startBtn").hidden = true;
  $("stopBtn").hidden = false;
  $("progressWrap").hidden = false;
  $("bar").style.width = "6%";
  setStatus(t(state.lang, "phaseAuth"));

  try {
    const scanned = await runScan({
      signal: state.abort.signal,
      onProgress: (p) => {
        if (p.me) setAccount(p.me, true);
        if (p.phase === "auth") setStatus(t(state.lang, "phaseAuth"));
        if (p.phase === "following") {
          setStatus(`${t(state.lang, "phaseFollowing")} ${p.loaded || 0}${p.expected ? ` / ${p.expected}` : ""}`);
          setProgress(p.loaded || 0, p.expected);
        }
        if (p.phase === "followers") {
          setStatus(`${t(state.lang, "phaseFollowers")} ${p.loaded || 0}${p.expected ? ` / ${p.expected}` : ""}`);
          setProgress(p.loaded || 0, p.expected);
        }
        if (p.phase === "diff") setStatus(t(state.lang, "phaseDiff"));
        if (p.rateLimited) setStatus(t(state.lang, "rateLimited"), "warn");
      },
    });
    const persist = {
      me: scanned.me,
      scannedAt: scanned.scannedAt,
      notBack: scanned.notBack,
      mutual: scanned.mutual,
      fansOnly: scanned.fansOnly,
      modes: scanned.modes,
      counts: scanned.counts,
    };
    state.result = withDerived(scanned);
    state.tab = "notBack";
    await chrome.storage.local.set({ lastResult: persist });
    renderResult();
    $("bar").style.width = "100%";
    setStatus(`${t(state.lang, "done")} · ${t(state.lang, "notBack")} ${scanned.counts.notBack}`);
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus(t(state.lang, "stopped"), "warn");
    } else if (error?.code === "NOT_AUTHENTICATED") {
      setStatus(t(state.lang, "needLogin"), "warn");
    } else {
      setStatus(`${t(state.lang, "error")}: ${error.message || error}`, "err");
    }
  } finally {
    state.scanning = false;
    state.abort = null;
    $("startBtn").hidden = false;
    $("stopBtn").hidden = true;
    setTimeout(() => {
      if (!state.scanning) $("progressWrap").hidden = true;
    }, 700);
  }
}

$("langBtn").addEventListener("click", async () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  await chrome.storage.local.set({ lang: state.lang });
  applyI18n();
  renderResult();
});

$("openX").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://x.com/home" });
});

$("startBtn").addEventListener("click", startScan);
$("stopBtn").addEventListener("click", () => state.abort?.abort());

document.querySelectorAll(".stat").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    renderStats();
    renderList();
  });
});

$("search").addEventListener("input", renderList);

$("csvBtn").addEventListener("click", () => {
  if (!state.result) return;
  download(`x-tool-${state.result.me?.screenName || "scan"}.csv`, "text/csv;charset=utf-8", toCsv(state.result));
});

$("jsonBtn").addEventListener("click", () => {
  if (!state.result) return;
  download(
    `x-tool-${state.result.me?.screenName || "scan"}.json`,
    "application/json",
    JSON.stringify(state.result, null, 2)
  );
});

$("clearBtn").addEventListener("click", async () => {
  state.result = null;
  await chrome.storage.local.remove("lastResult");
  renderResult();
  setStatus(t(state.lang, "empty"));
});

hydrate();

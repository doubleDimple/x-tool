import { detectLang, t, tf } from "../lib/i18n.js";
import { getAuth, resolveMe, unfollowUser } from "../lib/api.js";
import { runScan } from "../lib/scan.js";
import { applyFollowed, applyUnfollowed, packUsers, persistable, withDerived } from "../lib/graph.js";
import {
  IMPRESSION_GOAL,
  REWARDS_PAGE,
  formatCompact,
  loadHistory,
  pullRewards,
  withDeltas,
} from "../lib/rewards.js";
import { openInBrowser } from "../lib/tabs.js";

const $ = (id) => document.getElementById(id);
const UNFOLLOW_TABS = new Set(["notBack", "mutual", "following"]);
const FOLLOW_TABS = new Set(["fansOnly", "followers"]);

const state = {
  lang: "zh",
  tab: "notBack",
  result: null,
  scanning: false,
  unfollowing: false,
  followingAct: false,
  jobRunning: false,
  abort: null,
  selected: new Set(),
  todayCount: 0,
  view: "relation",
  rewardHistory: [],
  theme: "system",
};

const THEMES = ["system", "light", "dark"];

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const key = state.theme === "light" ? "themeLight" : state.theme === "dark" ? "themeDark" : "themeSystem";
  $("themeBtn").textContent = t(state.lang, key);
}

function applyI18n() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(state.lang, el.dataset.i18n);
  });
  $("langBtn").textContent = t(state.lang, "langToggle");
  $("search").placeholder = t(state.lang, "search");
  applyTheme();
  $("autoHint").textContent = t(state.lang, $("autoRewards").checked ? "autoOn" : "autoOff");
  if (state.view === "creator") renderCreator();
}

function setStatus(text, kind = "") {
  $("status").textContent = text || "";
  $("status").className = `status ${kind}`.trim();
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(state.lang === "zh" ? "zh-CN" : "en");
}

function canUnfollowTab() {
  return UNFOLLOW_TABS.has(state.tab);
}

function canFollowTab() {
  return FOLLOW_TABS.has(state.tab);
}

function followingIds() {
  return new Set((state.result?.following || []).map((u) => u.id));
}

function canFollowUser(user) {
  return Boolean(user?.id) && !followingIds().has(user.id);
}

function busy() {
  return state.scanning || state.unfollowing || state.followingAct || state.jobRunning;
}

function setAccount(me, loggedIn) {
  const img = $("avatar");
  img.referrerPolicy = "no-referrer";
  img.onerror = () => {
    img.hidden = true;
    img.removeAttribute("src");
  };
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



async function saveResult(result) {
  state.result = withDerived(result);
  await chrome.storage.local.set({ lastResult: persistable(state.result) });
}

function currentRows() {
  const result = state.result;
  if (!result) return [];
  return result[state.tab] || [];
}

function visibleRows() {
  const q = $("search").value.trim().toLowerCase();
  return currentRows().filter((u) => {
    if (!q) return true;
    return `${u.name} ${u.screenName} ${u.bio}`.toLowerCase().includes(q);
  });
}

function renderStats() {
  const counts = state.result?.counts;
  $("stats").hidden = !counts;
  $("toolbar").hidden = !counts;
  const note = $("countNote");
  if (!counts) {
    note.hidden = true;
    return;
  }
  const followingOfficial = Number(counts.followingOfficial || 0);
  const followersOfficial = Number(counts.followersOfficial || 0);
  const followingListed = Number(counts.following || 0);
  const followersListed = Number(counts.followers || 0);
  $("cFollowing").textContent = followingOfficial || followingListed;
  $("cFollowers").textContent = followersOfficial || followersListed;
  $("cMutual").textContent = counts.mutual;
  $("cNotBack").textContent = counts.notBack;
  $("cFansOnly").textContent = counts.fansOnly;
  document.querySelectorAll(".stat").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.tab === state.tab);
  });
  const followGap = followingOfficial && Math.abs(followingOfficial - followingListed) >= 1;
  const fanGap = followersOfficial && Math.abs(followersOfficial - followersListed) >= 1;
  if (followGap || fanGap) {
    note.hidden = false;
    note.textContent = tf(state.lang, "countGap", {
      followingOfficial,
      followingListed,
      followersOfficial,
      followersListed,
    });
  } else {
    note.hidden = true;
    note.textContent = "";
  }
}

function renderBatch() {
  const show = Boolean(state.result) && (canUnfollowTab() || canFollowTab());
  $("batchBar").hidden = !show;
  $("unfollowBtn").hidden = !canUnfollowTab();
  $("followBtn").hidden = !canFollowTab();
  $("paceHint").hidden = !canFollowTab() && !canUnfollowTab();
  $("paceHint").textContent = t(state.lang, "followPace");
  if (!show) {
    $("selectAll").checked = false;
    return;
  }
  const visible = visibleRows();
  const selectedVisible = visible.filter((u) => state.selected.has(u.id)).length;
  $("selectedCount").textContent = `${t(state.lang, "selected")} ${state.selected.size}`;
  $("selectAll").checked = visible.length > 0 && selectedVisible === visible.length;
  $("selectAll").indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $("unfollowBtn").disabled = busy() || state.selected.size === 0;
  $("followBtn").disabled = busy() || state.selected.size === 0;
}

function renderList() {
  const box = $("list");
  if (!state.result) {
    box.innerHTML = `<p class="empty">${t(state.lang, "empty")}</p>`;
    renderBatch();
    return;
  }
  const rows = visibleRows();
  if (!rows.length) {
    box.innerHTML = `<p class="empty">${t(state.lang, "emptyTab")}</p>`;
    renderBatch();
    return;
  }
  const allowPick = canUnfollowTab() || canFollowTab();
  const frag = document.createDocumentFragment();
  for (const user of rows) {
    const handle = user.screenName || user.id;
    const card = document.createElement("article");
    card.className = allowPick ? "card" : "card plain";
    card.dataset.id = user.id;
    const follow = canFollowUser(user);
    const unfollow = !follow && canUnfollowTab();
    card.innerHTML = `
      ${
        allowPick
          ? `<input class="pick" type="checkbox" data-pick="${escapeHtml(user.id)}" ${
              state.selected.has(user.id) ? "checked" : ""
            }>`
          : ""
      }
      ${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
      <a class="profile" href="${escapeHtml(profileHref(user))}" rel="noreferrer">
        <div class="name">
          <span>${escapeHtml(user.name || handle)}</span>
          ${user.verified ? `<span class="badge">${t(state.lang, "verified")}</span>` : ""}
        </div>
        <div class="mono">@${escapeHtml(handle)}</div>
        ${user.bio ? `<p class="bio">${escapeHtml(user.bio)}</p>` : ""}
      </a>
      <div class="actions">
        ${
          unfollow
            ? `<button class="ghost small danger" type="button" data-unfollow="${escapeHtml(user.id)}">${t(
                state.lang,
                "unfollowOne"
              )}</button>`
            : ""
        }
        ${
          follow
            ? `<button class="ghost small follow" type="button" data-follow="${escapeHtml(user.id)}">${t(
                state.lang,
                "followOne"
              )}</button>`
            : ""
        }
      </div>
    `;
    frag.appendChild(card);
  }
  box.replaceChildren(frag);
  renderBatch();
}

function profileHref(user) {
  return user.screenName ? `https://x.com/${user.screenName}` : `https://x.com/i/user/${user.id}`;
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
  const bits = [];
  if (state.result?.scannedAt) bits.push(`${t(state.lang, "lastScan")} ${formatTime(state.result.scannedAt)}`);
  if (state.todayCount) bits.push(`${t(state.lang, "todayUnfollowed")} ${state.todayCount}`);
  $("stamp").textContent = bits.join(" · ");
}

function setProgress(loaded, expected) {
  $("progressWrap").hidden = false;
  const pct = expected ? Math.max(4, Math.min(100, Math.round((loaded / expected) * 100))) : 8;
  $("bar").style.width = `${pct}%`;
}

let actionState = { total: 0, doneCount: 0, failCount: 0, index: 0, user: null };

function mergeAction(p = {}) {
  for (const [key, value] of Object.entries(p)) {
    if (value !== undefined) actionState[key] = value;
  }
  return actionState;
}

function resetActionState(seed = {}) {
  actionState = { total: 0, doneCount: 0, failCount: 0, index: 0, user: null, ...seed };
}

function updateActionProgress(p, line) {
  const s = mergeAction(p);
  const total = Number(s.total) || 0;
  const done = Number(s.doneCount) || 0;
  const fail = Number(s.failCount) || 0;
  const left = Math.max(0, total - done - fail);
  $("actionProgress").hidden = false;
  $("apTotal").textContent = total;
  $("apDone").textContent = done;
  $("apLeft").textContent = left;
  $("apFail").textContent = fail;
  const pct = total ? Math.round(((done + fail) / total) * 100) : 0;
  $("apBar").style.width = `${Math.max(done + fail ? 4 : 0, pct)}%`;
  $("apNow").textContent = line || "";
}

function actionLine(p, kind) {
  const s = mergeAction(p);
  const label = s.user?.screenName || s.user?.id || "";
  const total = Number(s.total) || 0;
  const step = total ? `${(Number(s.index) || 0) + 1}/${total}` : "";
  const at = label ? ` @${label}` : "";
  const bit = [step, at.trim()].filter(Boolean).join(" ");
  if (kind === "follow") {
    if (s.waiting === "look") return `${t(state.lang, "followLook")} ${bit}`.trim();
    if (s.waiting === "between") return `${t(state.lang, "followBetween")} ${step}`.trim();
    if (s.waiting === "rest") return t(state.lang, "followRest");
    if (s.rateLimited) return t(state.lang, "rateLimited");
    return `${t(state.lang, "followingAction")} ${bit}`.trim();
  }
  if (s.waiting === "look") return `${t(state.lang, "unfollowLook")} ${bit}`.trim();
  if (s.waiting === "between") return `${t(state.lang, "unfollowBetween")} ${step}`.trim();
  if (s.waiting === "rest") return t(state.lang, "unfollowRest");
  if (s.rateLimited) return t(state.lang, "rateLimited");
  return `${t(state.lang, "unfollowing")} ${bit}`.trim();
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

function openModal({ title, text, okLabel, cancelLabel, danger }) {
  return new Promise((resolve) => {
    const modal = $("modal");
    const okBtn = $("modalOk");
    const cancelBtn = $("modalCancel");
    $("modalTitle").textContent = title;
    $("modalText").textContent = text;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle("danger-fill", Boolean(danger));
    okBtn.classList.toggle("acid-fill", !danger);
    cancelBtn.hidden = !cancelLabel;
    if (cancelLabel) cancelBtn.textContent = cancelLabel;
    modal.hidden = false;
    const finish = (ok) => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (event) => {
      if (event.target === modal) finish(!cancelLabel);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
  });
}

function showError(message) {
  const text = String(message || "").trim() || t(state.lang, "error");
  setStatus(`${t(state.lang, "error")}: ${text}`, "err");
  return openModal({
    title: t(state.lang, "error"),
    text,
    okLabel: t(state.lang, "alertOk"),
  });
}

function confirmAction(users, kind) {
  const follow = kind === "follow";
  let text;
  if (users.length === 1) {
    text = tf(state.lang, follow ? "confirmFollowOne" : "confirmOne", {
      handle: users[0].screenName || users[0].id,
    });
  } else {
    const minutes = Math.max(1, Math.ceil((users.length * 5 + Math.floor(users.length / 15) * 14) / 60));
    text = tf(state.lang, follow ? "confirmFollowMany" : "confirmMany", { count: users.length, minutes });
    if (users.length > 50) text += `\n${t(state.lang, "confirmBig")}`;
  }
  return openModal({
    title: t(state.lang, follow ? "confirmFollowTitle" : "confirmTitle"),
    text,
    okLabel: t(state.lang, follow ? "confirmFollowOk" : "confirmOk"),
    cancelLabel: t(state.lang, "confirmCancel"),
    danger: !follow,
  });
}

function bindJobUi(running) {
  state.jobRunning = running;
  $("startBtn").hidden = running || state.scanning;
  $("stopBtn").hidden = !state.scanning;
  renderBatch();
}

const appliedJobIds = new Set();

function applyJobUsers(kind, users) {
  if (!state.result || !users?.length) return;
  const fresh = users.filter((user) => user?.id && !appliedJobIds.has(String(user.id)));
  if (!fresh.length) return;
  for (const user of fresh) appliedJobIds.add(String(user.id));
  state.result = kind === "follow" ? applyFollowed(state.result, fresh) : applyUnfollowed(state.result, fresh);
  for (const user of fresh) {
    state.selected.delete(user.id);
    state.selected.delete(String(user.id));
  }
}

function onJobProgress(kind, p) {
  bindJobUi(true);
  const line = actionLine(p, kind);
  setStatus(line, p.waiting === "rest" || p.rateLimited ? "warn" : "");
  updateActionProgress(p, line);
  if (p.done && p.user) {
    applyJobUsers(kind, [p.user]);
    renderResult();
  }
}

async function onJobDone(kind, payload) {
  bindJobUi(false);
  const result = payload?.result || { ok: payload?.ok || [], fail: payload?.fail || [] };
  if (result.ok?.length) applyJobUsers(kind, result.ok);
  if (state.result) await saveResult(state.result);
  await loadTodayCount();
  renderResult();
  const stored = await chrome.storage.local.get("friendshipJob");
  const total =
    Number(payload?.total) ||
    Number(stored.friendshipJob?.total) ||
    result.ok.length + result.fail.length;
  if (payload?.error) {
    const stopped = payload.error.name === "AbortError";
    const line = stopped ? t(state.lang, "stopped") : `${t(state.lang, "error")}: ${payload.error.message || payload.error.name}`;
    setStatus(line, stopped ? "warn" : "err");
    updateActionProgress({ total, doneCount: result.ok.length, failCount: result.fail.length }, line);
    if (!stopped) showError(payload.error.message || payload.error.name);
    return;
  }
  const doneKey = kind === "follow" ? "followDone" : "unfollowDone";
  const failBit = result.fail.length ? ` · ${t(state.lang, "unfollowFail")} ${result.fail.length}` : "";
  const reason = result.fail[0]?.error ? ` · ${result.fail[0].error}` : "";
  setStatus(`${t(state.lang, doneKey)} ${result.ok.length}${failBit}${reason}`, result.fail.length ? "warn" : "");
  updateActionProgress({ total, doneCount: result.ok.length, failCount: result.fail.length }, t(state.lang, doneKey));
  if (!result.ok.length && result.fail[0]?.error) showError(result.fail[0].error);
}

async function loadTodayCount() {
  const day = new Date().toISOString().slice(0, 10);
  const { unfollowDay } = await chrome.storage.local.get("unfollowDay");
  state.todayCount = unfollowDay?.day === day ? unfollowDay.count : 0;
}

async function bumpTodayCount(n) {
  const day = new Date().toISOString().slice(0, 10);
  state.todayCount += n;
  await chrome.storage.local.set({ unfollowDay: { day, count: state.todayCount } });
}

async function startFriendshipJob(kind, users) {
  const packed = packUsers(users);
  if (!packed.length) {
    showError("missing user id");
    return;
  }
  appliedJobIds.clear();
  resetActionState({ total: packed.length, doneCount: 0, failCount: 0, index: 0, user: packed[0] || null });
  bindJobUi(true);
  $("progressWrap").hidden = true;
  updateActionProgress(actionState, t(state.lang, kind === "follow" ? "followingAction" : "unfollowing"));
  setStatus(t(state.lang, "jobBackground"));
  try {
    const res = await chrome.runtime.sendMessage({ type: "START_FRIENDSHIP", kind, users: packed });
    if (!res?.ok) {
      bindJobUi(false);
      showError(res?.error || t(state.lang, "error"));
    }
  } catch (error) {
    bindJobUi(false);
    showError(error.message || error);
  }
}

async function unfollowSingleUser(user) {
  if (!state.result || !user?.id) return;
  if (busy()) {
    setStatus(t(state.lang, "jobBusy"), "warn");
    return;
  }
  if (!canUnfollowTab()) {
    setStatus(t(state.lang, "cannotUnfollow"), "warn");
    return;
  }

  // 立即乐观更新 UI 与存储，不需要弹窗确认和多余延迟
  appliedJobIds.add(String(user.id));
  state.result = applyUnfollowed(state.result, [user]);
  state.selected.delete(user.id);
  state.selected.delete(String(user.id));
  saveResult(state.result).catch(() => {});
  bumpTodayCount(1).catch(() => {});
  renderResult();

  const handle = user.screenName ? `@${user.screenName}` : user.id;
  setStatus(`${t(state.lang, "unfollowing")} ${handle}`);

  // 直接在后台发送请求，不阻塞界面交互
  try {
    const auth = await getAuth();
    if (!auth.csrf || !auth.authToken) {
      showError("Please log in to x.com first");
      return;
    }
    await unfollowUser(user, auth.csrf);
    setStatus(`${t(state.lang, "unfollowDone")} ${handle}`);
  } catch (error) {
    console.error("Single unfollow error:", error);
    const msg = error.message || String(error);
    setStatus(`${t(state.lang, "unfollowFail")} ${handle}: ${msg}`, "err");
    if (error?.code === "RATE_LIMITED" || error?.code === "NOT_AUTHENTICATED") {
      showError(msg);
    }
  }
}

async function unfollowUsers(users) {
  if (!users.length) return;
  if (busy()) {
    setStatus(t(state.lang, "jobBusy"), "warn");
    return;
  }
  if (!canUnfollowTab()) {
    setStatus(t(state.lang, "cannotUnfollow"), "warn");
    return;
  }
  const ok = await confirmAction(users, "unfollow");
  if (!ok) return;
  await startFriendshipJob("unfollow", users);
}

function setView(view) {
  state.view = view;
  $("relationView").hidden = view !== "relation";
  $("creatorView").hidden = view !== "creator";
  $("viewRelation").classList.toggle("on", view === "relation");
  $("viewCreator").classList.toggle("on", view === "creator");
  document.querySelector(".lede").hidden = view !== "relation";
  if (view === "creator") renderCreator();
}

function setGate(name, ok) {
  const el = document.querySelector(`[data-gate="${name}"]`);
  if (!el) return;
  el.classList.toggle("ok", ok === true);
  el.classList.toggle("no", ok === false);
}

function signedDelta(n) {
  if (n == null) return "";
  const abs = formatCompact(Math.abs(n));
  return n >= 0 ? `+${abs}` : `-${abs}`;
}

function renderCreator() {
  const rows = withDeltas(state.rewardHistory);
  const latest = rows[rows.length - 1];
  const impressions = latest?.impressions90d;
  $("impNow").textContent = impressions == null ? "—" : formatCompact(impressions);
  const pct = impressions == null ? 0 : Math.max(1, Math.min(100, (impressions / IMPRESSION_GOAL) * 100));
  $("impBar").style.width = `${impressions == null ? 0 : pct}%`;

  const bits = [];
  if (impressions != null) {
    bits.push(tf(state.lang, "creatorGoal", { remain: formatCompact(Math.max(0, IMPRESSION_GOAL - impressions)) }));
  }
  if (latest?.delta != null) bits.push(tf(state.lang, "creatorDelta", { delta: signedDelta(latest.delta) }));
  const recent = rows.filter((r) => r.delta != null).slice(-7);
  const avg = recent.length ? recent.reduce((s, r) => s + Math.max(0, r.delta), 0) / recent.length : 0;
  if (impressions != null && avg > 0 && impressions < IMPRESSION_GOAL) {
    bits.push(tf(state.lang, "etaDays", { days: Math.ceil((IMPRESSION_GOAL - impressions) / avg) }));
  }
  $("impMeta").textContent = bits.join(" · ");

  const fromStudio = latest?.source === "studio" || latest?.source === "gql";
  setGate("premium", latest?.premium ?? (fromStudio ? true : null));
  setGate("age", latest?.ageOk ?? (fromStudio ? true : null));
  setGate(
    "followers",
    latest?.verifiedFollowers != null ? latest.verifiedFollowers >= 500 : fromStudio ? true : null
  );
  setGate("impressions", impressions == null ? null : impressions >= IMPRESSION_GOAL);

  const chart = $("chart");
  const empty = $("chartEmpty");
  const points = rows.filter((r) => r.impressions90d != null).slice(-30);
  if (!points.length) {
    chart.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const max = Math.max(...points.map((p) => p.impressions90d), 1);
  chart.innerHTML = points
    .map((p) => {
      const h = Math.max(4, Math.round((p.impressions90d / max) * 100));
      const tip = `${p.date} · ${formatCompact(p.impressions90d)}${p.delta != null ? ` (${signedDelta(p.delta)})` : ""}`;
      return `<div class="chart-col" title="${tip}"><div class="chart-fill" style="height:${h}%"></div><span>${p.date.slice(5)}</span></div>`;
    })
    .join("");
}

async function hydrate() {
  const stored = await chrome.storage.local.get(["lang", "lastResult", "theme"]);
  state.lang = stored.lang || detectLang();
  state.theme = THEMES.includes(stored.theme) ? stored.theme : "system";
  applyTheme();
  state.result = withDerived(stored.lastResult || null);
  state.rewardHistory = await loadHistory();
  await loadTodayCount();
  applyI18n();
  renderResult();
  renderCreator();
  const { rewardAuto } = await chrome.storage.local.get("rewardAuto");
  $("autoRewards").checked = Boolean(rewardAuto);
  $("autoHint").textContent = t(state.lang, rewardAuto ? "autoOn" : "autoOff");
  chrome.runtime.sendMessage({ type: "GET_FRIENDSHIP_JOB" }).then((res) => {
    const job = res?.job;
    if (job?.status === "running") onJobProgress(job.kind, job);
  }).catch(() => {});

  try {
    const auth = await getAuth();
    if (!auth.csrf || !auth.authToken) {
      setAccount(state.result?.me, false);
      setStatus(t(state.lang, "needLogin"), "warn");
      return;
    }
    const cached = state.result?.me;
    try {
      const live = await resolveMe(auth);
      const merged = {
        ...cached,
        ...live,
        avatar: live.avatar || cached?.avatar || "",
        screenName: live.screenName || cached?.screenName || "",
        name: live.name && live.name !== "You" ? live.name : cached?.name || live.name,
        followingCount: live.followingCount || cached?.followingCount,
        followersCount: live.followersCount || cached?.followersCount,
      };
      setAccount(merged, true);
      if (state.result) {
        state.result.me = merged;
        await saveResult(state.result);
        renderStats();
      }
    } catch {
      setAccount(cached, Boolean(cached?.screenName));
    }
    if (!state.result) setStatus(t(state.lang, "hint"));
  } catch {
    setAccount(state.result?.me, false);
    setStatus(t(state.lang, "needLogin"), "warn");
  }
}

async function startScan() {
  if (busy()) return;
  state.scanning = true;
  state.abort = new AbortController();
  state.selected.clear();
  $("startBtn").hidden = true;
  $("stopBtn").hidden = false;
  $("progressWrap").hidden = false;
  $("actionProgress").hidden = true;
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
        if (p.phase === "lists") {
          const followingBit = `${p.followingLoaded || 0}${p.followingExpected ? `/${p.followingExpected}` : ""}`;
          const followersBit = `${p.followersLoaded || 0}${p.followersExpected ? `/${p.followersExpected}` : ""}`;
          setStatus(`${t(state.lang, "phaseLists")} · ${t(state.lang, "following")} ${followingBit} · ${t(state.lang, "followers")} ${followersBit}`);
          setProgress(p.loaded || 0, p.expected);
        }
        if (p.phase === "diff") setStatus(t(state.lang, "phaseDiff"));
        if (p.rateLimited) setStatus(t(state.lang, "rateLimited"), "warn");
      },
    });
    await saveResult(scanned);
    state.tab = "notBack";
    renderResult();
    $("bar").style.width = "100%";
    const followingOfficial = scanned.counts.followingOfficial || 0;
    const followersOfficial = scanned.counts.followersOfficial || 0;
    const followingListed = scanned.counts.following || 0;
    const followersListed = scanned.counts.followers || 0;
    if (
      (followingOfficial && Math.abs(followingOfficial - followingListed) >= 1) ||
      (followersOfficial && Math.abs(followersOfficial - followersListed) >= 1)
    ) {
      setStatus(
        `${t(state.lang, "done")} · ${t(state.lang, "notBack")} ${scanned.counts.notBack} · ${tf(state.lang, "countGap", {
          followingOfficial,
          followingListed,
          followersOfficial,
          followersListed,
        })}`
      );
    } else {
      setStatus(`${t(state.lang, "done")} · ${t(state.lang, "notBack")} ${scanned.counts.notBack}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus(t(state.lang, "stopped"), "warn");
    } else if (error?.code === "NOT_AUTHENTICATED") {
      setStatus(t(state.lang, "needLogin"), "warn");
    } else {
      showError(error.message || error);
    }
  } finally {
    state.scanning = false;
    state.abort = null;
    $("startBtn").hidden = false;
    $("stopBtn").hidden = true;
    setTimeout(() => {
      if (!busy()) $("progressWrap").hidden = true;
    }, 700);
  }
}

$("themeBtn").addEventListener("click", async () => {
  const i = THEMES.indexOf(state.theme);
  state.theme = THEMES[(i + 1) % THEMES.length];
  await chrome.storage.local.set({ theme: state.theme });
  applyTheme();
});

$("langBtn").addEventListener("click", async () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  await chrome.storage.local.set({ lang: state.lang });
  applyI18n();
  renderResult();
});

$("closePanelBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLOSE_PANEL" }).catch(() => window.close());
});

$("openX").addEventListener("click", () => {
  openInBrowser("https://x.com/home");
});

$("viewRelation").addEventListener("click", () => setView("relation"));
$("viewCreator").addEventListener("click", () => setView("creator"));
$("openStudioBtn").addEventListener("click", () => {
  openInBrowser(REWARDS_PAGE, { reuseXTab: false });
});
$("autoRewards").addEventListener("change", async () => {
  const enabled = $("autoRewards").checked;
  await chrome.runtime.sendMessage({ type: "SET_REWARD_AUTO", enabled });
  $("autoHint").textContent = t(state.lang, enabled ? "autoOn" : "autoOff");
});
$("pullRewardsBtn").addEventListener("click", async () => {
  $("creatorStatus").textContent = t(state.lang, "phaseAuth");
  $("creatorStatus").className = "status";
  try {
    const data = await pullRewards();
    state.rewardHistory = await loadHistory();
    renderCreator();
    if (data?.impressions90d != null) {
      $("creatorStatus").textContent = tf(state.lang, "creatorSaved", {
        value: formatCompact(data.impressions90d),
      });
      $("creatorStatus").className = "status";
    } else {
      $("creatorStatus").textContent = "";
      $("creatorStatus").className = "status";
    }
  } catch {
    $("creatorStatus").textContent = "";
    $("creatorStatus").className = "status";
  }
});

function stopJob() {
  state.abort?.abort();
  chrome.runtime.sendMessage({ type: "STOP_FRIENDSHIP" }).catch(() => {});
  bindJobUi(false);
  setStatus(t(state.lang, "stopped"), "warn");
}

function resetJob() {
  stopJob();
  resetActionState();
  $("actionProgress").hidden = true;
  $("progressWrap").hidden = true;
  $("apTotal").textContent = "0";
  $("apDone").textContent = "0";
  $("apLeft").textContent = "0";
  $("apFail").textContent = "0";
  $("apBar").style.width = "0";
  $("apNow").textContent = "";
  setStatus("");
}

$("startBtn").addEventListener("click", startScan);
$("stopBtn").addEventListener("click", stopJob);
$("jobStopBtn").addEventListener("click", stopJob);
$("jobResetBtn").addEventListener("click", resetJob);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "FRIENDSHIP_PROGRESS") onJobProgress(message.kind, message.progress || {});
  if (message?.type === "FRIENDSHIP_DONE") onJobDone(message.kind, message);
});

document.querySelectorAll(".stat").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    state.selected.clear();
    renderResult();
  });
});

$("search").addEventListener("input", () => {
  renderList();
});

$("selectAll").addEventListener("change", () => {
  const visible = visibleRows();
  if ($("selectAll").checked) {
    for (const user of visible) state.selected.add(user.id);
  } else {
    for (const user of visible) state.selected.delete(user.id);
  }
  renderList();
});

async function followUsers(users) {
  if (!users.length) return;
  if (busy()) {
    setStatus(t(state.lang, "jobBusy"), "warn");
    return;
  }
  const targets = users.filter(canFollowUser);
  if (!targets.length) {
    setStatus(t(state.lang, "cannotFollow"), "warn");
    return;
  }
  const ok = await confirmAction(targets, "follow");
  if (!ok) return;
  await startFriendshipJob("follow", targets);
}

$("unfollowBtn").addEventListener("click", () => {
  const users = currentRows().filter((u) => state.selected.has(u.id));
  if (!users.length) {
    setStatus(t(state.lang, "noSelection"), "warn");
    return;
  }
  unfollowUsers(users);
});
$("followBtn").addEventListener("click", () => {
  const users = currentRows().filter((u) => state.selected.has(u.id) && canFollowUser(u));
  if (!users.length) {
    setStatus(t(state.lang, "noSelection"), "warn");
    return;
  }
  followUsers(users);
});

$("list").addEventListener("change", (event) => {
  const pick = event.target.closest("[data-pick]");
  if (!pick) return;
  const id = pick.dataset.pick;
  if (pick.checked) state.selected.add(id);
  else state.selected.delete(id);
  renderBatch();
});

function onListClick(event) {
  const unfollowBtn = event.target.closest("[data-unfollow]");
  if (unfollowBtn) {
    const id = String(unfollowBtn.dataset.unfollow || "");
    const user = currentRows().find((item) => String(item.id) === id);
    if (user) unfollowSingleUser(user);
    return;
  }
  const followBtn = event.target.closest("[data-follow]");
  if (followBtn) {
    const id = String(followBtn.dataset.follow || "");
    const user = currentRows().find((item) => String(item.id) === id);
    if (user) followUsers([user]);
    return;
  }
  const profile = event.target.closest("a.profile");
  if (profile?.href) {
    event.preventDefault();
    openInBrowser(profile.href);
  }
}

$("list").addEventListener("click", onListClick);
$("list").addEventListener("auxclick", (event) => {
  const profile = event.target.closest("a.profile");
  if (!profile?.href) return;
  event.preventDefault();
  openInBrowser(profile.href);
});

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
  state.selected.clear();
  await chrome.storage.local.remove("lastResult");
  renderResult();
  setStatus(t(state.lang, "empty"));
});

hydrate();

import { detectLang, t, tf } from "../lib/i18n.js";
import { getAuth, resolveMe } from "../lib/api.js";
import { runScan, runUnfollow } from "../lib/scan.js";
import {
  IMPRESSION_GOAL,
  REWARDS_PAGE,
  formatCompact,
  loadHistory,
  pullRewards,
  withDeltas,
} from "../lib/rewards.js";

const $ = (id) => document.getElementById(id);
const UNFOLLOW_TABS = new Set(["notBack", "mutual", "following"]);

const state = {
  lang: "zh",
  tab: "notBack",
  result: null,
  scanning: false,
  unfollowing: false,
  abort: null,
  selected: new Set(),
  todayCount: 0,
  view: "relation",
  rewardHistory: [],
};

function applyI18n() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(state.lang, el.dataset.i18n);
  });
  $("langBtn").textContent = t(state.lang, "langToggle");
  $("search").placeholder = t(state.lang, "search");
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

function busy() {
  return state.scanning || state.unfollowing;
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

function withDerived(result) {
  if (!result) return null;
  const notBack = result.notBack || [];
  const mutual = result.mutual || [];
  const fansOnly = result.fansOnly || [];
  return {
    ...result,
    notBack,
    mutual,
    fansOnly,
    following: result.following || [...mutual, ...notBack],
    followers: result.followers || [...mutual, ...fansOnly],
    counts: {
      following: (result.following || [...mutual, ...notBack]).length,
      followers: (result.followers || [...mutual, ...fansOnly]).length,
      notBack: notBack.length,
      mutual: mutual.length,
      fansOnly: fansOnly.length,
      followingOfficial: result.counts?.followingOfficial || result.me?.followingCount,
      followersOfficial: result.counts?.followersOfficial || result.me?.followersCount,
      unavailableFollowers: result.counts?.unavailableFollowers || 0,
    },
  };
}

function persistable(result) {
  const full = withDerived(result);
  return {
    me: full.me,
    scannedAt: full.scannedAt,
    notBack: full.notBack,
    mutual: full.mutual,
    fansOnly: full.fansOnly,
    modes: full.modes,
    counts: full.counts,
  };
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
  $("cFollowing").textContent = counts.following;
  $("cFollowers").textContent = counts.followers;
  $("cMutual").textContent = counts.mutual;
  $("cNotBack").textContent = counts.notBack;
  $("cFansOnly").textContent = counts.fansOnly;
  document.querySelectorAll(".stat").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.tab === state.tab);
  });
  const official = Number(counts.followersOfficial || 0);
  const listed = Number(counts.followers || 0);
  if (official && Math.abs(official - listed) >= 3) {
    note.hidden = false;
    note.textContent = tf(state.lang, "countGap", { listed, official });
  } else {
    note.hidden = true;
    note.textContent = "";
  }
}

function renderBatch() {
  const show = Boolean(state.result) && canUnfollowTab();
  $("batchBar").hidden = !show;
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
  const allowUnfollow = canUnfollowTab();
  const frag = document.createDocumentFragment();
  for (const user of rows) {
    const handle = user.screenName || user.id;
    const card = document.createElement("article");
    card.className = allowUnfollow ? "card" : "card plain";
    card.dataset.id = user.id;
    card.innerHTML = `
      ${
        allowUnfollow
          ? `<input class="pick" type="checkbox" data-pick="${escapeHtml(user.id)}" ${
              state.selected.has(user.id) ? "checked" : ""
            }>`
          : ""
      }
      ${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
      <a class="profile" href="https://x.com/${encodeURIComponent(user.screenName || user.id)}" target="_blank" rel="noreferrer">
        <div class="name">${escapeHtml(user.name || handle)}</div>
        <div class="mono">@${escapeHtml(handle)}</div>
        ${user.bio ? `<p class="bio">${escapeHtml(user.bio)}</p>` : ""}
      </a>
      <div class="actions">
        ${user.verified ? `<span class="badge">${t(state.lang, "verified")}</span>` : ""}
        ${
          allowUnfollow
            ? `<button class="ghost small danger" type="button" data-unfollow="${escapeHtml(user.id)}">${t(
                state.lang,
                "unfollowOne"
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

function confirmUnfollow(users) {
  return new Promise((resolve) => {
    const modal = $("modal");
    $("modalTitle").textContent = t(state.lang, "confirmTitle");
    if (users.length === 1) {
      $("modalText").textContent = tf(state.lang, "confirmOne", {
        handle: users[0].screenName || users[0].id,
      });
    } else {
      const minutes = Math.max(1, Math.ceil((users.length * 12 + Math.floor(users.length / 9) * 40) / 60));
      let text = tf(state.lang, "confirmMany", { count: users.length, minutes });
      if (users.length > 50) text += `\n${t(state.lang, "confirmBig")}`;
      $("modalText").textContent = text;
    }
    modal.hidden = false;
    const finish = (ok) => {
      modal.hidden = true;
      $("modalOk").removeEventListener("click", onOk);
      $("modalCancel").removeEventListener("click", onCancel);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    $("modalOk").addEventListener("click", onOk);
    $("modalCancel").addEventListener("click", onCancel);
  });
}

function applyUnfollowed(result, unfollowed) {
  const gone = new Set(unfollowed.map((u) => u.id));
  const keep = (arr) => (arr || []).filter((u) => !gone.has(u.id));
  const moved = (result.mutual || []).filter((u) => gone.has(u.id));
  return withDerived({
    ...result,
    notBack: keep(result.notBack),
    mutual: keep(result.mutual),
    fansOnly: [...keep(result.fansOnly), ...moved],
    following: keep(result.following),
    followers: result.followers,
  });
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

async function unfollowUsers(users) {
  if (!users.length || busy()) return;
  if (!canUnfollowTab()) {
    setStatus(t(state.lang, "cannotUnfollow"), "warn");
    return;
  }
  const ok = await confirmUnfollow(users);
  if (!ok) return;

  state.unfollowing = true;
  state.abort = new AbortController();
  $("startBtn").hidden = true;
  $("stopBtn").hidden = false;
  $("progressWrap").hidden = false;
  $("unfollowBtn").disabled = true;

  try {
    const result = await runUnfollow(users, {
      signal: state.abort.signal,
      onProgress: (p) => {
        const label = p.user?.screenName || p.user?.id || "";
        const step = `${p.index + 1}/${p.total}`;
        if (p.waiting === "look") setStatus(`${t(state.lang, "unfollowLook")} ${step} @${label}`);
        else if (p.waiting === "between") setStatus(`${t(state.lang, "unfollowBetween")} ${step}`);
        else if (p.waiting === "rest") setStatus(t(state.lang, "unfollowRest"), "warn");
        else if (p.rateLimited) setStatus(t(state.lang, "rateLimited"), "warn");
        else setStatus(`${t(state.lang, "unfollowing")} ${step} @${label}`);
        setProgress(p.index, p.total);
      },
    });
    if (result.ok.length) {
      await saveResult(applyUnfollowed(state.result, result.ok));
      for (const user of result.ok) state.selected.delete(user.id);
      await bumpTodayCount(result.ok.length);
    }
    renderResult();
    $("bar").style.width = "100%";
    const failBit = result.fail.length ? ` · ${t(state.lang, "unfollowFail")} ${result.fail.length}` : "";
    setStatus(`${t(state.lang, "unfollowDone")} ${result.ok.length}${failBit}`, result.fail.length ? "warn" : "");
  } catch (error) {
    if (error?.name === "AbortError") setStatus(t(state.lang, "stopped"), "warn");
    else if (error?.code === "NOT_AUTHENTICATED") setStatus(t(state.lang, "needLogin"), "warn");
    else setStatus(`${t(state.lang, "error")}: ${error.message || error}`, "err");
  } finally {
    state.unfollowing = false;
    state.abort = null;
    $("startBtn").hidden = false;
    $("stopBtn").hidden = true;
    renderBatch();
    setTimeout(() => {
      if (!busy()) $("progressWrap").hidden = true;
    }, 700);
  }
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
  const stored = await chrome.storage.local.get(["lang", "lastResult"]);
  state.lang = stored.lang || detectLang();
  state.result = withDerived(stored.lastResult || null);
  state.rewardHistory = await loadHistory();
  await loadTodayCount();
  applyI18n();
  renderResult();
  renderCreator();
  const { rewardAuto } = await chrome.storage.local.get("rewardAuto");
  $("autoRewards").checked = Boolean(rewardAuto);
  $("autoHint").textContent = t(state.lang, rewardAuto ? "autoOn" : "autoOff");

  try {
    const auth = await getAuth();
    if (!auth.csrf || !auth.authToken) {
      setAccount(state.result?.me, false);
      setStatus(t(state.lang, "needLogin"), "warn");
      return;
    }
    const cached = state.result?.me;
    if (cached?.screenName && cached?.avatar) {
      setAccount(cached, true);
    } else {
      const me = await resolveMe(auth);
      const merged = {
        ...cached,
        ...me,
        avatar: me.avatar || cached?.avatar || "",
        screenName: me.screenName || cached?.screenName || "",
        name: me.name && me.name !== "You" ? me.name : cached?.name || me.name,
      };
      setAccount(merged, true);
      if (state.result) {
        state.result.me = merged;
        await saveResult(state.result);
      }
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
    const official = scanned.counts.followersOfficial || 0;
    const listed = scanned.counts.followers || 0;
    if (official && Math.abs(official - listed) >= 3) {
      setStatus(
        `${t(state.lang, "done")} · ${t(state.lang, "notBack")} ${scanned.counts.notBack} · ${tf(state.lang, "countGap", { listed, official })}`
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
      setStatus(`${t(state.lang, "error")}: ${error.message || error}`, "err");
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

$("langBtn").addEventListener("click", async () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  await chrome.storage.local.set({ lang: state.lang });
  applyI18n();
  renderResult();
});

$("openX").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://x.com/home" });
});

$("viewRelation").addEventListener("click", () => setView("relation"));
$("viewCreator").addEventListener("click", () => setView("creator"));
$("openStudioBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: REWARDS_PAGE });
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

$("startBtn").addEventListener("click", startScan);
$("stopBtn").addEventListener("click", () => state.abort?.abort());

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

$("unfollowBtn").addEventListener("click", () => {
  const users = currentRows().filter((u) => state.selected.has(u.id));
  if (!users.length) {
    setStatus(t(state.lang, "noSelection"), "warn");
    return;
  }
  unfollowUsers(users);
});

$("list").addEventListener("change", (event) => {
  const pick = event.target.closest("[data-pick]");
  if (!pick) return;
  const id = pick.dataset.pick;
  if (pick.checked) state.selected.add(id);
  else state.selected.delete(id);
  renderBatch();
});

$("list").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-unfollow]");
  if (!btn || busy()) return;
  const id = btn.dataset.unfollow;
  const user = currentRows().find((item) => item.id === id);
  if (user) unfollowUsers([user]);
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

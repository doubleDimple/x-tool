import {
  XError,
  discoverQueryIds,
  fetchListPage,
  getAuth,
  getCaptured,
  pingXTab,
  verifyCredentials,
} from "./api.js";

const PAGE_DELAY_MS = 1100;
const PAGE_JITTER_MS = 500;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForRateLimit(error, onProgress, signal) {
  const until = error?.extra?.retryAfter || Date.now() + 60_000;
  const wait = Math.max(5_000, Math.min(until - Date.now(), 90_000));
  onProgress?.({ rateLimited: true, wait });
  await sleep(wait, signal);
}

async function paginate(kind, userId, csrf, expected, onProgress, signal) {
  const users = [];
  const seen = new Set();
  let cursor = null;
  let prefer;
  const seenCursors = new Set();
  let emptyPages = 0;

  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    let page;
    try {
      page = await fetchListPage({ kind, userId, cursor, csrf, prefer, signal });
    } catch (error) {
      if (error?.code === "RATE_LIMITED") {
        await waitForRateLimit(error, onProgress, signal);
        continue;
      }
      throw error;
    }

    prefer = page.mode;
    let added = 0;
    for (const user of page.users) {
      if (!user.id || seen.has(user.id)) continue;
      seen.add(user.id);
      users.push(user);
      added += 1;
    }

    onProgress?.({
      kind,
      loaded: users.length,
      expected,
      mode: page.mode,
      rateLimited: false,
    });

    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    if (added === 0) {
      emptyPages += 1;
      if (emptyPages >= 2) break;
    } else {
      emptyPages = 0;
    }
    cursor = page.nextCursor;
    await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * PAGE_JITTER_MS), signal);
  }

  return { users, mode: prefer };
}

function diffLists(following, followers) {
  const followerIds = new Set(followers.map((u) => u.id));
  const followingIds = new Set(following.map((u) => u.id));
  const hasFollowerSet = followerIds.size > 0;

  const notBack = following.filter((u) => {
    if (hasFollowerSet) return !followerIds.has(u.id);
    return u.followedBy === false;
  });
  const mutual = following.filter((u) => {
    if (hasFollowerSet) return followerIds.has(u.id);
    return u.followedBy === true;
  });
  const fansOnly = followers.filter((u) => !followingIds.has(u.id));

  return { notBack, mutual, fansOnly };
}

export async function runScan({ onProgress, signal }) {
  onProgress?.({ phase: "auth" });
  await pingXTab();
  await sleep(250, signal);

  const auth = await getAuth();
  if (!auth.csrf || !auth.authToken) {
    throw new XError("NOT_AUTHENTICATED", "Please log in to x.com first");
  }

  let me;
  try {
    me = await verifyCredentials(auth.csrf, signal);
  } catch (error) {
    if (error?.code === "RATE_LIMITED") {
      await waitForRateLimit(error, onProgress, signal);
      me = await verifyCredentials(auth.csrf, signal);
    } else if (auth.userId) {
      me = {
        id: auth.userId,
        screenName: "",
        name: "You",
        avatar: "",
        followingCount: 0,
        followersCount: 0,
      };
    } else {
      throw error;
    }
  }

  const captured = await getCaptured();
  if (!captured.queryIds?.Following || !captured.queryIds?.Followers) {
    try {
      await discoverQueryIds(auth.csrf, signal);
    } catch {
      /* hardcoded ids still work as fallback */
    }
  }

  onProgress?.({ phase: "following", me, loaded: 0, expected: me.followingCount });
  const followingPage = await paginate(
    "following",
    me.id,
    auth.csrf,
    me.followingCount,
    (progress) => onProgress?.({ phase: "following", me, ...progress }),
    signal
  );

  onProgress?.({
    phase: "followers",
    me,
    loaded: 0,
    expected: me.followersCount,
    followingLoaded: followingPage.users.length,
  });

  let followersUsers = [];
  let followersMode = null;
  try {
    const followersPage = await paginate(
      "followers",
      me.id,
      auth.csrf,
      me.followersCount,
      (progress) =>
        onProgress?.({
          phase: "followers",
          me,
          followingLoaded: followingPage.users.length,
          ...progress,
        }),
      signal
    );
    followersUsers = followersPage.users;
    followersMode = followersPage.mode;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    onProgress?.({
      phase: "followers",
      me,
      warning: error.message,
      followingLoaded: followingPage.users.length,
    });
  }

  onProgress?.({ phase: "diff", me });
  const { notBack, mutual, fansOnly } = diffLists(followingPage.users, followersUsers);

  return {
    me,
    scannedAt: Date.now(),
    following: followingPage.users,
    followers: followersUsers,
    notBack,
    mutual,
    fansOnly,
    modes: {
      following: followingPage.mode,
      followers: followersMode,
    },
    counts: {
      following: followingPage.users.length,
      followers: followersUsers.length,
      notBack: notBack.length,
      mutual: mutual.length,
      fansOnly: fansOnly.length,
    },
  };
}

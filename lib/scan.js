import {
  XError,
  discoverQueryIds,
  fetchListPage,
  getAuth,
  getCaptured,
  pingXTab,
  resolveMe,
  followUser,
  unfollowUser,
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
  let unavailable = 0;

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
    unavailable += page.unavailable || 0;
    for (const user of page.users) {
      if (!user.id || seen.has(user.id)) continue;
      seen.add(user.id);
      users.push(user);
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
    cursor = page.nextCursor;
    await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * PAGE_JITTER_MS), signal);
  }

  return { users, mode: prefer, unavailable };
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
    me = await resolveMe(auth, signal);
  } catch (error) {
    if (error?.code === "RATE_LIMITED") {
      await waitForRateLimit(error, onProgress, signal);
      me = await resolveMe(auth, signal);
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

  const tally = { following: 0, followers: 0 };
  const emitLists = () => {
    onProgress?.({
      phase: "lists",
      me,
      followingLoaded: tally.following,
      followersLoaded: tally.followers,
      followingExpected: me.followingCount,
      followersExpected: me.followersCount,
      loaded: tally.following + tally.followers,
      expected: (me.followingCount || 0) + (me.followersCount || 0),
    });
  };

  emitLists();

  const followingPromise = paginate(
    "following",
    me.id,
    auth.csrf,
    me.followingCount,
    (progress) => {
      if (typeof progress.loaded === "number") tally.following = progress.loaded;
      emitLists();
      if (progress.rateLimited) onProgress?.({ ...progress, phase: "lists", me });
    },
    signal
  );

  const followersPromise = (async () => {
    await sleep(400 + Math.floor(Math.random() * 400), signal);
    try {
      return await paginate(
        "followers",
        me.id,
        auth.csrf,
        me.followersCount,
        (progress) => {
          if (typeof progress.loaded === "number") tally.followers = progress.loaded;
          emitLists();
          if (progress.rateLimited) onProgress?.({ ...progress, phase: "lists", me });
        },
        signal
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      onProgress?.({
        phase: "lists",
        me,
        warning: error.message,
        followingLoaded: tally.following,
        followersLoaded: tally.followers,
      });
      return { users: [], mode: null, unavailable: 0 };
    }
  })();

  const [followingPage, followersPage] = await Promise.all([followingPromise, followersPromise]);
  const followersUsers = followersPage.users;
  const followersMode = followersPage.mode;
  const unavailableFollowers = followersPage.unavailable || 0;

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
      followingOfficial: me.followingCount || followingPage.users.length,
      followersOfficial: me.followersCount || followersUsers.length,
      unavailableFollowers,
    },
  };
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function pauseLikeHuman(kind, signal, onProgress) {
  const ms =
    kind === "look"
      ? randInt(300, 900)
      : kind === "between"
        ? randInt(2800, 5500)
        : kind === "rest"
          ? randInt(10000, 18000)
          : randInt(8000, 14000);
  onProgress?.({ waiting: kind, wait: ms });
  await sleep(ms, signal);
}

let friendshipInFlight = false;

async function runFriendship(users, { onProgress, signal }, act) {
  if (friendshipInFlight) {
    throw new XError("BUSY", "A follow/unfollow batch is already running");
  }
  friendshipInFlight = true;

  try {
    const auth = await getAuth();
    if (!auth.csrf || !auth.authToken) {
      throw new XError("NOT_AUTHENTICATED", "Please log in to x.com first");
    }

    const ok = [];
    const fail = [];
    const restEvery = randInt(12, 18);

    for (let i = 0; i < users.length; i += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const user = users[i];
      const emit = (extra = {}) => {
        onProgress?.({
          index: i,
          total: users.length,
          user,
          doneCount: ok.length,
          failCount: fail.length,
          left: users.length - ok.length - fail.length,
          ...extra,
        });
      };
      emit({ waiting: "look" });
      await pauseLikeHuman("look", signal, emit);

      let done = false;
      try {
        await act(user.id, auth.csrf, signal);
        ok.push(user);
        done = true;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (error?.code === "RATE_LIMITED") {
          await waitForRateLimit(error, onProgress, signal);
          try {
            await act(user.id, auth.csrf, signal);
            ok.push(user);
            done = true;
          } catch (retryError) {
            if (retryError?.name === "AbortError") throw retryError;
            fail.push({ user, error: retryError.message || String(retryError) });
          }
        } else {
          await pauseLikeHuman("retry", signal, onProgress);
          try {
            await act(user.id, auth.csrf, signal);
            ok.push(user);
            done = true;
          } catch (retryError) {
            if (retryError?.name === "AbortError") throw retryError;
            fail.push({ user, error: retryError.message || String(retryError) });
          }
        }
      }

      emit({ done });
      if (i >= users.length - 1) continue;

      await pauseLikeHuman("between", signal, emit);
      if ((ok.length + fail.length) % restEvery === 0) {
        await pauseLikeHuman("rest", signal, emit);
      }
    }

    return { ok, fail };
  } finally {
    friendshipInFlight = false;
  }
}

export async function runUnfollow(users, opts) {
  return runFriendship(users, opts, unfollowUser);
}

export async function runFollow(users, opts) {
  return runFriendship(users, opts, followUser);
}

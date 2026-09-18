import { findXClientTab } from "./tabs.js";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const DEFAULT_QUERY_IDS = {
  Following: "F42cDX8PDFxkbjjq6JrM2w",
  Followers: "_orfRBQae57vylFPH0Huhg",
  UserByScreenName: "IGgvgiOx4QZndDHuD3x9TQ",
  CreatorStudioTabBarItemQuery: "1KZj_GRTxmPaSrk8jIb1Yw",
};

const GRAPHQL_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  hidden_profile_subscriptions_enabled: true,
};

export class XError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export async function getCookie(name) {
  const fromX = await chrome.cookies.get({ url: "https://x.com", name });
  if (fromX?.value) return fromX.value;
  const fromT = await chrome.cookies.get({ url: "https://twitter.com", name });
  return fromT?.value || null;
}

export async function getAuth() {
  const csrf = await getCookie("ct0");
  const authToken = await getCookie("auth_token");
  const twid = await getCookie("twid");
  const userId = twid ? decodeURIComponent(twid).replace(/^u=/, "") : null;
  return { csrf, authToken, userId };
}

export async function getCaptured() {
  const { captured } = await chrome.storage.local.get("captured");
  return captured || {};
}

async function getQueryIds() {
  const captured = await getCaptured();
  const { queryIds } = await chrome.storage.local.get("queryIds");
  return {
    ...DEFAULT_QUERY_IDS,
    ...(queryIds || {}),
    ...(captured.queryIds || {}),
  };
}

function headers(csrf, extra = {}) {
  return {
    authorization: extra.authorization || `Bearer ${decodeURIComponent(BEARER)}`,
    "x-csrf-token": csrf,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": extra.lang || "en",
    accept: "*/*",
    "content-type": "application/json",
    ...extra.headers,
  };
}

function throwForStatus(status, detail, retryAfter) {
  if (status === 401) {
    throw new XError("NOT_AUTHENTICATED", "Please log in to x.com first");
  }
  if (status === 429) {
    throw new XError("RATE_LIMITED", "Rate limited", {
      retryAfter: retryAfter ? Number(retryAfter) * 1000 : Date.now() + 60_000,
    });
  }
  if (status < 200 || status >= 300) {
    throw new XError("HTTP", `HTTP ${status}: ${detail || ""}`.trim(), { status });
  }
}

function parseJsonBody(text, status) {
  try {
    return JSON.parse(text);
  } catch {
    throw new XError("HTTP", `HTTP ${status}: invalid JSON`, { status });
  }
}

async function fetchViaPage(url, headerMap, { method = "GET", body } = {}) {
  const tab = await findXClientTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(
      tab.id,
      {
        type: "PAGE_FETCH",
        url,
        headers: headerMap,
        method,
        body: body ?? null,
      },
      { frameId: 0 }
    );
  } catch {
    return null;
  }
}

async function xfetch(url, csrf, { signal, extraHeaders, method = "GET", body } = {}) {
  const captured = await getCaptured();
  const headerMap = headers(csrf, {
    authorization: captured.authorization,
    headers: extraHeaders,
  });

  const init = {
    method,
    headers: headerMap,
    credentials: "include",
    signal,
  };
  if (body != null) init.body = body;

  const response = await fetch(url, init);

  const retryAfter = response.headers.get("x-rate-limit-reset");
  if (response.ok) {
    const text = await response.text();
    if (!text) return {};
    return parseJsonBody(text, response.status);
  }

  if (response.status === 403 || response.status === 404) {
    const viaPage = await fetchViaPage(url, headerMap, { method, body });
    if (viaPage?.ok) {
      if (!viaPage.text) return {};
      return parseJsonBody(viaPage.text, viaPage.status);
    }
    if (viaPage?.status) {
      throwForStatus(viaPage.status, viaPage.text?.slice(0, 180), retryAfter);
    }
  }

  let detail = response.statusText;
  try {
    const body = await response.json();
    detail = body?.errors?.[0]?.message || JSON.stringify(body).slice(0, 180);
  } catch {
    /* ignore */
  }
  throwForStatus(response.status, detail, retryAfter);
  throw new XError("HTTP", `HTTP ${response.status}: ${detail}`, { status: response.status });
}

function biggerAvatar(url) {
  if (!url) return "";
  return String(url)
    .replace("_normal.", "_bigger.")
    .replace("_mini.", "_bigger.")
    .replace("_x96.", "_bigger.")
    .replace("_reasonably_small.", "_bigger.");
}

function richerUser(current, next) {
  if (!current) return next;
  if (!next) return current;
  const score = (u) => (u.screenName ? 4 : 0) + (u.name ? 2 : 0) + (u.avatar ? 1 : 0);
  return score(next) > score(current) ? { ...current, ...next } : current;
}

export function normalizeUser(raw, source = "graphql") {
  if (!raw) return null;
  if (source === "rest") {
    return {
      id: String(raw.id_str || raw.id),
      screenName: raw.screen_name || "",
      name: raw.name || "",
      avatar: biggerAvatar(raw.profile_image_url_https),
      bio: raw.description || "",
      followers: raw.followers_count ?? 0,
      following: raw.friends_count ?? 0,
      verified: Boolean(raw.verified || raw.ext_is_blue_verified),
      followedBy: Boolean(raw.followed_by),
      followingThem: Boolean(raw.following),
    };
  }

  const user = raw.result && (raw.result.rest_id || raw.result.legacy || raw.result.core) ? raw.result : raw;
  if (!user || user.__typename === "UserUnavailable") return null;
  const core = user.core || {};
  const legacy = user.legacy || {};
  const avatar = user.avatar || {};
  const rel = user.relationship_perspectives || {};
  const id = String(user.rest_id || legacy.id_str || raw.rest_id || "");
  const screenName = core.screen_name || legacy.screen_name || user.screen_name || "";
  if (!id && !screenName) return null;
  return {
    id,
    screenName,
    name: core.name || legacy.name || user.name || "",
    avatar: biggerAvatar(avatar.image_url || legacy.profile_image_url_https),
    bio: user.profile_bio?.description || legacy.description || "",
    followers: legacy.followers_count ?? user.followers_count ?? 0,
    following: legacy.friends_count ?? user.friends_count ?? 0,
    verified: Boolean(user.is_blue_verified || legacy.verified),
    followedBy: Boolean(rel.followed_by ?? legacy.followed_by),
    followingThem: Boolean(rel.following ?? legacy.following),
  };
}

function walkUsersAndCursor(node, acc) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) walkUsersAndCursor(item, acc);
    return acc;
  }
  if (node.cursorType === "Bottom" && typeof node.value === "string") {
    acc.nextCursor = node.value;
  } else if (
    typeof node.entryId === "string" &&
    /cursor-bottom/i.test(node.entryId) &&
    node.content?.value
  ) {
    acc.nextCursor = node.content.value;
  }

  const result = node.user_results?.result || (node.__typename === "User" || node.__typename === "UserUnavailable" ? node : null);
  if (result?.__typename === "UserUnavailable") {
    acc.unavailableIds = acc.unavailableIds || new Set();
    const key = String(result.rest_id || `anon:${acc.unavailableIds.size}`);
    if (!acc.unavailableIds.has(key)) {
      acc.unavailableIds.add(key);
      acc.unavailable = (acc.unavailable || 0) + 1;
    }
  } else if (result && (result.legacy || result.core || result.rest_id) && result.__typename !== "UserUnavailable") {
    const user = normalizeUser(result, "graphql");
    if (user?.id) {
      const prev = acc.byId.get(user.id);
      if (!prev) {
        acc.byId.set(user.id, user);
        acc.users.push(user);
      } else {
        const merged = richerUser(prev, user);
        acc.byId.set(user.id, merged);
        const idx = acc.users.findIndex((item) => item.id === user.id);
        if (idx >= 0) acc.users[idx] = merged;
      }
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkUsersAndCursor(value, acc);
  }
  return acc;
}

export function parseGraphQlList(data) {
  const root = data?.data?.user?.result;
  const rootId = root?.rest_id ? String(root.rest_id) : null;
  const timeline =
    root?.timeline?.timeline ||
    root?.timeline_v2?.timeline ||
    root?.timeline ||
    data;
  const acc = { users: [], nextCursor: null, byId: new Map(), unavailable: 0 };
  walkUsersAndCursor(timeline, acc);
  if (rootId) acc.users = acc.users.filter((user) => user.id !== rootId);
  if (acc.nextCursor && String(acc.nextCursor).startsWith("0|")) acc.nextCursor = null;
  return { users: acc.users, nextCursor: acc.nextCursor, unavailable: acc.unavailable || 0 };
}

export function parseRestList(data) {
  const users = (data.users || []).map((u) => normalizeUser(u, "rest")).filter(Boolean);
  const next = data.next_cursor_str;
  const nextCursor = next && next !== "0" ? next : null;
  return { users, nextCursor };
}

async function graphqlList(operation, userId, cursor, csrf, signal) {
  const ids = await getQueryIds();
  const queryId = ids[operation];
  if (!queryId) throw new XError("NO_QUERY_ID", `Missing query id for ${operation}`);

  const captured = await getCaptured();
  let features = GRAPHQL_FEATURES;
  if (captured.features && typeof captured.features === "string") {
    try {
      features = JSON.parse(captured.features);
    } catch {
      /* keep default */
    }
  } else if (captured.features && typeof captured.features === "object") {
    features = captured.features;
  }

  const variables = {
    userId,
    count: 100,
    includePromotedContent: false,
    withGrokTranslatedBio: false,
  };
  if (cursor) variables.cursor = cursor;

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });
  const url = `https://x.com/i/api/graphql/${queryId}/${operation}?${params}`;
  const data = await xfetch(url, csrf, { signal });
  return parseGraphQlList(data);
}

async function restList(kind, userId, cursor, csrf, signal) {
  const path = kind === "following" ? "friends/list.json" : "followers/list.json";
  const params = new URLSearchParams({
    user_id: userId,
    count: "200",
    skip_status: "true",
    include_user_entities: "false",
    cursor: cursor || "-1",
  });
  const url = `https://x.com/i/api/1.1/${path}?${params}`;
  const data = await xfetch(url, csrf, { signal });
  return parseRestList(data);
}

export async function fetchListPage({ kind, userId, cursor, csrf, prefer, signal }) {
  const operation = kind === "following" ? "Following" : "Followers";
  const order =
    prefer === "rest"
      ? ["rest", "graphql"]
      : ["graphql", "rest"];

  let lastError;
  for (const mode of order) {
    try {
      if (mode === "graphql") {
        const page = await graphqlList(operation, userId, cursor, csrf, signal);
        const named = page.users.filter((user) => user.screenName).length;
        if (page.users.length >= 5 && named === 0) {
          throw new XError("PARSE", "GraphQL user payload incomplete");
        }
        return { ...page, mode: "graphql" };
      }
      return { ...(await restList(kind, userId, cursor, csrf, signal)), mode: "rest" };
    } catch (error) {
      lastError = error;
      if (error?.code === "NOT_AUTHENTICATED" || error?.code === "RATE_LIMITED") throw error;
      if (error?.name === "AbortError") throw error;
    }
  }
  throw lastError;
}

async function friendshipPost(userId, csrf, signal, action) {
  const captured = await getCaptured();
  const body = new URLSearchParams({ user_id: String(userId) }).toString();
  const url = `https://x.com/i/api/1.1/friendships/${action}.json`;
  const headerMap = headers(csrf, {
    authorization: captured.authorization,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

  const viaPage = await fetchViaPage(url, headerMap, { method: "POST", body });
  if (viaPage?.ok) {
    return viaPage.text ? parseJsonBody(viaPage.text, viaPage.status) : {};
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const response = await fetch(url, {
    method: "POST",
    headers: headerMap,
    credentials: "include",
    body,
    signal,
  });
  const text = await response.text();
  if (response.ok) return text ? parseJsonBody(text, response.status) : {};
  if (viaPage?.status >= 400) {
    throwForStatus(viaPage.status, viaPage.text?.slice(0, 180), response.headers.get("x-rate-limit-reset"));
  }
  throwForStatus(response.status, text.slice(0, 180), response.headers.get("x-rate-limit-reset"));
}

export async function unfollowUser(userId, csrf, signal) {
  return friendshipPost(userId, csrf, signal, "destroy");
}

export async function followUser(userId, csrf, signal) {
  return friendshipPost(userId, csrf, signal, "create");
}

export async function resolveMe(auth, signal) {
  let me = null;
  try {
    me = await verifyCredentials(auth.csrf, signal);
  } catch (error) {
    if (error?.code === "RATE_LIMITED") throw error;
  }

  if (!me && auth.userId) {
    try {
      const data = await xfetch(
        `https://x.com/i/api/1.1/users/show.json?user_id=${encodeURIComponent(auth.userId)}`,
        auth.csrf,
        { signal }
      );
      me = {
        id: String(data.id_str || data.id || auth.userId),
        screenName: data.screen_name || "",
        name: data.name || "",
        avatar: biggerAvatar(data.profile_image_url_https),
        followingCount: data.friends_count ?? 0,
        followersCount: data.followers_count ?? 0,
      };
    } catch {
      /* try settings next */
    }
  }

  if (!me) {
    try {
      const settings = await xfetch("https://x.com/i/api/1.1/account/settings.json", auth.csrf, { signal });
      if (settings?.screen_name) {
        const profile = await getUserByScreenName(settings.screen_name, auth.csrf, signal);
        me = { ...profile, id: profile.id || auth.userId };
      }
    } catch {
      /* last resort below */
    }
  }

  if (!me && auth.userId) {
    me = {
      id: auth.userId,
      screenName: "",
      name: "You",
      avatar: "",
      followingCount: 0,
      followersCount: 0,
    };
  }
  if (!me) throw new XError("NOT_AUTHENTICATED", "Please log in to x.com first");

  if (!me.avatar || !me.screenName) {
    const fromPage = await detectViewerFromTab();
    if (fromPage) {
      me = {
        ...me,
        screenName: me.screenName || fromPage.screenName || "",
        name: me.name && me.name !== "You" ? me.name : fromPage.name || me.name,
        avatar: me.avatar || biggerAvatar(fromPage.avatar),
      };
    }
  }
  return me;
}

export async function detectViewerFromTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!tabs[0]?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tabs[0].id, { type: "GET_VIEWER" });
  } catch {
    return null;
  }
}

export async function verifyCredentials(csrf, signal) {
  const data = await xfetch(
    "https://x.com/i/api/1.1/account/verify_credentials.json?skip_status=true",
    csrf,
    { signal }
  );
  return {
    id: String(data.id_str || data.id),
    screenName: data.screen_name,
    name: data.name,
    avatar: biggerAvatar(data.profile_image_url_https),
    followingCount: data.friends_count ?? 0,
    followersCount: data.followers_count ?? 0,
  };
}

export async function getUserByScreenName(screenName, csrf, signal) {
  const ids = await getQueryIds();
  const variables = { screen_name: screenName, withSafetyModeUserFields: true };
  const features = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
    fieldToggles: JSON.stringify({ withAuxiliaryUserLabels: true, withPayments: false }),
  });
  const url = `https://x.com/i/api/graphql/${ids.UserByScreenName}/UserByScreenName?${params}`;
  const data = await xfetch(url, csrf, { signal });
  const user = data?.data?.user?.result;
  if (!user?.rest_id) throw new XError("API_ERROR", "User not found");
  const parsed = normalizeUser(user, "graphql") || {};
  return {
    id: user.rest_id,
    screenName: parsed.screenName || screenName,
    name: parsed.name || screenName,
    avatar: parsed.avatar || "",
    followingCount: parsed.following || user.legacy?.friends_count || 0,
    followersCount: parsed.followers || user.legacy?.followers_count || 0,
  };
}

const QUERY_NAME_KEEP =
  /^(Following|Followers|UserByScreenName|useFetchAnalyticsQuery|CreatorStudioTabBarItemQuery)$|Eligib|Monetiz|Reward|OriginalContent|CreatorStudio|AnalyticsQuery|Jetfuel|useFetch/i;

export async function graphqlRequest(operation, variables = {}, { signal } = {}) {
  const auth = await getAuth();
  if (!auth.csrf || !auth.authToken) {
    throw new XError("NOT_AUTHENTICATED", "Please log in to x.com first");
  }
  let ids = await getQueryIds();
  if (!ids[operation]) {
    try {
      await discoverQueryIds(auth.csrf, signal);
    } catch {
      /* keep defaults */
    }
    ids = await getQueryIds();
  }
  const queryId = ids[operation];
  if (!queryId) throw new XError("NO_QUERY_ID", `Missing query id for ${operation}`);
  const params = new URLSearchParams({ variables: JSON.stringify(variables) });
  const captured = await getCaptured();
  if (captured.features) {
    params.set(
      "features",
      typeof captured.features === "string" ? captured.features : JSON.stringify(captured.features)
    );
  }
  const url = `https://x.com/i/api/graphql/${queryId}/${operation}?${params}`;
  return xfetch(url, auth.csrf, { signal });
}

export async function discoverQueryIds(csrf, signal) {
  const html = await fetch("https://x.com/", { credentials: "include", signal }).then((r) => r.text());
  const urls = [...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"' ]+\.js/g)].map(
    (m) => m[0]
  );
  const unique = [...new Set(urls)].slice(0, 24);
  const found = {};
  const re =
    /(?:queryId|queryID)["':]+([A-Za-z0-9_-]{10,})["']?[^.]{0,140}operationName["':]+([A-Za-z0-9_]+)\b|\boperationName["':]+([A-Za-z0-9_]+)[^.]{0,140}(?:queryId|queryID)["':]+([A-Za-z0-9_-]{10,})/g;

  for (const url of unique) {
    if (signal?.aborted) break;
    let text = "";
    try {
      text = await fetch(url, { signal }).then((r) => r.text());
    } catch {
      continue;
    }
    for (const match of text.matchAll(re)) {
      const id = match[1] || match[4];
      const name = match[2] || match[3];
      if (id && name && QUERY_NAME_KEEP.test(name)) found[name] = id;
    }
  }

  if (Object.keys(found).length) {
    const { queryIds } = await chrome.storage.local.get("queryIds");
    await chrome.storage.local.set({ queryIds: { ...(queryIds || {}), ...found } });
  }
  return found;
}

export async function pingXTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!tabs.length) return false;
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_CAPTURE" });
    } catch {
      /* content script may not be ready */
    }
  }
  return true;
}

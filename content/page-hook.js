(() => {
  if (window.__xtoolHook) return;
  window.__xtoolHook = true;

  const GRAPHQL_RE = /\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/(Following|Followers|UserByScreenName|VerifiedFollowers)\b/;
  const state = {
    authorization: "",
    queryIds: {},
    features: "",
  };

  const emit = () => {
    window.postMessage({ __xtool: "CAPTURE", payload: { ...state } }, "*");
  };

  const captureAuth = (value) => {
    if (typeof value === "string" && value.startsWith("Bearer ") && value !== state.authorization) {
      state.authorization = value;
      emit();
    }
  };

  const captureUrl = (url) => {
    if (!url) return;
    const match = String(url).match(GRAPHQL_RE);
    if (!match) return;
    const [, queryId, operation] = match;
    const name = operation === "VerifiedFollowers" ? "Followers" : operation;
    let changed = false;
    if (state.queryIds[name] !== queryId) {
      state.queryIds = { ...state.queryIds, [name]: queryId };
      changed = true;
    }
    try {
      const features = new URL(url, location.origin).searchParams.get("features");
      if (features && features !== state.features) {
        state.features = features;
        changed = true;
      }
    } catch {
      /* ignore */
    }
    if (changed) emit();
  };

  const nativeSet = Headers.prototype.set;
  Headers.prototype.set = function set(name, value) {
    if (String(name).toLowerCase() === "authorization") captureAuth(value);
    return nativeSet.apply(this, arguments);
  };

  const nativeFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    captureUrl(url);
    const hdrs = init?.headers;
    if (hdrs) {
      const value = typeof hdrs.get === "function" ? hdrs.get("authorization") : hdrs.authorization || hdrs.Authorization;
      if (value) captureAuth(value);
    }
    return nativeFetch.apply(this, arguments);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__xtoolUrl = url;
    captureUrl(url);
    return nativeOpen.call(this, method, url, ...rest);
  };

  const nativeHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name, value) {
    if (String(name).toLowerCase() === "authorization") captureAuth(value);
    return nativeHeader.apply(this, arguments);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.__xtool === "REQUEST_CAPTURE") emit();
    if (event.data?.__xtool === "FETCH") {
      const { id, url, headers } = event.data;
      nativeFetch(url, { method: "GET", headers: headers || {}, credentials: "include" })
        .then(async (res) => {
          const text = await res.text();
          window.postMessage({ __xtool: "FETCH_RESULT", id, ok: res.ok, status: res.status, text }, "*");
        })
        .catch((err) => {
          window.postMessage({
            __xtool: "FETCH_RESULT",
            id,
            ok: false,
            status: 0,
            error: String(err),
          }, "*");
        });
    }
  });
})();

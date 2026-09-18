function paintToast(text) {
  const id = "xtool-page-toast";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "right:16px",
      "bottom:16px",
      "max-width:min(360px,calc(100vw - 32px))",
      "padding:12px 14px",
      "border-radius:12px",
      "background:#141610",
      "color:#f3f0e4",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif",
      "box-shadow:0 12px 40px rgba(0,0,0,.28)",
      "border:1px solid #d6ff3c",
      "opacity:0",
      "transform:translateY(8px)",
      "transition:opacity .2s ease,transform .2s ease",
      "pointer-events:none",
    ].join(";");
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });
  clearTimeout(el._xtoolTimer);
  el._xtoolTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
  }, 4200);
}

async function showChromeNotification(title, message) {
  try {
    await chrome.notifications.create("xtool-job", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 1,
    });
  } catch {
    /* notifications may be blocked */
  }
}

export async function notifyCurrentPage(text, { title = "X-Tool" } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let painted = false;
  if (tab?.id && /^https?:/i.test(tab.url || "")) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: paintToast,
        args: [text],
      });
      painted = true;
    } catch {
      painted = false;
    }
  }
  if (!painted) await showChromeNotification(title, text);
}

export function jobSuccessText(kind, progress) {
  const handle = progress?.user?.screenName || progress?.user?.id || "";
  const done = progress?.doneCount ?? 0;
  const total = progress?.total ?? 0;
  const verb = kind === "follow" ? "已关注" : "已取关";
  return `${verb} @${handle}  ·  ${done}/${total}`;
}

export function jobDoneText(kind, result, error) {
  const verb = kind === "follow" ? "关注" : "取关";
  if (error?.name === "AbortError") {
    const done = result?.ok?.length || 0;
    return `已停止。成功 ${done} 个`;
  }
  if (error?.message) return `${verb}失败：${error.message}`;
  const ok = result?.ok?.length || 0;
  const fail = result?.fail?.length || 0;
  const reason = result?.fail?.[0]?.error;
  if (fail) return `${verb}完成：成功 ${ok}，失败 ${fail}${reason ? `（${reason}）` : ""}`;
  return `${verb}完成：成功 ${ok} 个`;
}

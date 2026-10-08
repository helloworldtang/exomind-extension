// MV3 service worker：所有网络请求都在这里发，popup 关掉也不中断。
//
// 核心体验设计——「登录后自动补存」：
//   用户未登录就点了存 → 记下 pending → 引导登录 → cookie 一落盘
//   （chrome.cookies.onChanged）→ 自动把刚才那篇存进去。
//   用户不需要「存完 → 登录 → 回来再点一次」。

import { resolveCredential } from "./lib/auth.js";
import { ingestAsync, ApiError } from "./lib/api.js";
import { SESSION_COOKIE, BASE_URL } from "./lib/config.js";

const MENU_ID = "exomind-save-page";
const RECENT_KEY = "recentIngests";
const RECENT_MAX = 5;

let pendingIngest = null;

// 右键菜单入口没有 popup 承接结果，用 badge 反馈成败——静默失败最伤信任。
// badge 留着不清，用户下次打开 popup 时由 popup 主动清掉。
function badge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}


chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "把这个网页存进知识飞轮",
    contexts: ["page"],
  });
});

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function rememberRecent(entry) {
  const { [RECENT_KEY]: list = [] } = await chrome.storage.local.get(RECENT_KEY);
  list.unshift(entry);
  await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) });
}

/** 存入主流程。失败不抛——统一返回 {ok, ...}，popup 只管渲染。 */
async function submit({ url, title, tags } = {}) {
  if (!url || !/^https?:/i.test(url)) {
    return { ok: false, message: "这个页面存不了（不是普通网页）" };
  }
  const cred = await resolveCredential();
  if (!cred) {
    pendingIngest = { url, title, tags };
    return { ok: false, needLogin: true };
  }
  try {
    const data = await ingestAsync({ url, title, tags }, cred);
    await rememberRecent({
      jobId: data.job_id,
      title: title || url,
      url,
      at: Date.now(),
    });
    return { ok: true, jobId: data.job_id };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      // 会话过期：引导重新登录，登录后自动补存
      pendingIngest = { url, title, tags };
      return { ok: false, needLogin: true, message: e.message };
    }
    return { ok: false, message: e.message || "没存上，稍后再试" };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ingest") {
    submit(msg.payload).then(sendResponse);
    return true; // 异步响应
  }
  if (msg?.type === "get-context") {
    currentTab()
      .then((tab) => sendResponse({ url: tab?.url ?? "", title: tab?.title ?? "" }))
      .catch(() => sendResponse({ url: "", title: "" }));
    return true;
  }
  if (msg?.type === "open-login") {
    pendingIngest = msg.pending ?? pendingIngest;
    chrome.tabs.create({ url: msg.loginUrl || BASE_URL });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 右键菜单：不打断阅读流。成败都落到 badge（✓ / !）。
chrome.contextMenus.onClicked.addListener(async (_info, tab) => {
  if (!tab?.url) return;
  const r = await submit({ url: tab.url, title: tab.title ?? "" });
  if (r.ok) badge("✓", "#16a34a");
  else if (r.needLogin) badge("?", "#f59e0b");
  else badge("!", "#dc2626");
});

// 登录完成（token cookie 落盘）→ 自动补存刚才那篇。
chrome.cookies.onChanged.addListener(async (change) => {
  if (change.cookie?.name !== SESSION_COOKIE || change.removed) return;
  if (!change.cookie.domain?.includes("youhuale.cn")) return;
  if (!pendingIngest) return;
  const p = pendingIngest;
  pendingIngest = null;
  const result = await submit(p);
  // 通知 popup（若还开着）刷新状态与结果
  chrome.runtime.sendMessage({ type: "ingest-settled", result }).catch(() => {});
});

// MV3 service worker：所有网络请求都在这里发，popup 关掉也不中断。
//
// 核心体验设计——「登录后自动补存」：
//   用户未登录就点了存 → 记下 pending → 引导登录 → cookie 一落盘
//   （chrome.cookies.onChanged）→ 自动把刚才那篇存进去。
//   用户不需要「存完 → 登录 → 回来再点一次」。

import { resolveCredential, authState, AUTH } from "./lib/auth.js";
import { ingestAsync, ApiError } from "./lib/api.js";
import { SESSION_COOKIE, BASE_URL, HOME_URL } from "./lib/config.js";
import { pageExtractor } from "./lib/extract.js";

const MENU_ID = "exomind-save-page";
const RECENT_KEY = "recentIngests";
const RECENT_MAX = 5;

// MV3 service worker 空闲 ~30s 会被杀,纯内存暂存会静默丢失:
// 「登录后自动补存」的待办落 storage.session(SW 重启不丢,关浏览器即清)。
const PENDING_KEY = "pendingIngest";
const setPending = (p) =>
  p ? chrome.storage.session.set({ [PENDING_KEY]: p }) : chrome.storage.session.remove(PENDING_KEY);
async function getPending() {
  const { [PENDING_KEY]: p } = await chrome.storage.session.get(PENDING_KEY);
  return p ?? null;
}

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

// 兜底正文：登录态 SPA（豆包对话等）服务端只抓得到标题一行，页面可见文本
// 只存在于用户浏览器里。提取走 extract.js 的站点策略（doubao 精确命中 →
// generic 兜底），返回 {title, text}：title 是策略拿到的干净标题（如豆包
// 会话标题），text 截 3 万字（与服务端 MAX_INGEST_CONTENT 对齐）后随
// client_content 上送，服务端抓空时才启用（trafilatura 质量优先）。
const CLIENT_CONTENT_MAX = 30000;

async function grabClientContent(tab) {
  try {
    const target = tab ?? (await currentTab());
    if (!target?.id || !/^https?:/i.test(target.url ?? "")) return { title: "", text: "" };
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      func: pageExtractor,
    });
    const r = res?.result ?? {};
    return {
      title: String(r.title ?? ""),
      text: String(r.text ?? "").slice(0, CLIENT_CONTENT_MAX),
    };
  } catch {
    return { title: "", text: "" };
  }
}

async function rememberRecent(entry) {
  const { [RECENT_KEY]: list = [] } = await chrome.storage.local.get(RECENT_KEY);
  list.unshift(entry);
  await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) });
}

/** 存入主流程。失败不抛——统一返回 {ok, ...}，popup 只管渲染。 */
async function submit({ url, title, tags, client } = {}) {
  if (!url || !/^https?:/i.test(url)) {
    return { ok: false, message: "这个页面存不了（不是普通网页）" };
  }
  // 兜底正文在「点存入的那一刻」抓：登录后自动补存时活动页已是登录页，
  // 那时再抓就取到登录页文本了——所以 pending 里必须存原始快照。
  if (client === undefined) {
    client = await grabClientContent();
    // 策略标题仅在「用户没改过 popup 里的标题」时生效：传来的 title 还等于
    // tab 原始标题说明是预填值，替换成策略的干净标题（豆包会话标题）；
    // 用户手改过（≠ tab 标题）则尊重用户。
    if (client.title && title && title === (await currentTab())?.title) {
      title = client.title;
    }
  }
  const cred = await resolveCredential();
  if (!cred) {
    await setPending({ url, title, tags, client });
    return { ok: false, needLogin: true };
  }
  try {
    const data = await ingestAsync({ url, title, tags, clientContent: client.text }, cred);
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
      await setPending({ url, title, tags, client });
      return { ok: false, needLogin: true, message: e.message };
    }
    return { ok: false, message: e.message || "没存上，稍后再试" };
  }
}

// 登录态探活：token cookie 只有 24h，过期后浏览器里页面依然「无感可用」
// （受保护页 302 → auth.ai-as.cc，SSO 长会话静默续签新 token），插件却只
// 看得到过期的 token → 误判未登录。这里对受保护页发一次带凭证的请求，
// 让 302 续签链在 cookie jar 里走完，新 token 落地后再查一次。
// 前提：auth.ai-as.cc 在 host_permissions 里——扩展对其有权限的请求浏览器
// 按同站处理，SameSite=Lax 的 SSO cookie 才会随 fetch 附带（fetch 非顶层
// 导航，没有这条豁免 Lax 不会带）。
async function probeLogin() {
  try {
    // HOME_URL(/ui/home) 是受保护页，中间件才会 302 到 /auth/authorize；
    // 打 "/" 会命中公开 landing，续签链不触发。
    await fetch(HOME_URL, { credentials: "include", redirect: "follow" });
  } catch {
    // 网络不通按未登录处理，不阻塞 popup
  }
  const { state } = await authState();
  return state === AUTH.READY;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ingest") {
    submit(msg.payload).then(sendResponse);
    return true; // 异步响应
  }
  if (msg?.type === "probe-login") {
    probeLogin().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg?.type === "get-context") {
    currentTab()
      .then((tab) => sendResponse({ url: tab?.url ?? "", title: tab?.title ?? "" }))
      .catch(() => sendResponse({ url: "", title: "" }));
    return true;
  }
  if (msg?.type === "open-login") {
    if (msg.pending) setPending(msg.pending); // 不必等落盘:cookie 落地远晚于此
    chrome.tabs.create({ url: msg.loginUrl || BASE_URL });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 右键菜单：不打断阅读流。成败都落到 badge（✓ / !）。
chrome.contextMenus.onClicked.addListener(async (_info, tab) => {
  if (!tab?.url) return;
  const r = await submit({
    url: tab.url,
    title: tab.title ?? "",
    client: await grabClientContent(tab), // 右键场景显式指定 tab,不赌焦点
  });
  if (r.ok) badge("✓", "#16a34a");
  else if (r.needLogin) badge("?", "#f59e0b");
  else badge("!", "#dc2626");
});

// 登录完成（token cookie 落盘）→ 自动补存刚才那篇。
chrome.cookies.onChanged.addListener(async (change) => {
  if (change.cookie?.name !== SESSION_COOKIE || change.removed) return;
  if (!change.cookie.domain?.includes("youhuale.cn")) return;
  const p = await getPending();
  if (!p) return;
  await setPending(null);
  const result = await submit(p);
  // 通知 popup（若还开着）刷新状态与结果
  chrome.runtime.sendMessage({ type: "ingest-settled", result }).catch(() => {});
});

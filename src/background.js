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

// 兜底正文：登录态 SPA（豆包对话等）服务端只抓得到标题一行，页面可见文本
// 只存在于用户浏览器里。随请求带上 client_content，服务端抓空时才启用
// （trafilatura 质量优先）。取不到（chrome:// 页/无权限）就只发 URL。
const CLIENT_CONTENT_MAX = 30000; // 与服务端 MAX_INGEST_CONTENT 对齐

async function grabClientContent(tab) {
  try {
    const target = tab ?? (await currentTab());
    if (!target?.id || !/^https?:/i.test(target.url ?? "")) return "";
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      func: () => {
        // ① 划词优先：选中即意图——聊天气泡/长文里精准截取，天然零噪音
        const sel = String(window.getSelection?.() ?? "").trim();
        if (sel.length >= 50) return sel;
        // ② 语义去噪：读 innerText 前临时隐藏 nav/aside/header/footer
        // （侧栏菜单/顶栏快捷键是 body.innerText 的主要噪音源），读完恢复。
        // 不能用 cloneNode：脱离文档的节点 innerText 退化为 textContent，换行全丢。
        const NOISE =
          "nav,aside,header,footer,[aria-hidden='true'],textarea,[contenteditable='true']";
        const saved = [];
        document.querySelectorAll(NOISE).forEach((el) => {
          saved.push([el, el.style.display]);
          el.style.display = "none";
        });
        let lines = (document.body?.innerText ?? "").split("\n");
        saved.forEach(([el, display]) => (el.style.display = display));
        // ③ 尾部工具条修剪：聊天输入框上方的功能按钮（「对话/图像生成/帮我写作/
        // 更多」）不是语义标签，DOM 层剥不掉；它们的文本特征是成串短行——
        // 从末尾往前删 ≤12 字的短行，直到碰到实质内容行。时间戳（「今天 20:41」）一并清掉。
        while (lines.length) {
          const last = lines[lines.length - 1].trim();
          if (!last || last.length <= 12) lines.pop();
          else break;
        }
        // innerText 的单换行在 markdown 渲染里会黏连成一句，转成段落换行
        return lines.join("\n").replace(/\n(?!\n)/g, "\n\n");
      },
    });
    return String(res?.result ?? "").slice(0, CLIENT_CONTENT_MAX);
  } catch {
    return "";
  }
}

async function rememberRecent(entry) {
  const { [RECENT_KEY]: list = [] } = await chrome.storage.local.get(RECENT_KEY);
  list.unshift(entry);
  await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) });
}

/** 存入主流程。失败不抛——统一返回 {ok, ...}，popup 只管渲染。 */
async function submit({ url, title, tags, clientContent } = {}) {
  if (!url || !/^https?:/i.test(url)) {
    return { ok: false, message: "这个页面存不了（不是普通网页）" };
  }
  // 兜底正文在「点存入的那一刻」抓：登录后自动补存时活动页已是登录页，
  // 那时再抓就取到登录页文本了——所以 pending 里必须存原始快照。
  if (clientContent === undefined) clientContent = await grabClientContent();
  const cred = await resolveCredential();
  if (!cred) {
    pendingIngest = { url, title, tags, clientContent };
    return { ok: false, needLogin: true };
  }
  try {
    const data = await ingestAsync({ url, title, tags, clientContent }, cred);
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
      pendingIngest = { url, title, tags, clientContent };
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
  const r = await submit({
    url: tab.url,
    title: tab.title ?? "",
    clientContent: await grabClientContent(tab), // 右键场景显式指定 tab,不赌焦点
  });
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

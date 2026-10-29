// popup：只管取上下文、发消息、渲染结果。网络请求全在 background。

import { AUTH, authState } from "./lib/auth.js";
import { HOME_URL, LOGIN_URL } from "./lib/config.js";

const $ = (id) => document.getElementById(id);

const els = {
  dot: $("dot"),
  statusText: $("statusText"),
  saveForm: $("saveForm"),
  loginGuide: $("loginGuide"),
  title: $("title"),
  tags: $("tags"),
  saveBtn: $("saveBtn"),
  loginBtn: $("loginBtn"),
  result: $("result"),
  result2: $("result2"),
  retryBtn: $("retryBtn"),
  recent: $("recent"),
  recentList: $("recentList"),
  openHome: $("openHome"),
  openOptions: $("openOptions"),
};

// 服务端状态 → 用户能懂的两个字。degraded 也算存进去了（只是抽取不完整）。
const STATUS_LABEL = {
  done: "已入库",
  degraded: "已入库",
  digesting: "整理中",
  failed: "没存上",
};

function showResult(el, kind, text) {
  el.className = kind;
  el.textContent = text;
}

function setMode(state) {
  const ready = state === AUTH.READY;
  els.saveForm.classList.toggle("hidden", !ready);
  els.loginGuide.classList.toggle("hidden", ready);
  els.dot.classList.toggle("warn", !ready);
  els.statusText.textContent = ready ? "已就绪" : "未登录";
}

/**
 * 最近存入——取服务端真实状态，不用本地记忆：
 * 本地只能记「我提交过」，记不了「到底存上没有」。URL 抓取失败要 6 次退避
 * （最久数小时）才转失败，那之前本地一直是「✓ 已存入」——假成功比失败更糟。
 * 服务端列表带 status 与失败 job_id，失败条目直接给「重试」。
 * 取不到（未登录/断网）才退本地记录，至少标题还在。
 */
async function refreshRecent() {
  const r = await chrome.runtime.sendMessage({ type: "recent" }).catch(() => null);
  if (r?.ok) return renderRecent(r.items ?? []);
  renderLocalRecent();
}

function renderRecent(items) {
  els.recent.style.display = items.length ? "block" : "none";
  els.recentList.innerHTML = "";
  for (const it of items.slice(0, 5)) {
    const li = document.createElement("li");
    li.className = it.status === "failed" ? "failed" : "";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.title || it.source_url || "链接文章";
    name.title = name.textContent;
    li.appendChild(name);
    if (it.status === "failed" && it.job_id) {
      const a = document.createElement("a");
      a.className = "retry";
      a.textContent = "重试";
      a.dataset.jobId = String(it.job_id);
      li.appendChild(a);
    } else {
      const label = STATUS_LABEL[it.status];
      if (label) {
        const s = document.createElement("span");
        s.className = "tag";
        s.textContent = label;
        li.appendChild(s);
      }
    }
    els.recentList.appendChild(li);
  }
}

async function renderLocalRecent() {
  const { recentIngests: list = [] } = await chrome.storage.local.get("recentIngests");
  els.recent.style.display = list.length ? "block" : "none";
  els.recentList.innerHTML = "";
  for (const it of list.slice(0, 3)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.title || it.url;
    name.title = name.textContent;
    li.appendChild(name);
    els.recentList.appendChild(li);
  }
}

/** 重试一条失败的存入：服务端复用原 payload，不产生第二条。 */
async function doRetry(jobId, el) {
  if (el) el.textContent = "重试中…";
  const r = await chrome.runtime.sendMessage({ type: "retry", jobId: Number(jobId) });
  if (r?.ok) {
    showResult(els.result, "ok", "✓ 已重新存入，AI 正在整理");
  } else if (r?.needLogin) {
    setMode("need_login");
    showResult(els.result2, "info", r.message || "先登录，登录后自动存入");
  } else {
    showResult(els.result, "err", r?.message || "重试没成功，稍后再试");
  }
  await refreshRecent();
}

async function boot() {
  // 打开 popup 即视为看到了反馈，清掉右键菜单留下的 badge
  chrome.action.setBadgeText({ text: "" });

  const state = await authState();
  setMode(state.state);

  // token 过期但 SSO 还活着时页面「看着一直登录着」，别急着判未登录：
  // 让 background 探活走一遍 302 续签链，探完再定论。
  if (state.state === AUTH.NEED_LOGIN) {
    els.statusText.textContent = "检查登录态…";
    const r = await chrome.runtime.sendMessage({ type: "probe-login" }).catch(() => null);
    setMode(r?.ok ? AUTH.READY : AUTH.NEED_LOGIN);
  }

  const ctx = await chrome.runtime.sendMessage({ type: "get-context" });
  if (ctx?.url) els.title.placeholder = ctx.title || "网页标题";
  els.title.value = ctx?.title || "";

  await refreshRecent();
}

async function save() {
  const ctx = await chrome.runtime.sendMessage({ type: "get-context" });
  if (!ctx?.url) {
    showResult(els.result, "err", "读不到当前网页，刷新页面后重试");
    return;
  }
  const tags = els.tags.value
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);

  els.saveBtn.disabled = true;
  showResult(els.result, "info", "正在存入…");
  try {
    const r = await chrome.runtime.sendMessage({
      type: "ingest",
      payload: { url: ctx.url, title: els.title.value.trim() || ctx.title, tags },
    });
    if (r.ok) {
      showResult(els.result, "ok", "✓ 已存入，AI 正在整理");
      els.retryBtn.classList.add("hidden");
      await refreshRecent();
    } else if (r.needLogin) {
      setMode("need_login");
      showResult(els.result2, "info", r.message || "先登录，登录后自动存入");
    } else {
      showResult(els.result, "err", r.message || "没存上，稍后再试");
      // 配额用满 / 内容超长：再点一次还是同一个结果，不给注定失败的按钮
      els.retryBtn.classList.toggle("hidden", r.retryable === false);
    }
  } finally {
    els.saveBtn.disabled = false;
  }
}

// 先启动渲染主干，再挂监听器：任何一个监听器注册出错都不该拖死整个 popup
boot();

els.saveBtn.addEventListener("click", save);

// 提交失败的重试：原样重发一次（表单里的标题/标签还是用户刚填的那份）
els.retryBtn.addEventListener("click", save);

els.recentList.addEventListener("click", (e) => {
  const a = e.target?.closest?.("a.retry");
  if (a) doRetry(a.dataset.jobId, a);
});

els.loginBtn.addEventListener("click", async () => {
  // pending 已在 background 里记着；登录后 cookie 落盘会自动补存
  await chrome.runtime.sendMessage({ type: "open-login", loginUrl: LOGIN_URL });
  window.close();
});

// 登录后自动补存完成 → popup 若还开着，刷新状态
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "ingest-settled") return;
  const r = msg.result ?? {};
  if (r.ok) {
    setMode("ready");
    showResult(els.result, "ok", "✓ 已存入，AI 正在整理");
    refreshRecent();
  } else if (!r.needLogin) {
    showResult(els.result2, "err", r.message || "没存上，稍后再试");
  }
});

els.openHome.addEventListener("click", () => {
  chrome.tabs.create({ url: HOME_URL });
  window.close();
});

els.openOptions.addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    // 个别 Chrome 版本 openOptionsPage 静默失败,直接开 URL 兜底
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") });
  }
  window.close();
});

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
  recent: $("recent"),
  recentList: $("recentList"),
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

async function refreshRecent() {
  const { recentIngests: list = [] } = await chrome.storage.local.get("recentIngests");
  els.recent.style.display = list.length ? "block" : "none";
  els.recentList.innerHTML = "";
  for (const it of list.slice(0, 3)) {
    const li = document.createElement("li");
    li.textContent = it.title || it.url;
    li.title = it.title || it.url;
    els.recentList.appendChild(li);
  }
}

async function boot() {
  // 打开 popup 即视为看到了反馈，清掉右键菜单留下的 badge
  chrome.action.setBadgeText({ text: "" });

  const state = await authState();
  setMode(state.state);

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
      await refreshRecent();
    } else if (r.needLogin) {
      setMode("need_login");
      showResult(els.result2, "info", r.message || "先登录，登录后自动存入");
    } else {
      showResult(els.result, "err", r.message || "没存上，稍后再试");
    }
  } finally {
    els.saveBtn.disabled = false;
  }
}

els.saveBtn.addEventListener("click", save);

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

boot();

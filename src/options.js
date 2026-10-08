// options：API Key 兜底配置。绝大多数用户永远不会打开这个页面。

import { resolveCredential } from "./lib/auth.js";
import { checkCredential } from "./lib/api.js";

const $ = (id) => document.getElementById(id);
const msg = $("msg");

async function boot() {
  const { apiKey = "" } = await chrome.storage.sync.get("apiKey");
  $("apiKey").value = apiKey;
}

$("save").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (key && !key.startsWith("sk_")) {
    msg.className = "err";
    msg.textContent = "密钥以 sk_ 开头，检查一下是不是复制全了";
    return;
  }
  await chrome.storage.sync.set({ apiKey: key });
  msg.className = "ok";
  msg.textContent = key ? "已保存" : "已清除（将使用浏览器登录状态）";
});

$("test").addEventListener("click", async () => {
  msg.className = "";
  msg.textContent = "测试中…";
  await chrome.storage.sync.set({ apiKey: $("apiKey").value.trim() });
  try {
    const cred = await resolveCredential();
    if (!cred) {
      msg.className = "err";
      msg.textContent = "还没登录，也没有密钥——先去 youhuale.cn 登录一次";
      return;
    }
    await checkCredential(cred);
    msg.className = "ok";
    msg.textContent =
      cred.kind === "session" ? "✓ 通了（用的浏览器登录状态）" : "✓ 通了（用的密钥）";
  } catch (e) {
    msg.className = "err";
    msg.textContent = e.message || "没连通";
  }
});

boot();

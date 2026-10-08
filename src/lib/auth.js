// 凭证链：能自动的绝不麻烦用户。
//
//   1. 会话 cookie（首选）——用户在 youhuale.cn 登录过就有，零配置；
//   2. API Key（兜底）——options 页手工填，给「从不在浏览器登录」的用户；
//   3. 都没有 → 返回 null，上层引导去登录。
//
// 用户全程不需要知道「cookie / JWT / API Key」任何一个词。

import { COOKIE_URL, SESSION_COOKIE } from "./config.js";

export const AUTH = {
  READY: "ready",
  NEED_LOGIN: "need_login",
};

/** 返回 {kind, headers} 或 null。cookie 优先于 API Key。 */
export async function resolveCredential() {
  const session = await readSessionToken();
  if (session) {
    return { kind: "session", headers: { Authorization: `Bearer ${session}` } };
  }
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (apiKey) {
    return { kind: "apikey", headers: { "X-API-Key": apiKey } };
  }
  return null;
}

async function readSessionToken() {
  try {
    const c = await chrome.cookies.get({ url: COOKIE_URL, name: SESSION_COOKIE });
    if (!c || !c.value) return null;
    // max_age=86400 的持久 cookie；expirationDate 已过视为未登录
    if (c.expirationDate && c.expirationDate * 1000 <= Date.now()) return null;
    return c.value;
  } catch {
    // host_permissions 未覆盖 / 权限被用户收回
    return null;
  }
}

/** popup 顶部状态。 */
export async function authState() {
  const cred = await resolveCredential();
  if (!cred) return { state: AUTH.NEED_LOGIN };
  return { state: AUTH.READY, kind: cred.kind };
}

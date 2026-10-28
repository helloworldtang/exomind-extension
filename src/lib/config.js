// 全局常量。v1 只支持官方服务（个人自部署，无多实例需求）——
// 少一个「服务器地址」概念，用户就少一个要理解的东西。
//
// 双域说明（v0.4.0 起）：
//   - API 走 exomind-api.ai-as.cn（专用 API 域）；
//   - 登录/首页/cookie 留在 exomind.ai-as.cn——OIDC 回调固定注册在
//     exomind.ai-as.cn/auth/callback，且服务端 token cookie 是 host-only
//     （query.py set_cookie 无 domain=），登录后 cookie 只落在这个域，
//     exomind-api 上永远没有。切域时两处要一起看，不能只改一边。
export const API_BASE = "https://exomind-api.ai-as.cn";
export const WEB_BASE = "https://exomind.ai-as.cn";

// 会话 cookie：HttpOnly + Secure + SameSite=Lax + 24h（query.py:2177）。
// 网页 JS 读不到，但 chrome.cookies 是扩展特权，可以读。
export const COOKIE_URL = `${WEB_BASE}/`;
export const SESSION_COOKIE = "token";

// 透传给服务端 ingest_log.source 的来源标记（≤32 字符，小写字母/数字/-/_/:）。
export const ORIGIN_TAG = "web-clipper";

// 未登录时打开的页面：首页未登录会被中间件 302 到 /auth/authorize，
// 若 auth.ai-as.cc 的 SSO 会话还在，整条链路无感完成。
export const LOGIN_URL = `${WEB_BASE}/`;

// 「我的知识飞轮」入口
export const HOME_URL = `${WEB_BASE}/ui/home`;

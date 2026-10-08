// 全局常量。v1 只支持 youhuale.cn（个人自部署服务，无多实例需求）——
// 少一个「服务器地址」概念，用户就少一个要理解的东西。
export const BASE_URL = "https://youhuale.cn";

// 会话 cookie：HttpOnly + Secure + SameSite=Lax + 24h（query.py:2177）。
// 网页 JS 读不到，但 chrome.cookies 是扩展特权，可以读。
export const COOKIE_URL = `${BASE_URL}/`;
export const SESSION_COOKIE = "token";

// 透传给服务端 ingest_log.source 的来源标记（≤32 字符，小写字母/数字/-/_/:）。
export const ORIGIN_TAG = "web-clipper";

// 未登录时打开的页面：首页未登录会被中间件 302 到 /auth/authorize，
// 若 auth.ai-as.cc 的 SSO 会话还在，整条链路无感完成。
export const LOGIN_URL = `${BASE_URL}/`;

// 「我的知识飞轮」入口
export const HOME_URL = `${BASE_URL}/ui/home`;

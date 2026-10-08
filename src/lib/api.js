// REST 客户端。端点契约见 myExoMindManager/src/exo/api/query.py。
// 错误一律转成人话——用户不该看到 HTTP 状态码或 JSON。

import { BASE_URL, ORIGIN_TAG } from "./config.js";

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** 把服务端错误翻译成用户能懂的一句话。 */
function humanize(status, text) {
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.detail ?? text;
  } catch {
    /* 纯文本响应 */
  }
  switch (status) {
    case 401:
    case 403:
      return new ApiError("登录已过期，重新登录就好", status, detail);
    case 422:
      return new ApiError("内容太长，超出了单次存入上限", status, detail);
    case 429:
      return new ApiError("今天存满了，明天再来", status, detail);
    case 502:
      return new ApiError("这个网页暂时抓不到内容，稍后再试", status, detail);
    case 503:
      return new ApiError("服务正忙，稍等一下再试", status, detail);
    default:
      return new ApiError("没存上，稍后再试", status, detail);
  }
}

async function request(path, { method = "GET", body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError("连不上知识飞轮，检查网络后再试", 0, String(e));
  }
  if (!res.ok) throw humanize(res.status, await safeText(res));
  return res.json();
}

/**
 * 异步存入一个网页。服务端自己抓正文（trafilatura），失败自动重试 6 次。
 * 返回 {job_id, status, poll}。
 */
export function ingestAsync({ url, title, tags }, cred) {
  return request("/ingest/async", {
    method: "POST",
    headers: cred.headers,
    body: {
      url,
      title: title || undefined,
      tags: tags && tags.length ? tags : undefined,
      origin: ORIGIN_TAG,
    },
  });
}

/** 连通性自检（options 页用）：任意受保护端点，200 即凭证有效。 */
export function checkCredential(cred) {
  return request("/keywords", { headers: cred.headers });
}

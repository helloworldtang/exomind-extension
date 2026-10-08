# myExoMindExtension — 浏览器剪藏插件

> 目录约定：**ExoMind 浏览器插件相关的所有内容都放这里**（Chrome MV3 扩展本体、设计文档、上架物料）。
> 服务端在 `myExoMindManager/`，CLI 在 `cli/`，小程序在 `myExoMindMiniApp/`。

---

## 一、需求理解

用户在浏览网页时看到好内容，想一键存进知识飞轮，不想切窗口、不想复制粘贴、不想再登一次录。

- **触发场景**：任意网页 → 点插件图标 / 快捷键 / 右键 → 当前页入飞轮。
- **隐含诉求**：① 免手工搬运正文；② 不用重新登录；③ 存完立刻有反馈，不打断阅读流。

## 二、现状盘点：后端已经全就绪

| 能力 | 现状 | 证据 |
|---|---|---|
| URL → 正文抓取 | ✅ 已有，trafilatura → Markdown，含公众号专用解析器 + SSRF 防护 | `src/exo/crawler/router.py:53` `fetch_url` |
| 异步摄入接口 | ✅ `POST /ingest/async` → 秒回 `job_id`，worker 后台跑 LLM 抽取，失败退避重试 6 次 | `query.py:3348` |
| 状态查询 | ✅ `GET /ingest/status?job_id=` | `query.py:3470` |
| 来源留痕 | ✅ frontmatter `source_url` / `final_url`，落 `raw/articles/` | `wiki/ingest.py:301,317` |
| CORS | ✅ `allow_origins=["*"]` + `allow_credentials=True`，任意来源带自定义头可过 | `query.py:648-654` |
| 已有先例 | ✅ 书签小工具（bookmarklet）「存到 ExoMind」 | `query.py:11949` |

**结论：后端零改动即可支撑插件 MVP。** 这是本需求最大的价值前提——投入全在前端，一个 MV3 扩展就能闭环。

### 现有 bookmarklet 的两个硬伤（正是插件要补的）

1. **拿不到正文**：未选中文字时只存 `来自: URL + 标题`，用户必须先全选再点。
2. **GET query 传内容**：`window.open` + URL 参数有长度天花板，正文稍长就废；且每次弹新 tab，打断开阅读流。

## 三、鉴权设计（已拍板）：分级降级，用户知道得越少越好

核心原则：**能自动的绝不麻烦用户，配置只在必要时才出现。**

| 层级 | 凭证 | 用户感知 |
|---|---|---|
| 1（默认） | `chrome.cookies` 读取 youhuale.cn 的 `token` cookie（HttpOnly，扩展特权可读），以 `Authorization: Bearer` 发送 | 装完即用，零配置 |
| 2（过期/未登录） | 引导一键打开 youhuale.cn → 中间件 302 到登录 → auth.ai-as.cc SSO 会话若在则无感回跳 | 点一下「去登录」，多为秒过 |
| 3（兜底） | options 页粘贴 API Key（`/ui/account` 生成），`X-API-Key` 发送 | 只给「从不在浏览器登录」的用户，藏在设置里 |

**关键体验设计：登录后自动补存。** 未登录时点了存，插件记下 pending；用户完成登录、
cookie 落盘的瞬间（`chrome.cookies.onChanged`），自动把刚才那篇存进去——
不需要「存 → 登录 → 回来再点一次」。cookie 24h 过期造成的周期性摩擦被压到最低。

> 技术依据：网页 JS 读不到 HttpOnly cookie，但 `chrome.cookies` API 是扩展特权，
> 可以读（Cookie 对象自带 `httpOnly` 字段）；需要 `cookies` 权限 + `host_permissions`。

## 四、MVP 范围（less is more）

**做**
- popup 一键存当前页：`{url, title, tags?, client_content?}` → `POST /ingest/async`（服务端自己抓正文）
- 登录态 SPA 兜底：豆包对话/知乎登录墙类页面服务端只抓得到标题，插件随请求带页面可见文本（activeTab 取 `innerText`，截 3 万字），**服务端抓空时才启用**（trafilatura 质量优先）；提取两级去噪——**划词优先**（选中 ≥50 字即只存选中内容，聊天气泡场景零噪音）+ 语义去噪（读前临时隐藏 nav/aside/header/footer，单换行转段落换行防 markdown 黏连）
- 存完即时反馈：「已存入，AI 正在整理」+ 最近存入列表（有确定性）
- 状态指示：● 已就绪 / ● 未登录，不出现 cookie/token/密钥等词
- 未登录引导 + 登录后自动补存（见上）
- 右键菜单「把这个网页存进知识飞轮」，成败用 badge（✓ / ? / !）反馈
- options：API Key 兜底 + 连通性测试（一般不用打开）

**不做（v1 砍掉）**
- 本地抽正文作主链路 / 划词剪藏（服务端 trafilatura 更强；本地文本只作抓空时的兜底，见上；URL 模式不受 30000 字符限制）
- 剪藏列表管理视图（`/ui/browser?dir=raw` 已能看）
- 智能标签推荐、批量导入、Firefox/Safari 版、可配服务器地址（v1 固定 youhuale.cn）

## 五、风险与阻塞项

| 风险 | 说明 | 应对 |
|---|---|---|
| 上架成本 | Chrome 商店需 $5 开发者费 + 审核（1-3 天） | v1 走「开发者模式加载已解压扩展」，零成本自用；验证价值后再上架 |
| 日配额 | 默认每日 50 次摄入 | 插件捕获 429 `daily_quota`，提示「今日配额用尽」而非静默失败 |
| 服务端抓取失败 | 反爬站点（知乎/公众号部分页）会 `blocked` | url job 已有 6 次退避重试；插件显示失败并给「重试」入口（`/ingest/retry` 已存在） |
| 权限面 | 只用 `activeTab` + `storage` + `host_permissions(youhuale.cn)`，不申请 `cookies` / `<all_urls>` | 商店审核友好，也降低用户心理负担 |
| 2C2G 服务端压力 | 剪藏高频会挤占队列 | v1 只做单页存入，不做批量 |

## 六、状态

- [x] 需求评审 + 鉴权方案拍板（cookie 优先 → 登录引导 → API Key 兜底）
- [x] MVP 实现（见下方目录结构与安装）
- [ ] 真机验收（加载扩展 → 保存一篇 → 到 /ui/browser 确认）
- [ ] 上架评估（v1 先开发者模式自用）

## 七、安装与验收（Chrome）

1. 打开 `chrome://extensions/` → 右上角开「开发者模式」
2. 「加载已解压的扩展程序」→ 选本目录（`exomind-extension/`）
3. 验收清单：
   - [ ] 已在浏览器登录过 youhuale.cn → popup 显示「● 已就绪」→ 点「存入知识飞轮」→ 绿色「已存入」
   - [ ] 到 `youhuale.cn/ui/browser?dir=raw` 看到刚存的 `raw/articles/` 页面，frontmatter 带 `source_url`
   - [ ] 未登录（或清 cookie）→ popup 变「● 未登录」→ 点「去登录」→ 登录完成 → 那篇自动存入
   - [ ] 网页上右键 →「把这个网页存进知识飞轮」→ 图标出现 ✓（失败为 !）
   - [ ] options「测试连通」显示 ✓

## 八、目录结构

```
myExoMindExtension/
├── manifest.json          # MV3，权限：cookies/storage/contextMenus/activeTab + youhuale.cn
├── src/
│   ├── background.js      # service worker：右键菜单、发请求、登录后自动补存、badge
│   ├── popup.html/js      # 一键存入 UI（状态、标题、标签、反馈、最近存入）
│   ├── options.html/js    # API Key 兜底 + 连通测试
│   └── lib/
│       ├── config.js      # 常量（BASE_URL、cookie 名、来源标记）
│       ├── auth.js        # 凭证链：cookie → API Key → null
│       └── api.js         # /ingest/async 客户端 + 错误人话化
├── tools/make_icons.py    # 图标生成（PIL，纯几何，无字体依赖）
└── icons/                 # 16/32/48/128
```

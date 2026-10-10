# exomind-extension — 浏览器剪藏插件

> 目录约定：**ExoMind 浏览器插件相关的所有内容都放这里**（Chrome MV3 扩展本体、设计文档、上架物料）。
> 服务端在 `myExoMindManager/`，CLI 在 `cli/`，小程序在 `myExoMindMiniApp/`。
> 远端：`git@github.com:helloworldtang/exomind-extension.git`

---

## 〇、当前状态（2026-10-09 核查）

**需求已实现并上线。** 插件 v0.3.0（已推送 GitHub），服务端配套已部署到 ECS 并运行。

| 环节 | 状态 | 证据 |
|---|---|---|
| 插件 | ✅ v0.3.0，工作区干净，已推 origin/main | `git log`（未推送 commit 数 = 0） |
| 服务端配套 | ✅ `client_content` 字段 + 空正文守卫 + 兜底 LLM 标题 | ECS `query.py:1491/3414`、`queue.py:688`，代码落盘 10-08 21:11/21:19 |
| 服务运行 | ✅ `systemctl is-active exomind` = active | workbench exec |
| 真机验收 | ✅ 已跑过（豆包对话登录态页踩坑 → 迭代 v0.2.0~v0.3.0） | commit 5925523 / 34b2ecd / d0e6180 |
| 上架 | ⬜ 未做（开发者模式自用） | 需 $5 + 审核 |

## 一、需求理解

用户在浏览网页时看到好内容，想一键存进知识飞轮，不想切窗口、不想复制粘贴、不想再登一次录。

- **触发场景**：任意网页 → 点插件图标 / 右键 → 当前页入飞轮。
- **隐含诉求**：① 免手工搬运正文；② 不用重新登录；③ 存完立刻有反馈，不打断阅读流。

## 二、服务端配套（v0.1.0 时判断「后端零改动」，实际改了一次）

原判「后端零改动即可支撑 MVP」在**登录态 SPA** 上被证伪：服务端抓取拿不到需登录页面的正文，
只拿到标题一行，旧链路照样跑 LLM 管道、落一行标题的 raw 还报成功——假成功比失败更糟。
因此加了两个服务端改动（均已上线）：

| 改动 | 内容 | 位置 |
|---|---|---|
| `client_content` 字段 | url 模式下的备胎正文，服务端抓空（有效正文 <50 字）时才启用 | `query.py:1491`，`queue.py:688` |
| 兜底 LLM 标题 | `client_fallback` 路径下由模型按正文起 ≤20 字标题，避免 N 篇对话 N 个同名壳标题 | `queue.py:698-720` |

> 抓正常的页面仍走 trafilatura（质量优先），不进兜底路径。

## 三、鉴权设计（已拍板）：分级降级，用户知道得越少越好

核心原则：**能自动的绝不麻烦用户，配置只在必要时才出现。**

| 层级 | 凭证 | 用户感知 |
|---|---|---|
| 1（默认） | `chrome.cookies` 读取 youhuale.cn 的 `token` cookie（HttpOnly，扩展特权可读），以 `Authorization: Bearer` 发送 | 装完即用，零配置 |
| 2（过期/未登录） | 引导一键打开 youhuale.cn → 中间件 302 到登录 → auth.ai-as.cc SSO 会话若在则无感回跳 | 点一下「去登录」，多为秒过 |
| 3（兜底） | options 页粘贴 API Key（`/ui/account` 生成），`X-API-Key` 发送 | 只给「从不在浏览器登录」的用户，藏在设置里 |

**关键体验设计：登录后自动补存。** 未登录时点了存，插件记下 pending（含页面正文快照）；
用户完成登录、cookie 落盘的瞬间（`chrome.cookies.onChanged`），自动把刚才那篇存进去——
不需要「存 → 登录 → 回来再点一次」。cookie 24h 过期造成的周期性摩擦被压到最低。

> 技术依据：网页 JS 读不到 HttpOnly cookie，但 `chrome.cookies` API 是扩展特权，
> 可以读（Cookie 对象自带 `httpOnly` 字段）；需要 `cookies` 权限 + `host_permissions`。

## 四、实现范围

**做**
- popup 一键存当前页：`{url, title, tags?, client_content?}` → `POST /ingest/async`
- 登录态 SPA 兜底正文 + **站点策略层**（`src/lib/extract.js`，与服务端 crawler/parsers 同构：站点精确命中 → generic 兜底）：
  - **doubao 策略**（DOM 依据 2026-10-09 实测探测）：标题 = tab title 剥「 - 豆包」后缀（会话级标题）；正文取 `<main>`（侧栏是独立 `<nav>`）；剥免责声明「AI 生成可能有误/请核实」、建议卡片「生成研究报告:…」、消息间时间戳
  - **generic 兜底**：划词优先（选中 ≥50 字即只存选中内容）+ 主内容容器优先（`main/[role=main]/article`）+ 语义去噪（读 `innerText` 前临时隐藏 `nav/aside/header/footer/textarea`）+ 控件词行过滤（孤立成行的「运行/表格/复制」等）+ 尾部短行修剪（剥掉输入框工具条按钮串）+ 单换行转段落换行
  - 划词优先对所有站点生效；策略拿到的标题仅在用户没改过 popup 预填标题时替换
- 存完即时反馈：「已存入，AI 正在整理」+ 最近存入列表
- 状态指示：● 已就绪 / ● 未登录，界面不出现 cookie/token/密钥等词
- 未登录引导 + 登录后自动补存
- 右键菜单「把这个网页存进知识飞轮」，成败用 badge（✓ / ? / !）反馈
- options：API Key 兜底 + 连通性测试

**不做**
- 本地抽正文作主链路（服务端 trafilatura 更强；本地文本只作抓空时的兜底）
- 剪藏列表管理视图（`/ui/browser?dir=raw` 已能看）
- 智能标签推荐、批量导入、Firefox/Safari 版、可配服务器地址（固定 youhuale.cn）

## 五、权限面与风险

manifest 实际声明：`cookies` / `storage` / `contextMenus` / `activeTab` / `scripting` + `host_permissions: youhuale.cn`。
其中 `cookies` 是层级 1 的前提，`scripting` 是取页面可见文本的前提，两者都**只在 youhuale.cn 与当前活动页**范围内使用，未申请 `<all_urls>`。

| 风险 | 说明 | 应对 |
|---|---|---|
| 上架成本 | Chrome 商店需 $5 开发者费 + 审核 | v1 走「开发者模式加载已解压扩展」自用；验证价值后再上架 |
| 日配额 | 默认每日 50 次摄入 | 插件捕获 429，提示「今天存满了，明天再来」而非静默失败 |
| 服务端抓取失败 | 反爬站点会 `blocked` | url job 6 次退避重试；**插件侧重试入口尚未接**（见待决项 ②） |
| 2C2G 服务端压力 | 剪藏高频挤占队列 | 只做单页存入，不做批量 |

## 六、待决项

### ① 用户标题被 LLM 起标题覆盖 —— ✅ v0.3.0 已收口

修法比「title_edited 标记」更省一层协议：**插件侧自知用户是否改过标题**（传入 title ≠ tab 原始标题即手改），只在没有手改时才用策略标题（豆包会话标题）替换；服务端 `client_fallback` 路径的优先级同步调整为 `payload.title > LLM 起标题 > fr.title`——插件传来的 title 已是「用户手改 or 会话标题」，都是明确意图，LLM 退居「插件没给标题」的兜底。

### ② 失败后没有「重试」入口

服务端 `POST /ingest/retry?job_id=` 已存在（小程序在用），插件侧未接。
当前失败只给一句话提示，用户要重存得自己再点一次（会重复入队而不是重试原 job）。

## 七、安装与验收（Chrome）

1. 打开 `chrome://extensions/` → 右上角开「开发者模式」
2. 「加载已解压的扩展程序」→ 选本目录（`exomind-extension/`）
3. 验收清单：
   - [x] 已在浏览器登录过 youhuale.cn → popup 显示「● 已就绪」→ 点「存入知识飞轮」→ 绿色「已存入」
   - [x] 到 `youhuale.cn/ui/browser?dir=raw` 看到 `raw/articles/` 页面，frontmatter 带 `source_url`
   - [x] 未登录（或清 cookie）→ popup 变「● 未登录」→ 点「去登录」→ 登录完成 → 那篇自动存入
   - [x] 右键 →「把这个网页存进知识飞轮」→ 图标出现 ✓（失败为 !）
   - [x] options「测试连通」显示 ✓
   - [x] 登录态 SPA（豆包对话页）→ 服务端抓空时启用页面可见文本兜底

## 八、目录结构

```
exomind-extension/
├── manifest.json          # MV3 v0.3.0
├── src/
│   ├── background.js      # service worker：右键菜单、发请求、登录补存、badge、页面正文兜底
│   ├── popup.html/js      # 一键存入 UI（状态、标题、标签、反馈、最近存入）
│   ├── options.html/js    # API Key 兜底 + 连通测试
│   └── lib/
│       ├── config.js      # 常量（BASE_URL、cookie 名、来源标记）
│       ├── auth.js        # 凭证链：cookie → API Key → null
│       ├── extract.js     # 页面正文提取：站点策略（doubao）→ generic 兜底
│       └── api.js         # /ingest/async 客户端 + 错误人话化
├── tools/make_icons.py    # 图标生成（PIL，纯几何，无字体依赖）
├── icons/                 # 16/32/48/128
└── LICENSE                # MIT
```

## 九、版本记录

| 版本 | 内容 |
|---|---|
| v0.1.0 | MVP：cookie 优先凭证链、一键存入、登录引导 + 自动补存、右键菜单、API Key 兜底 |
| v0.2.0 | 登录态 SPA 兜底：服务端抓空时用页面可见文本存入 |
| v0.2.1 | 兜底正文两级去噪：划词优先 + 语义隐藏 |
| v0.2.2 | 去噪第三级：尾部短行修剪，剥输入框工具条 |
| v0.3.0 | 站点策略层：doubao 策略（会话标题 + main 容器 + 豆包噪音词过滤）→ generic 兜底（main 容器优先 + 控件词行过滤）；收口待决项①（用户/会话标题优先于 LLM 起标题） |

// 页面正文提取器：在页面上下文里执行（chrome.scripting.executeScript 的 func）。
// ⚠️ func 会被序列化后注入页面——函数体必须自包含，不能引用任何外部绑定，
// 策略表因此内联在本函数内。
//
// 架构与服务端 crawler/parsers 同构（WeixinParser 精确命中 → GenericParser 兜底）：
// 站点策略按 hostname 分发，generic 恒兜底。区别在于登录态 SPA 的 DOM 只存在于
// 用户浏览器里，站点策略只能建在插件侧。站点策略的 DOM 依据见 README。

export function pageExtractor() {
  // 语义噪音：读 innerText 前临时隐藏，读完恢复。不能用 cloneNode——脱离文档
  // 的节点 innerText 退化为 textContent，换行全丢。
  const NOISE = "nav,aside,header,footer,[aria-hidden='true'],textarea,[contenteditable='true']";
  // 控件词：孤立成行的按钮/标签文本（豆包「运行」「表格」，通用「复制」「分享」）
  const CONTROL_LINE = /^(运行|表格|复制|复制代码|分享|重新生成|继续生成|点赞|点踩|朗读|编辑|\w+\s*运行)$/;

  function readText(root) {
    const saved = [];
    root.querySelectorAll(NOISE).forEach((el) => {
      saved.push([el, el.style.display]);
      el.style.display = "none";
    });
    const text = root.innerText ?? "";
    saved.forEach(([el, display]) => (el.style.display = display));
    return text;
  }

  function cleanLines(text, drop = []) {
    const out = text
      .split("\n")
      .filter((l) => !CONTROL_LINE.test(l.trim()) && !drop.some((re) => re.test(l.trim())));
    // 尾部修剪：聊天输入框工具条（「对话/图像生成/更多」）不是语义标签，DOM 层
    // 剥不掉；按钮标签的文本特征是成串短行——从末尾往前删 ≤12 字短行直到实质内容
    while (out.length) {
      const last = out[out.length - 1].trim();
      if (!last || last.length <= 12) out.pop();
      else break;
    }
    // innerText 单换行在 markdown 渲染里黏连成一句，转段落换行
    return out.join("\n").replace(/\n(?!\n)/g, "\n\n");
  }

  // ---- 豆包策略（DOM 依据 2026-10-09 实测探测）----
  // - document.title =「<会话标题> - 豆包」，会话级标题，剥品牌后缀即用
  // - 对话区在 <main>；侧栏是独立 <nav data-testid=chat_route_layout_leftside_nav>
  // - 免责声明「AI 生成可能有误 / 请核实」固定在正文前；建议卡片「生成研究报告:…」；
  //   消息间时间戳「今天 14:47」
  function doubao() {
    const title = document.title.replace(/\s*[-–—]\s*豆包\s*$/, "").trim();
    const container = document.querySelector("main") ?? document.body;
    const text = cleanLines(readText(container), [
      /^AI ?生成可能有误$/,
      /^请核实$/,
      /^生成研究报告[:：]/,
      /^(今天|昨天)\s*\d{1,2}:\d{2}$/,
      /^\d{1,2}:\d{2}$/,
    ]);
    return { title, text };
  }

  function generic() {
    // 主内容容器优先：语义化 main/article 天然排除侧栏（豆包侧栏即 <nav>）
    const container =
      document.querySelector("main, [role='main'], article") ?? document.body;
    return { title: "", text: cleanLines(readText(container)) };
  }

  // 划词优先（所有站点）：选中即意图——聊天气泡/长文精准截取，天然零噪音
  const host = location.hostname;
  const sel = String(window.getSelection?.() ?? "").trim();
  if (sel.length >= 50) {
    const titled = /(^|\.)doubao\.com$/.test(host)
      ? document.title.replace(/\s*[-–—]\s*豆包\s*$/, "").trim()
      : "";
    return { title: titled, text: sel };
  }

  const STRATEGIES = [{ host: /(^|\.)doubao\.com$/, run: doubao }];
  for (const s of STRATEGIES) if (s.host.test(host)) return s.run();
  return generic();
}

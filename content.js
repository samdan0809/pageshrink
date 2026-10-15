/**
 * PageShrink v2 - content script
 *
 * 这个脚本只负责遮罩，不再碰页面布局（窗口尺寸由 background 用 chrome.windows 控制）。
 *
 *  - background 把标签页搬进无边框小窗后发 pw:enter，进入「遮罩模式」。
 *  - 鼠标离开窗口（mouseleave / blur）-> 用一张图（白色或自定义图片）盖住整个网页。
 *  - 鼠标回到窗口（mouseenter / focus）-> 遮罩淡出，网页恢复可见可操作。
 *  - 小窗没有地址栏也没有工具栏，所以还原入口是页面右上角的浮动「还原」按钮。
 *
 * 遮罩用 <canvas> 绘制而不是 CSS background-image：很多站点的 CSP 里有严格的 img-src，
 * 会把扩展注入样式里的 url(data:...) 拦掉，表现为“设置没生效”。canvas 不受 img-src 约束。
 */

(() => {
  'use strict';

  // 扩展重载后页面上会留下 chrome.* 句柄失效的孤儿实例，先让它自毁再重新初始化
  if (typeof window.__pwDestroy === 'function') {
    try { window.__pwDestroy(); } catch (e) { /* ignore */ }
  }

  const STORE_KEY = 'pw.config';
  const Z_MASK = 2147483646;
  const Z_BAR = 2147483647;

  const DEFAULTS = {
    style: 'color',        // color | image
    color: '#ffffff',
    image: '',             // dataURL
    fill: 'cover',         // cover | contain | stretch | repeat | center
    opacity: 1,
    blur: 0,               // 遮罩背后的毛玻璃
    fade: 80,
    delay: 60,            // 鼠标离开多久后盖上遮罩（由 CSS transition-delay 实现）
    showHint: true,
    hint: '移回鼠标继续浏览',
    showBar: true,
    title: '文档',           // 小窗期间替换掉浏览器标题；留空 = 不改
  };

  let cfg = Object.assign({}, DEFAULTS);
  let mode = false;        // 是否处于小窗遮罩模式
  let covered = false;     // 遮罩当前是否盖上
  let host = null, shadow = null, wrap = null, canvas = null, hintEl = null, barEl = null;

  let bitmap = null, bitmapSrc = '', bitmapToken = 0;
  let sizeTimer = 0;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  // ---------------------------------------------------------------- 样式
  // 关键：盖上遮罩的「延时」交给 CSS transition-delay，不用 setTimeout。
  // 两个原因：(1) 窗口失焦时 Chrome 会节流渲染器定时器，setTimeout(250) 实测能拖到 780ms；
  // (2) 页面主线程忙时 JS 定时器会被推迟，而 transition 由合成器驱动，不受主线程影响。
  // 注意用 longhand 写：var() 放进 transition 简写里，一旦变量值不合法整条声明会失效。
  const SHADOW_CSS = `
    .mask {
      position: fixed; inset: 0; display: block; pointer-events: auto;
      transition-property: opacity;
      transition-duration: var(--pw-fade, 90ms);
      transition-timing-function: ease;
      transition-delay: var(--pw-delay, 0ms);
    }
    .mask.off { opacity: 0; pointer-events: none; transition-delay: 0s; }
    .mask.now { transition-delay: 0s; }
    .hint {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      font: 500 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #6b7280; background: rgba(255,255,255,.72);
      border: 1px solid rgba(0,0,0,.08); border-radius: 999px;
      padding: 6px 14px; white-space: nowrap; pointer-events: none;
      max-width: 86%; overflow: hidden; text-overflow: ellipsis;
    }
    .hint.off { display: none; }
    .bar {
      position: fixed; top: 8px; right: 8px; z-index: 2;
      display: flex; align-items: center; gap: 3px;
      padding: 4px 5px;
      background: rgba(26,28,32,.86);
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0,0,0,.3);
      color: #e8eaed; user-select: none;
      font: 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      transition-property: opacity;
      transition-duration: var(--pw-fade, 90ms);
      transition-timing-function: ease;
      transition-delay: var(--pw-delay, 0ms);
      /* shadow host 上是 pointer-events:none，这个值会继承进 shadow 树，必须显式打开 */
      pointer-events: auto;
    }
    .bar.off { opacity: 0; pointer-events: none; transition-delay: 0s; }
    .bar.now { transition-delay: 0s; }
    .bar button {
      all: unset; cursor: pointer; height: 22px; padding: 0 9px;
      display: grid; place-items: center; border-radius: 999px;
      color: #e8eaed; font-size: 12px; line-height: 1; white-space: nowrap;
    }
    .bar button.icon { width: 22px; padding: 0; font-size: 13px; }
    .bar button:hover { background: rgba(255,255,255,.18); }
    .bar button.restore { background: rgba(47,107,255,.9); font-weight: 600; }
    .bar button.restore:hover { background: #2f6bff; }
  `;

  // ---------------------------------------------------------------- DOM
  function ensureNodes() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = '__pw_host__';
    host.style.cssText = 'position:fixed;inset:0;z-index:' + Z_MASK + ';pointer-events:none;margin:0;padding:0;border:0;background:transparent;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    wrap = document.createElement('div');
    wrap.className = 'mask off';
    canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    hintEl = document.createElement('div');
    hintEl.className = 'hint';
    hintEl.textContent = cfg.hint;
    wrap.appendChild(hintEl);
    shadow.appendChild(wrap);

    barEl = document.createElement('div');
    barEl.className = 'bar off';
    barEl.innerHTML =
      '<button class="restore" data-a="restore" title="把页面放回原窗口">还原</button>' +
      '<button class="icon" data-a="opts" title="遮罩设置">⚙</button>';
    barEl.style.zIndex = String(Z_BAR);
    shadow.appendChild(barEl);

    barEl.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      e.stopPropagation();
      const a = btn.getAttribute('data-a');
      if (a === 'restore') {
        try { chrome.runtime.sendMessage({ type: 'pw:request-restore' }); } catch (err) { /* ignore */ }
      } else if (a === 'opts') {
        try { chrome.runtime.openOptionsPage(); } catch (err) { /* ignore */ }
      }
    });

    document.documentElement.appendChild(host);
  }

  // ---------------------------------------------------------------- 遮罩绘制
  function dataUrlToBlob(url) {
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    const meta = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    const m = /^data:([^;,]*)/i.exec(meta);
    const mime = (m && m[1]) || 'image/png';
    try {
      let bytes;
      if (/base64/i.test(meta)) {
        const bin = atob(payload.replace(/\s+/g, ''));
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      }
      return new Blob([bytes], { type: mime });
    } catch (e) {
      return null;
    }
  }

  async function loadBitmap() {
    const token = ++bitmapToken;
    if (cfg.style !== 'image' || !cfg.image) {
      bitmap = null; bitmapSrc = ''; draw(); return;
    }
    if (bitmap && bitmapSrc === cfg.image) { draw(); return; }
    bitmap = null; bitmapSrc = '';

    let img = null;
    const blob = dataUrlToBlob(cfg.image);
    if (blob && typeof createImageBitmap === 'function') {
      try { img = await createImageBitmap(blob); } catch (e) { img = null; }
    }
    if (!img) {
      img = await new Promise((resolve) => {
        const el = new Image();
        const done = (v) => { clearTimeout(t); resolve(v); };
        const t = setTimeout(() => done(null), 5000);
        el.onload = () => done(el);
        el.onerror = () => done(null);
        el.src = cfg.image;
      });
    }
    if (token !== bitmapToken) return;
    if (img) { bitmap = img; bitmapSrc = cfg.image; }
    draw();
  }

  function draw() {
    if (!canvas) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const W = Math.max(1, window.innerWidth);
    const H = Math.max(1, window.innerHeight);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cfg.color || '#ffffff';
    ctx.fillRect(0, 0, W, H);

    if (cfg.style !== 'image' || !bitmap) return;
    const iw = bitmap.width || 0;
    const ih = bitmap.height || 0;
    if (iw <= 0 || ih <= 0) return;

    ctx.save();
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* ignore */ }
    const fill = cfg.fill || 'cover';
    if (fill === 'repeat') {
      let pat = null;
      try { pat = ctx.createPattern(bitmap, 'repeat'); } catch (e) { pat = null; }
      if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); }
    } else if (fill === 'stretch') {
      ctx.drawImage(bitmap, 0, 0, W, H);
    } else if (fill === 'center') {
      ctx.drawImage(bitmap, (W - iw) / 2, (H - ih) / 2, iw, ih);
    } else {
      const k = fill === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
      const dw = iw * k, dh = ih * k;
      ctx.drawImage(bitmap, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 标题栏
  // popup 小窗的标题栏显示的就是 document.title，所以改标题要在内容脚本里做。
  // 难点：SPA 会自己改 document.title（路由切换、倒计时、未读数），会把我们的改掉。
  // 用 MutationObserver 盯着：发现标题变成了「不是我们写的那个值」，就说明是页面改的，
  // 把它记成新的 baseTitle 再套一次模板。靠 lastSet 比对来避免自己触发自己的死循环
  // （MutationObserver 回调是微任务，不能用同步的 flag 挡）。
  let baseTitle = '';
  let lastSet = null;
  let titleObserver = null;

  function renderTitle() {
    const tpl = typeof cfg.title === 'string' ? cfg.title : '';
    if (!tpl) return null;
    let host = '';
    try { host = window.location.hostname || ''; } catch (e) { /* ignore */ }
    return tpl.replace(/\{title\}/g, baseTitle).replace(/\{host\}/g, host);
  }

  function applyTitle() {
    const next = renderTitle();
    if (next === null) return;
    if (document.title === next) { lastSet = next; return; }
    lastSet = next;
    try { document.title = next; } catch (e) { /* ignore */ }
  }

  function startTitleWatch() {
    if (typeof cfg.title !== 'string' || !cfg.title) return;
    const head = document.head || document.documentElement;
    if (!head) return;
    if (document.title !== lastSet) baseTitle = document.title;
    if (!titleObserver && typeof MutationObserver === 'function') {
      titleObserver = new MutationObserver(() => {
        if (!mode) return;
        const cur = document.title;
        if (cur === lastSet) return;      // 是我们自己写的，忽略
        baseTitle = cur;                  // 页面改的，认账并重新套模板
        applyTitle();
      });
    }
    if (titleObserver) {
      try {
        titleObserver.observe(head, { childList: true, subtree: true, characterData: true });
      } catch (e) { /* ignore */ }
    }
    applyTitle();
  }

  function stopTitleWatch() {
    if (titleObserver) {
      try { titleObserver.disconnect(); } catch (e) { /* ignore */ }
      titleObserver = null;
    }
    // 还原成页面自己的标题（可能是小窗期间 SPA 换过的新标题，不是进小窗前的旧标题）
    if (lastSet !== null && document.title === lastSet) {
      try { document.title = baseTitle; } catch (e) { /* ignore */ }
    }
    lastSet = null;
  }

  // ---------------------------------------------------------------- 显隐
  function applyVisual() {
    if (!mode || !wrap) return;
    const fade = clamp(num(cfg.fade, 80), 0, 1200);
    const delay = covered ? clamp(num(cfg.delay, 60), 0, 3000) : 0;

    wrap.style.setProperty('--pw-fade', fade + 'ms');
    wrap.style.setProperty('--pw-delay', delay + 'ms');
    barEl.style.setProperty('--pw-fade', fade + 'ms');
    barEl.style.setProperty('--pw-delay', delay + 'ms');

    wrap.classList.toggle('off', !covered);
    barEl.classList.toggle('off', covered || !cfg.showBar);
    hintEl.textContent = cfg.hint || '';
    hintEl.classList.toggle('off', !cfg.showHint || !cfg.hint);
    canvas.style.opacity = String(clamp(num(cfg.opacity, 1), 0, 1));
    const bl = num(cfg.blur, 0) > 0 ? 'blur(' + num(cfg.blur, 0) + 'px)' : 'none';
    canvas.style.backdropFilter = bl;
    canvas.style.webkitBackdropFilter = bl;
  }

  /**
   * @param immediate true 表示跳过延时（窗口失焦、被遮挡这类确定已经离开的情况）
   */
  function cover(immediate) {
    if (!mode) return;
    covered = true;
    wrap.classList.toggle('now', !!immediate);
    barEl.classList.toggle('now', !!immediate);
    applyVisual();
  }

  function uncover() {
    if (!mode) return;
    wrap.classList.remove('now');
    barEl.classList.remove('now');
    if (!covered) return;
    covered = false;
    applyVisual();
  }

  // 指针离开内容区：延时交给 CSS，这里只翻状态
  function onLeaveWindow() { if (mode && !covered) cover(false); }
  // 确定人已经走了（失焦 / 被遮挡 / 标签页切走）：立刻盖上，不等延时
  function onLeftForSure() { if (mode && !covered) cover(true); }

  function onEnterWindow() { uncover(); }

  // 指针离开文档时 relatedTarget 为 null —— 比 mouseleave 更稳的一个信号
  function onMouseOut(e) {
    if (!e.relatedTarget && !e.toElement) onLeaveWindow();
  }

  // 鼠标是否还在窗口内（兜底：某些页面会吃掉 mouseleave）
  function onPointerMove(e) {
    if (!mode) return;
    if (e.clientX >= 0 && e.clientY >= 0 &&
        e.clientX < window.innerWidth && e.clientY < window.innerHeight) uncover();
  }

  function addListeners() {
    document.addEventListener('mouseleave', onLeaveWindow);
    document.addEventListener('mouseenter', onEnterWindow);
    document.addEventListener('pointerleave', onLeaveWindow);
    document.addEventListener('pointerenter', onEnterWindow);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('mouseover', onEnterWindow);
    window.addEventListener('blur', onLeftForSure);
    window.addEventListener('focus', onEnterWindow);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
  }

  function removeListeners() {
    document.removeEventListener('mouseleave', onLeaveWindow);
    document.removeEventListener('mouseenter', onEnterWindow);
    document.removeEventListener('pointerleave', onLeaveWindow);
    document.removeEventListener('pointerenter', onEnterWindow);
    document.removeEventListener('mouseout', onMouseOut);
    document.removeEventListener('mouseover', onEnterWindow);
    window.removeEventListener('blur', onLeftForSure);
    window.removeEventListener('focus', onEnterWindow);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onResize() {
    if (!mode) return;
    draw();
    reportSize();
  }

  function onVisibility() {
    if (!mode) return;
    if (document.hidden) onLeftForSure();
    else uncover();
  }

  function reportSize() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: 'pw:size', iw: window.innerWidth, ih: window.innerHeight });
      } catch (e) { /* 扩展已重载 */ }
    }, 220);
  }

  // ---------------------------------------------------------------- 模式切换
  function applyScroll(y) {
    const v = num(y, 0);
    if (v <= 0) return;
    // popup 里的页面是重新加载的，等布局稳定后再把滚动位置放回去
    let tries = 0;
    const tick = () => {
      try { window.scrollTo(0, v); } catch (e) { /* ignore */ }
      if (++tries < 6) setTimeout(tick, 220);
    };
    setTimeout(tick, 120);
  }

  function enter(payload) {
    const p = payload || {};
    if (mode) { draw(); return; }
    mode = true;
    covered = false;
    baseTitle = document.title;
    ensureNodes();
    addListeners();
    applyVisual();
    draw();
    loadBitmap();
    reportSize();
    startTitleWatch();
    applyScroll(p.scrollY);
  }

  function exit() {
    stopTitleWatch();
    removeListeners();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = shadow = wrap = canvas = hintEl = barEl = null;
    mode = false;
    covered = false;
  }

  // ---------------------------------------------------------------- 配置
  function sanitize(raw) {
    const out = Object.assign({}, DEFAULTS, raw || {});
    if (['color', 'image'].indexOf(out.style) < 0) out.style = DEFAULTS.style;
    if (['cover', 'contain', 'stretch', 'repeat', 'center'].indexOf(out.fill) < 0) out.fill = DEFAULTS.fill;
    out.opacity = clamp(num(out.opacity, 1), 0, 1);
    out.blur = clamp(num(out.blur, 0), 0, 40);
    out.fade = clamp(num(out.fade, 80), 0, 1200);
    out.delay = clamp(num(out.delay, 60), 0, 3000);
    if (typeof out.color !== 'string' || !/^#([0-9a-f]{3,8})$/i.test(out.color)) out.color = '#ffffff';
    if (typeof out.image !== 'string' || !/^data:image\//i.test(out.image)) {
      out.image = '';
      if (out.style === 'image') out.style = 'color';
    }
    if (typeof out.hint !== 'string') out.hint = DEFAULTS.hint;
    if (typeof out.title !== 'string') out.title = DEFAULTS.title;
    out.title = out.title.slice(0, 80);
    return out;
  }

  function applyConfig(raw) {
    const prevImage = cfg.image, prevStyle = cfg.style, prevTitle = cfg.title;
    cfg = sanitize(raw);
    if (!mode) return;
    applyVisual();
    draw();
    if (prevImage !== cfg.image || prevStyle !== cfg.style) loadBitmap();
    if (prevTitle !== cfg.title) {
      if (!cfg.title) stopTitleWatch();        // 改成不改标题，立刻还原
      else { startTitleWatch(); applyTitle(); }
    }
  }

  function loadConfig() {
    try {
      chrome.storage.local.get(STORE_KEY, (d) => {
        if (chrome.runtime.lastError) return;
        applyConfig(d && d[STORE_KEY]);
      });
    } catch (e) { /* ignore */ }
  }

  let storageListener = null;
  try {
    storageListener = (changes, area) => {
      if (area !== 'local' || !changes[STORE_KEY]) return;
      applyConfig(changes[STORE_KEY].newValue);
    };
    chrome.storage.onChanged.addListener(storageListener);
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- 消息
  let messageListener = null;
  try {
    messageListener = (msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false;
      switch (msg.type) {
        case 'pw:ping':
          sendResponse({ ok: true, mode });
          break;
        case 'pw:screen':
          // 供 background 计算停靠位置：screen 的可用区就是当前这块屏
          sendResponse({
            ok: true,
            sw: window.screen.width, sh: window.screen.height,
            sal: window.screen.availLeft, sat: window.screen.availTop,
            saw: window.screen.availWidth, sah: window.screen.availHeight,
          });
          break;
        case 'pw:enter':
          enter(msg);
          sendResponse({ ok: true, mode: true });
          break;
        case 'pw:snapshot':
          // popup 模式要重新加载同一个 URL，顺手把滚动位置带给新页面
          sendResponse({
            ok: true,
            url: window.location.href,
            sx: window.scrollX || 0,
            sy: window.scrollY || 0,
          });
          break;
        case 'pw:apply-scroll':
          applyScroll(msg.y);
          sendResponse({ ok: true });
          break;
        case 'pw:exit':
          exit();
          sendResponse({ ok: true, mode: false });
          break;
        case 'pw:toggle':
          if (mode) { exit(); sendResponse({ ok: true, on: false }); }
          else { enter(); sendResponse({ ok: true, on: true }); }
          break;
        default:
          return false;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(messageListener);
  } catch (e) { /* ignore */ }

  window.__pwDestroy = function () {
    try { exit(); } catch (e) { /* ignore */ }
    try {
      if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
      if (messageListener) chrome.runtime.onMessage.removeListener(messageListener);
    } catch (e) { /* ignore */ }
    storageListener = null;
    messageListener = null;
    delete window.__pwDestroy;
  };

  loadConfig();

  // popup 模式的页面是重新加载出来的，background 那条 pw:enter 很可能发早了。
  // 所以内容脚本一起来就先向 SW 认领：我是不是在某个小窗里？
  try {
    chrome.runtime.sendMessage({ type: 'pw:whoami' }, (r) => {
      if (chrome.runtime.lastError) return;
      if (r && r.shrunk && !mode) enter({ scrollY: r.scrollY });
    });
  } catch (e) { /* 扩展已重载 */ }
})();

/**
 * PageShrink v2 端到端测试（真实 Chromium，有头模式）
 *
 * 有头是必须的：headless 下所有窗口共享同一块渲染表面，per-window 尺寸不生效。
 * defaultViewport:null 也是必须的：puppeteer 默认给每个 page 强加 800x600 的 Emulation
 * 覆盖，innerWidth 会是假的。
 *
 * 覆盖两种模式：
 *   popup  —— 新建无边框小窗重新加载同一 URL（Chrome 禁止把标签搬进 popup）
 *   resize —— 直接把当前窗口改小，页面不重新加载
 */
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const EXT = path.resolve(__dirname, '..');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font:16px/1.6 sans-serif;background:#101418;color:#eee}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:12px}
  .cell{background:#1b2531;border:1px solid #2a3a4d;padding:10px;border-radius:8px}
  .ph{height:1600px;background:linear-gradient(#243040,#101418)}
</style></head><body>
  <h1 style="padding:12px">测试页</h1>
  <div class="grid">${Array.from({length:9},(_,i)=>`<div class="cell">卡片 ${i}</div>`).join('')}</div>
  <div class="ph"></div>
</body></html>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   -> ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(PAGE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const browser = await puppeteer.launch({
    defaultViewport: null,
    executablePath: require('./browser'),
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu', url],
  });

  let worker = null;
  for (let i = 0; i < 40 && !worker; i++) {
    for (const t of browser.targets().filter((x) => x.type() === 'service_worker')) {
      try { const w = await t.worker(); if (w && w.evaluate) { worker = w; break; } } catch (e) { /* ignore */ }
    }
    if (!worker) await sleep(250);
  }
  check('service worker 就绪', !!worker);

  const findPage = async () => {
    for (const p of await browser.pages()) if ((p.url() || '').startsWith(url)) return p;
    return null;
  };
  let page = null;
  for (let i = 0; i < 25 && !page; i++) { page = await findPage(); if (!page) await sleep(300); }
  check('测试页已打开', !!page);
  await sleep(900);

  const setCfg = (patch) => worker.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get('pw.config'))['pw.config'] || {};
    await chrome.storage.local.set({ 'pw.config': Object.assign({}, cur, p) });
  }, patch);
  const findTabId = () => worker.evaluate(async (u) => {
    for (const t of await chrome.tabs.query({})) {
      if ((t.url || '').startsWith(u)) {
        try { const r = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (r && r.ok) return t.id; } catch (e) { /* ignore */ }
      }
    }
    for (const t of await chrome.tabs.query({})) {
      try { const r = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (r && r.ok) return t.id; } catch (e) { /* ignore */ }
    }
    return -1;
  }, url);
  const doShrink = (id) => worker.evaluate(async (tid) => {
    try { return await shrink(await chrome.tabs.get(tid)); }
    catch (e) { return { error: String((e && e.message) || e) }; }
  }, id);
  const doRestore = (wid) => worker.evaluate(async (w) => {
    try { return await restore(w); } catch (e) { return { error: String((e && e.message) || e) }; }
  }, wid);
  const listWindows = () => worker.evaluate(async () => {
    const ws = await chrome.windows.getAll({ populate: true });
    return ws.map((w) => ({ id: w.id, type: w.type, state: w.state, width: w.width, height: w.height,
      tabs: w.tabs.map((t) => ({ id: t.id, url: (t.url || '').slice(0, 40) })) }));
  });
  const tabOf = (id) => worker.evaluate(async (t) => {
    try { const x = await chrome.tabs.get(t); return { windowId: x.windowId, index: x.index, url: x.url }; }
    catch (e) { return { gone: true }; }
  }, id);
  const metrics = (p) => p.evaluate(() => ({
    iw: window.innerWidth, ih: window.innerHeight,
    cols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length,
    scrollH: document.body.scrollHeight, sy: window.scrollY,
    transform: getComputedStyle(document.body).transform,
    host: !!document.getElementById('__pw_host__'),
    mode: (() => { const h = document.getElementById('__pw_host__'); return h ? !h.shadowRoot.querySelector('.mask').classList.contains('off') : null; })(),
  })).catch(() => null);

  const maskState = (p) => p.evaluate(() => {
    const h = document.getElementById('__pw_host__');
    if (!h) return null;
    const w = h.shadowRoot.querySelector('.mask');
    const bar = h.shadowRoot.querySelector('.bar');
    const c = h.shadowRoot.querySelector('canvas');
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const g = off.getContext('2d'); g.drawImage(c, 0, 0);
    const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { off: w.classList.contains('off'), opacity: Number(getComputedStyle(w).opacity),
      barOff: bar.classList.contains('off'), pe: getComputedStyle(w).pointerEvents,
      barPe: getComputedStyle(bar).pointerEvents, px: [d[0], d[1], d[2], d[3]],
      cw: c.width, ch: c.height, hint: h.shadowRoot.querySelector('.hint').textContent,
      z: Number(getComputedStyle(h).zIndex) };
  }).catch(() => null);

  // =================================================================
  //  A. popup 模式（纯净小窗，页面重新加载）
  // =================================================================
  console.log('\n--- A. popup 模式 ---');
  await setCfg({ mode: 'popup', width: 480, height: 320, corner: 'br', gap: 24, hideSource: true, style: 'color', color: '#ffffff' });
  await sleep(400);

  let tabId = await findTabId();
  check('content script 可 ping 到', tabId > 0, 'tabId=' + tabId);
  const srcTab = await tabOf(tabId);
  await worker.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    await chrome.windows.update(t.windowId, { left: 60, top: 30, width: 1000, height: 720 });
  }, tabId);
  await sleep(700);

  await page.evaluate(() => window.scrollTo(0, 620));
  await sleep(250);
  const m0 = await metrics(page);
  console.log('     缩小前 innerWidth=' + m0.iw + ' 列数=' + m0.cols + ' scrollY=' + m0.sy);
  check('宽视口下是多列栅格', m0.cols >= 3, m0.cols);

  let r = await doShrink(tabId);
  check('shrink(popup) 成功', r && r.on === true && r.kind === 'popup', JSON.stringify(r));
  await sleep(2200);

  let wins = await listWindows();
  let pop = wins.find((w) => w.id === r.windowId);
  check('新窗口类型是 popup（无标签栏/地址栏）', pop && pop.type === 'popup', pop && pop.type);
  check('新窗口只有 1 个标签', pop && pop.tabs.length === 1, pop && JSON.stringify(pop.tabs));
  const popTabId = pop && pop.tabs[0] ? pop.tabs[0].id : -1;
  // SW 没有 host 权限时 tabs.query 不返回 url 字段，改从 puppeteer 侧数页面
  const pagesWithUrl = async () => (await browser.pages()).filter((x) => (x.url() || '').startsWith(url)).length;
  check('小窗里加载的是同一个页面（全局只有 1 个测试页实例）', (await pagesWithUrl()) === 1, 'count=' + await pagesWithUrl());

  const srcNow = await tabOf(tabId);
  check('源标签仍在（被就地清空而不是关掉）', srcNow && !srcNow.gone, JSON.stringify(srcNow));
  const srcWin = wins.find((w) => w.id === srcTab.windowId);
  check('源窗口已最小化', srcWin && srcWin.state === 'minimized', srcWin && srcWin.state);

  let popPage = null;
  for (let i = 0; i < 20 && !popPage; i++) { popPage = await findPage(); if (!popPage) await sleep(300); }
  const m1 = await metrics(popPage);
  console.log('     缩小后 innerWidth=' + (m1 && m1.iw) + ' innerHeight=' + (m1 && m1.ih) + ' 列数=' + (m1 && m1.cols));
  check('★ 小窗视口真的变小（<=560）', m1 && m1.iw > 200 && m1.iw <= 560, m1 && m1.iw);
  check('★ 尺寸补偿后贴近 480', m1 && Math.abs(m1.iw - 480) <= 24, m1 && m1.iw);
  check('★ 页面按小视口重新排版（' + m0.cols + ' 列 -> ' + (m1 && m1.cols) + ' 列）', m1 && m1.cols < m0.cols, m1 && m1.cols);
  check('★ 内容高度变长（真实重排，不是等比压缩）', m1 && m1.scrollH > m0.scrollH, m0.scrollH + ' -> ' + (m1 && m1.scrollH));
  check('★ body 上没有 transform', m1 && m1.transform === 'none', m1 && m1.transform);
  check('滚动位置被带到新页面', m1 && m1.sy >= 400, m1 && m1.sy);

  const modeInfo = await worker.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'pw:ping' }), popTabId);
  check('小窗内容脚本已进入遮罩模式（靠 pw:whoami 认领）', modeInfo && modeInfo.mode === true, JSON.stringify(modeInfo));

  await popPage.mouse.move(200, 120);
  await sleep(300);
  let ms = await maskState(popPage);
  check('鼠标在窗口内 -> 遮罩揭开', ms && ms.off === true && ms.opacity === 0, JSON.stringify(ms));
  check('揭开时「还原」工具条可见且可点', ms && ms.barOff === false && ms.barPe === 'auto', ms && (ms.barOff + '/' + ms.barPe));

  await popPage.mouse.move(-400, -400);
  await sleep(1000);
  ms = await maskState(popPage);
  const synth = !ms || ms.off;
  if (synth) {
    await popPage.evaluate(() => document.dispatchEvent(new MouseEvent('mouseleave')));
    await sleep(1000);
    ms = await maskState(popPage);
  }
  check('鼠标离开 -> 遮罩盖上', ms && ms.off === false && ms.opacity === 1, JSON.stringify(ms));
  check('遮罩是不透明白色', ms && String(ms.px) === '255,255,255,255', JSON.stringify(ms && ms.px));
  check('盖上时拦截页面点击', ms && ms.pe === 'auto', ms && ms.pe);
  check('盖上时工具条隐藏', ms && ms.barOff === true);
  check('遮罩铺满内容区', ms && Math.abs(ms.cw - m1.iw) <= 2, ms && (ms.cw + 'x' + ms.ch + ' vs ' + m1.iw + 'x' + m1.ih));
  check('遮罩层级压住页面', ms && ms.z > 2147483000, ms && ms.z);
  check('遮罩上有提示文字', ms && /鼠标/.test(ms.hint), ms && ms.hint);
  console.log('     （mouseleave 触发方式：' + (synth ? '合成事件' : '真实指针移出视口') + '）');

  r = await doRestore(pop.id);
  check('restore(popup) 成功', r && r.on === false && r.kind === 'popup', JSON.stringify(r));
  await sleep(2500);
  wins = await listWindows();
  check('小窗已关闭', !wins.find((w) => w.id === pop.id));
  const backTab = await tabOf(tabId);
  check('源标签还在原窗口', backTab && !backTab.gone && backTab.windowId === srcTab.windowId, JSON.stringify(backTab));
  const srcWin2 = (await listWindows()).find((w) => w.id === srcTab.windowId);
  check('源窗口取消最小化', srcWin2 && srcWin2.state !== 'minimized', srcWin2 && srcWin2.state);
  page = await findPage();
  check('还原后测试页又回到 1 个实例', (await browser.pages()).filter((x) => (x.url() || '').startsWith(url)).length === 1);
  const m2 = await metrics(page);
  check('视口恢复到大尺寸', m2 && m2.iw === m0.iw, m0.iw + ' -> ' + (m2 && m2.iw));
  check('栅格排版恢复', m2 && m2.cols === m0.cols, m2 && m2.cols);
  check('遮罩节点已移除', m2 && m2.host === false);
  check('会话表已清空', Object.keys(await worker.evaluate(async () => (await chrome.storage.session.get('pw.sessions'))['pw.sessions'] || {})).length === 0);
  check('徽章清零', (await worker.evaluate(async () => await chrome.action.getBadgeText({}))) === '');

  // =================================================================
  //  B. resize 模式（窗口改小，页面不重新加载）
  // =================================================================
  console.log('\n--- B. resize 模式 ---');
  await setCfg({ mode: 'resize' });
  await sleep(400);
  tabId = await findTabId();
  const before = await tabOf(tabId);
  await page.evaluate(() => {
    window.__keepMe = 'SPA-状态标记';
    const d = document.createElement('div');
    d.id = 'injected-marker';
    d.textContent = '运行时插入的节点';
    document.body.appendChild(d);
    window.scrollTo(0, 300);
  });
  await sleep(200);
  const b0 = await metrics(page);

  r = await doShrink(tabId);
  check('shrink(resize) 成功', r && r.on === true && r.kind === 'resize', JSON.stringify(r));
  await sleep(1800);

  const sameWin = await listWindows();
  const smallWin = sameWin.find((w) => w.id === r.windowId);
  check('resize 模式复用同一个窗口（没有新建）', !!smallWin && smallWin.type === 'normal', smallWin && smallWin.type);
  const m3 = await metrics(page);
  console.log('     resize 后 innerWidth=' + (m3 && m3.iw) + ' 列数=' + (m3 && m3.cols));
  check('★ 窗口同样变小了', m3 && m3.iw > 200 && m3.iw <= 560, m3 && m3.iw);
  check('★ 页面状态完整保留（JS 变量还在）',
    await page.evaluate(() => window.__keepMe === 'SPA-状态标记'));
  check('★ 运行时插入的 DOM 节点还在（没有重新加载）',
    await page.evaluate(() => !!document.getElementById('injected-marker')));
  check('标签页没被移动过', (await tabOf(tabId)).windowId === before.windowId);

  ms = await maskState(page);
  check('resize 模式遮罩同样可用', ms && ms.z > 2147483000, ms && ms.z);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseleave')));
  await sleep(900);
  ms = await maskState(page);
  check('resize 模式离开后遮罩盖上', ms && ms.off === false, JSON.stringify(ms));
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseenter')));
  await sleep(400);
  ms = await maskState(page);
  check('resize 模式移回后遮罩揭开', ms && ms.off === true);

  r = await doRestore(smallWin.id);
  check('restore(resize) 成功', r && r.on === false && r.kind === 'resize', JSON.stringify(r));
  await sleep(1200);
  const m4 = await metrics(page);
  check('窗口尺寸还原', m4 && m4.iw === b0.iw, b0.iw + ' -> ' + (m4 && m4.iw));
  check('还原后遮罩节点移除', m4 && m4.host === false);
  check('还原后插入的节点仍在', await page.evaluate(() => !!document.getElementById('injected-marker')));

  await browser.close();
  srv.close();

  const failed = results.filter((x) => !x.ok);
  console.log('\n==================== ' + (results.length - failed.length) + '/' + results.length + ' 通过');
  failed.forEach((f) => console.log('  失败: ' + f.name + '   ' + f.detail));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });

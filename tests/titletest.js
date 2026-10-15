/**
 * 窗口标题功能测试
 *  - resize 模式最适合验证还原：标签页不换、不重载，能直接看到 title 改了又改回去
 *  - 关键难点：页面自己改标题（SPA）时能不能顶回来，且不会和 MutationObserver 死循环
 */
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const EXT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><title>原始网页标题 - Acme</title><style>body{margin:0;height:2000px;background:#101418}</style>
</head><body><h1 style="color:#fff">标题测试</h1></body></html>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   -> ' + detail : ''));
}

(async () => {
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(PAGE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const b = await puppeteer.launch({ defaultViewport: null, executablePath: require('./browser'), headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu', url] });
  let w = null;
  for (let i = 0; i < 40 && !w; i++) {
    for (const t of b.targets().filter((x) => x.type() === 'service_worker')) { try { const k = await t.worker(); if (k && k.evaluate) { w = k; break; } } catch (e) {} }
    if (!w) await sleep(250);
  }
  check('service worker 就绪', !!w);
  const find = async () => (await b.pages()).find((p) => (p.url() || '').startsWith(url)) || null;
  let page = null;
  for (let i = 0; i < 25 && !page; i++) { page = await find(); if (!page) await sleep(300); }
  await sleep(900);

  const setCfg = (p) => w.evaluate(async (pp) => {
    const c = (await chrome.storage.local.get('pw.config'))['pw.config'] || {};
    await chrome.storage.local.set({ 'pw.config': Object.assign({}, c, pp) });
  }, p);
  const tabId = await w.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (r && r.ok) return t.id; } catch (e) {} }
    return -1;
  });
  const shrinkNow = (id) => w.evaluate(async (t) => await shrink(await chrome.tabs.get(t)), id);
  const restoreNow = (wid) => w.evaluate(async (x) => await restore(x), wid);
  const title = () => page.evaluate(() => document.title);

  // ---------- 1. resize 模式：改标题 + 还原 ----------
  await setCfg({ mode: 'resize', width: 700, height: 500, corner: 'tl', gap: 10, title: '项目文档' });
  await sleep(400);
  const t0 = await title();
  check('初始标题是网页自己的', t0 === '原始网页标题 - Acme', JSON.stringify(t0));

  let r = await shrinkNow(tabId);
  await sleep(1500);
  page = await find();
  const t1 = await title();
  check('★ 进小窗后标题被换成自定义值', t1 === '项目文档', JSON.stringify(t1));

  r = await restoreNow(r.windowId);
  await sleep(1200);
  page = await find();
  const t2 = await title();
  check('★ 还原后标题改回原样', t2 === '原始网页标题 - Acme', JSON.stringify(t2));

  // ---------- 2. 占位符 ----------
  await setCfg({ title: '{host} · 文档' });
  await sleep(400);
  r = await shrinkNow(tabId);
  await sleep(1500);
  page = await find();
  check('★ {host} 占位符被替换', (await title()) === '127.0.0.1 · 文档', JSON.stringify(await title()));
  await restoreNow(r.windowId);
  await sleep(1000);
  page = await find();

  // ---------- 3. SPA 自己改标题能不能顶回来 ----------
  await setCfg({ title: '我的标题' });
  await sleep(400);
  r = await shrinkNow(tabId);
  await sleep(1500);
  page = await find();
  await page.evaluate(() => {
    window.__setCount = 0;
    const orig = () => {};
    // 模拟 SPA 路由切换改标题
    setTimeout(() => { window.__setCount++; document.title = 'SPA 新页面'; }, 30);
    // 再来一次，模拟持续改标题
    setInterval(() => { window.__setCount++; document.title = '未读数 (3)'; }, 400);
    void orig;
  });
  await sleep(300);
  const tA = await title();
  check('★ SPA 改标题后被顶回来', tA === '我的标题', JSON.stringify(tA));
  await sleep(1200);
  const tB = await title();
  check('★ 页面持续改标题时依然压得住', tB === '我的标题', JSON.stringify(tB));

  // 死循环检查：MutationObserver 自己触发自己会把标题写坏 / 主线程打满
  const looped = await page.evaluate(async () => {
    const before = document.title;
    await new Promise((res) => setTimeout(res, 60));
    return { changed: document.title !== before, title: document.title };
  });
  check('★ 静置时标题稳定（无自触发抖动）', looped.changed === false && looped.title === '我的标题', JSON.stringify(looped));

  await restoreNow(r.windowId);
  await sleep(1000);
  page = await find();
  const tC = await title();
  check('★ 还原后回到页面「当前」标题而不是进小窗前的旧标题',
    tC === '未读数 (3)' || tC === 'SPA 新页面', JSON.stringify(tC));

  // ---------- 4. 留空 = 不改 ----------
  // 上一节埋的 setInterval 会一直改标题，重载页面把它清掉再测
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  page = await find();
  check('重载后标题回到原始值', (await title()) === '原始网页标题 - Acme', JSON.stringify(await title()));
  await setCfg({ title: '' });
  await sleep(400);
  r = await shrinkNow(tabId);
  await sleep(1500);
  page = await find();
  check('★ 标题留空时完全不碰 document.title', (await title()) === '原始网页标题 - Acme', JSON.stringify(await title()));
  await page.evaluate(() => { document.title = '页面自己改的'; });
  await sleep(300);
  check('★ 留空时页面改标题不被干预', (await title()) === '页面自己改的', JSON.stringify(await title()));
  await restoreNow(r.windowId);
  await sleep(1000);
  page = await find();
  check('★ 留空模式还原后标题不变', (await title()) === '页面自己改的', JSON.stringify(await title()));

  // ---------- 5. popup 模式 ----------
  await setCfg({ mode: 'popup', title: '阅读中' });
  await sleep(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1000);
  const tabId2 = await w.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) { try { const r2 = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (r2 && r2.ok) return t.id; } catch (e) {} }
    return -1;
  });
  r = await shrinkNow(tabId2);
  await sleep(2500);
  page = await find();
  check('★ popup 小窗（重新加载的页面）标题也被替换', page ? (await title()) === '阅读中' : false, page && JSON.stringify(await title()));
  const popupTabTitle = await w.evaluate(async (id) => { const t = await chrome.tabs.get(id); return t.title; }, r.windowId).catch(() => null);
  await restoreNow(r.windowId);
  await sleep(1500);
  page = await find();
  check('★ popup 还原后源标签标题正常', page && (await title()) === '原始网页标题 - Acme', page && JSON.stringify(await title()));
  void popupTabTitle;

  await b.close(); srv.close();
  const failed = results.filter((x) => !x.ok);
  console.log('\n==================== ' + (results.length - failed.length) + '/' + results.length + ' 通过');
  failed.forEach((f) => console.log('  失败: ' + f.name + '   ' + f.detail));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });

#!/usr/bin/env node
/**
 * 生成 README 用的截图。
 *
 *   set CHROME_PATH=C:\path\to\chrome.exe
 *   node scripts/screenshots.js        -> docs/*.png
 *
 * 必须用 Chromium / Chrome for Testing + 有头模式，原因见 README「跑测试」。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = `<!doctype html><html><head><meta charset="utf-8"><style>
 body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f1720;color:#dbe4ee}
 nav{position:sticky;top:0;height:48px;background:#16222e;display:flex;align-items:center;gap:20px;padding:0 20px;border-bottom:1px solid #24313f;font-size:13px;z-index:10}
 nav b{color:#5aa2ff} nav span{color:#7f8f9f}
 .hero{padding:26px 20px 14px}.hero h1{margin:0 0 6px;font-size:26px;color:#fff}.hero p{margin:0;color:#8fa0b1;font-size:13px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:14px 20px}
 .card{background:#16222e;border:1px solid #24313f;border-radius:10px;padding:14px}
 .card h3{margin:0 0 6px;font-size:14px;color:#5aa2ff}.card p{margin:0;font-size:12.5px;color:#8fa0b1}
</style></head><body>
 <nav><b>Acme Console</b><span>概览</span><span>实例</span><span>日志</span><span>费用</span></nav>
 <div class="hero"><h1>生产环境监控总览</h1><p>最近 24 小时处理 1.28 亿次请求，P99 延迟 214ms，错误率 0.03%。</p></div>
 <div class="grid">${Array.from({ length: 12 }, (_, i) =>
   `<div class="card"><h3>服务 ${String.fromCharCode(65 + i)}</h3><p>QPS ${(1200 + i * 137).toLocaleString()} · CPU ${(20 + i * 5) % 95}% · 内存 ${(35 + i * 4) % 90}%</p></div>`).join('')}
 </div>
</body></html>`;

(async () => {
  const CHROME = process.env.CHROME_PATH;
  if (!CHROME) { console.error('请先设置 CHROME_PATH 指向 Chromium / Chrome for Testing'); process.exit(3); }
  fs.mkdirSync(OUT, { recursive: true });

  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    r.end(DEMO);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const browser = await puppeteer.launch({
    defaultViewport: null, executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-sandbox', '--disable-gpu', url],
  });

  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    for (const t of browser.targets().filter((x) => x.type() === 'service_worker')) {
      try { const k = await t.worker(); if (k && k.evaluate) { sw = k; break; } } catch (e) { /* ignore */ }
    }
    if (!sw) await sleep(250);
  }
  if (!sw) { console.error('service worker 没起来，确认用的是 Chromium 而不是品牌版 Chrome'); process.exit(1); }

  const find = async () => (await browser.pages()).find((p) => (p.url() || '').startsWith(url)) || null;
  let page = null;
  for (let i = 0; i < 25 && !page; i++) { page = await find(); if (!page) await sleep(300); }
  await sleep(900);

  const tabId = await sw.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) {
      try { const r = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (r && r.ok) return t.id; } catch (e) { /* ignore */ }
    }
    return -1;
  });

  await sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get('pw.config'))['pw.config'] || {};
    await chrome.storage.local.set({
      'pw.config': Object.assign({}, cur, {
        mode: 'popup', width: 420, height: 640, corner: 'br', gap: 24,
        style: 'color', color: '#ffffff', hideSource: false, title: 'Acme · 文档',
      }),
    });
  });
  await sleep(400);

  // 1) 普通大窗口
  const srcWin = await sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    await chrome.windows.update(t.windowId, { left: 40, top: 30, width: 1280, height: 800 });
    return t.windowId;
  }, tabId);
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'shot-1-normal.png') });
  console.log('  docs/shot-1-normal.png');

  // 2) 小窗（鼠标在内 -> 页面可见）
  const r = await sw.evaluate(async (id) => await shrink(await chrome.tabs.get(id)), tabId);
  await sleep(2400);
  page = await find();
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const clip = { x: 0, y: 0, width: vp.w, height: vp.h, scale: 2 };
  await page.mouse.move(Math.round(vp.w / 2), Math.round(vp.h / 2));
  await sleep(600);
  await page.screenshot({ clip, path: path.join(OUT, 'shot-2-window.png') });
  console.log(`  docs/shot-2-window.png  (${vp.w}x${vp.h} 视口)`);

  // 3) 小窗（鼠标离开 -> 遮罩盖住）
  await page.mouse.move(-500, -500);
  await sleep(900);
  await page.screenshot({ clip, path: path.join(OUT, 'shot-3-masked.png') });
  console.log('  docs/shot-3-masked.png');

  // 4) 设置页
  const extId = sw.url().split('/')[2];
  const opt = await browser.newPage();
  await opt.setViewport({ width: 1200, height: 900 });
  await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'load' });
  await sleep(1200);
  await opt.evaluate(() => window.scrollTo(0, 0));
  await opt.screenshot({ path: path.join(OUT, 'shot-4-options.png') });
  console.log('  docs/shot-4-options.png');

  await sw.evaluate(async (winId, srcWinId) => {
    await restore(winId);
    try { await chrome.windows.update(srcWinId, { state: 'normal' }); } catch (e) { /* ignore */ }
  }, r.windowId, srcWin);
  await browser.close();
  srv.close();
  console.log('\n完成。');
})().catch((e) => { console.error(e); process.exit(1); });

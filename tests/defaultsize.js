/**
 * 默认尺寸验证：清掉存储里的宽高，走扩展自己的默认值，量真实内容区。
 * 同时验证竖版比例在 1920x1120 工作区内不会顶到屏幕边界。
 */
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const EXT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   -> ' + detail : ''));
}

(async () => {
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    r.end('<!doctype html><html><head><style>body{margin:0;background:#101418;color:#eee;font:16px sans-serif}'
      + '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:12px}'
      + '.c{background:#1b2531;padding:14px;border-radius:8px}</style></head><body>'
      + '<h1 style="padding:14px">竖版小窗</h1><div class="g">'
      + Array.from({ length: 12 }, (_, i) => `<div class="c">卡片 ${i}</div>`).join('')
      + '</div></body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const b = await puppeteer.launch({ defaultViewport: null, executablePath: require('./browser'), headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu', url] });
  let w = null;
  for (let i = 0; i < 40 && !w; i++) {
    for (const t of b.targets().filter((x) => x.type() === 'service_worker')) { try { const k = await t.worker(); if (k && k.evaluate) { w = k; break; } } catch (e) {} }
    if (!w) await sleep(250);
  }
  await sleep(1200);
  const find = async () => (await b.pages()).find((p) => (p.url() || '').startsWith(url)) || null;
  let page = null;
  for (let i = 0; i < 25 && !page; i++) { page = await find(); if (!page) await sleep(300); }
  await sleep(900);

  // 关键：把存储里的尺寸字段删掉，强制走扩展自己的默认值
  const stored = await w.evaluate(async () => {
    const cur = (await chrome.storage.local.get('pw.config'))['pw.config'] || {};
    delete cur.width; delete cur.height;
    const next = Object.assign({}, cur, { mode: 'popup', corner: 'br', gap: 24 });
    await chrome.storage.local.set({ 'pw.config': next });
    return next;
  });
  check('存储里已无 width/height（走默认值）', stored.width === undefined && stored.height === undefined);

  const tabId = await w.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (r && r.ok) return t.id; } catch (e) {} }
    return -1;
  });
  const r = await w.evaluate(async (id) => await shrink(await chrome.tabs.get(id)), tabId);
  check('shrink 成功', r && r.on === true, JSON.stringify(r));
  await sleep(2200);
  page = await find();

  const m = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight,
    cols: getComputedStyle(document.querySelector('.g')).gridTemplateColumns.split(' ').length }));
  const win = await w.evaluate(async (id) => { const x = await chrome.windows.get(id); return { left: x.left, top: x.top, width: x.width, height: x.height }; }, r.windowId);
  const screen = await page.evaluate(() => ({ aw: screen.availWidth, ah: screen.availHeight }));

  console.log(`     内容区 ${m.iw}x${m.ih}，外框 ${win.width}x${win.height} @(${win.left},${win.top})，屏幕工作区 ${screen.aw}x${screen.ah}`);
  check('★ 默认内容区宽 = 420', Math.abs(m.iw - 420) <= 4, m.iw);
  check('★ 默认内容区高 = 640', Math.abs(m.ih - 640) <= 6, m.ih);
  check('竖版：高 > 宽', m.ih > m.iw, `${m.iw}x${m.ih}`);
  check('小窗完整落在工作区内（右下角停靠）',
    win.left >= 0 && win.top >= 0 && win.left + win.width <= screen.aw + 40 && win.top + win.height <= screen.ah + 5,
    `右边界 ${win.left + win.width}/${screen.aw}，下边界 ${win.top + win.height}/${screen.ah}`);

  // 四个角 + 居中：补偿尺寸后都必须还贴在各自的工作区边上，不许溢出屏幕
  await w.evaluate(async (id) => await restore(id), r.windowId);
  await sleep(1200);
  for (const corner of ['br', 'bl', 'tr', 'tl', 'center']) {
    await w.evaluate(async (cc) => {
      const cur = (await chrome.storage.local.get('pw.config'))['pw.config'] || {};
      await chrome.storage.local.set({ 'pw.config': Object.assign({}, cur, { mode: 'popup', corner: cc, gap: 24 }) });
    }, corner);
    await sleep(400);
    const tid = await w.evaluate(async () => {
      for (const t of await chrome.tabs.query({})) { try { const rr = await chrome.tabs.sendMessage(t.id, { type: 'pw:ping' }); if (rr && rr.ok) return t.id; } catch (e) {} }
      return -1;
    });
    const rr = await w.evaluate(async (id) => await shrink(await chrome.tabs.get(id)), tid);
    await sleep(2000);
    const wb = await w.evaluate(async (id) => { const x = await chrome.windows.get(id); return { left: x.left, top: x.top, width: x.width, height: x.height }; }, rr.windowId);
    const inside = wb.left >= -2 && wb.top >= -2
      && wb.left + wb.width <= screen.aw + 40 && wb.top + wb.height <= screen.ah + 5;
    // 停靠角是否真的贴住了
    const near = (a, b) => Math.abs(a - b) <= 30;
    let docked = true;
    if (corner === 'br') docked = near(wb.left + wb.width, screen.aw - 24) && near(wb.top + wb.height, screen.ah - 24);
    if (corner === 'bl') docked = near(wb.top + wb.height, screen.ah - 24) && near(wb.left, 24);
    if (corner === 'tr') docked = near(wb.top, 24) && near(wb.left + wb.width, screen.aw - 24);
    if (corner === 'tl') docked = near(wb.top, 24) && near(wb.left, 24);
    check(`停靠角 ${corner}：补偿后仍在屏幕内且贴住该角`, inside && docked,
      JSON.stringify(wb) + (inside ? '' : ' 溢出!') + (docked ? '' : ' 没贴住'));
    await w.evaluate(async (id) => await restore(id), rr.windowId);
    await sleep(900);
  }
  check('按窄屏重新排版（12 张卡变单列）', m.cols === 1, m.cols);

  // 设置页默认值展示
  const id = w.url().split('/')[2];
  const opt = await b.newPage();
  await opt.setViewport({ width: 1180, height: 1300 });
  const errs = [];
  opt.on('pageerror', (e) => errs.push(String(e)));
  await opt.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'load' });
  await sleep(900);
  const shown = await opt.evaluate(() => ({
    w: document.getElementById('width-val').textContent,
    h: document.getElementById('height-val').textContent,
    tag: document.getElementById('pv-tag').textContent,
    box: (() => { const r = document.getElementById('win').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
  }));
  check('设置页显示 420 / 640', shown.w === '420 px' && shown.h === '640 px', JSON.stringify(shown));
  check('预览卡片是竖版比例', shown.box === '112x170' || parseInt(shown.box.split('x')[1]) > parseInt(shown.box.split('x')[0]), shown.box);
  check('设置页无 JS 报错', errs.length === 0, errs.join(' | '));

  // 「恢复默认」按钮应给出 420x640
  await b.close();
  const b2 = await puppeteer.launch({ defaultViewport: null, executablePath: require('./browser'), headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu'] });
  let w2 = null;
  for (let i = 0; i < 40 && !w2; i++) {
    for (const t of b2.targets().filter((x) => x.type() === 'service_worker')) { try { const k = await t.worker(); if (k && k.evaluate) { w2 = k; break; } } catch (e) {} }
    if (!w2) await sleep(250);
  }
  await sleep(800);
  const id2 = w2.url().split('/')[2];
  const o2 = await b2.newPage();
  await o2.setViewport({ width: 1180, height: 1300 });
  await o2.goto(`chrome-extension://${id2}/options.html`, { waitUntil: 'load' });
  await sleep(900);
  // 全新安装、存储为空时，界面初始值就是默认值
  const fresh = await o2.evaluate(() => ({
    w: document.getElementById('width-val').textContent,
    h: document.getElementById('height-val').textContent,
  }));
  check('全新安装时界面初值 = 420 / 640', fresh.w === '420 px' && fresh.h === '640 px', JSON.stringify(fresh));
  await b2.close();
  srv.close();

  const failed = results.filter((x) => !x.ok);
  console.log('\n==================== ' + (results.length - failed.length) + '/' + results.length + ' 通过');
  failed.forEach((f) => console.log('  失败: ' + f.name + '   ' + f.detail));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });

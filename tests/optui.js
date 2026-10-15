/**
 * 设置页交互回归测试
 *
 * 关键：必须用 page.mouse.click(x, y) 真实点击，不能用 element.click()。
 * 后者直接在节点上派发事件，会绕过命中检测 —— 正是上一个 bug（滑轨盖住 checkbox
 * 吃掉点击）能溜过去的原因。
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const EXT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   -> ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: require('./browser'), headless: 'new',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu'],
  });
  let w = null;
  for (let i = 0; i < 40 && !w; i++) {
    for (const t of browser.targets().filter((x) => x.type() === 'service_worker')) {
      try { const k = await t.worker(); if (k && k.evaluate) { w = k; break; } } catch (e) { /* ignore */ }
    }
    if (!w) await sleep(250);
  }
  const id = w.url().split('/')[2];
  const p = await browser.newPage();
  await p.setViewport({ width: 1200, height: 1500 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'load' });
  await sleep(900);

  const getCfg = () => w.evaluate(async () => (await chrome.storage.local.get('pw.config'))['pw.config'] || {});
  const center = (sel) => p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, sel);

  // ---- 命中检测：控件中心点上最靠前的元素必须是控件自己（或其子孙）----
  const hitTest = (sel) => p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { ok: false, why: 'not found' };
    if (!el.offsetParent && el.offsetWidth === 0) return { ok: true, skip: true, self: s };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return { ok: false, why: 'no element at point' };
    const ok = top === el || el.contains(top) || top.contains(el);
    return { ok, top: top.tagName.toLowerCase() + (top.className ? '.' + String(top.className).split(' ')[0] : ''),
      self: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') };
  }, sel);

  // 图片面板默认是隐藏的，先展开，否则 rect 全 0 会误判
  await p.evaluate(() => { document.querySelectorAll('#seg-style button')[1].click(); });
  await sleep(500);
  console.log('--- 命中检测（点击会不会被别的元素吃掉）---');
  const hitTargets = [
    ['#showHint', '显示提示文字开关'],
    ['#hideSource', '最小化原窗口开关'],
    ['#seg-mode button', '缩小方式分段按钮'],
    ['#seg-style button', '遮罩样式分段按钮'],
    ['.swatch', '颜色色块'],
    ['#width', '宽度滑块'],
    ['#delay', '延迟滑块'],
    ['#pick', '选择图片按钮'],
    ['#clear-img', '移除图片按钮'],
    ['#reset', '恢复默认按钮'],
    ['#hint', '提示文字输入框'],
  ];
  for (const [sel, label] of hitTargets) {
    const r = await hitTest(sel);
    if (r.skip) { console.log('  SKIP   命中：' + label + '（当前不可见）'); continue; }
    check('命中：' + label, r.ok, r.ok ? r.self : `被 <${r.top}> 挡住`);
  }

  console.log('\n--- 真实鼠标点击 ---');
  // 1) 提示文字开关（用户报的那个）
  await p.evaluate(() => { document.getElementById('showHint').checked = true; });
  let c = await center('#showHint');
  await p.mouse.click(c.x, c.y);
  await sleep(700);
  let offByClick = await p.evaluate(() => document.getElementById('showHint').checked);
  let stored = await getCfg();
  check('点一下就能关掉「显示提示文字」', offByClick === false, 'checked=' + offByClick);
  check('关闭状态已写入 storage', stored.showHint === false, 'storage.showHint=' + stored.showHint);
  check('预览里的提示气泡同步消失',
    await p.evaluate(() => getComputedStyle(document.getElementById('pv-hint')).display === 'none'));

  c = await center('#showHint');
  await p.mouse.click(c.x, c.y);
  await sleep(700);
  check('再点一下恢复开启',
    (await p.evaluate(() => document.getElementById('showHint').checked)) === true
    && (await getCfg()).showHint === true);

  // 2) 最小化原窗口开关
  const hBefore = (await getCfg()).hideSource;
  c = await center('#hideSource');
  await p.mouse.click(c.x, c.y);
  await sleep(700);
  check('「最小化原窗口」开关同样可点', (await getCfg()).hideSource === !hBefore,
    `${hBefore} -> ${!hBefore}`);

  // 3) 分段按钮：缩小方式 / 遮罩样式
  c = await center('#seg-mode button:nth-child(2)');
  await p.mouse.click(c.x, c.y);
  await sleep(700);
  check('点「保留页面状态」生效并持久化', (await getCfg()).mode === 'resize', JSON.stringify(await getCfg()).slice(0, 40));
  check('预览同步显示浏览器 UI 条',
    await p.evaluate(() => getComputedStyle(document.querySelector('.uistrip')).display === 'block'));

  c = await center('#seg-style button:nth-child(2)');
  await p.mouse.click(c.x, c.y);
  await sleep(700);
  check('点「自定义图片」切到图片面板',
    (await getCfg()).style === 'image'
    && await p.evaluate(() => document.getElementById('box-image').hidden === false));
  check('没图时给出提示而不是静默',
    await p.evaluate(() => document.getElementById('warn').classList.contains('show')));

  // 4) 色块
  c = await center('.swatch[data-c="#1c1e22"]');
  await p.mouse.click(c.x, c.y);
  await sleep(700);
  stored = await getCfg();
  check('点深色色块改颜色并回退到纯色模式', stored.color === '#1c1e22' && stored.style === 'color',
    JSON.stringify({ c: stored.color, s: stored.style }));

  // 5) 滑块：点在轨道 25% 处
  c = await center('#delay');
  await p.mouse.click(c.x - c.w * 0.25, c.y);
  await sleep(700);
  const dv = await p.evaluate(() => Number(document.getElementById('delay').value));
  check('点击滑块轨道能改变数值', dv !== 250, 'delay=' + dv);
  check('滑块数值已持久化', (await getCfg()).delay === dv, 'storage=' + (await getCfg()).delay);

  // 6) 输入框
  c = await center('#hint');
  await p.mouse.click(c.x, c.y);
  await p.evaluate(() => { document.getElementById('hint').value = ''; document.getElementById('hint').dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  await p.mouse.click(c.x, c.y);
  await p.keyboard.type('测试提示');
  await sleep(900);
  check('提示文字可输入并保存', (await getCfg()).hint === '测试提示', JSON.stringify((await getCfg()).hint));

  check('全程无 JS 报错', errs.length === 0, errs.join(' | '));

  // 7) 反向验证：把修复回退掉，命中检测必须报错（证明这个测试不是空转）
  await p.addStyleTag({ content: '.switch input{z-index:auto !important;} .switch i{pointer-events:auto !important;}' });
  const regression = await hitTest('#showHint');
  check('测试有效性：回退修复后命中检测确实会失败', regression.ok === false,
    '回退后中心点是 <' + regression.top + '>');

  await browser.close();
  const failed = results.filter((x) => !x.ok);
  console.log('\n==================== ' + (results.length - failed.length) + '/' + results.length + ' 通过');
  failed.forEach((f) => console.log('  失败: ' + f.name + '   ' + f.detail));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });

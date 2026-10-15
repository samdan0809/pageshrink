/**
 * PageShrink v2 - service worker
 *
 * 两种缩小模式（chrome.tabs.move 有平台硬限制，必须分两条路）：
 *
 *  A. popup 模式：chrome.windows.create 新建一个 type 为 popup 的小窗，没有标签栏和地址栏。
 *     Chrome 明确禁止把标签页 move 进 popup 窗口（报错 "Tabs can only be moved to and from
 *     normal windows"），所以只能重新加载同一个 URL，并尽力恢复滚动位置。
 *     源标签若不是窗口里唯一的标签就直接关掉，否则就地置为 about:blank，避免源窗口消失。
 *
 *  B. resize 模式：直接把当前窗口 resize 成小尺寸并停靠到屏幕角。
 *     不搬标签、不重新加载，页面状态完整保留，代价是标签栏和地址栏还在。
 *
 * 其它要点：
 *  - MV3 service worker 会被回收，会话表放 chrome.storage.session（内存态、跨 SW 重启存活）。
 *  - windows.create 的 width/height 是窗口外框，标题栏/标签栏会吃掉内容高度。
 *    创建后由内容脚本回报真实 innerWidth/innerHeight，再做一次补偿 resize。
 *  - 不用 chrome.system.display：实测无显示信息的环境下 getInfo() 会直接终止 service worker，
 *    屏幕可用区改由页面回报 screen.avail* 获取，无需额外权限。
 */

const STORE_KEY = 'pw.config';
const SESS_KEY = 'pw.sessions';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const DEFAULT_WIN = {
  mode: 'popup',
  width: 420,
  height: 640,
  corner: 'br',
  gap: 24,
  hideSource: true,
};

const SKIP_URL = /^(chrome|edge|brave|vivaldi|about|devtools|chrome-extension|view-source|javascript|blob|data):/i;
const MAX_SESSIONS = 8;

// ---------------------------------------------------------------- 会话表

async function getSess() {
  try {
    const d = await chrome.storage.session.get(SESS_KEY);
    return (d && d[SESS_KEY]) || {};
  } catch (e) {
    return {};
  }
}

async function setSess(map) {
  try {
    await chrome.storage.session.set({ [SESS_KEY]: map });
  } catch (e) { /* ignore */ }
}

async function updateBadge() {
  const n = Object.keys(await getSess()).length;
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#2f6bff' });
    chrome.action.setBadgeText({ text: n ? String(n) : '' });
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- 配置

async function winCfg() {
  const out = Object.assign({}, DEFAULT_WIN);
  try {
    const d = await chrome.storage.local.get(STORE_KEY);
    const c = (d && d[STORE_KEY]) || {};
    if (['popup', 'resize'].indexOf(c.mode) >= 0) out.mode = c.mode;
    if (typeof c.width === 'number') out.width = Math.round(clamp(c.width, 280, 2400));
    if (typeof c.height === 'number') out.height = Math.round(clamp(c.height, 200, 2400));
    if (['tl', 'tr', 'bl', 'br', 'center'].indexOf(c.corner) >= 0) out.corner = c.corner;
    if (typeof c.gap === 'number') out.gap = Math.round(clamp(c.gap, 0, 200));
    if (typeof c.hideSource === 'boolean') out.hideSource = c.hideSource;
  } catch (e) { /* ignore */ }
  return out;
}

// ---------------------------------------------------------------- 几何

/**
 * 取停靠用的可用屏幕区域。屏幕数据向页面要（screen.avail*），
 * 拿不到就退回用当前窗口的矩形。
 */
async function workAreaOf(tabId, windowId) {
  let bounds = null;
  try {
    const w = await chrome.windows.get(windowId);
    bounds = { left: w.left || 0, top: w.top || 0, width: w.width || 0, height: w.height || 0 };
  } catch (e) { /* ignore */ }

  let wa = null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'pw:screen' });
    if (r && r.saw > 200 && r.sah > 200) {
      wa = { left: r.sal || 0, top: r.sat || 0, width: r.saw, height: r.sah };
    }
  } catch (e) { /* 页面没有 content script */ }

  if (!wa) {
    wa = bounds
      ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
      : { left: 0, top: 0, width: 1280, height: 720 };
  }

  // 多显示器下 screen 可能不是窗口所在那块屏，做一次包含性校验
  if (bounds) {
    const cx = bounds.left + bounds.width / 2;
    const cy = bounds.top + bounds.height / 2;
    const near = cx >= wa.left - 600 && cx <= wa.left + wa.width + 600
              && cy >= wa.top - 600 && cy <= wa.top + wa.height + 600;
    if (!near) {
      wa = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    }
  }
  return wa;
}

function popupBounds(wa, c) {
  const g = c.gap;
  const right = wa.left + wa.width - g - c.width;
  const bottom = wa.top + wa.height - g - c.height;
  let left = wa.left + g;
  let top = wa.top + g;

  if (c.corner === 'tr') { left = right; top = wa.top + g; }
  else if (c.corner === 'bl') { left = wa.left + g; top = bottom; }
  else if (c.corner === 'br') { left = right; top = bottom; }
  else if (c.corner === 'center') {
    left = wa.left + (wa.width - c.width) / 2;
    top = wa.top + (wa.height - c.height) / 2;
  }

  return {
    left: Math.round(clamp(left, wa.left, Math.max(wa.left, wa.left + wa.width - 160))),
    top: Math.round(clamp(top, wa.top, Math.max(wa.top, wa.top + wa.height - 120))),
  };
}

async function windowExists(id) {
  try { await chrome.windows.get(id); return true; } catch (e) { return false; }
}

async function tabExists(id) {
  try { await chrome.tabs.get(id); return true; } catch (e) { return false; }
}

// ---------------------------------------------------------------- 缩小

async function shrink(tab) {
  const c = await winCfg();
  const sess = await getSess();
  if (Object.keys(sess).length >= MAX_SESSIONS) return { error: 'too-many' };
  if (sess[tab.windowId]) return { error: 'already' };

  // 先问页面自己拿 URL 和滚动位置：chrome.tabs.get() 的 url 字段需要 host 权限
  // （只有点图标那一刻靠 activeTab 才有），而内容脚本的 location.href 一定准。
  let snap = null;
  try { snap = await chrome.tabs.sendMessage(tab.id, { type: 'pw:snapshot' }); } catch (e) { /* ignore */ }
  const pageUrl = (snap && snap.url) || tab.url || '';
  if (!pageUrl || SKIP_URL.test(pageUrl)) return { error: 'unsupported-page' };

  const src = { windowId: tab.windowId, tabId: tab.id, index: tab.index, url: pageUrl };
  const wa = await workAreaOf(src.tabId, src.windowId);
  const pos = popupBounds(wa, c);

  return c.mode === 'resize'
    ? shrinkByResize(sess, tab, c, pos, wa)
    : shrinkByPopup(sess, tab, c, pos, wa, src, snap);
}

/** B 模式：原窗口直接改小，页面不重新加载 */
async function shrinkByResize(sess, tab, c, pos, wa) {
  const winId = tab.windowId;
  let saved = null;
  try {
    const w = await chrome.windows.get(winId);
    saved = { left: w.left, top: w.top, width: w.width, height: w.height, state: w.state };
  } catch (e) {
    return { error: 'no-window' };
  }

  try {
    await chrome.windows.update(winId, {
      state: 'normal',
      left: pos.left,
      top: pos.top,
      width: c.width,
      height: c.height,
      focused: true,
    });
  } catch (e) {
    return { error: 'resize-failed', detail: String((e && e.message) || e) };
  }

  sess[winId] = {
    kind: 'resize',
    tabId: tab.id,
    winId: winId,
    savedBounds: saved,
    width: c.width,
    height: c.height,
    wa: wa,
    corner: c.corner,
    gap: c.gap,
  };
  await setSess(sess);
  await updateBadge();
  try { await chrome.tabs.sendMessage(tab.id, { type: 'pw:enter', scrollY: 0 }); } catch (e) { /* ignore */ }
  return { on: true, windowId: winId, kind: 'resize' };
}

/** A 模式：新建纯净 popup 重新加载同一 URL（Chrome 不允许把标签搬进 popup） */
async function shrinkByPopup(sess, tab, c, pos, wa, src, snapFromCaller) {
  let snap = { url: src.url, sx: 0, sy: 0 };
  if (snapFromCaller && snapFromCaller.url) {
    snap = { url: snapFromCaller.url, sx: snapFromCaller.sx || 0, sy: snapFromCaller.sy || 0 };
  } else {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'pw:snapshot' });
      if (r && r.url) snap = { url: r.url, sx: r.sx || 0, sy: r.sy || 0 };
    } catch (e) { /* 拿不到滚动位置就算了 */ }
  }
  if (SKIP_URL.test(snap.url)) snap.url = src.url;

  let win;
  try {
    win = await chrome.windows.create({
      url: snap.url,
      type: 'popup',
      focused: true,
      left: pos.left,
      top: pos.top,
      width: c.width,
      height: c.height,
    });
  } catch (e) {
    return { error: 'create-failed', detail: String((e && e.message) || e) };
  }

  const inPopup = await chrome.tabs.query({ windowId: win.id });
  const popupTabId = inPopup.length ? inPopup[0].id : null;

  // 源窗口里还有别的标签就直接关掉源标签，否则就地清空，避免整个窗口消失
  const siblings = (await chrome.tabs.query({ windowId: src.windowId })).filter((t) => t.id !== src.tabId);
  let blanked = false;
  if (siblings.length === 0) {
    try {
      await chrome.tabs.update(src.tabId, { url: 'about:blank' });
      blanked = true;
    } catch (e) { /* ignore */ }
    if (c.hideSource) {
      try { await chrome.windows.update(src.windowId, { state: 'minimized' }); } catch (e) { /* ignore */ }
    }
  } else {
    try { await chrome.tabs.remove(src.tabId); } catch (e) { /* ignore */ }
  }

  sess[win.id] = {
    kind: 'popup',
    tabId: popupTabId,
    winId: win.id,
    srcWindowId: src.windowId,
    srcTabId: src.tabId,
    srcIndex: src.index,
    srcUrl: snap.url,
    scrollY: snap.sy || 0,
    blanked: blanked,
    width: c.width,
    height: c.height,
    wa: wa,
    corner: c.corner,
    gap: c.gap,
  };
  await setSess(sess);
  await updateBadge();

  // 页面还在加载，这条发不到也没关系：内容脚本就绪时会用 pw:whoami 自己来认领会话
  try {
    await chrome.tabs.sendMessage(popupTabId, { type: 'pw:enter', scrollY: snap.sy || 0 });
  } catch (e) { /* ignore */ }

  return { on: true, windowId: win.id, kind: 'popup' };
}

// ---------------------------------------------------------------- 还原

async function restore(windowId) {
  const sess = await getSess();
  const s = sess[windowId];
  if (!s) return { on: false, error: 'no-session' };
  delete sess[windowId];
  await setSess(sess);

  try { await chrome.tabs.sendMessage(s.tabId, { type: 'pw:exit' }); } catch (e) { /* ignore */ }

  if (s.kind === 'resize') {
    if (s.savedBounds && await windowExists(windowId)) {
      const b = s.savedBounds;
      try {
        await chrome.windows.update(windowId, {
          left: b.left,
          top: b.top,
          width: b.width,
          height: b.height,
          state: b.state === 'minimized' ? 'normal' : b.state,
          focused: true,
        });
      } catch (e) { /* ignore */ }
    }
    await updateBadge();
    return { on: false, kind: 'resize' };
  }

  // popup 模式：小窗里若只剩我们那个标签就关窗口，否则只关标签，别误杀用户自己开的
  if (await windowExists(windowId)) {
    const rest = (await chrome.tabs.query({ windowId })).filter((t) => t.id !== s.tabId);
    try {
      if (rest.length === 0) await chrome.windows.remove(windowId);
      else await chrome.tabs.remove(s.tabId);
    } catch (e) { /* ignore */ }
  }

  if (await windowExists(s.srcWindowId)) {
    if (s.blanked && await tabExists(s.srcTabId)) {
      try { await chrome.tabs.update(s.srcTabId, { url: s.srcUrl, active: true }); } catch (e) { /* ignore */ }
    } else {
      try {
        const n = (await chrome.tabs.query({ windowId: s.srcWindowId })).length;
        await chrome.tabs.create({
          windowId: s.srcWindowId,
          index: Math.min(s.srcIndex, n),
          url: s.srcUrl,
          active: true,
        });
      } catch (e) { /* ignore */ }
    }
    try { await chrome.windows.update(s.srcWindowId, { state: 'normal', focused: true }); } catch (e) { /* ignore */ }
  } else {
    try { await chrome.windows.create({ url: s.srcUrl, type: 'normal', focused: true }); } catch (e) { /* ignore */ }
  }

  await updateBadge();
  return { on: false, kind: 'popup', restoredTo: s.srcWindowId };
}

// ---------------------------------------------------------------- 事件

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
  const sess = await getSess();

  // 点图标的标签页自己就是被缩小的那个（resize 模式下小窗有工具栏，图标可点）
  const self = Object.entries(sess).find(([, v]) => v.tabId === tab.id);
  if (self) { await restore(self[0]); return; }

  // 点图标的窗口里有一个已缩小的会话 -> 还原它
  const srcHit = Object.entries(sess).find(([, v]) => v.srcWindowId === tab.windowId);
  if (srcHit) { await restore(srcHit[0]); return; }

  if (SKIP_URL.test(tab.url || '')) return;
  await shrink(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // popup 里的页面是重新加载的，内容脚本就绪时主动来认领自己的会话
  if (msg.type === 'pw:whoami' && sender.tab) {
    getSess().then((sess) => {
      const hit = sess[sender.tab.windowId];
      if (hit && hit.tabId === sender.tab.id) {
        sendResponse({ ok: true, shrunk: true, kind: hit.kind, scrollY: hit.scrollY || 0 });
      } else {
        sendResponse({ ok: true, shrunk: false });
      }
    });
    return true; // 异步应答
  }

  if (msg.type === 'pw:request-restore' && sender.tab) {
    restore(sender.tab.windowId);
    return;
  }

  if (msg.type === 'pw:size' && sender.tab) {
    const wid = sender.tab.windowId;
    getSess().then(async (sess) => {
      const s = sess[wid];
      if (!s || !s.width) return;
      // 只补偿一次：Chrome 对带标签栏的窗口有约 500px 的最小宽度硬限制，
      // 反复补偿会撞上这个下限然后来回震荡。
      if (s.compensated) return;
      s.compensated = true;

      const dw = s.width - (msg.iw || 0);
      const dh = s.height - (msg.ih || 0);
      if (Math.abs(dw) > 2 || Math.abs(dh) > 2) {
        // 改尺寸的同时必须重算位置：否则右下停靠的窗口会朝屏幕外长出去
        const nw = s.width + dw;
        const nh = s.height + dh;
        const upd = { width: nw, height: nh };
        if (s.wa && s.corner) {
          const np = popupBounds(s.wa, { width: nw, height: nh, corner: s.corner, gap: s.gap });
          upd.left = np.left;
          upd.top = np.top;
        }
        try {
          await chrome.windows.update(wid, upd);
          s.lastBounds = upd;
        } catch (e) { /* ignore */ }
      }
      sess[wid] = s;
      await setSess(sess);
    });
  }
});

// 小窗被手动关闭 -> 收尾
chrome.windows.onRemoved.addListener(async (winId) => {
  const sess = await getSess();
  const s = sess[winId];
  if (!s) return;
  delete sess[winId];
  await setSess(sess);
  if (s.kind === 'popup' && await windowExists(s.srcWindowId)) {
    try { await chrome.windows.update(s.srcWindowId, { state: 'normal' }); } catch (e) { /* ignore */ }
  }
  await updateBadge();
});

// 被缩小的标签页被直接关掉
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sess = await getSess();
  let touched = false;
  for (const [winId, s] of Object.entries(sess)) {
    if (s.tabId !== tabId) continue;
    delete sess[winId];
    touched = true;
    if (s.kind === 'popup' && await windowExists(winId)) {
      try { await chrome.windows.remove(winId); } catch (e) { /* ignore */ }
    }
  }
  if (touched) {
    await setSess(sess);
    await updateBadge();
  }
});

chrome.runtime.onInstalled.addListener(() => { updateBadge(); });
chrome.runtime.onStartup.addListener(async () => {
  await setSess({});
  updateBadge();
});

/* PageShrink v2 - 设置页逻辑 */
(() => {
  'use strict';

  const STORE_KEY = 'pw.config';
  const DEFAULTS = {
    mode: 'popup',
    width: 420, height: 640, corner: 'br', gap: 24, hideSource: true,
    style: 'color', color: '#ffffff', image: '', fill: 'cover',
    opacity: 1, blur: 0, fade: 80, delay: 60,
    showHint: true, hint: '移回鼠标继续浏览', showBar: true,
    title: '文档',
  };
  const CORNER_TEXT = { br: '右下角', bl: '左下角', tr: '右上角', tl: '左上角', center: '居中' };
  const MODE_NOTE = {
    popup: '无边框、无标签栏，最像一张“页面卡片”。代价是页面会重新加载一次，未提交的表单和 SPA 内部状态会丢（滚动位置会尽量带回）。',
    resize: '不重新加载，页面状态完整保留；但标签栏和地址栏还在，小窗顶部会多一条浏览器 UI。',
  };
  const MAX_BYTES = 1.6 * 1024 * 1024;

  let cfg = Object.assign({}, DEFAULTS);
  let saveTimer = 0;
  const $ = (id) => document.getElementById(id);

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORE_KEY]: cfg }, () => {
        if (chrome.runtime.lastError) { toast('保存失败：' + chrome.runtime.lastError.message); return; }
        toast('已保存');
      });
    }, 220);
  }

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1300);
  }

  function warn(text) {
    const el = $('warn');
    el.textContent = text;
    el.classList.toggle('show', !!text);
  }

  // ---------------------------------------------------------------- 渲染
  function syncUI() {
    document.querySelectorAll('#seg-mode button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === cfg.mode));
    });
    $('mode-note').textContent = MODE_NOTE[cfg.mode] || '';

    document.querySelectorAll('#seg-style button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === cfg.style));
    });
    $('box-image').hidden = cfg.style !== 'image';

    $('color').value = cfg.color;
    $('color-val').textContent = cfg.color;
    document.querySelectorAll('.swatch').forEach((s) => {
      s.setAttribute('aria-pressed', String(s.dataset.c.toLowerCase() === cfg.color.toLowerCase()));
    });

    $('fill').value = cfg.fill;
    $('img-meta').textContent = cfg.image
      ? '已加载图片，约 ' + Math.round(cfg.image.length / 1024) + ' KB（base64）。'
      : '还没有上传图片，当前会回退到纯色遮罩。';

    ['width', 'height', 'gap', 'opacity', 'blur', 'fade', 'delay'].forEach((k) => {
      const el = $(k);
      if (el) el.value = k === 'opacity' ? Math.round(cfg.opacity * 100) : cfg[k];
    });
    $('width-val').textContent = cfg.width + ' px';
    $('height-val').textContent = cfg.height + ' px';
    $('gap-val').textContent = cfg.gap + ' px';
    $('opacity-val').textContent = Math.round(cfg.opacity * 100) + '%';
    $('blur-val').textContent = cfg.blur + ' px';
    $('fade-val').textContent = cfg.fade + ' ms';
    $('delay-val').textContent = cfg.delay + ' ms';

    $('corner').value = cfg.corner;
    $('hint').value = cfg.hint;
    $('title').value = cfg.title || '';
    $('title-len').textContent = (cfg.title || '').length + ' / 80';
    $('hideSource').checked = !!cfg.hideSource;
    $('showHint').checked = !!cfg.showHint;

    syncPreview();
  }

  function maskCss() {
    if (cfg.style === 'image' && cfg.image) {
      const fit = { cover: 'cover', contain: 'contain', stretch: '100% 100%', center: 'auto' };
      if (cfg.fill === 'repeat') return 'url("' + cfg.image + '") left top / auto repeat';
      return 'url("' + cfg.image + '") center center / ' + (fit[cfg.fill] || 'cover') + ' no-repeat';
    }
    return cfg.color;
  }

  let previewBuilt = false;
  function buildPreview() {
    if (previewBuilt) return;
    previewBuilt = true;
    const win = $('win');
    win.addEventListener('mouseenter', () => win.classList.add('hover'));
    win.addEventListener('mouseleave', () => win.classList.remove('hover'));
    const st = document.createElement('style');
    st.textContent = `
      .win.hover .maskl { opacity: 0 !important; }
      .win.hover .barl { opacity: 1 !important; }
      .win .maskl { z-index: 5; }
      .win .uistrip {
        position: absolute; left: 0; right: 0; top: 0; height: 15px; z-index: 4;
        background: #dee1e6; border-bottom: 1px solid #c6ccd4; display: none;
      }
      .win .uistrip::before {
        content: ""; position: absolute; left: 4px; top: 3px; width: 34px; height: 8px;
        border-radius: 3px 3px 0 0; background: #fff;
      }
      .win .uistrip::after {
        content: ""; position: absolute; left: 6px; right: 6px; bottom: 2px; height: 6px;
        border-radius: 3px; background: #f6f7f9; border: 1px solid #cdd3da;
      }
      .win.withui .uistrip { display: block; }
      .win.withui .page { top: 15px; }
    `;
    win.appendChild(st);
    const strip = document.createElement('div');
    strip.className = 'uistrip';
    win.appendChild(strip);
  }

  function syncPreview() {
    buildPreview();
    const win = $('win');
    const m = $('pv-mask');
    const stage = $('stage');

    m.style.background = maskCss();
    m.style.opacity = String(cfg.opacity);
    m.style.backdropFilter = cfg.blur > 0 ? 'blur(' + cfg.blur + 'px)' : 'none';
    m.style.transitionDuration = Math.max(60, cfg.fade) + 'ms';

    $('pv-hint').style.display = cfg.showHint && cfg.hint ? '' : 'none';
    $('pv-hint').textContent = cfg.hint || '';

    // 预览卡片按真实比例缩放显示（不做精确像素映射，只表达形状）
    const k = Math.min(1, 300 / cfg.width, 170 / cfg.height);
    win.style.width = Math.round(cfg.width * k) + 'px';
    win.style.height = Math.round(cfg.height * k) + 'px';
    const pad = 16;
    const pos = {
      br: { right: pad, bottom: pad }, bl: { left: pad, bottom: pad },
      tr: { right: pad, top: pad }, tl: { left: pad, top: pad },
      center: { left: '50%', top: '50%' },
    }[cfg.corner] || { right: pad, bottom: pad };
    ['left', 'right', 'top', 'bottom'].forEach((p) => { win.style[p] = pos[p] !== undefined ? pos[p] : 'auto'; });
    if (cfg.corner === 'center') win.style.transform = 'translate(-50%,-50%)';
    else win.style.transform = 'none';

    $('pv-tag').textContent = cfg.width + ' × ' + cfg.height + ' · ' + (CORNER_TEXT[cfg.corner] || '右下角')
      + ' · ' + (cfg.mode === 'resize' ? '保留页面状态' : '纯净小窗');
    win.classList.toggle('withui', cfg.mode === 'resize');
    void stage;
  }

  // ---------------------------------------------------------------- 绑定
  function bindRange(id, key, toValue, toText) {
    const el = $(id);
    el.addEventListener('input', () => {
      cfg[key] = toValue(Number(el.value));
      toText(Number(el.value));
      scheduleSave();
      syncPreview();
    });
  }

  function init() {
    chrome.storage.local.get(STORE_KEY, (data) => {
      if (chrome.runtime.lastError) return;
      cfg = Object.assign({}, DEFAULTS, (data && data[STORE_KEY]) || {});
      syncUI();
    });

    document.querySelectorAll('#seg-mode button').forEach((b) => {
      b.addEventListener('click', () => { cfg.mode = b.dataset.v; syncUI(); scheduleSave(); });
    });

    document.querySelectorAll('#seg-style button').forEach((b) => {
      b.addEventListener('click', () => {
        cfg.style = b.dataset.v;
        if (cfg.style === 'image' && !cfg.image) warn('还没有上传图片，先选一张图，或暂时用纯色。');
        syncUI(); scheduleSave();
      });
    });
    document.querySelectorAll('.swatch').forEach((s) => {
      s.addEventListener('click', () => { cfg.color = s.dataset.c; cfg.style = 'color'; syncUI(); scheduleSave(); });
    });

    $('color').addEventListener('input', (e) => {
      cfg.color = e.target.value; cfg.style = 'color'; syncUI(); scheduleSave();
    });
    $('fill').addEventListener('change', (e) => { cfg.fill = e.target.value; scheduleSave(); syncPreview(); });

    $('pick').addEventListener('click', () => $('file').click());
    $('clear-img').addEventListener('click', () => {
      cfg.image = ''; cfg.style = 'color'; syncUI(); scheduleSave(); warn(''); toast('已移除图片');
    });
    $('file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^image\//i.test(f.type)) { warn('请选择图片文件。'); return; }
      if (f.size > MAX_BYTES) warn('这张图 ' + (f.size / 1024 / 1024).toFixed(2) + ' MB，偏大。建议压到 1.5 MB 以内。');
      else warn('');
      const fr = new FileReader();
      fr.onload = () => {
        const url = String(fr.result || '');
        if (!/^data:image\//i.test(url)) { warn('读取失败，换一张图试试。'); return; }
        cfg.image = url; cfg.style = 'image';
        syncUI(); scheduleSave(); toast('图片已载入');
      };
      fr.onerror = () => warn('读取失败，换一张图试试。');
      fr.readAsDataURL(f);
    });

    bindRange('width', 'width', (v) => v, (v) => { $('width-val').textContent = v + ' px'; });
    bindRange('height', 'height', (v) => v, (v) => { $('height-val').textContent = v + ' px'; });
    bindRange('gap', 'gap', (v) => v, (v) => { $('gap-val').textContent = v + ' px'; });
    bindRange('opacity', 'opacity', (v) => v / 100, (v) => { $('opacity-val').textContent = v + '%'; });
    bindRange('blur', 'blur', (v) => v, (v) => { $('blur-val').textContent = v + ' px'; });
    bindRange('fade', 'fade', (v) => v, (v) => { $('fade-val').textContent = v + ' ms'; });
    bindRange('delay', 'delay', (v) => v, (v) => { $('delay-val').textContent = v + ' ms'; });

    $('corner').addEventListener('change', (e) => { cfg.corner = e.target.value; scheduleSave(); syncPreview(); });

    let hintTimer = 0;
    $('hint').addEventListener('input', (e) => {
      cfg.hint = e.target.value;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { scheduleSave(); syncPreview(); }, 260);
    });

    let titleTimer = 0;
    $('title').addEventListener('input', (e) => {
      cfg.title = e.target.value.slice(0, 80);
      $('title-len').textContent = cfg.title.length + ' / 80';
      clearTimeout(titleTimer);
      titleTimer = setTimeout(scheduleSave, 260);
    });

    $('hideSource').addEventListener('change', (e) => { cfg.hideSource = e.target.checked; scheduleSave(); });
    $('showHint').addEventListener('change', (e) => { cfg.showHint = e.target.checked; scheduleSave(); syncPreview(); });

    $('reset').addEventListener('click', () => {
      if (!window.confirm('确定把所有设置恢复成默认值吗？（上传的图片也会被清掉）')) return;
      cfg = Object.assign({}, DEFAULTS);
      syncUI(); scheduleSave(); toast('已恢复默认');
    });
  }

  init();
})();

// Full-screen document viewer used by both dashboards.
// Viewer.open({ name, ext, size, previewType, load: () => Promise<Blob>, pageCount,
//               confirm: { label, text, onConfirm }, extraButtons, onPageCount, onError })
(function () {
  const { icon, esc, formatSize } = window.App;
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve;
        s.onerror = () => { delete loaded[src]; reject(new Error('Could not load the viewer component.')); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  const MAX_PDF_PAGES = 60;
  let current = null;

  function open(opts) {
    close();
    const el = document.createElement('div');
    el.className = 'viewer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="viewer-bar">
        <button class="btn btn-sm" data-a="close" aria-label="Close preview">${icon('back')} Back</button>
        <div class="viewer-title"><strong>${esc(opts.name)}</strong><span data-meta>${esc(opts.ext.toUpperCase())} · ${esc(formatSize(opts.size))}</span></div>
        <div class="viewer-tools">
          <button class="btn btn-sm" data-a="out" aria-label="Zoom out">${icon('minus')}</button>
          <span class="zoom-label" data-zoom>100%</span>
          <button class="btn btn-sm" data-a="in" aria-label="Zoom in">${icon('plus')}</button>
          <button class="btn btn-sm" data-a="fit">Fit</button>
        </div>
        ${(opts.extraButtons || []).map((b, i) => `<button class="btn btn-sm" data-extra="${i}">${b.html}</button>`).join('')}
      </div>
      <div class="viewer-stage" data-stage><div class="spinner"></div><p style="text-align:center;color:#ccc">Opening document…</p></div>
      ${opts.confirm ? `
      <div class="viewer-foot">
        <div class="confirm-text">${esc(opts.confirm.text || 'Is this the correct document?')}</div>
        <button class="btn" data-a="close">Not this one</button>
        <button class="btn btn-accent" data-a="confirm">${icon('check')} ${esc(opts.confirm.label || 'Yes, confirm')}</button>
      </div>` : ''}`;
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';

    const state = current = { el, opts, zoom: 1, render: null, closed: false };
    const stage = el.querySelector('[data-stage]');
    const zoomLabel = el.querySelector('[data-zoom]');

    function setZoom(z) {
      state.zoom = Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
      zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
      if (state.render) state.render();
    }
    state.setZoom = setZoom;

    el.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      const x = e.target.closest('[data-extra]');
      if (x) return opts.extraButtons[+x.dataset.extra].onClick();
      if (!a) return;
      if (a.dataset.a === 'close') close();
      if (a.dataset.a === 'in') setZoom(state.zoom + 0.25);
      if (a.dataset.a === 'out') setZoom(state.zoom - 0.25);
      if (a.dataset.a === 'fit') setZoom(1);
      if (a.dataset.a === 'confirm') { close(); opts.confirm.onConfirm && opts.confirm.onConfirm(); }
    });
    state.onKey = e => {
      if (e.key === 'Escape') close();
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(state.zoom + 0.25); }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(state.zoom - 0.25); }
    };
    document.addEventListener('keydown', state.onKey);
    setTimeout(() => el.querySelector('[data-a="close"]').focus(), 30);

    const fail = (title, msg) => {
      stage.innerHTML = `<div class="viewer-msg"><h3>${esc(title)}</h3><p>${msg}</p></div>`;
      state.render = null;
    };
    state.fail = fail;

    const renderers = { pdf: renderPdf, image: renderImage, text: renderText, docx: renderDocx, sheet: renderSheet };
    const fn = renderers[opts.previewType];
    if (!fn) {
      fail('Preview not available', `A live preview is not available for <strong>.${esc(opts.ext)}</strong> files on this system. Please check that the file name and size above are correct.` +
        (opts.unsupportedHint ? `<br><br>${opts.unsupportedHint}` : ''));
      return state;
    }
    fn(state, stage).catch(err => {
      if (state.closed) return;
      console.error(err);
      fail('This document could not be opened', 'The file may be damaged, password-protected or in an unusual format. ' +
        (opts.errorHint || 'You may still download it and try opening it on a computer.'));
      opts.onError && opts.onError(err);
    });
    return state;
  }

  function close() {
    if (!current) return;
    current.closed = true;
    document.removeEventListener('keydown', current.onKey);
    if (current.cleanup) current.cleanup();
    current.el.remove();
    current = null;
    document.body.style.overflow = '';
  }

  function updateMeta(state, extra) {
    const m = state.el.querySelector('[data-meta]');
    m.textContent = `${state.opts.ext.toUpperCase()} · ${formatSize(state.opts.size)}${extra ? ' · ' + extra : ''}`;
  }

  // Documents come from this browser's storage (no server).
  async function loadBlob(opts) {
    const blob = await opts.load();
    if (!blob) throw new Error('This file is no longer available.');
    return blob;
  }

  // ---------- PDF ----------
  async function renderPdf(state, stage) {
    // Pages opened straight from disk (file://) cannot start Web Workers, so
    // pdf.js is given its worker code up front and runs on the page instead.
    if (location.protocol === 'file:') await loadScript('vendor/pdfjs/pdf.worker.min.js');
    await loadScript('vendor/pdfjs/pdf.min.js');
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    const data = await (await loadBlob(state.opts)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    if (state.closed) return;
    state.cleanup = () => pdf.destroy();
    const n = pdf.numPages;
    updateMeta(state, `${n} page${n === 1 ? '' : 's'}${state.opts.converted ? ' (converted preview)' : ''}`);
    state.opts.onPageCount && state.opts.onPageCount(n);

    const pages = [];
    for (let i = 1; i <= Math.min(n, MAX_PDF_PAGES); i++) pages.push(await pdf.getPage(i));
    let renderToken = 0;
    state.render = async () => {
      const token = ++renderToken;
      const avail = Math.max(260, stage.clientWidth - 24);
      const frag = document.createDocumentFragment();
      const jobs = [];
      for (const page of pages) {
        const base = page.getViewport({ scale: 1 });
        const fit = Math.min(avail / base.width, 1.6);
        const vp = page.getViewport({ scale: fit * state.zoom });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const c = document.createElement('canvas');
        c.className = 'page';
        c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
        c.style.width = Math.floor(vp.width) + 'px'; c.style.height = Math.floor(vp.height) + 'px';
        frag.appendChild(c);
        jobs.push({ page, c, vp, dpr });
      }
      stage.innerHTML = '';
      stage.appendChild(frag);
      if (n > MAX_PDF_PAGES) {
        const p = document.createElement('p');
        p.style.cssText = 'text-align:center;color:#ccc';
        p.textContent = `Showing the first ${MAX_PDF_PAGES} of ${n} pages.`;
        stage.appendChild(p);
      }
      for (const j of jobs) {
        if (token !== renderToken || state.closed) return;
        await j.page.render({ canvasContext: j.c.getContext('2d'), viewport: j.vp, transform: j.dpr !== 1 ? [j.dpr, 0, 0, j.dpr, 0, 0] : null }).promise;
      }
    };
    await state.render();
  }

  // ---------- images ----------
  async function renderImage(state, stage) {
    const blob = await loadBlob(state.opts);
    const url = URL.createObjectURL(blob);
    state.cleanup = () => URL.revokeObjectURL(url);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Image could not be decoded')); img.src = url; });
    if (state.closed) return;
    updateMeta(state, `${img.naturalWidth}×${img.naturalHeight}px · 1 page`);
    state.opts.onPageCount && state.opts.onPageCount(1);
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    wrap.appendChild(img);
    stage.innerHTML = '';
    stage.appendChild(wrap);
    state.render = () => {
      const fit = Math.min(1, (stage.clientWidth - 24) / img.naturalWidth, (stage.clientHeight - 40) / img.naturalHeight);
      img.style.width = Math.round(img.naturalWidth * Math.max(fit, 0.05) * state.zoom) + 'px';
    };
    state.render();
  }

  // ---------- plain text ----------
  async function renderText(state, stage) {
    const text = await (await loadBlob(state.opts)).text();
    if (state.closed) return;
    const pre = document.createElement('pre');
    pre.className = 'text-doc';
    pre.textContent = text.length > 400000 ? text.slice(0, 400000) + '\n\n… (preview truncated)' : text;
    stage.innerHTML = '';
    stage.appendChild(pre);
    const lines = text.split(/\r?\n/).length;
    updateMeta(state, `${lines} line${lines === 1 ? '' : 's'} · ~${Math.max(1, Math.ceil(lines / 55))} page(s)`);
    state.render = () => { pre.style.fontSize = (14 * state.zoom) + 'px'; };
    state.render();
  }

  // ---------- Word (.docx) rendered in the browser ----------
  async function renderDocx(state, stage) {
    await loadScript('vendor/jszip/jszip.min.js');
    await loadScript('vendor/docx-preview/docx-preview.min.js');
    const blob = await loadBlob(state.opts);
    if (state.closed) return;
    const wrap = document.createElement('div');
    wrap.className = 'doc-wrap';
    stage.innerHTML = '';
    stage.appendChild(wrap);
    await window.docx.renderAsync(blob, wrap, null, { inWrapper: true, ignoreLastRenderedPageBreak: false, experimental: false, useBase64URL: true });
    const pages = wrap.querySelectorAll('section.docx').length;
    if (pages) {
      updateMeta(state, `about ${pages} page${pages === 1 ? '' : 's'}`);
      state.opts.onPageCount && state.opts.onPageCount(pages);
    }
    state.render = () => {
      const natural = wrap.scrollWidth / (parseFloat(wrap.style.zoom) || 1);
      const fit = Math.min(1, (stage.clientWidth - 20) / (natural || 1));
      wrap.style.zoom = String(fit * state.zoom);
    };
    state.render();
  }

  // ---------- Excel (.xlsx / .xls) rendered in the browser ----------
  async function renderSheet(state, stage) {
    await loadScript('vendor/xlsx/xlsx.full.min.js');
    const buf = await (await loadBlob(state.opts)).arrayBuffer();
    if (state.closed) return;
    const wb = window.XLSX.read(buf, { type: 'array' });
    let active = 0;
    updateMeta(state, `${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? '' : 's'}`);
    state.render = () => {
      const html = window.XLSX.utils.sheet_to_html(wb.Sheets[wb.SheetNames[active]], { header: '', footer: '' });
      stage.innerHTML = `
        ${wb.SheetNames.length > 1 ? `<div class="sheet-tabs">${wb.SheetNames.map((n, i) => `<button class="btn btn-sm ${i === active ? 'btn-accent' : ''}" data-sheet="${i}">${esc(n)}</button>`).join('')}</div>` : ''}
        <div class="sheet-wrap" style="zoom:${state.zoom}">${html}</div>`;
      stage.querySelectorAll('.sheet-wrap script').forEach(s => s.remove());
      stage.querySelectorAll('[data-sheet]').forEach(b => b.addEventListener('click', () => { active = +b.dataset.sheet; state.render(); }));
    };
    state.render();
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (current && current.render) current.render(); }, 200);
  });

  window.Viewer = { open, close };
})();

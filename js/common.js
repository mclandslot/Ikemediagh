// Shared helpers for both dashboards.
(function () {
  const ICONS = {
    upload: '<path d="M12 16V4m0 0-5 5m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M12 4v12m0 0-5-5m5 5 5-5M4 20h16"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
    printer: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a6 6 0 0 1 4 6.5"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
  };
  function icon(name, cls = 'icon') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function timeAgo(iso) {
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  // Every /api/... call is answered by the Supabase data layer in
  // supabase-store.js.
  async function api(url, opts = {}) {
    try { return await window.LocalStore.handle(opts.method || 'GET', url, opts.body); }
    catch (err) {
      if (err && err.status) throw err;
      console.error(err);
      throw Object.assign(new Error((err && err.message) || 'Something went wrong. Please try again.'), { status: 500 });
    }
  }

  function toast(msg, type = '') {
    let box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 4200);
    setTimeout(() => t.remove(), 4600);
  }

  // Promise-based confirmation dialog.
  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, requireText = null }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cdTitle">
          <div class="modal-head"><h3 id="cdTitle">${esc(title)}</h3></div>
          <div class="modal-body"><p style="margin-top:0">${message}</p>
            ${requireText ? `<label for="cdInput">Type <strong>${esc(requireText)}</strong> to confirm</label><input id="cdInput" class="input" autocomplete="off">` : ''}
          </div>
          <div class="modal-foot">
            <button class="btn" data-a="cancel">Cancel</button>
            <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-a="ok" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const ok = wrap.querySelector('[data-a="ok"]');
      const input = wrap.querySelector('#cdInput');
      if (input) { input.addEventListener('input', () => { ok.disabled = input.value.trim().toUpperCase() !== requireText.toUpperCase(); }); setTimeout(() => input.focus(), 30); }
      else setTimeout(() => wrap.querySelector('[data-a="cancel"]').focus(), 30);
      const done = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', e => {
        if (e.target === wrap) return done(false);
        const a = e.target.closest('[data-a]');
        if (a) done(a.dataset.a === 'ok');
      });
    });
  }

  function ftype(ext) { return `<div class="ftype ft-${esc(ext)}">${esc(ext)}</div>`; }
  function statusClass(s) { return 'st-' + String(s).toLowerCase().replace(/\s+/g, '-'); }

  window.App = { icon, esc, formatSize, formatDate, timeAgo, api, toast, confirmDialog, ftype, statusClass };
})();

// Supabase data layer, using the project URL and key in js/config.js.
//
// It answers the same /api/... calls as the old server, so the pages don't
// need to know where the data lives. The rules that keep data safe are in
// the database itself: see supabase/schema.sql.
(function () {
  const cfg = window.IKE_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    // Not connected: every call fails with a clear message instead of crashing.
    const notSetUp = () => Promise.reject(Object.assign(
      new Error('This site is not connected to its database yet. Add the Supabase URL and key to js/config.js.'), { status: 503 }));
    window.LocalStore = {
      backend: 'none', handle: notSetUp, stageUpload: notSetUp, stagedBlob: notSetUp,
      fileBlob: notSetUp, downloadFile: notSetUp, downloadAll: notSetUp, onChange: () => {}
    };
    return;
  }

  // Accept the URL with or without a pasted /rest/v1 (or trailing slash) on the end.
  const URL_BASE = String(cfg.supabaseUrl).trim().replace(/\/+$/, '').replace(/\/(rest|auth|storage)\/v1$/i, '');
  const KEY = cfg.supabaseAnonKey;
  const BUCKET = 'documents';
  const EMAIL_DOMAIN = '@ikemedia.local'; // must match private.create_account in schema.sql
  const SWEEP_MS = 30 * 60 * 1000;

  const COLOURS = ['Black & White', 'Full Colour'];
  const PAPER_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
  const SIDES = ['Single-sided', 'Double-sided'];
  const TYPES = {
    pdf:  { mime: 'application/pdf', kind: 'pdf', sig: 'pdf' },
    doc:  { mime: 'application/msword', kind: 'office', sig: 'ole' },
    docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'office', sig: 'zip' },
    ppt:  { mime: 'application/vnd.ms-powerpoint', kind: 'office', sig: 'ole' },
    pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'office', sig: 'zip' },
    xls:  { mime: 'application/vnd.ms-excel', kind: 'office', sig: 'ole' },
    xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'office', sig: 'zip' },
    jpg:  { mime: 'image/jpeg', kind: 'image', sig: 'jpeg' },
    jpeg: { mime: 'image/jpeg', kind: 'image', sig: 'jpeg' },
    png:  { mime: 'image/png', kind: 'image', sig: 'png' },
    txt:  { mime: 'text/plain', kind: 'text', sig: 'text' }
  };

  if (!window.supabase || !window.supabase.createClient) {
    console.error('Supabase library missing: vendor/supabase/supabase.js did not load.');
    return;
  }
  const sb = window.supabase.createClient(URL_BASE, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ike-media-auth' }
  });

  // ---------------- helpers ----------------
  function fail(status, message) { throw Object.assign(new Error(message), { status }); }
  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function clean(s, max) { return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }
  function extOf(name) { const m = /\.([^.]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

  const OFFLINE = 'Could not reach the server. Check your internet connection and try again.';
  // Turns a Supabase error into { status, message } the pages understand.
  function toError(error, status) {
    const code = String((error && error.code) || '');
    if (/^PT\d{3}$/.test(code)) return Object.assign(new Error(error.message), { status: parseInt(code.slice(2), 10) });
    const msg = String((error && error.message) || '');
    if (!status || /failed to fetch|networkerror|load failed/i.test(msg)) return Object.assign(new Error(OFFLINE), { status: 503 });
    console.error('Supabase error', error);
    if (code === 'PGRST202' || code === '42883' || code === '42P01' || /schema cache/i.test(msg)) {
      return Object.assign(new Error('The database is not set up yet. Run supabase/schema.sql in your Supabase project.'), { status: 500 });
    }
    if (status === 401 || status === 403) return Object.assign(new Error('Please log in.'), { status: 401 });
    return Object.assign(new Error('Something went wrong. Please try again.'), { status: status >= 400 ? status : 500 });
  }

  async function rpc(fn, args) {
    let res;
    try { res = await sb.rpc(fn, args || {}); }
    catch (err) { fail(503, OFFLINE); }
    if (res.error) throw toError(res.error, res.status);
    return res.data;
  }

  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve;
        s.onerror = () => { delete scripts[src]; reject(new Error('Could not load a required component.')); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  // ---------------- settings (readable by everyone) ----------------
  let settingsCache = null;
  async function getSettings(fresh) {
    if (!fresh && settingsCache && Date.now() - settingsCache.at < 60000) return settingsCache.value;
    let res;
    try { res = await sb.from('settings').select('*').eq('id', 1).maybeSingle(); }
    catch { fail(503, OFFLINE); }
    if (res.error) throw toError(res.error, res.status);
    const r = res.data || {};
    const value = {
      maxFileMB: r.max_file_mb || 25, maxFilesPerOrder: r.max_files_per_order || 20,
      retentionDaysCompleted: r.retention_days_completed ?? 7, retentionDaysMax: r.retention_days_max || 60
    };
    settingsCache = { at: Date.now(), value };
    return value;
  }

  // ---------------- file checks ----------------
  async function contentMatches(file, ext) {
    const t = TYPES[ext];
    if (!t) return false;
    const h = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (!h.length) return false;
    const starts = sig => sig.every((b, i) => h[i] === b);
    switch (t.sig) {
      case 'pdf': return new TextDecoder('latin1').decode(h.subarray(0, 1024)).includes('%PDF-');
      case 'jpeg': return starts([0xFF, 0xD8, 0xFF]);
      case 'png': return starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      case 'zip': return starts([0x50, 0x4B, 0x03, 0x04]);
      case 'ole': return starts([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
      case 'text': return !h.includes(0) && !starts([0x4D, 0x5A]) && !starts([0x7F, 0x45]);
    }
    return false;
  }
  async function pdfPageCount(file) {
    try {
      if (file.size > 60 * 1024 * 1024) return null;
      const s = new TextDecoder('latin1').decode(await file.arrayBuffer());
      const m = s.match(/\/Type\s*\/Page(?![s\w])/g);
      if (m && m.length) return m.length;
      const c = s.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
      return c ? parseInt(c[1], 10) : null;
    } catch { return null; }
  }
  function previewTypeFor(ext) {
    const t = TYPES[ext];
    if (!t) return 'none';
    if (ext === 'pdf') return 'pdf';
    if (t.kind === 'image') return 'image';
    if (t.kind === 'text') return 'text';
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx' || ext === 'xls') return 'sheet';
    return 'none';
  }

  // ---------------- customer uploads ----------------
  const staging = new Map(); // uploadId -> { rec, file }

  async function accessToken() {
    try { const { data } = await sb.auth.getSession(); return (data.session && data.session.access_token) || KEY; }
    catch { return KEY; }
  }

  // Direct upload to Storage with XHR so customers see real progress on slow connections.
  function putObject(path, file, mime, token, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${URL_BASE}/storage/v1/object/${BUCKET}/${path}`);
      xhr.setRequestHeader('apikey', KEY);
      xhr.setRequestHeader('authorization', 'Bearer ' + token);
      xhr.setRequestHeader('content-type', mime);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', 'max-age=3600');
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let body = {}; try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        const msg = String(body.message || body.error || '');
        const code = String(body.statusCode || xhr.status);
        if (xhr.status === 413 || code === '413' || /too large|exceeded the maximum/i.test(msg)) reject(Object.assign(new Error('File is too large for the server.'), { status: 413 }));
        else if (/mime|content type/i.test(msg)) reject(Object.assign(new Error('This file type is not accepted.'), { status: 400 }));
        else { console.error('Upload failed', xhr.status, xhr.responseText); reject(Object.assign(new Error('Upload failed. Please try again.'), { status: xhr.status || 500 })); }
      };
      xhr.onerror = () => reject(Object.assign(new Error(OFFLINE), { status: 503 }));
      xhr.send(file);
    });
  }

  async function stageUpload(file, onProgress) {
    const progress = p => { try { onProgress && onProgress(Math.round(p)); } catch { /* ignore */ } };
    const settings = await getSettings();
    const ext = extOf(file.name);
    if (!TYPES[ext]) fail(400, `"${file.name}" is not a supported file type.`);
    if (file.size === 0) fail(400, 'The file is empty.');
    if (file.size > settings.maxFileMB * 1024 * 1024) fail(413, `File is too large. Maximum size is ${settings.maxFileMB} MB.`);
    progress(2);
    if (!await contentMatches(file, ext)) fail(400, `"${file.name}" does not look like a valid .${ext} file. It may be damaged or renamed.`);
    const rec = {
      id: uid(), path: `uploads/${uid()}.${ext}`,
      originalName: clean(file.name, 200) || `document.${ext}`,
      ext, size: file.size, pageCount: null, previewType: previewTypeFor(ext), createdAt: Date.now()
    };
    if (ext === 'pdf') rec.pageCount = await pdfPageCount(file);
    else if (TYPES[ext].kind === 'image') rec.pageCount = 1;
    progress(5);
    await putObject(rec.path, file, TYPES[ext].mime, await accessToken(), f => progress(5 + f * 94));
    progress(100);
    staging.set(rec.id, { rec, file });
    return {
      uploadId: rec.id, originalName: rec.originalName, ext, size: rec.size,
      pageCount: rec.pageCount, previewType: rec.previewType, converted: false
    };
  }

  // The customer previews the copy on their own device: nothing to download.
  function stagedBlob(uploadId) {
    const s = staging.get(uploadId);
    if (!s) fail(404, 'Upload not found or expired. Please upload the file again.');
    return Promise.resolve(s.file);
  }

  // ---------------- live updates ----------------
  const listeners = new Set();
  let channel = null;
  let changeTimer = null;
  function emitChange() {
    clearTimeout(changeTimer); // one reload for a burst of row changes
    changeTimer = setTimeout(() => listeners.forEach(fn => { try { fn(); } catch { /* ignore */ } }), 300);
  }
  function startRealtime() {
    if (channel) return;
    channel = sb.channel('ike-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, emitChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_files' }, emitChange)
      .subscribe();
  }
  function stopRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }

  // ---------------- retention (runs while a worker is logged in) ----------------
  let sweepTimer = null;
  async function sweep() {
    try {
      const r = await rpc('apply_retention');
      const paths = (r && r.paths) || [];
      for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    } catch (err) { if (err.status !== 401) console.warn('Retention check failed:', err.message); }
  }
  function startSweeps() {
    if (sweepTimer) return;
    sweep();
    sweepTimer = setInterval(sweep, SWEEP_MS);
  }
  function stopSweeps() { clearInterval(sweepTimer); sweepTimer = null; }

  function onWorkerSession() { startRealtime(); startSweeps(); }
  function onNoSession() { stopRealtime(); stopSweeps(); }

  async function removeStored(paths) {
    if (!paths || !paths.length) return;
    try { await sb.storage.from(BUCKET).remove(paths); }
    catch { /* the next retention check removes leftovers */ }
  }

  // ======================================================================
  //  API routes
  // ======================================================================
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, fn });
  const num = v => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : null; };

  // ---- customer ----
  route('GET', /^\/api\/config$/, async () => {
    const s = await getSettings(true);
    return {
      pressName: 'IKE MEDIA GH', maxFileMB: s.maxFileMB, maxFilesPerOrder: s.maxFilesPerOrder,
      allowedExtensions: Object.keys(TYPES), officeConversion: false,
      options: { colours: COLOURS, paperSizes: PAPER_SIZES, sides: SIDES }
    };
  });

  // The stored copy is left for the retention check to remove: customers
  // are never allowed to delete anything.
  route('DELETE', /^\/api\/uploads\/([^/]+)$/, async ([, id]) => { staging.delete(id); return { ok: true }; });

  route('POST', /^\/api\/orders$/, async (m, body) => {
    const items = Array.isArray(body.items) ? body.items : [];
    const payload = items.map(it => {
      const st = staging.get(String(it.uploadId || ''));
      if (!st) fail(400, 'One of your uploads has expired. Please remove it and upload it again.');
      return {
        path: st.rec.path, ext: st.rec.ext, originalName: st.rec.originalName, pageCount: st.rec.pageCount,
        previewConfirmed: !!it.previewConfirmed, specs: it.specs || {}
      };
    });
    const r = await rpc('submit_order', { p_customer_name: String(body.customerName || ''), p_phone: String(body.phone || ''), p_items: payload });
    items.forEach(it => staging.delete(String(it.uploadId || '')));
    return r;
  });

  // ---- auth ----
  route('POST', /^\/api\/auth\/login$/, async (m, body) => {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) fail(400, 'Enter your username and password.');
    const bad = () => { rpc('log_failed_login', { p_username: username }).catch(() => {}); fail(401, 'Invalid username or password.'); };
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) bad();
    let res;
    try { res = await sb.auth.signInWithPassword({ email: username + EMAIL_DOMAIN, password }); }
    catch { fail(503, OFFLINE); }
    if (res.error) {
      const e = res.error;
      if (e.status === 429) fail(429, 'Too many attempts. Try again in a few minutes.');
      if (/banned/i.test(e.message || '') || e.code === 'user_banned') fail(403, 'This account has been disabled. Ask an administrator.');
      if (!e.status || /fetch|network/i.test(e.message || '')) fail(503, OFFLINE);
      bad();
    }
    let me;
    try { me = await rpc('me'); }
    catch (err) {
      await sb.auth.signOut().catch(() => {});
      if (err.status === 401) fail(403, 'This login is not a worker account.');
      throw err;
    }
    await rpc('log_auth_event', { p_action: 'auth.login' }).catch(() => {});
    onWorkerSession();
    return { worker: me.worker };
  });

  route('POST', /^\/api\/auth\/logout$/, async () => {
    await rpc('log_auth_event', { p_action: 'auth.logout' }).catch(() => {});
    onNoSession();
    try { await sb.auth.signOut(); } catch { /* already signed out */ }
    return { ok: true };
  });

  route('GET', /^\/api\/auth\/me$/, async () => {
    const { data } = await sb.auth.getSession();
    if (!data.session) { onNoSession(); fail(401, 'Please log in.'); }
    try {
      const r = await rpc('me');
      onWorkerSession();
      return r;
    } catch (err) { if (err.status === 401) onNoSession(); throw err; }
  });

  route('POST', /^\/api\/auth\/password$/, (m, b) =>
    rpc('change_my_password', { p_current: String(b.currentPassword || ''), p_new: String(b.newPassword || '') }));

  // ---- orders ----
  route('GET', /^\/api\/orders$/, () => rpc('list_orders'));
  route('GET', /^\/api\/orders\/([^/]+)$/, ([, id]) => rpc('open_order', { p_id: id }));
  route('PATCH', /^\/api\/orders\/([^/]+)\/status$/, ([, id], b) => rpc('set_order_status', { p_id: id, p_status: String(b.status || '') }));

  route('DELETE', /^\/api\/files\/([^/]+)$/, async ([, id]) => {
    const r = await rpc('delete_file', { p_file_id: id });
    await removeStored(r.paths);
    return { order: r.order };
  });
  route('DELETE', /^\/api\/orders\/([^/]+)\/files$/, async ([, id]) => {
    const r = await rpc('delete_order_files', { p_order_id: id });
    await removeStored(r.paths);
    return { order: r.order };
  });

  route('GET', /^\/api\/activity$/, (m, b, q) => rpc('list_activity', { p_limit: Math.min(num(q.get('limit')) || 300, 2000) }));

  // ---- settings & workers ----
  route('GET', /^\/api\/settings$/, async () => {
    await rpc('me'); // login check
    return { settings: await getSettings(true), officeConversion: false };
  });
  route('PUT', /^\/api\/settings$/, async (m, b) => {
    const r = await rpc('update_settings', {
      p_max_file_mb: num(b.maxFileMB), p_max_files_per_order: num(b.maxFilesPerOrder),
      p_retention_days_completed: num(b.retentionDaysCompleted), p_retention_days_max: num(b.retentionDaysMax)
    });
    settingsCache = null;
    return r;
  });

  route('GET', /^\/api\/workers$/, () => rpc('list_workers'));
  route('POST', /^\/api\/workers$/, (m, b) => rpc('create_worker', {
    p_username: String(b.username || ''), p_password: String(b.password || ''), p_full_name: String(b.fullName || ''),
    p_role: b.role === 'admin' ? 'admin' : 'staff', p_can_delete: !!b.canDelete
  }));
  route('PATCH', /^\/api\/workers\/([^/]+)$/, ([, id], b) => {
    const changes = {};
    for (const k of ['fullName', 'role', 'canDelete', 'active', 'password']) if (b[k] !== undefined) changes[k] = b[k];
    return rpc('update_worker', { p_id: id, p_changes: changes });
  });
  route('DELETE', /^\/api\/workers\/([^/]+)$/, ([, id]) => rpc('remove_worker', { p_id: id }));

  async function handle(method, url, body) {
    const u = new URL(url, 'http://local');
    const m = String(method || 'GET').toUpperCase();
    for (const r of routes) {
      if (r.method !== m) continue;
      const match = r.pattern.exec(u.pathname);
      if (match) return r.fn(match.map(decodeURIComponent), body || {}, u.searchParams);
    }
    fail(404, 'Not found.');
  }

  // ======================================================================
  //  Worker file access: preview, download, ZIP
  // ======================================================================
  async function fileRow(fileId) {
    let res;
    try { res = await sb.from('order_files').select('id, storage_path, download_name, deleted').eq('id', fileId).maybeSingle(); }
    catch { fail(503, OFFLINE); }
    if (res.error) throw toError(res.error, res.status);
    if (!res.data) fail(404, 'File not found.');
    if (res.data.deleted) fail(410, 'This file has been deleted.');
    return res.data;
  }
  async function downloadPath(path) {
    let res;
    try { res = await sb.storage.from(BUCKET).download(path); }
    catch { fail(503, OFFLINE); }
    if (res.error || !res.data) fail(410, 'This file is no longer available.');
    return res.data;
  }

  async function fileBlob(fileId) {
    return downloadPath((await fileRow(fileId)).storage_path);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function downloadFile(fileId) {
    const f = await fileRow(fileId);
    const blob = await downloadPath(f.storage_path);
    rpc('log_file_download', { p_file_id: fileId }).catch(() => {});
    saveBlob(blob, f.download_name);
  }

  async function downloadAll(orderId) {
    const { order: o } = await rpc('open_order', { p_id: orderId });
    const live = o.files.filter(f => !f.deleted);
    if (!live.length) fail(410, 'This order has no documents left to download.');
    let res;
    try { res = await sb.from('order_files').select('id, storage_path').eq('order_id', orderId).eq('deleted', false); }
    catch { fail(503, OFFLINE); }
    if (res.error) throw toError(res.error, res.status);
    const paths = new Map(res.data.map(r => [r.id, r.storage_path]));
    const available = [];
    for (const f of live) {
      if (!paths.has(f.id)) continue;
      try { available.push({ f, blob: await downloadPath(paths.get(f.id)) }); } catch { /* skip missing */ }
    }
    if (!available.length) fail(410, 'This order has no documents left to download.');
    await loadScript('vendor/jszip/jszip.min.js');
    const zip = new window.JSZip();
    for (const { f, blob } of available) zip.file(f.downloadName, blob);
    const lines = [`Order ${o.ref}`, `Customer: ${o.customerName}`, `Phone: ${o.phone || '-'}`, `Submitted: ${o.createdAt}`, ''];
    for (const { f } of available) {
      const s = f.specs;
      lines.push(f.downloadName, `  Copies: ${s.copies} | ${s.colour} | Paper: ${s.paperSize || 'any'} | Sides: ${s.sides || 'any'}${s.notes ? ` | Notes: ${s.notes}` : ''}`);
    }
    zip.file(`${o.ref}_PRINT-SPECS.txt`, lines.join('\r\n'));
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    rpc('log_order_download', { p_order_id: orderId, p_count: available.length }).catch(() => {});
    saveBlob(out, `${o.ref}.zip`);
  }

  // Deferred: Supabase advises against calling the client inside this callback.
  sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') setTimeout(onNoSession, 0); });

  window.LocalStore = {
    backend: 'supabase',
    handle, stageUpload, stagedBlob, fileBlob, downloadFile, downloadAll,
    onChange: fn => listeners.add(fn)
  };
})();

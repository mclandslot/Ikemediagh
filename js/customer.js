// Customer dashboard: upload -> preview & specs -> details -> submit.
(function () {
  const { icon, esc, formatSize, api, toast, ftype, confirmDialog } = window.App;
  const $ = s => document.querySelector(s);

  let config = {
    maxFileMB: 25, maxFilesPerOrder: 20,
    allowedExtensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'ppt', 'pptx', 'xls', 'xlsx', 'txt'],
    options: { colours: ['Black & White', 'Full Colour'], paperSizes: ['A4', 'A3', 'A5', 'Letter', 'Legal'], sides: ['Single-sided', 'Double-sided'] }
  };
  const COPY_PRESETS = [1, 2, 3, 5, 10];
  const defaultSpecs = () => ({ copies: 1, copiesMode: '1', colour: 'Black & White', paperSize: '', sides: '', notes: '' });

  // Each entry: { key, name, size, ext, status: uploading|done|error, progress, error, job,
  //               uploadId, pageCount, previewType, converted, confirmed, specs }
  let docs = [];
  let step = 1;
  let keySeq = 0;

  $('#year').textContent = new Date().getFullYear();

  api('/api/config').then(c => {
    config = c;
    $('#limitsText').textContent = `${c.allowedExtensions.filter(e => e !== 'jpeg').map(e => e.toUpperCase()).join(', ')} · up to ${c.maxFileMB} MB each`;
  }).catch(() => {});

  // ---------------- navigation ----------------
  document.querySelectorAll('[data-start]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    goTo(step === 'done' ? 1 : step);
    $('#order').scrollIntoView({ behavior: 'smooth' });
    if (step === 1 && !docs.length) setTimeout(() => $('#fileInput').click(), 350);
  }));
  document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => goTo(+b.dataset.back)));

  function goTo(n) {
    step = n;
    document.querySelectorAll('[data-step]').forEach(el => el.classList.toggle('hidden', el.dataset.step !== String(n)));
    document.querySelectorAll('[data-step-ind]').forEach(li => {
      const i = +li.dataset.stepInd;
      li.classList.toggle('active', i === n);
      li.classList.toggle('done', n === 'done' || i < n);
    });
    if (n === 2) renderCards();
    if (n === 3) renderSummary();
    const top = $('#order').getBoundingClientRect().top;
    if (top < 0) $('#order').scrollIntoView({ behavior: 'smooth' });
  }

  // ---------------- step 1: upload ----------------
  const input = $('#fileInput');
  const dz = $('#dropzone');
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  function extOf(name) { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }

  function validate(file) {
    const ext = extOf(file.name);
    if (!config.allowedExtensions.includes(ext)) return `"${file.name}" is not a supported file type.`;
    if (file.size === 0) return `"${file.name}" is empty.`;
    if (file.size > config.maxFileMB * 1024 * 1024) return `"${file.name}" is ${formatSize(file.size)} — the maximum is ${config.maxFileMB} MB.`;
    return null;
  }

  function addFiles(list) {
    const errors = [];
    for (const file of Array.from(list || [])) {
      const active = docs.filter(d => d.status !== 'error').length;
      if (active >= config.maxFilesPerOrder) { errors.push(`You can upload at most ${config.maxFilesPerOrder} documents per order.`); break; }
      const err = validate(file);
      if (err) { errors.push(err); continue; }
      const d = { key: ++keySeq, name: file.name, size: file.size, ext: extOf(file.name), status: 'uploading', progress: 0, confirmed: false, specs: defaultSpecs() };
      docs.push(d);
      upload(d, file);
    }
    $('#uploadErrors').innerHTML = errors.map(e => `<div class="alert alert-error">${esc(e)}</div>`).join('');
    renderList();
  }

  // Files are checked and held in this browser until the order is submitted.
  function upload(d, file, onDone) {
    const job = d.job = {};
    const onProgress = pct => {
      if (d.job !== job) return;
      d.progress = pct;
      const bar = document.querySelector(`[data-key="${d.key}"] .progress > div`);
      if (bar) bar.style.width = d.progress + '%';
      const lbl = document.querySelector(`[data-key="${d.key}"] [data-pct]`);
      if (lbl) lbl.textContent = d.progress < 100 ? `Uploading ${d.progress}%` : 'Processing…';
    };
    window.LocalStore.stageUpload(file, onProgress).then(data => {
      if (d.job !== job) { api(`/api/uploads/${encodeURIComponent(data.uploadId)}`, { method: 'DELETE' }).catch(() => {}); return; }
      d.job = null;
      Object.assign(d, { status: 'done', progress: 100, uploadId: data.uploadId, name: data.originalName, size: data.size, ext: data.ext,
        pageCount: data.pageCount, previewType: data.previewType, converted: data.converted, confirmed: false });
      onDone && onDone(true);
      refresh();
    }, err => {
      if (d.job !== job) return;
      d.job = null;
      d.status = 'error';
      d.error = (err && err.message) || 'Upload failed. Please try again.';
      onDone && onDone(false);
      refresh();
    });
  }

  function removeDoc(d) {
    d.job = null;
    if (d.uploadId) api(`/api/uploads/${encodeURIComponent(d.uploadId)}`, { method: 'DELETE' }).catch(() => {});
    docs = docs.filter(x => x !== d);
    refresh();
  }

  function refresh() {
    if (step === 1) renderList();
    if (step === 2) renderCards();
    updateButtons();
  }

  function renderList() {
    const ul = $('#fileList');
    ul.innerHTML = docs.map(d => `
      <li class="file-item ${d.status === 'error' ? 'error' : ''}" data-key="${d.key}">
        ${ftype(d.ext)}
        <div class="file-main">
          <div class="file-name" title="${esc(d.name)}">${esc(d.name)}</div>
          <div class="file-meta">
            <span>${esc(formatSize(d.size))}</span>
            ${d.status === 'uploading' ? `<span data-pct>${d.progress < 100 ? `Uploading ${d.progress}%` : 'Processing…'}</span>` : ''}
            ${d.status === 'done' ? `<span class="badge badge-ok">${icon('check', 'icon" style="width:12px;height:12px')} Uploaded</span>${d.pageCount ? `<span>${d.pageCount} page${d.pageCount === 1 ? '' : 's'}</span>` : ''}` : ''}
          </div>
          ${d.status === 'uploading' ? `<div class="progress"><div style="width:${d.progress}%"></div></div>` : ''}
          ${d.status === 'error' ? `<div class="file-err">${esc(d.error)}</div>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm" data-remove="${d.key}" aria-label="Remove ${esc(d.name)}">${icon('x')}</button>
      </li>`).join('');
    ul.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removeDoc(docs.find(x => x.key === +b.dataset.remove))));
    updateButtons();
  }

  function updateButtons() {
    const done = docs.filter(d => d.status === 'done');
    const uploading = docs.some(d => d.status === 'uploading');
    const failed = docs.filter(d => d.status === 'error').length;
    $('#toStep2').disabled = !done.length || uploading;
    $('#uploadSummary').textContent = uploading ? 'Please wait for uploads to finish…'
      : done.length ? `${done.length} document${done.length === 1 ? '' : 's'} ready${failed ? ` · ${failed} failed (remove to continue)` : ''}` : '';
    if (failed && !uploading) $('#toStep2').disabled = true;
    const confirmed = done.filter(d => d.confirmed).length;
    $('#toStep3').disabled = !done.length || confirmed !== done.length;
    $('#confirmSummary').textContent = done.length ? `${confirmed} of ${done.length} confirmed` : '';
  }

  $('#toStep2').addEventListener('click', () => goTo(2));

  // ---------------- step 2: preview & specs ----------------
  function readyDocs() { return docs.filter(d => d.status === 'done'); }

  function openPreview(d) {
    window.Viewer.open({
      name: d.name, ext: d.ext, size: d.size, previewType: d.previewType, converted: d.converted,
      load: () => window.LocalStore.stagedBlob(d.uploadId),
      unsupportedHint: 'If the name is right, you can confirm it. Our staff will open it on a computer.',
      errorHint: 'If you believe the file is fine, you can still confirm it — our staff will check it — or replace it with a PDF.',
      onPageCount: n => { d.pageCount = n; },
      confirm: {
        text: 'Is this the correct document?',
        label: 'Yes, this is correct',
        onConfirm: () => { d.confirmed = true; renderCards(); updateButtons(); toast(`"${d.name}" confirmed`, 'ok'); }
      }
    });
  }

  function replaceDoc(d) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = input.accept;
    picker.onchange = () => {
      const file = picker.files[0];
      if (!file) return;
      const err = validate(file);
      if (err) return toast(err, 'error');
      const oldId = d.uploadId;
      const backup = { ...d };
      Object.assign(d, { name: file.name, size: file.size, ext: extOf(file.name), status: 'uploading', progress: 0, confirmed: false, uploadId: null, pageCount: null });
      renderCards();
      upload(d, file, ok => {
        if (ok) {
          if (oldId) api(`/api/uploads/${encodeURIComponent(oldId)}`, { method: 'DELETE' }).catch(() => {});
          toast('Document replaced — please preview it again.', 'ok');
        } else {
          const msg = d.error;
          Object.assign(d, backup, { job: null });
          toast(msg, 'error');
        }
      });
    };
    picker.click();
  }

  function copiesSelect(d) {
    const opts = COPY_PRESETS.map(n => `<option value="${n}" ${d.specs.copiesMode === String(n) ? 'selected' : ''}>${n}</option>`).join('');
    return `<div class="copies-row">
      <select class="input" data-spec="copiesMode" aria-label="Number of copies">${opts}<option value="custom" ${d.specs.copiesMode === 'custom' ? 'selected' : ''}>Custom…</option></select>
      <input class="input ${d.specs.copiesMode === 'custom' ? '' : 'hidden'}" data-spec="copiesCustom" type="number" min="1" max="1000" inputmode="numeric" value="${d.specs.copies}" aria-label="Custom number of copies">
    </div>`;
  }

  function renderCards() {
    const ready = readyDocs();
    const box = $('#docCards');
    const pending = docs.filter(d => d.status === 'uploading');
    if (!ready.length && !pending.length) { goTo(1); return; }
    box.innerHTML = docs.filter(d => d.status !== 'error').map((d, idx) => {
      if (d.status === 'uploading') {
        return `<div class="doc-card" data-key="${d.key}"><div class="doc-head">${ftype(d.ext)}<div class="file-main"><div class="file-name">${esc(d.name)}</div>
          <div class="file-meta"><span data-pct>Uploading ${d.progress}%</span></div><div class="progress"><div style="width:${d.progress}%"></div></div></div></div></div>`;
      }
      const s = d.specs;
      const colourRadios = config.options.colours.map((c, i) => `
        <input type="radio" id="c${d.key}_${i}" name="colour${d.key}" value="${esc(c)}" data-spec="colour" ${s.colour === c ? 'checked' : ''}><label for="c${d.key}_${i}">${esc(c)}</label>`).join('');
      return `
      <div class="doc-card ${d.confirmed ? 'confirmed' : ''}" data-key="${d.key}">
        <div class="doc-head">
          ${ftype(d.ext)}
          <div class="file-main">
            <div class="file-name" title="${esc(d.name)}">${esc(d.name)}</div>
            <div class="file-meta">
              <span>${esc(formatSize(d.size))}</span>
              ${d.pageCount ? `<span>${d.pageCount} page${d.pageCount === 1 ? '' : 's'}</span>` : ''}
              ${d.confirmed ? `<span class="badge badge-ok">${icon('check', 'icon" style="width:12px;height:12px')} Confirmed</span>` : '<span class="badge badge-warn">Not previewed yet</span>'}
            </div>
          </div>
          <div class="doc-actions">
            <button class="btn ${d.confirmed ? '' : 'btn-primary'} btn-sm" data-act="preview">${icon('eye')} Preview</button>
            <button class="btn btn-sm" data-act="replace">${icon('swap')} Replace</button>
            <button class="btn btn-danger btn-sm" data-act="remove" aria-label="Remove">${icon('trash')}</button>
          </div>
        </div>
        ${d.confirmed ? '' : `<div class="preview-prompt"><span>Please open the preview and confirm this is the right document.</span></div>`}
        <div class="specs">
          <div class="field"><label>Number of copies</label>${copiesSelect(d)}</div>
          <div class="field wide"><label>Printing colour</label><div class="seg" role="radiogroup">${colourRadios}</div></div>
          <div class="field"><label for="ps${d.key}">Paper size <span class="muted small">(optional)</span></label>
            <select class="input" id="ps${d.key}" data-spec="paperSize"><option value="">No preference</option>${config.options.paperSizes.map(p => `<option ${s.paperSize === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
          <div class="field"><label for="sd${d.key}">Printing sides <span class="muted small">(optional)</span></label>
            <select class="input" id="sd${d.key}" data-spec="sides"><option value="">No preference</option>${config.options.sides.map(p => `<option ${s.sides === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
          <div class="field full"><label for="nt${d.key}">Notes for the printer <span class="muted small">(optional)</span></label>
            <input class="input" id="nt${d.key}" data-spec="notes" maxlength="300" placeholder="e.g. print pages 1–5 only, staple" value="${esc(s.notes)}"></div>
        </div>
        ${idx === 0 && ready.length > 1 ? `<div class="apply-all"><button class="link-btn" data-act="applyAll">Apply these options to all documents</button></div>` : ''}
      </div>`;
    }).join('');

    box.querySelectorAll('.doc-card').forEach(card => {
      const d = docs.find(x => x.key === +card.dataset.key);
      if (!d || d.status !== 'done') return;
      card.addEventListener('click', e => {
        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.dataset.act === 'preview') openPreview(d);
        if (a.dataset.act === 'replace') replaceDoc(d);
        if (a.dataset.act === 'remove') confirmDialog({ title: 'Remove document?', message: `Remove <strong>${esc(d.name)}</strong> from this order?`, confirmText: 'Remove', danger: true })
          .then(ok => { if (ok) removeDoc(d); });
        if (a.dataset.act === 'applyAll') {
          readyDocs().forEach(o => { if (o !== d) o.specs = { ...d.specs }; });
          renderCards();
          toast('Options applied to all documents.', 'ok');
        }
      });
      card.addEventListener('input', e => onSpecChange(d, card, e.target));
      card.addEventListener('change', e => onSpecChange(d, card, e.target));
    });
    updateButtons();
  }

  function onSpecChange(d, card, el) {
    const k = el.dataset.spec;
    if (!k) return;
    if (k === 'copiesMode') {
      d.specs.copiesMode = el.value;
      const custom = card.querySelector('[data-spec="copiesCustom"]');
      if (el.value === 'custom') { custom.classList.remove('hidden'); custom.focus(); d.specs.copies = parseInt(custom.value, 10) || 1; }
      else { custom.classList.add('hidden'); d.specs.copies = +el.value; custom.value = el.value; }
    } else if (k === 'copiesCustom') {
      d.specs.copies = parseInt(el.value, 10) || 0;
    } else if (k === 'colour') {
      if (el.checked) d.specs.colour = el.value;
    } else {
      d.specs[k] = el.value;
    }
  }

  $('#toStep3').addEventListener('click', () => {
    const bad = readyDocs().find(d => !Number.isInteger(d.specs.copies) || d.specs.copies < 1 || d.specs.copies > 1000);
    if (bad) return toast(`Number of copies for "${bad.name}" must be between 1 and 1000.`, 'error');
    goTo(3);
    setTimeout(() => $('#custName').focus(), 300);
  });

  // ---------------- step 3: details & submit ----------------
  function renderSummary() {
    const ready = readyDocs();
    $('#orderSummary').innerHTML = ready.map(d => {
      const s = d.specs;
      return `<div class="summary-row">${ftype(d.ext)}<div class="file-main">
        <div class="file-name">${esc(d.name)}</div>
        <div class="summary-specs">${s.copies} cop${s.copies === 1 ? 'y' : 'ies'} · ${esc(s.colour)}${s.paperSize ? ' · ' + esc(s.paperSize) : ''}${s.sides ? ' · ' + esc(s.sides) : ''}${d.pageCount ? ` · ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}` : ''}${s.notes ? `<br>Note: ${esc(s.notes)}` : ''}</div>
      </div></div>`;
    }).join('');
    $('#submitError').innerHTML = '';
  }

  $('#detailsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#custName').value.trim();
    const phone = $('#custPhone').value.trim();
    const errBox = $('#submitError');
    errBox.innerHTML = '';
    if (name.length < 2) { errBox.innerHTML = '<div class="alert alert-error">Please enter your name.</div>'; $('#custName').focus(); return; }
    if (phone && !/^[+()\d\s-]{7,20}$/.test(phone)) { errBox.innerHTML = '<div class="alert alert-error">Please enter a valid phone number, or leave it empty.</div>'; $('#custPhone').focus(); return; }
    const ready = readyDocs();
    if (ready.some(d => !d.confirmed)) { goTo(2); return toast('Please preview and confirm every document first.', 'error'); }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const res = await api('/api/orders', {
        method: 'POST',
        body: {
          customerName: name, phone,
          items: ready.map(d => ({
            uploadId: d.uploadId, previewConfirmed: d.confirmed,
            specs: { copies: d.specs.copies, colour: d.specs.colour, paperSize: d.specs.paperSize, sides: d.specs.sides, notes: d.specs.notes }
          }))
        }
      });
      $('#orderRef').textContent = res.ref;
      $('#successMeta').textContent = `${res.fileCount} document${res.fileCount === 1 ? '' : 's'} · submitted ${new Date(res.createdAt).toLocaleString()}`;
      try { localStorage.setItem('ike_last_ref', res.ref); } catch {}
      docs = [];
      $('#detailsForm').reset();
      goTo('done');
      $('#order').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      errBox.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit printing request';
    }
  });

  $('#copyRef').addEventListener('click', async () => {
    const ref = $('#orderRef').textContent;
    try { await navigator.clipboard.writeText(ref); toast('Reference copied', 'ok'); }
    catch { toast(`Your reference is ${ref}`); }
  });
  $('#newOrder').addEventListener('click', () => { docs = []; renderList(); goTo(1); });

  window.addEventListener('beforeunload', e => {
    if (docs.length && step !== 'done') { e.preventDefault(); e.returnValue = ''; }
  });
})();

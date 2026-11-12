const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const WORKING = ['queued', 'extracting', 'transcribing', 'analyzing'];
const LABEL = { queued: 'Waiting', extracting: 'Reading video', transcribing: 'Transcribing', analyzing: 'Finding clips', ready: 'Ready', failed: 'Failed' };

let me = null, plans = null, projects = [], openId = null, picked = null, timer = null, signup = false;

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (r.status === 401 && me) { me = null; showAuth(); }
  if (!r.ok) { const e = new Error(body?.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return body;
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) });

/* ---------- auth ---------- */
function showAuth() {
  clearTimeout(timer);
  $('#auth').hidden = false; $('#app').hidden = true; $('#acct').hidden = true;
}
function setMode(isSignup) {
  signup = isSignup;
  $('#auth-h').textContent = signup ? 'Create your account' : 'Log in to ClipGenius';
  $('#authgo').textContent = signup ? 'Create account' : 'Log in';
  $('#swaptext').textContent = signup ? 'Already have an account?' : 'New here?';
  $('#swap').textContent = signup ? 'Log in' : 'Create an account';
  $('#password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#authmsg').textContent = '';
}
$('#swap').addEventListener('click', () => setMode(!signup));
$('#authform').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#authmsg').textContent = '';
  try {
    me = await post(signup ? '/api/auth/signup' : '/api/auth/login', { email: $('#email').value, password: $('#password').value });
    $('#password').value = '';
    enterApp();
  } catch (er) { $('#authmsg').textContent = er.message; }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  me = null; projects = []; openId = null; showAuth();
});

/* ---------- header, plans ---------- */
function renderMe() {
  $('#credits').textContent = `${me.credits.total} credits · ${me.planName}`;
  $('#manage').hidden = !me.canManageBilling;
}
async function loadPlans() {
  plans = await api('/api/plans');
  const grid = $('#plangrid');
  grid.innerHTML = plans.plans.map((p) => `
    <div class="plan ${p.id === me.plan ? 'current' : ''}">
      <h3>${esc(p.name)}</h3>
      <div class="price">$${p.price}<small>/month</small></div>
      <p>${p.credits} credits each month</p>
      ${p.id === 'free' ? `<p>${p.id === me.plan ? 'Your current plan' : 'Included with every account'}</p>`
        : p.id === me.plan ? '<p>Your current plan</p>'
        : `<button class="primary" style="margin-left:0" data-buy="${p.id}">Choose ${esc(p.name)}</button>`}
    </div>`).join('') + `
    <div class="plan"><h3>Credit pack</h3><div class="price">$${plans.pack.price}<small> once</small></div>
      <p>${plans.pack.credits} extra credits that don't expire</p>
      <button data-buy="pack">Buy a pack</button></div>`;
  $('#plannote').textContent = plans.creditUnit + (plans.billingEnabled ? '.' : '. Billing is not configured on this server yet.');
}
$('#credits').addEventListener('click', async () => {
  const sec = $('#plans');
  sec.hidden = !sec.hidden;
  if (!sec.hidden) { await loadPlans().catch((e) => banner(e.message)); sec.scrollIntoView({ behavior: 'smooth' }); }
});
$('#plans').addEventListener('click', async (e) => {
  const buy = e.target.dataset.buy;
  if (!buy) return;
  e.target.disabled = true;
  try { location.href = (await post('/api/billing/checkout', { plan: buy })).url; }
  catch (er) { banner(er.message); e.target.disabled = false; }
});
$('#manage').addEventListener('click', async () => {
  try { location.href = (await post('/api/billing/portal')).url; } catch (er) { banner(er.message); }
});
function banner(msg) { const b = $('#banner'); b.textContent = msg; b.hidden = !msg; }

/* ---------- upload ---------- */
function setFile(f) {
  picked = f || null;
  $('#drop-title').textContent = f ? f.name : 'Choose a video or drag it here';
  $('#drop-sub').textContent = f ? `${(f.size / 1048576).toFixed(1)} MB` : 'MP4, MOV, WEBM, MKV or M4V';
  $('#go').disabled = !f;
}
const drop = $('#drop');
$('#file').addEventListener('change', (e) => setFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });

$('#go').addEventListener('click', () => {
  if (!picked) return;
  const fd = new FormData();
  fd.append('clipCount', $('#clipCount').value);
  fd.append('minLen', $('#minLen').value);
  fd.append('maxLen', $('#maxLen').value);
  fd.append('video', picked); // file last so fields are parsed first
  $('#upmsg').textContent = '';
  $('#go').disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/projects');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('#go').textContent = `Uploading ${Math.round((e.loaded / e.total) * 100)}%`; };
  xhr.onload = () => {
    $('#go').textContent = 'Find my clips';
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 201) { setFile(null); $('#file').value = ''; openId = body.id; refreshMe(); refresh(); }
    else if (xhr.status === 401) { me = null; showAuth(); }
    else { $('#upmsg').textContent = body.error || 'Upload failed.'; $('#go').disabled = !picked; }
  };
  xhr.onerror = () => { $('#go').textContent = 'Find my clips'; $('#upmsg').textContent = 'Could not reach the server.'; $('#go').disabled = !picked; };
  xhr.send(fd);
});

/* ---------- videos ---------- */
async function refreshMe() { try { me = await api('/api/me'); renderMe(); } catch {} }

async function refresh() {
  if (!me) return;
  try { projects = await api('/api/projects'); } catch { return; }
  renderList();
  renderDetail();
  const busy = projects.some((p) => WORKING.includes(p.status) || p.clips.some((c) => c.render.status === 'rendering'));
  clearTimeout(timer);
  if (busy) timer = setTimeout(async () => { await refreshMe(); refresh(); }, 2500); // refreshMe picks up refunds on failed jobs
}

function renderList() {
  const el = $('#list');
  if (!projects.length) { el.innerHTML = '<p class="empty">Nothing here yet. Upload a video to get started.</p>'; return; }
  el.innerHTML = projects.map((p) => {
    const cls = p.status === 'ready' ? 'ready' : p.status === 'failed' ? 'failed' : 'work';
    const sub = p.status === 'failed' ? `${esc(p.error)} Your credits were returned.` : WORKING.includes(p.status) ? esc(p.progress) : `${p.clips.length} clips · ${fmt(p.duration || 0)} · ${p.cost} credits`;
    return `<div class="row ${p.id === openId ? 'active' : ''}">
      <div><div class="name">${esc(p.name)}</div><div class="sub">${sub}</div></div>
      <div class="actions"><span class="badge ${cls}">${LABEL[p.status]}</span>
        ${p.status === 'ready' ? `<button data-open="${p.id}">Open</button>` : ''}
        <button data-del="${p.id}" aria-label="Delete ${esc(p.name)}">Delete</button></div></div>`;
  }).join('');
}

$('#list').addEventListener('click', async (e) => {
  const o = e.target.dataset.open, d = e.target.dataset.del;
  if (o) { openId = o; renderList(); renderDetail(true); }
  if (d && confirm('Delete this video and all its clips? Credits are not refunded.')) {
    await api(`/api/projects/${d}`, { method: 'DELETE' }).catch((er) => alert(er.message));
    if (openId === d) openId = null;
    refresh();
  }
});

function renderDetail(scroll) {
  const el = $('#detail');
  const p = projects.find((x) => x.id === openId);
  if (!p || p.status !== 'ready') { el.hidden = true; el.innerHTML = ''; return; }
  // Don't clobber inputs/video the person is editing while a poll lands.
  if (!scroll && el.contains(document.activeElement) && !p.clips.some((c) => c.render.status === 'rendering')) return;
  const keep = {};
  el.querySelectorAll('.clip').forEach((c) => {
    keep[c.dataset.cid] = { s: c.querySelector('.s')?.value, e: c.querySelector('.e')?.value, cap: c.querySelector('.cap')?.checked };
  });
  el.hidden = false;
  el.innerHTML = `<h2>Clips from “${esc(p.name)}”</h2>` + (p.clips.length ? `<div class="clips">${p.clips.map((c) => clipCard(p, c, keep[c.id])).join('')}</div>` : '<p class="empty">No clip-worthy moments were found in this video.</p>');
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clipCard(p, c, k = {}) {
  const r = c.render;
  const src = `${p.sourceUrl}#t=${c.start.toFixed(1)},${c.end.toFixed(1)}`;
  const media = r.status === 'done' ? `<video controls preload="metadata" src="${r.url}"></video>` : `<video controls preload="metadata" src="${src}"></video>`;
  return `<article class="clip" data-cid="${c.id}">
    <span class="score" title="Hook, intensity and clarity">Score ${c.score}</span>
    <h3>${esc(c.title)}</h3>
    ${media}
    <p class="why">${esc(c.reason)}</p>
    <div class="times">
      <label>Start (sec)<input class="s" type="number" step="0.1" value="${k.s ?? c.start.toFixed(1)}"></label>
      <label>End (sec)<input class="e" type="number" step="0.1" value="${k.e ?? c.end.toFixed(1)}"></label>
      <label class="chk"><input class="cap" type="checkbox" ${(k.cap ?? true) ? 'checked' : ''}> Captions</label>
    </div>
    ${r.status === 'failed' ? `<p class="err">${esc(r.error)}</p>` : ''}
    <button class="primary" style="margin-left:0" data-render="${c.id}" ${r.status === 'rendering' ? 'disabled' : ''}>${r.status === 'rendering' ? 'Rendering…' : r.status === 'done' ? 'Render again' : 'Render vertical clip'}</button>
    ${r.status === 'done' ? `<a class="dl" href="${r.url}" download="${esc(c.title)}.mp4">Download MP4</a>` : ''}
  </article>`;
}

$('#detail').addEventListener('click', async (e) => {
  const cid = e.target.dataset.render;
  if (!cid) return;
  const card = e.target.closest('.clip');
  try {
    await post(`/api/projects/${openId}/clips/${cid}/render`, { start: Number(card.querySelector('.s').value), end: Number(card.querySelector('.e').value), captions: card.querySelector('.cap').checked });
    refresh();
  } catch (er) { alert(er.message); }
});

/* ---------- boot ---------- */
async function health() {
  try {
    const h = await api('/api/health');
    const missing = [!h.transcription && 'OPENAI_API_KEY', !h.clipSelection && 'ANTHROPIC_API_KEY'].filter(Boolean);
    $('#health').textContent = missing.length ? `Missing in .env: ${missing.join(', ')}` : '';
    $('#health').classList.toggle('bad', missing.length > 0);
  } catch {}
}
function enterApp() {
  $('#auth').hidden = true; $('#app').hidden = false; $('#acct').hidden = false;
  renderMe(); health(); refresh();
  const b = new URLSearchParams(location.search).get('billing');
  if (b) {
    banner(b === 'success' ? 'Payment received. Your credits update as soon as Stripe confirms it, usually within a few seconds.' : 'Checkout was cancelled. You have not been charged.');
    history.replaceState({}, '', '/');
    if (b === 'success') setTimeout(refreshMe, 4000);
  }
}
(async () => {
  try { me = await api('/api/me'); enterApp(); } catch { showAuth(); }
})();

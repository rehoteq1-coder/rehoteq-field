/* =====================================================================
   app.js — REHOTEQ Field
   The flow: Technician -> Job -> Checklist -> Photos -> Sign-off ->
             Report -> PDF -> WhatsApp

   The curated troubleshooting library works offline. AI diagnosis is
   online-only, safety-first, and grounded in verified library guides; it
   never writes to a job card without technician confirmation.
   ===================================================================== */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const app = () => $('app');

  const S = {
    view: 'boot', user: null, trade: 'solar', job: null, jobs: [],
    photos: {}, sig: {}, libEntry: null, quote: null, lastBackup: null,
    passportEq: null, online: navigator.onLine, search: '', toastT: null,
    // The signed-in Firebase user, or null. Null is a perfectly good way
    // to use the app — signing in is optional, never required.
    fbUser: null,
    // The crew, once TEAM.load() has read it. Owners hold the company and
    // the member list; members hold only their own membership on S.user.
    team: null,
    // First-run landing mode: 'individual' technician or 'company' crew.
    onboardMode: 'individual',
    draftProfile: null,
    // V3 fault diagnosis state. Lives separately from S.job so nothing
    // enters a job card until the technician explicitly confirms a cause.
    diag: { trade: 'solar', fault: '', code: '', equipment: '', busy: false, result: null },
    accounts: [], usageLedger: { version: 1, reportIds: [], used: 0, count: 0 },
    workerCode: ''
  };

  const USAGE_LEDGER_KEY = 'rehoteq_usage_ledger_v1';
  const MAX_FREE_REPORTS = 3;
  let usageGate = Promise.resolve();

  function cloneRecord(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function normalizeUsageLedger(raw) {
    let source = raw;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch (e) { source = Number(source) || 0; }
    }
    const ids = [];
    let explicitCount = 0;
    if (Array.isArray(source)) {
      source.forEach(x => {
        const id = typeof x === 'string' ? x : x && (x.jobId || x.id);
        if (id && !ids.includes(String(id))) ids.push(String(id));
      });
      explicitCount = source.length;
    } else if (typeof source === 'number') {
      explicitCount = Math.max(0, Math.floor(source));
    } else if (source && typeof source === 'object') {
      const entries = Array.isArray(source.reportIds) ? source.reportIds
        : Array.isArray(source.jobIds) ? source.jobIds
          : Array.isArray(source.reports) ? source.reports : [];
      entries.forEach(x => {
        const id = typeof x === 'string' ? x : x && (x.jobId || x.id);
        if (id && !ids.includes(String(id))) ids.push(String(id));
      });
      explicitCount = Math.max(0, Math.floor(Number(source.used) || 0),
        Math.floor(Number(source.count) || 0), Math.floor(Number(source.total) || 0), entries.length);
    }
    for (let i = ids.length; i < explicitCount; i++) ids.push('legacy-slot-' + (i + 1));
    return { version: 1, reportIds: ids, used: ids.length, count: ids.length,
      updatedAt: source && source.updatedAt ? source.updatedAt : null };
  }

  function mergeUsageLedgers() {
    const ledgers = Array.from(arguments).map(normalizeUsageLedger);
    const ids = [];
    let maxCount = 0;
    ledgers.forEach(l => {
      l.reportIds.forEach(id => { if (!ids.includes(id)) ids.push(id); });
      maxCount = Math.max(maxCount, l.used);
    });
    for (let i = ids.length; i < maxCount; i++) ids.push('legacy-slot-' + (i + 1));
    return { version: 1, reportIds: ids, used: ids.length, count: ids.length, updatedAt: null };
  }

  async function persistUsageLedger(ledger) {
    const normalized = normalizeUsageLedger(ledger);
    normalized.updatedAt = new Date().toISOString();
    S.usageLedger = normalized;
    await DB.setMeta('usageLedger', normalized);
    try { localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(normalized)); } catch (e) { /* storage may be disabled */ }
    return normalized;
  }

  async function readUsageLedger() {
    const saved = await DB.getMeta('usageLedger').catch(() => null);
    let browserCopy = null;
    try { browserCopy = localStorage.getItem(USAGE_LEDGER_KEY); } catch (e) { /* storage may be disabled */ }
    return mergeUsageLedgers(saved, browserCopy);
  }

  async function loadUsageLedger() {
    const ledger = await readUsageLedger();
    const savedJobs = await DB.all('jobs').catch(() => []);
    savedJobs.forEach(job => {
      if (!job || !job.id || job.isDemo || job.companyId || !(job.lockedAt || job.status === 'sent')) return;
      if (!ledger.reportIds.includes(String(job.id))) ledger.reportIds.push(String(job.id));
    });
    ledger.used = ledger.reportIds.length;
    ledger.count = ledger.used;
    return persistUsageLedger(ledger);
  }

  async function canGenerateReport(job) {
    const reserve = async () => {
      if (!job || !job.id) return false;
      const ledger = await loadUsageLedger();
      if (job.isDemo || job.companyId || companyJob(job)) return true;
      if (hasProAccess()) return true;
      const reportId = String(job.id);
      if (ledger.reportIds.includes(reportId)) return true;
      if (ledger.used >= MAX_FREE_REPORTS) return false;
      ledger.reportIds.push(reportId);
      ledger.used = ledger.reportIds.length;
      ledger.count = ledger.used;
      await persistUsageLedger(ledger);
      return true;
    };
    const pending = usageGate.then(reserve, reserve);
    usageGate = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function loadAccounts() {
    const saved = await DB.getMeta('accounts');
    S.accounts = Array.isArray(saved) ? saved : [];
    return S.accounts;
  }

  async function saveAccount(profile) {
    if (!profile || !profile.uid) return [];
    const accounts = await loadAccounts();
    const i = accounts.findIndex(a => a && a.uid === profile.uid);
    const snapshot = cloneRecord(profile);
    snapshot.lastLoginAt = new Date().toISOString();
    if (i < 0) accounts.unshift(snapshot);
    else accounts[i] = snapshot;
    await DB.setMeta('accounts', accounts);
    S.accounts = accounts;
    return accounts;
  }

  function isOwnerEmail(email) {
    if (window.CONFIG && typeof CONFIG.isOwner === 'function') return CONFIG.isOwner(email);
    const e = String(email || '').trim().toLowerCase();
    return e === 'rehoteq@gmail.com' || e === 'rehoteq1@gmail.com';
  }

  function isOwnerAccount(u, fb) {
    const user = u !== undefined ? u : S.user;
    const fbU = fb !== undefined ? fb : S.fbUser;
    // A profile's explicit email is authoritative. In particular, an owner
    // must lose local owner mode immediately after changing that email.
    if (user && String(user.email || '').trim()) return isOwnerEmail(user.email);
    return Boolean(fbU && isOwnerEmail(fbU.email));
  }

  /* An unexpired 14-day trial clock means Pro. The server (Cloud
     Functions createAccount) is the only writer of the clock; the
     device can only read it. */
  function trialActive(u) {
    const user = u !== undefined ? u : S.user;
    if (!user || !user.trialEndsAt) return false;
    const t = new Date(user.trialEndsAt);
    return !isNaN(t.getTime()) && t.getTime() > Date.now();
  }

  /* One entitlement test for the whole app: an owner, a paid plan, or a
     running trial. Nothing else decides who gets Pro features. */
  function hasProAccess(u) {
    const user = u !== undefined ? u : S.user;
    if (isOwnerAccount(user)) return true;
    return ((user && user.plan) || 'free') !== 'free' || trialActive(user);
  }

  /* ---------------- account ----------------------------------------
     Sign-in exists only to answer three questions the device cannot
     answer for itself: are you actually Pro, when does your trial end,
     and who are your technicians. Nothing about doing a job needs it.
     ------------------------------------------------------------------ */
  function accountCard() {
    const u = S.fbUser;
    if (u) {
      return `
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Account</div>
          <div class="cb" style="display:flex;align-items:center;gap:11px">
            ${u.photo
              ? '<img src="' + esc(u.photo) + '" alt="" style="width:38px;height:38px;border-radius:50%;flex:none">'
              : '<div style="width:38px;height:38px;border-radius:50%;flex:none;background:var(--primary-l);display:grid;place-items:center;color:var(--primary-d);font-weight:800">'
                + esc((u.name || u.email || '?').charAt(0).toUpperCase()) + '</div>'}
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:13.5px">${esc(u.name || 'Signed in')}</div>
              <div style="font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis">${esc(u.email)}</div>
              <div style="font-size:11px;font-weight:700;color:var(--primary);margin-top:2px">${planLine()}</div>
            </div>
          </div>
          <div class="srow" onclick="ACT.signOut()"><span class="si">${ICON('log-out', 17)}</span>
            <span class="sl">Sign out</span><span style="color:#94A3B8">›</span></div>
        </div>`;
    }
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="ch">Account</div>
        <div class="cb">
          <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:11px">
            You do not need an account. Every job card, report and photo works
            offline without one. Signing in is only for your subscription and,
            later, your team.
          </div>
          <button class="btn primary" style="width:100%" onclick="ACT.signIn()">
            ${ICON('log-in', 17)} Sign in with Google</button>
        </div>
      </div>`;
  }

  /* ---------------- helpers ---------------------------------------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function money(n) {
    return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  }
  function dstr(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function planLine() {
    if (isOwnerAccount()) return 'Owner access · all plans unlocked';
    if (trialActive()) return 'Pro trial · ends ' + dstr(S.user && S.user.trialEndsAt);
    if (((S.user && S.user.plan) || 'free') !== 'free') return 'Pro';
    return 'Free plan';
  }
  function tstr(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function uid() { return IMG.uid(); }
  function toast(msg, sub) {
    const t = $('toast');
    t.innerHTML = esc(msg) + (sub ? '<span class="s">' + esc(sub) + '</span>' : '');
    t.classList.add('show');
    clearTimeout(S.toastT);
    S.toastT = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function go(view) { S.view = view; render(); }

  // Nag, but only when it is actually true: never-backed-up with real work
  // on the phone, or a backup that has gone stale.
  function needsBackup() {
    const n = S.jobs.length;
    if (n < 3) return false;
    if (!S.lastBackup) return true;
    const age = (Date.now() - new Date(S.lastBackup).getTime()) / 864e5;
    return n >= 10 && age > 7;
  }
  // Plain text, safe to wrap in esc(). For the mark itself use tradeIcon:
  // an SVG pushed through esc() would arrive as escaped markup.
  function tradeName(id) {
    const t = DATA.TRADES.find(x => x.id === id);
    return t ? t.name : id;
  }
  function tradeIcon(id, size) {
    const t = DATA.TRADES.find(x => x.id === id);
    return ICON(t ? t.icon : 'wrench', size || 16);
  }

  /* ---------------- job lifecycle ---------------------------------- */
  // Derived from the jobs we actually hold, so a restore can never hand out
  // a reference that already exists.
  async function nextRef() {
    const jobs = await DB.all('jobs');
    let max = 0;
    jobs.forEach(j => {
      const m = /(\d{1,6})$/.exec(String(j.ref || ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'RF-' + new Date().getFullYear() + '-' + String(max + 1).padStart(5, '0');
  }

  /* ---------------- backup ------------------------------------------- */
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        res(s.slice(s.indexOf(',') + 1));
      };
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'image/jpeg' });
  }

  async function newJob() {
    const ref = await nextRef();
    return {
      id: uid(), ref: ref, trade: S.trade, jobType: '',
      customer: { name: '', phone: '', address: '' },
      site: { address: '', lat: null, lng: null },
      equipment: { category: '', model: '', serial: '', capacity: '', installDate: '' },
      instructions: '', fault: '', diagnosis: '', work: '', recommendation: '',
      materials: [], labour: 0, checklist: null,
      signatures: { customer: null, technician: null },
      status: 'draft', startedAt: new Date().toISOString(),
      completedAt: null, lockedAt: null, createdAt: new Date().toISOString(),
      hashes: []
    };
  }

  async function saveJob() {
    if (!S.job) return;
    S.job.updatedAt = new Date().toISOString();
    await DB.put('jobs', JSON.parse(JSON.stringify(S.job)));
    DB.queue({ type: 'job.upsert', id: S.job.id });
    await refreshJobs();
  }

  async function refreshJobs() {
    S.jobs = (await DB.all('jobs')).filter(j => !j.deletedAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /* ---------------- photos ------------------------------------------ */
  async function loadPhotos(jobId) {
    const all = await DB.all('photos');
    const mine = all.filter(p => p.jobId === jobId && !p.deletedAt);
    const by = { before: [], during: [], after: [], serial: [] };
    mine.forEach(p => {
      // A restored backup can carry a photo record whose image data did not
      // survive. createObjectURL(null) throws, so never call it unguarded.
      if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob);
      (by[p.stage] = by[p.stage] || []).push(p);
    });
    S.photos[jobId] = by;
    return by;
  }

  async function pickPhoto(stage) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      toast('Processing photo…');
      const j = S.job;
      const stamp = {
        line1: dstr(new Date().toISOString()) + '  ' + tstr(new Date().toISOString()),
        line2: (j.site.lat !== null && j.site.lat !== undefined
          ? Math.abs(j.site.lat).toFixed(4) + (j.site.lat >= 0 ? 'N ' : 'S ') +
            Math.abs(j.site.lng).toFixed(4) + (j.site.lng >= 0 ? 'E' : 'W') + ' · '
          : '') + (S.user && S.user.name ? S.user.name + ' · ' : '') + j.ref
      };
      const out = await IMG.processPhoto(f, stamp, 350);
      const sha = await IMG.sha256(out.blob);
      const rec = {
        id: uid(), jobId: j.id, stage: stage, blob: out.blob,
        sha256: sha, w: out.width, h: out.height, bytes: out.blob.size,
        lat: j.site.lat, lng: j.site.lng, capturedAt: new Date().toISOString(),
        device: navigator.userAgent.slice(0, 60)
      };
      await DB.put('photos', rec);
      DB.queue({ type: 'photo.upload', id: rec.id });
      j.hashes = j.hashes || [];
      j.hashes.push(sha);
      await saveJob();
      await loadPhotos(j.id);
      toast('Saved — ' + (out.bytes / 1024).toFixed(0) + ' KB', 'Time, GPS and name stamped into the image');
      render();
    };
    input.click();
  }

  /* ---------------- logo --------------------------------------------
     The logo lands on every PDF he sends, so it has to be small enough to
     sit inside a backup file and simple enough to survive one: a 256 px
     JPEG on a white background, kept as a data URL so it round-trips
     through the JSON backup like any other string.
     Transparent PNGs flatten onto white — JPEG has no alpha, and a logo
     on a printed document is on paper anyway.
  -------------------------------------------------------------------- */
  async function compressLogo(file) {
    const bmp = await IMG.loadBitmap(file);
    const MAX = 256;
    const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return { dataUrl: cv.toDataURL('image/jpeg', 0.86), w: w, h: h };
  }

  /* ---------------- gps --------------------------------------------- */
  function getGps(cb) {
    if (!navigator.geolocation) { toast('No GPS on this device'); return; }
    toast('Getting location…');
    navigator.geolocation.getCurrentPosition(
      p => cb({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => toast('Could not get location', 'Turn on location services, or type the address')
    , { enableHighAccuracy: true, timeout: 12000 });
  }

  /* ---------------- signatures -------------------------------------- */
  function bindSig(canvas, onEnd) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    function size() {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0F172A';
    }
    size();
    let drawing = false, last = null, moved = false;
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); moved = true; }
    function move(e) {
      if (!drawing) return; e.preventDefault();
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
    }
    function end() { drawing = false; if (moved && onEnd) onEnd(canvas.toDataURL('image/png')); }
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', () => { if (drawing) { drawing = false; if (moved && onEnd) end(); } });
    return {
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); moved = false; }
    };
  }

  async function dataUrlToJpeg(dataUrl) {
    const img = new Image();
    // Guard: if the image never decodes, fail loudly rather than leaving the
    // technician staring at "Building PDF…" forever.
    await Promise.race([
      new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('image decode timed out')), 6000))
    ]);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
    return { bytes: await IMG.blobToBytes(blob), w: img.width, h: img.height };
  }

  /* ---------------- pdf --------------------------------------------- */
  function pdfBlob(bytes) { return new Blob([bytes], { type: 'application/pdf' }); }

  async function makeReportPdf() {
    const j = S.job;
    const by = await loadPhotos(j.id);
    const withBytes = {};
    for (const stage of Object.keys(by)) {
      withBytes[stage] = [];
      for (const p of by[stage]) withBytes[stage].push(Object.assign({}, p, { bytes: await IMG.blobToBytes(p.blob) }));
    }
    const sigs = {};
    for (const role of ['customer', 'technician']) {
      const s = j.signatures && j.signatures[role];
      if (s && s.dataUrl) sigs[role] = Object.assign(await dataUrlToJpeg(s.dataUrl), { name: s.name, at: s.at });
    }
    return pdfBlob(REPORT.buildReport(j, withBytes, sigs, docProfile()));
  }

  /* ---------------- team (Business, offline edition) ------------------
     A crew without a server. Invites, assignments and updates travel as
     files over WhatsApp, and every record is shaped to match the
     Firestore model in FIREBASE_PLAN.md — when sync lands, these objects
     map onto companies/{id}, members/{uid} and jobs/{jobId} instead of
     being redesigned.

     Honest limits of this edition (stated on screen, not just here):
     - nothing arrives by itself; every transfer is a file someone sends
     - removing a technician frees the seat at once, but their phone keeps
       the company stamp until they import the removal notice
     - extra seats are self-declared after payment and verified at sync
     ------------------------------------------------------------------ */
  const TEAM_FORMAT = 'rehoteq-field-team';
  // No 0/O/1/I: a code read over the phone must survive the call.
  const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function teamState() {
    if (!S.team) S.team = { company: null, members: [], invites: [], workerLogins: [], seats: null, sel: null };
    if (!S.team.seats) S.team.seats = { paid: DATA.PLANS.business.seats, selfDeclared: false, claimedAt: null };
    if (!Array.isArray(S.team.members)) S.team.members = [];
    if (!Array.isArray(S.team.invites)) S.team.invites = [];
    if (!Array.isArray(S.team.workerLogins)) S.team.workerLogins = [];
    return S.team;
  }

  function myUid() { return S.user && S.user.uid; }

  function myRole() {
    const t = teamState();
    if (t.company && myUid() && t.company.ownerId === myUid()) return 'owner';
    if (S.user && S.user.memberOf && S.user.memberOf.companyId) return 'member';
    return 'none';
  }

  function myCompanyName() {
    const t = teamState();
    if (t.company && t.company.name) return t.company.name;
    if (S.user && S.user.memberOf && S.user.memberOf.branding) return S.user.memberOf.branding.name || '';
    return '';
  }

  // A job is company work when it carries the crew's id — whether this
  // phone is the owner's or the technician's. Company work never burns
  // the technician's free reports: the crew's subscription covers it.
  function companyJob(j) {
    if (!j || !j.companyId) return false;
    const t = teamState();
    if (t.company && j.companyId === t.company.id) return true;
    return !!(S.user && S.user.memberOf && j.companyId === S.user.memberOf.companyId);
  }

  // The owner's copy of an assigned job. It is a shadow: the technician's
  // phone is the source of truth, updates arrive as files, and editing it
  // here would be silently overwritten by the next update — so it opens
  // read-only instead.
  function isShadow(j) {
    const t = teamState();
    return myRole() === 'owner' && !!j && !!j.assignedTo &&
      !!(t.company && j.companyId === t.company.id) && j.assignedTo !== myUid();
  }

  function isMine(j) { return !!j && !!j.assignedTo && j.assignedTo === myUid(); }

  function statusLabel(s) {
    return { draft: 'Draft', assigned: 'Assigned', 'in-progress': 'In progress',
      completed: 'Completed', sent: 'Sent' }[s] || 'Draft';
  }

  function memberById(id) { return teamState().members.find(m => m.memberId === id); }
  function memberName(id) { const m = memberById(id); return m ? m.name : 'Crew'; }
  function memberJobs(id) { return S.jobs.filter(j => j.assignedTo === id); }
  function lastUpdateFor(id) {
    const at = memberJobs(id).map(j => j.updatedAt || j.assignedAt || j.createdAt).filter(Boolean).sort();
    return at.length ? at[at.length - 1] : null;
  }

  function teamStatusLine() {
    const t = teamState();
    const r = myRole();
    if (r === 'owner') return (t.company ? t.company.name : 'Crew') + ' · ' + t.members.length + ' techs';
    if (r === 'member') return myCompanyName() || 'Crew';
    return 'Run a crew, or join one';
  }

  // The branding printed on documents. A technician under a company sends
  // company-stamped PDFs; everyone else sends their own. The personal name
  // is always the sender's own — the stamp must say who did the work.
  function docProfile() {
    const u = S.user || {};
    const t = teamState();
    const co = (myRole() === 'owner' && t.company) || (u.memberOf && u.memberOf.branding) || null;
    if (!co) return u;
    return {
      name: u.name, phone: co.phone || u.phone,
      company: co.name, address: co.address, email: co.email,
      bank: co.bank, bio: co.bio, logo: co.logo || u.logo || null
    };
  }

  async function teamSave() {
    const t = teamState();
    await DB.setMeta('company', t.company);
    await DB.setMeta('teamMembers', t.members);
    await DB.setMeta('teamInvites', t.invites);
    await DB.setMeta('workerLogins', t.workerLogins);
    await DB.setMeta('teamSeats', t.seats);
  }

  async function teamLoad() {
    const t = teamState();
    t.company = await DB.getMeta('company');
    t.members = (await DB.getMeta('teamMembers')) || [];
    t.invites = (await DB.getMeta('teamInvites')) || [];
    t.workerLogins = (await DB.getMeta('workerLogins')) || [];
    t.seats = (await DB.getMeta('teamSeats')) ||
      { paid: DATA.PLANS.business.seats, selfDeclared: false, claimedAt: null };
    if (S.user && !S.user.uid) {
      // Installs from before teams existed have no uid. Mint one now, so
      // invites and assignments have an identity to point at.
      S.user.uid = IMG.uid();
      await DB.setMeta('user', S.user);
    }
    return t;
  }

  function makeCode() {
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)];
    return 'RQ-' + s.slice(0, 4) + '-' + s.slice(4);
  }

  function brandSnapshot(company) {
    return {
      name: company.name, address: company.address || '', phone: company.phone || '',
      email: company.email || '', bank: company.bank || '', bio: company.bio || '',
      logo: company.logo || null
    };
  }

  // Photo records for a team file. Same shape as the backup format, and
  // the same rule: one unreadable photo must never sink the transfer.
  async function packPhotos(jobId) {
    const all = await DB.all('photos');
    const recs = [];
    for (const p of all) {
      if (p.jobId !== jobId || p.deletedAt) continue;
      let image = null;
      try { if (p.blob) image = await blobToBase64(p.blob); } catch (e) { image = null; }
      recs.push({ id: p.id, jobId: p.jobId, stage: p.stage, sha256: p.sha256,
        capturedAt: p.capturedAt, lat: p.lat, lng: p.lng, w: p.w, h: p.h,
        device: p.device, image: image });
    }
    return recs;
  }

  async function unpackPhotos(recs) {
    let added = 0, noImage = 0;
    for (const p of (recs || [])) {
      const rec = Object.assign({}, p);
      if (rec.image) {
        try { rec.blob = base64ToBlob(rec.image, 'image/jpeg'); }
        catch (e) { rec.blob = null; noImage++; }
      } else { noImage++; }
      delete rec.image;
      if (!rec.url && rec.blob) {
        try { rec.url = URL.createObjectURL(rec.blob); } catch (e) { rec.url = null; }
      }
      const existing = await DB.get('photos', rec.id);
      if (!existing) added++;
      await DB.put('photos', rec);
    }
    return { added: added, noImage: noImage };
  }

  // Every operation below returns { ok } and never throws for an expected
  // failure — a wrong file, a full crew, a stranger's job. ACT turns the
  // error code into words via teamErr(). Exposed as window.TEAM so the
  // test suite can run the whole round trip for real: invite, join,
  // assign, update, dashboard.
  const TEAM = {
    load: teamLoad,
    save: teamSave,
    role: myRole,
    docProfile: docProfile,
    companyJob: companyJob,
    isShadow: isShadow,
    isMine: isMine,
    statusLabel: statusLabel,
    memberName: memberName,
    memberJobs: memberJobs,

    seats() {
      const t = teamState();
      return { used: t.members.length, paid: (t.seats && t.seats.paid) || DATA.PLANS.business.seats };
    },

    workerLogins() { return teamState().workerLogins.slice(); },

    async createWorkerLogin(details) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      if (!S.user || S.user.plan !== 'business') return { ok: false, error: 'business' };
      const active = t.workerLogins.filter(w => w && w.status !== 'revoked');
      const workerSlots = new Set(t.members.map(m => String(m.memberId))
        .concat(active.map(w => String(w.workerId || w.code))));
      if (workerSlots.size >= DATA.PLANS.business.seats) return { ok: false, error: 'full' };
      const input = typeof details === 'string' ? { name: details } : (details || {});
      let code = makeCode();
      while (t.workerLogins.some(w => w && w.code === code) ||
             t.invites.some(i => i && i.code === code)) code = makeCode();
      const worker = {
        workerId: 'WK-' + IMG.uid(),
        name: String(input.name || '').trim() || 'Worker ' + (workerSlots.size + 1),
        phone: String(input.phone || '').trim(),
        trade: DATA.TRADES.some(x => x.id === input.trade) ? input.trade : 'electrical',
        code: code, status: 'waiting', createdAt: new Date().toISOString()
      };
      t.workerLogins.push(worker);
      await teamSave();
      DB.queue({ type: 'team.worker-login', id: worker.workerId });
      return { ok: true, worker: worker, file: TEAM.workerLoginFile(code) };
    },

    workerLoginFile(code) {
      const t = teamState();
      const worker = t.workerLogins.find(w => w && w.code === String(code || '').toUpperCase());
      if (!worker || !t.company) return null;
      return {
        format: TEAM_FORMAT, kind: 'worker-login', code: worker.code,
        companyId: t.company.id, companyName: t.company.name,
        ownerName: t.company.ownerName || '', branding: brandSnapshot(t.company),
        worker: cloneRecord(worker), createdAt: worker.createdAt
      };
    },

    async importWorkerLogin(file) {
      const code = String(file && (file.code || (file.worker && file.worker.code)) || '').trim().toUpperCase();
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'worker-login') {
        return { ok: false, error: 'notworkerfile' };
      }
      if (!/^RQ-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) || !file.companyId ||
          !file.branding || !file.branding.name || !file.worker ||
          file.worker.code !== code || !file.worker.workerId) {
        return { ok: false, error: 'damaged' };
      }
      const imported = (await DB.getMeta('workerLoginFiles')) || [];
      const index = imported.findIndex(x => x && x.code === code);
      const saved = cloneRecord(file);
      if (index < 0) imported.push(saved); else imported[index] = saved;
      await DB.setMeta('workerLoginFiles', imported);
      S.workerCode = code;
      return { ok: true, company: file.branding.name, code: code };
    },

    async loginWithWorkerCode(code) {
      const normalized = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!/^RQ-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) return { ok: false, error: 'nocode' };
      const imported = (await DB.getMeta('workerLoginFiles')) || [];
      let file = imported.find(x => x && x.code === normalized) || null;
      if (!file) file = TEAM.workerLoginFile(normalized);
      if (!file) return { ok: false, error: 'nocode' };
      const worker = file.worker || {};
      const accounts = (await DB.getMeta('accounts')) || [];
      const previous = accounts.find(a => a && a.uid === worker.workerId) || {};
      const priorMemberOf = previous.memberOf || {};
      const user = Object.assign({}, previous, {
        uid: worker.workerId,
        name: worker.name || previous.name || 'Worker',
        phone: worker.phone || previous.phone || '',
        trade: worker.trade || previous.trade || 'electrical',
        company: (file.branding && file.branding.name) || file.companyName || 'Company crew',
        plan: 'free', ownerAccess: false,
        memberOf: {
          companyId: file.companyId,
          code: normalized,
          branding: cloneRecord(file.branding),
          ownerName: file.ownerName || '',
          joinedAt: priorMemberOf.joinedAt || new Date().toISOString(),
          sent: Boolean(priorMemberOf.sent), workerCode: true
        }
      });
      S.user = user;
      S.team = null;
      await DB.setMeta('user', user);
      await saveAccount(user);
      await teamLoad();
      return { ok: true, user: user, company: user.company };
    },

    async createCompany() {
      if (!S.user) return { ok: false, error: 'noprofile' };
      const t = teamState();
      if (t.company) return { ok: false, error: 'exists' };
      if (S.user.memberOf) return { ok: false, error: 'member' };
      const u = S.user;
      t.company = {
        id: 'CO-' + (u.uid || IMG.uid()),
        ownerId: u.uid, ownerName: u.name,
        name: u.company || 'My company',
        address: u.address || '', phone: u.phone || '', email: u.email || '',
        bank: u.bank || '', bio: u.bio || '', logo: u.logo || null,
        createdAt: new Date().toISOString()
      };
      await teamSave();
      DB.queue({ type: 'team.company', id: t.company.id });
      return { ok: true, company: t.company };
    },

    async saveCompany(patch) {
      const t = teamState();
      if (!t.company || myRole() !== 'owner') return { ok: false, error: 'notowner' };
      Object.assign(t.company, patch);
      await teamSave();
      return { ok: true };
    },

    async makeInvite() {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      let code = makeCode();
      while (t.invites.some(i => i && i.code === code) ||
             t.workerLogins.some(w => w && w.code === code)) code = makeCode();
      const inv = { code: code, companyId: t.company.id, status: 'waiting', createdAt: new Date().toISOString() };
      t.invites.push(inv);
      await teamSave();
      DB.queue({ type: 'team.invite', id: code });
      return { ok: true, invite: inv, file: TEAM.inviteFile(code) };
    },

    inviteFile(code) {
      const t = teamState();
      const inv = t.invites.find(i => i.code === code && i.status === 'waiting');
      if (!inv || !t.company) return null;
      return { format: TEAM_FORMAT, kind: 'invite', code: code, companyId: t.company.id,
        ownerName: t.company.ownerName, branding: brandSnapshot(t.company), createdAt: inv.createdAt };
    },

    async revokeInvite(code) {
      const t = teamState();
      t.invites = t.invites.filter(i => i.code !== code);
      await teamSave();
      return { ok: true };
    },

    async applyInvite(file) {
      if (!S.user) return { ok: false, error: 'noprofile' };
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'invite') return { ok: false, error: 'notinvite' };
      if (!file.branding || !file.branding.name || !file.companyId) return { ok: false, error: 'damaged' };
      const t = teamState();
      if (t.company) return { ok: false, error: 'runscrew' };
      const cur = S.user.memberOf;
      if (cur && cur.companyId === file.companyId) return { ok: false, error: 'already' };
      if (cur) return { ok: false, error: 'elsewhere' };
      S.user.memberOf = { companyId: file.companyId, code: file.code,
        branding: file.branding, ownerName: file.ownerName || '',
        joinedAt: new Date().toISOString(), sent: false };
      await DB.setMeta('user', S.user);
      await saveAccount(S.user);
      return { ok: true, company: file.branding.name };
    },

    acceptanceFile() {
      const m = S.user && S.user.memberOf;
      if (!m) return null;
      return { format: TEAM_FORMAT, kind: 'acceptance', code: m.code, companyId: m.companyId,
        member: { memberId: myUid(), name: S.user.name, phone: S.user.phone || '', joinedAt: m.joinedAt } };
    },

    async markAcceptanceSent() {
      if (S.user && S.user.memberOf) {
        S.user.memberOf.sent = true;
        await DB.setMeta('user', S.user);
        await saveAccount(S.user);
      }
    },

    async applyAcceptance(file) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'acceptance') return { ok: false, error: 'notaccept' };
      if (file.companyId !== t.company.id) return { ok: false, error: 'wrongcrew' };
      const inv = t.invites.find(i => i.code === file.code);
      const workerLogin = t.workerLogins.find(w => w.code === file.code);
      if (!inv && !workerLogin) return { ok: false, error: 'nocode' };
      const m = file.member || {};
      if (!m.memberId || !m.name) return { ok: false, error: 'damaged' };
      if (workerLogin && m.memberId !== workerLogin.workerId) return { ok: false, error: 'notyou' };
      // Re-importing an acceptance (the file got sent twice) updates the
      // record instead of eating a second seat.
      const dup = t.members.find(x => x.memberId === m.memberId);
      if (dup) {
        dup.name = m.name; dup.phone = m.phone || dup.phone;
        if (inv) inv.status = 'joined';
        if (workerLogin) { workerLogin.status = 'joined'; workerLogin.memberId = m.memberId; }
        await teamSave();
        return { ok: true, member: dup, again: true };
      }
      const s = TEAM.seats();
      if (s.used >= s.paid) return { ok: false, error: 'full' };
      const rec = { memberId: m.memberId, name: m.name, phone: m.phone || '',
        joinedAt: m.joinedAt || new Date().toISOString(), code: file.code };
      t.members.push(rec);
      if (inv) inv.status = 'joined';
      if (workerLogin) { workerLogin.status = 'joined'; workerLogin.memberId = m.memberId; workerLogin.name = m.name; }
      await teamSave();
      DB.queue({ type: 'team.join', id: rec.memberId });
      return { ok: true, member: rec };
    },

    async makeAssignment(jobId, memberId) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      const member = memberById(memberId);
      if (!member) return { ok: false, error: 'nomember' };
      const job = await DB.get('jobs', jobId);
      if (!job) return { ok: false, error: 'nojob' };
      if (job.lockedAt) return { ok: false, error: 'locked' };
      job.companyId = t.company.id;
      job.ownerId = t.company.ownerId;
      job.assignerName = t.company.ownerName;
      job.assignedTo = memberId;
      job.assignedAt = new Date().toISOString();
      job.status = 'assigned';
      job.updatedAt = new Date().toISOString();
      await DB.put('jobs', JSON.parse(JSON.stringify(job)));
      DB.queue({ type: 'team.assign', id: job.id });
      await refreshJobs();
      if (S.job && S.job.id === job.id) S.job = JSON.parse(JSON.stringify(job));
      const photos = await packPhotos(job.id);
      return { ok: true, member: member, file: {
        format: TEAM_FORMAT, kind: 'assignment', companyId: t.company.id,
        ownerName: t.company.ownerName, companyName: t.company.name,
        job: JSON.parse(JSON.stringify(job)), photos: photos
      } };
    },

    async applyAssignment(file) {
      if (!S.user) return { ok: false, error: 'noprofile' };
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'assignment' || !file.job) {
        return { ok: false, error: 'notassign' };
      }
      const m = S.user.memberOf;
      if (!m || m.companyId !== file.companyId) return { ok: false, error: 'wrongcrew' };
      if (file.job.assignedTo !== myUid()) return { ok: false, error: 'notyou' };
      const local = await DB.get('jobs', file.job.id);
      if (local && local.lockedAt) return { ok: false, error: 'locked' };
      const job = file.job;
      job.updatedAt = new Date().toISOString();
      await DB.put('jobs', JSON.parse(JSON.stringify(job)));
      const ph = await unpackPhotos(file.photos);
      await refreshJobs();
      return { ok: true, job: job, photos: ph.added };
    },

    async makeUpdate(jobId) {
      const job = await DB.get('jobs', jobId);
      if (!job) return { ok: false, error: 'nojob' };
      if (!isMine(job)) return { ok: false, error: 'notyou' };
      const photos = await packPhotos(job.id);
      return { ok: true, file: {
        format: TEAM_FORMAT, kind: 'update', companyId: job.companyId,
        job: JSON.parse(JSON.stringify(job)), photos: photos
      } };
    },

    async applyUpdate(file) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'update' || !file.job) {
        return { ok: false, error: 'notupdate' };
      }
      if (file.job.companyId !== t.company.id) return { ok: false, error: 'wrongcrew' };
      if (!memberById(file.job.assignedTo)) return { ok: false, error: 'nomember' };
      // The technician's phone is the source of truth for this job: the
      // update replaces the shadow outright. The owner's copy is never
      // edited (it opens read-only), so nothing of value is lost.
      const job = file.job;
      job.updatedAt = new Date().toISOString();
      await DB.put('jobs', JSON.parse(JSON.stringify(job)));
      const ph = await unpackPhotos(file.photos);
      DB.queue({ type: 'team.update', id: job.id });
      await refreshJobs();
      if (S.job && S.job.id === job.id) S.job = JSON.parse(JSON.stringify(job));
      return { ok: true, job: job, photos: ph.added };
    },

    async makeRemoval(memberId) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      const member = memberById(memberId);
      if (!member) return { ok: false, error: 'nomember' };
      t.members = t.members.filter(x => x.memberId !== memberId);
      await teamSave();
      DB.queue({ type: 'team.remove', id: memberId });
      return { ok: true, member: member, file: {
        format: TEAM_FORMAT, kind: 'removal', companyId: t.company.id,
        companyName: t.company.name, memberId: memberId
      } };
    },

    async applyRemoval(file) {
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'removal') return { ok: false, error: 'notremoval' };
      const m = S.user && S.user.memberOf;
      if (!m || m.companyId !== file.companyId) return { ok: false, error: 'wrongcrew' };
      if (myUid() !== file.memberId) return { ok: false, error: 'notyou' };
      const name = (m.branding && m.branding.name) || 'your crew';
      delete S.user.memberOf;
      await DB.setMeta('user', S.user);
      await saveAccount(S.user);
      return { ok: true, company: name };
    },

    async leaveTeam() {
      if (!S.user || !S.user.memberOf) return { ok: false, error: 'none' };
      const m = S.user.memberOf;
      const name = (m.branding && m.branding.name) || 'your crew';
      delete S.user.memberOf;
      await DB.setMeta('user', S.user);
      await saveAccount(S.user);
      return { ok: true, company: name };
    },

    // Extra seats, honestly labelled: the app cannot verify a payment
    // without a server, so the claim is recorded (and queued for sync)
    // and REHOTEQ verifies it when the server lands.
    async claimSeats(n) {
      const t = teamState();
      if (myRole() !== 'owner') return { ok: false, error: 'notowner' };
      n = Math.floor(Number(n) || 0);
      if (n < 1 || n > 20) return { ok: false, error: 'badcount' };
      t.seats.paid += n;
      t.seats.selfDeclared = true;
      t.seats.claimedAt = new Date().toISOString();
      await teamSave();
      DB.queue({ type: 'team.seats.claimed', id: String(n) });
      return { ok: true, paid: t.seats.paid, added: n };
    },

    // The crew rides inside the normal backup: an owner who loses their
    // phone loses the member list too unless it is backed up with the jobs.
    serialize() {
      const t = teamState();
      if (!t.company && !t.members.length && !t.invites.length && !t.workerLogins.length) return null;
      return { company: t.company, members: t.members, invites: t.invites,
        workerLogins: t.workerLogins, seats: t.seats };
    },

    async restore(saved) {
      if (!saved) return { ok: true, company: false, membersAdded: 0 };
      const t = teamState();
      let company = false, membersAdded = 0;
      if (saved.company && (!t.company || t.company.id === saved.company.id)) {
        t.company = saved.company;
        company = true;
      }
      (saved.members || []).forEach(m => {
        if (m && m.memberId && !memberById(m.memberId)) { t.members.push(m); membersAdded++; }
      });
      (saved.invites || []).forEach(i => {
        if (i && i.code && !t.invites.find(x => x.code === i.code)) t.invites.push(i);
      });
      (saved.workerLogins || []).forEach(w => {
        if (w && w.code && !t.workerLogins.find(x => x.code === w.code)) t.workerLogins.push(w);
      });
      if (saved.seats && Number(saved.seats.paid) > t.seats.paid) t.seats = saved.seats;
      await teamSave();
      return { ok: true, company: company, membersAdded: membersAdded };
    },

    packPhotos: packPhotos,
    unpackPhotos: unpackPhotos,

    // Test seam: simulates the second phone. There is no other honest way
    // to run an owner and a technician through one test window — S is a
    // closure, and the suite must drive the real functions, not copies.
    _testAs(u) { S.user = u || null; S.team = null; teamState(); }
  };
  window.TEAM = TEAM;

  function teamErr(code) {
    return {
      noprofile: ['Create your profile first', 'The team needs a name to attach'],
      notowner: ['Only the crew owner can do that', null],
      notyou: ['That file is for someone else', 'Check with your oga'],
      wrongcrew: ['That file belongs to another crew', 'You can only work with one crew at a time'],
      damaged: ['That file is damaged', 'Ask them to send it again'],
      notteam: ['That is not a team file', 'Pick the file the app sent, ending in .json'],
      backup: ['That is a backup file', 'Use Restore from backup in Settings'],
      business: ['Business plan required', 'Worker login codes are available to Business company owners'],
      notworkerfile: ['That is not a worker login file', 'Ask the company owner to send the REHOTEQ worker file'],
      exists: ['You already run a crew', null],
      member: ['You work with a crew already', 'Leave it first, then start your own'],
      runscrew: ['You run a crew — crews cannot join crews', null],
      already: ['You already joined this crew', null],
      elsewhere: ['You already work with another crew', 'Leave it first'],
      notinvite: ['That is not an invite', null],
      notaccept: ['That is not an acceptance', null],
      nocode: ['No invite matches that code', 'It may have been revoked'],
      full: ['All seats are taken', 'Add seats below, then import the acceptance again'],
      nomember: ['That technician is not on your crew', null],
      nojob: ['Job not found on this phone', null],
      locked: ['That job is signed and locked', 'Locked evidence cannot be reassigned'],
      notassign: ['That is not an assigned job', null],
      notupdate: ['That is not a job update', null],
      notremoval: ['That is not a removal notice', null],
      badcount: ['How many seats? Enter 1 to 20', null],
      none: ['You are not in a crew', null]
    }[code] || ['Something went wrong', 'Ask them to send the file again'];
  }

  // Team files leave the phone the same way backups do: the share sheet
  // when the device has one, Downloads when it does not.
  async function shareTeamFile(obj, filename, sentMsg) {
    const json = JSON.stringify(obj);
    const file = new File([json], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        toast(sentMsg || 'Sent', 'Choose WhatsApp from the share sheet');
        return true;
      } catch (e) { return false; }
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('Saved to Downloads — ' + filename, 'Send it on WhatsApp yourself');
    return true;
  }

  /* ---------------- V3 fault diagnosis (`DIAG`) -----------------------
     Spec §7 Layer 3 — the four non-negotiable rules:
       1. Safety block first, always (hard-coded preamble + guide safety).
       2. Render as structured cards, never a wall of chat prose.
       3. Nothing enters the job card until the technician confirms a cause.
       4. Refuse out of scope (domestic gas, structural, medical, utility HV).
     And the honesty rule:
       • Online-only (calls `aiProxy` on the server so the Groq key never
         ships in this app).
       • If the curated library has no verified entry for the fault, say so
         plainly — never guess or invent a fault code.
     Exposed as window.DIAG so the test suite can verify every rule.
     ------------------------------------------------------------------ */
  const DIAG_SAFETY = {
    electrical: 'ISOLATE FIRST: Switch off at the main isolator, lock off, and prove dead with a tested meter on every conductor before opening the DB board or touching terminations.',
    solar: 'ISOLATE FIRST: Switch off AC supply and inverter before opening any panel. PV strings stay live in daylight — cover panels or open the DC isolator before touching terminations. Remove rings, watches and bangles.',
    cctv: 'ISOLATE FIRST: Disconnect camera and NVR power before re-terminating. Use a stable ladder and never work at height in rain, wind or near overhead mains.',
    networking: 'ISOLATE FIRST: Never run data cable in the same conduit as mains power. Never look into an open fibre connector or open the ISP ONT.',
    hvac: 'ISOLATE FIRST: Isolate indoor and outdoor unit supplies, lock off and prove dead before opening. Wait for capacitors to discharge; do not vent refrigerant or open a sealed circuit unless qualified.',
    generator: 'ISOLATE FIRST: Run generators outdoors only because carbon monoxide can kill without warning. Disable automatic start, isolate generator and utility sources, and prevent back-feed before servicing.',
    plumbing: 'ISOLATE FIRST: Shut off and depressurise water before opening pipework; let hot water cool. Keep clear of nearby electrical equipment and isolate it safely if water is present.',
    fire_access: 'LIFE SAFETY: Notify the site responsible person and monitoring station before testing, obtain an impairment permit and fire watch, and never leave alarm or sprinkler zones bypassed.',
    smarthome: 'ISOLATE FIRST: Isolate and prove dead before opening mains-connected smart devices. Keep extra-low-voltage wiring separate from mains and never collect a customer password.',
    ev: 'ISOLATE FIRST: EV charger circuits carry sustained high current. Isolate, lock off and prove dead; verify earthing and DC-capable residual-current protection to OEM and local requirements.'
  };

  const DIAG_OUT_OF_SCOPE = [
    {
      id: 'gas',
      re: /\b(gas\s+(leak|cylinder|cooker|pipe|smell|burner|valve|line)|lpg|cooking\s+gas|butane|propane)\b/i,
      specialist: 'licensed gas / LPG technician',
      tellCustomer: 'Ventilate the area immediately, do not operate any electrical switch or inverter, close the cylinder valve if safe, and call a licensed LPG/gas technician.'
    },
    {
      id: 'structural',
      re: /\b(structural\s+crack|roof\s+collaps|load[- ]bearing\s+wall|building\s+sinking|foundation\s+crack|slab\s+collaps)\b/i,
      specialist: 'licensed structural / civil engineer',
      tellCustomer: 'Stop work and keep load off the roof or wall until a licensed structural engineer has inspected and cleared the building.'
    },
    {
      id: 'medical',
      re: /\b(medical\s+(device|equipment)|life[- ]support|ventilator|dialysis|defibrillator|x[- ]ray\s+machine|patient\s+monitor|icu\s+equipment)\b/i,
      specialist: 'licensed biomedical engineer',
      tellCustomer: 'Clinical and life-support equipment requires a manufacturer-certified biomedical engineer. Do not open or modify the medical unit.'
    },
    {
      id: 'utility_hv',
      re: /\b(11\s*kv|33\s*kv|high[- ]voltage\s+line|transformer\s+pole|overhead\s+ht|disco\s+pole|nepa\s+pole|phcn\s+pole|street\s+transformer)\b/i,
      specialist: 'DISCO / licensed high-voltage linesman',
      tellCustomer: 'Keep everyone clear of the pole or transformer and report the fault directly to the electricity distribution company (DISCO).'
    }
  ];

  const DIAG_STOP = new Set([
    'the', 'and', 'for', 'with', 'when', 'from', 'that', 'this', 'have', 'has',
    'not', 'are', 'was', 'were', 'but', 'all', 'any', 'can', 'out', 'off', 'into',
    'only', 'one', 'two', 'after', 'before', 'what', 'why', 'how', 'customer',
    'says', 'said', 'very', 'some', 'more', 'than', 'its', 'there', 'their',
    'on', 'in', 'to', 'at', 'by', 'or', 'is', 'it', 'no', 'so', 'up', 'do', 'if',
    'my', 'we', 'be', 'as', 'an', 'of', 'channel', 'unit', 'system', 'work', 'working'
  ]);
  const DIAG_SHORT = new Set(['ac', 'dc', 'pv', 'db', 'ir', 'ap', 'ip', 'tv', 'ht']);

  function diagTrade(t) {
    const s = String(t || '').toLowerCase().trim();
    return DIAG_SAFETY[s] ? s : 'solar';
  }

  function diagTokens(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(w => (w.length >= 3 || DIAG_SHORT.has(w)) && !DIAG_STOP.has(w));
  }

  function diagTokMatch(hay, needle) {
    for (let i = 0; i < hay.length; i++) {
      const h = hay[i];
      if (h === needle) return true;
      if (needle.length >= 5 && h.length >= 5 && (h.startsWith(needle.slice(0, 5)) || needle.startsWith(h.slice(0, 5)))) {
        return true;
      }
    }
    return false;
  }

  function diagClassifySafety(input) {
    const trade = diagTrade(input && input.trade);
    const text = [
      (input && input.fault) || '',
      (input && input.code) || '',
      (input && input.equipment) || ''
    ].join(' ');
    for (let i = 0; i < DIAG_OUT_OF_SCOPE.length; i++) {
      const r = DIAG_OUT_OF_SCOPE[i];
      if (r.re.test(text)) {
        return {
          outOfScope: true,
          category: r.id,
          specialist: r.specialist,
          message: 'This needs a ' + r.specialist + '. Here is what to tell your customer.',
          tellCustomer: r.tellCustomer,
          safety: [DIAG_SAFETY[trade], r.tellCustomer]
        };
      }
    }
    return { outOfScope: false, safety: [DIAG_SAFETY[trade]] };
  }

  function diagRetrieve(query) {
    const trade = diagTrade(query && query.trade);
    const rawCode = String((query && query.code) || '').trim().toUpperCase();
    const text = [
      (query && query.fault) || '',
      (query && query.code) || '',
      (query && query.equipment) || ''
    ].join(' ');
    const qTokens = diagTokens(text);
    if (!rawCode && !qTokens.length) return [];

    const scored = [];
    DATA.LIBRARY.forEach(entry => {
      const entryCode = String(entry.code || '').trim().toUpperCase();
      const exactCode = Boolean(rawCode && entryCode && rawCode === entryCode) ||
        Boolean(entryCode && qTokens.includes(entryCode.toLowerCase()));
      if (entry.trade !== trade && !exactCode) return;

      let score = 0;
      if (exactCode) score += 50;

      const symTokens = diagTokens(entry.symptom + ' ' + entry.cat);
      const causeTitleTokens = diagTokens((entry.causes || []).map(c => c.t).join(' '));
      const causeDescTokens = diagTokens((entry.causes || []).map(c => c.d).join(' '));

      let primaryHits = 0;
      qTokens.forEach(tok => {
        if (diagTokMatch(symTokens, tok)) { score += 6; primaryHits++; }
        else if (diagTokMatch(causeTitleTokens, tok)) { score += 5; primaryHits++; }
        else if (diagTokMatch(causeDescTokens, tok)) { score += 2; }
      });
      if (primaryHits >= 2) score += 4;
      if ((exactCode || primaryHits >= 1) && score >= 6) {
        scored.push({ entry: entry, score: score });
      }
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(s => s.entry);
  }

  function diagPrependSafety(trade, guideSafety, modelSafety) {
    const t = diagTrade(trade);
    const out = [DIAG_SAFETY[t]];
    if (guideSafety && String(guideSafety).trim()) out.push(String(guideSafety).trim());
    if (Array.isArray(modelSafety)) {
      modelSafety.forEach(s => {
        const clean = String(s || '').trim();
        if (clean && !out.includes(clean)) out.push(clean);
      });
    }
    return out;
  }

  function diagValidateSchema(obj, candidates) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const allowedIds = (candidates || []).map(c => c.id);
    const guideId = obj.matched_guide_id || (allowedIds[0] || '');
    if (allowedIds.length && !allowedIds.includes(guideId)) return false;
    if (!Array.isArray(obj.possible_causes) || !obj.possible_causes.length || obj.possible_causes.length > 6) return false;
    for (let i = 0; i < obj.possible_causes.length; i++) {
      const c = obj.possible_causes[i];
      if (!c || typeof c !== 'object') return false;
      if (typeof c.t !== 'string' || !c.t.trim()) return false;
      if (!['HIGH', 'MED', 'LOW'].includes(c.p)) return false;
      if (typeof c.d !== 'string' || !c.d.trim()) return false;
    }
    if (!Array.isArray(obj.checks) || !obj.checks.length) return false;
    for (let i = 0; i < obj.checks.length; i++) {
      if (typeof obj.checks[i] !== 'string' || !obj.checks[i].trim()) return false;
    }
    if (!Array.isArray(obj.parts)) return false;
    for (let i = 0; i < obj.parts.length; i++) {
      const p = obj.parts[i];
      if (!p || typeof p.d !== 'string' || !p.d.trim() || typeof p.price !== 'number' || p.price < 0) return false;
    }
    if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) return false;
    if (typeof obj.escalate_to_human !== 'boolean') return false;
    return true;
  }

  function diagFromGuide(guide, trade, fallback) {
    const t = diagTrade(trade || (guide && guide.trade));
    const escalate = /EMERGENCY|do not re-energise|fire service/i.test((guide && guide.safety) || '');
    return {
      ok: true,
      status: 'diagnosed',
      trade: t,
      fallback: Boolean(fallback),
      matched_guide_id: guide.id,
      symptom: guide.symptom,
      cat: guide.cat,
      code: guide.code || '',
      source: guide.source || 'REHOTEQ field data',
      possible_causes: (guide.causes || []).map(c => ({
        t: String(c.t),
        p: ['HIGH', 'MED', 'LOW'].includes(c.p) ? c.p : 'MED',
        d: String(c.d)
      })),
      checks: (guide.checks || []).map(String),
      safety: diagPrependSafety(t, guide.safety, []),
      parts: (guide.parts || []).map(p => ({ d: String(p.d), price: Number(p.price) || 0 })),
      confidence: 0.85,
      escalate_to_human: escalate
    };
  }

  const DIAG = {
    MANDATORY_SAFETY: DIAG_SAFETY,
    classifySafety: diagClassifySafety,
    retrieve: diagRetrieve,
    prependSafety: diagPrependSafety,
    validateSchema: diagValidateSchema,
    fromGuide: diagFromGuide,
    state: () => S.diag,

    async diagnose(query, opts) {
      const o = opts || {};
      const isOnline = typeof o.online === 'boolean' ? o.online : S.online;
      if (!isOnline) {
        return { ok: false, error: 'offline' };
      }

      const trade = diagTrade((query && query.trade) || S.diag.trade || S.trade);
      const fault = String((query && query.fault !== undefined ? query.fault : S.diag.fault) || '').trim();
      const code = String((query && query.code !== undefined ? query.code : S.diag.code) || '').trim();
      const equipment = String((query && query.equipment !== undefined ? query.equipment : S.diag.equipment) || '').trim();

      S.diag.trade = trade;
      S.diag.fault = fault;
      S.diag.code = code;
      S.diag.equipment = equipment;

      if (!fault && !code) {
        return { ok: false, error: 'empty' };
      }

      // 1. Out-of-scope safety classifier runs before anything else.
      const safetyCheck = diagClassifySafety({ trade: trade, fault: fault, code: code, equipment: equipment });
      if (safetyCheck.outOfScope) {
        const refused = {
          ok: true,
          status: 'refused',
          trade: trade,
          category: safetyCheck.category,
          specialist: safetyCheck.specialist,
          message: safetyCheck.message,
          tellCustomer: safetyCheck.tellCustomer,
          safety: safetyCheck.safety,
          possible_causes: [],
          checks: [],
          parts: [],
          confidence: 0,
          escalate_to_human: true
        };
        S.diag.result = refused;
        await DB.queue({ type: 'ai.request', outcome: 'refused_out_of_scope', trade: trade, fault: fault, code: code });
        return { ok: true, result: refused };
      }

      // 2. Curated library gate — if no verified entry exists, say so plainly and never guess.
      const candidates = diagRetrieve({ trade: trade, fault: fault, code: code, equipment: equipment });
      if (!candidates.length) {
        const noMatch = {
          ok: true,
          status: 'no_match',
          trade: trade,
          matched_guide_id: null,
          message: 'We have no verified entry for this fault in the REHOTEQ library yet — we will not guess on live equipment.',
          safety: [DIAG_SAFETY[trade]],
          possible_causes: [],
          checks: [
            'Isolate the supply and prove dead before opening any enclosure.',
            'Photograph the nameplate, model number, and any error code shown on the unit.',
            'Record your meter readings on the job card so this fault can be reviewed and added to the library.'
          ],
          parts: [],
          confidence: 0,
          escalate_to_human: true
        };
        S.diag.result = noMatch;
        await DB.queue({ type: 'ai.request', outcome: 'no_verified_entry', trade: trade, fault: fault, code: code });
        return { ok: true, result: noMatch };
      }

      // 3. Call the server proxy (`aiProxy`) when reachable; validate strict schema
      //    and prepend the mandatory safety block. Fall back to the verified guide
      //    if the proxy is unreachable or returns invalid JSON.
      const fetchFn = o.fetch || (typeof window.fetch === 'function' ? window.fetch.bind(window) : null);
      const endpoint = CONFIG.ai && CONFIG.ai.endpoint;
      let finalResult = null;

      if (fetchFn && endpoint) {
        try {
          const res = await fetchFn(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trade: trade,
              fault: fault,
              code: code,
              equipment: equipment,
              uid: (S.fbUser && S.fbUser.uid) || (S.user && S.user.uid) || null
            })
          });
          if (res && res.ok) {
            const remote = await res.json();
            if (remote && remote.status === 'refused') {
              remote.safety = diagPrependSafety(trade, '', remote.safety);
              finalResult = remote;
            } else if (remote && remote.status === 'no_match') {
              remote.safety = diagPrependSafety(trade, '', remote.safety);
              finalResult = remote;
            } else if (remote && diagValidateSchema(remote, candidates)) {
              const matched = candidates.find(c => c.id === remote.matched_guide_id) || candidates[0];
              finalResult = {
                ok: true,
                status: 'diagnosed',
                trade: trade,
                fallback: Boolean(remote.fallback),
                matched_guide_id: matched.id,
                symptom: matched.symptom,
                cat: matched.cat,
                code: matched.code || '',
                source: matched.source || 'REHOTEQ field data',
                possible_causes: remote.possible_causes.map(c => ({
                  t: c.t.trim(),
                  p: c.p,
                  d: c.d.trim()
                })),
                checks: remote.checks.map(c => c.trim()),
                safety: diagPrependSafety(trade, matched.safety, remote.safety),
                parts: remote.parts.map(p => ({ d: p.d.trim(), price: Number(p.price) || 0 })),
                confidence: Math.round(remote.confidence * 100) / 100,
                escalate_to_human: Boolean(remote.escalate_to_human)
              };
            }
          }
        } catch (e) {
          finalResult = null;
        }
      }

      if (!finalResult) {
        finalResult = diagFromGuide(candidates[0], trade, true);
      }

      S.diag.result = finalResult;
      await DB.queue({
        type: 'ai.request',
        outcome: finalResult.fallback ? 'fallback_library' : finalResult.status,
        trade: trade,
        fault: fault,
        code: code,
        matchedGuideId: finalResult.matched_guide_id || null
      });
      return { ok: true, result: finalResult };
    },

    // Nothing enters the job card until the technician confirms a specific cause.
    async confirmCause(index) {
      const res = S.diag && S.diag.result;
      if (!res || res.status !== 'diagnosed' || !Array.isArray(res.possible_causes)) {
        return { ok: false, error: 'noresult' };
      }
      const cause = res.possible_causes[Number(index)];
      if (!cause) return { ok: false, error: 'nocause' };

      const diagText = cause.t + ' — ' + cause.d;
      const faultText = (S.diag.fault || res.symptom || '') +
        (S.diag.code ? ' (' + S.diag.code + ')' : (res.code ? ' (' + res.code + ')' : ''));
      const pricedParts = (res.parts || []).filter(p => p.price > 0)
        .map(p => ({ desc: p.d, qty: 1, unitPrice: p.price }));

      let mode = 'created';
      let targetView = 'newjob';

      if (S.job && !S.job.lockedAt) {
        mode = 'updated';
        targetView = 'jobcard';
        S.job.diagnosis = diagText;
        if (!S.job.fault && faultText) S.job.fault = faultText;
        if ((!S.job.materials || !S.job.materials.length) && pricedParts.length) {
          S.job.materials = pricedParts;
        }
        await saveJob();
      } else {
        S.job = await newJob();
        S.job.trade = S.diag.trade || res.trade || S.trade;
        S.job.fault = faultText;
        S.job.diagnosis = diagText;
        S.job.materials = pricedParts;
        if (S.diag.equipment) S.job.equipment.model = S.diag.equipment;
        await saveJob();
      }

      await DB.queue({
        type: 'ai.confirm',
        guideId: res.matched_guide_id,
        cause: cause.t,
        jobId: S.job.id
      });
      return { ok: true, mode: mode, view: targetView, job: S.job, cause: cause };
    },

    // Test seam: toggles S.online inside the closure so the suite can
    // verify the real offline and online screens without duplicating state.
    _setOnline(on) { S.online = Boolean(on); render(); }
  };
  window.DIAG = DIAG;

  /* ---------------- views ------------------------------------------- */
  const V = {};

  function loginPanel() {
    const accounts = Array.isArray(S.accounts) ? S.accounts : [];
    return `
      <div class="sec" style="margin-top:4px">Log in / Worker</div>
      <div class="card" style="margin-bottom:12px">
        <div class="ch">Saved on this device</div>
        <div class="cb">
          ${accounts.length ? accounts.map(a => `
            <button class="rowitem" style="width:100%;border:0;background:transparent;text-align:left;font:inherit;cursor:pointer"
              onclick="ACT.loginAccount('${esc(a.uid)}')">
              <div class="dotg"></div><div style="flex:1;min-width:0">
                <div class="jt">${esc(a.name || a.email || 'Technician')}</div>
                <div class="js">${esc(a.email || a.company || 'Device profile')} · ${esc(a.plan || 'free')}</div>
              </div><div style="color:#94A3B8">›</div>
            </button>`).join('')
            : '<div style="font-size:12px;color:var(--muted);line-height:1.5">No saved accounts yet. Log in once on this device and your profile will be saved here.</div>'}
        </div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="ch">Worker code</div>
        <div class="cb">
          <div style="font-size:12px;color:var(--muted);line-height:1.55;margin-bottom:10px">
            Ask your company owner to send you a Worker Login JSON file. Import it here, then enter its RQ code.
          </div>
          <div class="field"><label class="fl">RQ worker code</label>
            <input id="workerCode" autocomplete="one-time-code" autocapitalize="characters" maxlength="12"
              placeholder="RQ-ABCD-EFGH" value="${esc(S.workerCode || '')}"></div>
          <div class="btnrow">
            <button class="btn primary sm" style="flex:1" onclick="ACT.workerCodeLogin()">Log in with code</button>
            <button class="btn ghost sm" style="flex:1" onclick="ACT.receiveFile()">Import worker file</button>
          </div>
        </div>
      </div>
      ${window.FB && window.FB.enabled() ? `<button class="btn ghost sm" onclick="ACT.signIn()">${ICON('log-in', 15)} Sign in with Google</button>` : ''}`;
  }

  /* ---------------- welcome splash ------------------------------------
     The first screen a brand-new visitor sees, ALAT-style: who it is for,
     what it promises, and one honest way in. Shown once; the device
     remembers it. Try-it-first is a real path, not a dark pattern.
     -------------------------------------------------------------------- */
  const R_MARK_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAADQCAYAAAC9WlyjAAEAAElEQVR42uz9e7xlWVYVCI8x19rn3EdEZES+611kVVGYhWJRKIoKhV1gK0+RKkGUh1AICiKKqCBkFp8P2kfbighq22qjYnc0fuqn2L4LUWzB0mqwEgqqkiKpqnxnRkbEveees9ea8/tjrrX22ueeGxGZ9QC+r2/+Iu/jvPfea6w5xxxzTOKFfhl41k0PPPgAgbcBDz6A1+EhAm/Gd7/9uwkArz1/vT3ukSeek/rzan8kANy9zHz4qcxxqbz03B0cF5kAkBaZ+boSADZjEtwG5GPlBVxAjkpdKfOJ347zgJ4oNRqPABziELpWHgHY3yiPd32cjXWf5wAAsOt+/sfjdp+zvo6f9w23+HWLj199BJ7zBX2tPpxPto9f0K8P+eUPXvhDh2DzE9U9VzwxAMAm2Oz+i2C4Xn9fGRbRsAyG9eD3W1037JWf9UD9aZ/z368vDOeWhqv7hgtP+N+e2Te8GsAz5w2PPmzAG4AXvXt6zYfu9p/vv3/629veZmciyAv44gsFK9vx4AZUAF73uv+dl998GU+8/YkZUD27tyIAXHtkwwpU62XmnU85MK2Xys3iDo7PZfYgtT8mSYP/nOM56qr8PCj1RInDc9C1UqMSR4BGpYUJhHTj97fNHnetJxuVN7pKV6dW4f7Wk6x2XNWrnVf5ajW/5wta0ye7PsX+je9WvvZWu//+iweYfhGC1am381F+P1HOXuBjAaq4ttnfYvn7EAybAmqLYFhHK7u0g9RyMCyj4eTI/74XDccLw8HScP2KAxeABl7P7Pvvt5/379vgdevA9bxBKz5fdFMDeQqsDA88SAJvw4MPGi7jMnHZwer6T1/nG94A4A3As+9a8dojG+LVJaJ6JXD3o5mrpzJnQJU3zIfKdD3z/IExHSvX+0pdnWO+pNSnNtTbjDgC9o+U16IR2MBgVChxCNjaaCdG7AO2WRLrAOwBKqm9dRuVfgD2gM0GdrgkToD1uv9sGz/Ps88b2t9PlvXGADw33X/7fv3XsqCF1t+xh5NdELKHs5HlZPv9YPdr7XoogeUaWNcb1x8qYJb3eiOUvKWvve4J9rZuW9/CJ/sofNW3dXW1+7Pf0oO3D9JNniCIIW+t7dhFU4u1YQWAHahlGkj/nTTkctsohlT+bsJ2+3qlwCVgeWzYX5dLc0PIvuHcSvEYgAsALtwN4AmPtp65Rtx+3vCGNwD/6lniRc8bgPh8gev5RVglsuof+AAe8B8fBF734OuIy5fx3XddJvBpeO3563z24RVx/zyiuntZQOqKEvcAR6uLgjuBdDXzwqAcr2eu97PkY6XGcwSAxZhEo1HXSg371LVHT7pRajBqNNpm2aIqHacIy0b/vgZgqfxNFtxeB/W29a7FsN61qpc3Xuvrm/x582FYQC8AbDYvFKQ+xNe98ddHAoA+SqD2gl5mcet3DaOdeqH2NwCpgFHoo7DBQSduJqCK4lFXjcgs6ZRujop19LTRH6BYRcPeke2MuK6WKKtGXH209aJz80irj7Y+xBTxlgDLCl81u/ODD/CBBwtQve4h4s3A5ctvxhPvegtf+zlvOJX+zYBqqdwsSqq3uk1SAak8GFNU5nCOBytljspxzAIAKS1Fg1E3yiGrAMBxWHK5MWpQroLRrhkXYcH1ElhcN54EYwUhLAE7MloY5p85TWCGDQAx+sW0aat7M7vINvOLbrMdi226i3EzvzA3NwGRFwxkG2CzuHWweqGvs/lIrfjFR+kxH6m3/xF8L4sOkE6BUhdN9X8PoyHJ9LcYzAFr44CVKnCtraWOltR5r2jYRMNi5anj+thwYV9xBcDFtc6AC8CM56rA9ejDfttHALh4q2C1fecH8ABbVAXg8uW34Im7Pq3xVc/ulfRvO6oqYHXbc8rjw9sEAE7WSSpQ6Uq5WCbRE2O6mkXPG5ebPV4bVPZGo4oy60JsNOpoxBLQ1SAWjCYFoDaASfk9D9x00ROC3+5RVuW4FhhHwLLx1AIt1+K4ucX1PO5+/M6F3913HIYtXqL+b9j+4y0CybDzMWP3p6HcZzz9Zm5hJY1nvN4LBb/FTQ7aTVnpmx+nW32Pi5u/0vghfPRdLzLc6KgK7dQnyj1AlcRHkjUAE/E0cFEBLRksKIIY0mjAnkdYe4MCJ8Bx1AZcMRg2wXBYoq71ygn8k8FwYa04joajheFlWxHXrURbHyKvxZungE6vz1LAB98G4AG87sHX8fLly3jiridmQHWjqGp/5SCVBuXJOslykyTFc8wnynGZRdfKYaGiYY8pqQNTBSkxLkZjHgbRowJIBaROLIolIwoIWfbbgAUsbwgMHk0t/LYxgwgwZJT7R9YrZnZxVBAbd1xQ4+5lPLug0+nLfRz9VseoAhrjTfDgDNBIY09EDuUlxxuvops9d7o54Zk+vIzy/H0NZ73HAR+Vr+F53iF+GF9baDfksoYCQPV41ftLATCh+d+TA9Zefb6gMNVCvKvvC1mRxJCCYZkUKRhs0BaNVfCyUbEJhiEabKO4sK84OTIcR8PejlTxVqKt++83L9A98LyAK948DSSsPPrBxlc9gNehgtXlAlZvIN4A4F0OVvfsjzxeZq4WDlb7h0nCVWMalGPMXK+zHC6VazmQcRxFoUymstzf4yapDOsoYzimykIWIjQEybqStS6oq1FsMFoaqMcmJqBIosFoMCKDYzaaRkI3BZBGYojAxmjZCwdYA2ONsipi6B4FCUBEwsovzm7xhJAsjeXQye4DagCsrmjpVngEkEbEwpGbdq879NHNOPHoNwCSdOoMjqfCqNgvrlRA7mb7ety9YtMLQalbAt60BVzpQ0OB9CGCyRinEza8YLrl1pabbkX1u857BSgBcFIjq7EDKxqQPerK9XdThOyPzTQIzCOwoDihA9dKFQEGoWJjiqAGHKtHZ4Nij8RIgwmRxTCuFQdL4KnrxPk9hUTDc0eGg41hdVGBK07Mvw+GV66IZwC86D400Dr19cDzPoK8Vc6qketAAStPASe5wjt47ZFXz4HqaeXmJcr9R7Kk4SLHmLlcZ8lBuR4PJAflYswyJpW0WEpOKrpRDoNKzgvJqpJ1kIUYs6qcqIqlgVFVTEC1IMigJePGVKJEbrIRChqNUKNJJMYESGABCaZsrBeP1Qsmletcp4+dzgolUv8t9mgEpDi7W0TqFnrcQq8eBeLOBXdTjEhnrM609ToA8va6yB8CENzgK98ykMRTfw83fN4PH4kebogrzw/lcrzB84abxQenz3/evps6MAUAuUVg5YIl7VSUpbQpmqL570EhyXktE0UWv08o963pIrJiERUnqlOEVVLH46TYXyg2JwZberp4vpDzulbsLQxHS0Na+Wu/6Jri9n3DewCsn9QWab3ubsPlrfTwFlNE3oizavx6SQNf9+D/Tly+DNdXOVg9u/eOkgKC9+y/gsfLzCvXRrm4UK4H5eaqcbV/XipQDQWoNgWohoVKSktJOUvOJlkHiVlFBwcrVU/1NKrkMQQIqKoSxbjZBIkRGMcgNpoYjaYgaDQ1JgXBwAZKFcgAYHQA60EqNQCIgI4N1PLOVRiR0u5IIHfXoQND6h4eC45UcEsd8N1sxQe/MfV3TdOayABC9M32Zgsz3cLLbb96vhlIhfompsek3YlkfkE5VbjBLfGm4Blwi585nnnkT284AEIItwTeYdcpTvV97QAs0sIZKWPWTudQQUs7GQMKYAnN5Q6qMFG/XzbIwoFKxRCzDjJk5GSjRcUiK9YFuCwrbFCgfLfk//YXik002DOK5+5WLI4nfuv284onAaSV4nDf8MwThgtbKeKb7lNcrkT8ZWsR12nQsud1pdQ08MEHDZcvX8ZlXMYTbwffCOBRvAMzsHpV5uqJzApWxyuVcf8Cl+ss602WHI02ZhmZZTSVYW8pJ6sUcg6SlRKjCsYUxjAwkgJNAQoBTTAGQUoBEgmFJCFJStoYYUlgJsiBmUasQRtAmtGykQo6Tni62MA6A1QjkJERIFo1WgpoQIbB1NPHXBYsBS0kF60JoC/EnB2ABBE5+0VtAchmW8e/gtWIXAGsOy/hzHDFkPvzl3ekJ6WKHXYC7S0v2d2LL4cbLMtQjkOYvyeOt/CS463EPTehXPXDxyNtcAYY5ZZKz8BH9dYirO74TT/VYlCaoqldKKs0/5nWcF/yRLJrAa1UQMp6wFJDVAVEkcpt3Kg/Tg1UNWUmgsJOFCdBIcjYmAKmsJXCosKOFToozBQjs+u1FsDBNUL3FFcBLKLhmWvA4cKga+IagNvvBtI11209ex9w6WHDu54g7i+c1kNv5gRaO0+67bwCtqOrBlZ4Hd9y+TLuL/qqR0tkdW0B3vOBV8xSwIsL5bVVljQYl3vn5eTJJPuXjMd5L4zPZVmeN66PFiHlLHFQGTGEnFWiDpKjSjYNWYOEUYOGKGpB8qjBTEUtiKmJmYmZiCYTDOA4iiCZmBoNJqUEKKZgVmP7XGoEA0sE5FHVNodQU8KMEqnItBhUkKFArn8T5FyuqQDkXBc2UK/znHUis/Lu7XcbWAIC8o7VHRDaa9Qwyt+FYkao5ekR2j2P9Ksn9x/51sBLcrhx8JPra3aPuRVIaeFggOQbQVK4tfcZzkCMfIvwFm58m9zoAeEWQfEGUZmGreNXIiftIqzAaRFnLaCkjesymClYaF3SELoIy9S/55ARCxlvBdBMHaxM1Lf04FGWWHbQGrrfkyLsZ+AYONGMi4cZ62OD7itWC8Nta22EvF70Q56uaYu0nl8F0WYR1tlgBVy+fBl482Xg7fVWj6zwHuD4Ymmp6cBqtZ9luTa5/uwoec+YjnIYUhLZV1mdLGWUMcTlQk5OcoiaBEMMGyZJmxBioGBkGIOIpBQsmPgpDJI0BbNQAAtiBsFopJkYTBhApCDZQDMTqNFTyAJKDIQZFdl/VoD19+lKY39ht+1O/T42QxoDoLAejNS3gYZThQ8FPDyrP/pmqQ6IW3jjz2s7FpzNV50A0nb33J5Eu9RFZos0zRdCPg0qN1pxeiOyuc9xznoOvcniVZYtVD+0KErPiMrCraLSTXLfLbDR7gXlBm9FbvWt1/MiDSG79M+jqmzd36SAEksob+aAJDAY1B9DDWYlVRTNpCLC0zuoQkL2tM8UDBlBMzYanPW1DDPx9HBUyJAxglBTyBExrg2yBzyZiQNR6HUi7CmeW/tHWl0E0oo43DdcdRUBnr0PwMPOad3/BD3SeohT9XB3pOVEtNUog1tg9SDecvktvL9UAh89/wYC78AjFyD3fAA8XoKrBXjx6Xt49TDJJhqXqyyrtcl6eSiLjcpmVAm2DHFQGdNCRmgYLQaxHPLJIDJoyAhBVSUjBBk1ZEhQ/1k0StC1BROVMVswExGIJDMxC4LsEVdKFEim2SCwTEsmEGPWwGyZgAAJnjJ6BM5y4ltEletxqBilU+iQ89aFno26I7JxoOr+3kdY6J9XIRigOZ/erbVEPXlrR89huqKl3g+QLcaqy1C2AKv7u76QZOpmSy5MISbCLWegEirgS/tMO+8nH1oCKD3QZLlBhHPjZxfxmPbURnMTHJTuvYsEgLt3AO03JIS51KE+Jmv7WVsk1Z4vl93WIKKeTqqKidIriDkHUYCKZIogFZQUalN0lS1jYRkbVcQhwYIibTI4ZFhWDEyz6EuTwhYKHRW6VATLyGvFMhryecV+ibSq7OGxRwyX9ueR1v2XbVY9nEdaFqfI6jRYXb58mX1k9ezeO4jXAfe8HXz62osE54H9a0nWC8XmqnG5n+V6OgzpTmO4ksOJ7smwpyLHOaxtIeMmh3xuELuSBlkas6Y4aggEg4HBRgRLDCkOQaHBYhSFBokImhHAIFALG83BKDRNAVnEsglAUQNEUzATaqZABJo2QgSARhgYIcwpUzUgaOWwXL8hRoPBU0YFaMKUayBa8q+Kb0aDTulimCLV2cITRKjWK7tCnEAhQM4l5Hf4auGZKgRSmjf7CrjVvMC5U20Pnl2notPy0DNysvbY5wVK+eylqD13JQAMkuobkJuw/nkWJcpZQig7613eAHx69J5xiTfgw1LY/cwd4kh/THsg1DmQSUnYt59GMc4cT6SQYtpI8/oUJQKnWjsGpAHB/JqmSk0FazhvVAcwNfU/AAmqYopMhUFFRJFEScs5mwLIIDM0ZpgqhpgxjhlrZgRJiIE4CgoJAhmIFDPWJ8QhE07OE0TG8XXirggcAcAaEDVsbifkCcXRwnCyT8SV4eg8sb5DcS+A288Dj/aR1psBPIQzIi3GcgQwfZ8iK+Ay7n87+OhPwzVWAK79DIgluP+qYMufHOXqoXITjeEoh9XSOAQVu6IyjCrZcrATBysepYg4yJBSGBniehMC9zRglACw/ospWkBGQEAwTQGQYGuLOUAkI0AgyBZgJsFEsqeCknMWySZK0lRJoeTRhBRoNjHLhAlhmUaYqIkSZgJPE40GM0JLemxi6spZ1njIF0zu+ChtF6ltRTaqHT+k0/eeM1LdXo1+HtQm2Y1mbYujgVh9aSuPs60VZd3qzjj9ptpC4BmoIM8zduFO8NPGm9mH/Fw3C6v0eUeIt/aI+RE747hYPo3p9XsnSD+VqfaH33Sq+FVgNZk2JMKUIEwNpIkDmQMUa28gCm9V3wHLxSROnpPOP1HUyVVTg2WBKMlciPoEYYbmDGEGkXOygMCEQTNSEGgSBMtgyDghMa4yLAuWTHhOCTIjDEAegbBSXF8C+Tngwr4irwTpvOL2Y+KZ0kD+bPleIy0PrUrh8AH2UVbsSfgH8QAfxIO4jLcQby5gdR589tf5oT14EoIluFq8iBd/cuTVwyTLlUreUzlZHspwpcgUdBm4pyJHOYxYBJEcuIiBFgJGBpgMBgbqIpgXcYMlBiOijYgGC6YWgBDMNKrHxQFi4gCnAkWAiUCzgxYoahQYhQSyipAmmgtIQaAKqjlAGQkxkCVqsqxs8VIWuERi2irNKUkoDKq57JxEzQ2ydhelTtdZrNGazheOIrVoaZLQCKDmlhj1rKg14W7YWvgBgCq75y4ynG5hcQZS7MO1GwCTPc+U0LZCuf4W/fBV/FTOvD/793bG3ai7eacbvrMuD7XuWIrMU/wbNsZJHw7Un2Xna7KLAqUnDR3QrEWK9BJ2+Zs1fbex3lkBMfF+FQPFUz2jAqZq8LTPoEJk08JdAYEIGTmXslPIQXKCUqiWMUhCgiSYIIiTjsEIDhlyAgg9bQgAjoSQNXBu6U4mUnV014An14a77lbg54l7X6547BG/6Yn6gd9cJA9v25Y1GOag9SAeunwZ9981P2/3PgJeLRZAF59Wrl+iXD6qcryncnKiIprDcMl49NQi5nPK8STFURZBTlJYL4ZAyTFvEGSIYQwcaDmMyaJCA2lRowTdIGbkaJCgwig5BxgjvKAb8ohgkgWQAGVImsXMRM0EZICZk+1GZr+NMKGqEMykCYOBCsLMmNVLLBABwcZnGafUC2qcZV6pX6SV+J4uXKmBjGGqLxqgpvOcQmUW8XhUZfPURb3ToD6PZjsj7THILFrK3WvZzdndU+ndC0gJz3yd56sKtxuQVXZLIGfdYyi3gHe3zuDvDlZvCL86pYXlzXDGbW69CmmN/rQ0PXPg/IrSXKIxGEyrlsUAmhkKuU4DqF4XUhVY9ovbshgUsAxFhlipCOYSrlkGkClMoGYYBZrF1HLOWYCYYSlBB8ISwSjARpBIaBIgAToQQ0zYrInxOEM3xHUAab/Y1KwURyvi8GWGq08Q974ceOwR4LUl0nqoOzgPgHibn/xS8rdyHB/EW/A2Apiiqz3w2uLVvOcD7+HT518kF59WXj1McrxSWe6pDCeHcjKqyH4OJzmHmPZkbUMQ07DehCiLGJJpwEkaEkIglzHnHHPUwJGDQgKyRDUMahI1j0EZo4BBk0UzjabmHFeyYCJisJCTBSjFRMRTPgvIIIyiJsxqLnsAoCoCKNSKlZcpHTB8b/JLgHRQUt+XFFBTap4nbPD9aYpidL5CtAFd4avydMPsMaIOdHUViUw8V9pKXeqlqrsXj8xWopT7hRsucjO9AfjweeddlDMkfekWGPRTIRF3A56cHROdLeKRW3j82fElefMHSZSbwB1nr23ccYRl9qJ9BbAj4KSeHpsq0jSYGFCkDQ3EiqxBqDAYaEpKhsI8sqJqkAw1ByxFhoQEWgZDgjFBU4bEBMsJElNISGDKUKZsSBAmZMsQJigTIv3xukmQZcbaMkQzNCkWTFgHg2jGubVC9xV5pbi6MNx1UZu4tCri333OcHeVOxSN1ttgsb9C3nL5bcSbJ7ACANdajTxeghefVq4Xzlkt1yoH+TyvaZLNQgXXcxjTnuS9HMRCWG9y5IgIMoA5jgyRWSLICGFEYoQyJmWMFgYTjTnlqBYigZiBQLGIhJhNgjEHCIPpGEwZ1BhgFCQTmAVTiKkJAFFzxbtBBSY0ZIJCy8oCWpBsrNEEQWbVEiFVEsAAI7TwE6aYYh0Tj5hU5gvZ5uS6h0UKaEmMVGdRzCz46Dgxy4pe/sUuVZ2lWlqfatKJQQzCSf86E62qbUECd6Ync0b5VgKcCGTePA+bPRd3P7HeYCXnfAOI2f361pVJOTt+Mwb8BpnvzSNEzTovAW6/M9kK7wQwmd+RJjsAWP09U63jLq1UVq289ynC8nQPoDkJYeaXnoOXEr5KoJINUOScQclQZphl5BxBSWCOMCQYEpCDZzi5ZDlMkCxQCoT0fwZgBBKnTjUqYRvgWIGDJXAlRVzMCc9tBFgCIRnSbcSF54CjFZu49NkVcal4bT3xBB20Hmi8VuxTwQpWXhH07y5f+DmuFi8iFonX9rMsV1m4PJRryyTDxjkrGaIMMYcTDhEIgUTEXohjyhEUBydjJHLMigEZMVMjYDGRg4GxXPlRLQxUjUoGNYmARSAG1RzMYsi0IMqQ4ZyVmpvLKL38JkYSKoRrsMxAMSWVDAYCLDSRwVRZd2J6DA2r6VUGmMuiLvmgIgBioBLOjZUHQTy7bOmcJwLaFnKYUsGiDpRZ5clK2lgAJO24+nVHDKJOBrPWsdUKLukODmuLD7JiH9tFWzYj9G/GNU2P4g3TxR1LX3P3zNwCibA71bvluKh73l6+wK0frWkMZrg1Cz6F3SvsrjL2mHwqVqSgZfvSReEqthMwS6DtF2U9DtFaEmTlAqPUy3TqJbTCV5mof4eZc1UGQ1Zq4bA0A0G9xUMzA3PxLckON5K87MsARQARkOHrTbK4roOEgdAswCBAIFgymEAiEMACWG78WgsRUAsICyCsgbwE4jFwcptisyI+CGD/iuDayxUoqeG7q9yh6LMecJCg81Zv4/13zSOr17wHeOwiuLx2j/RgtVielxUyh40KdRlEc6ANYWMhCELAJkQIIlOIIGJSGRAYIxjTiAGDxjyGhUYLNA7KHDVxoDECMsAQMyTayGi0YMpoFqKaBlMLZAjqaaIYGGBBDCpmWaCQbEqoiSXSjCQ99XWkouunVIpgtMTfvhvRF6s1EKkXG6GlqycDFiaaE/MKoXZXvZOx1h7v4KLtitR+nfWZj/Pup5YgeRY3VMSrKFxZd5udIQxiTTUN83af9l5Op5REaIeGRPez3gDYOHte7iKUZouWZz4VX9AIAtuZOit7OeKcnZu9SrZbi7yqdk+2BRc2vUwfVVK8SJd3i8xMMNn7Wju9reyontrBCGN/FZl4aghq0fIULgvZVEq0hUwzBSUDms1KX4dZNsrou3IIHihwhGpAgCBBxBDUEBDIchUwQEkEJCTCBgKJyOJRdFh49L0snO2BALJwMLtuhnNloMv+c4ZLdyoOrhG4i8D1jNdeJ94N4O4qKi0p4UMlFZz0ViDeA1zdR4us1oPy/DXj8R6Y11mYc1ipC0LXJznIoqSBG0TIGMkQxwpWmgdwiMlyzDYMeRMWDBqhOphygMQI0wEiEVkHNUSoDUqNpgxQRkOOUE8NLSPAEAwQywiAK91NRZwgVNdh+YGkZmcfkY0wI8X5qYIarNU4qLGtdS0LslzQ1G7FlS1YUehJo9+hyQzYaAdaiSSUMEO58ipEzHd/05KGqjWgOyuIMN3GLp3KJ3pGyX1WRe80sjvTM90NPr2sov0cyrU7B4HTVULZWT2cOUAZTzPaO6Kd05B4c67JmOeRT3mfVuihXZGs2S1Q61NDGLhVZDB2MvXyOg5eNn86Pb1pGAuuwSGFQboIy5kLqhpCtJImGM2TQBAKU1MppLt3zXuERWQEcZEoLBfeI0OQkDQglHQwI4EIgI1QCgxBQQGNZTf2n7ObDUQoYSOSVjGgFGlDuZhl33BybNgbgDEZwihYnzOkNbG+DTheEes1cbD01BCvA177MBpoAYgPguh5q2f3QG9mRuOtrh4qlyuvCA6LQzk6ziK6J3Evi+gQxCRgEwpYhci0iCNzJCVGMiYdIoQDwAHAAHDICAPBQckByQZAhgyJZhhMdTBjhEk0QzSzaMag2SLJYNmC0QIUYiYCQyCCAEpTC6YkQaoGKUWFEgQYVUkbQZiWoRriwY8ZW4pQkUrR2c0IWKUIRhjUU/m2w9LbeHJ5vBV2VLf5c5st3ra2za9Q6vbS0K6QKx2vNVW4K/jMnutmhT100gk7OzJhI+E94u/BZfrZpjR6x9NwB+L2k0xMt1It400rjoQ00LMzgzJuoXwHbN3cJ8rZOD0D0zOqtHOp2Rm7TG0ssanENesR7whLk+pC2Rd8zaYdtKqGBZBgMDVzBPTLnabt4GR1PoumVKgDGbI4SGl5hQRDhkpQWIRKAmwkESB0YwHAeavAUnlPzl8ZfTcWwCwaKeYWFDaBa/D1gXHl1/CzI3CQA+I+ICsD1sD5ZxTrfeLSncSzTwH3vpz4mWvAJRiu19GAb0Z8qJy1XhwKALXtBoVkZ1QehPO89nSSYV+FWeX4aAiy1DBaDgssA8GAJHGkRKgNIxmz6mDgAikOCg4gBmRbwCxmYDDFoG7kOlBz1GyDKQYDohkjskWoxKwWAQT1DthgimAmQc0EBiEgpkVCbqRlCkhazqygY2pSLnqaiotW1AgzD5R1wgGPjgxIRoqAdJVpFd3QBKb+RlAkB6wF1zwRQQothGoFwcnB1dRXc21tbYtuu22kXqdpZ7mvRFFTwmTaN4YGzEKvTjIxPcZusNjLwjC7uXet7Qo+bHcSxXmuyxaY8sxoaWeXulTtbLHV2ApMvcuhP45+P8virisU7/2t4Gx6i+VDmYe7uft73ztitjv13TYWbc9HJyGlhVks4ZhPzpHyWINf8eaaGDMrJIWBJboCUZWGBrWMQI+wrFQFTV0cOrVypGIbUTOYsbxiACBCddACRUi6k4qW1FCJlGhxgUj1lBCjpQxgQ3+GQNcM7Ym7px5vDMyGtAQuDYblMXG8Ji7dCVy9Rrxm3/DYinjDvuHdrbxToqs3eCpYo6unFy8q0VXy/sClSV5nWWkO5/Iy0HKIg4hZDGIMaaGBKccNLUJtSMoBZAyZC/8ZC0sY1DAoudBsA9zwdYDJQktUZeogltUGQCNMomZGMwQS0cwCjMFUglcFPVRNpmJq1AwhjaYUWhZVg0Dd1E9J36joQIVCUCtB13BBjQjJvKiCAckMlvzCFwRosqlCpwZzPssj9Fw1fdP12EdAoRVlrRKo3X0AFh6DmTPyoi7mauUF7bZ1Q6Pc/X3MNzZ0t02ShXkKpDdo3pObSR16pnjH1CbtIi+5kaaL02vWqqVtCRbYtUaZKUAiUlo3TOPW+ty0mneYc21lZBISJ5UvyaIESHMpBG9QixQ7lV5XvKGcjmSVBG0CZpKnN57+VXIlwLqIk12UZTTL5lf/1AxcuQSfeDeRGVZK1/VQZS2iUU8J6WBlEkFNyBxLKijMJjAGCkpRSwkhRUkYC6x6RuP9uhnJjIjqXK/mEm2J9zsC7jevxeorBEPMhrAWPHsArI/8pKzX/pGuvRx41yNtLGWc663mqeD6Jcrz141PXjdZ4FCOr+YwmMo4qFBV7HqM45ADGOI4SjRqTESMtAgOEcYhKQeGOKSMgRIGKBcwHQRYJJOFgoMZBstYGCWapsGUAyGDqUUzREIjweDpYQiw7KAFEapJNooqQrn2xDJolkX9+qTW+WtOghR/K2UVCpvRAwESkhUZQlhEvvIsLh6MOFhEKLJj3NCF6sFTtFzdOYJ390zRC0v/qUcNmnK52BygmpDZ6MCZ/YrT3JW3bbpPWmsndnZuhKZe7TdugVPNoKyrCuqUj5jOK4H1qWnd8g+FbZM5sbIFBqXxsltYPWZN5H3uF6n24tbt8l3/e9gStJb5YjoAAdhQnB+WXFIuA5Kdzjt9cfg5CwEYIhAEEiMQBaRAQoCQ0FJRULNii+BKerLTsGkXGQkL14ROAtOdQ5lyb8OuNHjOz9HMsUABo9oUIQewILiVMpLft2ivJnRUmLlbg7flGFr7DQxgtmS5VJKcv1IJ3kXP4OIzC75bUmAaLFGERt//ITB1FiYrIJFGAaMZUsnPNRhsbVHEEAbQssFoo8GBKwRDODKEQ0EegetLYDgBFhcMi6sCnAeOrynuAXAehksA3r3DwO94ORHt1657VTCHc0zBh0PQ9mSdsgCLgKgiFsPaUkC2yCxRKCHnIVIYk2LQwMFyXmgOi6y6oIVBKQuYLJCxMGjhtmQBtQiTQdWG8vdoplGNUU2LwNQCTQLUAtXECEI1UF3pDi26XTNKhigiMoqJXwEmKuiUlcHFpurJkZLuurSH9Nwz+KpP/Th85W99BcAPYJRNWRBsgFEbe1n5p1KVcymDFKlEFzFoqCKcKXVpzcEBNcLzfuzytzSlSVmlAZNlQrNzaZqlZA0sLiD+mGyAjqm2SEKzQjU6G5dzUdcHWJYWtWUDNE2q/DGn2jeOrP7+hAFpNCR1HX5OI7LlEikqUvYPpwocZ3W2SYFRM8wIImCT1jArlj0lJYM6L5W6XpeUu6gqrSbdLzaewduicIoC2tJXbXWL6HozfT/IWK3X2KzXuLJZ4bnj6zi6dhWrozWOT45d5xXFwWx/ibhcYjEMyBCYKbIact0Fu7CP1hHrW0JT3S6WBKCWrWc3lcogzCUznq6itmZZE7EGaaqtQqV2hGOJYKz0DyoBqRIHKowZnjt6Oui6LZczeKdIFkXwp1cn2FUFqgGkWL3AYG7ZRF9nQIIkwntMSk0pmgZGQzaFpQKcVEhSmAWcwDAOhnDiFP+FA+LZ4BVGJP/sl0ZivTRcezmr1CHW6OreBXjwAfDp8y/ixah8apXlfDI+d2gyBJVho8Lz+zxeJRFdBGxSMDJswCCwoEliGhBwwgGBQ055yIEDDINKGJA50MKgJgslFgAWGrDAiIUBgxGDqiwAjRQbVJ0Hcy4LwTIiDME8tw5wpYd40wFEs/kVqialsi8CUKlkLomCFhdSI2DqONNfd6YIiEhHK3zyK/bwp77yNyKE/4Bjexo5GAhB1EDfb4PvikoIBrcLUQJCBAwFsIiAWJpm6banJVoQxI7Q9qpxLo04obkVxNI8XKJnDN1CDED3fP5zoxswddfGbnn1tw3dbUOX1kXMJ4P2z7Xofo/dz+EM7VV9TCcwxS6eiluvw63b6u8jPDcYCxQcALgOL4Nd6o7bafmalpwoZ4WqYnWywtHREY6uX8ez16/isSefxGOPP4r3PfYofuoDP4v3vf/9ePyZJ/HslStI6xUQBDw8xN7+HjIM2WrbXuEhtXLqeUIQK6mfTXsdc4lMe/EWaS2SLjynFxKcHurjZmar6WhpVuAWUAH0lv1aPqrRl5paLjxXBoqlDFj+IYBMamVHNQb/DgFYQk+U1K/qXKt+jtBg3l9GKdy/GZLBKEYEs5yMC+iwoZLARkSxXAXIviFQcLw2xI1/wM0FxfpIgNsV62sE9h20Lj3ZSBX8DIDznZodtwOblfLg6Bx5kHk8qNj1HMghbJjDYhjCOknEWoaN6ABqhHJIxgHKmMAFEocMDFBdKIIDlWGBhIUaFjRdKGVQxcIyFmaIljF4mlgiLJVoCm+QdgFUgEoh3SleKTQxNSGMZvTKoNGV7rlETgZCjVmtVgG9Lqze+w5Tv+hCQE5HeNXL78X+cIWPXnsC2HNng4yxynhLybYwPLaBlj5yyVIiar9PKDGWlSpbjZD8FhS7iErq1ybnoWUBbKDiNW6zegGHbtHHBiAOH7FcoYRQXH5hdH60vHcRf4xSICYgy6VgEcLlXIHd2O1QiJVQgFSmiJMTTyalTdshfq+tGKmgqIDIBJh1YcLYzApqjZIM7XmJAOMRsgEL+vMi7WEZXwKzcarCV1La6y49G+iwSMH+/iHuPLgNuPc0wK3TiOvrEzz6+ON498/+DN7x334c//X/fife+fBP4fHHnnEq5mAP8bZDIIp74GX1DaySmAWsKBWf2NI+l0nNbbMpLJGxwUiwSOvmxYhClk46LcejVtmgkU7Te0+hlYazClgaK4dFSqkQWhWMZgBiVt6xQTqeQWA1mioMHM0F9WqAiGk1nRQzgRmzubwCo1nMRs2wlI0k7IREXBs0GnQURAq4ZxiC4foV4mAkFolYb4hLI3GwIh7fNzy7YmzcVYmusEi8tsqyhAtEr4UkstmTmLNYirLaz8IxhmxRBAwWGURDUDLmzEgiJuMA46AWBigWqjoAOkDjQtUjKmYsEmRhKgszXZhhMONgJoNpHkCXNKgywqUNIWcJMI0ARRUCLdIGNVFXvVdihS5tCKSxOY6aGmmTgsD9ZQpPZFK0JQZsArhJHtsuAcUJFqZQausNM1QbGmDkCDC52LNW08x32yxpzqsaocX736xuk2XHNYHlPHEoai3FkKKzt5Z6WlcQ92okrBXHG1kuvUBCdd7fRkDKRjr1jFSBqoOIdVWtiSgmaEV7BUGdmya1uZehAEOA2NBxyWylfZHgSt7KMzX+a251JBXUApEtIOgClDUsPwsZX4mXHfw+LMPHgeodJFbV+4WtdIcWa6LaJgQ2wLBulVeroGYOaJf2DnDHfa/Gx9/3avy2/+43Y8wJP/fBD+C//uR/w7/59z+MH3rnj+KnP/AIct5ALp2HHOy5q70W4FKA0Tch6lz069yYN4m1wwKCEmoWOJGQXYTmgVieZDTCEt41YtNDG3cWdUsHT/vKuygWM7BAsCigod6GY9kEAdQASuh2xMpnlRYcqxtVQSSbRGVSnCDUPBeiWnBq32tVRgWS29tIECi9crSi4fzGcKyGuDSM2TBeINbHxPHtxPoacQ+A49pL+B4AvwxY/7RSDpXYB9IIMiizGe3AaE+p2KCSs4oqJUODbhigDHkRgiWErIhGjcwaMxlBDmYS4ZXBQVUXBhlUsQSwsOQclpkMZliY6WDgQEHUjEGLU4PRoqpEGoJZEIUGt7tAACwUm2E/ikqhkurEjY/68pNJNvmVAapsSiQtKWJW5wioyBRkRB/LFoiQpMJCK7oYtQjenXQ2LzX7YrCpOFO3ydItAVJLNmmzsrfBvAuDXpU2mfpgFdUfvhSOqluEy5YLedAUGa7rLBRd+3vYWjRiBdA4WTDRyubPiTBuANdk2WBHEot5lBYQ/PM1grrFNE0TXRenlMhSyBJKFMDMpZJW48sYCr8YkJgRB4WlY8Tx43Dfud+Li8NnwEYWmUMs73Gelk16MKLD3EkIUtM7CKyoCtY5Q3ICSGjOiCHi1S97BV79slfgzZ/5WXjquefwI//lR/HP/uU/xz/5T/8O73/kA8DBPhYXzsFiQLIEzRmhCkelVCKhHvmZzYujJg2pxAwWfTNllfSpWW9Wb1V7W6PJSrqbgbXh2Rm8egFq93cFNVgRjNJFbZkeopYX9q4QeNBbTmARISKzdHtABWa5uJ1aMS73C933UQ/wNQRqTgwwKga6NbPQrSwEAtkX5JUCmdhbCo5Gw/JAsN4YVmOtGDI2kWgA7wHwVLE5ZjqUE1MZsoo+lwM4hDVyYLE3HrkIITKMGwauUwRiJHPMmRFk1ASPqoDBYIOpLYAwwLAwg6eBpgsDB3MgW5g6uBUAiwSj+nNFqIVsCJ5b+yQdhQbTEverOmlkpHrDAq0w6cXWDF49NDS1Su0b1SpR8nwS5RhGACGNfiYtIlObSp2FRLCa8JRUM1sRGVOhZlCTDpTYAMVlMgGmuZeFF+Bxkhem5feqi19MQXoBRKsVdtvd55OqE2gnd2iMf+nr8AzAZoDXIqmqK7IWvHZtQu3NdP8vAlfx+2trxPYIogKRB1qe4vbVPAYvIFQwSeanN5BYMGJ9coRLeCNeff4PY99+ZRm6OkIxbOkO/HxoVZWbgzPtdGcQO3RjCRiahopurZxyRtIi1KPg0vlz+NxP/wx87qd/Br75Az+Pf/R//iD+zj+8jHe85yeB/QHLu253NsIUEP9MNRBp8yFsW0/XAlDHXcE8gmnAOoXYji/lqSo/b5zkDaCVi02pwZpXlqo6B8zgFse+u3gSS6FCFGXGp9P7zqaxXM/uE2+iBMTMlA5WKlNExyKlkPq9mgiyNGeLR1sBgnUShEGAYDhZA4tkwJCxHomLtxNXngHuWTlxcbx8KVdPZK4PN+LtN7eRGLnZqIjuCYZBDEniZpD1MoumEJBzzLIIYIoZEkdIhOoAiwMgA6kxmw3OV8lCMxYwG1S5UNjCMhdmsmjRlWLh6n4bDBxgjKYWDYg0CWoaxGW9AdlElWJKIYwYITARA13qa8pS0aBX71h8rrzruUZbWkBGVcFMSle6Ft1AcVxSv9ELLMVt1tr2xVZ96nVF1i16mraLrDknsLT1YPTrieXMmi8YR9rKlHYRWKlWtyIap02274txXVCpjHWtOaeHoNdeybzdqLjlCsGyXsIELIYZeFnb/QtXp6dVnNQ8k0WQ2XUoCI0uyXT7pVh7enP0QRvDFYxHS9wTfgdedfGtCPkVhTYiwFjUELnKVDo/CnQcmc1FnTdp125Ra7Yid5g2nc04wmwDIfGKl7wMf+Arfw9+9xd9Cf7xv/oX+F9+4O/jh378P0HPLTDcfhFZS/eLAVGd08xFJN44tjxdG5QS92oBT2UZAmVTZFukWCzoy8ZjSTFwq/I6rcZ+Wu5TtujgHIRQkc13aIN49S+zpA6FYLSSf5Zin0de1s5vgJFszqaqZpCcneQyt7qpcrkMBakDRIFRx82ee8APewI7DtjAcLhvuK7EwYlgkQzrDXHxduD4GqOLRH1E1/4hsIkXOIZMMWM+MuZDFZwcCTaDYEmRdQwpUDQzwDbBMIQMBKoT5EpGqA6aMTBzAOkyBcUAYjBwsGyDQQYzHZy/Er8/GdVssFLCykCkIaohmDHQEKDmzqKqQqsiGEjrKzaTchqLUkWKI4MBCiFoWjwYfTg0rAAE0WVoBvc2S4A/nvVvZYeseqr6X73wynY3a16uQYbpjC+xuigUJXtFiQQqWDW+bUpdilWNzjpe5+0sVbgzj3oM2+Yysy3eep4pnlZ3d2magxTn2iydaPY518Vd/gbtpeiy3o63UrdXQoByAWCDQGBz9Q7ct/9FeOX5r0AeXwQwueFl45TjVoNjJzbtymy6y/WGu00xiMIj9lrfKntVvwZUgPXqBFTF4WKJ3/l5X4Av+M2fjR/8d/8Gf/n7/mf80E+8Azy3h8X5fWzaQN3SxxjYdFvWEArGzEohdq1HZTfL4ifWo5mSv5dm1spkedjl0k4XQChoQreaEZBqpi5vgHrRWyHegV2U64U7b2XA0tuGzNZ/7ZGcGZRqzKX1xwVEyOZ6Fgvq+hVmZAaXTzAYJTMHGUKWERIwJh9csTwmUiaGjfcFbC5wmlsJxOPlS7l+euTFhfLZlcpyz5iDMh2rDIs9QUpieSnrGAQxiCYGjgwZKQQuHFSImMloymhgNA3RLEcLiJoRSUalRiAMplyQWCgcmIyMqrogJSrM/bJMY1YdaBIARnMMD2oWrEgZABE1dVdRiFgWKXVe8YVdWGXnNl0kYqXjphCHZgCSN65XFBF10oAmroTXDIseSWup3JpNimozK7zHPCqpt9FtiUqkZl3fW3mMNUasa2djA7xS8ilkrJXfbd48a1sgZPNy/tkxBW/4640NXGx3C06rqLOlWJUv6n23PO2SQpBMPTaiHskoxQe+5DWweiVec+Gr8LL9z4emCxCpnSt5qqDZGR/grI/IG3cZTVHgbgsvEZnEoOoEw3pMkJQwDAO+8E3/PT771386/pcf+Pv4zr/2Xfj5Rx7D4t47kQVIpkWP2Ydz1jEDHvEaaaSULMw3VJbualPxa0sAOk0rDWWtsKkmVmjFMqnQXJOl3pBW8smSosFdeafNr7JXZnVHMesMA1s51EArgzCYDZbFTCFSWn9yhkqmIOfKa9Vex0G8kiVJIYNA1oL1IMBoiFAcLwU2GtYrB6/VyIiXAvhJYD0ocR4Yn1LuJ+O1k31iL9NOloRE5jSKrRcBIYlmBrUQmDTk0WvqqoyijAqNkjHAvMXGsrkwVMV/V4tmEpmdiEfGAPXIymUMNihsoEmEMWS1SErIpgHqwyegLANVy1lVk6ZupNFUakRVyBLrrmibOvQVoBBUgam35vhqMWh2ITBZfMx8iBtyPebNqK+Clc0WY410sk1W2y1qKoS585qYIhabQLDnNiqgsV3Oc9Gh2e5uQJt3KOL5DYPYsYxn0dK849j6FBF2qpeFcwuHBvhEBi1O2kchshJB1ticGM6NvxKfcPs34s7Fp0PVM5ip6TNOgxo+yl/08AUwQgK9x1jcXsYsI52MGELE7/2SL8NnvPHT8R1/7jvx/f/0HwB3XMDexUNsUgKL8UHfaNDS7Va4zZ65CR03KKxDRIvw2RvMyNlJJqWkDGh1UTNlU5g4C8Gyu5QxFx3h2E6ZX6VWqy+mWvrEqkmgQqUQ7DY0sh1aTAGLz5bBB6/6OLGQsga3+ZAMzYI4BoxZEU0QTLE2Yj95enoOwLWRWI+MdbT8tWhcrs7LEBKPFvsyjKOsBxVkFUs5hDiIicp6E4KNCBo9RdPa1khGVbhS3XI0SqRKBEozs9EjKuOg5mS8p3s2mHIwyACPZQaoNIcGADEnC4SJGUJW9zgsRV6h+SyJKmrTLFWeUl3Nescg0vyCKnRHa8txrqBQkgnQ7ClhtgRVD+W1EOlVslC92mu3wZQSbk9KKYqJwjlZL0rQ3o2mXF0dz5OrC5tNNEwDopamsHuMbccIO3sG50MUFLcUarFvg7Q569PlL9xuQymCIvFaiDv3VnmGsuVtBDCaAkOAngy4pJ+IT7zjj+E2fjI0bRzcZiJYfMTAav75bnK7GkKB0JxLMxOJMWesNxvcd+9L8H1/4a/gs9/0m/Ctf+5P4L0feAz7L7oLY84eJTnbPacQSpuU53cKy0Tt3Ct2yF20WCIfTvWVsjrg7dFWHRxKq72qIBR+qvgdVW6B1nqarKnZwc7zrFQECyvB4vhgplBmeirqkRMsl2Hp2TTnMtc7AAwZDKAITAIkZKQsCEGwaRUv8ZaJRGz2BedXiucuMa6fdilDumbUrOTSuHk2C0QlhoUgRznJo2BJsTVDEJFNRGAKYeNWACFpjlAGEMHMghrdXUF1gElUpVvGgANo0dQ5KlUb1Ms77jSqMkDhqaFZhGnQ0oZjlGDIAkIsa7GNoZjWMpOKKmHqsamVQROiVoWjHgWoQtVAY90jGli1ECgXAz4osnp1yEe6+cXoKcBEMuSyrczbXdHExzo5uLW0v+eMqmxGKwlOznmupp9id58pncw+M3YCOetN43YD0XygxRldvlsUlxKT79UsrNMilpX5Yi6k8mThNAFMaE3bVqQbBDQix4TNccTL8Ln4pDu+Hnv2MVAbJ0U9e51CKq8p+IX8KpQTWETofs61lWGOV8dYxAG//bM+D7/2DZ+EP/anvgN/79/9IPbuusNphqTNasw4HWeWmp2TfeYvVLOyMFmmNV8kRXegXe9gUiuFHhaV3NKJitp5WNVctOwbyJRoW70UIUW2UHRdxmojkNulSRtgks00U5jUED2yyhmK5KI/ByyE6mYqGbYOResjrkneE4RjAfYMDIYhGzYXiNuOGTcLZbhqHPeVy0MgpUNq2BDcIzaRlkcZZMGTzRgsLAWZImaSbBTJISRBkCzBMj0qIoq7gkUo/XdT/64WNXMwY1TVaCbRkENJ/8p0HA0wCajOhmYBZHA1O4Ongep2Migt8NaMgApfxdk6MKIxQUab7B+ta27viWdl0dStHesIZKamGG/PUXhOO5WTFW6rKLfqxtWm79ikC8rWzWiybWGC66OUMnFn1TmpX7fGGTDReh59KyW0HQ3GuwaM7rRIZuO1zbpwqxlPKE47hsrpRm4EZB2Qw9q373wIygiLx8jXz+HjD78YH3f7VyPmj4HhpGhAF52UoxdTsZfZfxhTvht5he3IlrdS5SqPkHLuFMT1oyO8/N6X4O/+pb+K+//6d+FPftdfAA4HDPt72OTU5A+9T07dnAjOKtPMdb9jf2pbk2LV0xUfe5YyohXxDt0Ajl5xqhBlnbtYlVA0f7hSw9Y28EDLHwf4SOEygUejGjJNHayyJheiWjTLiVq6VWiCbIJgASlkgIJMgY7EXiZGdb0XsvcXblyLFcfnlMPhReajxDVGCTnLMhhxYjyRlWgUsbQIIZvYqDKCQYnAzJiVkcaQYcG8tyNadpKcJlHd0StmIpq6v5XS/O+QqEA0SJTm547glseMSgRTC5ZRyfZQUvdiKcNqEFt4LNI8c6drNT1J07axeL+6qRRbGO/7tNkVJ03/IIwwrGFu2wdi44Fg8yWzxkdNup1e1jCBVpGLVpUFtKRDzn9xGixnlQPlDHDcNKAA5Y4Kn24Z3vVWvPObuMU6E/PkbWv1TWHRKQcUs+m9ODXSPatwS7jZ9wOyCK5XoAqg+7C4BrlBvn4XXn/+y/ErL3wVxs0lQDZl7S5gNm5Z2NRNZUcBYPaenx+QGfpWmO1jczOSvp7TcqGWS1QoSClDJOB4tYaEgG9969fjtS+9D7/nj34jrqyuIV44h3FM4BDLXEpv5WkoUy8wqV5YE8gUY8VyVZIFiMzHrdKamstXRxWotVKQjxsgTZA56VfKE1p3IJu+KnY1nYygudi5ZqgOcDvmSEMGJAIhwVIEgoMYLYdKJWXJSSCgCEIJ08fkqgRRF5Ja9srhei3xzjuB557MTPvajDx0vUc7HKlro41Gy+algQDJawvezRi9hy95VGUjPSpiia6yRaNFyxrhnH+EIpp73kUzi0SIsOyRlSE4b1VkDKoByqCwYEYxKGEhlAhYzP2rSs9gGdBsVkWjtVzMttKcb2SzIKkNvEVGoH1kUfrnPINM0Gpz3PyrtAgiixOA2twaxSbAqi0zjVjVoq1iV/kr4Keta99m4FOjsBm531s+2Zxcn1W2Oj+tJozk3HSzXZfsMq7ePrht+LKTv7fSqtmiqP54zN9Mwy6BwfISjIq1XsVy/Vr8uju+Bfcd/GZsNksIA8iuvEB+uIOojxwhvwMGXdvs/kdqhuOU8IW/+bNw97334kve+hX44BPPYvGiO7DWNJkaFiNGekG1eGrZFFDWVNFHEZKd+Ni1W901W1IHK60WLIpTFl1oaZiQLoSerQgnS8TBymqrTxnGqshqxW6ZmqESwRQVzGIxAtlbEFSD0QJhASn4cAsJ0qIrKIuBmtuZ7xtxpMQ5JYZEHABxc9WYB+NhUB5v9iVqEgwiuL6QKElOVASqoghieQgmSUyDGFJQhgCfCxhKA5lPs8mICkbTAmCwoHVckEl0zx0Et62QAFrQYswHs2DeehN8TBfFm0p8cJ9XOiglxvUezM4hqNmum016ysqtqDfblUPt05yLEp1V2FR6IVRd47ZBRtapQucEuBYArFxXWbDWBNZddCEtqpoirUm+ZIVKKPXj0mE0T+m0SDB6n3fr7qSnlsjclJh9M3H/c3svdjoNtM63qS4QmRP9cxP306mfFdH1FG+FJixLeglcXMeYr+DS+Gvw6+78Frx48emwkX6muYHaBuRQIinDLxnEOoOkr8WN2p509eoRPvX1b8A/+b6/jy/8PV+B9zz7BBZ3XsRmTB4EVVu8Ok4iTJKa6ptQqq2sI5Aqb2kBpSAnZa/1xmhnEJwuKvypsekJ2z2qkaE/E2tPUa0AevTgciOLgHhFkEhl3QaYRPeJMeesYAHCUIcigyKQUYAUMGpwOWcWWBCEtSCYYL0nyIMiZWJcE3aOMQ0XeZA3XK+M+wfGExptk2WTKTQV5IUYEKCUDVSQJZiqO35KDIYcTMXlBiZBtbwpZTDLEXCfaM1w5wVIMNPgfBS80mgIPmzCghlDsV4V0xDMIKW/xRWGbsog5qGJmDdh0rLQOsdhM8IyyWrEZvT9oXb+l0igUi8ukDe3GwIxJsWIhBG5ZO++qbQxWmKtXNIs4KuvU58uFVBo5Htpb1DkKpdBvZJ81KJ13lh1fVdJ2TRKRbsWEqPMqoGTORxh3JE12Zbh3xZPNb+rTXrM5oY7iVPbN05N2f1rmk5hVZu0owCHZ3CyGXGnvRGffs+DuDf8GuRxDURrka/zViX7YO6atF+4FOGFpoo3ekz/9+379L9L16KjphARXLt2hE/4ZffjB/7W38UXfvWX4j3PPI7lpQsYx3HyhSkN5qacesOlXJNCWDaD+KfTegYzWt5RzEDZpHtm4vbKJiSzd+lQrHGQJQKghdJDVOxmtGp61FB9jywUiwyfsqNIDIwwTb72tQAURMDgzn4SmHPIyoCsgigCDUTS4GZmCzeFEwBLJa5kYnlAWGYcr2cu94EcD4mTkWp7JCOWeyMsLbgxo40LGkYxRDFLkiy4MX0yyZkhCwVjiZggIauLPGnOd2lmMItlcIS6p5VZhOs0QxF5iI/tco7KTMRMxVvASDflU3oG56jjhzWLE5Elosol4qpiXGudm+5OXiIKrYZ3bT5XR7inDFU4XNVp3loAqvaHVe7JtPTESQOmLWu2uTGR1XZpntJRaeWf6kVdKmy11cQ6oYLaRMCeGnsw49J4RqJy1tAIm3FgW6QuZr5Ns0ESu5+3JbEV9E1gyFhfW+MVi8/Fb3zx23CJH4s0brxVx+3+p5JZDYntZjbNv/S+cs5AEFy5fh2vu+/V+D++52/h8373l+ADV57FcO4AG9VWLWZJEacZGtbsbKofoNVWVRZHLHj6WU8hpSM2nSswH5tHHyNMkrRifVwuQsE0hMI9kYrQtEZOpTAG86qf1OpfiarQnB9CUdl7CjhQkJNzV1kFCxVE8zmHVWoXk2Btij0lxkxoYsyDK9vzkZIH5i4H17Nwf5C1jm46ryojggDWgAQIYiohiQlGC1XWoErv91P6GC4ykBbMTKAQn9jsftFaTMJMJaiqwFSgImpWQAslDTQfMOGA5jJfI6qkwZoLA7vwYWr/8MlshccqZ9b7N4s0S6dqW3G8dgsY+CRurRKWmhI2v6UpTobpRLTPaJtJ+oCSfqpMbTheRbZWCawktRWuwze3gkLCThm/LW7nzqLfqREQMwLrDAamGY93bTTYEjf2fF11XJg1T3s0mDEiGABbYuQIcsS4WuD+w7fi0+75QzjUl0FtjbwQRNuH5AzIWE5O7f8T76On/tJLC7kbZIXiPYZwSc3x9SP8itd8LP7OX/oefP5XfAmevXKEcH4PqfB9pEDdSMTYC/JKxFvnlZNk66go9lWG0uXHqYw80RLmobuU8WqUsquXqqLV7nkzatAyrqiao9W0MIA2DV2lZ1gQBNb7AAFS7c3NsyZSIGXdJ08Hh6wyDsFV75lEyOIlu0xczd78nFbniHMJx3oAykiIcTMamY2wBUcxYgRNgsCSmAWBiWRLIkUnNRI+3FQtaGYgEdQYLXnqB0NEVp98YwV5c5l8gwpQFHWQo6lQoCzCTnYlLoLiDqEwVgeGSaxoxS3DICYwTa550MJa1rGStcJkLmIsfTclfgmgZWSMyJpgVGTGMnzUnBcsFRy1vjuwq+x1gDWN3+UEPsUIL+sUI2kFUk7PbZzcDUQ5pRTsJFGYyxpmKUpd+JjMA9sQ1zMAS4w7hfHacSTThJ5WKfAZfEyN4HeYDxA1ZAjGmKBHS3zyxW/Ap97xDYh2DsoMsehj7GBwymVr1Fcbvf1hBCvhqdRt0oudfdvOY6y7N4uzUkZrNkN0MHdlOq5dP8ave/0n4a9951/Ab//qL4PtDZBFhGouldfSnVMlLtlqK60BPiWi6tQpdbkYWbukteivWPWllUowK8oJfxGtJ8Cmac5OyIc69r5MAem4KTpomU08lSIg58JTI8BSgECgErLkAIUE7/SWnFWigWNdCGpEXhLrFbC/53TYvjK8+EvPH/AoSPYppSFnFRhDFIaMHCxLFItRRaMVYz4aBjUdVGUAOKiWpmaw2MjAbWOMQzZdwDioqjuJOkERNTMCdGmDetuNgi5f0OAHR4v+qh4w7QaiFpO+NnEGrWrY5VdFn6VlAnSf9imagWKtbLF0OOhRwse9QvGmTz+PJ44fLVU8gdJQTRYrV13ngNdKX7aGfQ5AyvZ7tmraV/7mts2FWCfqbAMtThJ1xGGtIFrxSW+Wv9Z9t6nHotellgaj6Z9JayRrINr9Azg979a/vqm7AnE29Y4pEIoRigQt/YA0IIwHWMsSJ/Ic4rW78KY7vwO/+vavRND9Kq2+Qa1tl2XyR6yUt5PrujVy60N/f5VK2Kw3+JWvex3CYol/9YM/iMXFCz4/5AZiMdZdjb11YVemYLUCm5Vti3MQywOLJy6n8Sl0WZeX4asNMzHtHqSyNjujDGht36VceqJCZqNlQnysGP2yAaAilkFVs6BCVWXhyXJwIyorc9BVDWksJtvnAN1XhuuAypJIGyKqmAyEwKUNMEKMxsAcTGyjblWZg5iZZJrQsoCBlumTmE0EapLNJttVKzoq7xBvZmEeVSlNy/CyqbWmDIcwTNbH7XvdrZosrmvYZ5evN2BqLqMdycJW3SsOm4XjyvABLJPOtKaF2tpRtAmG6wCJ2js4CSt1x+j5qa+wBijSVOysFjLsZANdNbCmk+2jKaeUsGZRM3cXnuG+YJ0UY5IycJfqvTVfl/vIXANWBc+wBUyH8n4NKZ4gScJy9Vp81ku+DR9/+HlIG4JB/3+NkvqQigFaJi9pVqyOV/jmr/06/Jd3vhM/8Pb/E4uX3I1NGk+XRxQlIrVpYhA70afNK8XuVTJ5wZUtnaWUy7nobMKw4uPNueFZcSM1E4LuyGgQTvbKoax3QkyEFFGnhUgJSi2YEAkoYzACgRgTMQwE1myEXVbC9gisEfPxOfJwQ33GFZiLA+VaFiQEut4IdclRjCkHwWgCGwUQ57IyRJFFYYJMMTCoWukRQtCSr5oxsIKUURTuwZ5zIdsNYupEu/v8es2VxpISeq+gaw7rmCyWkjvZCMmyzWjWRrh4lKoePmePeFr+rs4fNMayLlZVaHbA0moua74ttOjYOKV+ZdoNejJdu+gaVVpSCPqOEGe1ZEw6Nck3p5wSjXHayVkAzPVf03U6kzLMJPN9lCJblUCbgMt2YlRLTz2j0ElVrlsN0VQvEqUFJADUERqA63qEF28+AZ/7kj+NVyzfiKQJIeYykvKFV/lutYJ3K5XBs1LB/jkqqHwolcWzHt+/PoNgtd5guVjif3jgO/CfHvpxPHZyhLCI7jjbDa5WAqLmY8tgsFwQJRTKxKXUNZMsNkkedyjFXXZhnod72k13KVEpcZvURsVSkW++WQ4201xQyxDQvKoPBjALTGqmJDSIigiYfRJPAcFsKgGUJEZsNs5nMXsaMAaBblybta/EdWXUqNQTo4Z90iI310YiG8eoQhm4ERWOUcxG10gkj5Cy9xGIJYgZggULlpyHqkMhkNW91h2UvFpIDVARJ9n9NnXnnIlkd1tjETXqhAq0LGXsfCEWixC0WBIXCxl05Lp7dEM9JWaVmJTb2VwbCuDZpKVSVSTLSFZBjchSC/cyiS1r+0zX1WVdBKNVi4XJYshYiXppz6E9D2WcUs3WdmNTwGjTP5R01Wa9g9K16XAHcE2R28S71Pe/NSBh1uM70Yidg0x5XJkOJYTqEWJUrI4GvGL5JnzuS9+Gl8TXQ9MGiEC2oZ9D+v989dRaEJgarl67jle99GX4E9/8Lfjdf+jrsLz7DpyoFrwo4luZa+VaTF/ttafNizSXHdfkUequ5i1mU5RFdV8fDzSc/LUWUxffrPKPlNI6J7SaQTG4ZDVUct4Bje5l5+6E2b23vFIpNVMrHeQOUCmLPyoKUlTkTOT9Gtgf+gcPxoUsaaHQpsmIZDQxmkZiLI5sWgbj1VCRFViU0wdTMQprWGjGZlfscgUWW/0yFKjGEVPjfgUkFlX7RE7X21oZXrsKlXbk5jQvlN0iN8wb9+bdB1P0lSzVRKfxU6l8z+rWMfV71U1psUnO7XdXquf2eJ84ruoODup0IpKWNNQPeXkN572ST0yaXrt7rqRAKsOlUmm7n+5v7TGpe+1k3m40PZe17/37z2ZIqu1fRn0vhoTuOwzJ/D6qBkrAteMBL9//TPyOl/95vDi8vkQHBtqAoM9DT/X/b2mjTlHS8fEaX/p5vw1f+KbPwuqDj2MYBgcn6wzPpnpeJ5MpGsOJaC0hlvWVbBrK7INJ8UvOGqC6JtXalV/DTZYduBh3tXY5lrTBrIBRm4Ti98/m1T9zisl3ZCFCIdrrv8XuwxPziVIOlGpKrIWbUTmqkUOUJCM5DuXtGdNgRDLJMHf7FJGELMgikinJM2pRNddUecuQlzCMbmtsFFUjzX2jzcTbi90wT9wIQ+h1DT+GDjbitscZ1Ylo6uV1QJyOb0kFoVZSSCk0oU3tWGWYKUu/jFuo19xHkDOxKQRyFgCSpuJJjX5a5ultPlW1XjWuzVamDFnQNnCTxXbbQQnNF8uKOLA4LjQTP5mGXTQ+jl070a5ewul90iYebGqilSlqs3mDdPNzQ5FVlE8YTKEM7hwCH0FWk9yACCORQsL62gKvP/cWfPbL/zDO60uQLYMiAIbSDqTziBH1vDhtkUu1RIolP6RyhLk0jPv780p8WZwkgvjxDcLWEiVlgnIbbO3l5Znk5FZTu7NSxpv1Xu9KRW9UdSSJnDNWKWFYRPy/vvlb8cP/7ofxxPUVuL8ovi7+uaXIUAhFHXDufSD1eu5T+MYowFSLFxe9UbU1PSiRjZRalmQdoijm2h1BnXXtPuM10po0lI3H8nWP7BNHWIFMgwh9Th5VJOdERJFGFEcjdJjadBbmJml7yohzE1KfAJAlgFWBtwyaGJHgUY6G4gumzKjGEs7tk0JBFXjm+mGpNbqyehuI1i6AMt+2+qlI6Qwm2sxALbuBde0idSyMYbKOweRcaVWqYALNnCSXNQWs49UUM8KSXeeUGpCQi9sM3U6otvjQpQ2t6aT2YNeR80UVXn2rrM7C4FSZ9P4G64SmUuQPxT2ikezsuKo5eV6Bp01QqqmgTkLTqpKfPMEmdt3OWlDbY+/LQk0I8Hm2CvKkwGEA8gGGYACuQJ+7DZ9y51vxmfd+Nfb1TvdvI2dsfxV1tLaibrYhOXFtPpZLoUlBIRbmY+VDjxvdJKCsCk0j0mgIwd+nBrdhbqBd+AnjRy90e94N2OVaVDMcHa3wsfd9DL7+d78V3/Jd34m9l97r/YahT+ddVsIq12iuuPQQWur0o2JpolMtRgrt3nmaTN2mUxN4cQZqxn6cZpO1aa8T58Gu0Ijt3+E7k3W+8dWROxgxGmGR0JEYSGxAHBixLhGWrpTutmVcjMoxkC3RS5Gkp4OW3NXTaDQzkQwqzdEUItYNNPVIqg1eLKLPcqysNC+XBjkvirXVzmZ6USc0s7MzyM36vqZtLN2c3h1QwmPPVutMPasTcUruyZYudkKq5mdEtLDHq1ymKJbuk9rKqt1L56pQ0qk6BaYIjZFVJmKe7PRa1mQP9R003VWpNrY5Dux7/tip7Mt1QJSNjhMBb53bwCzl7aqJXW84Z+4EbIVW7VKCHLwBU7JAuCiDOQRGxVrXiNcv4be86A/g19/1NUBaIsvJmdOYXa4zlWrr21IFMPpsv7gIhVAGVuMJHj16BqvNClevX8XVo+uw7JW15XKB22+/A/uLA1w6dwHn9w/aMx/nFUSBBRdtgpX+EumjFhGMacTJyRpf9VVfib/5g/8A733iUcj5JfKoxaa5gC9rhblE1X1zgE2i5Vl3k1kJoDotsZEmxerK6sQco7EYdKEBUYms2I9TKn9roFZSQ+erfPSeBUj259LsAKfinFYdj1TTwurVc1LA0pRR10Y9MOpqSYZAG0faAGLl8zHd6bmgoAUPzYzM2UQpQhV3TlBzwLIq03bCnUUGreq3Wcl5WZFZOwFQcZoyJ3fcQVQnWUMv8a7lfyuRkpTpzQ3gqx9RX9o3diMlrfFalUFvZnmmhXQ3pJJ6SXErMHraVguXUwsMYBqKQZ80a6Hcyjp18RdesVQ8W/OzeRpTAa/+7PKGGoHITLqAmcyBMysXs7k9SsX9ltI2cOzU6UTra7I+2mrAqQi6AXWJzAPkkHyh5Oewf3w3Puel34Zfe8ebwSwQSSCH6X1spVS57N6hRJeqI1QVy8UeEPw0v/ex9+E/v+ud+M/v+q946N0P4T3PvB/XNyscH68wpgRNCZoVQww42D/E4cF5vOTuF+OXvfw1eP2r78ev+uWfiNd87GtwW9hDGkenVAJPiTt3CUVvVmUkJxHvmX7yW88xNYXfuptpEMHR8THuuv0Sft+XvxXf+G1/BHvnD7CysXFZrNOiC+KzqNU9UgvdRe4Xi4l380zKX6kevq5zmPjovjWL2iUrrTJUxaVq4l3UgRB194VghIaJ02r/RJBzsTW3SaRq3XczQheEbmr0QRCIwCGOj0fEAmQiA+14ZBKCYkw2ABpIG2lm/qazOLk2iai3Sk9Ko5BWHTIIQ6ZqaDadZTQbupyn9fVTC49ovRKy1HFLylN4rxZ1WK3y5crllaTIulHPNo1BbxWU6qWszWeopXkJQObkWeWgI636Z9bmXJSerZKGYvJUUqDRmFrdGJoans0h3j9q6BTvVe1unXJ+rqiuU6DVej0VWxSIyvH0IsPmDNE1T5+hbJ9XColsSwSeAFSkYGBUMI/Yu/pifP4r/zB+zR1vBtMeEE+gIIIuiyzodMejlJ1fNUM1YVjsAQDe84GH8S9/9O34Zz/8r/HOh38Sjz73JNJ4AgwR2Bsw7O+D5wRmg1fHs2EMwPWwBvQEP/vI4/j3P/VjwD/c4MLeBXzSfR+Pr/9dX43P+g1vAnKGWGiykOcrqXghDdO7AOv5vy6xHhN++2d9Dr77r38P3nflScRz+2Vyz9QIYGLl/lrQhT76j5XyYDfxvjEgbfKuST9ctisx18EtrKF4GfLCGWFaUsRakqcLvKnsBr5O9xMhNHW7a6rtI5y1Dqixpf1ZvTUHB4Bt3PsKicCipFsKmI6kKZOVSmBOVIv0uaUqGRTLoGkh4g100r1kWSZUzYXLcjIrmxTpOWgJVQgKMy3pYTWXtGIhY82JkUYKzfv/GoFceafqE14AqsobtJb/zVtAyrh4dNUUdrqm6m+mpcrWZ2PafK6m1/anDzPnUJ2KPlNUYVPKVTLgTi0/OTpkTor4ml7a7MkqoFnRbGkXPW0Z7W2BzvR3zt1NbS5TwJZFvL9fgdqez8ELgK4N8frt+IKP+TZ88u1fgJQzlqIwi5BSaGCzSZZZ4zQBbMYNlsslAiJ+9Kfeib/9A38X//jt/xTvv/4osFwi3HYIuec8otzmlsokshqSuUElcmkOEYAxOBV8aJDbCK5GHB+t8W9+7Ifwnp/+afzaf/LvcM+F25FTLu0sv4S6Eklcv3oN995xJ37nW74YD/y5P4G92841XZeVnd0L+NYVVjBtTCJoU85lAlEPqn0nNxYqvZr+WevbVW+Ltq32g24KLm1KBbXNd6u3F8cV8ftJJlR8ekcbSGkTj+EWgJ7N9Ts4gKhrpUbluAoIETgRo6SBbluxYcqRg5TjYUZaYFaFaednYdWt29XoigCa82L+YoGlf6Z6Vnm6rP2cXivZSONhiI6AbmlgL8itzesmMJ2qpC1qsqmEQ2VzTGCVQVjfPVycMLtRk1ViQE7Rb7W7bYRxIbQnUCtclVXiWLoIipPzglUn0UlobkXykqVrr7F6PdAnTzcf+CkyqoqRyXSvqxLatrlgSTkNp7wAsWXe10s9DD5JaM8igH1kO8biuXP4ra/4I/j1t78ZyEAIZRSLhnJYfOZAN1YRNEPWETEIlsslfvzhh/AXv/+v4x/82x/ElaMrkNsPsffSu4EYXK5RO0LER9VnThIWytTcI+1zC3JOgCmGxQIH5y7iW7/pW3Dp/EWMOUPk9JzEX/TAVdZAWid8yRe8Gd/zt/8GnjxaAcvoKgLrhci9vXMHUP1cSsVk812vkWYH52uYnAbS1bCrNUI0LqG5/tafSKtjPov3Qx0w1auRc3/wrURi3e8FFxYANoN6EFVlDSgh1jIIExKwBjYARFQSBgCGlAMzDD4u0RhUqJapCK5EV6NBKlHuk7Ms0FSpHn/TVfutraT0/QVnc5SusPUD7MQ+mn7EP1x23qubIeichNbItajOSvRUrPLR8jNzhWpNMakTOLLcT8rzlRnhTS9FCLJMYKOKWUvLNEewbiqhRUvuSbjla6WTcV8ui4xCrxrWuUs2tfVMkbQ0oO1TROsAyVrqwvIZ5lGN1YlodrYh3qyFSCfHShEip4i0N2J9LePzXvo1+Mx7fmfRA06WxZPBTq3KFQ4tj0h5xHL/EE8dPY7v+tvfi7/6j/4eHh+vQ24/h+Heu5FzRtI8TVsPvuAStDSly1RAqetPHLxEFaT7Q8ZAnDz5HP7sN/5pfPXnfQnyZnQtYzHEmzuh2s7PfiuqeXJSY95qVfD5pJeV+2Mgrh5dxate8lJ8zqd9Bv76//vvYbj7DuSsJXraMuCY0MWvaUG7X5t2TjbRVYUnrWPFpXy6Fqy5Cp7aheFsC2gqk5MUFI5aCwMOIUiqZVJtiqxyacpzpT5zbn1zhBk3tqbPUFXns3jcHHKwAmDjlDsy0JCNQeFVw4CaczHTmOscQNUubPA3XbVv7cO3GrtHXNVQj+ptnSXysdrjZDZV9moVtKUyzS2UbYCEauexXlI97URy04Tmzr4Yfa5XTGIqsmQr1SQiK5DUv2tJi6YGZgccbcp0j3xTtiL6rOJPf3z954LL6bEu0Cyi0e61kk4uD0rx5ynau9KWBYWUx7n4NNfJ0JgiOytAlTPa6+XSTpTrZ9Dp51ycalVrGuhiZKYB62GJo9VVfNql34HPePHXeDRzg2VeRbuqCSLAcv8Q/+zf/2v8xi//AnzH3/oLuLI07L3kTmBvQKaBUWAxgEHAIfo8EhEwCiR464qEIpQWFm8OX3V5ADJHBDOcfOApfMdbvwm//82/C8cnJ67HqqUsu4G7zi/erBAp+RyeL/ytvxULBljKRQpV+hDVDSYnAfRE8qt2otHa5TGRWKSe9q/nBMn9KABudaxP46O41UrBoq9snfXi3JU5RaQFK7IlT2V6YVwd9rwlII0albZWYr0BosCqE0LZzhMATa49yAA0V8keUASgZUIyaZaLx6GyVgSpxtJnx67NpKSG5tZaPjNeHAh0In9qCljGynuFz1qUUH+uvD1b5DX5XjVCrIz46kn4gortsU3uUM51snLcyuwlIkzpaScryTabdTwbM9/bJ2tpq9Bp9FvjuqxSanArFiteWE0iUTm6TkqB3rJ+EmfMJDC5XkdWmg60ppQ8ZXLcWnTYVQcnmhwpAKv1U7g/fAre8opvwl46gDG7SHcHArCM6U55RIwBoxIP/tXvxJ/9G9+FkwNi/5UvQxZvgTIhQnnJXMAIZMeWcBK7akcq0qXUJkRmwhAF6597HH/sK74Rf+xLfz9WqxX2hkXx+O1mT/8SVNDHKDheHePXfOIb8HGv+WX48YffjXjh/Nzyh3VsnUtD6kCMyfVxuo9XDNsEa7qpK3cMhrNq6NCndn0ztF+cMjW9drx+V5ouZ1OE3expoGBLSwk3YGnOPWXVEY8LiNmoRNzRMuEDKJgBinNRBAFNmbRQopp6JYh7qWcp0xaKQrsgrRYebFpwflV6UUBheRqMwDrBS5VVusDas9bsD0KRKNCHZFe1dHXtLIppLdxJE44CoGqdXtSer/j5lzRfMWZFdsPT8tnYhjFM/dKdYLSr5mnr+Yu9200TpbaiQXVi0CaVQVZrppCWrVUcrfNcr1IGFo5U+z2xas2qFKKYfzeRqvH0NJhGunNWARV6BdZIjDzGneNL8Ts/9ltxh9wNoxZyPTcF58wSmIKURsQh4snrz+Eb/uQ34/v/9T9EeNHtWOwNSJqgMcCi99iqTJrEOpyjjYRvMpbTAR1JMAMLRKze/zi+4Yu+Bt/x1j8KW2+wt1g4Z1c+f0aZN2w36AS6gZThdCNzlRtNm+18FiN3+mm9ABoLpOD4+Bh33nEnPvM3fCp+/Cf+K8JttyHnseEJ6zRzDyhQZVZtDmojuYreTq11ZVRRpCujrSeJix0TOJsK3SqDVrpQrLbtlPUnPShNVWsLbWQbktR6JU/79AzAZqxVMvrAu+PuoIxTD8945qHLjhBBMAszqnZjcrDzdp/q5aKnc4XqmuurdKtipfT+wkok1qM9uTJMTpt9r27fEa+Y2aW0UFlt/mItqtJZ1TGX45DVI9apn49IIJIKkpZUrQyLyGXWYMrldhMk9cdq+Z7UU7vUUsAuNYMgY0r5/O/BU0EIMgIywpQOQjB2qV02QQIxmpTX9wlJKaO8D/9XfbG0S2m16MayRSgC1EJ5juCf68qA3/aKb8T9B78KmldVRTIDv9pqhlIFDEHwgStP4wt//5fi+9/+j7B3372ww4AUFboM0CjQAFgU78aIU4Yh2yPH6obSuhI8kkjjiGjEySPP4Kt+05fgf/iab4euN5AQZw3pgmlK1i/t3mvDZ37qGxGHPWhOp29VmzX3Wydutq3K9S7A9uHcbONYqbeQQs84QRIWZNY6wdLhIgAk85Qc4lajzOnHPawxIqSBlkZiQWxGlbDjuTIAyQEZyQfhmJPhvayp4VDhC7JpsTT2N+4qda+o1vTPih5LvOF5AjmrPddTqba21tQ2HNVJ6jHZxnCmYtcCSpNgtGsSbTIHNPsahZPW1cpjas1B6Syoq0gKz1Q5Lpu8rqoEwjqjvMajSZMM5GrdXPimGr3lYmVzajjEVE0tI8DmjGsTKeoUPs2iEzZImHnQW5vao97DWOx3V8dr/IaLn4c33v25sDHD4h6aMXL1YO9AK6WExWKBDzz9OL74678cP/wz/wUHr3kJ1mGDQCJTfGqb783FIXNiTerAhtm8R52611m6D3LOGOKA1WNP4s1v/Bz8T3/wT2JYGzICfFOtPGgblv3h8Nv7BeKxfN2v1yNe//GfgNe8/OX4ycffDzl3OGvn6S2B+tm5VkeHSc3yOoU7J0plSvSKi0MbS9fTU1VVatRdPtCcxpPsCmKlqxb2d8g1VYyRw8o47hn76ClWwt2Ra4l1CUwkR3qxa+NbMowZGZpdb8ScfY62oKusTeS3H5DCL0EpEE6jqjjzSSkV1DKICG3wOztwsvIaUhdekR64fqp4UVfzu/54aedAqi4DYfXCsqnhxsW4WhaFIlNxgoCsS68QsoTV6AwAWb2tQkkLrdh5obOGCW0D0W5yjrWJydWyWJwYrRuUziZoovKJEyD1nGecRthja8gphmmaza4J1SDIUA6RwSxgyBnBMtZREBixsozb7RX4so/5ehziAjLHLu3eomgNSJoRKHj6uWfwlj/4pfiRn/pRHL765Tix5IWMIK1Nti7CyX3AI9S6MbE6GBQvfZYGQhGBjQlLWWL96FP4nF/3mfjeP/pnsFckWlF8E9LtFknghtY2ddx8kjqYrPOBPCM9BE4TY7tU8TeqBN5KyqhGiARcu3Ydd9xxOz75l78eP/nedyNcOI80ZkAKyYJpQ66yqkKHdryntkb76sbonXDa6Irm+lfmQ7MSrey6LvoPzxoblPxTJzCczaer+WkopHizSCkHNQLYjBhnhPtJk2D7r3vlh01/pxEpRV8oCbAT56KsTwMzSmXQJQ2qbXa4O4iaUnUq5WO7FaboPqyS7nXmduYpfZBo30qzqxZfQmHtiiTN+sVaOtE84FvVpBtsW/5pSf3Uoqd/IJIFpFKtTSaeHqpM9i1aUkZFS/Nq5S4V6xizaSiIqrRUrH3vU7Vmr1xv80bs9s+kVSK9qlerQV1zgG5X/brnVmkWzlN1ULGB4FgOkbMhL46hxwG/5UVfgpfvvdrL4SHMTF2rrU/dSEwzshi+9o//QfzIf/sxHH7MS7GyjUsUSoVPgkBK+9hsUrbtzg+qPEKMCJZhNmKIAesnnsVv/IRfj+/9I38G5xCLFCIUf/kXMMqLcB3clk7rF08KOU3C+aRPfAOYCwdrvRDa5m1A2m3+O7Ub/QVTZB92CsjZd4D152sKIAoZW3dklmpVUxEoixC1SRcg6ASU6eYpoYV92rgh1jITdI3jiDAMjXzKyNAwFPdOFu4ClYybfoGPFrPivmClv6+N3myVPh92CgWt2GRUyxZa1ZlW/y8D1FteRCe+rjm81qqITaBY3RVoVgj5AlotcrFmOcOSapiWQWNqTb+WUXoEpZKV1RnWJiqsEPFaPquxppTWaaJY+r1kZpfc1B5dhbHKJqZhpZPX+kQX9lGUzby+hNN+ortskisn2OYElhYhA2J2UnrNEQdxgWePF/iYo1+Gz3rJ53vZvLR4bEcN1QUhjSOG/QW+9S9/Jy6//Z/g8DUvxVoUNgQgBohY6XNFI6rNdlMh3BZ3ln7RzIRhWODkg8/gkz/2E/F9D/wV3LM4QM6GIEPr+WRnoXOrX1XYE7qp8PUs6C8WyBLBmDI+6fWvx8H+IVabsSuOdLxtHWVHXz+1TYrF2JecC1Np5hsKp+G7s0nh6NTr1t0B3fxJ6Qj+D/eXKiNWAA73gbDhCYyxSbEGYByBFFBsIme9doCcYu/c+bROApqPlWoGetqdeW1jcMoGwTYXb1aGsOqoqrMeuMpRlVtalNQi0ApinOQjVsd9dzuDddFX0U0jW8aoQLJQALM6x7JV37TKJ1icnYsDwTQLYxJxWp9KgpN6vPWRWgMu7dLmZpts1Rq5XbWth9Kq/1a5WLPN6w497zWjGCrHyGnCtA/aSFjKgCvXDvDed2V80xu/CneEu5EtI4TQTTDmVDEzwyYlLPf38I9+6J/jz/zNv4Tlq1+MVVRgcB1Va9OZcqyuaRszJo39+OwaEZOwKBgW+9g89Sxef9/r8L99x/fgxRcuIaUNYly0LoS2oXVVuhtZIM+PmM+q8kkJfs2FYlZg2OVldePUr3/t/r284OohgZOTNe575X2459IdePjq0wiHB83PzdAYEnQ6hsn/qgOpU8lsNwXcAwudrNO4/X2u92rBGjuDwWp7pP0ggC6EKxnK9AYSkDqHj3UVjpbWnFMHIxltEQkFxjF0nQxlAm8u76NLPX2S8TZ92wEbilu+lbyHRd1ejEPZWcGgaY2m3idTKTPWqsqZkxYnoxmibJ/8tsvUymIl0HtCv6sSTH5YAssoaZ9HsO64EX2+4CziKSaBne6pNbJjcm6Y0gpplc3Gc9UNS90jS7upZjazipmqoq2JuW4NO8d8sYvU5gxsS8MgSKoQiZ6+EpB8iMd/VvDuh57GZ7/qc/BbXvMm5DFBYvFWEJm9livgE+IQ8MhTj+GP/Jlvh14YYIM2PVXjqtR8yHk/CsbmTY/1gmd34DwCyIiLBTZPH+O1t70C3/fAX8Erbr8b43oDLgZvLK/cjc0IlFtSnlvlfODeWhwCBg4YYbAxlTa5XwzJoRv83XHpIl7zMa/Cwz/6KHj+HFAqhrQ5qd6F8rO2qyYelNmAy1kfIlsxyJqeb1pw5Z808d8NuyZuUb9B2MihdMiMA2akuxz3d153KtNsRKClSq6IecNi+aA+o6d8r7PpoD4LtXhVtbSvUYE1QnMAEpM27BFljqBYL/CQ4hjq6Zp1F3FrOejI2dnw9amxvEVPPlZLOwCbjmjzewdbS1Au/6qNz8QzFQtjTBbEWuULRbqQq92xalGxW/c4lwO0EVx1rFYbzNqN+6r8VnXo0PkUnsnVgTv+TZ8hoyjvOb1fhZT+0gBVYBEFxyfEf/sp4qGHBXH9IvyeX/UW7NW+1bNM78oE7RAG/Nm/9hfx7ve/B8OdF0DVlnqGIvRlVWKXSm7zaW4fymZczMQzZsQQsHnqGl4+XML3//HvxevufiWOj4/BGMBO7SamMObmjPr8Mw9FXAx47yM/h9/+1t+F//jOdyAMA3Lf/PoLmhL6BiEk7n/1xwKbTdkQTl/XM6bR5seY1lnOmJ7mEs2ep8bWZEoZb+CQKDt+zr28oYujNmfKGqbbFTMjR2/pAFyDreL1exo1F88qN+GiWaaimEX5QitDIqZUDqpQFYjlKbxulcB6lANMPcKq8oQGSlUU2cr12sSc3u7TVV1UCxeGaYFUs8Tyniajfg+Rg2aAye1+ETGiAGtRpbfBpsombnQhnDTgQR0wMQ37KZFWJ1nrvK+ac0KxsumlZJOd8SRURVcB3Z2idAJH9FbIdfCF2wmrJmRbQ4Y9rPM+Hn90xGOPAZt0ADDjU1/5Sfi0V34S0pggg5w5XSbnjGGxhx/98Xfgb/3Dv4/40ruQ1BxIxL3E0PlsMQNWzv8UQmGm4K/yEzEgJ0UMEZunr+Ml8Tz+zrf9Jbz+lR+HvF5judxvhPwkMyk5UbNS2SHNKfNggtbU3GvQOW2w2NvDTz3yML74D/0evPM//QieWF/HP/lrfweLMJyqAN6o/2/75w89rpoql6mYTN73qvuAZJDs/m0scpAm/6hVwubuUY+JY4tUrZawDSOeJCaGXl5k7PLBzieNWrz9zMzm1h9lzGEZ5WdGtwCW4q1lk6JdevlDwngGTDpgrQAcO23VIqxwpmx0FuZpiSt12uC6xaaTDKFrkSmMTRchWed46RkjtbqraiuxUqdRXDaXKzZQq2VrtW5+YK3GtrXB06WfrvQJ+qdKKl7xYyjiDEz2w63NwQfdtqblDqzQ3DamJvQ245BV/tC5KtTU2rQ7huz8qKwpq1Wn9plpmnQ/g3o6Bw1A63QmEKonoASI3IZnrije//gazx7dBuIQw+GIcO06vuxTPhcHYcBoK4DLmXl5a8qlA2wW4Lv/9l/DdTvB8uACRk0+rbxe3+ozMatpoZh1yfWssWJaFOqjq5ZhiZOrx7g77eP7/tT34jd83Cdhk44gyyVoPj3ZtiK+auJ4U2lBeTkhMZ5ssLe/h5/8+ffizd/wlXjo8Udw7hM+Dv/XT/xn/Kcffwf+u1/9qTherxBDfEEjvz4sktFyrqXoMl/6spf5NTjmGZhW7nTSVtmcSLc2R3re6dDObe/UsXWHU8Mr2YTf7CQMtp2St7a7Fpe0x52FNzuDs9WOG8YRSGMv/slbcXP3Pc3ZXcsTr9YqetrHf5Oj6vSP6CegSiffsJoS9ikCOktjTDxVr0Hqw1n2al/VGb1B290K0RqJDd5wnDk1MpsUNXgvS6ip1jSJOdnUCO1pprTm5N5gUUszdJ+K5qp0Lwp6QzUPtEla1jbTzrgV7ASlRb5QQFwtw7ABFkscp0O8573AT7074OqVCwi2RIgZm2eP8KvuvB9veu2vgiVFYCwAbafM6HLOWAwRP/bj/wU/8G9+EMt7bkdKyZuNWVXX9VqQrljCrld2+sdu7qEZwWGBdH2FSxvB933HX8anf/wnY70+xhCWJaqV5zVMojV95LKxFRfuPI7Y29/DQz/3XnzB130ZHvrg+7B/x0VsqFjriH/+w2/3yz1rGfLwC5ccWgHgccy4/fY7sNxbIqfUGfX1aaAWzeH2JF9ta6GtyE7qgx2AXGmTGvnWf7zRG71RSqgdtuRcxkfdotL9pDx+2MxzzNqL7zNRPcHQqtUoXuIVkVQnfgugD3Y0wTTGOHt/YbGGMavILJN6vSOkm0xBu7C0kap1p2DLwdl1qVfiscklinyhnbxGws9PpFRpmRpyaa8BwszPvVkBKVsjsZVJPFqCdmuTl8OMn+wHTjSlOrtBFu32zp99202vs0CuuhyDnr5OTJAtgG0YlyKEJcwCHnsi4gOPZpwcDWA49POXTiAQxGPgt/3aN+FuHkJtBMJQbJVOO2eqKkII+F9/4O/hyNZY7A2gjrM3Yjb1pJntuJa5FelqGZUHg65H3JYG/M/f/ufxmZ/0adisTzCEZYlEpS00e4HT5QXAuDnBcn8fDz3yXnz+138ZfuaD78Pyjos4GTcuAdhb4j/82H/EJieE4P2du1K+PmW+WQS23Wv4vMCqPH4zjjh/2wWc29vDMzlBhjBrgmahQ7QrtkwcMFuPe1/l41z4Mr3HyZe7oxfYWkjqJPtTKXDNcmplVJv6ocmonk+sGnEM4ByA5Q2EJmk386ZdqUH7q7BxFjJdFRWY2ocI3cIvoUIpN0xuh6e43WmM166QCF0LR71/p/+yrRNT36awF5mWYmg3I7A5JmByAZ2dXquygOqVLlstMuxUHPW5tIFTc7rROqY1tApg7xTaU742EyjY7LbpWCjAjGQZIgEM53H12gKPf/AIT10Dsh2AUaC6dnuOPEBXCffEi3jjx3wy2OmSdlXWcs4YhgEfeOKD+MEf+bfg7eegmloa7L2zReOl5ULe9Xy6pcMq5yAYYVdP8G2//9vxBZ/ymThZrzEslm1orU8zeWFRSjZAhBjHDZZ7e/iJ9/0M3vwHvwo/8/QHsHfXHdiMo2/Q4gPL3/ueh/HBD34QL3vpS5E1/4IpSdkA0ZBzxrnDQxzuH+CZ68959COnr++Z0Hyr/Ubs9DlmJ3uZVAu9DMI+rBFm2KKcJl4qnh1htSqh3ACsiqgQuQwR0NO8VW8d3A6QoumrKm2IfqZenVZcRJm01GvSphOQp4ZObc2dnctfsUCuqnarjhFuEzGrfvQqeNNJjzV5yJcUT0vPW23dqerCPveHTPdvfXs1JutARifbsIl88r5BbVmtNzJZR5JPsr3c6WqmyKumnzgl7ygt0lxgTId44jHDY09usNlc8HHyAlgqUpJExDFgc+0IH/+qX4HX3vYyYMzA4JXbXZdnSgkhBPzr//BDeOTxn0O870WwlGFBfLZgnQi0jaW8Qb5gHr0rgHyywWvvfQV++6d/tgtSh9i4SylmPUbsYMJuVjl3J4lxXGNvuYf/+t6fwhf90a/Bz1x9DMt7LmG9TkAAOAK2yRBVPPP0U3j44Yfxype9HGNxR/iFSwmdw6obxnK5hF3TbvOcT0qq1fJmPKmTgxBkLq9qUZzZXCLXTpzOpRE7ogfTEgXoNJ26UtGT6+kO8OixStG8sJYdPMXdh2TEOA6Iix3Ql9FSu/r+daqOdmR2sdbU7QEK3afTgDn73c/LY1czmuxQrE/5uhh5WgPWQmaramWdzATZIalpi2P8IrDO071wR1pi1sxu7HsPVAWUtFEv0zj7nlOzbnqOk/bShLhWuK/pvqj2HFtCU+5IEGTqPSxEZx1KETgg2wVce87w/g+ucP0kwuQAMkSYjX4udSjvLsG4BsY1fsOrfjUOGJEtwZo93ukIS4TImvEv/v3bYcuISEE2r1ah9myyP5u90wi3GrGnFEJLM7RuEu6+7U6cW+6DxYI51xh1e1jNTfoDMZMNEuP6BHv7+/jRn/4JfNEf+mr87LWnsLzzPDYpwQLBYl2kaURcDBjXJ3jPzz2M34g3uuwhxq1eyo/+l2rGIgQs95ZeBSd9BnizTZ60iGpbx6L1aZaYoZPF1aSn8lXWC0V7rWXFr/4C0R6QbgDqeoMw61Y4rKrB2gDQjZcLx7QtbwgIMGQWoEm9Bk3aAmJThneVgW6aT21EbpFCs33J0yzGVs1z/RRritnspDHNVWvSBy0+YuxST5saoWFOBteBpbCZA0DfhEcTbBAx5uhGaKIQnYhtkp2AlP1g3eZNhtm0m+0pzYXT0g6mt8352gAHr6pmC9haeu15rfggZXVvKuECx8eC9z8NXLmSgHwOEqJP7knrKR1FctAOGUlG3HbuLnzqS391CUOmNF67zdTfd0aMEY9deRo/8tA7wfPnYLm43oIIrkD1eYky2STdXNdD109RwMUefu6px/DM8TWc27uIlLNbxlCQBBBThDI55qzUtVoi+/7ijb6bzQb7+/v4jz/5DnzR178VP796Fnt3XMR6k3zCdWnlygFALJvRYPiZxz84nc1OC8dbAhc9e0zY8+Gvtsi/iIChVLGF2iER2nRxqYxUlR+QE8+K2ajKqkiawJiY6yKbprmaiBoMuTXrt5y+PFizTeEV69zOXLbBLgZKACx5xU7msyzX66JgWNUEcIXaDF2EWuMsI8wtwMpu26F5Eo9qkTaUKhAsV5Z+IoKtMwzrjASrtWlvKNbvArTTlT72Z68TG/ZxWgOhrdYhK8LR1hPXPb/MXssBaDR1cWdpSG6VO1TvKW9yrgDl/lXFwrhEZ9UfK8NKMzVm0ZuBWwLRyZZ4aoSW0vZjnQtEdCeI4mGvcCcEyD6yXcDjTw54z89u8OzTG8D2Qe5Bc43sxKUjRbCpWQEJwCbjNbe/BL/83lfCLINBEEqaLbbl/1bm373roXfh597/CIb9/aatUpuaca1rPrdb/OcbSUZYLvBz738fvvvv/A1guXBn0nKt1e2xykNuxPnk4AmBiCCtV9hfLvDD73oHvugPfDU+ePws4vkDnGzWsJyhOZeWnMLTBAFDAIaIK1ee7Wv3v3BfpeIbQkSQsqE1pxE/N9u+9zdi8GcC6r4aWIS+1N0iUt4iyBYPl0Kn6M4K5C2T7scA9k4XfU+Lr7SkcFLAatZ+VRPhMsi0doiXaKalA83HyibxGaQcDE732dpJZMLorSrFxDfNm2Rtt0tZ1z/Vg5V1J2pukeyuDFLGVNG4YyBEV9WDE+69qeDMp8q6tHC7ytx3zxhPcS5mHV/DOhG8VGdpiGEPZufw3NWMJ546wdVrBOUihBma4zTCjNWJ1X3UtFZ/sgIrxce/8pW4PS4xpg2EYSep7afaL7r/8hM/Dk3O6aQxAUOZMFzOJc2eVzOsNfMxIOsGi9vO48//r9+LCxfP49u+5OtwvDnCXtiD5GqjbDcmwKs2j8BmfYy9vQP8Xw+9E7/jD38tPri+huHiIdZWho9Wp4O+NiDesI4h4vr1a7ckHP1oMO8sTsOjqh/3Zmipjc81ww25Nm5TKjvrWFbnGJ6yYj6r0DvTdOlkHt4qApAXDlhncVgYhwkpuud3gW3ANJCvK0ihrw76BcCi6q59SG3ckHIara5Nr9nxTjbJJZqg3ZqSfdZ60LRV1kL1xmMlQz9pp9nLdM3S0lUIpbyWEhhBJAqk2JawENwtnG+C1W7GH3s9lLfbTIg0LzTYjiKndTt4+wzVxVPnl0ZWgwjAsIej1R6efGqDZ69kjLYHDrG1bZIo/XsZZqWWbAJRn2nISsyOxK948WsmXr9ILihbKaEZcvYd8ycf/mlPsbM2jVjfs8au2faWGfFO/JgIyO2HeNtf/fO4bf8cft8XfDmOjq7h3N5hIefn/avbEoMqxRjTiOXyAP/2v/0YvvRbfz8eTUcYLp3DOidQCSkFHW0Vzsk/jEGARWwLjqUVydBRE7cgYeh/P6tJuv8MN3q+Kh9YjyNOjo9Lr2uJPmXaBes8z2kjRysPVm5YSpGnjv+qA1Xb+2hp3sT5sl4bN8NWEfTTW62kiPoCQasZ+C1vFGGlKk3Ibj/RkWb1g/oOlbtIIpemSTY+i8Uahh2R3Ls5qJ1OA613imxuk9NbmGjvicu5VVORXkwqM9mDt9mM6qAVyrTnitGzse+T/dfkl87p+xT9EugYhUaxbS3sajKBjtScPC3QvOphAeQS40bwzHMjnr5yjJPjAIkHpeydSxzYpQxt95U5y5kNWRULXeB1d97XXjtgohtb60t5b8vFAuu0xvs++H5gGGbq/LPkJrfO1NSUxPksLgkZ9vFNf+VPQfb28LW/5YtwcnyMvcUStXVt1xq34le+2Wywf7CPf/HOH8GX//FvwGNYYbjtAJtxLFYr2sr47XzkCexYPPEl1Mnc6tKTX8DMUCiIMeJktcLR8TFq98W2rOGGR7kq2cVOkeDcUcmYJqXTH9MVutr3ytJLf4FPTypncO7PT4d13iksWwOL4Cr3U15fqY2dA5AdIWcRVioRkF8AVsViWgVlYYIWrbqOqU3DO7kUUwI5T5fYtfGgGyRR5Q2opCanNpxbWSvtAJqWXWqy+0mmSN0JadOfqx7LOuAtV7t20QmqoLNVFOeXkXV14z6lzbolPtN6kTroiARAB1y9Qjz71IjnjgwYzkEGQdbSduBG6YXP4KQfMwKIpf4xVWF1VNw2HOJFh3eUDdjPk5TTLDOJifebHT13jCeffBJYDj5cQHYU4O2FwJX3+LmRAJFhsCHA7tjHN/3F70DYKL72838HVicrLBaL5v+1HalIEJysNzg42McP/oe348u+/RvwTNxgedseTsZxxrJoVylj1nLdlu6AwrHG6AlJEPkFdfSrwlSSuHbtOo6uXwcHwHK5Nm6hEsDincUa9UjnIFs4MgmnEK55r1XjxflrVVGXlgxqqqR/uL5mnu7Axjn3TQmyEgCNRdZe2EsY1ALEDIrgSzRP47/LDKsGMCw9bD6WS8oCltZWk7WPImSartEksKHJDNjnnjppsupQVJYUgcWfSWZasKK/qu6M1fO9FVakqLkVsARjREoRmgUjgSwl0upbf7rJy60e003E6S1oTinWpdpAhpK4SClk1BJHLI3KuTRKK4yGGA+wOol48ok1rl01WF6Cw8JTT82+AVTL267B2EFdSprgAXmuKmUEIG1w9/5F3Hv+zi6U93ccZtIvP4YBgqvXruK5688BQ3mvauVSqVGPTGPb/EnPQKmt+5ThFv24YcseCeSDiD/4F98Gi8TXfvYXY310jOVizz23Wrrkx3l9ssbBwT7+8X/4l/iKP/J1eCYqhnPnMJ7oLILwQ8NOJVkdMKoDiYfbl85faOGBtx5pkZBwaiHbVoMDO1XvtsPqnDzTErRE1zIBa1lnTz39FI42G9jyoGnyENiamQUybeBSd/4MCwRscPmGoVAD9A1KDbTcNUBP49Sq4zh18nnfsjTbqg6ksukaYgwl6BLnwqcZUw2KchNi0SfmjDXtijfisHblg9syCjmtu9A6QlamqERlyp1bpFRJdjtd9aspj7IDm6JwK+X9bUEptmxiMCvB79i+d9gst8CtU736VBuBiNvGaO8xaxOBaP0nsbkJkZ6aO1k1aj4ctaZnrKO3rBvtjgRVD22HeB6bHPHYYytcu3qCzWYAZVnSzjxvSVKv0raCyGxeI6a+S/pFGkJEEuCuc7fh3N4BLOvMEWjOqk58xGazwWazBhZsxKz7hPdiH960qmTbvZ/Wl/GnVBjrBBPB5iDg67/zWwEFfu/nfjGOjo6wF/c98iiNu5vR08C/96//P/jaB74J16MhHO4hj+mU4r5FC6c5Y/8lZWA94kV339N9ro9EiHXjRK6PwlU9mnrqqWeQR9eK5SqkrVo/MVgY2/XGYt9EizDb+GeWjBx8zUoe4LPlc5lhya7NlxMdUxujb1Yt3VLVfziMSDvAOnFQ2BSF6djhVGkonG0UZVf0CTUykZQ1wsnSwkNWkrn0FLZdaNYfmKcKYyM88zSsT7uJN6qd6WHtFdRC8lvXFH3r0ufeYqbOmRtVMZohVDJWJ/njTMFe+gCbOZ5OTrI19J6tBPPhENMBnlJZ1F2xumDJEpYP8PRThmevJqxPAkI4QAgRqnlqyjFpsoc2cANTTx5a9Fl6L0u6RYaiZTNcOryIQSJyyqA5IS87oqK6uOtYeaGUYkrRoamBnNwc7MO0mA0KbJJbLN+2xDf+j98OIOP3fu7vxPHJMaIRQQI2yNhf7uN/+7f/FF/1p78Z630ixAHZfM5hniaSbxH1c7BslMzJBlglvPj2u6b3wo9uVtjPHJHSmI9AvO/nH3G+cTFAU/IoqolrBcgCYx2XnmFZAEZk2QOoEFWPqgjXGoJgXhQw0k5kajN5US5mnghSTeOmyJynwaoqy/XDAlirm91FkLcmFTrj5K0v0+GUwk+FjjyVlvtOR11OuSuIbUU+dvYOyO4AYGss9/Zz3LAE3Tk/9FeG1VHxxXE0F4tmKTbFnIX0fVOzRzTaKblbSlRFdc3jvUz5Ka3vbYoJgIwEwQDYAa4fAc89vcbJKsDCAAYHToN21STpSPmualWijUkh2A0naGG9+SDTbLi4fx4BgmR5CiB4Yy6lr2ixV6v06fiHsq32KRbpbqdqwBCRzgm+8X96G5bLPXzlb/rCdr99AN//w/8MX/ed34KT/ejme+sR0skWdpZot6hDgu41tU4QiXjZi15yOnz/KHNZ1qUDBuB9j7wPiAEQmTzztI4pNqiUtCyW7YwBDEDAAFhpktOALARkU6ZFi2+aJf2va9OCtMCDrFOj7cZuGdsRVrFxUQmte8ZrGRn5Fi6UOAuwlrvvlLf0UFLzeAvueV00t2xe5J1pXHNqYAEvTDMAq7vqtr2vz6Z3rgu1H2qaMUfQya82MrmmDjZPLbvICTtKy6cArSMS1QwjgU2rEoapd7Fp56WlNC14UukSRD/5c0vayWaWZUola7rGUCxCBMfHEdeuJKxPCMsLMEQYk79+eQ5Td4IQnUcIVtw9Zxq1DsBp0oaQWtBCKgsOF8vJ8oU8NcG4LeQSdS0XCywXS1g+af2ZrXWqO87ENHn6+QDUNptjxag8AEjZgChI5/bwjf/jg3jHu/5vvPETPwWLEPCv3vHv8Tf/5T/G6lAwyMLtnUXAIgitYkluywn6ghfgU34SkMYRd912CR/zylcip+wjxnSaLF6LSdscVu/acNrHnbckg5hNm+7eHIVYrdd493veAywXzreVATGtX5ZVvB0QbFlmLRBYZxcb2wlyUGDvnHPYmnwKCQ2U4BN5oN6EDiBb9ip/CGWYiuJUZtgmodQKlRP6MqvRSUdeuyuKk6rJqYh0tlRrN4e18ddKjcJKzQpC4OoF6XxJqS6unKxlyq6eORGhtf/LcktXdp2zfvNrRnw6EUwsPj4VrKpiXboohy90U+8GMpj6ohi7KLCmUrWKiDrxhZxJpOrEoFp+bhec6jS5REvrTdF5RFkCNuDkWHF8zbA6VuS0gJQd0VR9eKuFxlWxAnkN3nVKYxqQ9hY9pYprXSeq6dRKseSipXzc0vyEEE5FuHt7e9jb34ddvQ7Dwj8fiNr9MfVE4tQgzpsxOTv/XuZvpcKp6OjFntWC+J5/8H34nv/jb/tCCILh7jsQQ8CYkm8KReorih36oX660SQdMTXEYUAaN3jt/b8cL77nXqTN6H2OtEYOfFQrhOXS39vfx5NPPIGf/tmHEQ8PvFuhFqqSQjfJry0xTwGjAgeA7G1weNuAu8/t48J+xP5yxJiu4nhzHZtEjBvg+PqI9UpxdGQYV4pkAiwOgYPziHsBEgw5p2okWopOis605iP2+eMKk9J9s3EMqgXCZqbVNz5zSxCgc2GFlHFc9X9N46ndwIROPVv/Pt9P59Nd2uCIymVpPXlTvm5bZO3OWovtFkZXnddk6qdQEYylFyp1/VEVzBrx3qq43DlWOJcIqi1e606qGcQGBA44ORFcu7rGZgVYWgIWEUKRKaRcohppiMgemIjTUaTNB080p9M+Ci1cm4wG3eS+XnVK4LhNspplHJ47jwsHF4An3g8cHpRKIueOsBUdtgTIOCPlvBGXHQoD4Vyw+c5fSvLD7bf5q2a3hEFKvqHVDgw1kFLasGy7NlKqpdZ40eraMYSAlDJ+/Sd/CoYYsdp4B0Cn751zlB86S3ULKaFif7HAww+/B/9f5t47zrKsqvv+rr3POTdU6pwmDzAMkxjCkBFEQKKggJJBUMH0KCjPgz4KCqiIoIDAg2SHnBRkAAmSswxhYAJM6umcu7rSvfecs/d6/9j7hHu7umcGBnmbTzPdVdVVN5yz9lq/9QtHjh1GZqbweY5qENKJcTCbIlMgaxKS6R7J2i5mnUVnCqY2ZWzbMOBOp3S5aNsa7tBP2DoFkhxiaWmBw/OW5dE0x1Z6LOwSdl13lGt2LvKjHSvs2WcZLnQhWUPWBTFL5N6Bn0JMoN2I9uJ2cERluXBb+bMm1TTY/lUUBGZvrFg2JuaolbC18uCNwUQPqyoYYax4RfGsluPnqqnf4Dgu+XAj2GotjAm8LE/L4z1qDr3UVjCVAFl8E9klEX+SlkNpxZrXKuRRdcztoZaOEA3+4irWiSX3wf7XG9skHVf+8mKbLmWiCDYMYSid1EVAvQtFyoQRzIolzw2jFWU0KPFlSiJZPL0V74poFxMdP01LLR83XRr1lPVY6SuLmXBhV6OytLot1YBZVaLTpAzusqMyr7vCanwZi6eqJD1ica5kbmqaMzefxveu/kHoX0woBF6aHIL21k+8rMrqbo89J4OFfKTXWG04uCaO6b5oCG312Ob8+NEnTVSa1OGi1Uhu6j9XYaIqBl8qHcl40P0eGB9DkMRI7YXe9l87vtBPjnptveSJxsCTtVdqBHWOLEn43hXfY+QLumtSPJ5Ot0Myk6AzFl2TodMGeh5SIe94XNejvZQlSvYeMHxpTwHJiFP7BRfMLXG/O3a45Kw+W7rzDDnGmdMZ3UughzCkw/DIBm64sc8XvrzEpz51gBtu8tBZS6cvFCoRPRwCOeI8arOgsKhwNdPKHGpVMGuapsjdIuLobGyzRi0OVu3rXtZVMhQcO9lUjYHVtZiy1XpL7dFTxdhHV0naoyL1eNfgS37MKub4JXiL1sSkSQ2rbgvlFgGllZYtRH21I7c1Rne1tYo6ccM12iBQY8fcGIwJ5mtaZgwHwnCYo6UFMhKTRqKnHwuLbYJftZXlFwc331LGe53oGGglWY+D41otAOLPoyhZWliYwKsmcKdWoXDeYUk45/Z3gM8riTXk6vif+jXuNy5jfuTtjnDVQqDjflHhNYli7Xggeq/YxDJaWODi29+RSy6+G0VZBNLoz/GXRO//3BV88+vfAJuENOxCoCwpBzn+qCL7BelYTN8i0xaZTeisz3BTkE53kX5BLjDSlF3LI3btT/jUVQMu2DLiKfdZwz1OHzA4coT5JHT6XevoTN3ERXcxXHK3OZ7+pFk++UnhHf96hB07e2Qb+jgZos6EDs+UqM8QLcfo7avdes45MMnJWFQ3g2HRmgfLJAQdRt1zTf5zMU3WjbezYQtg4xbKjBPM2l5UjG80mkWWa4zfWhs8WU2vpa2ujYk/r8K5khOMiZMrjSrQo1BD4S1iTN3c+HanRWvUkvY41Yolq3AdLEJCWQijUUGx7NDcIiZDSEKBLFyjMB1LsQ6vk5oWubbV3VVcJW1vCVvjMq0ADqnpD00xdGUJrmRhYTFQH4ys+mK1cccKeD/3nDtCkmCiuXQbQ/tZZ2KdCJxuf9ysEnradtNsBPQVRQfEKV59oOvML/LLv/EQ5mZmWRmsYJPk51esIo2o3+uyZ+8evvXdyzEiDPctorlHfeQfGQnmjFagYyERJFVMV5CuwfdTZLOQbEqZWWuRqYRius/IGX5wNOdlHyt58n3X8LT7TpEV+1HXBS0ZiGV5VOL9Xvpr9/GMZ27jUb+0hte+boH3fmwXZmYDmiX4Mgt1wubR8+6W/Lplh11SbwiHsaMbmw3BJjawTV0E9qX1vX1lMOfrsaRKqZFIgKy81ttGk5UKXOrRrunAKgtY0Yp0qQ3YrS0cqpWx5rWl+6q4YdrEz9P+e7VZ9ONUvHZXZ2LXVKqNdjqC8WHDpLW8xdbthmrjXlBjG7FgJBFkLz24QsiHHi0MoinG2kDSjGxqafHKqk2iqYM8tPYwr5KmGxNqHRe2xu1q6LKif7wPacZBsB2XF/H1D+Om4dDSPLkv6ZDUXlztMcePmbKF/975vPOZnpljVBZIEvbIRpsk7luWtjxBNTkhfqMnHKFWK14y8fN9226lghNoHaYxpLda5fvlEf2sz+Me+RhQXy8extnsLXx1lcdzHA7I6j7uNyt4rnhz3tPv9/jaN7/Frl27SDeto9ASuh4xCa0NB8YmaJqE5+wMfknRJaX0Hrm+ZMQSZkbJtmTI2VNkZ03R2TDFshPe/J2jjCj53ftvxuR7KLEkUuLo45lluVhheXk367b0+Nu/P53zL7K89FX7UT0bTZZRcYjrBdvWW7UGK0NZKoqgoLhFHdZyi+JQThTBCKCauCH0gHUE1nZ0GQ2C5ZD62zQMTeGZ9N/RmJleOyj4xqamLgR+lU5isvvyDT4lzWQ3xhC2vjVFrXqKNd7tYSQMxclEQZ1Wiczt0Ayv41ynKEsRwBeWsnDkeRnItCRIFGV6X7YA+dbEtQo7vGKpV7YtDWbXOFRQWyprLTmq/lwTWH3bySBuMi24xHBosMjicIVub3ZV/pRoyyffhhfhtG2nceqmTVxzYAfJ3DS0tKCit22XdWttXbTVwbNax64tMmM82Cpn2tRY8oOHePADf5mLz7uQvMwRY39u1jISt8zVxXvZJz4OZRG8qlwwstQYeFtTUlDQYficNFonMYIkKeI76KKSH3W4a46QbusyfbdZ0rukjE47lXdeuZv1UyOecte1lMOjwbjTF3TLgN/6LGUxN+TltTztKWewcf1WnvfnN5FzJnkyDz5HTdyIG2kRgX5yEH71abFiurdaNVcybj9aac18Vayab9lExPs6sJQx3Z8ef2W18K2xdgqaiC9hzEJa2lsl3+qoVuPwTJDYbhbH8sQk53CCjgcUh1xA54PLgfeKd6BOgrRGDa7w5APHYEHJVyyUKTiJaT8OdWXjM+8rDtOYifbEm6Mt0FxrUL3deTSfp+XkqnWRqsTmGtn0tfukCNLrcmhhnr3HjtwsZ0rjSFgWJd0kZarXq98u7z0/q1mwefxtbeZJTm8dB7rrZGMY8/SvFzFV5yXgBjm28PzWM55NaiI94uf4K4jilW6vy3U3XM/nPv857NyaKKUJB2Sdj5cImghqDeoz1KfgLcaHRZlEOpAzOb4zgmmw/TUUhxLm/2uZlQ8fJL36KN21Z/P2b+RcvnOaTDK0qNwdgo20SRKsdeSsZcf8TTz2Ycv82fNnyRduJPEBFK8bjNtoTVjfEx1oouqr5qtMoLTgLNbZJhaaZpNi4prVRBqDUWKwVYzwqmZY36QNhg1bDG6o/EvqjL6A0ZgWDaFOMKxGuxZLXiVuptAWXKUNf6ty9vSBieO0FZEV3Q+blGhfR4Z5IzgfrCrVuZCi40PX5X3EiDTIEioulqiB0uAHFlYSdMUizmLi62dJEBc8tKwYwpAWhM/V/yRSKSoul3ppkq1rB8iIzWjT3Ym2zi8fMBi81kTCdjGT+BycsWhqsV1Q71gzvYaZ3lTwthoLc9U6Nbiy43FFgUksBw8fZNehg0ivQ9tP38cxx9D8rh1ivZ5kezaRVlk5Z2pFS0gQSWiHllTb4+N+x0NAfXgdRS1Gw40rahBvsN5gtLkepVRSb3H7jvCQ+z+YX37AL7EyWCGxWcv8PHy/6nebBuKjo+1q497k87y1HZZzjl63zyf+81PsP3gQM92nwITCZOqzp4Y/pE5Lb14/lQQkiURuC2pjornHZilJ0qHckbH4oWOkXznCop7GB/57GSezwTOdYGEjMSFXFBI82pvihtF2nvIbjofe31HMF1iT1AurigMXXp9y7D2eHPmSuPcbM7kaDccL1qhNGm1tBZtQTzfxAT/udurBlEGu41yEdU08yqIwW7wGeWBsVypspm2/WncdLspV2ifiLSTWHdc96fg28bj9uTbjYGXeHC4+DbYBLTqDBjOHQJb1VViBRUtDWSjFyFPmDu8MhqwR79IaIce6AlmVNmlUWn9rPMPqENKKLd8yPmxsn1s/o5YuRdM53wrPdIo1MCxKtqQb+edn/wVnzm3EeRfTpX3NVDcm3hixpS2KAmMMH/v0J9m/axdptxswL2OOw5p+0pv0hFSlyfdOTvL1LQmVtIm1dSqMBrWGhmvSIuiooIPhhc//UzJrMcYEkzvltnsuP8FTTzsdlgYD3v/+9yNpUh8Mkyoj0ck43Qm7ptb/B5eQRnKjrgBjETfDsc9uh8uXuWl+iuuPLGM7SThEpNKpxlFVBqCOwmUsmf0841nb6Nh9UGTRI++2S8lefSTM2yMhQa1+MiDfn+DPbjwmSFvg0ZiB2GrXWSuKi1twkchJnqC5lXdEBVg7VzltxuJUBjEpzgQn01LQUvGF4kfgSxN9v9I4P9tVRpebGWPqUVDGi9VYUvL4M2+POGMq2ZqPRWMb7UKXZgsflCfDIVtYw6XPejkPPeMuFMUAa+1xOY4VUG0QitGIqakpvnH5f/PyV/09yex06Mq8ntBd8+duKwzHJYeP3fBROZCqodh3iGc87Zn8wj3vQ14UWGNbcjJ+AlPCn/6Xc46ZmWm+9LWvcPn3v0u2Zg7vytvodfE1N8ypQK6oK8jyWfyXD7P/h549S10Sm7BqJqEUMUAiY//KCne6c8H9L+lQHhtE7zbFl/62LljdFoCV11tCyurWszWIZeKGsM4ljBXaa4to4aR2o2sqfkzO8MEsr4ZQWqOCtqJIRKTmOAXvLNekj9TM61an0cIiqmToMN5o08m1WOJSW61o6Gh0XMDrtSLGWtQFPy/rbHDCzJUy9/hc0cKATwKNQ1MEi3rB+UpjJnU32v6tUZw8vomLXWiFi8UUZNEI5NfO0c0mUbyPREgTdYIm2G3FUbvaPoqPm7HcYb1QDHLW5xlvfuKf85DTLqTMc5KsEzuKVbZZ3lOMCnrdHt/54RX8+tOfzL6VRUyvg4vhDU2N1eNGo3bxqkanyd/HB1KsQr5c5etOeCRoK0ihve10Ptoia/yzIxFDOb/I2dtO58+e94LgflB1pe2DFE74eE8crHHzxNITrFPDY3bB2+yd730XeTmqQWyJJN/69wkOiXDJ+OMIu5ObYMVgnUEoUOvI8ikWvn6M0WKfrNOJWZ0+wiK+5T8WetXcCJ3uUX7xfinoKAR4GMEk0SwhVhAf/3bSMlasVrBW2n9dRf1chqQc5xzGulr4PPZNIk2gju7xMt5ytvoCQ8u9Utsbvjgq3kwDpKvcAFX3oLVergVEx4/Xo1CL4d5wxxjT59UjFALRfiWY3Am+AF9Qd1oBo6p8hmy0b1mt5zuJHcWJvmxyOVB9X681ThMAdakNDKvRm5bPfKA5CEYN4oJtcr60xIZj8Nan/BWPOvuelIXDZFlND2EVXlNZlmS9Dldffy2P/80ns/PYIbqb11NUI4f83Juo427YsbAR33SZpgrPrdxFS09aKu7oIn/zopdy5pZtjPJgoRzO45+AmX7btD9471m7Zo7Lv305H7/s4yTr11GWZWwAbmPlnjYeSGXm0a6F/YZiX0lC0iy14uvrKr4aQYHQkS6eIXe6QOjNFE1a3G06Eg4iiDVa7UssOBf8vV2d8NXqrhpaUzi5aNjYfpXqNhYBGHGiOkVHT+wNvtoLO+HIUIPLkULRMMOb0xXvW/yb1oPyTRxVs1ULp6+Wii8lPPcyBFvgCC4JFeDrKqDXT7gKtke5mxsH22+LxMTl2F1VG7JYdBttInVairZGwMZKup2yrSRicYOCGU1542//FY85536MRgVJamICoaz6Wud5TpZl/Pi6a3n8057EjUcP0jljK0OJZn8/5yJl6gCRdjTVOFxQLQ8igo2ULmzMSkeWpizv2s3vPuf3eOJjfpXBYECaJHWnrfLzfYZplvH/3vAGlpeXQhDuOPh6m/1KvMOJx2ugPZT9BFwGiz7OV9rqNON0UnpKBCOejipFucKGrSn9GYsrw9h9W42Ex/GwshxyzcB5koqHhg0reROIPL4tgq5GwmoLVH1MG8tg2qJSaOnamle7tiGpvlcbd4mAdXC0ZGLEi6NfuxK2nAIkpiJXnVztAd/yjNKWXzUIxnhEEsR1IB/EuPsGNJcKadJ6do1AePwSr9EfPmxf2n5Zhmg5Io3HuvGKlNTEVBETPbmaLpRWsk8la6r8alUbnV59k9ZkU4+KwXoh6RqGS8tsIOVNz3kJjz3nFxgOhiRZVscxqWm4cfU+pSxDsbrxeh77jCdx9eHddE5ZH0Ic0rChqlwpdcKVYTL4c7WP1yoBbbJ2J3lx0LKeHk/4pGWi2qQVMxGzXnuUxWdWbZBdSTfJGN60jwfe55d4+Z//FXlZINbU14eprxsdS6xZjRR6Mu7YLUnFqZ5alQNZOs/c7Axf/9a3+LeP/zvJujnKokArg8TKZK+CFiruYa3nbLrlOpFJhONCzOv3QlDjgyhfh3gyJFlm3ZSlrOKHvUaHhqqnsRhxMSOywAukHeh2DCy5MWsZ41s6+HieygRt9NaD7hHDKk/2j6puaqIrWLXcxw6kGXdaYPAq3UcjYqbWxa0a1a6B6tAUjvGlUUtqORa9PQ7CclxbrTE0Q8skjH0+GQuA1fq52ma9XhUzL43HvAbbDY3rlLEb2YVcwDqQtspiDtaPIWA10jVCgLavRxqtWO3asqpRUwt6q2IV9OKxkGVKoUPW0uHNv/MSfvWcXyAfjUjS4GPmK6mRNheuV88oH5FlGdffeAOPe+oTuXr/TrJt64NQuvIIj3truZkR90Q4U9UdCRNBnhNp3LSvmUmjRiaup5aPf6B3+OZacTEwpCjoSMJw134uPPOOXPqa/8d0pxvth5uN6Gqj5s9qPFRpzSR1jJvwD698BYN8BdtNg19VfcTq8efBeJpcU6iqXuAkM5qXaNwnJZp6dKTM9EvudLt1FN6BiW4sIrVjrTeCjR1+GZsUpy5Y3lQxVj+rLWHOeLmrKA2OkIpbj4CumQuPP0SPH++MCCpVArA/7qSdDEmVNkC4yvsh9Qjnj7tgfH1Tt29wPzagjZ3yejzZsNm4TeZOn6gwt7IIo3g2LBBME2UWj/4QEaWolpjo4OCj0sfE1boVqRcHFbFUaq6a1gVfKg5Wa4EVMhrDssMWBotS+CEzK4Y3P+VFPPac+5OPhqRZOmbM134mVgVKz1S3x1XX/phH/9pj+eGO6+hsWkc+HCI2CSe1lWYk/BkkImvrf1Vhm/xdF7lVKC7Gac3f885Frp3Hl47MpIx2H+T2azbx3rdfyimnnMIgH9XpOD+v8bZ6HqU65tau4cP/8VE+9vHL6KzfQJkXP/NHIChqCox00eUlzjunwxlndhnmQxIbMg7EtMiq4lENji5WDVZgaWHIaKFRqZjbvmANb/6LnW11Va5+MFJ1XPGi0ki9qHga0u7bG4e/ppOKPmOmhU3VG56xrVirgMXt4vhp3JyE1VbIx4DV+nvJBIDf4oGNUy5a2YOrcafqDaUZP/Eny2+rsFQE2cr2RqoEEYLdi4ql2+ljSkWHLpAaXRCdS2WrUxFF4+YwdBHSvE7tzbvzJOIp8xVmFy1veuJf8bhzHkCeD0myFCMmOHG2pUDRxaEYFWSdjOtv2s6vPeU3uHrfDnqnbSX3Zfh33sV/J7d1hTp+i1s/79V3F5NSr7HXvW5W4hc4hcLRTVOG+w9xx82n8pH3/zvn3/4cRsMhxtpmEw0nHPl+pnSN+C2TJOXw/Dx/+7KXQZa28NpbslxczS7xlobLexALfgodLfOL99/IVHcxAP31VjIoJaxIGBcC5RktA4Q0f8iwfCwmYHmd6I1+iqj6MVpDBbq3KKbWRQzLSySPSs1yr5wbwlzqw9+dBoC+8glSrYmNTYWUOm5KWha+dYx8ldBRR25rnRDdrKpb+BfaBFNUYmcYE1xLJfptdV+1lxbtgigtn3dperJoz3u8LKRlfRM7MpFJImcrJzHy0awL7XQh4cLMmMIeGZDvvgk3l2LXrkVLFzqDlk8TE+RW2hbM7dTkGASR+2VmloQ3Pv1FPOHcB+BKR5qlDb+rtdI2JnzPfDSi0+1y464dPPbJT+BHe25i6vStrBR5EDjX43kM6Kiux9X0hyI/3Y3dllqdMKx18ulrdF6IgG910JUO6yGzGYMb93C38y7ivW99J3c48yyKwYgsxqWdsGBNFKlbMh7e2uddObYWRcH6Dev5v3/1In5wxffpnbIlCMwjDcFL615ppQBVOFY7Gah+W2S1eNTJB1BGqkeCH5Wsnyt5+CM2cLT8Nog5wfNpxaXhwHTYfpMwygVJQxxvUF5IqBOmWgb5cIBUs2u1yMtO9OCGrRCKtk6wyELHlAQNoa3uTdf+uhQmAqdNK5G58lpHwv4K36xCMTGWb3wOi+NSIyRuB280nlIxNy0iSUrj3qBtQD3+Ni2/9eNSq2QsVb3mKzVdU3sM9OP/2kvLoeFmA7tbBNBQ4EoEYyxT0iXbnzO88lpG+w5hzzkD5tYECpsrIw8txle1/te4S0Qxsm9x03wAZH2ZM71U8oan/jVPuuBBlEWJTS3i3XEXebWxLYqCTrcbOqun/gZX7tlO99SNrPgRJk2bjNb4ElUD8q1VEI576XOcP9VJ/81qjJE2cN/y+tfWBjrBkBQlg117eNRDH81bXvsGNqxbx2A4pJOmY57pP69x0HuPc441c3N84Ytf5J//6dV0Nq1n5PL/Ed6IRmWKkYLy8H4e85uncftzVrhucQWbJq03ytcSt3CbxIQrqxg7w9VXK1iDtQZ1Mgkc/RQd1mA1+lUemq+TQvaVRUv7Zm6lLbQA83FrJalTdRs/qVV0yZWH+8TBrTrBoRqTpklt06ItWUb7ezS7wHHIzYydE62lsZ4o23DCj7kmBUyMLjHaO+5XAYvNErJBiuxZprjxWlau24Ppdpi+150Zru+TF8cC78vYSGNogg7aQLQ6IrYjNXlPYrFyRcHUkud1T/lLnnrnh5MPB5huFgubPY5nJQKjvKCbZdy0exePf9pvcMWO6+mfsplBOYI0C19nqxXWpDF660iYcOJYzWFzbAPYikKT44hFq4jZV2m0KpvripFeuYlWebWZSRgdXcAuDviLP/1z/uL5LyQ1hmGek6QJrvbI0uOAfL3ZtoSfuKvS1gVapfmkWcaRhQWe96fPZ6CORMa3SXoCVZcy7lJy82hQG0epfP4dRhP8sGR6Q8Hv/M5FLA6/hJcQM9M2JKiuyaDFdIimJEnB0gp89wcrMLWpDm25Rbu+WzUSDtvdU1ZfFbbCq8r4g9vbvjrvLLxKPgqIRaQViipN+k1lVF+vryPnCR2jF0grCKA9SjXpONLYpNSFUVrHlKmtajRadwaSmza2InVBlBZjt5WmKo1X+jjbO3ArxDcXj1GwqjghJDBLMIELb6rDe8VkXbI0JRsY8uuOUl59mHLvAlos0Tv/VOSCU1kyJS6fRxIbWmjXjLG1Q3LNg2lyGNXbus9JBAr19BZHvP6J/4dnXPxoyrIk6XRjYZAoXG1PXcooz+l3u+zcu4dfe+aT+d6O65g6bSsr+QBstFUxTbx5PYrQCnWQxjq4ebnciW8Yldbh0tywoquv3Bvm/bgvtWggxarGay96vRuxpNbglgYMDx7i4juez9+96CU87Bd/iaIsKFGyLGvJdSrnjFZ4R52GI2M7hRNRGm7p+Fvd+t6Mt/zeOdauW8P//v0/5Ac/uILu1q2t7so3TX/1ercoCuPUhtiRt8bAsccpcbFVwR3GhetNPKmkDI/M87wX34Mzzz3K9fOHSbsJ2griamUlY6oyopa5TsZ3vp3wo+uErJ9RlHlTHGPwivGmxR5fvSBVP6cg8kPTAFvdunWImxgd/aRNsm8NYCd+o066IbwFW6OxNfNxxsgnhDiO6wXUt/CNEz3WCGjXfVltlNd4cwWAs4UdUBUujyWlk/aRJfC75hlcvQ/25ZjBCPqe6fueiz9rAyvlChQOi+BcQz6txc7ocX5O1HYpZXDOEHDe0Dua849P/t884+6PpSgL0iQdB54ZcztGnaeXdbhpz24e99Qn8p0brqK/bQuDMkeTWAzNT5qG0u7kxtqQ1hZ4LG2zjkbnZhp8WjQIjfYM3oWFhjUGSsfw4GHWdLr87h//Kc97zh+wcW4Nw5UBSSeLRos/nxnQM84bExHyfMSmTRt5y9vfwZvf+mZmNm1iuRjdLDFXWsXrlm82RvHQqAJ9E/CGNJlmeOww93ngLL/7Bxeyb/kTuCwBbAwJ01XLgqGHyAKWzXzmspLRygzZlLvNR+zk5j5xwkAAHJXfaJV8U8VYjyE+2hi5jR0OOp42cvN+i62r3jfma6YOBpXx76WrFMbWeKdtFnwL+wobN9OQWNv+Xa3wTGlhJl4Mai3eloEL4sGYlMRndI8I/toDDK47hFsoAiE1T/DrhalLTqfYMs0oXwoJvFVHKqbesOLbbH7TBErUljwafbM9jpTsyIjXPuEFPPuSX2VYDMmSTqRa+ONe0RAF50jShB17d/O4pz+Ry3/8A7qnb2PgRmBNnSlY5yne2nKlE4dNy7+sGpUlvqAqUd7lPE7i8zQyfp34Bqeqx2MJBjZWLAaPGwwoFhaZSrs84Zcfw/P+6Hnc/bwLKIuCYpTT7XYp1fPz/FX5LBoNlJ98lLNh/Xq+9LWv87//z/+ht2aOotrE6sQouNpw3dLd3rL3xYIGDp7KCFSwVtCVEWunBrz8bx9LkX2fxaUj2KwT7K9PMFh6UXxZMjUFN9wwzWcuO0IyswGngyZZ6mdasHIo44tkzSS1oXrGlgrkqguUCbYovrWCrkbBSudGKxI+tKUNeH6yNJE2J6u6WOsTJVrRyBipUmuAW1ogmfHhJvc0Ymnaxne+cZBo/LGqEyw+0/ZYaYTEEOK4EsWkGf28S7oPlr6/g4Vr98LAYNJp0iShyI9hN8+Q3vNsBrMGl69gRGMCUUx0aW1OvXcN1B7dXKvRp0oECmm9YI8OeOXjns+z7/OrsRB1W9ODtIzsQldVeE+apezcv5dfe/ZTuXz7NXTPPoUiLyCxkYhcuVdKw/5m1SiQEwQ+mBYXr8G0bLWN84o1tik+geCHWBP2B9XPNzLWDYvYelw2XihGOfnyAAYjNs2s42GPfjzPetozecA97g3AaDQiTdKwyPa+WvqOBZ3W5oPKqttAnWC6rzYC3lL8ql7yxI3gzNwsP7ruWn7zN5/JYjmiOz1NXuYhPJbxjWClJmhGwMoFV8dGRZETpSaGEN7wDcrgV+Z7ZCoUSzfy8lf+Kudd6PjR/A+RboLxnkRLCnvi51b6FTI28bEPrrB/f4fOlhF5pYKpoIRqKkt8o1md/D4QfLfMybaE1a8RJ0x/bmhX0Uuppjh4vBdq/r2MwXkTI5jWWzlqwsCkk2gUG6iubtE75ol0fKpz0ylprSmcTJ3RVpEcA+VjQIF32rI9DhESWsfmNExqjdbDpQnC4Wk7BbsG+Ct2cvQ7N5KseGa3bWYJhUIolxfon7Mec7etLFPCwCNGUfG4KrpbTV1URMejsdp+9lLFoIkgBSSHhrzqCc/jD+7364xcgU3SE7bPQnCxsIll1+GDPO45z+DyG66mc+oWRvkQsXZCMUA7mObWrp3G/ljdVC6KjhOCnQvWsmZ6lmGeM1xehnwEnQyyDDopSacTVAOq4YIejCAvgnmk6bBlZi3n3f2uPOz+D+RRD304dzzr7HCJFzlGhE5cGoS49p8cJL9teVhCWZZ0ez0OHTnEk5/6ZLbvvInOhvWMyhK1djxF+zZdSTZBkeI6ZNphZe8NPO9/3ZWnPG0LVx35KKZrw10uJSczFccV9HoZN1y7mQ9+8AbM7GYKzTGacVv3seOgexIXhNWWEIIXlsTgMCd1y+VdQ2NoUxqYXHP7cT6ajin7ZYzoJxrkIM3qcHzDMDZOViddxWBXGStk41yrlpWw+rExb+x7jtEoTPDykVCwGjlELCreBc5HlpAkGckRofj2TYz+ezssHWLz3bdwxj3PYc83D7NwzX5IM7K7nI5csIEVdxRTCmqCuNZ6g/VKgWkoIe0N3hjg3wTLCqDOIfNDXvn4P+YPf/HJDPMV0qyHUcWLj66m4++Nc46kk7L70AEe9ztP57+vvZLe1k2MRjkiNuoZY4dXCX/NyUNOb0G9auYaVTJvsKOSwcEDPOIXH8IznvQ0bn/GWSwtL/Hj667lyit/yPU7trPvyGGWRwOc8+Hpl47uXIe1/SnO2LKNs+9wDnc9/yLOu+OdOPP000ltuG7z0QgRIU0stuUYoidFO3+ygiW3kuEfG3ZcUdDvdBnlQ5701CdzxVVXMLV5CyuDYRjHjdTEarmtXRmkOegTa1nZexOPeexZ/PmL7s11i/9BnhwlMQlWS1RKcpFVsV4fl1Y9s4m3vH43R/ZPk2xL8bkNfNLstrXMPjnoPpYRZlu38nGwbSWLbFweWzFVdShCe5Bokf0qUmcVdl2PYazSUU2OlvEmMO0f3+rGvFAnxWibWKlxfFXGQh3CssMhJkpBJNgYexTxJdZluMJjEkdmO5gDBfmV2xn88Cgsl2y4c8p5T7gvc1Nb+cabv8Ohq44i63pkF58KZ69nebSEaBJpEBrJdO2Fgo45Yo4D7RXuoXgbRu/k6Ar/8Pjn8ccPfDJ5kZMm3dZexLQit8J4UBQ5WZJx4Ng8v/57z+JbV3+f/pZNDPMI7k5UNzEm4nWT5JRxM0ZVWXWZEny4FEcMkCXw1/qkzO/aw+8+47d4zctfSWqaR/0Ld793nPSVwXBAXuSURYlXjzGWLE3pdXt00nT8ci0KCh/IlWmWNSNdRThpEXr1BONsLcI/QSf1k2gJ29bSksQAktGIfrfHyBU8+RnP4Kvf+Aa9zZvD+2Cjb1w8aCs/gMqDXyY3hOb49rfCPNUYjIxQNagE+gGiiHcIKUmSMTqwl/vcewtvfvWvcDS/jAU9QJalVJQAIaUKh/OSYGQUAlTSLuWoYO1Uny9+usPHL5snW7uBvCgwkuDSSOg2dpVCR62CtlGW5k7kENppGp+GONqlxbtqaA2Ti0FaLgK0uyhzPCy/2r5QJm6+Or24ZsQ3o6CMvfitz09su6QVi0XbH6saC1vODMQYrdpKeELqYNSCSymtw2ejULzKcNJ4B15Kuqmhuz9jeMURVr5/HZQDttxrC+c+fCO3u/eZ/Pgbe/nPl3+GYvcsyakb6d55K8XmjNFgIeYTmsjCaGgBLq7Px+LI2vHw1WtlFI8hKRU9tMzfPu4P+eMHPpnSlaRJ1qzeq2hBaXR2rgj+TgePHuHxz30mX/vhd+ht3hC2gRVYKeMbZxFZfR7Rk/y55f9edYO1FMt5uiZhfvsunvPM3+G1f/sKvPOMvCOVBOfKgDHFG7KTpPQ7XYyY2iCywpvyPG+0kMZgrF21iOgJBqqTiZlvK+lN+/UnbpOLomC612eU5zzl6U/hM5/7LFMbNzAsctoL0qp7G2O1n+BnrOoKJA6RIupK05C0XruMKFnSY3j0EHe/aB3vfdNzGKaf4mh+E2knozGyCu21iAIFFsVoF2NGeDdgTSfj0IGtvOqVu3FmEyYJoRjeKD8LT57VO6yi+YxdZT9YdVjet4a/9obQc0KqwImW3l4b4l4cwmorC2r8iSbKa+IG8S08S8e2fzrO1+Lkj01RnIEUwfgEXAdPCgbSaSE94PFfOsDRb28Hu8gp95rjvEeex8a7zyLZNF+79Htc/b7DJKwjPceSXXgKeV/Ii5UQcOl82ELaCaasifiZtt5orzVnSqIKwMW20e9f4q8f87v8yYOeSjkaYrJOTdJrc28cIRvROUeapBxcnOc3nvtMvvz9b9Hbtpkch7Q2Kz+tOlDanDqRVmaf4gvPlM1Y2r6bZz7hKbzmb/6eosjppFnQ8KEkktbb5zqjMkZW1dQRgoOlVFY9PyG2tlqeIDqeTiQ3kyB0S8a/6uBOxDAaDlmzZg2HF47ylKc8hS988fPMbNnEoMiDs4Yw1hWLTPC/xnhpN/9ehOVNGmk2cWTykKYzDA8f4s7nTvP+t/022bqvsWNwOaZra1pJu6f2InhjSJ2jNAmJ88xqwlF7On/9sgPcePUc2cZZcpYZlx38jDGsYJCcQ5E0V27b/yoa+JlJJ0zT5mX5ljbPNhSCSncnDaO56nYqVpNUZnR1d0QDoCvj0fUtOU61/tUJZnQdyd7Cvia95MdtY4OJmckFmxeoLJMmM/SLHuWXj7H8xR/AwUOcft+NnP/EC9h812l8NmDl0Iivve469nxhhbQ/hz89JbnLaQxMgdciXHyloiS10Z6M049aljuVIFuCB3u8iNUotgS/b4EXPuZ3eMHDn0WRj0hsOjZ21KdxLOylc1hjODZc4Tf+4Nl84Qffon/qVobFKGRHimD9BPnwZsadcWmN1GN95SoRxl2PlfhcnZIZy9KNO3na45/Mm171GvBKkmQYY8cf+0nGtck1W3tbd7OPs909xZvZ38yG72Qj4c0Vsoqjp9GuZlTkrF23juuuv44nP+OpfPcHVzC1eSODPEdNUyQmO6n2AVR/zkidNdimi4xZHiN4byN1Ifqw+A4dmzA6cIi7nTfF+9/x22Sbv831K1+h20+CJUwbKq9eZw2235gRqV8EqxwwZ/HGD1i+9GnIZreSlwuQeIQQPnGcjY0xtU2uwTZTmePk5PeaOAoJKzR27kzYy1CGmK+IuVeFy1TbypIm+VnlBCQ8v2pbpa0bU1VarqAtnlRVzHx7izfxWrYlMhMFXVqobx0hdRJnYq9KgiCS4HCYNKGXTJH9cIljn/w27DvKmfed485/cWe2XDzFKDlK7pbJb9zAF1/5Iw5+x5H2ZvFnGdK7ncZQDRRxbHGKSHSKFK35RKsh1KptX7AgL1Ebnrk7sMj/feSz+ctH/Da2dIjJUHs827ruTIoCNcLhlSWe9Pu/xRe+9WWy07YxiKB0JVj4aYDoWnrUwhVrhwyvmMLRwbJ0026e+utP5l9e+doQaGZM9J1qazlPPEnIT2lfM1ZsTvg5GbuMVxNB39KOq+LRIcJolLNh43q+9NWv8KxnPYvtu3fQ37QxYFYygdeuymKW+rU1RvDmFjoviI/ReQbrO3QkY2XPdu51yUY+8PbfIVn/ba5f/hpmGsoyxaIow7GMRokLpwRh5Ao2SI/trs+7vwcffesC1m2i7CyCGUbjP3CJxkCWm++A3U/UYVWVrHvL/qE5weOoOVntXvhEVNC6iOhYKz7pjaWVm6nIWGESHcfjT4RTVNQG0UkWTLuuhnHKoXhxzPiEme0Jez90I4Orfsy2O05xzxdcwOn3nSVPFjk4v4sZO8Pwx7N89u+/y8L2BDPdR243R3bBFnI/JMHjjIkBqjFwSXRMS9nciG1GffP6mSquuQS3f56/fNTv8FePfi5lUYR8ORNMAmWVG9u5IHJeGg548h89h89e/lV6p25jWBRhAzXBh/Xyk9IXdCLZu+Vi5Rw9tSzduIMn/Nqv85Z/fF19mBprxoD729L7+6eoascRbX+akdCVJVknY83mDbzlbW/jT/7k+ayoo7NhHcN8iHrFWHOz1AWJ7097W3izEFH0bxIvWJOQqrCyZzuPeOQZvOWfH8No6vPctPRdev0ULUIX5qvJR4JxABGL8uIR71hv1/HNpYzLbtzIl992jPwGQ9pPKVgOAJJ2cMZF+lMGtzGxIVmNNNpcsVGdXY5fTa0JMJ4iJmw2Wgb1tX+RMS1BcLy5XCudhvGY97azo1Qbm1YsU7swtbEpjRYs9VjCRHCAtkS4MZhUFIwvA51CDN45xAipTRlcP2Dx9Z9hfc/zoP97N8562DRFZ8ji4j4Kk7N+ZhN7v+H51EuuoDgyjZkzJLdfQ3LuBgY6DJ5W0ujbIo01enhFvVrLPC8coC33cQ3jrBGwpZAfOspfPjIUK81zkjQN2YFozEeMxPyoc/RaYq1lOS94yv96Lp/5+pfonRK2UFJZ5cQK7uP2qVpgnAhPbyyvmy1hJYGtHrs4jwn0PKR09LCsbN/JrzzyMbz9df8SXCoBY22ra2kC7lsSxZvtlm7R56WyAGpbZzPmd9be1XAz498t6bCqztU7x+zMDKOy4Pkv+FNe89rXkM3OkKQZeZGHDsaaOhlHjGkBiTJmrtomATX3wcRySkydQigKRsKhYU0H6zyDgzv5rWdezD+8/CEcNZ9l7+hasukESkMiCU4cRVJiSkjVUFLikbAp1xH9dA2fP2D5wL6MH3/Oc/i/hmT9tYzMMG6+K1WCrop+n+iXbf1p1U3hcVvCmzslkgjEewc2GWvktBWkKqb28Wu8xlsvtrbGNxnrshpvJt/iUNVA69i2sClAMmYpQ+OTVcfWj7NDtf1vyKMVS4KIQ30e0n1zoVge0tkw5Jd+/Xzu87jNpBuPsG9+H+VSj1Qsc9NbuO5LI/7zZVdSLszCdEF21gbSc05j0Y/CShqJftVNEZIxcoCekKtUqwKsIsaSHzrMCx72dF7ymN/DFSWSBPO98BY3rNuKAV2McmxqWRoOedoL/hef/NoX6Z22lYHLg6eRTHhgTHBsdDWHBECjiF0meClt73RRgdJhFDq2y8r12/mVR/wKl/7LW+l3u7iyxKbpONl3tS3MbdEsUYHmx+OVitQe8U0SzImlhScF3ydoEpWf1sYN67niqh/yv/74eXzpc5+lu3kjPjqfBuqCtArTuEd9bWTBuLPIqkYW8VoQbSJTNZJzO92UfGEFPzjEy170CP7keRewY/AJjrrddHq9QOa2EuyOSLBewYzwUqKmiwxLOskI35nhI9fDRxemGfxoI4cv/RZqt1KkZQhqkUhdENe60t1t3gAnY+NgcoL5smwj78HL3ZvxcUqkjWHJOOWBcaCTirkVwdhAcKRlkNfirtTRXDoWfVXLcGqgd7wzG1P1+6Z6So2XZWEjaEu8t3RNj3x+iC+XuO/jNvOo511I9445B5d3cOSIQ+hjkpx1/S1857IjfOINP0bMFrQ/oHP2NuR2m1kqBpAFmmISOV7uViJDosGeOLwmhnLvIf7kIU/n737tj8nzEUmSBtynLQ+Jxcog+NJhrWHoPc94/u/zH1/+DP3Tt1K4IlrPRP7XT4IHTQLUyvimLXLpEhE6JmX5xu38ysMfzbve+q90TIiKszb5HxUcnygjsDpotS0iP4Ec5xbjVUBeFPT7PTq9Lv/yljfzor/+aw4ePkhv21byMq8B89v0OdZb1TAthBU0pGmP0aFjbOwPef2/PJlHPGaWq5c+xMgeJk2zplDHsqgoiQ/bwNIYbFHQywxHdDPvvGLIF/PNbF7Yxg9e9yV0tBnpCo7R/+gwf/IOq6jAhfJ4hMxHDpo0RSuMPIKxUgOpFbO83oqNWcW0bVtCmkkFinulZT1SS9pbLgU0a7U69KHl9Ol1zGK5siVuNosGTI6xJWnRZXBogTPuCM/884u548O77Bpex+6jntzM4ROD+EXWTG/max/Yw3+9eQcm3YaaJTq324CctpkBI8gs1sRtmejNCj/Fj3Om6pciNRiFYs8h/ujBT+VlT/hj/KggSYIHu68OiEm4wjnEGIZlyTP+9Pf5yBc/RXZKcF0Q9VgJY5ia8YSdW3RTVtiibx0qkcSqLdsb4zz9tMvC9dt5xEMfxaVvfAtTaUbpHIm11Vt1wuXHbXwn19rF4yxgqueCnnAbeDLKRE15IDhD5HmOsZZNmzbyg6uv4kUvehEf+8hHSOam6a5byyhuZOvidksOjHZwyUnwYMGhxsVrLkPUkhlltHcfd71gC2963XM558LdXLX0XrTjSOi3zCfbgDO4RHDO0hkV9PuGHy5M85YrS65NzuBUOY3LX/FF/J41MGPxMkR8f0LS8vMoWNWqsNYQmRaO5QL6Z6T5c4VveBcFpS2ioLa61pZFcEVFqF0eaKsFtPazGvdHb6xv67dex03ipL221nHujlb+7ggiCySmS34kA3uIpz/vDB73R6cyXLOba47sIPcdrJ3FkCM4pvvr+OI7dvDld+wn6ZyGY4ns9E2Yszey4hcwpKHTjM/Vx9CNE5/4EzdWtYCwhkRhdHCRP/qlp/DK33g+jHJckobgk1WKiyiUZaBOFMBv/9nz+PfPfZJs20bKIr6HEnSblcmD3FpDumrcQ2s2eCNED64Z3is9m7Jwww4e+aCH8c43vY25fp/ClWRJMkEhGB+3TkRPaBfmn5RzdVzXVG9tJArM/Ym3iSco5tXjKosCbwxr161lcWmRf3j1P/Kqf3glhw7up7dhA060ThgaM45crWBVfDyRWvXRFjC3bY/bBU+oMElLYrvYYc7oyC6e+Pi78ppXPBrW/pArF78EfTDaJS0Vb4I/XPuxVD5zKSN8f4qP7+jy/h8bhmtP53Qzxw/+5gusXGPozU6zpItAn0B59ghJM97egl9tpvut2Rcen0t4HLWhYh/CWLa0O3FbjLbCPn0LWJ3Ijoshgy3v8ya1ubG2rX5eE2Ch7Q6t9mkfj6pvtom+lvNUNAFrLabIyPce47y7zfG8l92fOzxgheuP/JgDBwTTm0KcR3WJzKT0/Nl84h9/zH//+xE6U6czkmWys9aSnrGNFb8SfM59FNtI3AwaxkMvVikyq7B2sF4ZHTrCHz7wN3jFE/8UcofYBDG6ihtn1Y2G16M08OwX/jHv/8xH6Z66maIosGJxlUfXCX/2LR9X62aXcT98dUrXWJZv2MkjH/xw3vvWdzDV6eK8J03SxulVj//5k/HpPzW7vNUt+eNGu7ZZJGP+7W3nBm5GguNccNGYm53D4fnoZR/j71/5D1z+zW+SrJmlu3kjeVlGbHfcpvu241NWqyWDqJBJyujIEXqdAX/zN4/huc85n/3FZRxZ2knaN6jLQkdshpGfKDXYHXqJgikLR3WGd33f8IndU3RO28ZZfiPf+esvcvC7nnR2HStuAZN0UJ+gpvjJL6jbfCScQPLdRIk0J1ytahRKt1beLZqDjJ16VdfQhIKqjIO6Yx612i6CWluu1MZv8QGZiJipxrDJCFokNqU4toDPB/zmH9yJ57zwbBanr+OqfUcZ2h5JDygdhXMkNiPRbXzsNdfwnfcdpbNuMyNdpHvGRuR2G1iSowG0dxneFOGnRl7RzVquSUseFPE8aw3FoaM85wGP4xVPfD7p0OHSBG+VzLm43DITbAyPx1MYeO4Ln897P/7v9M7YSpHnWCylbaQdaIhoNz/tDSPtDW04dDKbsLJzDw/9xYfyzje9leleH5eXJJ2k5rid7IfekpDRnwSzmuDI1F2erobJ0awLvdeW43NY8XtVnAug8tzcLEli+fKXv8xrXvNqPvbJT5B0O8xs3sTQFRSuPN5t5JYCYSfkVK2WPqMYYzFOGe3exSV3PoVX/t2zuMd9l/jx4rsZpCOyLkhRBn6UGHKTYDQI41XAaU6KJe3M8oP5lEuvWOFbw1nWn30G24qMy//u88x/05OtW0uuy4hNES1RUyCuF4393f90wRoChnwssiKBUrHWQFnUjguBOOpjek6Qkvt67d1acfvxc6C2RUFrPolUSbwq0dg+WKpUguWYFT7uZ15ZMFeRV8SceJ+EhARbRC1TB/Eh+8+IQ3xCvv8ot7tDnxe//P7c5ZcLrjn63xxeKDCdOaz6yEUqSa2jy1Y+9A/X8p0PL5Bt3ELuFklOXUd6x00sMYwcKYNPBYkM9rqD0TpH+jiiWggbcHGEDFu71EG+5xDP/oVf459/48+QUvGZJTGmZuxXJ7OTYMnsncepQ5OE577o/3Dpf32c7pmn4ooSQxILlbbwIqmZCTq2pZMxiVP7fBAx9RjqIxhZCc2ldCHmXSyDPbt46C88iA+841Kmez3yIidLEtSF4cYIq/jIy6rkzNWwIqBeNqzmP+WlZSMkjXeW+rAF1LG08RhO29qoNalEMbRWfZCjVAWsLElsxuzadeT5iC9/42u86c1v4ROXXcZwtEy6fg2qyoovxl1xW41ME2jaeh3aiIdtrnET7ynvg5Vs1XmKBFO/yp3EpAYWPG7xEL/7rHvxl395P7J1V3PFsf/G9iypdDE6Qo1SBO47mVfKyINRKegmJaIb+NB1GR+80TGfref0O2xi5mDC917xdY58a4XO2k3kPrp5VOO0mBCrZaS5pibG1kDVaPabxnNcYomcdCjM4z+wrYI1uC3wzTh3eZ24MP1qoEXkTbU93eMoICa6UVID6hrnEG1Ft485hvoM8QZhiDdlKJjegOYYGWGzHsWyovOHeNKTzuHP/upi/KZr+eG+a3C9hCzrU5aOFKX0StaB/mArb3/5Tr738SXStevJ8yH2jI10zz2FJR0iNpjvi5rxk28VJ4DVO9ZqTHNYScj3HeHZ930M//SMF2JcLFDtxl8EL9owXMqYQ5IY/uDFL+TSy/6N3tYNjDRgCsTOSvytfiPH62sLc6vi2gL7XiEv6WJZ2bWLX7r/A3nf2y5lOuuiXsnSNF4OPnaT46W7CuFcrUit1mWdVDYz0THVvldaNYCNLrBi5Es9Ega8NPavwZUjEYy3FKMR3nuSXofu1AxL84t84oMf4J3vfhdf+epXyAcDumvWkE13g0uEnvSlvGUvvzTw2vjdbFBNEDMAcozvkdBhsPcQZ5xi+Pt/fhIP/9U17B/9J/MLe8j6vXhfDSglDTZDWqLicMbg1SFmielkjh8vbOLNVy/wncPK1Ib1nLlpLb3d03zzFZ9j6YcF6dwmRn6IiG1tz8xP8Sz/B0bCmwPQpPa7iq+xaeFGE7hJ5aeuk52Tb3Q4Wq0WW5a6Y15X2gb183jxx5s4WhsLBSbrkh8ZsK6b89eveQiPe/p6rlr6PPsXDmGnplGfIM5gTY7zJR2Bvp7Om166j+99YoXOxs2M8iHJpmmyO53CcurQRGrwXmP7oq1TRf3xjhOr3JUh4lsM5b6jPOsBj+U1z/wL+iMojCe1yfGJ1sTtmlO8d2ia8PsvfiFv+egH6J2yiZF38USXCcLhT4GQaBXMUFlgR5sR5+hJwsqNO/mF+96P9136HuamZ3FFgUkteVHU2LAxwT+ksfC9dR5Sk11VtSVddfunyokIbup93XkFup5vFgcSoqh8WaKuBBHSNGE4HHHVD37Ipz79KS77xCe58qqrQSCbmaI71aN0Dry7zWGcSa2p4BFZCdBBZ45iYUQxfxNP/NWL+OuXPoiNZ+ziumOfxXVXML0pnC9x4vFJh47LMRqw1RKDasGMhUXdwAdugPdcu8TuZCObN3U4a8Na/PaUr//N5xjekJD11lOUQzCW/z/8Sk68Iiwj/8reArTfNx1SCweoW0EfWdUR89CYBnNcKg6T/lfV+n+CnNgK1zRx3PRqwXeAIaI5VlISLwx3HuQed9/E617zRE47fy+XH/0kR63BdjdAWWJ8ijUlXpYwYpmVM/jXv9jJN94/YPp2W1hxR5DZ9WR3PpVRL2/F3UvM5pPjUnZDDP3x6/SxjZeFxKQUuw7yjHs+ktc+7c/oOkNpDYkZ31LVW7SiDKON89Dt8Icv+wve8h/vo7NtE8PKWlgDyFsZ/LUf2wntVLyOOwS004NaUWnhxQ5f2M06rOzezQPu9wt86L0fYHZ6mnw0xIpgTYbNmuumHOUUrsTYJMTAV8lCN4NnrbblmyRx1p5Qq42J6oNgt97b+IYtTvBS92VZHwDeeySxjETZfmAP3/z+d/jsf36Kb33qcxw9fBhmpumsn8N7h/MaipVIjDrnpNvEyltMJ0bddnhJvRQxE7bI8b6xWQIupdh7lNPPyPiLV/wqT/71rex3X+FHx26k2+uiOhPi30yOoSApC0qToUkCLifB002nuGq+y7uuHPGVI1MkU9Oc3fds2DrH0vdzvveyLzLaP0WnM8eIAWrBOIMaP5aYVFs1t8m1x0FyJl435mdQsEY0Pn0/dcs1frrr2Jap8bcau3DbARJVZ+YnimDLGNCMo8BAgeiIlAy/5BkePsBzn313XvS392ex/02+deTHFN0OUxpIjF4EKyXeLGM9zJg7cOnf7uPT/+8onW1rGGmB700zc9czGawDV4yCX5ZXEBsDEuKKX09wsZ7ADSAzltG+IzzhHo/gn571l0yVllw0QHAnYlsbE7ZTnZTnvfzF/MuH30ln2wZyra0PY8FsxOS3IkdlIs+asQi2sGF1iAr9rMvy9t088D7354Nvfyfr5uYYDUfgPLbX4wtf/Qpf+PpX2LJ5C5fc5a7c4Q53YLbfby4P53BlOVaM27FhJ/NLv7nObLIoV7w1H51pnQs/dxS3fJVn/bHRgBt27+B7V17BV35wOd+5/hp2HzkACOmpa0i6wea6cGWLcBkPUHMrOtZbcRuF80GwBCnTaCknKY/w7KdexAtf8EA2nLaTG5cuYzlZwEx3KcvQMRoTrm0hiQsET8aAKZuyx23i3deUfOwmz7yeysx0n/7cUdZvWsfip5b47iu/gynmSHt9hjpEkwLUYtTfPNOq/QTrP98W/q7tgrUC9G6bbzZpiSyrkCRPtNaViRtHJQB0bT8l2p5YNF5ZQY1uMTqiY1MG+wumzDL//LpH8aTf3MY1S5/iwNJBpD9N5h2GgoEpI+rmcM4z1zuL9/7NYS579UGyNdOUwwJfGrp3O4ViG5SuRLIM4zzqTeBZhT1LFKa2pRXSuIcyWbCEJLWMDhzm1+7yi7z+N/8vUy5laCAVIalSmatOwHuIYLPznizLeP7LX8LrP/CvdLduCMkqTgMYGg+yOpHlJ6EtVTe88633VOvOst/psrRjD/e92z1539svZe30HGVRourp9Lp8+qtf5Am/9TSWyhymuqxZO8c5Z92Oe150d+5357tylztdwOmbttBJs+MKjSvLgCG1xT+TgQ80Fizta2WMyhCpCt55ytLXYRcScVDvPUeHK+zet58fX/sjrrj2Gq668Vqu3nkDRxbmQRSzbpZs6zq8VzKT4Ke7DK/ZHaCGNAm605/R2FNZ9QiQJYZi5BgdOcxdL1zHX7z4CTzoIR2O5J/nhsWDkAmpTKNliYofE1WVCKoFa6ySmzV8dn+X9/8o58rlPnZuLT1dYWa2ZG1vKzveuZ0b33QdGZtxmVBI4I7ZshNwLzsE6UxEsk1eO6YO9xBj2q4EP2MMq2hKvF2l6kMkv1fgvffHr1yrVBxarITIcPbtk1xjxHW8qIiWxnWHhcQRxwXHAykDblQmGC94KRFKjAo9M8PSngOcc6rw6jc+lnveR/nBsY+zkA6wnRkogme8GkuiFvElpZ9n0/RpfOh1K3zgH28im91AqUN8OSK9/Rr0tGlGbkAiSbD5qoTCdRpzNEpbxVo14EkWcYp14UZKrWG0/yC/ftFDef1v/iVz0q1xHhOfv4/+VIpSquJ9yB1M0pQXvOpv+acPXhrM97wDsZUSo82YaHC1aqSr8cAq+qPlESaM6THr7iywgKOFkWPKpCzeuIt7XXx33v/Wf2XzmnUUhQvme67AWsuHP3kZS37EzFmnk3vHYifhW9uv51tXXckbPvxeNs2t4dwzz+ac087kTmffgTueeTZnbTuNTWvXsnZm9ubbwLYTawXax7Gv8AXeCd5BWTjysmBQ5qwUQw4eO8ruwwfZvnMHP7ruWq7ds4Prdu7g8PyRsBia6ZOtmaK78VQEIS+LwKOyUJYjsk2zpIlQ/PAGZFQiWVLF7oDaxvtKZCxmTkXbirJxUptowIZECLEocUuiI0ySYnyHwYEjrF3v+L0/vye/+9vnk67bx43LX0WTAUmvi/MmThsGTwgzcSJ4N6BnHN20xzXzU7zrWuErhyzSnWF6tkPOMdZtXsPMcI7rXnM1e/99P9n0ZkYGxMfut0oUj6JqaXw6x9OnTavZGGvrTyBpMD9507VqwUppy/bKwEhUMOoao3QXLhrjtYKwYhelY/9afc0gDduvFr5Vk0kn/NYDYD7uvx4/Ejx2Ki6ROlSVxGRkeJb2bucRD70dr3rlw+mdcg1XHPs+kgh906UsHaUpavlQRkrullk3ewqfep/lbX+znWR6I2Uywi960k1d+nfaxDEt6lek6pnGjOMmuisYD3utgnU9ik0Moz1HePgF9+b1z34xa7RL4TxZLFaBkRW2e6bVeRTO0e90+YvXvJJXvudtdLdtYKguhhPImK7TtCLL6jW65zgxOi0Sr1GJ0qp28HVMuHaKjEpSY1ncs5t73/2efPgd72Lrho0UhQNjcOrqx1uoIv0uQ6+BmuMh7fVJpqZRVfbnK+y94jt8/ltfA69kacamtevZtHYdp287ldO2bGHj2nVs2bSZDRs2MN2fIktSOmnGTKcXAlLjmFd4j/MlSysjji0vsbiyzOLSIkeOznPg0EEOzx9h//IRDswf4cDiMY6uLDEYrIArIMuQXofklPU1vOJN3MRaAzbDShLfQ6XQEnvmWjpz5zP6xpXYlRzSJKzhXSSHtrIBq/vUnUBILhLtVzQLnZG4ELwrkEiP0XyBLQ7w2Mecyf/+P3fn3AtG7Mm/xGBlBelYPDM49VgpseopxJInFimXSbVgqrOWg4M+793uuey6kn1mim6/Q2qFgmW2bd1Cb0eX7//TN1n43ohkdhO5GcTpJUSAqcSlkgi1c4s011XbvpkmTGqsXo2Z9MV9GKYVF3hzv3LGkrwS+Jn1tceNhn7Mbz1kk9WOoe1nqhr9u1te7ZFFjjOY0qAyQqXASIqMDCsH9/OHv3tP/vrF9+OQ/wY3Lf4I0wd1Bpt3cbbAJzlWBTSldMfYvHY93/zcGl7zwqtIOpvAjhDNwHg662awsz1YOoJNs2hfK3VLPD6Z62qpZOH9EsUlHpskFLsP8eg7/wJvffZLmCMjV09iold5vS0FG4uQYHBFTr/b469f80r+7h1voLdtA3lcx/6E2abN26OT27WYNKRxvY+ihaOrhsENO7nnJffiQ+96L5vWrqPIg760zPNGdlWNZ1kCHQujwAj3LuAfYgyJsWivh/Q6GCs4VXb7ZXYfXuY7+26I/LrAPTIYjAhJYknTjG6ni7UWMRasCdiUKxiVjlHhcM5R4hsukBHoKPR6ZNMd/MwMiU4HHmFexK1htbSpOBDht5jotmEsYgVrOvjE4m83x2y/z+LHv4EZhuI8Jrm5pfiUz4KlkS3BFIhAJl2KZc9o/hCX3H0Nf/qCh/HgR09zzF3N9Yv7oW9JE4OWBSIa8izVMTRdSpRuuUwvTTnqtvCZ7ZaP/nCe68pZ/HSHvslRV1B2pjl1w0ZGX5jnm2/6Abpvlk53IyOzEo5Lb28Z3+XnviUcUtuQnhxQlwAG2MAElTD3VWBNBd80s9IYoD6RACM0KucWtjVuI0PrRgrzqpdwCqR2Br+4glncxSv/7lf4/edcwA3HPsV8shc71cGX4MThEqUwBYlakhIGfoXZmQ43/HCWv/nja8jdGmxaUPoSMX1IBD+VUkwnMDIYUYoJb+0x4ybfhF7IBBahVrFpQnlwnkddcF/e9KyXsIEpcleGjVmV5NzGZ0oQKxRlQbfb46/e+Gpe8o5/prt1E6O4dZWYquPbbpUtE8SbA6ab/MbKEaPlLWakdrjopRkr22/i3ne/Fx9+3/vZun4Dy8uD6PrgI5zYlO/Se0gSSCyucHX6T0W1KLyv7bBDoooBm2A6KSJ9TPw6rxXe5Bgh5CIsJqELwZSRtKjBgqdjEdNBjJAkJkqZImnRaOx8NG5OBace7Sa19bQ1LeJsNU/byjYr+ujHy7BYXMJummLq0fdg6dPfxrgSTVPqdDrna0PGkx0mzuRxuyJ0zBQ69IyOznPqaQl/+ML78sRnnkF/bje7l35IbkvoE2ysXTjQ1PhABJWUzC8yZ1OGZgtf3p9w2Y0F3zg4wCfrmZ0WhBErZcLUuj7bZB273r6D7e+5HrFrYGoa7wYY71FNa+XFrXfzkOPhdalf0PEa4aMxXIjh0dDGJ/oTj4QFsTUoq2rhFFU1anRyHeari93K+HrQR69Q1eCjUA3zLd2v+EaSU4udK50g7Y1g+LN1KYhS4kjpURxZZK2s8Po3P4NHP2aKa+YvY5QuQLePOo9VRbwlt0oqBTa3OAqmZ7oc3L6ZP3/O1Rw5sIZs2pOPPDCDEixrtWPwPYtkgDMxj1HGC1a9vauJ+ogLz87GkzuxltHBBR5yxt35l2f8FRtdl1w8kmRVZGy0exnfOgxHQ6Z6ff72za/nZW9/A+lpGyk8tfe6j+qnMUC/tUU9Pk5tXAAscXmhLRO+iqyrZYmI0E0yVnbt5j73ujcffs8H2bhmLQtLy5HL5ALzvGKGR1pFuTKA0mMRyppGEMeL6BShrYKvIsHquywBwRkZ30aZxjfKSNJ0ufVavZp443NxLnZoBjGG1IRu1dvm1UbiG1SJwiPuJBKMKDUJInST2gCwE6AH4xUdlQxWlumeMcvc4+/Dwr9/CasJmiZo4TCRh6em6pJXIcGiiBUSk2LKLsO9A+bmBjz7D8/m2b9/LqeflnN49B2ODpexWYdMEtQPEO/JbZBboQWJz5kiJU3Xc8V8h/ff4PjaoYIi7dGb7SDqwuYwSVizdY65/R2uee33Ofj1RdKpbWjicW4U78Ekmh1IoDVXRbeNi0Zuiwi1fTIiqiIqiLZ8KrXmkt/SuhfMFWLxskqJkhZasxfSQHBvCla3Cy6HInZP4aLS2wTlj/IMr6pSZcSrhnR5tOZSVduoRnuorcodnAa8M6Q2oTh4mDM2CO98y29z8SUFVy9+DtcZQZJinCCV2b0B64WeTxiZDod6CQd2zPDq37mWHVcmdNZYinwUE5eL4IipIcRSEkHToN+TGKc+xmlq0wjqeysWDR/GwNGBw/ziqXfhLc94CZuSNTjnSZIk5LqtcgqrwCgfMdXr87K3voEXvekf6W1aWzv9tHNp25imPxmnqWV6SMtDrM0MlzohOziW9rKMlR17uPdd78GH3v5uNq1Zy8pwGIoTIUq+EnyDUpRl+DFHlmDnIbobNjMS01iptApMFcxaYYHa4sBUjPhGzlKN4TFkVloLDh3HU6qf0U6bcYZIP5Exo0IhOBaY6i6LDhsVPhHAcxfIpUYgkZDS3bVkMzMU6ki3bWHjhoez/x2fIxnEYud9o79aZd+vaBDf+2nyQ/Nk2TyPfdw2fu/5l3Dni4UFrmVPPiBJKjwyD+nfmuGsw0uJ9Sv08STpZq5dsHzkOsdXDgw5YnvITI+UEcYbcm/JpiybZ9ex+NU9fPcN11Pu7JOumaKQEeKDb5tigwxJ/NhQVNvbSIs6JG0+x/+A6tmIti/uULCGAyAJ7+BPQWhd1ZxAGy5PtTVpdMwa/iqtGwlBvEEpIq5TFR+DlxHdrMdwzxEuuH3GpW9+Bmecu5cfLX4PuhlWDL70CJ7SeJx4jM9JbcLQruGapUWuO+r42Et3ce1XM5K1GUUe4oJURiAl6qfRMmga1XgkSetTXVspP2P+8zGEoQq1FA9JljA6cIQHnHVX3vQ7L2OLnaUsXfh+PuJ39RgcjPW8eoqyCJ3V29/AX77hlaRb1jISreU63jAW1nHSS0abznxVMma1DfTBXto7j7iSfpqxvGMvl1x4Fz74tneydcMGVpYHQZIjpu4ihIbrZKqyUjg4sMBoz0E6G+cY2YYgKVFehATSZj02t+Mh483RSFQM3ozztIii9grQFaHp3IwJJ4cxqA03YW3EJhIO8Tj2mmpUNbHQWQPiAyZXF9TG8aM0jhSDSwXtpCzmC5iLt7H1WQ9j3//7TxgKNstwEnBA620cR3OwBiMZBkO+uAyDw9z3/hv5wz+9hF94aMJQd7NnMCSxXTKTRP+2FAVKm+MYYMqC6cSSJmvYvpLx0asLPrWj4KDL6E/16VlF/QiH4kzJhjV95sopbnrLjex6326Mn0bWWUqXYLzDG6U0ivVlSMfWNMrg/CT1s5aG1WNdpVb5n/DuMxGGMqIJ1iiYsSpGXoCkYApsq4JpRPu98UrpBVAjcUZ1vhVVrMF7slr7+jbFQWKwY2hqotpWtbr7o6DaGR+8mUsfhlSTMWX6LO/Zz30u3sxb3/xk1p56HduHV5P0u4GxrKbWhYlIOD1MypFC+crh3RxKMq7+oOVHH1E6s31KBvHGLUAMQhraYudQK2gatiNhnNA6GagaqQwg6vEablfxgcGe2Yzh3kPc+4yLeO9vvoI12QwDNyIzCaLBJxtpAl1N9Jly3jHV7fPyd7yR//v/XoXZtpYyCr3dhMVCBZpX0ZDSStOsCpRRxhKvTbQLDqqnOoueVAy+yFHn6Ihh+fqd3PXCi/nw297FKRs3kedlKAi+IWIyxhEMqcLhW4fPFXsPYhPBnLK+9pmvnjOGOnG77ooqwL4e/+IwVaUdS6MsaI0j4YCglYJciXLjAVMV0vB0Hd4G+o2Y+BkTuwYTxjSxSYw60+C/GB9LQC4MmlQuJAKJcmzPHrhoK6f+wS+z59Ufg1GJ9LIg+QJMkmOyDOiQL65AscRd77aG3/rt83jYr67HdA9wYLSE2hTTybCaIx5Kk6IGjBaIc3SlS6c7y4HlhI9ducxHdq1wk+sx3ekx3ff4ogSX4LUg7SVsWn8K+ZUr/OCN32X+ihGdzibyZIC6ktRllEZrcwFXLW9MC5IxDX7sw+FQFY34OpvxTUPt4NEWP1d5dRLNtwSjlU2JqZwPJtQ0yUkB/lu1JRQRVSk1HPPiJ8dFadmVSwWPSIvvOkZhYExu08w7sVj5LuKiOZhkpEnK8vZ9PPiBZ/LmtzyRbOYaDi3uotObxrsyjFK2RHxJpxREMhal4IqlFb63J0enCha+P8c3/vkQkvVwsgxqJxiu8Ui1BkkESdOQ26dSC3hFzVhCs68Sb6LS2GYpw0ML3PeUi/jXZ7+Uud4Uo3JEJrYRdFeb0HihJAqucPR6Xf7pnW/hz9/4j3Q3rSWPqdhGT7x/miThrqbdrD/eGglpOUqUZYk4Tz/tsHzTTu56p4v48Lvey2lbtjAcFAEl9XqSvEKPizY/FSwpcRzuzvTx66bJfRH4aD4wYtqDUj0aT3J4YgGru6uxPzfFLqS7SG1wV42cIhJrV3SpaE03dV0zJhym1mCsiY8jBkJIZDzHYimtlX7A70LXdmzXTtLzTmXb836F3a/+KNlSQjFtIXNYEkbzCn6eO9+9z7OedU8e9aubsf09HB1ehS4LWTYVMEGvOMkoEyXxIxI3ILEdkmwjNy3Bx27M+cL1h7hxkKLdNaydSiJPLnC5cgpmZnqs82vZ/87t3PTBG2Bhhm5vE+oLVEswNmzb0Ylhddw+QbUyVRSV9msdcUc9mQVqw+qb3NhVmiylTU/z4jHyk4PukRmqlOASUdvgsjfLYjjuYQdOVYR8mtmkMeHzkSiqjS2DzyJwOkA1oSOzDG7cziMefHve9pbfIu9ezkK5C9vrkDMAG0BRqyWpWOh0uGk45IdHjrE9HzGYTZg6fCZf+JudcHiaZMbiIzlu1edhBEkskoT1eWWpXNt6qNZYTpV6XaojSS3l/qPce8sFvPXZf8OZyRpW8hGZTRqBd7VnqMinCmVR0uv3ec173s4LXv23JKeup4ydUjvKTCbGPdHjpU9Mymtaf9ba7DD4YmlrA9tLOyzt3M3dL7wLH770fZy+bRtLSyvRsExWhTLHBMnOtTyoBJsklOoYbd9HJz2VdE2fwgXjuMRHvpO0MMC2RKsafWsrlkAerm6WKg1bpfmYiQVGRRAb+GyY8cJWFUUxEnIeran/jo1bRdH6+1QbxlriYwQTf7bzPsSUiZBKh0N7b2Lt+Vs57fcfxq43fhYZjSiXPW60wgX3mOY5v3cxD3/UNmZmF5jPf8zCqMQmU9jKNkgcI5vg1WPLFXomJUk3ceMg45M7Bnx6zzGuzzOSZD3d2RSjA9QvhfQlZzFTwtz0WvSHBT/41+8y+N4KWXc9ZVcZyWI4FdViXXLLEtmlXiipxmDCRhfZih+qWAJVjZDVCD63kATlROtO7gTFJmFlGfotPoMxWnv7iihliUvsOPuLilnrwiJA4jjoa1Ol+qZu85aqRGCJoFXVqIyd+iiUw3hHCT2mWNmxi0c95Fze9KYnknd+wGK5D9tLKTyIdMErHTcAmzGvJdfMH+HqxSWWbRfX92xJp7jsxQc5+ENDstbinG+6pklr3uoIthYSE05g58Mb6CWcThWwWx3ZzpOYhOLwMe694Vze86yXsi1dy1JR0knSAGS31H4VH82aEC3W7fd57fv+lT997d/B1nXBBDCGbxhTeTu1nVmprXmcBlypDteIdd+3YtJql9Dj0nkC56lrEpZ27+Pu592Zf3v3+zht81aWVoZh/R//nWdc4zi5dSy9o1Qfi1DDKaP0jK7dRf8Op+OnE5xzJGW4pktp2f5KYwdcYYH1iV6pCypfqNa/qdulCsOyJnwdcVyuC1/Fkm19f6OR/hC+h4sbjLD1jULfWDCrkdGLRP5TeN9FBZWETLsc3b8H7nM7ZvU+HH3Tf3G3c7bw5N++M4/5ja3Mzuzn2OgqDgwyJJmmR0khK4yyMlpHFKjLmUpSOmYd1670+NT183xp31Guchl+ZgtzWY7mRXhvfUpZKsYo0+tmmS2m2H/pdez9t90kC3Okc5sYmpUAcRgQb7E+QURwtow+ba209Brma43gWhPe69uCRkwfClmlnWhhj+Oj0/GZtcdVIdv6aFmGvE2RsCmsmrnhZIdVGCXLdSxJtXLicxFm9mgTdiYBLNJqtSeq6jQA0KJ4H3BTDb8EVF1lRasVg9iLih3jOqgGWxi12jEzrGzfow9/6Nny1rc+hVH6YxbLAyQdi9cSg+DKJGip0oSbVo7xvcN72e1zbG8WW3jWT6/j6vcVXPPRYyTr5ii1BGMCa381xLDCpkQw1jbx4bXdR0VKNPWxkqUp5YFj3GPtObztN1/KqckaRsMc20nxWtZcJDPBWvHO0e12ed2H38PzX/O3yIYZSA1a+rrMe3TsIpBWd1VJauputXK1CASmIICNISBtLKveCjpPJoaVXXu5JBarUzdtYnFpQOnLliZsIpX7BJtj396F1fMhyHLOytU30j3/bMqOwRuPVt2MGR/xqq7IxP96ms/XG0cTX8EWzuWrTikWtZr9HwF5EcDaUKREAhpgQi5gKIhaXw5adWGt0VArVre0xOUaMjZ94hBvSJZSFq65kkc+cCOP/pXH8cA7ZMzNHWUxv5bDgwIx09gEyuQY6tP4fTypd/RIMLbPNQsZH9++whd2HuA618P0ZpntK1l5FK8J3iQIBnEl070OvZk+5fdW+NGlV7FylSfNtuLW5Dg9hpQJQidEwkWRn7cOb8Pjra+hSo7R7DMC+mki6lyRcJtQUF2dqxGvTGkVGt+S19ZHpq0sXUNH5VAs6k5kCS89xZSKdwTQPTHKaIIOb2NrFn/wcRbJk2TSCmRX18ypPsYc+xo/ie0XKtV+sE4FqAq9QZkiNbCyfRcP/oWzuPTNz6JIr2HZHSVNU7x34cQA0kQ5VhZceXSeHy8dYskkAV/Ic9LUs3DtFJ9//X6SdC0qRcT5smCGthoZQAP5j5anfFOw4k0UrUJEwCQp+bF5Lt5wJu944l9zh/5GFvKSLEvp5iWFiS6mLd6Uxs3cVL/PGz/wLp7/6pehm2eDb1TpcaYO3G3OKB0f+bQ99tWcqglcIqZZMxl7Fi2AO9Yy3H2Ai8+9kA+/8z2cumkzyyvLzbgZrFHr7szLyQtW+0WU1sIFBAYlwx9tZ+qC2zHoZ7i8QMS0tn+xg6p+V1YlStPpVIB8e9VeFaRWYamKXrsrwFSYVewgDBFkN3FcrPSJ2oDxoT0LAHztpOlrvaCoCfKkxQE2XeFBt8t4+oVruN/ZCZ1sxFJ5iMP5ADGByOoYgViM61KYEqOGtTKLT5Qr5gs+ckPOZ3ctsB/PzMxapgGjQRqXS5fECsYpZVbQ29BnZv80+//5RvZ/cheUPZLpteQU4AuMT0kkoZBw/alxITNQBONSWv7PsTijIhMxutVyw5hwKY7RGKSV/MJ47rrGE7oiV46RUONmapz3hCurLjhebVIoJOO0KhPiWiMPK1bDMg9dFBoYpAawZRBFGaN4p3hRXxZR/l6vr1SMqFEDvvYZDTqrxgCylt56cvCCcV1UCqqYTlVI04zhzt3c6y7bePObn4X2rtfl4pgkNsVLDh4SsRTWcO3yUa46sp+DukLe6ZKWhjxfpFDDus4GPvtPB1neU5LNCMUwiTW41S0dh92Z2rSuLCIwnaSRA+fjDRyKQGoNw+VFLumcyaVPfCmnz21kcWmFxKY4V1JImGydCb+TuLUrXcnczCyv//C7+aNXvxTZMIsRi3c+nOraPIZ6leFbLhBeGx8iNbWcpi0Qrmx5KsqIqAZP79JjgJ4Ylnft5ZJzL+CD734vp23dyuLSSsCi2tFSLc5X1XBX2uO27ZmxCQYbHrMPS4RK6xheVotfzFm++gb6d7kjgyxFSxeoKALONvhSPRoSO62JkbAuQDEUVgxR8xZ2QV5kjHBKXMmbuNkSG8ZBX91TQs3bqkZRtVWOZQDXVTyZL9Akw6Ud/GiEXznGXOZ54HnKE+42xz1PS5ixKyzniyzmiqRKYrt4l+PVocZTek+iXeaShIIZvnHI85Gb9vP5fUc5WHRJuzP0OkGYb9UFjaHpUDqDY0h/rsMa1rH4mXmufPeV6HWGbGoTZcdRauw6NEXF4CriauSuqdiY4ix1gZYxIi8qYqKNdmtL2z6savGzb20vapV30321cagKZG9jXYhWFhouUMF0VTKhyFgNDQVrBZCRBh1JNUuKYgpFErWVYbavZTdad1Cm9kVW48J/fXSwC/F8qj78t0LftfE8tl5VjYoLL4GinaSjo/1HuPD263n3v/4RU2v3sOCOYLI0OK47SJKUBT/ie/tv4prhUVzWwdBDfIlXQ2ktU1nGDy8b8MNPH8VOzeJKWn7THk6QQFM/QWmBvrVjZuBL4TxiYbg44k5mA697ygs5a3Yzy8vLdG1ak0od4KobQwWJvkxzM7O8/oPv5Hn/+FLM+ll8YqBwtUmerrZv0eN1g43zqtZjZ12wNNhQ0zBNcKVHSkeadVjesZu7nnMeH3rP+zl101aOLa5EtvrqqTVazwvj8Wu1RbGGUd/7sX1xzacyqsFd9egywyuvJ7vw9uSZCdw0a8N9EQme0iJ4Nnyp5v2r6A0qLXcAacB6Yicl1QtqwgY3dGIVbyu+1kbqohVu4iRwuSSPWFVw98AEPlhZKKwc5oy5gkfcucMjz+9x4aYRmV/kWAGHNSMTQ1dCOIjzgjcWSsNUCbYzw8HS840dhv+4cTtfWFpiwU7T72xkbUcRtwK5RUwXZxKMLXFuSNZLme6vIbnGs+u9V3Hsv4+RmjnMXEru8ogPt9wQqvTxmnjbWpyY5qARJiR0xzMr/XFXnTS5V+OjXpvp7lsFTBtJjopGW5Lm33oXuikp4/csxx+PGSmaKP6kW0JpmKwyuSUUxVVUet88kFpH6FsxObV31bjqzMdRhRHgFGc1kR7lwgKnrbd66duex4bNhzmU74G+RcuSxKv6pCvbB/v49uEb2eNXIOuEMTjeGaVxkGaU81N8+c03IqxB6OLLIhjma8ws05MYi1UZ960T3UQ01ieKSTPKoyvcjnW85Yl/yUXTp7G0skxPDdZLwArjjRq6LCHxntI5ZtfM8f/e/07+6J9eChtmITF45xsmit6MN5pOkHGrEa+6tNpYFeMJ2XhP16as3LiLi889jw+/532cvmUrx44tha2d6s34F53YsbQxydPjHWGq6c0pme0w2jsP6U10L7gdg14gzCY+FAQ1jeS/sivx0qIsVB2YqfhRbUpENVaYxuqlHgdNQCgiqRTjxxwGqtlfxGMkpMuoSdAkQZzDDZfx+QIXbSp53EUzPPTCjZwyUwDHGIxGjKzBJArkiCSMJKX0lo5Tpq3FZj12D5VPX7vAZdfs4/JjjrzXQ6Y30rMpRgtWpEDSjE6ZkIqjZIBLEmZnN5HudyxcuoOD/3kAMz9FNrOewo6CiYCc+DbWVVwcldVF82ObaKWSMUgDoIuu+sUV10pX4QnUGmNpoo4lZGW1gjuVEkhbXVmBkk0obYyJxFGJxFETO6ZRoViJI6FTlyZRV+ibgmStGqdhjxQwrEAHdXUyQJC9B5ZFCC3xGvotp6EFlCDQEjVYOthhrlm5wFte9wJOvyN6aLCXTjajbpiLscrIeL57aBffX9qpix0vkk1hch+6GFtiioRChqyZWctX3nKMo9clJDM9ynKEsT4IltTURDVZLaGhGj0SgyRJvXESFygY0k9xSwPOTTfzL7/xZ1w8fRajpRFZaqNgt8Tb5siyHqz3jEY50xvW89p/ew9/+qqXkGyao0iacU4jZOJoBz+09JRVSKxvkft03CZGfRj3qi2tCUQ9Sh+8xKpidbfzLuTD7/8gp23awuLCMt6VwedrFeXbuOOnn3B3aOAKVaUsy3pelGhrY73iJDyvkNfhSTo9/O6juN5u+hffnuVyQFlqzfpvM9vr8dNEGkKbSFoXMq1HwkqfWNEfxLZoE6b6Ot+SB+lYl2bVhfwj06VUwS3NM8UC9zltisdduJ77nTPLtv4Czu1l6JSRdjDZFJkO0NJRSsIQJTOOvk2wdg3XLnku276XT+05yFXHRqhOY2YtfYEkd4w6JXkKHUlISsF5R8mQ/nSf6cEM+acOs+MjN1LuyLC99cgc5DJA1JEWCWojrtqiHdQZj2Nctub14TjJVN29xpCmyL8iMMzrpJzGME1rvGmsk6rzh1oNTPyaek9l1PsYZkkUPSeuGSWlxdIsROk0hbIpzblo23emnkGloTjYuOWMFMG4ejKKOjVxJvVS+cA0gaYyvjyq/EtqXxZxVlPvdHjgJl7z2ufqL91nAzetXEvW7UNh6dguh/wKXzl8LT8azatOdcTgMYWnTISR8UhZIM7T7WQsXGP4zvuPknZncQwR65to7noe0BMTUIwJlIYk3iA+dF0phsHREVvdLP/8pP/NPWbOZnFxBdvNmm0KofmsiMMBs3Ks2bCeN/zbe3j+378I2ThLYQTqbWBMM7tZ7ZOOA/BtIXP93yZlR73Hl0rig5vpys493O28O/Ohd7+H0zdtYXFxCXV+Ygs9WaTGj9RJNwjvw83vnKN0ZYt/K40ipnp+lXQJpZt0yLfvg17GzJ3OYMmvBJJspS00poZG6k53wnOq7pCqzqst1o0FTiOVoZbvNBKFmshr4gJFRPGSMRyVsLyfDVMjHnTBDI87/1TufXpGPz3CoLyJQW4o6SIJdMyQEmHgLCmWjg6ZsoaCDt/f7/n33dv59J6D7KQDtk8620dcjhQOh1CknsI4ErEB87OepNOhm2+BLy6w96PfZ3RVjk3WYeYySpbAFyQ+QbSLsz5QMOpDWFpmgg0NYTxqbMxkUlcjUzYp060uSGuO1ISZeft37U3ta+hI4ySGHe8SJC7lJE5zTsPNk1afa+NgI4WEhKFRpo0Gm2RRika3E0Y+gr+GlMHLIzj3qXHeY4wa9XUfgNYKjnCHq3gbU96C2Y4q7f8hakqjqTE62L1T//fzf0Wf8aTz2L10rU53MvWuFJ8K1xaH9WsHrpV9fgn6HSgdIOqMkVIqx9IuThaYTtbx5UsPM9iTka6JLqbexiLl4uvqTs5tkxY9P1qtGIVBMWDzsMObfv353GfuDiwtDZBOWqf1VHylysdLnKfUgrVr1/HGD76LP/nHl5JsWkspwe/LxLmxuplvjm7XJpEyQVOo4s98WzvoFfWOVBIGu/dz13Mv4CPv/yCnbtrEscVl1Ptg/WxNEx/WChs9fiM40fnFv5fOU0aP9rFiR0O9MLSAW4GRL8lMxuiqm0izjJlzTmVxaSFqBONNZyQC6yGT0Enj6lnpACuOltCiSNRYWJTc1OJnjUUsknJFMRHrcih+BJT7uWjDiIefv4GHXXQaZ2/w9DmGH+3laJlEcbbHGsGp4L1FKFlnLZnJ2Dnsctm+FT75ox1cfmjIwcQg07MkqcG4UbwFDN6aiIoI6chiSo9bkzJt15J9f8SRf/8Rw68tYPIedmYalyi+XAbxGAwiJkwWJjY7J8mpnSxWMjGtx+WMUqcdTn6+lS5TE0WrbqpyY2lt+4nFqvqYqSCjeKOo+Pjnalz0dcdWaesMShkwdPKoca63hCuEftnkiu2Gb14A1sQiUyqlqAuiCsV49SJK6T3GeKPeB+MFia2M+givexeubm8cwbXPhwdq1fqSwpo009HOw/orj7xY//wFD2dxeIMmaaJ4h6ZGL1+6US9f2iXHMq9WukJR4n1IWHY4tRhJnDJSsH3L4SuUH3zsEGl3Ljo326YI1SQ5P/bWjIUWqGK94hOLxWA82NRQ5Dlbh9P84xOez/023JGVowtov4v6kizOF86Emz1x4QYqXcnM+nW88d/fy/Nf9TJk/SzOmmAHVI19LdPCthh6vHMaB7rNRBK2arOyEw2MlNJ7xPsQxbVrLxff4Tw+9J73ccqmTSwuLuNcGfhwgcpcCycmwY1x6k1gs3sacqqPHuql9+R5ETWX1IexrxXKLQ1ypPQVriTRhKXv/YipLKF/5maWV5awXjGJxZmYwygSqB4tHeFYp2Ca/XMtw7HViGjDOt/4qFEMhS2cQ4ZyoFAMWNtb4R536PPIi7byS2d12dpXfLmPQTHiGF00WYsBShlSMAIdkTjDmqyP0OPG5YLLbjrAR7fv58eLjgFdzFSf1PhgneJKShPY8omBxLtg4IfDJMp0d47kR8rwv3Zw4MsHYN6Smjn8jMH5Ycgr1TT8G+NDUDCK8YGvUY+E1evTQtOlpdesuqr6tZLIlmxi6lRUNLISNNqVtyhONQXc1wYiGhNaq+KjrdFQ1COmhocCm9xGDbKoSBLqSvX9JRapSqNscsWnAa7SQcSwTMSxFCjygElZUYoCssg6lcbQOF6VkdZQbQzDnaWVKVfYy6NhgxwHx1pCol5zTazV8vAxPffUKV7z90/V0uzVohR61nLE5PqVg9fK1flBXMeSOaXQQkuJBkpo7aUdQPclOjLDty9bpDgM6YZq5e8mzWlv1tzO+iBDVw9kFkphc9nlDY9/IQ/YfD750WOYbob6kjQ6SpTRBtmokogwKEas2bCBN7w/MNh10wyaGCiCG4BOMs8nuqcxSc4qXKzxjzfSLIOiRYF1nm7WYfmmPdztDufxgXe9h7O2bePYwlJ06tSmk6zMRk8A/Df0hUAmdTHSzbkg2PZA7koGRY5v2ai0bpBVwN0oukWxmrJ8+dX0uyn90zcwXIpLADRIV0RRK7XDg0obJA/2P2oVlZBMLKYTV/YOJNpii8XYDsamFL6kXCmx7jDnbhzwwPPX85DzTuNe25Qps8xiOeRQ4cAkJAZS9XiGjBQ6KB21WNvjqO3whQNH+dwNe/jc3hV+rAn0ZsnmRmTOUDoficOutp0WoLQK1uO9Yc7NMr27YOGrOzn6pUX8fIp01yB9QsCIdxix4Vq0FdRgwu6oontMCnrlFmTV1NvYStitE+aUzdinzQawuTqM0XHPkHqj2FypFQ/L+7gdjKOi+ApwDxOba9WRyVGwWgCasOiLGNZyGByNVIUrMtrF450PK8dYpJzzGOuNx3vReFvHFs+rF8WrRJ9ZFS/qvXr1pcerUY/gVcSreLXL1k+vDPW1b3+WbtwyYGllRdOu1b1+pJ/fdw3XuSMqqVEpSjxegtDYx2ZIJGa2aQnSyTq4Q7Nc/eUdmDRDXCNNulUWORFAtiOPRRmgbFhM+edffi6/fOpFLB46ikkTSprI9rLaWXgldTD0OXMb1vGad72VP3v938O6GUgCg92onhSsmojYw4zZWR1vvida8bIidSG6NPTSjOUdu7j7eXfmQ+/5IGds3szR+YXQeUUk+0QE0MlordqdwTe0j0BhCJ9zGoJVy7LEl/4WScnaHVIwERUGX/8BM91LsKfNUCwuY1xcGpiKS9UUPxETPLlUwOZxLJwKsKwohgKpqM42w5FSDnIoDjHTLbj32Rm/cvct3Pf2hi29ReAwo2HBUZMiYkmMDU2DlhQEwuU6k4LMsmugfHXHIT5yw4/56sEVhraDTE/RS8CbEXlwn8N4YnBKFIvgAvdQLCo9Unq4y4+x723XYw/1SWbWUs4oUpZjWZETo9xP80tP8rE2RUHHtnw1sVt87KRiVyWhaxL12ox54Ws0GtKpeIxEAqONcUZNfQjfMzqOurLeKI4f0aMAKgyMJiQ2FCkZ6hgDNVa0xiai0vaIGl/ZnMb2T6tvbBT1PqiQgnFw9XkVbZ6883SSro727tEX/9mv6QMecIoeHf5I086M3lge1U8d/BGH3VA1TcT44IgwMsHBz3grzkfsIZ5YhS91dmpKrvuvEYvbhW4vpcS12pBb/lZXrs2aWUoPM4c8r3zYc3jUWfdmML9A0kkZqseLJ/Mm4FGiGOexCnlZMr15Pf/wr2/kxa95Bfa0jaH7cq4KtT7+qjne9aLlyNoWODdaQdGGsmAipuRVwTm6Ngmd1fkX8aF3vo8zNm/m2LFFyrIMKojY4t2coHn87407qY/nlnPBpaFUT1GUJGmJc+5W3T7V8km8oENl8avfYerh94R1MxRLK5RFxWNrac5aBM8w3mmtKfEmR5IRxnZQnQm8qcECqeznThuVh5w/zYMu2srFpypdRqwUSwyGLqRwpzaOxoL6AjGOTCyZ6THE8u1Dns/u2smn9xzkR4MRhXQw0+vJkpLEDHCFxyUZYroYdYgUeDKc5IiE8Td1XWQlZbQ0RVFYOmvWkt3Jk39rP52uUJQ54lqRJ/KzChM7yQV4PH5VdUBMaC/aX+uPK2yB5e6rrWMAe8WHpsivsueOeLkVJc+VTho6MQ+MAhCSwCKQgRVlGFeIJlcKE7osL+GqTNRbo96NAv3RoN5oFF+oevFVRVWvKi6ScjxqnKh6TIC/BfFZlrnRniP2Fx90jv+9/3U/v5Rv90l3zv94eNj854Er9YDBZ9YIzutIQttmPOK9JfRaglMq/wScGKxO6fVfvUHQPj7TeONEztXNFKzqovDqERc6BJ+lrJ+3vPgXn8OTz7g3h+cX8YnB+ACWW4XEa3C09B7rhZEvmN60jpe/7Q285I2vItmyNjRTZcOzagPRUlsUt/lPcdvl/bj/fUz7abow32Q0KlA6RJVMDSs37uCSC+7CB9/1Pk7fuo1j84s452o8I0zzpkVVGA8unSxaVYdV4Vyl8/gy4FZVjL33HleWE+PGSV7zVhipE6m9qGS5ZPD579B7xL1hqhc6LbGNaLwlVhdMFFv0gQLpDEhsRjno4Ac56DFOmS2574VreeRFt+ceZyScMjUid/sZjTwLAj4J3pUWA95Q+gJrCtbaaaz02Tks+dy+A3xqx06+cdRxtAR6XeyaHpkvcPkSpXYotYcmIcTBOsVT4sQBOak1mLILixnlYg+3kJHmUzgrLM8JZ/zu/Vja9t8c/I+rybobKbWoveMw41irtLzAlOOpDJPjIdLe+tc4Vz23S9g+hCSvsCpSMTUp1Nf4VeXsFxgAsdPS4P9UTVh1B1bhVoQ6EELrfGBsqseUHk0CnuXxgfzmPGp8gJaKZjQcxo4gqwz8BhHDSuN/jSjOeJLYUdmIXxnxlOKtKQObKsB9VXvn1KgTF1OqquIVW0M14VDGqzOqTpcLu27a+5e95PE+zQ77wqX+x4MF/x/7rvSH0lxS0xHnvKrB5zY8dBuNv7wPIZNeRVxoE0Qyw/IRw44rV1SmelKYHCXB+JJxyfHNb+EqhvvMEcdL7/lkHrvuAo4dnkc7SXito84wOFxKDYbnKDMb1vHKd7yJl/zLP9HZsDZ0VmUZH0G0VKlNLyTytiYWMRNe9m13T63Y6+gYeO2VQOmwCSs37eJed76ED73nvWzdsCl2VnnAQEyTUhT2H7ToM9GLvAL8o6TDt4inPoa51iRRHw4GR4s0Kreum600ir5yPrUWPbjC4DP/zdxD7sVCt0s5GmE0bMZoR79rkNtokgQwemUIK0tszErufm6XB99tG79w9jRnrBM6HGRULHB0KBSmi0lilqY6Ej9CtEATwzo7ReEyvnxomY/vvpEvHTjGNUslpFMkHYvpKSoFXkeoJmjSi15oJUY9NurZvBhEMrquSzEPxbxFlztI0UWKhEJykr4l6Qpu7Qp3f+GvcWX5cXZ86LvIzJow1rYE9u28ydtgDGx1VsJxXU6FsGrc7quGolL5jlebq/A5p6Kh2Ij6EOClPq7Oq39XMbbjxWsV8dHDXKLpS7vOxC1hIaEm4WNtMi3QPVhzhM6qGgmteEzU+ZSoE1XrUbFxJnXhQZoItItq2BbW1dZ7jHopK1GPaCpWh4cO6p/8+SP9Pe+0QQ8Ve/Qmd0w/svtK3Z+hKSnqVUtE1ftAoTKqI2mpUOLuXhXxTrWbprJ/+4ilvQVJp6tFIIfKrQ3JVsCkFjca8bhzH8AzT7kne/fshyxFnCOJuYpOlDLaoxjvKbxjzfr1vOLNr+elb3oN2ZY1lKLBgVQambJvhcnKWMctJ6ZXaMuYsSpUFaO9sikulUwsKzv2cK+7XsKHLn03p2zazPyReYqw+wgYUKtLOm63XU322oDmGunAqk1icgDaY0flPaULb7VXPW6pcVLOvDTuqGH5FETN3ntMliA7jnLsM1+n/+B7Muj2cMMR1gRpf8xuR72hXPHAMfqdkgu2dnnwhXM86IIuF23p0TcFy+UhBsWIRQQxU1gjpL4g1xKvjq61dJnCSZfdx1Z4/56DXLZ/nu8fPsoxm0K/R7qmg/UeX3ict3g1Ae82IZ5cJYq81VKIwYghLUEGKaOjPfxSCqMeQoKxBXamRGYMM2s6zHQM+coxbljczl3+7BGMjh5l/6dvwG7c2JqaKt97vTXB73rSj2kjGW0pWSK+IMpkwGibh1V1UVqrYVr4lQ8joWmI4zU1ykQxrklcHCFa28GKPlUokkY+Uq6YdMLTPbUhpUKMMhgqXas4GwzRyzwULYdPDF5LfMgDss44fCBEGe99VUG9Ex9aRIM6X6rDlN6W1hXGum5autGBBXfJXU91v/Ose9slf9jfpLn/0L6r/f6u89ZkvtDSlz5SQlTEYBVvPKJGFfVSUTPDTVhqKaWxuu/aZSmXPemcwQ483pQab/ixTOqTnVLGBL9yZzzbptdiFIZlQcfGQHoVSmsobLQfLkvUKVNrp3nJG/6BV/3rv9A9ZR2j6AFuJGwb/QSdxUdb4TD82eOxIz8+UgWbmBbNIabzSBzPepIw2Lmbe975bvzbe97PpnXrOXxsCe/CyNoWdNdXn/djRauiVWjETSragkZfMxdffK8hjbqMoLuL1BrvDS4GilIhs7GDOZlDXDDLjMETBLqJcz5Y82w/wPAL32b20ffl2LTAIIfC4JZzGB0jS5a542mz3P+CNTzkwrXc7cwea5IhJSV5ucBSWeCsA2tIxYR7qSywCFOmi9qUPfmI7x1d4lM7b+IrBxbYnec4q5ipGRJrEErUFRS+smDxgUZgbIxPSYASsR5RQ5L3YCnFzYMM+2jZQ3GY1JF0PN2phP50H+2UmEQpLaS2w9KBA+zc4rnXSx/D14sPc+AbB+jObGDESmAG+AxvXG1xU4dTrbL7Diz1li1PawysfCYq1rmvsxWMr7iXGjlTvumQfHzikbKACxc3LkS3S+zCgp18+DgutPGhMVf1DrUeNQ5fxJHQhZHQ4DFpOBFK8WSijETpiuJHSpJ6zECxacutYWgi2FXd0nkE3sfIXHFejdtDL00VrT6uhOKl6hBxaWFdkZUOzZ0fdZxZWvR/+fyn+g3Tib98ecF/YM/lfnfPeyNGKbwK4l3A6KKQ2ikqYgK5UpXaj0iqMWnkDEcOBcYyTwAAU6VJREFU5coQ/LSKr5cb0TZDbyGnoeXfV5ZlJXeMT9EwktCtGC+IKzDGkM1N8eLX/gOv++Db6W/dyEhdlMhEsqLeDOK8Gu6pclzSzZijLDFOqizp2YTBzj3c++JL+MC73s3GdeuZX1wiL/IINdjVCZ0TZ7BOYFjV72r8C+Og4L2rAXfvA7tdK5931Vt8/MsYVd3QpukHf3yl052h3DnP4OtXMnOf85gfLWNXDnP++pT7n7uOB118OhfewbC5a0gpWCrnOVImqMnIjJCIwRGuqERzMklI0hlWFC4/ssTn9+7kU/v3cmVRktsU20tIOj3EWdSX+HIYt/cGoyZYd2sWIrEUBIeIx0oHGST4eUt5rIMOuxiXhWLSKen3M3r9BJOBTSBJWxmU0RMrEeXIvgPM3X6GB/7j0/jMc9/GwvcOk0zPUFCQ+SGlpCciGOut6LbG9z5t8bJoQzeosavq3o5dVJXnreLGsCwkFCmpipiJf/cu4Fmtwld1WD7SIBw+umSGG7coFBO5WCNRMmAgSgoJiVFkWSm70T7GKJJ7nA3fMBFPiccVoRJKIIcKxqmqx+KCzN84fHzAIsF+0qtzYpwqvi/iVg4ec0949MXukQ8+w1092us+vOdKs93kJtXM2NK5wlbNoYjxRlRUTJTROG/AOCOY6DAm9eQ6KAxDLJReKEpVU3FDjysYt/x2igHE6n3AcQiaRauClC7wE+e6vOAVL+Ft//E+0m0bQrGqjDmEk8eyTWzp2gXFTDLNxxKztV4Q9EzCYMce7nvXe/KBd72HzWvXcvjwPKV30Sc9gvcnSs05gXvoCYuWJxYrF/hXLkTFKxIKvDuer2Ha28AxSkMSi3De8p5KMSKkBBb5cFhCMUS/fhV32Oh5xqPuwCV3Op+73j5l08wIw5DBaIWlYYZKitgUk5R4juFcgikNU9Zjki5Lvs8VS0O+sn83Xzmwm28tzjPvlMT2IZ2lYwSvBU5doIYgGE2h9BETSWLHqFhyEi8kdCmXLXqsi5tP8cMU0X5w9+gonb6h1++QpBJgGynDCIlgTRISiDTcx9ZYrAgH9uxk6nYZv/zqp/Oxp7+R0Y1LpDN98qwAn6yac3gLR8JWplt9Mvg6Q89EehIteoLGglQB61X3BC5+fd2YhP8SvqbqylSdhsIWfHJUYqHSUPCUUOhM7LJKfLRI9mjhydPg7GAGYTRME58wD3SMkq0okmmtEPWiUGiwmckUFRUjXp1650qPWG+MuOB2Fx9U8F90gbggDqPeeXVSdJ0rV/xUp/QveO5D3DyL7n37fuivNcuOtGvJS1+K+FzUGxUvqPEiXny0TjOVO6AJOptqnECxiTAsPXZtlyQRtPBCh8rHptUzrVIwWN3yt9L4qTbuA4KSqEBZhoTh2T7P/7sX8+5PfJj+KZsoyqLJCqTxrTuZ+4LoCRqs4/zbtWV+5sCHbeBg/37ueqcLeP+/vpMta9cyf3gRX5RjCn0/4cBQc7lEju+82oUqdlVVwSrLYN2jLd+tNj+sKEuKogidVvRYr/T5CHXKcxOONIzBKUJmMqy1DAZDXAFuxZH1Ss47f5b73Pf2POHh53L7i2ZZu0lJKBiUR1keDMGYQNEwwcLae8EW0DOWrp2i1JTtw2N848BNfHbffr57bJldpafs9Ml6a+gSYs28H6ClqTQkGCnBJ6FQxZRl1SFWlFQyJO8gyxmjI13KxWmsS0itxXcSNFFMB7KuIcsq87+odLNhZDaGePbH2DET5D5pZrGq7N5xA7e/4Hwe/Oon8Z/PfAe6NMB0ui3XCpl0xTjuPDi+UDGhDY4f9+LFihfBK1EiU42CQYrRbAUlAu3EgiPadFTS7rBiIQrquab7MuLw4jDWS7UhNBLqia+4nrliO5HHFalSA6N0jLIACemikk4pg4jE94yyUsnfTeiwpPSxgwoucyYC6g6PSDhqxTqUUFHVu2CgrKV1JGISNzqy4H7tkXdyl9ztVPf6vZ91/z2cL6eyrim9c84Yo+qNLfF4vLPigqWwDwR+522dOarGa61eFiMm0aIoZebMKWEd6pZKSDuhY8VHL9xb1FnJxHw03pVI8LOS1KLTHZ73d3/Fez7172Rb15MXOYlvNIHaXin7kzBfTtBhierxtjKtvydqKA/Nc4dtZ/Cet76DTWs3cOTIAsVohI/ma7Vzw0kY/ScrWIFr5RrKgg9bRa3+7MNI6J0PqGr8uHpfm3qIjh8MlfmkMQYrDpUUnxtGx0pwC8yuS7jjXdZz//ucyiMefC53vGCGtesSlCFLLLJYOLwvwQou68fvXZL4kowRnSxDfYedw5yvH9rDl/Yc5JuLh9g7GJInHSTN6HUMhiIYLJLg1IKkiESFA8FaxkWLDlGPLSE1GWapT7nUIT9q8SsZYqZIpYPpK77rMJliUkhEApnGK956EmsRE8wITZXyU0nyIo/MmDAallbwo5xrf3gFF979rjzgFY/lM3/yAbJRR4vUNu6JNz/2MSY5kJamoRoDaxPjaGIgUT4nFSYloZuSqkui9Xeiu2CrSKk2HVj9eXUYExqZahnnC49JAoeoKoTiQk0prKOM9003D6R1E7eFdknDSJgYrbeF5ciTWI/mHu17XO5JxOELWzo8VlwkmATXEHWxgnof0hnDA1dPiUjijZamXCo7lPYPn/1g+9X8x/bjh25yOjvritI5L5hCMF2HUUQG1kvQdKuoCb2KRFMDY2i01ah4VS9Yca5gzRnrdM2d1svhr82r7fWkDLDvLWGNyoRHXW3s1jazc86TJgbTS3n+S/+C9//XZWRb1uFKh3VQquJsI1CoEm38yYTMJ8CwxopXO1pLYnDF8oC5JOVNr34ddzzrbA4dmWeUF5go8vUx9CLiw8cx5b33dYc12V0GGkPTXVVFqKYyRNJo9WcfvTu0VcQqu+zKs7wyrpRo1VMMi2DDXS6zZlPCXe61mYc+5C488IFncc4dZ+hPlSywBG4/CytKYZJAFLbRDNeH55cllp4Jdrn7BvDdg/N8Yc9OvnPkMNeOVlhJE7pJFzszzTQGV5aoFqEokAQsMkIxXqrXLgRNaBIunSTvky5OUR5JGR1L0CLFpD1sRyBTSIb41CKJwUaPLhGlNAZj43lvwgLeGhOSyKPHF9aHocFULguKak5qFF0uufba73H+4y/hgUv/X3fvHmxLfpWHfWut369773POnTt33pqRNNJIyEggITyAZJAQsoGKbIwcggwug+MHLjvEDlXYMXGwMQoxdmGgKhhC8CNlElecAj8qNsa4HGNjcIGNBWj0lkbSaGbu3Pe557n37u7fWit/rF/33ufcc+/cEYKksqvuPXv37t370d1fr/Wtb33rG/Bv/+I/hTT3wl5M3HB6vhWdGrlLU3NykLOMk1U9Yt1Qq49ShApetOanI4PSE2lizLrXmCdGxd2UKAKYqmpXkCpxDtxw1qDd3dDAUEQhHukg5WgLcXbkZIFP5AnNxiyUNKaFq3D4W/Yx375QlTIg2FZ2g5EqQ1lhxlRJDVJ2K4AXZwjMSgZLf+OgvOstr5FHnrxXvvcT/1QOU8s7WmRlVEJc49zXmeTFiRqrnkrhYENE4RtlWidjRqRF7hadK8ac723wqt/zalz/lV8l4eyFFHnVkJHH2ORq+B36tzpVGnL6ahTrpQyhhJQYOTdwd7QpQeeEP/ve78I//vmfxdYrXoblajXR4MR0YqLNeJ8345w6XOjWQ46m42ocR8VTL/zUEwMiQ3ZCf/MA3//9P4yvestbcenGDfSDVhqoAsTIc21kw6cjqk05g51YrnAUmBJMOSqDFbRGV9HKxNbmZ6o22KOv+uhuoWjZ4IkxrAr0cBUX9y3gta95GF/ylgv4yrc9gS952+N4/NUttngBxQH65XO4sTCUpoEwI7cJyRXFe7AxEhuahqAQXFk6PnCwj39/9TJ+7eYNPHuwwKFkSJuRZ9u4zwtMh7Xzp0R/qZdU1fEGZQrOFxSVWyYkJmC5Bb3ZYthtUI634aUBZ4dsSYwESyEn4pTBIhE9cR0bQgAlDT+BsRl5smW2EMkiwC3a5Kxa3hiSExIYsgX0/RGe/sQH8eQf/Qoc3NjF+/76L6A9/wAGjsG/qSQohRhq6r6jdTd90BruG8Ns3J2czMfOk1GaEGAVqVvoppzKRLKHjqrUXqcAJqYCcAGsgFDCbI603lcwFXYuU3roNeJyVjiXkDyRRZrYGzRHz1hXjfu4c3TZ0Syj+RkAknjCvjhycgx1rzI7WEIIlgarItIg4G2o1YGRMFNFmHyKwUotUgvcCzy655w8oevKN37TV8q/3X9anjrcl/PnH+C+G8QlEXnYtanXIqzGxZediDnUzDyx1+4wcO25rgSBUebWu+Mjfu3XvMyf+Zl7aPejPbjN5DJUG8HRjJwdTnCXzXmdtHZtHs/imAwcTruM1DQwAb7jL/15/JNf+BdoX/EIutUyzHZ4dK5ZR96+kQaRn4rO/eyRIydt1G0KzdbDJCKiWF2+jv/8a38f/vQf/iO4cXMfXVemOX2qulF58s2jdGMWgE8K9zEyWtscx4lr2sBcIz93DSLaRgArMMT1Sc1RdMRIgrAjtwnEwHDch/xAFPfcK3jDV9yPt739tfhd73gUb3ryITzwoCBB0eMYq+4q9qzUeYbVJYMA8wLXghknpLyNwRKe6Q7xvuuX8dTuFfz6jWt4Fj0WIkicke6d4ZwDXgyqgoKMnkJkIw6k+l3Yw7bYYHArVWo4A2wLdjRD2WPoPgP9OSSfw0XgrcPZoFIdlJkhuc4pZKyndnAYn8jYsTB66/h60MV4bTk5W2CcJMXV6nlAygnHh3t4+tn34yv/7Nege/4YH/wH7/P2nvvRU0yxJhslIdWtjE64fWLdCTiSaVgb8IWFhQdA8VgJ1CkXBgrIS/iBkkbVAAXRvlv/YuP+uJxKRGH1tYQCRoGjkFSwMlY1VXgyGBtSMfRuEDNIqop4MXRimCXD8tjQjrKGtO8YtmlKC33TJplDk2WDIYliBQGPxJopMdQBjblbJAASjArBChLJcNiX1zx+QR7/8gflR57714Jz90opHbuLmDonQoku5uAh43wzSqD4yTgqKfDQlhBCD0RO5ORsDE/EbNpbeuCQ3vptb/Sf+e9+hZI+7MqLqpbkiHZHKbuP7vy+Dp83hzdogWLAYNGUnrdbfPtf/E78k5//Wcwefxi9lkm6MOV8t+GjbuVGz354YuhpBehpbBaHjUg5XODlDz2Cv/Hev4qj5QoHx0fIkkEegz2nzv16H44Tvv+hlN/0YV83QdtGNdEd0BJdBWYCNUC1oOgC5sNEyJuGRarVhgdGi+XhADfHYy9L+IIvfDne+btfhq/8ytfh8SdmuOecw3GMZbmCo+UAA0FSBgmDRAB0UShiwZxnyJhjSYynFwd46sYz+OWbV/Ch3V1cHAp6zkgpockznKf4jKVYpHST+WjICIkFpAluDKcKxOgBYjS+Bep2UPbn6G800IMMDC2kSQEmDaAyVLcIqalptflPNaqsNSoaPeOl1oeqYaDXgay0AVSoWIHJdjAiY2KNFLJypsyOK1efwbwxfPV7fy8We0d45ueeQb73gvcY0IySE+aTZRzaVK8TqgPw2hFhtIThMeWruinidRQVqV+ZoiYfAQo1AkMB0RDP1+eYC9wK0fh6FDBrXBk40sMCBUNhZMhqEFaoW6SDHv5XZiFnAICDauqXxBOa5GjUgWODzAm0cCwaw7wzdJnggyGxDSqaFTKkEnltIQsyTdWAAqcU87cQkZZTYWfRw/3hK971ZvlI85x8tF/KvL1X4AseiJnMaaDJyJXDmCxccgZ2sJNDbbQ7QkgcLBopycmdayul+lbDvHewi0e+6lX05m99Hf3Gj38Es/lD1PsCY6eJe1/TpjqUzjclBjW2UQM0ZGZd6ZG35vgL/8Nfxj/6v/852scfxWq1mqz9fVORemIAEt1iurcO0m9DtNOmQ8OIpVQn9TASCMPeAn/1h38Qr3rk5Xj24kVQziCLA3uz52wEoWn6jJ8cIHECsKbUrvJbGqV9M4ZpDZa9B6iPcXJF4N5AC1CGAV0ZwFhi1izR5F380T/+KnzHf/uH8eSXPYL7HiC03OPYbmI5XMe1VaThDc+RU4ZXpjEa+gkt74DBONQe7z/YxYdu3MSv37iGDxzs4mrpUcSQ8wxNM0ejDIhjoHLLkA6uykU2Q2OGwgWWHIMrQoqckJdz2HIHq905yt4c3rUgtBAh2GyAi8EYMKEQT4mEwp5ioKpLRE42ghFzAJPUa6JsYAVz8FW1NByVwhiAy1X+CNYI1KTuSx9Fn1E0u3jtU0hPzPAHfuBb8b9d/THc/I19n8/vQ/HD6lkga0H86BQ6Wo+M/to8ku21g2UkwZnCaUWCd4KTUqR/AU6owAWKFBA8rKMrFBgGEA/hxO4F7gXEZUod3QucleAK4wArgoGLwrKCOwNySCGWbmg4oquUQhnvx4Ykjj3xhDY79ovjPIB9drTJ0KwIJRmGnjCT0GCJ2GCkUBUYKQQKI1WlINDIC9zEjISdEmDFIZLJ5NGveGT413ufYW3nLH3hnoOKJHcmq6kgE4nDmUZrMfZxEC8Rg2FuREIuMZiVwq/TnUmoMByeeJuur67Sl33b6zBcPaIP/YPnIOd3yKkBW/jaOA+1ZToIfTcn9/W8jQhXHF3XYadp8Jd/6Pvxk//w72P+xGPoliskX3vA6OZsSbtVxT3yW2ei0lmtKr6Jfz5ZR7QsWD37Av7IH/wWvOfrvwHPX7yMnFsM2ACfU83cpyuAo0bqJGDZicjKTGFGgDWA96GRohiFrmUrIhgboHYE8B5m52/iwk6Hc+ePcH7nCLO2xxve+AAYHQYssVh2WHgPpAIRgZDDvIf6Cg5Hyy22uUUxxnU1fPD6Tbx/9xJ+7eASPn60i6s+QLnBPDXYSjvrtFUHGAMDCMU5JvKgOj54VcKNynxyuPRAIrS2DT/cRnelwWp3B8Mig7QBSRM+fxWknAFPtDE1mkPkLj6BEurUHSUP8JFID4mrack0B7G6ntbARoiiyE4OIq1+XjY5qowTgQiAVD1fkhjNdeXiM7j3d9yPP/hD3+x/7z0/Cr12AD4viFiVJhLUR4fIkUahauJjVcIoZjVXtTrM2MCktRMrxJ6ogDMCEmMIgOKhLh8AGmBeQFRgVEA2ADTQBFwjh2VBjI56rFRbUJ0VqQTZntnQrwySDUNvmLXxOCdHEsdRNrTJE+Y5hk5ACTnFMMJUBaRCUT2kuaErlceiCOGsKISipGlcw0UWAAK2AiIp3SAPPrjF/hriDx4dM6e5FD/igm2SgSX2g2Pq8a4XrvA/jSQjWlzgzsQR7FeHWqkEATlZEW+EOYvB1WkvXaSv+u+/kNoLgl//Xz5BTnP4fIdcyDeZg1Oh8/ryzMB8vkX/5tf+A37kJ34U+eH70K26CPUrAV49MyKyN5/sf89Urd8mB9wMijZbZab5VW7IKaO7uoc3f/6b8Fe/6y/jxrXrk9qPanVyc3LZ5LPuY4Uap2yNsW5yhk8k/WgGa0awAeg1oRSC+hKEBZxWmG/vYnu7YOv8Cts7e+B0DUgHEO4q2GXsdQx3gwhAjVdXCYVYASDIvIWUM1YouLQ4xkdvXMFT16/hqYOr+HR/iCMYkDKado5tbIFq98ZA/TSAU9lRolaDpo4LDmudClKIMWyUCUQ7kFWL4UpGt9tgudvCljsgaSrAIApjbDBqg6CSaqscKAhKBmaDSYoeRnEwj7tpw0FiKjRTBaSR7yIwccWB8Qpt67F+o7yJRurfIO6QcTqJcTRCDx0+9cn3+Rd8wZvp3T/4jfipP/0PnMsFkKRxUOXaZG8CrCmqCnHoqLNiGt0YDDx2p5BVHqqmgh6gxFQAH0AYEF7EQwAXBjDV5T4AGIg8npuW0QDwEE0Hlf8OQVREWepVNFoCtblzIDuWC0dOwLGE1AoAcAUJVy85zj3gWMKQ9gnttuHICJwM2QiFo8yoxZA4ZlWxM4QVAxVQEShF7wJI2E3gNDAJ2/KY73vjOX6+7WS1aKQl6pfEDCU2Qm8aRBnBWaL7FePMFTN3RiVI4W4GTsR14ru7OxPIhEDkxl7cPDfFk4m4D36NnqEv/7OvpSde+TL83I//Mh99+prL9gWinMhScbcU9CKHUoLATgQSzigpQTPjf/5f/07o3BqBWVkb/I/ph9XK61m2miOBb3ym24eRwp2r3THBiWsBmUBGcV3IAlsNuHc2w9/8gR/EuXaG3Zv7IJHw7h8pucmhFiemMhGoDmVFOIFUk0iXylPVMMDUoMqVp+qhfogmF2zPDtFs3USzvY9mZ4FZewiSFQQLACtYKWHJohJTd9jBKdJpdYU4Y07b4BSuEjdLh+eO9vD0jSv4tf3L+Nj+DVxd9jhOAs6C2fYM5+sFQHWY0lRxAVFCoXWLUmIHioJNYAYUFKgbIAymLVC/hXIj4/jmDoabCeVwDvYteCOguWJ97aP1VJ5kIUfKDmeG1zRwZBBAIa0AxZWVxnRvHNEpNQqrY++N60Sxer55fS5IdYLUUWMkVLktmgCMWCvojaAKMCl0ceAf/eR/xJt+71vx7u95N/7xd/8zNDsPefHi4QwDi4bA0ZCInGgsI0YrLhGrV6+qoEpH4bcbUSXQ3ZWA4iPxPkZb8W+YCPWwdA0eq8oZNriu+BeC0omwV6AgoaC4IrlicIMlm8CsicgDORnKgSPNHCKOzH5yoFkjPinfeeFYNg7pg6Uv0fSMVA3VnRSiDOMCURYjVlC0ssf4WIYqNw9u80V2FgOzGRvNe3CBWSKjSNalmvGM8wylPhKISzA/xoCUSBk5EMti+JAXAguvinMujLZxT0Zwa+n68go98M07+ENf/nb71Z94Gh/62YtUDhrk7XOhlJCodnnIPYg4wRzg8w1+7ld+Hs/s3QDddyG6kjzVFqmIq4MUE5Txanob/d44GiuO00mTMfXdu22OtKolbi1RWl85mqMVfvLH/i7e8vovwqXLV5CbJqYzu9VqYG3BcanavcqpTm61Og100Nr1ZcZQL3Gx9AKjJVK7xFYzoEk9mq195HYfs7wHkmW9IBpQepRhhRVrzCNJdSJLqRd0VTTE0WaSZljBcKlb4NN71/Ab1z6DjxzewKcOb2BPe0gSJGG09yQ0lfkduoKOHSYO0Qy2AEGX2nBGPeAZQi2sGAyKoQm+reE50lEDe95xsNzB4eI8+r0W0C2QOFISeOJ6XhQQhU8aSQUdikunpQComLpjAVAyzjKkSq6Py2LHWo2asDGk1bmCKoWoidjBMjbWVLuouq6RQaqdDMOrIDxAKlWqmGDOrsiZ0K328anLT+Gt3/Z233t+Fz//Y7+I5vwjDjaY904QhImcO0lt+gA5hUeVk1e/qqq3Ine1qlYPspyKE5RAA+CDGxUwBgL1lWQfYgAjergPYB7g1DtjcMcARqSJjgK3ApIBVkEKUGiNtsQV5go2Aw0GzxFNadWFJvGRu0JKjiw1JZznOMv2i2N+bDiaR8WwWRm4IZTeUMTQDmMjmUCkRJ2bonwJYbgKnNncWFJhDIWbnYYW/ZJNiArXYXUGgjtHwh45vqGKJRhwJxeCF4qEItFmAyZEyYzHKYogBoGVwdwN1HC2zESZnFLDdHSwi/lDDX3t970OX/Itr6L3/6OL+PDPXcbxJSNAwG1Cals4gwwKJQM3O/j1D38c6YF74G0OvlKH6kS50c01GqqdkohuunSOmi+n2r1dy92ju2z4akVbCDikCU1D0IMFfP8Yf+vH/g7e9Y6vwfWLl9HMMnordeygnzTwRpnoCh+5HCdI5aPMe5gvQaJIAjSyh9weo2l65PkCko8AOYZgAGEVXlcWHjpGgNEQ1dpacfUSusHMCS1CzTIkwY3uGM90e/jowXV84uYVXOxv4PqwxE0uKJIwO5dwXz+HeuQWo/jUYigg2AlSMhy5Dm0YL+COdmjREdA1BZ4JDc/Q9Bl2WXD8vh5Xf+Umho8r/MEBO7//dRjOObwEXWO2jpQYOdL7sWBcJ0WDARaCpriAiHjlsoKf8tpFABkFxlrnWEbq6LKZClYj33qgJvaKcY6qSQZT+GZyFZcSG4SAVPu7BAGEEjMWnZ3ADuTE2D24iGfmT/nv/YvvwOVnnvcP/+yzaO9/GVzJjc3J2NllzTUQqmVLDd/iyqajgWykhdBNyYJPkgX0MAwQDPAKVCNoAT3ceqdpRw2V84p1nNcVxFJ5LEHIJgYPsh29oskK7Q1DYxhWhlljOGTHdjYMyZGzoxVPONc4rl5yPPQyoBuiYjg7NnjD6JNBEgFqSL1Bx0iLtY7pVUALjBiwAjGhQgw3VhWBGy/JCOLcsZGCWJSJucojrc6KU1QvL3KYu6BaKjuZMBvcEnOc4VYzeocxFAlh66Ag5qUN5Msl87kZts24Uact2oYNAx36Vdz7hh36A29+M975Jw7ok//qOj74L17Apz52k4a9FUAtODfIDaA+IEkT5XaXGJ3oFkLWTUKcfRodJmPCR5VpGwOcWi1iZ7hxFX4R2AhOElzJerAMGplhdeUm7jXGj/7I38Z73vVuXHzhIiQxXPsNLnU9FYAsg7yFo4djgHkPpuhHT2kJliW4WSClI3B7jJQLMnUgqZG8DSEjK1xN/TKc+rhAVmCFOZQLEgxzYsAz+pSx3y/x6eNdfOL4Kp49uIKnD6/i8uoQC4+yf9swpBXcixlUg9iPPu4aoZwWthJF1Md1gJQaxBIchH5uaOczzIeM9ELC6jccN37xCHufOIJdA3JpkbbvRf/8Eotf+gjOfd2T2G9WQBmi2EQRtogZTIKmhVTpE4do1BIqZ1XTv8pzQWgaCoNKulsFJ5fo9wUxWCrtywFeAofUUWIyRlIAIDqp3qVKCuN5+DhhT2qaGX2H9eLoQBY4seO5mx/D1iPuf/IHvwE/dOkn/fkP3kR7z33obGHOBjYxmnzZq5vKaP7PrFUgWrVXa1GoA1UYWvkqRwH7AKcejB7AAJtAayDmwRUDyIOct/oa1DRxjLbEFYyCIcV7qytaDQJxYIMnxbAyMAd31Rw69mYRUOUrjoszJ7znDQ0Oe8JyIJx7gHG4ZMx7hswFq4HBvYAbwWJIgCRQSYCkDE2DlWiTd8vw3MC0kUINxBo2tMPuzfw7/ovXtsO3PdAcHvaNkM2EkUW9NeNGwBnuDZE3TJSZ0ACUmTQBnpNTkkQi7glAYoIQSIjBBBOKwjOTOZMTqxgZOt4ho1ec26Fz5ASsKHGCyBYBBnGlC1stzqeGuG9w7ZM9PvHLN/HR//ACfeapQ9x8oYceGrDVQF7xgPs8xeRz5ug8Gh0/KaZDhxeU1gObJj7LdWxLsVr1oTooVEBEMBuHj1SLXmZY12O4fBNf9von8YP/w/fjy77oSTz37HOglOFNeC0lECjFhc6pq61dKzAtAV4AcgDO+wFQ0kF4WU80Cc2Q+dRGHoxQiXFcznBL1Y6mh/IC4AIBY8YJoopDOcBBf4wXFjfwyf3L+MjBZTx9dB173mFFfQziSBLnc70m9XVSHEoA+lAHigdhGcybGsX71ykupfJXXPkbaeYAWtANweJDAw5/ZcD++3t0VwdAW2DGSE24PRQbkBND+4L8xa9C/vo3YTEcAtrBC8FFQmjJFtGV0JTeMQviSNPKV4XdVURQPDaE1SlUocWcUscKLpkiFWSK+9m9zuN1MBRZgDiAS/XI9CnSStHCMwIWUe2Ek2rhQURoQUghrXBzg5jji5/4YqdPP4y/8c0/4XtX4bx9zgdbebQsUvAszEYyzv9jdbiBOYTyxGoc0gWKfDmEnhQclcNrCjilgx2BBwh35NYbuAeh4zDe7czQI6GHUQ8tPTh1QdCjD/LeBww+wK0AeYBZgTUFzaBoe0VpFMtsaI8NR43hnoMwVbs+M8KTT2Y8uB97Y2/FOHcfY94xFgOj3WYcdQIZArQwJKwkwYYMkgQvGa4Z4AznjEEbAWeFNkzU2sFhfvnXPtbO/swrmt2jVUNurcAbB2dxtKzUgC2zUwN4I4wMp8RsORFnwBIDSQiJiITZoyUrLNWZYUJsxOrCcC7kBHYW7TCH8qPn76FHZkJiFhbiTJSFMDPAWUlSwfmdhrZFkLsWh1cUV59e4eqHV/jMs/u4eGlJV64UHO8xFgcK72poUw9kCAG5jWpYChKXwGCkSBANdbKLwz14pyCSQl4SBuk21sfx0IUH8a3v/kP47u/4TsxbxguXnkPKA9RWgBSktAeWJUA9WFYgWQEokLSHlA5hTmAZ08IwD0yYTTwXjaHBNPLXJ57NUepQ0QYMQmJDr0tcHw7w6eUlPHP0Ap4+fA6XVru40R3iwIaYFciMxBJT5IFpknS/kSR7MLcnbXumLlzC4AyzOtbKCY00QMsga4ArGccfUFx73wL9hxzL6woMM1CTgGxgqtETGrhTrbwWcMoo1mP29tdg551vxLXhOniIUqozBTDV6Mo51Plc22c8xYUkjGt1DVh18AVx7RrgGvnU/txUwSpVDBQCMoeffxpBiQxMQGKrBekIKHLd5pgiRqQVBbzQbwfHlsi8ASPFhOxgUVPytz7xu3H1l4r/9T/2oz5097pL48alKvrInStxFiMMzZkUTEYgPQFYNApCK6FONLh5AWMAU00BMRBzR4Qe5oOJdDD0zOgA9GbagyRSRxtBavo7AGkAfIhpulpgOVoamkZRekXfKtpjw7wxHM0NO9fjULq2bUG6n2sch/2aN94Xx1wdR7UxmsmRxXCsBukNkjQumRJHXF9LKKmeGWAiI4a0ODpcUWtzKt2COHNtvDWYO4kS3NilThVTZxO2StGELDQkrzBmiJoLM4TNhZnEyJUVrO7K7EzOJMWZKNOxOz1zuM992cLLz91D98AI1kUVOie03BA5oTsaaOVHIFbMH2nxiscFr/3aLXwN7geWDdlews0XFrj+wk3sXVFcu7rEtesLHBwIjo4J3bGh6x1dp9CiGPoBOqymGeBkVZsDR2KDZEbbZjRNQjtj7Jyboc2Ot3/p5+Obvu7d+B2PvwJ7w9/HjWEJeeAYTEskrCAo8LQcp6hChKeGDjbUgaUJpgmEJozmQAgHsZFPG4tBBCFGpgRw+FL1cByXI1xfXMQnV9fw7PElfHJxEZeXuzjoD6KQI/HbyVbC1piaKgFDSAoGAVSCyZXKTphFKz/VklGMq5c6ka76aQmDU8K5vA0uGf0VYPEhxu6vrrD/wSOUFxRuc/C8Bc8YPitwHoCicGtj6EOqVVhTaI7+wBm20P/8x3A8A3be+fk42r8RzRgc4k+kOsZkJNGnyl/MQSSp+rjKR02tN4S6Lk34L1KFoLQGrFEUykSIYzzkEQKBSMC1UAy+jSnUFdiiB9FHPqxqVMOVi92FNC6NRC7JMfjSP/DsL+Ktb3ubf9v/+Af8b/7XP+Vp/oiLmFuKjlwiNoMZGdyZtY400fCurX1+k2JdxjabABiu4DUS7URVrlBBzNBDPIh1lnhNkgFaIjXMaUAZCnIqKF6QVdG7IqlCs6ItCs2G5cLRN47aOohrQEykB3AxOxqA8I53JBwdEZ5YEq4eMzolnLuPcdwxtgbGapshnaApDM8JXZEpNew0gSQBJcOoAVkS5wzXBuCsRZvZw9489n1vay7Z8w0Xboi8cfMGRI0gZTJrhTkzIYGoEfYs5InNMzESHElC6J3EXZhIhJzJLTE5MVjAxmQqRESJwNUWlMEg80L3MNMTO9t4+VZD22Qk6KE+UBViIGUB1ClZjQOY0BLQsGOWgDYL5iKYIyFO8wxGhvdAWXl4UK2qzf0QKSLVfsUERDoGILEgp4wmJ6SG0LSCeduAcnBgPVZYLI4guYEIwJ4m8XICg3wWPQrEIAq/pqi7h3yBKUVhwAHiBIEgWQJTBrPU5t4EA6ErC9ws+7h0fBPPri7hE8fP4bnjy7jZ72G/rKJHsgFECA0JkgHsUSEtFCAEdxhx9JbXcWxRJx/jJwZZgjqwUo9KH8doe6YEboJl4J6hzwmOPyi49p8GHH7c0O0OIGvAlEGNRLWtjrOb+iQ3GjCdTutzo5tPxDCsjnDu698Me9srcdztx6zAVuAMCARECm0AlyYqudxXuUGkgHGfYRStMhCq0oM6mZoVIkAiRwIhV3eGRB56KgFSvShnBMGeJ4I9RlYSDIkIEhXB4MEQ2wywg/OYXgrAcI+pBQZJjauan58l/8KXfSn+yQ98wP/ZX/slm+885H1SN3EH7RjBFbxy56ZUJWupU5l1alwmFGcuRDSEnIHXKSFTAaGbRKMjgIF7HqMpQk+EiLBQBlX0gISQdEwJTRTwAaUo2iaiq7ZRdCuboqujxpCSY2vXcH1maBrHfH5K1jDPjk4JbQ7aWJQgB440DxMtEcNgBCkKEkL2qHU4M5gLSrRpSy3WNtLQcGWX/LkjklcK+eFQNU7FU2kc5C7EMPdw9QCZa9RvKaRKygw1c2UiBUHcXDwkoMrkzGRMxSUxs8FpqGJ5BrEYUcIWHQ49fWBvH88fE73q3A49trWF86mnhju4FtiqD46qYQgnSEnUEIFJMegA1R4rNSwMaCRcHOJKSuAtRmZFhoE5R6c9BIwyJYhRBwyfaUFfTzQBFOgQahcv8cvNcoZzvFLAgKfYBhEGlknbSm61WOUVHAkCReIGxFI/hWAgxb4tsLs6xtV+H5dWN3H5aBfPdtdwbXUTx90xehlQWKNfawY0qG6YQLWXiaEbamlyu/Wp2dugieAmYEsQtziWyTGQofCAUs0ymAUNC7byFtJRwuJjBdc/4Ljx/iUOPjnAbsxgpQW3LZp2G4pSyXgdJ99NvVAnHC/ONP6yiOYMmGMLh//4P+DCVgN+y2M47HbBTSCSThqr4ItAWsfcc3VE8dobaFVjVRUOMopGI5WUOu+ROVK8hAouIxDVSEqqNkvGBH2MzqZacTUxiDTSGfHaaKh2EJELEdgjyws3CPWcyBfdgX/qxq/hm/7c2+zg2X3/hf/9w97c/6iZLRy5M3cxQrZaDQyPu9HLanRoYCowK0i1IoMNoah7VAoL9yDvwdLDdIDUKiIwkMgA9XUztHtBouiEQVZ0Zmi0Gn+mWsybhKKO9jjSv7SuDAY2zetcwod+wYF3AJ8C8ASA5eC4fgU4dx9h2RjmAI4yoQXAK4IVAjcEHhRdiro3CYEUSAYMIIWRoMqxFokW/+l5nH/N47hSXojiHouLh9LMAE8Oc3WXpGEoU9w4yrBGyiasqsyqTsJkksiFnCSKLMaJnAtF6ymbM5jJXKNP3pxIMikJdvueDq7s4RNyQA/PmR67J+GBrS2cb4laKIQKyArYlBIorIqZINRChCFZp658rhOWZYhoYgjDwTqhqICcK1kqYOK43hvXiCvm6ZEzIAEsmtsYreGhw6FJNV3q8LwgiAWEJABDkCDVbSehN+Co9DjQY1wfDnCjO8Tl430829/A3mof+8sjrGTAcVnCKK76WQSyLWhJMAtZdzhbU0SJpRLfURWPKhqIIO51uEakk2TVeSRGSYaNMrySj4y03QBg9FcTFh9LeOE3Bux+aImj5xS6n0C6jWbO4K2oEqoZBtVqanfSD+x2XU4nWheq5IPra7s8QLCNvZ/+FVw4/1Vov/RedIsDNI7wxuIaoUqJoR3gKlOInmDUbteQQnDsn8p/CRwsjuw1GiJHdkOuwzUyhe1MJocgoioWQtLKe4mNEdT0N41p/0bFMFJDgxC5cJRG6gR3F3e4Dy4M3zu4govyy/Ynvv/32LXL+/jwv9m1fP8FL1hp9Le1Jm5mgDptmu1tiDtpEnxG1U9rlZDQQ1H5KAwgnSqFAHoi76E+Ph6UZFgDlxW4KpJpOENmRRkUqY3IatYYltmwraG72qgMomniB9nZccJ7ILj6DsLRUezdB/cZy4HOTA3bgXHUJUgR9I1AioDSVDkEaUKvGYWDiM+W5EgbefAgP/Y9X90831xLutJsTG0SJJGciSkzUQNYJkZi9UwomYwzB7eYiJGEIGKUCCbMLAKLggqIiVQSg2N4vTMJSMiD02SCqFMTFjNsrOjJYUNH2To6lwUPz5M/PGN6eGdO92+1uCevPIOoqf0OyRyi9Qpa53SlqqUCKcQTJJK2aWAq11FQ0ckU0RJbTMoZ6RAXgJGQwGAKzkkcaMZ8hBmIK0WkOBYil6NScNgPuDEc4drxHq6VDpfLMfYW+zjSFY69w1IjanI2ZGEkSgGyU/NHHKnsCDPIqU/JoEJwV5j5ieBFR4saC77MAXgq4dhQEENREpDSDA3m4BVjcb3B3kcLLv/qCjc/1OH4eQCLBpgxZJ7AnEMYYlZ7hSlGBKyNpjd0uIwXHSeyaWvtgFDCICW+9aLAHxhw33d+DfafyCgH+0jKKE1Te2RqV0r0hoXqvXJUlBjOBhFCIoBkdIKoURQcTUwcQEZo3RIIiawCdyXTayLPiIQlV1lXqgU8hk0yL6kEPhOc2JBcvaaDJCDnaBHxxtnNVuAkbubu6P01D7/B+Oqr/b3f9H/Y1edab3bOWecLI88myqpSau5Ja/6KIhJy0AChQuABRKWmhGMbTr9uzfFIEZ2LwEPqIDKAfFB4EOslD0hWAcsKmhR/dVBoUmgpyOnsVLAVx7Vtw3zu2NlxPPQLFbAATKD1xJJw2BP2VowHHqZJ5rCsVcNFL2iUwY1gOSQkZXQpKoYkCUUToAngDLIkhbPuXsn3f+sbm9k3vSZdeuaTjezMshJnJs7BX3l29wZkCYYk4hkFAWARUCQiFwGLEISIhFAkuUv01hgzuQgzESkTOQkRE5QjuXWOLvkY6UcgYiiFW6aSegdRw5xB24lwITse2t7Cg/MWF1rBva3gfMrYIkUjNRWEI7MiBQpCnEG1oR8apCvVpFDqVTsSxNGLq93IZQQKRlFFUcVCOyxKwWEZcFAGHJYlDroVbpQe+8MSh6sFjkqHjjQkAoKIepiQkoTXPY+iMR5no63HZaKq3scJEaZ1uEL0RHptcvQ6f3AECCOHudQBsgVqjlailptmW5hhjuFqi+NPEvY+MODyU8e48amC4QYBwwzctMBMgdbgxqChDmHYiKB06r98MbNYP9s2dpyGXQOlZIZsjGU986ksII8m7Hz3u3B0f49ycAjxBKUMsEJQUCbeCoBEVEQS3vFjSscwJI42msQeRWMGcoyrQKoEeijVOYCr6jcFwSuLhC4rjQAGrdwVYdSypiDvXaCVwFeHAykiPReOXyt5dOQQZy/eO7vZF7z8Sb/8vi37K//lP3Tv7jNtkqqqi4qqeCh/WcYhpxocFRV3L2AqxBiIpBiCy6ocVAmSzwdAhhC58SCQCcwUVoAUvBVV+YKpIqd4PLBhrgWlVgWP2TGfK9ojw1FryNmxc92CaA/uag1YfwWMD9f9vQlaIwH/gBIOL6xBK80FXWHIIOgagaiASsKQBNAALJIE1wy1BPS51a1c2sP82r/+znTtwnHe3d3Lud3OCs8wZFDJMGRmTkBJCZzXfCQS8ShvICGHCLuQe5DvAAvX6JkQnBaIiI0FRFTpMCcigZFU7R+REqooL1oJA2wKFOpKpAbRAUkcW0mwLQlb1GO7YezkFjtC2AJjlhhzkTrDbtThhBCQncAaQlKrfdO9xol+rIYFDAMGLLVgqQN6HdCZY6U9ejX0OsDYa9+hA0kgwjXe4sqVCMCKUsWdVM2gpuzJ2nU8NTqN1IrdSFwrNFK86jdOde7j6JM1zgQzcvSWQLOMtjHMLSEfncfxxQY3P7nEC0+tsPuBHocXLaYccwuaEaQRhDFpV3W2UsF7bFCScL6QMPMmTS8OUn67lHBzlaBocmnC2SJFUzR3CvnCHdz7Xe/EtfkBZG8Fl4QSJedozamOpNxECh8WzwqRahvnGtGSUHWecWQOuYKYo6nHE1Ml5KsKRjhSwwSFUFzMUgUjcoVUvouqkiKT+2T6wH1UBuMS53UdT1xcLEGQ3bAIzRXYoeZf9Iq32VP/Yul/7dv/L5X2EVP28F+kqpmgamDgVCBUAFen2g/IaWCmYu4lRlpTFYZyRE+CAeoDmEsAVo2s3AOwIu4e4KlEC4cWaFI0JaqDpVfMW8XyOKoMqy3F1q6NmqvTYIVaxDr7NrbrhB0/cCCOLXOsFgaZERoxWEfILbA0Qi4A180VidMhQqNAgwP25/7+L9trv/cb/Ig/7v3RwhmNCbEpRA29makmQA2sIM8wUyMqbJyckWAqTBAyEmcSd2JmiBmxkDPMmImZGURKMRWVQG4h1zQncqvGwRJhhHi4P5MqzEGZgUaiO95yAzXDoQP7g4ftytLB6EAWF6hxFKNx5azG4bY82cMHAVztkq3Oo85c1dHj2Sc0RWJNElASMHJECBPIaMwR4fEMNRRXYPCwYuYYI4XJXVSgtZctau9l7MiGm0eFTINDQx2fZqGgRMEApRLRmxGkacCNYKefY3mpxeEne3zmqQ5XP7KP/U87yp4C2iI1O0hZ4PdxdS0Nu38qFM6PtUYTkotxxGyZmsSpeqKdjVd8is+yTY79FhaeEN1fXQ4DRPJolZDZOehv7GHvx38RD37n23Ht3Ap8uEBChubqpJBrR0OqVuTMoUQfeatRvsARUQmHdUwiRRKuQ9Mj6kq01mIxOZLV7VBNCa161Y8ut3V7Y3VfGD4p3wEXWHVzc7DDE9VWZy6eCO5QZ2IzdX/62vvsbe/6Sv8T3/V2/Vvf++8sn3uVFT9WNNWnnVhBafRnD0uYVKUNZAUklc+SHuxByKO26YAHpHX7TaSBKVLFXFNApLCf6kttvymKQaL9JievZvfRMzjeWlnzVgDw0ENx/6dRIywAZ0ZZmwr4bqA1n1UY7Vakh6kIOhVIFgwmkRaagCPSSkVTSZwTcSrHN9ODX/ea/Oif/8r0kWefyv3eMrE0SQwZ8KxkyYCUAvkSzBKDE3NJRCKMIkwuxCJMJuTETCREzkzOAmIiY3IPRw8YiRsxEzmDWL1SyA4ipxBZGoWSUSHMxGQbfuw19Jr8zrRWhwjsXgVQPoqgI6retLut20AFprHxmat0og7YXeukqlsoidf5ACER4PFstFBnTs4M5KfOVp7+r0YsGFjhSPUj6JqT8mr6Nvm01cwQBmocObVoZAZ0DYabwN7zipsfILzw1ALHzwCLFwCsWlAzB2YAN+vxX1Maeacb85lFvju+8m62e8tr/BYLDXeD5Aba7WPnP3sUW3/ySVw7vopcADRh94ZcMZ41UrMEjAaTUiu0mVCBx0PaACATVe4puMtkJRTs5BXs4lhKAJKwy8RrrauLY1+18GjBq9WCS8Fwry09XmHfufpwM8PFOTxX2Y0puXa93TPb9i988O36I3/u39vP/N3PWPvIw9p7HxGWiLqLgoomIjVQMaLqHEoF4gFIXNNC9xqJTZXDUbsVqZ9UsBs5K0sFuSgsl1oR1DtKGFpxXMyO8+dtJNrH6CoACyD8lXoufRiEq++I+7fjswYlbA2Mo14wbDGawuiLQBrBUARigr4kSD4JWllSgNYL6WXf+EX50T/1jvTx559Kh5euppx2sjZNgiEBqwRBYnAyi1SQmQTkArYKWBAOTRYTEbO7kBMnciZyZjeK4kw07Qm4eirbdAFns2he94i4mALExlLzSIgIrU8jhk+RU7huOI0TYYJyKdUddT2EQmh9KlZPCjDWgvPxOdo4VZnXk2HG9522wafTH1v3IhoHuPFaKBpbyaGVgkK4A8wxIGOlBs4KaoAdyWgwh/QZ5VCw/6xi94OMGx/pcO0jSxxdF2ARZ7HMavNwBhSr8KnyfJvxQGcDk54cwXFXc27vBGzsJwQNLwJyHL183kAPb+CBb/58pD/+Rbi8eA7JDRCJFE6qiLPeR9VQpUqMSyXMhTUqhEzBTfEoCLWqt4rIKY8aKzASuQujVgljXcHIhdl07ERh0itgDWPBEgmjeF1DzU5hJCKJnGLWhROrZ2LruoU/dO8D+ih9iX33H/mX9tS/6zQ/eL8NPlTXBFJ2KEsFLPdSo66QOagXZCrhFW1r8JIKTBNgeUGqy0wVlgq0KHJS9L1h1hQMvSInwyob5ksNc74N3uratk0yhhGsfnp9YNwKWJtR1llVw74Qlj1jPjA6jUhrNUTFsLQMKRFpiQqQEoqmrUFS33AqZpLIUjm6mh561+vTG7/z96VPrD6dnn326YRlk7I0SUUDuLgIDIkZCSBhhlhygZMkhsBdmDwAC1aHABEzO7EXiuXOECMCh/W2eWg4DcSkNKZH1VB+4rHY1nZ848EzYUw9gEcr7CliwiYw2QadbieDCtto74FFCocpCKvOfie3wfX0pk2wm/aggX0k9KOAwxL2kMSCPDAchkIDFD2MgSQZTUtokECrHei1BouLjmsfW+LyhxWHHy04utJDj6swdb4T+uBssX0NIrmYrWkAorsIqtYfXDeAhJjvKlg6AVh3E2356Qhr89aBrUVWwWq4jIf+q7cgf8sTuHjwaTTaRlSESNnC52vqeQ7wQamPGSIa3BWFbEVgyKmmdojUMYCs1GUchL1YlUPUNJMt+C2eRir4eGw1DACDT+08NSWUaCN3IneKKzQSm0HJBMXF2Dt2g+3bYxcet/nl32l/4Q/9jD77fLK0c14LdWpiyp4V3ijIiwXXUcAUxpxcp+NABrBFBGWmEA6OKkk8H0Ml1gS7lagEihhcC1IylF7R5nGohIWEYW7IV/wW3grAKcDamBF8FmgBwEPXeEoNOyUMSti5wGeCVl8E2RhDjr+rkiEmEJc8SIIlGUgTyBL2D+X8k4/m3/l9Xy/XHtb08Q98OPW7R0kaEq8cJcSSQJKzCVjE2ATkzCCBmzAxg5w5nKwk5g44g7Qq3p2ZDeTCIeiL7lpXI+YxagJFNzwIZBVUKljo5OwVmqCqsYJVJ8nqFFnNYdZ4EwfUSZDZ4LMw8jZ8Knoan+cR7CJaGJen0+EEj9OhCpixAXEFA5ZgAcQYTZMxlwbiGVg1WOwRlp9SXP/YEtc/ZDj4JLB/cQAW8wiUtguE5+BaOTP0EahsWDjHr8Z1OkAlqNOtwHNbYGJ8FundXQKZbT7HEXG5nYz2vMDIACQkNRgO8Irv+V3ov/Y+7F2+AU5AqlVfZkOq9EBNA0CIVC+BQWzrHkLGVDFkxLg9SoyEggQF1eZlrsDWJAbBkKxWHaN6WIFJp+KKwJw5HEOEI7pC6LpiDpTBKdUpcW7OIHMUZxRzbd24Nx2O9A0Pf6lfff8D+h3f8q+s15cr50Z7Oja4BZcVwyJKkLSkkRp6TQ+5wFkhVVcVFlMaja5WYKLxOIeKPYmhDMFddStDThYke2O3VARrr+AoED0rujoJWKdB66zU8HSkNVYOR9DqCyMVwWCMoYnqYVHB3CQXEyyTDOwC0px0Jti/kfxRlzd8+7vTzte9QW4eXkyf+chHUr8cBJLEc1xwJJsoUwCWRwoImDARw4lZPIDLneHK7KBEHqIpcoqJ6PGXg4ACikfUVXMSRhnTrbA5Y6y5o6lKs46seJx8Uv+kiViv6V0Np8ZzlDdPIi7YhJeofqwJeEuxpVTT0RGf0hSG2QSMBoTpHwpKAnIKZfy9qQEXQ1llLK4wDp9m3Pxoh+sfXuHmcwWrawxfMcANKAFpDmBmgaOlqc3KgPHIcTE8bXBpI7FdyXKvVsB3HSN9zgFr/PVPAxYmZ4xbNxakv1hGo4rV+QN83ve/A+VNCYf7h4ipLYZ22j82zUbkkUQfo3AuaDieG2UNY/8fc2wqjdH3BqhNavh6PAQ41guixYGTyZzB4TzONeri4jw1ZsUXZCKLY9eM4ks7S29UyN2TSuqtdJ296eVvtV/6R41931/495q3Xm2Dd2HgFwdbABbXAahjlCVcwgqdC8Tq38pXmSqkglUShW9UA4c6TKL0odkYqnxhM7IaeaszqoKb0dVp1941YL0YCd8pTZzWZqQ1KKOZ8zrSUsGQg9cSE6gxSkooliAmiUXKqk9Y3JT7v/w18tpv/+o0e/MjcmPvBfnM88/K4c09gVkCQ3JuRWFiNBpLuYCMkzJDiI2DeA9O0pDd2cUZzgTW0aONRq8XRgnNuYNYqvUnlJip9is58ZlgtfGXKv+1CWLjlJtk4zl05rkZ8ckIXFwjJNtI+dZghxLDERLK+j1S1Xw0CQkJyRJsZeh3DYvPMBbPAHtP99j7WI+Dyz3KUQrFPHO0FiWGpXhcbDXpNLlGl4V5TYxb9davgLWO9ey2RPodl90Jr+6UHt4uDWSu7hen+KvxQmHjxeQkz5Uq2Nq4gxc98MQRvvCHfzfKQ4y9xQEMhhmAVFCrsBt6G6tRJZdYhurCwLFPU91nKdK0SrhHOt0AzmzIjIliGNcFTxVGT9NF0SAc1m9BVZSYKkjkCebEdZBXbNfgVuui6mK9s2dFghF3lgF7031fZf/nT9zQH/lrH/bZzsu196LmFpzWCFg2RlkjQLHCpYBVw314g69iNlgJwNoEq5GzarNNkdVpsDqLtzoDrG4FrLNSQ7wHuHr19qC1exQFqbySE5FWXwTFGKkRFGWUymuJCYoleCaQJYjIXF2G/X0pTUqPffUb5cFvfJ3c/8Uvlyv9vly6elkOb94QPVyKkjPUJGdidRMkIZCxgYSLMoSIiUnIWd1ZhGlgA3sJfjI8r8MXC0xgc4BjOSyKfmwIKoCcTallmXQwxkOMa1IG3GjiGjBWf2olzuJKGSfDqJoagBTvUe0VomzN2HhfhOeWnQQuZAYnIDdAgxapT5Blht4E9i8f4Pi5guNPAIefWmL/0z36/RTNETmGKnBicMtTJfA00JjUBuaah9p0pvP0ETZRxm4LGuGHdVcYk/ilBFEvGpStf1Y7lSJOX7pGSNjYL2MEFhEkJwaWBefexHj9D38prs6OYYsOWQvY5rA8RATFEe1kHtve4r0z6xQ9ZUH1zyjT8ZHqNSD4jgLh8Chntvp6gEyJknlCzBRlBoRtPUyHYIIClABFSvAEc8UAYTLSaYSTOczJ1UTIzDXSkgybZVHxxl6/82X2Q9/1afupv33dmvvv1T4PCs6RKzOpmKk2lauyRitvpRDW7FYGIsfKCrZFJ3Jdk07VwDENvB1ndXeR1S2AhduC1lnp4XJJeGWtHA5KuO9Bmoh4NULuZYq0AqgYogJtArSSMQZNsACfGPXrklgEalL2DwTbSe5/86Py6O9/M+/8zteIPeRytb8qB7v7fLh7xHp4JLrqGOzMmRjkbOwMYmJyDmOoOtckgbjOUxcw8ag4EB1HlUYkJQIxpfV4+XqVg66ZD+GNiuF0tCNDkdVqI+1GV0kGWjWIVVSCbrzepvcZ+3mEAc4MpA5zmSNrBpeMcqDobnYYngUOPnOM5aUBB58eMFwDumsG6wBYjjOnBXg8W2LKaUUhrUONbkWAW6pvwi81K5s0RLcul7PXF3xOb1Ydi22UbtjG5zW7c5VR1/sgYRs2HOCed2S84b1vxQ19HliGLRCYJ2CJSKnqq2T9lVKVN0REFdzVKEnIMkbqqM3yFcjG1wrAbD4yCrkeLwmKSB9qGxWTC7Q6PBvYLbzbYdEqkGFJ1WN4Z28kUTmUDBPAUiM2KNmON/YKfIl+57f8R/tP/yaZvOweVR5UiEyZFLalYFZwF9FUKXViliikpn9jVFUkrKc0KVKyCaxW2dCcAisAZyrZbyXZbykd023FwncDWqeJ+EEJ3cCYF0ZXGMNWgFau0ZYaI9XUULKsQcsF5rxlSZxnMphx6RcCWbLc18r9b3lC7nv7EzJ/4/3cPHgPH+mCD46O+Obuden3D0kXx6zmzOThFZ+im1WICUmjuxWASvUnHsdOBvlKhkmMSVCZNEyAgjMmQWg01oxpn4fpkyK6G2qpezxtpZLnWg/mDK0ELjCrxTeGYMYZYhmsDFsNGG4a9DqwurLA/tMLdBcViysLrK4Y7CgDw5hjCjgzREJLpXlMhhRQAQ8ZGRldHk7i01lgdJd8konclbRqM6rizLfBq7O3pXfY/u3efaggNc5eHNFovKiYnQHMqqfCMJ4i2i3Zwmp3Fw//wQfwur/0eryweAGizQQ6Tf2kGaPzQuDyKD0QBKhhBKb6XIZWUShXmxnzXCUTuX7zUUMXUoqhyiYCiERCdxX3DeSjPgtuIGeJ58AwjsFnDldjgRPIhNUY8CRivat1Xa8v29qydOmL7L95z4fsuUvndHbhnK702NBQHXraGFgDoLQ1iCoKG1IFqoENOSmG3pDE0HXxd7M/cFO6sBlZbWqt7gKsTg/NuzNgbVYOT2u0AGAxMC7cv460+sKYlYh2xmir1+C21BiliWhLLUArOUNdsiUepBdI4qQipXfG4kAgheWhlu/9vEf5wpOPS/v6R4gfnbHcN6clrWTRL7lbLqhbHlM/dNSvjlmtJ+4zYShUO0orYGn1xgWk+vTKGJEQk0g9cdQgomeeOazRASgA0DRQ1GhZFJBICZCBuQpgggxB0zP6gwG6WkGuA3pDMdzo0V9SHF9aYXV1BT0QDNf7dWSkGZybAKZZPzIY65NQY/pPfOJqP8NNPQ95Sk3vFClFEMQvGvnYHdI0k81lcof3GZfL3emrXiIfzxNoR7S1iYJnbWsCuWlyVA/ugfmwjePlVbzyT70ar/wzr8WN42cx24DZZgOkBApUYp3rMSETEK3XCRuZ8bkqNK33I+gPYbLwxnYjAnMZpS11pFR2m6S/BK3+GeH5I2xWtA7vkfAjVKglgTnUG4cOJbk6rCudvWr7frv81Cv1z/+xj1gpj1nZbrSIKdqlobQG4wAsqd7ruQRQSa0CMjlmbUG3qhL9ZJPF8Tj15k5p4AhWt+GtbgdYZ7dk3U7ucFaktRjimNi5l1FqtGVOmBVGNwvJSFvTxKGClzlDG0Ya75tkyzxIJ9FVmxgskvqeU++8Wi4Zw4qx7Sz37PD5V95H6TX3UfPqhtuH76X5o/dyd0+DLhsXIj6UDp2tCNoRVAEtpFbvQxDLRw2BV7uFvsYAp87eCkaiYePdVE+r6SVLRbNUyBHQ7y+hRz2wq+j3e+BaD1wD+t0e/RHiuV42EKJBIwI0ApUe2HwKAq0XOdmIQlROxSy1zUYnAMMIqWeA0fqB3GV6dlb0IyK3PHf77cmZ29pcXe/wWURf/LPJBmDpHbdRfx+9NfJTKCBHmC/PY7m8hjd892vxyj/6IK7tXgtuuEa1ovFlmxGkZASZGoXVaGwEn0biDaUuJ1aX2i0/Rm3Nxm8o9cNlCVPQ8diLiAnOqkQCZ1fXSCmtYqeTk5mUAK1CTlIspxglSdHjbt2QjRxWfGWvvvCY/do/P2/f++c+brTzeYq2tcEOgkwfyCGiJ4Cq72NOaZMVzF4tYhQHAOarqAgeNSOZfsLm+ATBfndg5XfqGX3xSGuTiN8ELQBhAHiPTOkhAMwL43phbDthmPMEWr0KZk44MkbTRrQlJrDMSCuGOWdzHjpnJHAAmFOyxBic0Q9clkP4JPqSsZMI24nb8wk41zDu2SbcK4TzLWRHSOZCKQthWyBtwpgeQgAMhSZ9FBQFQOoAH5igCu3iX+kL0PXAokAPFbrogENAFoAuYjkOU/wt4wmR4ghM9UraNPWEaWs3Zx3XVg/oZjzsS/heoAgkvdhJruvlugkM6cwX3QmkTrxPkjsD1pkb09sA04sDFiSd2lJ5UcDS28CibjxTf9pop7wdYAkgWmqw2tf33EIv1/EV7/1iXPi6FhevX8G51GKzEbeZ+C+gQQEkvDhkYw/IxlcTKFqUqSkaUwQWjdBjFNVuXHLG6ClN0WpxiQbvmD5WU8Po2CJjlBi3CbglOLlaUwPR4jBBcXhSW2QvaTD2Yq9+9HH7qf+J7cd/8Ko1D3ye9bIwDIOhzA0yGNIQ4NSzoUmKJTuaKlcYo6p0uO4NPGoNW1sGPB/NzJGNfFaR1d0D1iZovRfAe+4AWgAmMn54kHCh0ARcfWFsG2FQhjqhzBlzowm43OnMiMucsztBk8B7Htwpp8zuTjDnDNAgiYoLJwehDBTT0ZZUAMLghFIIKNWgKAHR8UgoJYhq1Pa/VCZV1DinVuGEErzQNMs2AWGjGUCCkqAJkHFb9QROCRunG9Z9e3Xh5skiGyeqajkzPZN6otwt53MmuKT0WZPgeqfVU7rbTxDbusuPoWXjXZPc/jVFXxzASjn7a44vKCX243ixQAdBG/e3D/DOH3kS228Bru6/gPNlG0U1SPU4CELWUF+f6oWoLQCS1t7B9WdpMUoexs8Y90sCmhGcpNQoDtWCZu1gyChe02xPZQVJcEOKZT6miHD3iLIowWQYwSu6Z9lh1MMsx7JZhj2w/bj90Hcd2b/8Z+cNF+aG4dAgbOg4PIuapFguw3mQK1CtsoEPHG027EtMaT7dGzg2M5+uBr4EsLodYN0dmL3njDaes8j4wQjdvYzzShO3pUaYbwBXUUZrkT5q5bUaZ1hLMGPkACeYMzonJGc4KLuHxYCDh/hLSCmkGuNjOMU0zPr5fWoFjMF3Z36/Ml3Lbj2vysbScutTIeG85VUpzofb39LdLD57pTtt9rZAktYvTHfY3ubLy50+y10AVtrYQjmxiXT7b7jxo5XbvUc5ub/K+qpy6stsPFjd+tHLqr5qtvl8QUJCKSvMHjnCV//A2zB/M7DE0bTSHDMAJfRaqf6r33e28d1T2gC2CazK9LnT9H71fj1oUgKaREZloPFbSgWsaLKt91MAVh2s5oLiPhR3ZJc8OPdknuFtmBC5gszQuziZtGQG+H04b3/vJ8n/5vcc2Oz+R23V9wZexQSVjm0CqlWqgDWS6tlOABWwtogZgWpTwX4H6cKdln1uAGvktO4EWhfuX0dbRWnitswJgzHKLO7PnaaKojtBndE6QZsKThW83CmbM3KA02C1BdjHv1gDV3iF0Anezk99vxPgtb7yYTgNavmOJ2XB8CII8hJvafNufumAlV8iQt5hrXKHz3I3XznlF18/3fG3vcNteIlPlFvfswxl/ZudelkqAIYB5b5DPP7lD2H+8BzAEkCurx+QUar+bb3NfOI9hlt3y7B+v/H3aXgdSY0ghwJwu24xp3VPF5jX0RYGgIW8aBDuKZNhALwhY4UXgYuSs8CdyFjJi8Bt1pso+aKb2b/8p53vXb3fsLNjWK0csgpwSnKSVMcebomqTlcCXzwFvGuwejHA+s1FWgDw4DFPvNZmtKVKOG80AddQ+S11gm0RigZgzSp4eY28HGvAamoEZZkbAP0IWJEmYoCvoyk/DVJOY3F6DVQDwjBkfWDljeMJcby+NEy403l0lxgz3HadfPt18m8OI3O+3XfJLwkXh1NP5N/075Ix3OaVmwAwnPnccHJfjvt3uHUbw+124PiCxbj8Rb7F8Fl86Xzmen7qE5462ZtYlmsOEanjOs2i8XGdAj35HVHMKpwBoLmBuujA3toK/+bUGZgci9oc1jQKOQrzrjYbdgE01RrmdkB1Oqp68RTwTsvv8jJ79gZPAtk4zGK8LZeEi9UE8LHNFfcMxQhHRjh/IdLEsco2FMb2MiY8FHMMc4JxzJZqasq4jrICuKDo3QnZY4yjOQ9tG0DkXQDTmcB1mungjWW8Pr66je/Jn7vjMlbsNw7U5iW+Xu/uqeazQK/bqUPziQ2/5G0NDX6TN7uV5ervhovrQ792t9xdP5ytqxAgKwM7IwTy+qfoR0jpTx0bzR0wqb8VWKnx2/+05Og3WH6Cx0BmCfsP6quZfQBTjxYNVfO3vnfMZg7uHB05aOYdk4M6h2wHMLE6unNVvr8ysETq13BEUHzgaGvlb188/MKTI19zZPFb+KoRrDZvP/0iHkIv4jFEL+FoubtIazNNvHYt9mjfEx7bqCKO0VaxAKwRuMaIK+4ztiZgWv/zeURbANCMnbdOrUVE1U2gdIcIy53GGszZKeHmraOzT86Ng63Db8+tbX6rNnzy4W/V2/xWbLc/uen+Ltdfv+Al7LwOaNCjb2MjTdfc3Xu+lBuR3/ZHo95jX3VrAJuAq+5HIgc6gGYBRtM69TFvRcRFq/g7+id1YtgGsJKx38jAR16nuvoJngoA5jdjvSyOSxIR1mli/fYp4EtKAz9bwLrT+ieB6yoID8GnNHFMETfBawQuAFhWIl6dcN99mPRbagSzAKpSwWkTxNwJNq+2Amvwqqkh3ZoKbnJYZwBUU9frbncyfxbI1N0eFz6r9e4GcDY31rb4f/XWvuQnPosf9g67pgXa7i72XvfS93E7vaKLR93n4Gvd/szz2wPb5vwzOLACaO4zJl+taCPqqvd5ZdOyEbDqzLD4xzHpPYnjJoCcrR5LhnzN7whUdybWP2ug+mwB6+5B63aEfF/lDyNoAZgEp2PEpRdOclyo6eJ4fza22fv6eZ3xrUC1OdRuA8jODESdXiRQpc/2XPqtP/k/y42NJayNitm07P8nt9teblafw530udvUrSfu7BRIrc5YPpL0m+B0GqQ278tqDVKTHUT1Vj+o64wgJSOhfsOROVI/ACfAahOoNimiFyfWf1sA67cOuM6KuEaQOXfPSfDaBKxNkJpvgJg7YTHu4HHZfPwMt37ycR3MN7i423395efg+Jz/1pyl8/8PIcbst+nDrD4H+2X52/7Cu9+BtPLbrjOB0vJWwOIz7h+T4zw5jjiiqTEFHIELu0DziE381OmICsCZUdXtU0D/zQLVePt/AMWkcC6Ipk7UAAAAAElFTkSuQmCC";

  V.welcome = () => `
    <div class="welcome">
      <div class="w-bg" aria-hidden="true">
        <div class="w-grid"></div>
        <div class="w-orb w-orb-cyan"></div>
        <div class="w-orb w-orb-amber"></div>
        <div class="w-orb w-orb-lime"></div>
      </div>
      <div class="w-wrap">
        <div class="w-hero">
          <div class="w-mark">
            <span class="w-mark-glow" aria-hidden="true"></span>
            <img src="${R_MARK_SRC}" alt="REHOTEQ Field mark">
          </div>
          <div class="w-name">REHOTEQ <em>Field</em></div>
          <div class="w-tag">Diagnose it. Prove it. Get paid.</div>
          <div class="w-lead">
            Turn every site visit into tamper-evident photo proof, a signed PDF
            service report and a QR equipment passport your customer can verify
            on WhatsApp. Everything works offline, account or not.
          </div>
          <div class="w-metrics">
            <div><b>${DATA.TRADES.length}</b>Trades</div>
            <div><b>${DATA.LIBRARY.length}</b>Guides + AI</div>
            <div><b>PDF + QR</b>Stamped proof</div>
          </div>
        </div>
        <div class="w-side">
          <div class="w-card">
            <div class="w-eyebrow">What your customer receives</div>
            <b>Stamped A4 service report &amp; quotation</b>
            <p>GPS-stamped photos, dual signatures and a QR passport for every installation, locked by a SHA-256 hash chain.</p>
            <div class="w-pills"><span>Signed PDF</span><span>QR passport</span><span>RF-2026-00184</span></div>
          </div>
          <div class="w-actions">
            <button class="btn solid-w" onclick="ACT.signIn()">${ICON('log-in', 17)} Get started free</button>
            <button class="btn outline-w" onclick="ACT.enterApp()">Try it first, no account</button>
            <button class="w-link" onclick="ACT.signIn()">Already have an account? Sign in</button>
            <div class="w-fine">Every new account starts a 14-day Pro trial.<br>Pro ${money(DATA.PLANS.pro.price)}/month after · your work stays on this device either way.</div>
          </div>
        </div>
      </div>
    </div>`;

  V.boot = () => {
    const u = S.user || S.draftProfile || {};
    const isEditing = Boolean(S.user && S.user.name);
    const mode = S.onboardMode || 'individual';
    const showLogin = mode === 'login' && !isEditing;
    const showDocFields = Boolean(S.user || mode === 'company');
    const logoObj = (S.user && S.user.logo) || (S.draftProfile && S.draftProfile.logo) || null;
    return `
    <div class="pad" style="padding-top:${isEditing ? '24px' : '18px'}">
      ${!isEditing ? `
        <div class="hero-land">
          <div class="eyebrow">${ICON('shield-check', 12)} Field Engineering OS · Works Offline</div>
          <div class="h-top">
            <div class="h-sq">R</div>
            <div>
              <div class="h-title">REHOTEQ Field</div>
              <div class="h-tag">Diagnose it. Prove it. Get paid.</div>
            </div>
          </div>
          <div class="h-lead">
            Built for electrical, solar, security, networking, building services, automation and EV technicians.
            Turn every site visit into tamper-evident photo proof, a signed PDF service report,
            a quotation, and a QR equipment passport on WhatsApp.
          </div>
          <div class="land-metrics">
            <div><b>${DATA.TRADES.length} Trades</b><span>Engineering &amp; MEP teams</span></div>
            <div><b>${DATA.LIBRARY.length} Guides + AI</b><span>Grounded fault cards</span></div>
            <div><b>PDF + QR</b><span>Stamped for WhatsApp</span></div>
          </div>
          <div class="hero-actions">
            <button class="btn-hero solid" onclick="ACT.loadDemo()">${ICON('play', 14)} See a live PDF report</button>
            <button class="btn-hero translucent" onclick="ACT.go('library')">${ICON('book-open', 14)} Browse ${DATA.LIBRARY.length} guides</button>
          </div>
        </div>

        <div class="land-preview">
          <div class="lp-hdr">
            <div>
              <div style="font-size:9.5px;font-weight:800;letter-spacing:.08em;color:var(--primary);text-transform:uppercase">
                What your customer receives
              </div>
              <div style="font-size:13.5px;font-weight:800;color:var(--ink);margin-top:2px">
                Stamped A4 Service Report &amp; Quotation PDF
              </div>
            </div>
            <span class="tag code">RF-2026-00184</span>
          </div>
          <div style="font-size:11.5px;color:var(--muted);line-height:1.5">
            Every photo is compressed to ≤ 350 KB with date, GPS coordinates, and your name burned into the pixels — locked by dual signatures and a SHA-256 hash chain.
          </div>
          <div class="lp-pills">
            <span class="lp-pill">${ICON('camera', 12)} GPS + Time Stamped</span>
            <span class="lp-pill">${ICON('lock', 12)} Dual Signatures</span>
            <span class="lp-pill">${ICON('brain', 12)} Safety-First AI</span>
            <span class="lp-pill">${ICON('qr-code', 12)} QR Solar Passport</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;padding-top:9px;border-top:1px solid var(--line)">
            ${DATA.TRADES.map(t => `<span class="chip grey" style="margin:0;font-size:10.5px;padding:4px 8px">${tradeIcon(t.id, 13)} ${esc(t.name)}</span>`).join('')}
          </div>
        </div>

        <div class="sec" style="margin-top:4px">How are you starting today?</div>
        <div class="role-tabs">
          <button class="role-tab ${mode === 'individual' ? 'on' : ''}" onclick="ACT.setOnboardMode('individual')">
            <div class="rt-top">${ICON('user', 18)} ${mode === 'individual' ? ICON('check', 15) : ''}</div>
            <div class="rt-t">Individual Technician</div>
            <div class="rt-d">Solo engineer or freelancer · your name &amp; brand on every PDF</div>
          </button>
          <button class="role-tab ${mode === 'company' ? 'on' : ''}" onclick="ACT.setOnboardMode('company')">
            <div class="rt-top">${ICON('building-2', 18)} ${mode === 'company' ? ICON('check', 15) : ''}</div>
            <div class="rt-t">As a Company / Crew</div>
            <div class="rt-d">Engineering firm · company stamp, 5-seat crew &amp; job dispatch</div>
          </button>
          <button class="role-tab ${showLogin ? 'on' : ''}" onclick="ACT.loginSaved()">
            <div class="rt-top">${ICON('log-in', 18)} ${showLogin ? ICON('check', 15) : ''}</div>
            <div class="rt-t">Log in / Worker</div>
            <div class="rt-d">Return to a saved profile or enter a company code</div>
          </button>
        </div>` : `
        <div class="center" style="margin-bottom:22px">
          <div style="width:56px;height:56px;border-radius:17px;margin:0 auto 10px;
            background:linear-gradient(145deg,#0E7C5A,#0A5C42);display:grid;place-items:center;
            box-shadow:0 12px 28px rgba(14,124,90,.28)">
            <span style="font-size:23px;font-weight:800;color:#fff">R</span></div>
          <div style="font-size:21px;font-weight:800;letter-spacing:-.03em">REHOTEQ <span style="color:#0E7C5A">Field</span></div>
          <div style="font-size:12px;color:#64748B;margin-top:4px">Edit your technician &amp; business profile</div>
        </div>`}

      ${showLogin ? loginPanel() : `
      <div class="card" style="margin-bottom:12px">
        <div class="ch">${mode === 'company' ? 'Company &amp; lead details' : 'Technician profile'}</div>
        <div class="cb">
          <div class="field"><label class="fl">${mode === 'company' ? 'Your name (owner / lead)' : 'Your name'}</label>
            <input id="iName" placeholder="Toye Adewale" value="${esc(u.name || '')}"></div>
          <div class="field"><label class="fl">Phone / WhatsApp</label>
            <input id="iPhone" inputmode="tel" placeholder="0803 000 0000" value="${esc(u.phone || '')}"></div>
          <div class="field"><label class="fl">Main trade</label>
            <select id="iTrade">${DATA.TRADES.map(t =>
              `<option value="${t.id}" ${(u.trade === t.id) || (!u.trade && t.id === 'solar') ? 'selected' : ''}>${t.name}</option>`
            ).join('')}</select></div>
          <div class="field" style="${!showDocFields ? '' : 'margin-bottom:0'}">
            <label class="fl">${mode === 'company' ? 'Company name (printed on all crew PDFs)' : 'Business name (optional)'}</label>
            <input id="iCompany" placeholder="REHOTEQ Technologies" value="${esc(u.company || '')}"></div>
          ${!showDocFields ? `
            <div class="field" style="margin-bottom:0"><label class="fl">Email (optional)</label>
              <input id="iEmail" inputmode="email" placeholder="hello@rehoteq.com" value="${esc(u.email || '')}"></div>` : ''}
        </div>
      </div>

      ${showDocFields ? `
        <div class="sec" style="margin:14px 0 6px">Printed on every document</div>
        <div class="card" style="margin-bottom:12px"><div class="cb">
          <div class="field"><label class="fl">Business address</label>
            <input id="iAddress" placeholder="12 Sapele Road, Benin City" value="${esc(u.address || '')}"></div>
          <div class="field"><label class="fl">Email (optional)</label>
            <input id="iEmail" inputmode="email" placeholder="hello@rehoteq.com" value="${esc(u.email || '')}"></div>
          <div class="field"><label class="fl">Bank details (printed on quotations)</label>
            <input id="iBank" placeholder="GTBank · 0123456789 · REHOTEQ Technologies" value="${esc(u.bank || '')}"></div>
          <div class="field"><label class="fl">About your business (printed on quotations)</label>
            <textarea id="iBio" maxlength="300" rows="3"
              placeholder="We design, install and maintain solar and inverter systems across Ondo State — 8 years, 400+ installations."
              >${esc(u.bio || '')}</textarea>
            <div class="hintline">Two or three lines. It goes on every quotation you send.</div></div>
          <div class="field" style="margin-bottom:0"><label class="fl">Logo</label>
            ${logoObj ? `
              <div style="display:flex;align-items:center;gap:10px">
                <img src="${esc(logoObj.dataUrl)}" alt=""
                  style="width:52px;height:52px;object-fit:contain;background:#F1F5F9;border-radius:10px">
                <div style="flex:1;font-size:11.5px;color:var(--muted);line-height:1.5">
                  Appears on every report and quotation.</div>
              </div>
              <div class="btnrow" style="margin-top:10px">
                <button class="btn ghost sm" style="flex:1" onclick="ACT.pickLogo()">Replace</button>
                <button class="btn ghost sm" style="flex:1" onclick="ACT.removeLogo()">Remove</button>
              </div>` : `
              <button class="btn ghost sm" style="width:100%" onclick="ACT.pickLogo()">＋ Add your logo</button>
              <div class="hintline">A square image looks best. It is resized to 256 px
                and travels inside your backup.</div>`}
          </div>
        </div></div>` : ''}

      <button class="btn primary" style="margin-top:6px" onclick="ACT.saveProfile()">
        ${isEditing ? 'Save profile' : mode === 'company' ? 'Start as a Company' : 'Start as Individual Technician'}
      </button>
      ${!isEditing ? `
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.openTeamJoin()">
          ${ICON('inbox', 15)} Joining a crew? Import your invite file
        </button>` : ''}
      <div class="center" style="font-size:10.5px;color:#94A3B8;margin-top:14px;line-height:1.6">
        No account needed. Everything is stored on this device until you choose to sync.
      </div>`}
    </div>`;
  };

  V.home = () => {
    const plan = (S.user && S.user.plan) || 'free';
    const owner = isOwnerAccount();
    // Company work is covered by the crew's subscription, so it never
    // burns the technician's own free reports.
    const used = Math.max(0, Number((S.usageLedger && S.usageLedger.used) || 0));
    const limit = (!owner && plan === 'free') ? MAX_FREE_REPORTS : -1;
    const pct = limit < 0 ? 0 : Math.min(100, (used / limit) * 100);
    const cont = S.jobs.filter(j => !j.lockedAt && j.status !== 'sent').slice(0, 2);
    const meterText = owner
      ? 'Owner — all plans unlocked (' + plan.toUpperCase() + ')'
      : plan === 'business'
        ? 'Business — unlimited reports & crew'
        : plan === 'pro'
          ? 'Pro — unlimited reports'
          : used + ' of 3 free reports used';
    return `
      <div class="pad">
        <button class="btn primary" style="padding:18px;font-size:16px" onclick="ACT.startJob()">▶&nbsp; START A JOB</button>
        <div class="sec">What are you working on?</div>
        <div class="grid2">
          ${DATA.TRADES.map(t => `<button class="tile ${S.trade === t.id ? 'on' : ''}" onclick="ACT.setTrade('${t.id}')">
            <span class="ic">${tradeIcon(t.id, 22)}</span><span class="t">${t.name}</span><span class="d">${t.desc}</span></button>`).join('')}
        </div>
        ${cont.length ? `<div class="sec">Continue</div><div class="card">${cont.map(j => `
          <div class="rowitem" onclick="ACT.openJob('${j.id}')">
            <div class="dotg"></div>
            <div><div class="jt">${esc(j.jobType || 'Job card')}${j.customer && j.customer.name ? ' — ' + esc(j.customer.name) : ''}</div>
              <div class="js">${esc(j.site.address || 'No location')} · ${dstr(j.startedAt)}</div></div>
          </div>`).join('')}</div>` : ''}
        <div class="meter" onclick="ACT.goPlan()">
          <div>${ICON('file-text', 20)}</div>
          <div class="lab"><b>${esc(meterText)}</b>
            <div class="bar"><i style="width:${pct}%"></i></div></div>
          <div style="color:#94A3B8">›</div>
        </div>
        ${needsBackup() ? `<div class="warnbox" style="margin-bottom:4px">
          <div class="wh">${ICON('alert-triangle', 14)} Back up your work</div>
          <div class="wt">${S.jobs.length} job cards live only on this phone.
            Settings → <b>Send backup</b> takes ten seconds.</div>
          <button class="btn primary sm" style="margin-top:10px" onclick="ACT.shareBackup()">
            ${ICON('upload', 15)} Back up now</button></div>` : ''}
        <div class="sec">Quick actions</div>
        <div class="grid2">
          <button class="tile" onclick="ACT.go('library')"><span class="ic">${ICON('book-open', 22)}</span><span class="t">Troubleshooting</span>
            <span class="d">${DATA.LIBRARY.length} guides · offline</span></button>
          <button class="tile" onclick="ACT.go('jobs')"><span class="ic">${ICON('clipboard-list', 22)}</span><span class="t">My jobs</span>
            <span class="d">${S.jobs.length} job cards</span></button>
          <button class="tile" onclick="ACT.go('passport')"><span class="ic">${ICON('qr-code', 22)}</span><span class="t">Solar passport</span>
            <span class="d">QR · warranty</span></button>
          <button class="tile" onclick="ACT.go('settings')"><span class="ic">${ICON('settings-2', 22)}</span><span class="t">Settings</span>
            <span class="d">Branding · plan</span></button>
        </div>
      </div>`;
  };

  V.actions = () => `
    <div class="pad">
      <div class="sec" style="margin-top:2px">What do you need?</div>
      <div class="grid2">
        <button class="tile" onclick="ACT.startJob()"><span class="ic">${ICON('clipboard-list', 22)}</span><span class="t">New job card</span>
          <span class="d">Fault → work → report</span></button>
        <button class="tile" onclick="ACT.go('library')"><span class="ic">${ICON('wrench', 22)}</span><span class="t">Troubleshooting</span>
          <span class="d">Step-by-step fixes</span></button>
        <button class="tile" onclick="ACT.go('jobs')"><span class="ic">${ICON('search', 22)}</span><span class="t">Find a job</span>
          <span class="d">History &amp; drafts</span></button>
        <button class="tile" onclick="ACT.go('passport')"><span class="ic">${ICON('qr-code', 22)}</span><span class="t">Solar passport</span>
          <span class="d">QR + warranty</span></button>
        <button class="tile locked" onclick="ACT.toast('Equipment ID','Ships in V2 — point the camera, get the model')">
          <span class="lock">V2</span><span class="ic">${ICON('scan-line', 22)}</span><span class="t">Identify equipment</span><span class="d">From a photo</span></button>
        <button class="tile" onclick="ACT.openDiagnose()">
          <span class="ic">${ICON('brain', 22)}</span><span class="t">Diagnose a fault</span><span class="d">AI-ranked · online</span></button>
        <button class="tile locked" onclick="ACT.toast('Voice copilot','Ships in V4 — speak, get a finished job card')">
          <span class="lock">V4</span><span class="ic">${ICON('mic', 22)}</span><span class="t">Ask by voice</span><span class="d">Hands-free</span></button>
        <button class="tile" onclick="ACT.go('settings')"><span class="ic">${ICON('settings-2', 22)}</span><span class="t">Settings</span>
          <span class="d">Profile · plan</span></button>
      </div>
      <div class="banner b-ok" style="margin-top:14px">
        <b>Working on ${tradeIcon(S.trade,15)} ${esc(tradeName(S.trade))}.</b> Checklists and troubleshooting are filtered to this trade.
        Change it on the home screen.
      </div>
    </div>`;

  V.diagnose = () => {
    const d = S.diag || { trade: S.trade || 'solar', fault: '', code: '', equipment: '', busy: false, result: null };
    const r = d.result;
    return `
      <div class="pad">
        ${!S.online ? `
          <div class="warnbox">
            <div class="wh">${ICON('cloud-off', 14)} Offline — AI diagnosis needs a connection</div>
            <div class="wt">AI fault ranking runs through the REHOTEQ server proxy so the API key never ships on a phone. While offline, use the curated troubleshooting library below — it works with no signal.</div>
            <button class="btn ghost sm" style="margin-top:10px" onclick="ACT.go('library')">
              ${ICON('book-open', 15)} Open offline troubleshooting library</button>
          </div>` : `
          <div class="banner b-ok">
            <b>${ICON('cloud', 14)} Online-only · Grounded in verified REHOTEQ guides.</b>
            Nothing enters your job card until you confirm a cause. If the library has no verified entry for this fault, it says so — it never guesses.
          </div>`}
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Fault details</div>
          <div class="cb">
            <div class="field"><label class="fl">Trade</label>
              <select id="dTrade" onchange="ACT.setDiag('trade',this.value)">
                ${DATA.TRADES.map(t =>
                  `<option value="${t.id}" ${(d.trade || S.trade) === t.id ? 'selected' : ''}>${t.name}</option>`
                ).join('')}
              </select></div>
            <div class="field"><label class="fl">Fault code or equipment (optional)</label>
              <input id="dCode" placeholder="E03 · SMS-II 6.2K" value="${esc(d.code || '')}"
                oninput="ACT.setDiag('code',this.value)"></div>
            <div class="field" style="margin-bottom:10px"><label class="fl">What is happening on site?</label>
              <div class="fieldwrap">
                <textarea id="dFault" rows="3" placeholder="Inverter shuts down when the fridge or borehole pump starts. Battery reads 51 V open circuit."
                  oninput="ACT.setDiag('fault',this.value)">${esc(d.fault || '')}</textarea>
                <button class="mic" onclick="ACT.voiceDiag(this)" title="Dictate">${ICON('mic', 16)}</button>
              </div></div>
            <div class="btnrow">
              ${r ? `<button class="btn ghost sm" style="flex:1" onclick="ACT.clearDiag()">Clear</button>` : ''}
              <button class="btn primary sm" style="flex:2" onclick="ACT.runDiagnose()" ${!S.online || d.busy ? 'disabled' : ''}>
                ${ICON('brain', 15)} ${d.busy ? 'Diagnosing…' : 'Diagnose fault'}</button>
            </div>
          </div>
        </div>
        ${r && r.status === 'refused' ? `
          <div class="warnbox">
            <div class="wh">${ICON('alert-triangle', 14)} Out of scope — ${esc(r.specialist)}</div>
            <div class="wt">${esc((r.safety && r.safety[0]) || '')}</div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">What to tell your customer</div>
            <div class="cb">
              <div style="font-size:13px;font-weight:680;line-height:1.45;margin-bottom:6px">${esc(r.message)}</div>
              <div style="font-size:12.5px;color:var(--muted);line-height:1.55">${esc(r.tellCustomer)}</div>
            </div>
          </div>` : ''}
        ${r && r.status === 'no_match' ? `
          <div class="warnbox">
            <div class="wh">${ICON('alert-triangle', 14)} Safety first</div>
            <div class="wt">${esc((r.safety && r.safety[0]) || DIAG_SAFETY[d.trade || 'solar'])}</div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">No verified entry in the library</div>
            <div class="cb">
              <div style="font-size:13.5px;font-weight:700;line-height:1.4;margin-bottom:6px">
                ${esc(r.message)}
              </div>
              <div style="font-size:12px;color:var(--muted);line-height:1.55;margin-bottom:10px">
                REHOTEQ Field only ranks causes from faults seen and verified on real jobs. Safe baseline checks before you proceed:
              </div>
              ${(r.checks || []).map((c, i) => `<div class="step"><div class="sn">${i + 1}</div><div>${esc(c)}</div></div>`).join('')}
              <div class="btnrow" style="margin-top:12px">
                <button class="btn ghost sm" style="flex:1" onclick="ACT.go('library')">${ICON('book-open', 14)} Browse library</button>
                <button class="btn primary sm" style="flex:1" onclick="ACT.startJob()">${ICON('clipboard-list', 14)} Blank job card</button>
              </div>
            </div>
          </div>` : ''}
        ${r && r.status === 'diagnosed' ? `
          <div class="warnbox">
            <div class="wh">${ICON('alert-triangle', 14)} Safety first</div>
            <div class="wt">${(r.safety || []).map(s => `<div style="margin-bottom:6px">${esc(s)}</div>`).join('')}</div>
          </div>
          ${r.escalate_to_human ? `
            <div class="warnbox">
              <div class="wh">${ICON('alert-triangle', 14)} Stop and escalate if unsafe</div>
              <div class="wt">High-risk condition flagged. Do not re-energise until the fault is physically cleared and verified with a meter.</div>
            </div>` : ''}
          <div class="card" style="margin-bottom:12px">
            <div class="ch">Ranked causes <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#0E7C5A">
              ${r.possible_causes.length} verified · ${Math.round((r.confidence || 0.85) * 100)}% match</span></div>
            <div class="cb">
              <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
                Matched guide: <b>${esc(r.symptom || r.matched_guide_id)}</b>${r.code ? ' · code ' + esc(r.code) : ''}
                ${r.fallback ? ' · local verified fallback' : ' · ranked by AI proxy'}
              </div>
              ${r.possible_causes.map((c, i) => `
                <div class="cause" style="flex-direction:column;gap:6px;padding:11px 0">
                  <div style="display:flex;gap:10px;align-items:flex-start">
                    <div class="n">${i + 1}</div>
                    <div style="flex:1"><div class="c1">${esc(c.t)}</div><div class="c2">${esc(c.d)}</div></div>
                    <span class="prob ${c.p === 'HIGH' ? '' : 'med'}">${esc(c.p)}</span>
                  </div>
                  <button class="btn ghost sm" style="margin-top:4px" onclick="ACT.confirmCause(${i})">
                    ${ICON('check', 14)} Confirm cause — use on job card</button>
                </div>`).join('')}
            </div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">Check in this order</div>
            <div class="cb">
              ${(r.checks || []).map((c, i) => `<div class="step"><div class="sn">${i + 1}</div><div>${esc(c)}</div></div>`).join('')}
            </div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">Parts typically needed</div>
            <div class="cb">
              ${(r.parts || []).map(p => `<div class="matrow"><span>${esc(p.d)}</span>
                <span class="p">${p.price ? money(p.price) : '—'}</span></div>`).join('')}
            </div>
          </div>
          <div class="center" style="font-size:10.5px;color:#94A3B8;line-height:1.6;padding-bottom:10px">
            Nothing enters your job card until you tap <b>Confirm cause</b> on the cause you verified on site.
          </div>` : ''}
      </div>`;
  };

  V.library = () => {
    const q = (S.search || '').toLowerCase();
    const list = DATA.LIBRARY.filter(e => {
      if (S.trade && e.trade !== S.trade) return false;
      if (!q) return true;
      return (e.symptom + ' ' + e.cat + ' ' + e.code + ' ' + e.causes.map(c => c.t).join(' ')).toLowerCase().includes(q);
    });
    return `
      <div class="pad">
        <div class="searchbox"><span class="si">${ICON('search',16)}</span>
          <input id="iSearch" placeholder="Search faults, codes, equipment…" value="${esc(S.search)}"
            oninput="ACT.search(this.value)"></div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
          ${list.length} guides · ${esc(tradeName(S.trade))} · curated from real jobs, works offline
        </div>
        ${list.map(e => `
          <div class="libcard" onclick="ACT.openLib('${e.id}')">
            <div class="lt">${esc(e.symptom)}</div>
            <div class="lm">
              ${e.code ? `<span class="tag code">${esc(e.code)}</span>` : ''}
              <span class="tag">${esc(e.cat)}</span>
              <span class="tag ${e.freq === 'high' ? 'hi' : ''}">${e.freq === 'high' ? 'Common' : 'Occasional'}</span>
              <span>${e.causes.length} causes</span>
            </div>
          </div>`).join('')}
        ${!list.length ? `<div class="empty"><div class="ei">${ICON('search', 26)}</div><div class="et">Nothing here yet</div>
          <div class="ed">This library grows from real REHOTEQ jobs. Add what you see on site.</div></div>` : ''}
      </div>`;
  };

  V.libdetail = () => {
    const e = S.libEntry; if (!e) return '';
    return `
      <div class="pad">
        <div class="card" style="margin-bottom:12px"><div class="cb">
          <div style="font-size:15px;font-weight:720;line-height:1.35">${esc(e.symptom)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:5px">
            ${esc(e.cat)} ${e.code ? '· code ' + esc(e.code) : ''} · ${esc(e.source)}
          </div>
          <button class="btn primary sm" style="margin-top:11px" onclick="ACT.jobFromLib()">${ICON('clipboard-list', 15)} Start a job card from this</button>
        </div></div>
        <div class="warnbox"><div class="wh">${ICON('alert-triangle', 14)} Safety first</div><div class="wt">${esc(e.safety)}</div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Possible issue <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#0E7C5A">${e.causes.length} found</span></div>
          <div class="cb">
            ${e.causes.map((c, i) => `<div class="cause">
              <div class="n">${i + 1}</div>
              <div style="flex:1"><div class="c1">${esc(c.t)}</div><div class="c2">${esc(c.d)}</div></div>
              <span class="prob ${c.p === 'HIGH' ? '' : 'med'}">${c.p}</span></div>`).join('')}
          </div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Check in this order</div>
          <div class="cb">
            ${e.checks.map((c, i) => `<div class="step"><div class="sn">${i + 1}</div><div>${esc(c)}</div></div>`).join('')}
          </div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Parts typically needed</div>
          <div class="cb">
            ${e.parts.map(p => `<div class="matrow"><span>${esc(p.d)}</span>
              <span class="p">${p.price ? money(p.price) : '—'}</span></div>`).join('')}
          </div>
        </div>
        <div class="center" style="font-size:10.5px;color:#94A3B8;line-height:1.6;padding-bottom:10px">
          Was this helpful?
          <button class="chip" onclick="ACT.toast('Logged','Ratings like this become the V3 training set')">${ICON('thumbs-up', 13)} Yes</button>
          <button class="chip" onclick="ACT.toast('Flagged for review','A human reviews every correction')">${ICON('thumbs-down', 13)} No</button>
        </div>
      </div>`;
  };

  V.newjob = () => {
    const j = S.job;
    return `
      <div class="pad">
        <div class="field"><label class="fl">Customer</label>
          <input id="fCustName" placeholder="Mr. Adewale Ade" value="${esc(j.customer.name)}"
            oninput="ACT.set('customer.name',this.value)"></div>
        <div class="field"><label class="fl">Phone</label>
          <input inputmode="tel" placeholder="0803 000 0000" value="${esc(j.customer.phone)}"
            oninput="ACT.set('customer.phone',this.value)"></div>
        <div class="field"><label class="fl">Location</label>
          <div class="fieldwrap">
            <input id="fAddr" placeholder="14 Adeyemi St, Okitipupa" value="${esc(j.site.address)}"
              oninput="ACT.set('site.address',this.value)">
            <button class="mic" onclick="ACT.gps()" title="Use my location">${ICON('map-pin', 16)}</button>
          </div>
          <div class="hintline" id="gpsLine">${j.site.lat !== null && j.site.lat !== undefined
            ? '<b>' + ICON('map-pin',12) + ' GPS captured</b> · ' + j.site.lat.toFixed(4) + ', ' + j.site.lng.toFixed(4)
            : 'Tap ' + ICON('map-pin',12) + ' to stamp the location'}</div>
        </div>
        <div class="field"><label class="fl">Job type</label>
          <select onchange="ACT.set('jobType',this.value)">
            <option value="">Choose…</option>
            ${(DATA.JOB_TYPES[j.trade] || []).map(t =>
              `<option ${j.jobType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select></div>
        <div class="card" style="margin-top:14px">
          <div class="ch">Site instructions <span style="text-transform:none;letter-spacing:0;color:#64748B">from the lead</span></div>
          <div class="cb">
            <div class="field" style="margin-bottom:0"><label class="fl">What must be done, and how</label>
              <textarea rows="3" placeholder="Isolate the array before touching the DC isolator. Torque the terminals to 2.5 Nm. Do not energise until I have seen the photos."
                oninput="ACT.set('instructions',this.value)">${esc(j.instructions || '')}</textarea>
              <div class="hintline">Stays at the top of the job card and prints on the report, so nobody is working from memory.</div>
            </div>
          </div>
        </div>
        <div class="card" style="margin-top:14px">
          <div class="ch">Equipment <span style="text-transform:none;letter-spacing:0;color:#64748B">optional but valuable</span></div>
          <div class="cb">
            <div class="field"><label class="fl">Description / capacity</label>
              <input placeholder="6.2 kVA hybrid inverter" value="${esc(j.equipment.capacity)}"
                oninput="ACT.set('equipment.capacity',this.value)"></div>
            <div class="field"><label class="fl">Model</label>
              <input placeholder="SMS-II 6.2K" value="${esc(j.equipment.model)}"
                oninput="ACT.set('equipment.model',this.value)"></div>
            <div class="field" style="margin-bottom:0"><label class="fl">Serial number</label>
              <input placeholder="SMS62-2024-88314" value="${esc(j.equipment.serial)}"
                oninput="ACT.set('equipment.serial',this.value)"></div>
            <div class="hintline">Serial numbers are what make proof-of-work and the solar passport possible.</div>
          </div>
        </div>
        <div class="btnrow">
          <button class="btn ghost" style="flex:1" onclick="ACT.saveDraft()">Save draft</button>
          <button class="btn primary" style="flex:1.4" onclick="ACT.toJobCard()">Start work ›</button>
        </div>
      </div>`;
  };

  V.jobcard = () => {
    const j = S.job;
    const locked = !!j.lockedAt;
    const text = (key, label, ph) => `
      <div class="field"><label class="fl">${label}</label>
        <div class="fieldwrap">
          <textarea ${locked ? 'disabled' : ''} placeholder="${esc(ph)}"
            oninput="ACT.set('${key}',this.value)">${esc(j[key] || '')}</textarea>
          <button class="mic" onclick="ACT.voice('${key}',this)" title="Dictate">${ICON('mic', 16)}</button>
        </div></div>`;
    return `
      <div class="pad">
        ${locked ? `<div class="banner b-ok">${ICON('lock', 15)} This job card is <b>locked</b>. Both parties signed — it is now evidence and cannot be edited.</div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          <span class="chip">${tradeIcon(j.trade,13)}<span>${esc(tradeName(j.trade))}</span></span>
          <span class="chip grey">${esc(j.ref)}</span>
          ${!S.online ? '<span class="chip grey">' + ICON('cloud-off',12) + ' Offline — will sync</span>' : ''}
        </div>
        ${j.instructions ? `<div class="banner b-ok" style="text-align:left;line-height:1.55">
          <div style="font-weight:800;font-size:11px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">
            ${ICON('clipboard-list', 12)} Site instructions</div>
          <div>${esc(j.instructions).replace(/\n/g, '<br>')}</div></div>` : ''}
        ${text('fault', '1 · Fault reported', "What the customer said, in their words")}
        ${text('diagnosis', '2 · Diagnosis', 'What you found')}
        ${text('work', '3 · Work performed', 'What you actually did')}
        <div class="card" style="margin-bottom:12px">
          <div class="ch">4 · Materials used <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#0E7C5A"
            onclick="${locked ? '' : 'ACT.addMaterial()'}">+ Add</span></div>
          <div class="cb">
            ${(j.materials || []).length ? j.materials.map((m, i) => `
              <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
                <input style="flex:1" value="${esc(m.desc)}" placeholder="35 mm² copper lug"
                  oninput="ACT.setMat(${i},'desc',this.value)" ${locked ? 'disabled' : ''}>
                <input style="width:62px" type="number" value="${m.qty}" oninput="ACT.setMat(${i},'qty',this.value)" ${locked ? 'disabled' : ''}>
                <input style="width:96px" type="number" value="${m.unitPrice}" oninput="ACT.setMat(${i},'unitPrice',this.value)" ${locked ? 'disabled' : ''}>
                ${locked ? '' : `<button class="iconbtn" onclick="ACT.delMat(${i})">${ICON('x', 14)}</button>`}
              </div>`).join('') : '<div style="font-size:12px;color:#94A3B8">No materials yet</div>'}
            <div class="field" style="margin:8px 0 0"><label class="fl">Labour (₦)</label>
              <input type="number" value="${j.labour || ''}" placeholder="25000"
                oninput="ACT.set('labour',this.value)" ${locked ? 'disabled' : ''}></div>
          </div>
        </div>
        ${text('recommendation', '5 · Recommendation', 'What should happen next — this is where the next job comes from')}
        <button class="btn ghost sm" onclick="ACT.go('checklist')">
          ${ICON('list-checks', 15)} Checklist ${j.checklist ? '· ' + j.checklist.items.filter(i => i.passed).length + '/' + j.checklist.items.length : ''}</button>
        ${!locked ? `<button class="btn ghost sm" style="margin-top:10px" onclick="ACT.openDiagnose()">${ICON('brain', 15)} Diagnose a fault · online</button>` : ''}
        ${myRole() === 'owner' && !j.lockedAt && !j.assignedTo && teamState().members.length
          ? `<button class="btn ghost sm" style="margin-top:10px" onclick="ACT.assignJob()">${ICON('send', 15)} Assign to crew</button>` : ''}
        ${isMine(j)
          ? `<button class="btn ghost sm" style="margin-top:10px" onclick="ACT.sendUpdate()">${ICON('send', 15)} Send update to supervisor</button>` : ''}
        <button class="btn primary sm" style="margin-top:10px" onclick="ACT.go('photos')">${ICON('camera', 15)} Job evidence</button>
      </div>`;
  };

  V.checklist = () => {
    const j = S.job;
    if (!j.checklist) {
      const key = j.trade + '|' + j.jobType;
      const tpl = DATA.CHECKLISTS[key];
      if (!tpl) {
        return `<div class="pad"><div class="empty"><div class="ei">${ICON('clipboard-list', 26)}</div>
          <div class="et">No checklist for this job type yet</div>
          <div class="ed">We have checklists for ${Object.keys(DATA.CHECKLISTS).length} job types.
          This one is on the list — write it from your next real job.</div></div>
          <button class="btn ghost" onclick="ACT.go('jobcard')">Back to job card</button></div>`;
      }
      j.checklist = { name: tpl.name, version: tpl.version, items: tpl.items.map(i => Object.assign({}, i, { passed: false })) };
    }
    const items = j.checklist.items;
    const done = items.filter(i => i.passed).length;
    return `
      <div class="pad">
        <div class="bar" style="margin-bottom:14px"><i style="width:${(done / items.length) * 100}%;background:linear-gradient(90deg,#0E7C5A,#4ADE9E)"></i></div>
        <div class="card">
          ${items.map((it, i) => `
            <div class="ck ${it.passed ? 'done' : ''}" onclick="${j.lockedAt ? '' : 'ACT.tick(' + i + ')'}">
              <div class="box ${it.passed ? 'on' : ''}">${it.passed ? ICON('check',13) : ''}</div>
              <div style="flex:1">
                <div class="ct">${esc(it.l)}</div>
                ${it.h ? `<div class="cd">${esc(it.h)}</div>` : ''}
                ${it.critical ? '<div class="cd" style="color:#DC2626;font-weight:700;margin-top:3px">' + ICON('alert-triangle',12) + ' Critical — blocks completion</div>' : ''}
                ${it.photo ? '<div class="cam">' + ICON('camera',12) + ' Photo required</div>' : ''}
              </div>
            </div>`).join('')}
        </div>
        <button class="btn primary" onclick="ACT.doneChecklist()">Continue to photos ›</button>
      </div>`;
  };

  V.photos = () => {
    const j = S.job;
    const by = S.photos[j.id] || { before: [], during: [], after: [], serial: [] };
    const cell = (stage, label, icon) => {
      const p = (by[stage] || [])[0];
      if (p) {
        return `<div class="ph"><img src="${p.url}" alt="${stage}">
          <span class="stag">${label}</span><span class="ok">${ICON('check', 13)}</span>
          ${j.lockedAt ? '' : `<button class="x" onclick="ACT.delPhoto('${p.id}')">${ICON('x', 14)}</button>`}</div>`;
      }
      return `<button class="ph empty" onclick="${j.lockedAt ? '' : 'ACT.pick(\'' + stage + '\')'}">
        <span style="font-size:22px">${icon}</span><span>Add ${label}</span></button>`;
    };
    return `
      <div class="pad">
        <div class="banner">Time, GPS and your name are <b>burned into every photo</b>.
        A screenshot of metadata is not evidence — a stamp on the image survives being shared.</div>
        <div class="photogrid">
          ${cell('before', 'BEFORE', ICON('camera',22))}
          ${cell('during', 'DURING', ICON('hammer',22))}
          ${cell('after', 'AFTER', ICON('zap',22))}
          ${cell('serial', 'SERIAL', ICON('scan-line',22))}
        </div>
        <div class="card" style="margin-top:14px">
          <div class="ch">Why this matters</div>
          <div class="cb" style="font-size:12px;line-height:1.6;color:#334155">
            When a customer says <i>"you didn't do the work"</i>, this is the answer:
            four photographs with the time, the location and your name <b>burned into
            the image</b>, plus both signatures on the same page. Signing locks the job
            card — after that the app will not let anyone edit it.
          </div>
        </div>
        <button class="btn primary" onclick="ACT.go('signoff')">Get sign-off ›</button>
      </div>`;
  };

  V.signoff = () => {
    const j = S.job;
    return `
      <div class="pad">
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Customer</div>
          <div class="cb">
            <div class="field"><label class="fl">Name</label>
              <input id="sigCustName" placeholder="A. Adewale" value="${esc(j.customer.name)}"></div>
            <div class="sigpad" id="padC"><canvas id="cvC"></canvas>
              <div class="ph2" id="phC">${ICON('pen-tool', 15)} Customer signs here</div></div>
            <div class="btnrow">
              <button class="btn ghost sm" style="flex:1" onclick="ACT.clearSig('customer')">Clear</button>
              <button class="btn dark sm" style="flex:1" onclick="ACT.saveSig('customer')">Save signature</button>
            </div>
            ${j.signatures.customer ? `<div class="hintline"><b>${ICON('check', 13)} Signed</b> ${dstr(j.signatures.customer.at)} ${tstr(j.signatures.customer.at)}</div>` : ''}
          </div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Technician</div>
          <div class="cb">
            <div class="field"><label class="fl">Name</label>
              <input id="sigTechName" placeholder="${esc((S.user && S.user.name) || 'Your name')}"
                value="${esc((j.signatures.technician && j.signatures.technician.name) || (S.user && S.user.name) || '')}"></div>
            <div class="sigpad" id="padT"><canvas id="cvT"></canvas>
              <div class="ph2" id="phT">${ICON('pen-tool', 15)} You sign here</div></div>
            <div class="btnrow">
              <button class="btn ghost sm" style="flex:1" onclick="ACT.clearSig('technician')">Clear</button>
              <button class="btn dark sm" style="flex:1" onclick="ACT.saveSig('technician')">Save signature</button>
            </div>
            ${j.signatures.technician ? `<div class="hintline"><b>${ICON('check', 13)} Signed</b> ${dstr(j.signatures.technician.at)} ${tstr(j.signatures.technician.at)}</div>` : ''}
          </div>
        </div>
        <div class="banner b-ok">${ICON('lock', 15)} Once both signatures are saved the job card <b>locks</b>.
        That is what turns a note into evidence.</div>
        <button class="btn primary" onclick="ACT.finish()">Generate report ›</button>
      </div>`;
  };

  V.report = () => {
    const j = S.job;
    const prof = docProfile();
    const by = S.photos[j.id] || {};
    const stages = ['before', 'during', 'after'];
    const strip = stages.map(s => (by[s] || [])[0]).filter(Boolean);
    const mats = (j.materials || []).reduce((s, m) => s + (Number(m.qty) || 1) * (Number(m.unitPrice) || 0), 0);
    const total = mats + (Number(j.labour) || 0);
    const sigBox = (role, label) => {
      const s = j.signatures && j.signatures[role];
      return `<div class="sigbox">
        <div class="rl" style="color:${s ? '#0E7C5A' : '#94A3B8'}">${s ? ICON('check',13) : '—'} ${label}</div>
        ${s ? `<img src="${s.dataUrl}" alt="">` : '<div style="height:34px"></div>'}
        <div class="nm">${esc(s ? s.name : 'Not signed')}</div></div>`;
    };
    return `
      <div class="scroll" style="flex:1">
        <div class="rpthdr">
          <div class="lg"><div class="sq">R</div><div>
            <h3>REHOTEQ SERVICE REPORT</h3>
            <p>${esc((S.user && S.user.company) || 'REHOTEQ Technologies')}</p></div></div>
          <div class="rptref"><span>${esc(j.ref)}</span><span>${dstr(j.completedAt || j.startedAt)}</span></div>
        </div>
        <div class="rptkv">
          <div class="k">Customer</div><div class="val">${esc(j.customer.name) || '—'}</div>
          <div class="k">Phone</div><div class="val">${esc(j.customer.phone) || '—'}</div>
          <div class="k">Location</div><div class="val">${esc(j.site.address) || '—'}</div>
          <div class="k">Service</div><div class="val">${esc(j.jobType) || '—'}</div>
          <div class="k">Equipment</div><div class="val">${esc([j.equipment.capacity, j.equipment.model].filter(Boolean).join(' · ')) || '—'}</div>
          <div class="k">Serial</div><div class="val mono">${esc(j.equipment.serial) || '—'}</div>
        </div>
        ${[['FAULT REPORTED', j.fault], ['DIAGNOSIS', j.diagnosis],
          ['WORK PERFORMED', j.work], ['RECOMMENDATION', j.recommendation]]
          .filter(x => x[1]).map(x => `<div class="rptsec"><div class="h">${x[0]}</div>
            <div class="v">${esc(x[1])}</div></div>`).join('')}
        ${(mats || j.labour) ? `<div class="rptsec">
          <div class="h">Materials &amp; labour</div>
          ${(j.materials || []).map(m => `<div class="matrow"><span>${esc(m.desc)} × ${m.qty}</span>
            <span class="p">${money((Number(m.qty) || 1) * (Number(m.unitPrice) || 0))}</span></div>`).join('')}
          ${j.labour ? `<div class="matrow" style="border-top:1px solid var(--line);margin-top:5px;padding-top:8px">
            <span style="font-weight:700">Labour</span><span class="p">${money(j.labour)}</span></div>` : ''}
          <div class="matrow" style="border-top:1.5px solid var(--ink);margin-top:5px;padding-top:8px">
            <span style="font-weight:800">TOTAL</span><span class="p" style="font-size:14px">${money(total)}</span></div>
        </div>` : ''}
        ${strip.length ? `<div class="stripe">
          ${strip.map((p, i) => `<div class="sp"><img src="${p.url}" alt="">
            <span>${['BEFORE', 'DURING', 'AFTER'][i] || ''}</span></div>`).join('')}</div>
          <div class="rptsec" style="font-size:10px;color:var(--muted);padding-top:0;border:none">
            ${dstr(strip[0].capturedAt)} ${tstr(strip[0].capturedAt)} ·
            ${strip[0].lat !== null && strip[0].lat !== undefined ? strip[0].lat.toFixed(4) + ', ' + strip[0].lng.toFixed(4) + ' · ' : ''}
            ${esc((S.user && S.user.name) || '')}</div>` : ''}
        <div class="sigs">${sigBox('customer', 'Customer')}${sigBox('technician', 'Technician')}</div>
        <div class="verify">${ICON('search', 12)} Record reference · ${esc(CONFIG.domain)}/v/<b>${esc(CONFIG.slugify(j.ref))}</b>
          ${j.hashes && j.hashes.length ? `<br><span style="font-size:9px;opacity:.8" class="mono">${j.hashes.length} photo digest${j.hashes.length === 1 ? '' : 's'} recorded on this job card</span>` : ''}</div>
        <div class="disclaim">This report records work performed as described. It is not a certificate of
          regulatory compliance unless issued by a licensed contractor.</div>
      </div>
      <div class="actionbar">
        <button class="btn ghost" style="flex:0 0 30%" onclick="ACT.go('jobcard')">Edit</button>
        <button class="btn primary" style="flex:1" onclick="ACT.pdf()">${ICON('file-text', 16)} Generate PDF</button>
      </div>`;
  };

  V.quote = () => {
    const j = S.job;
    if (!S.quote) {
      const mats = (j.materials || []).reduce((s, m) => s + (Number(m.qty) || 1) * (Number(m.unitPrice) || 0), 0);
      S.quote = {
        id: uid(), number: 'QT-' + new Date().getFullYear() + '-' + String(S.jobs.length + 1).padStart(5, '0'),
        date: new Date().toISOString(),
        validUntil: new Date(Date.now() + 14 * 864e5).toISOString(),
        customer: j.customer, subject: j.jobType || 'Works as discussed',
        items: (j.materials || []).map(m => ({ desc: m.desc, qty: m.qty, unitPrice: m.unitPrice })),
        labour: Number(j.labour) || 0, taxRate: 0, notes: '', terms: '70% deposit · balance on completion'
      };
    }
    const q = S.quote;
    const sub = q.items.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0);
    q.tax = sub * (q.taxRate / 100);
    q.total = sub + (Number(q.labour) || 0) + q.tax;
    return `
      <div class="pad">
        <div class="card" style="margin-bottom:12px"><div class="cb">
          <div style="font-size:11px;color:var(--muted);font-weight:700">QUOTATION ${esc(q.number)}</div>
          <div style="font-size:16px;font-weight:750;margin-top:3px">${esc(q.subject)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:3px">Valid until ${dstr(q.validUntil)}</div>
        </div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Items <button class="chip" style="padding:3px 9px" onclick="ACT.addQuoteItem()">+ Add</button></div>
          <div class="cb">
            ${q.items.map((it, i) => `
              <div style="display:flex;gap:7px;margin-bottom:8px;align-items:center">
                <input style="flex:1" value="${esc(it.desc)}" placeholder="Description"
                  oninput="ACT.setQuoteItem(${i},'desc',this.value)">
                <input style="width:56px" type="number" value="${it.qty}" oninput="ACT.setQuoteItem(${i},'qty',this.value)">
                <input style="width:92px" type="number" value="${it.unitPrice}" oninput="ACT.setQuoteItem(${i},'unitPrice',this.value)">
                <button class="iconbtn" onclick="ACT.delQuoteItem(${i})">${ICON('x', 14)}</button>
              </div>`).join('')}
            ${!q.items.length ? '<div style="font-size:12px;color:#94A3B8">No line items yet</div>' : ''}
            <div class="field" style="margin-top:8px"><label class="fl">Labour (₦)</label>
              <input type="number" value="${q.labour}" oninput="ACT.setQuote('labour',this.value)"></div>
            <div class="field"><label class="fl">VAT (%)</label>
              <input type="number" value="${q.taxRate}" oninput="ACT.setQuote('taxRate',this.value)"></div>
          </div>
        </div>
        <div class="card" style="margin-bottom:12px"><div class="cb">
          <div class="timerow"><span>Subtotal</span><b>${money(sub)}</b></div>
          <div class="timerow"><span>Labour</span><b>${money(q.labour)}</b></div>
          ${q.tax ? `<div class="timerow"><span>VAT ${q.taxRate}%</span><b>${money(q.tax)}</b></div>` : ''}
          <div class="timerow" style="border-top:2px solid var(--ink);margin-top:5px;padding-top:10px">
            <span style="font-weight:800">TOTAL</span>
            <b style="font-size:19px">${money(q.total)}</b></div>
        </div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Notes &amp; terms</div><div class="cb">
            <div class="field"><textarea style="min-height:60px" placeholder="Notes"
              oninput="ACT.setQuote('notes',this.value)">${esc(q.notes)}</textarea></div>
            <div class="field" style="margin-bottom:0"><textarea style="min-height:56px" placeholder="Terms"
              oninput="ACT.setQuote('terms',this.value)">${esc(q.terms)}</textarea></div>
          </div>
        </div>
        <button class="btn primary" onclick="ACT.quotePdf()">${ICON('file-text', 16)} Generate quotation PDF</button>
      </div>`;
  };

  V.jobs = () => `
    <div class="pad">
      <div class="sec" style="margin-top:2px">${S.jobs.length} job cards</div>
      ${S.jobs.length ? S.jobs.map(j => `
        <div class="card"><div class="rowitem" onclick="ACT.openJob('${j.id}')">
          <div class="dotg" style="background:${j.lockedAt ? '#0E7C5A' : j.status === 'sent' ? '#94A3B8' : '#F59E0B'}"></div>
          <div style="flex:1">
            <div class="jt">${esc(j.jobType || 'Job card')}${j.customer.name ? ' — ' + esc(j.customer.name) : ''}</div>
            <div class="js">${esc(j.ref)} · ${dstr(j.startedAt)} · ${esc(tradeName(j.trade))}</div>
            <div class="js" style="margin-top:2px">
              ${j.lockedAt ? ICON('lock',12) + ' Locked as evidence' : j.status === 'sent' ? ICON('upload',12) + ' Sent' : ICON('pencil-line',12) + ' Draft'}</div>
            ${isShadow(j) ? `<div class="js" style="margin-top:2px">${ICON('send',12)} Assigned to ${esc(memberName(j.assignedTo))} · ${TEAM.statusLabel(j.status)}</div>` : ''}
            ${isMine(j) ? `<div class="js" style="margin-top:2px">${ICON('users',12)} From ${esc(myCompanyName())} · ${TEAM.statusLabel(j.status)}</div>` : ''}
          </div></div></div>`).join('')
        : `<div class="empty"><div class="ei">${ICON('clipboard-list', 26)}</div><div class="et">No jobs yet</div>
           <div class="ed">Start your first job card. It takes about two minutes and ends with a
           PDF you can send on WhatsApp.</div></div>`}
    </div>`;

  V.settings = () => {
    const u = S.user || {};
    const plan = u.plan || 'free';
    const owner = isOwnerAccount();
    return `
      <div class="pad">
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Business profile</div>
          <div class="srow"><span class="si">${ICON('building-2', 17)}</span><span class="sl">Business name</span>
            <span class="sv">${esc(u.company || 'Not set')}</span></div>
          <div class="srow"><span class="si">${ICON('user', 17)}</span><span class="sl">Your name</span><span class="sv">${esc(u.name || '')}</span></div>
          <div class="srow"><span class="si">${ICON('phone', 17)}</span><span class="sl">Phone</span><span class="sv">${esc(u.phone || 'Not set')}</span></div>
          <div class="srow"><span class="si">${ICON('map-pin', 17)}</span><span class="sl">Business address</span>
            <span class="sv">${esc(u.address || 'Not set')}</span></div>
          <div class="srow"><span class="si">${ICON('mail', 17)}</span><span class="sl">Email</span>
            <span class="sv">${esc(u.email || 'Not set')}</span></div>
          <div class="srow"><span class="si">${ICON('landmark', 17)}</span><span class="sl">Bank details</span>
            <span class="sv">${esc(u.bank || 'Not set')}</span></div>
          <div class="srow"><span class="si">${ICON('image', 17)}</span><span class="sl">Logo</span>
            <span class="sv">${u.logo && u.logo.dataUrl
              ? '<img src="' + esc(u.logo.dataUrl) + '" alt="" style="width:28px;height:28px;' +
                'object-fit:contain;background:#F1F5F9;border-radius:7px;vertical-align:middle">'
              : 'Not set'}</span></div>
          <div class="srow" style="cursor:pointer" onclick="ACT.editProfile()">
            <span class="si">${ICON('pencil', 17)}</span><span class="sl">Edit profile</span><span style="color:#94A3B8">›</span></div>
          <div class="srow" style="cursor:pointer" onclick="ACT.logout()">
            <span class="si">${ICON('log-out', 17)}</span><span class="sl">Log out / switch account</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Team</div>
          <div class="srow" style="cursor:pointer" onclick="ACT.openTeam()">
            <span class="si">${ICON('users', 17)}</span><span class="sl">My team</span>
            <span class="sv">${esc(teamStatusLine())}</span></div>
        </div>
        ${accountCard()}
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Subscription</div>
          ${owner ? `
            <div class="cb" style="padding-bottom:6px">
              <div class="banner b-ok" style="margin-bottom:8px">
                <b>${ICON('shield-check', 14)} Owner access (${esc((u.email || (S.fbUser && S.fbUser.email) || 'rehoteq@gmail.com').toLowerCase())}).</b>
                All plans (Free, Pro &amp; Business) are permanently unlocked on this account. Switch active plan mode below at any time:
              </div>
              <div class="plan-pills">
                <button class="plan-pill ${plan === 'free' ? 'on' : ''}" onclick="ACT.setPlan('free')">Free</button>
                <button class="plan-pill ${plan === 'pro' ? 'on' : ''}" onclick="ACT.setPlan('pro')">Pro</button>
                <button class="plan-pill ${plan === 'business' ? 'on' : ''}" onclick="ACT.setPlan('business')">Business</button>
              </div>
            </div>` : ''}
          <div class="srow"><span class="si">${ICON('star', 17)}</span>
            <span class="sl">Plan<br><span style="font-size:11px;color:var(--muted);font-weight:500">
              ${owner ? 'Owner · all plans unlocked (' + esc(plan) + ')' : plan === 'business' ? 'Business · 5 seats & unlimited' : plan === 'free' ? 'Free · 3 reports on this device' : 'Pro · unlimited'}</span></span>
            <button class="switch ${plan !== 'free' ? 'on' : ''}" onclick="ACT.togglePlan(this)"></button></div>
          <div class="srow" onclick="ACT.goPlan()"><span class="si">${ICON('credit-card', 17)}</span>
            <span class="sl">Plans &amp; pricing</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Field settings</div>
          <div class="srow"><span class="si">${ICON('signal', 17)}</span><span class="sl">Data saver</span>
            <span class="sv">Photos ≤ 350 KB</span></div>
          <div class="srow"><span class="si">${ICON('cloud', 17)}</span><span class="sl">Offline</span>
            <span class="sv">${S.online ? '<span class="online-dot"></span>Online' : '<span class="offline-dot"></span>Offline — work is saved'}</span></div>
          <div class="srow" onclick="ACT.syncInfo()"><span class="si">${ICON('refresh-cw', 17)}</span><span class="sl">Sync queue</span>
            <span class="sv" id="queueCount">…</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Backup
            <span style="text-transform:none;letter-spacing:0;font-weight:700;
              color:${S.lastBackup ? '#0E7C5A' : '#DC2626'}">${
                S.lastBackup ? 'Last: ' + dstr(S.lastBackup) : 'Never backed up'}</span></div>
          ${!S.lastBackup ? `<div class="cb" style="padding-top:0">
            <div class="warnbox" style="margin:0 0 10px">
              <div class="wh">${ICON('alert-triangle', 14)} Your data is only on this phone</div>
              <div class="wt">If this phone is lost, reset or the browser data is cleared,
              every job card and photo goes with it. Back up now — it takes ten seconds.</div>
            </div></div>` : `<div class="cb" style="padding-top:2px;padding-bottom:6px;font-size:11.5px;color:var(--muted);line-height:1.55">
              A backup file is only safe somewhere other than this phone.
              Email it to yourself or put it in Drive.</div>`}
          <div class="srow" onclick="ACT.shareBackup()"><span class="si">${ICON('upload', 17)}</span>
            <span class="sl">Send backup off this phone<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Jobs + photos · email or Drive</span></span>
            <span style="color:#0E7C5A;font-weight:700">Best</span></div>
          <div class="srow" onclick="ACT.exportAll(true)"><span class="si">${ICON('save', 17)}</span>
            <span class="sl">Download backup (with photos)</span><span style="color:#94A3B8">›</span></div>
          <div class="srow" onclick="ACT.exportAll(false)"><span class="si">${ICON('file-text', 17)}</span>
            <span class="sl">Download backup (text only)<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Much smaller · no photos</span></span>
            <span style="color:#94A3B8">›</span></div>
          <div class="srow" onclick="ACT.importBackup()"><span class="si">${ICON('download', 17)}</span>
            <span class="sl">Restore from backup</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Support</div>
          <div class="srow" onclick="ACT.contact()"><span class="si">${ICON('message-circle', 17)}</span>
            <span class="sl">Message REHOTEQ on WhatsApp<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">${esc(CONFIG.support.whatsappLabel)}</span></span>
            <span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Data</div>
          <div class="srow" onclick="ACT.loadDemo()"><span class="si">${ICON('play', 17)}</span>
            <span class="sl">Load a demo job</span><span class="sv">Try the PDF in one tap</span></div>
          <div class="srow" onclick="ACT.wipe()"><span class="si">${ICON('trash-2', 17)}</span>
            <span class="sl" style="color:#DC2626">Delete everything on this device</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="center" style="font-size:10.5px;color:#94A3B8;line-height:1.7">
          REHOTEQ Field v1.4.1 · PWA<br>Built for the people holding the phone.
        </div>
      </div>`;
  };

  V.passport = () => {
    const eq = S.passportEq;
    if (eq) {
      const url = CONFIG.passportUrl(eq.slug);
      const qr = QR.encode(url);
      const hist = S.jobs.filter(j => j.equipment && j.equipment.serial === eq.serial);
      const inst = eq.installDate ? new Date(eq.installDate) : null;
      const months = Number(eq.warrantyMonths) || 24;
      const exp = inst ? new Date(inst.getTime() + months * 30.44 * 864e5) : null;
      const days = exp ? Math.round((exp - Date.now()) / 864e5) : null;
      return `
        <div class="pad">
          <div style="background:linear-gradient(150deg,#0E7C5A,#064E3B);color:#fff;border-radius:18px;padding:17px;margin-bottom:12px">
            <div style="font-size:10px;letter-spacing:.11em;opacity:.75;font-weight:700">MY SOLAR SYSTEM</div>
            <div style="font-size:18px;font-weight:800;margin:4px 0 13px">${esc(eq.customerName || 'Customer')}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px">
              <div><div style="font-size:9px;letter-spacing:.07em;text-transform:uppercase;opacity:.7;font-weight:700">Installed</div>
                <div style="font-size:13.5px;font-weight:750">${inst ? dstr(inst.toISOString()) : '—'}</div></div>
              <div><div style="font-size:9px;letter-spacing:.07em;text-transform:uppercase;opacity:.7;font-weight:700">Capacity</div>
                <div style="font-size:13.5px;font-weight:750">${esc(eq.capacity || '—')}</div></div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,.12);
              padding:10px 12px;border-radius:11px;margin-top:13px;font-size:11.5px">
              <span>${ICON('shield-check', 13)} Warranty · <b>${days === null ? '—' : days > 0 ? 'active' : 'expired'}</b></span>
              <span><b>${days === null ? '—' : Math.max(0, days) + ' days'}</b> left</span></div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">QR sticker <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#0E7C5A"
              onclick="ACT.printQr()">Print</span></div>
            <div class="cb center">
              <div class="qrbox"><canvas id="qrCv"></canvas></div>
              <div style="font-size:11.5px;color:var(--muted);line-height:1.55">
                Stick this on the DB board.<br>Customer scans — <b>no app needed</b>.</div>
              <div class="mono" style="font-size:10px;color:#94A3B8;margin-top:8px">${esc(url)}</div>
            </div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">Serial numbers</div>
            <div class="cb"><div class="timerow"><span>Inverter / equipment</span>
              <b class="mono">${esc(eq.serial)}</b></div>
              <div class="timerow"><span>Model</span><b>${esc(eq.model || '—')}</b></div></div>
          </div>
          <div class="card" style="margin-bottom:12px">
            <div class="ch">Service history (${hist.length})</div>
            <div class="cb">
              ${hist.length ? hist.map(j => `<div class="timerow">
                <span>${esc(j.jobType || 'Service')}</span><b>${dstr(j.completedAt || j.startedAt)}</b></div>`).join('')
                : '<div style="font-size:12px;color:#94A3B8">No recorded service yet</div>'}
            </div>
          </div>
          <button class="btn ghost sm" onclick="ACT.closePassport()">‹ Back to all systems</button>
        </div>`;
    }
    const list = S.equipment || [];
    return `
      <div class="pad">
        <div class="banner b-ok">Every job card with a serial number becomes a
          <b>digital passport</b>: QR code, live warranty countdown, and full service history.</div>
        <div class="sec" style="margin-top:2px">${list.length} systems</div>
        ${list.length ? list.map(e => `
          <div class="card"><div class="rowitem" onclick="ACT.openPassport('${e.id}')">
            <div class="dotg" style="background:#0E7C5A"></div>
            <div style="flex:1"><div class="jt">${esc(e.customerName || 'Customer')}</div>
              <div class="js mono">${esc(e.serial)}</div>
              <div class="js">${esc(e.capacity || '')} · ${esc(e.model || '')}</div></div>
            <div style="color:#94A3B8">›</div></div></div>`).join('')
          : `<div class="empty"><div class="ei">${ICON('qr-code', 26)}</div><div class="et">No systems yet</div>
             <div class="ed">Add a serial number on a job card and it will appear here.</div></div>`}
      </div>`;
  };

  /* ---------------- team views --------------------------------------- */

  V.teamadd = () => {
    const t = teamState();
    if (myRole() !== 'owner' || !t.company) { go('team'); return ''; }
    const s = TEAM.seats();
    const waiting = t.invites.filter(i => i.status === 'waiting');
    const stepShare = waiting.length ? waiting[waiting.length - 1] : null;
    const full = s.paid && s.used >= s.paid;
    return `
      <div class="pad">
        <div class="card"><div class="cb">
          <div style="font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted)">ADD A TECHNICIAN · ${esc(t.company.name)}</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:6px">
            An invite is a small file. You send it to your technician on WhatsApp,
            they open it in their REHOTEQ Field, and they appear on your dashboard.</div>
        </div></div>
        <div class="card" style="margin-top:12px"><div class="cb">
          <div style="font-size:11px;font-weight:800;color:#0E7C5A">STEP 1 · CREATE THE INVITE</div>
          ${stepShare ? `
            <div style="text-align:center;margin:10px 0 2px">
              <div style="font-size:10px;color:var(--muted);letter-spacing:.06em">INVITE CODE</div>
              <div class="mono" style="font-size:24px;font-weight:800;letter-spacing:.08em;color:var(--ink)">${esc(stepShare.code)}</div>
            </div>`
          : `
            <div style="font-size:12px;color:var(--muted);margin:6px 0 9px">One tap. Seats left: ${Math.max(0, s.paid - s.used)}.</div>
            <button class="btn primary sm" style="width:100%" onclick="ACT.makeInvite()" ${full ? 'disabled' : ''}>
              ${ICON('user-plus', 15)} Create the invite</button>
            ${full ? '<div class="hintline" style="margin-top:8px">All seats are used — add seats first.</div>' : ''}`}
        </div></div>
        ${stepShare ? `
        <div class="card" style="margin-top:12px"><div class="cb">
          <div style="font-size:11px;font-weight:800;color:#0E7C5A">STEP 2 · SEND IT ON WHATSAPP</div>
          <div style="font-size:12px;color:var(--muted);margin:6px 0 9px">Tap below, choose their chat, and send. The file carries the invite code automatically.</div>
          <button class="btn primary sm" style="width:100%" onclick="ACT.resendInvite('${esc(stepShare.code)}')">
            ${ICON('send', 15)} Send the invite file</button>
        </div></div>
        <div class="card" style="margin-top:12px"><div class="cb">
          <div style="font-size:11px;font-weight:800;color:#0E7C5A">STEP 3 · WHAT THEY DO</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.8;margin-top:6px">
            1. Open REHOTEQ Field on their phone.<br>
            2. Team tab, then <b>Import file from WhatsApp</b>, then pick the file you sent.<br>
            3. Tap <b>Send acceptance</b> and choose your chat.<br>
            4. Import the acceptance the same way on your side, and they appear here.</div>
          <div class="hintline" style="margin-top:9px">Their acceptance also arrives as a file: tap Import file from WhatsApp on your dashboard when it lands.</div>
        </div></div>` : ''}
        <div class="banner b-ok" style="margin-top:12px;text-align:left;line-height:1.6">
          Also available: a Business account can create <b>worker logins</b> — ready-made
          accounts for workers who never create their own profile. Same kind of file;
          on their phone it is Log in / Worker, then enter the RQ code.</div>
      </div>`;
  };

  V.team = () => {
    const t = teamState();
    const role = myRole();
    if (role === 'owner' && t.company) return teamOwnerView(t);
    if (role === 'member' && S.user.memberOf) return teamMemberView(t);
    return teamNoneView();
  };

  function teamOwnerView(t) {
    const s = TEAM.seats();
    const biz = DATA.PLANS.business;
    const waiting = t.invites.filter(i => i.status === 'waiting');
    const workerLogins = TEAM.workerLogins();
    const workerSlots = new Set(t.members.map(m => String(m.memberId))
      .concat(workerLogins.filter(w => w.status !== 'revoked').map(w => String(w.workerId || w.code))));
    const businessPlan = Boolean(S.user && S.user.plan === 'business');
    const pct = s.paid ? Math.min(100, (s.used / s.paid) * 100) : 0;
    return `
      <div class="pad">
        <div class="card"><div class="cb">
          <div style="font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted)">YOUR CREW</div>
          <div style="font-size:17px;font-weight:800;margin:3px 0">${esc(t.company.name)}</div>
          <div style="font-size:11.5px;color:var(--muted)">You are the owner · since ${dstr(t.company.createdAt)}</div>
          <div class="meter" style="margin:11px 0 0">
            <div>${ICON('users', 20)}</div>
            <div class="lab"><b>${s.used} of ${s.paid} seats used</b>
              <div class="bar"><i style="width:${pct}%"></i></div>
              <div style="margin-top:4px">Extra seats ${money(biz.extraSeat)} / month each` +
              (t.seats.selfDeclared ? ' · extra seats self-declared' : '') + `</div></div>
          </div>
        </div></div>
        <button class="btn primary sm" style="width:100%" onclick="ACT.go('teamadd')">${ICON('user-plus', 15)} Add a technician</button>
        <div class="btnrow" style="margin-top:9px">
          <button class="btn ghost sm" style="flex:1" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Import file from WhatsApp</button>
          <button class="btn ghost sm" style="flex:1" onclick="ACT.go('company')">${ICON('briefcase', 15)} Stamp</button>
          <button class="btn ghost sm" style="flex:1" onclick="ACT.buySeats()">${ICON('plus', 15)} Seats</button>
        </div>
        <div class="card" style="margin-top:12px">
          <div class="ch">Worker logins · ${Math.min(workerSlots.size, biz.seats)} of ${biz.seats}</div>
          <div class="cb">
            <div style="font-size:11.5px;color:var(--muted);line-height:1.55;margin-bottom:9px">
              For a worker who will not create their own profile (Business plan). Create the code, send the login file; on their phone: Log in / Worker, Import worker file, then enter the code.
            </div>
            ${businessPlan ? '' : '<div class="hintline" style="margin:0 0 9px">Switch this company account to Business to create worker logins.</div>'}
            <div class="field"><label class="fl">Worker name (optional)</label>
              <input id="workerLoginName" placeholder="Worker 1"></div>
            <button class="btn ${businessPlan && workerSlots.size < biz.seats ? 'primary' : 'ghost'} sm" style="width:100%"
              onclick="ACT.createWorkerLogin()" ${businessPlan && workerSlots.size < biz.seats ? '' : 'disabled'}>
              ${ICON('user-plus', 15)} Create worker login</button>
            ${workerLogins.length ? `<div style="margin-top:10px">
              ${workerLogins.map(w => `<div class="timerow">
                <span style="min-width:0"><b>${esc(w.name || 'Worker')}</b><br>
                  <span class="mono" style="font-size:11px">${esc(w.code)}</span> · ${w.status === 'joined' ? 'joined' : 'login ready'}</span>
                <button class="btn ghost sm" style="width:auto;padding:8px 10px" onclick="ACT.sendWorkerLogin('${esc(w.code)}')">Send file</button>
              </div>`).join('')}
            </div>` : ''}
          </div>
        </div>
        <div class="sec">Technicians (${t.members.length})</div>
        ${t.members.length ? t.members.map(m => {
          const jobs = memberJobs(m.memberId);
          const active = jobs.filter(j => j.status !== 'completed' && j.status !== 'sent').length;
          const done = jobs.length - active;
          const last = lastUpdateFor(m.memberId);
          const open = t.sel === m.memberId;
          return `
          <div class="card">
            <div class="rowitem" onclick="ACT.toggleMember('${m.memberId}')">
              <div class="dotg" style="background:${active ? '#F59E0B' : '#0E7C5A'}"></div>
              <div style="flex:1">
                <div class="jt">${esc(m.name)}</div>
                <div class="js">${esc(m.phone || 'No number')} · ${active} active · ${done} done</div>
                <div class="js" style="margin-top:2px">${last ? 'Updated ' + dstr(last) + ' ' + tstr(last) : 'No jobs yet'}</div>
              </div>
              <div style="color:#94A3B8">${open ? '▾' : '›'}</div>
            </div>
            ${open ? `
              <div class="cb" style="padding-top:0">
                ${jobs.length ? jobs.map(j => `
                  <div class="rowitem" style="padding-left:0;padding-right:0" onclick="ACT.openJob('${j.id}')">
                    <div class="dotg" style="background:${j.lockedAt ? '#0E7C5A' : '#F59E0B'}"></div>
                    <div style="flex:1">
                      <div class="jt" style="font-size:13px">${esc(j.jobType || 'Job card')}${j.customer.name ? ' — ' + esc(j.customer.name) : ''}</div>
                      <div class="js">${esc(j.ref)} · ${TEAM.statusLabel(j.status)} · ${dstr(j.updatedAt || j.assignedAt)}</div>
                    </div>
                    <div style="color:#94A3B8">›</div>
                  </div>`).join('') : '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px">No jobs assigned yet — open a job card and tap Assign.</div>'}
                <div class="btnrow" style="margin-top:6px">
                  <button class="btn ghost sm" style="flex:1" onclick="ACT.nudgeMember('${m.memberId}')">${ICON('send', 14)} Nudge</button>
                  <button class="btn ghost sm" style="flex:1;color:#DC2626" onclick="ACT.removeMember('${m.memberId}')">Remove</button>
                </div>
              </div>` : ''}
          </div>`;
        }).join('') : `<div class="empty"><div class="ei">${ICON('users', 26)}</div><div class="et">No technicians yet</div>
           <div class="ed">Add your first technician — the invite goes to them on WhatsApp,
           and they appear here once they accept.</div>
           <button class="btn primary sm" style="margin-top:10px" onclick="ACT.go('teamadd')">${ICON('user-plus', 15)} Add a technician</button></div>`}
        ${waiting.length ? `<div class="sec">Invites waiting (${waiting.length})</div>` + waiting.map(i => `
          <div class="card"><div class="rowitem">
            <div style="flex:1">
              <div class="jt mono">${esc(i.code)}</div>
              <div class="js">Sent ${dstr(i.createdAt)} — waiting for their acceptance file</div>
            </div>
            <button class="btn ghost sm" style="width:auto;padding:9px 12px" onclick="ACT.resendInvite('${i.code}')">Send</button>
            <button class="btn ghost sm" style="width:auto;padding:9px 12px;color:#DC2626" onclick="ACT.revokeInvite('${i.code}')">Revoke</button>
          </div></div>`).join('') : ''}
        <div class="banner b-ok" style="text-align:left;line-height:1.6">
          <b>How it works today.</b> Invites, jobs and updates travel as small files over
          WhatsApp, so nothing arrives by itself: you send, they send back. Your company
          stamp prints on every PDF your crew sends, and every update they send back lands
          on this dashboard.</div>
      </div>`;
  }

  function teamMemberView(t) {
    const m = S.user.memberOf;
    const mine = S.jobs.filter(j => isMine(j));
    return `
      <div class="pad">
        <div class="card"><div class="cb">
          <div style="font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted)">YOU WORK WITH</div>
          <div style="font-size:17px;font-weight:800;margin:3px 0">${esc(m.branding.name)}</div>
          <div style="font-size:11.5px;color:var(--muted)">Oga: ${esc(m.ownerName || '—')} · joined ${dstr(m.joinedAt)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:3px">Your PDFs carry the company stamp.
          Company jobs never touch your 3 free reports.</div>
        </div></div>
        ${!m.sent ? `<button class="btn primary sm" onclick="ACT.sendAcceptance()">${ICON('send', 15)} Send acceptance to your oga</button>
          <div class="hintline" style="margin:7px 0 11px">They cannot see you on their dashboard until it arrives.</div>` : ''}
        <div class="btnrow">
          <button class="btn ghost sm" style="flex:1" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Import file from WhatsApp</button>
          <button class="btn ghost sm" style="flex:1;color:#DC2626" onclick="ACT.leaveTeam()">Leave crew</button>
        </div>
        <div class="sec">My assigned jobs (${mine.length})</div>
        ${mine.length ? mine.map(j => `
          <div class="card"><div class="rowitem" onclick="ACT.openJob('${j.id}')">
            <div class="dotg" style="background:${j.lockedAt ? '#0E7C5A' : '#F59E0B'}"></div>
            <div style="flex:1">
              <div class="jt">${esc(j.jobType || 'Job card')}${j.customer.name ? ' — ' + esc(j.customer.name) : ''}</div>
              <div class="js">${esc(j.ref)} · ${TEAM.statusLabel(j.status)}${j.assignerName ? ' · from ' + esc(j.assignerName) : ''}</div>
            </div>
            <div style="color:#94A3B8">›</div></div></div>`).join('')
          : `<div class="empty"><div class="ei">${ICON('inbox', 26)}</div><div class="et">No jobs yet</div>
             <div class="ed">When your oga assigns you a job, import the file with Receive file above.</div></div>`}
        <div class="banner b-ok" style="text-align:left;line-height:1.6">
          <b>Keep your oga posted.</b> Open a job and tap Send update after each visit —
          it travels as a file over WhatsApp and lands on their dashboard.</div>
      </div>`;
  }

  function teamNoneView() {
    return `
      <div class="pad">
        <div class="empty"><div class="ei">${ICON('users', 26)}</div>
          <div class="et">Run a crew, or join one</div>
          <div class="ed">Owners stamp every PDF their technicians send, assign jobs with
          instructions pinned, and watch progress land on a dashboard.</div></div>
        <button class="btn primary sm" onclick="ACT.createCompany()">${ICON('briefcase', 15)} Start a company</button>
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Join a company (import the invite they sent)</button>
        <div class="banner b-ok" style="margin-top:14px;text-align:left;line-height:1.6">
          Pilot: teams are free while we test. Business is ${money(DATA.PLANS.business.price)} / month
          for ${DATA.PLANS.business.seats} seats — extra seats ${money(DATA.PLANS.business.extraSeat)} / month each.</div>
      </div>`;
  }

  // The owner's copy of an assigned job, read-only. Editing it here would
  // be overwritten by the next update file, so the screen says where the
  // truth lives instead of pretending this copy is editable.
  V.teamjob = () => {
    const j = S.job;
    if (!j) return `<div class="pad"><div class="empty"><div class="ei">${ICON('users', 26)}</div>
      <div class="et">No job open</div></div>
      <button class="btn ghost" onclick="ACT.go('team')">Back to team</button></div>`;
    const mats = (j.materials || []).reduce((s, m) => s + (Number(m.qty) || 1) * (Number(m.unitPrice) || 0), 0);
    const sig = j.signatures || {};
    return `
      <div class="pad">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          <span class="chip">${ICON('users', 13)}<span>Crew job</span></span>
          <span class="chip grey">${esc(j.ref)}</span>
          <span class="chip grey">${TEAM.statusLabel(j.status)}</span>
        </div>
        <div class="card"><div class="cb">
          <div style="font-size:15px;font-weight:750">${esc(j.jobType || 'Job card')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px">
            ${esc(j.customer.name || 'No customer')}${j.customer.phone ? ' · ' + esc(j.customer.phone) : ''}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(j.site.address || 'No location')}</div>
        </div></div>
        ${j.instructions ? `<div class="banner b-ok" style="text-align:left;line-height:1.55">
          <div style="font-weight:800;font-size:11px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">
            ${ICON('clipboard-list', 12)} Site instructions</div>
          <div>${esc(j.instructions).replace(/\n/g, '<br>')}</div></div>` : ''}
        <div class="card"><div class="ch">Progress</div><div class="cb">
          <div class="timerow"><span>Assigned to</span><b>${esc(memberName(j.assignedTo))}</b></div>
          <div class="timerow"><span>Assigned</span><b>${dstr(j.assignedAt)}${j.assignedAt ? ' ' + tstr(j.assignedAt) : ''}</b></div>
          <div class="timerow"><span>Last update</span><b>${j.updatedAt ? dstr(j.updatedAt) + ' ' + tstr(j.updatedAt) : '—'}</b></div>
          <div class="timerow"><span>Materials + labour</span><b>${money(mats + (Number(j.labour) || 0))}</b></div>
          <div class="timerow"><span>Customer signed</span><b>${sig.customer ? 'Yes' : 'Not yet'}</b></div>
          <div class="timerow"><span>Technician signed</span><b>${sig.technician ? 'Yes' : 'Not yet'}</b></div>
        </div></div>
        <div class="banner b-ok" style="text-align:left;line-height:1.6">
          Updates arrive from ${esc(memberName(j.assignedTo))} as files — ask them to open the job
          and tap Send update after each visit.</div>
        <button class="btn ghost sm" onclick="ACT.nudgeMember('${j.assignedTo || ''}')">${ICON('send', 15)} Nudge on WhatsApp</button>
      </div>`;
  };

  V.company = () => {
    const t = teamState();
    const co = t.company;
    if (!co || myRole() !== 'owner') return `<div class="pad"><div class="empty"><div class="ei">${ICON('briefcase', 26)}</div>
      <div class="et">No company yet</div></div>
      <button class="btn ghost" onclick="ACT.go('team')">Back to team</button></div>`;
    return `
      <div class="pad">
        <div class="banner b-ok" style="text-align:left;line-height:1.6">This stamp prints on every PDF
          your crew sends — reports and quotations.</div>
        <div class="field"><label class="fl">Company name</label>
          <input id="cName" value="${esc(co.name)}"></div>
        <div class="field"><label class="fl">Address</label>
          <input id="cAddr" placeholder="12 Sapele Road, Benin City" value="${esc(co.address || '')}"></div>
        <div class="field"><label class="fl">Phone</label>
          <input id="cPhone" inputmode="tel" value="${esc(co.phone || '')}"></div>
        <div class="field"><label class="fl">Email</label>
          <input id="cEmail" inputmode="email" value="${esc(co.email || '')}"></div>
        <div class="field"><label class="fl">Bank details (printed on quotations)</label>
          <input id="cBank" value="${esc(co.bank || '')}"></div>
        <div class="field"><label class="fl">About the company (printed on quotations)</label>
          <textarea id="cBio" maxlength="300" rows="3">${esc(co.bio || '')}</textarea></div>
        <div class="field"><label class="fl">Logo</label>
          ${co.logo && co.logo.dataUrl ? `
            <div style="display:flex;align-items:center;gap:10px">
              <img src="${esc(co.logo.dataUrl)}" alt=""
                style="width:52px;height:52px;object-fit:contain;background:#F1F5F9;border-radius:10px">
              <div style="flex:1;font-size:11.5px;color:var(--muted)">Appears on every crew PDF.</div>
            </div>
            <div class="btnrow" style="margin-top:10px">
              <button class="btn ghost sm" style="flex:1" onclick="ACT.pickCompanyLogo()">Replace</button>
              <button class="btn ghost sm" style="flex:1" onclick="ACT.removeCompanyLogo()">Remove</button>
            </div>` : `
            <button class="btn ghost sm" style="width:100%" onclick="ACT.pickCompanyLogo()">＋ Add the company logo</button>`}
        </div>
        <button class="btn primary" style="margin-top:6px" onclick="ACT.saveCompany()">Save stamp</button>
      </div>`;
  };

  /* ---------------- paywall ------------------------------------------ */

  // The paywall must never offer a button that goes nowhere — that is
  // exactly how 25 dead buttons shipped in v1.0.0. A plan with no payment
  // link gets no button; if none of them have one, it offers WhatsApp.
  function payLink(kind) {
    const p = (window.CONFIG && CONFIG.payments) || {};
    if (kind === 'annual') return p.proAnnualUrl || '';
    if (kind === 'business') return p.businessUrl || '';
    return p.proMonthlyUrl || '';
  }

  // How many months the annual price saves, worked out rather than typed in.
  // If Toye moves either number the sentence follows it; a hardcoded
  // "2 months free" would quietly start lying.
  function monthsFree() {
    const plan = DATA.PLANS.pro;
    if (!plan.yearPrice || !plan.price) return 0;
    return Math.round(12 - plan.yearPrice / plan.price);
  }
  // The annual line only appears when there is actually a way to pay it.
  // Advertising a price with no button behind it is the same lie the old
  // "Start 14-day free trial" was.
  function annualLine() {
    if (!payLink('annual')) return '';
    const free = monthsFree();
    return '<div class="yr">or ' + money(DATA.PLANS.pro.yearPrice) + ' / year'
      + (free > 0 ? ' \u2014 ' + free + ' months free' : '') + '</div>';
  }

  function payBtns() {
    const out = [];
    const pro = DATA.PLANS.pro, biz = DATA.PLANS.business;
    const free = monthsFree();
    if (payLink('monthly')) {
      out.push('<button class="btn primary" onclick="ACT.payMonthly()">Pay ' + money(pro.price) + ' · one month</button>');
    }
    if (payLink('annual')) {
      out.push('<button class="' + (out.length ? 'btn ghost sm" style="margin-top:9px' : 'btn primary') +
        '" onclick="ACT.payAnnual()">' + money(pro.yearPrice) + ' / year'
        + (free > 0 ? ' — ' + free + ' months free' : '') + '</button>');
    }
    if (payLink('business')) {
      out.push('<button class="btn ghost sm" style="margin-top:9px" onclick="ACT.payBusiness()">' +
        biz.name + ' · ' + money(biz.price) + ' / month</button>');
    }
    if (!out.length) {
      out.push('<button class="btn primary" onclick="ACT.subscribe()">Subscribe — '
        + money(pro.price) + ' / month</button>');
    }
    return out.join('\n        ');
  }

  function openPayment(url, label) {
    if (!url) return toast('Payments are not connected yet');
    const win = window.open(url, '_blank');
    if (!win) return toast('Allow pop-ups to open the payment page');
    toast('Opening ' + label + '…', 'Paid? Switch Pro on in Settings → Subscription');
  }

  function showPaywall() {
    const pw = $('paywall');
    pw.innerHTML = `
      <div class="pwsheet">
        <div class="center" style="margin-bottom:13px">
          <div style="margin-bottom:4px">${ICON('lock', 32)}</div>
          <div style="font-size:16px;font-weight:750;letter-spacing:-.01em">You&rsquo;ve used all 3 free reports</div>
          <div style="font-size:12px;color:var(--muted);margin-top:5px;line-height:1.5">
            Your report is ready. Upgrade for unlimited reports whenever your work needs it.</div>
        </div>
        <div class="plan">
          <div class="badge">MOST POPULAR</div>
          <div class="pr"><span class="amt">${money(DATA.PLANS.pro.price)}</span><span class="per">/ month</span></div>
          ${annualLine()}
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>Unlimited job cards &amp; PDF reports</div>
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>No watermark — your own logo</div>
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>Quotations that get accepted</div>
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>Evidence packs, GPS, signatures</div>
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>Offline mode, syncs later</div>
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>All 10 engineering &amp; MEP trades + full checklists</div>
        </div>
        ${payBtns()}
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.closePaywall()">Maybe later</button>
        <div style="background:#fff;border:1px solid var(--line);border-radius:13px;padding:13px;margin-top:14px">
          <div style="font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-bottom:7px">Also available</div>
          <div style="font-size:12px;line-height:1.6">
            <b>${esc(DATA.PLANS.business.name)}</b> — ${money(DATA.PLANS.business.price)}/mo · 5 technicians · supervisor dashboard<br>
            <b>Enterprise</b> — custom · API, SSO, white-label
          </div>
        </div>
        <div class="center" style="font-size:10px;color:#94A3B8;margin-top:12px;line-height:1.6">
          ${payLink('monthly')
            ? 'Payment opens in Flutterwave. Already paid? Switch Pro on in Settings → Subscription.'
            : 'Payments open soon — message us and we will switch Pro on for you.'}
          <br>WhatsApp ${esc(CONFIG.support.whatsappLabel)}
        </div>
      </div>`;
    pw.classList.add('show');
  }

  /* ---------------- render ------------------------------------------- */
  function render() {
    const shellEl = document.getElementById('shell');
    if (shellEl) shellEl.classList.toggle('w-open', S.view === 'welcome');
    const v = S.view;
    const titles = {
      home: null, actions: tradeName(S.trade), library: 'Troubleshooting',
      libdetail: 'Guide', diagnose: 'Diagnose a fault', newjob: 'New job card',
      jobcard: S.job ? S.job.ref : 'Job card', checklist: 'Checklist',
      photos: 'Job evidence', signoff: 'Sign-off', report: 'Service report',
      quote: 'Quotation', jobs: 'My jobs', settings: 'Settings', passport: 'Solar passport',
      team: 'My team', teamadd: 'Add a technician', teamjob: S.job ? S.job.ref : 'Crew job', company: 'Company stamp'
    };
    let bar = '';
    if (v !== 'boot' && v !== 'home' && v !== 'welcome') {
      const showBack = !['jobs', 'settings'].includes(v);
      bar = `<div class="appbar"><div class="row">
        ${showBack ? `<button class="back" onclick="ACT.back()">‹</button>` : '<div class="spacer"></div>'}
        <div style="flex:1;text-align:center">
          <div class="ttl">${titles[v] || ''}</div>
          ${v === 'jobcard' && S.job ? `<div class="sub">${esc(S.job.jobType || 'Job card')}${S.job.customer.name ? ' · ' + esc(S.job.customer.name) : ''}</div>` : ''}
          ${v === 'checklist' && S.job && S.job.checklist ? `<div class="sub">${esc(S.job.checklist.name)} · ${S.job.checklist.items.filter(i => i.passed).length}/${S.job.checklist.items.length}</div>` : ''}
        </div>
        ${showBack ? '<div class="spacer"></div>' : '<div class="spacer"></div>'}
      </div></div>`;
    }
    if (v === 'home') {
      bar = `<div class="appbar"><div class="row">
        <div class="brand"><div class="sq">R</div><b>REHOTEQ <em>Field</em></b></div>
        <div style="display:flex;gap:7px">
          <button class="iconbtn" onclick="ACT.go('jobs')">${ICON('search', 18)}</button>
          <button class="iconbtn" onclick="ACT.go('settings')">${ICON('settings-2', 18)}</button>
        </div></div>
        <div style="font-size:12px;color:var(--muted);margin-top:7px">
          Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'},
          <b style="color:var(--ink)">${esc((S.user && S.user.name) || 'there')}</b>
          ${!S.online ? ' · <span style="color:#DC2626">offline</span>' : ''}
        </div></div>`;
    }
    const hasTab = ['home', 'jobs', 'settings'].includes(v);
    const body = v === 'welcome' ? V.welcome() : (v === 'report' ? V.report() : `<div class="scroll">${(V[v] || V.home)()}</div>`);
    app().innerHTML = bar + body +
      (hasTab ? `<div class="tabbar">
        <button class="tab ${v === 'home' ? 'on' : ''}" onclick="ACT.go('home')"><span class="ti">${ICON('house', 20)}</span>Home</button>
        <button class="tab ${v === 'jobs' ? 'on' : ''}" onclick="ACT.go('jobs')"><span class="ti">${ICON('clipboard-list', 20)}</span>Jobs</button>
        <button class="tab" onclick="ACT.go('library')"><span class="ti">${ICON('wrench', 20)}</span>Guides</button>
        <button class="tab ${v === 'settings' ? 'on' : ''}" onclick="ACT.go('settings')"><span class="ti">${ICON('settings-2', 20)}</span>Settings</button>
      </div>` : '');

    postRender(v);
  }

  function postRender(v) {
    if (v === 'signoff') {
      // Re-hydrate the pads: the canvas is recreated on every render, so a
      // signature that was already saved has to be drawn back onto it.
      S._sig = {};
      ['customer', 'technician'].forEach(r => {
        const cv = $(r === 'customer' ? 'cvC' : 'cvT');
        if (!cv) return;
        S._sig[r] = bindSig(cv, () => {
          const ph = $('ph' + r[0].toUpperCase());
          if (ph) ph.style.display = 'none';
        });
        const s = S.job.signatures && S.job.signatures[r];
        if (s && s.dataUrl) {
          const img = new Image();
          img.onload = () => {
            const rect = cv.getBoundingClientRect();
            if (rect.width) cv.getContext('2d').drawImage(img, 0, 0, rect.width, rect.height);
            const ph = $('ph' + r[0].toUpperCase());
            if (ph) ph.style.display = 'none';
          };
          img.src = s.dataUrl;
        }
      });
    }
    if (v === 'passport' && S.passportEq && $('qrCv')) {
      QR.drawToCanvas($('qrCv'), QR.encode(CONFIG.passportUrl(S.passportEq.slug)), 3);
    }
    if (v === 'settings') {
      DB.pending().then(p => { const el = $('queueCount'); if (el) el.textContent = p.length + ' pending'; });
    }
    if (v === 'newjob' && S.job && S.job.site.lat === null) { /* nothing */ }
  }

  /* ---------------- actions ------------------------------------------ */
  const ACT = {
    go, toast,
    isOwner: () => isOwnerAccount(),
    canGenerateReport: canGenerateReport,

    async loginSaved(accountId) {
      if (accountId) return ACT.loginAccount(accountId);
      S.accounts = await loadAccounts();
      S.user = null;
      S.draftProfile = null;
      S.onboardMode = 'login';
      go('boot');
    },

    async loginAccount(accountId) {
      const accounts = await loadAccounts();
      const key = String(accountId || '').trim();
      const account = accounts.find(a => a && (String(a.uid) === key ||
        String(a.email || '').trim().toLowerCase() === key.toLowerCase())) ||
        (Number.isInteger(Number(key)) ? accounts[Number(key)] : null);
      if (!account) return toast('Saved account not found', 'Create a new profile or log in with a worker code');
      S.user = cloneRecord(account);
      delete S.user.lastLoginAt;
      if (!S.user.uid) S.user.uid = uid();
      S.fbUser = null;
      S.trade = S.user.trade || 'solar';
      S.job = null;
      S.photos = {};
      await DB.setMeta('user', S.user);
      await saveAccount(S.user);
      await TEAM.load();
      await refreshJobs();
      await refreshEquipment();
      await loadUsageLedger();
      S.onboardMode = 'individual';
      go('home');
      toast('Welcome back', S.user.name || S.user.email || 'Your profile is ready');
    },

    async workerCodeLogin(code) {
      const field = $('workerCode');
      const value = String(code || (field && field.value) || S.workerCode || '').trim().toUpperCase();
      if (!value) return toast('Enter your worker code');
      S.workerCode = value;
      const result = await TEAM.loginWithWorkerCode(value);
      if (!result.ok) {
        const e = teamErr(result.error);
        return toast(e[0], e[1]);
      }
      S.user = result.user || S.user;
      S.trade = (S.user && S.user.trade) || 'electrical';
      S.job = null;
      S.photos = {};
      S.workerCode = '';
      await TEAM.load();
      await refreshJobs();
      await refreshEquipment();
      await loadUsageLedger();
      go('home');
      toast('Worker login successful', myCompanyName() || 'Company workspace ready');
    },

    async logout() {
      if (S.user) await saveAccount(S.user);
      if (S.fbUser && window.FB && typeof window.FB.signOut === 'function') {
        try { await window.FB.signOut(); } catch (e) { /* local logout still succeeds */ }
      }
      S.fbUser = null;
      S.user = null;
      S.team = null;
      S.job = null;
      S.photos = {};
      S.jobs = [];
      S.equipment = [];
      S.draftProfile = null;
      S.workerCode = '';
      S.onboardMode = 'login';
      await DB.setMeta('user', null);
      S.accounts = await loadAccounts();
      go('boot');
      toast('Logged out', 'Your device account is saved on this phone');
    },

    setOnboardMode(mode) {
      const pick = id => { const el = $(id); return el ? el.value : null; };
      const cur = Object.assign({}, S.draftProfile || {}, S.user || {});
      if (pick('iName') !== null) cur.name = pick('iName');
      if (pick('iPhone') !== null) cur.phone = pick('iPhone');
      if (pick('iTrade') !== null) cur.trade = pick('iTrade');
      if (pick('iCompany') !== null) cur.company = pick('iCompany');
      if (pick('iEmail') !== null) cur.email = pick('iEmail');
      if (pick('iAddress') !== null) cur.address = pick('iAddress');
      if (pick('iBank') !== null) cur.bank = pick('iBank');
      if (pick('iBio') !== null) cur.bio = pick('iBio');
      S.draftProfile = cur;
      S.onboardMode = mode === 'company' ? 'company' : 'individual';
      render();
    },

    async openTeamJoin() {
      if (!S.user || !S.user.name) {
        const nameEl = $('iName');
        const phoneEl = $('iPhone');
        const tradeEl = $('iTrade');
        const name = (nameEl && nameEl.value.trim()) || 'Technician';
        const phone = (phoneEl && phoneEl.value.trim()) || '';
        const trade = (tradeEl && tradeEl.value) || 'solar';
        S.user = {
          uid: uid(), name: name, phone: phone, trade: trade,
          company: 'REHOTEQ Technologies', plan: 'free', ownerAccess: false,
          bank: '', address: '', email: '', logo: null, bio: ''
        };
        await DB.setMeta('user', S.user);
        await saveAccount(S.user);
      }
      go('team');
      ACT.receiveFile();
    },

    async setPlan(plan) {
      if (!['free', 'pro', 'business'].includes(plan)) return;
      S.user = S.user || {};
      S.user.plan = plan;
      if (isOwnerAccount(S.user, S.fbUser)) S.user.ownerAccess = true;
      await DB.setMeta('user', S.user);
      await saveAccount(S.user);
      render();
      toast('Plan set to ' + plan.charAt(0).toUpperCase() + plan.slice(1),
        isOwnerAccount(S.user, S.fbUser) ? 'Owner access — all plans unlocked' : '');
    },

    async saveProfile() {
      const name = $('iName').value.trim();
      if (!name) return toast('Enter your name');
      const prev = S.user || S.draftProfile || {};
      const wasCompanyMode = S.onboardMode === 'company';
      S.user = {
        uid: prev.uid || uid(),
        name: name, phone: $('iPhone').value.trim(), trade: $('iTrade').value,
        company: $('iCompany').value.trim() || 'REHOTEQ Technologies',
        plan: prev.plan || 'free',
        ownerAccess: Boolean(prev.ownerAccess),
        // carried through untouched — these are edited on the same screen
        // once a profile exists, and must not be wiped on first run
        bank: prev.bank || '', address: prev.address || '',
        email: prev.email || '', logo: prev.logo || null,
        bio: prev.bio || ''
      };
      if (prev.memberOf) S.user.memberOf = prev.memberOf;
      // the document fields are only rendered when editing an existing
      // profile or starting in company mode, so read them defensively
      const pick = id => { const el = $(id); return el ? el.value.trim() : null; };
      if (pick('iAddress') !== null) S.user.address = pick('iAddress');
      if (pick('iEmail') !== null) S.user.email = pick('iEmail');
      if (pick('iBank') !== null) S.user.bank = pick('iBank');
      if (pick('iBio') !== null) S.user.bio = pick('iBio');

      const wasOwnerProfile = isOwnerEmail(prev.email) || Boolean(prev.ownerAccess);
      const isOwnerProfile = isOwnerEmail(S.user.email);
      if (isOwnerProfile) {
        S.user.ownerAccess = true;
        if (!wasOwnerProfile && (!prev.plan || prev.plan === 'free')) S.user.plan = 'business';
      } else if (wasOwnerProfile) {
        // Owner access belongs to the owner email, not to stale profile
        // state. Changing that email returns the profile to the Free plan.
        S.user.ownerAccess = false;
        S.user.plan = 'free';
      } else {
        S.user.ownerAccess = false;
      }

      S.trade = S.user.trade;
      S.draftProfile = null;
      S.onboardMode = 'individual';
      await DB.setMeta('user', S.user);
      await saveAccount(S.user);
      if (wasCompanyMode && TEAM.role() === 'none') {
        await TEAM.createCompany();
      }
      await refreshJobs();
      await refreshEquipment();
      go('home');
      if (isOwnerAccount(S.user, S.fbUser)) {
        toast('Welcome, Owner', 'All plans (Free, Pro & Business) are unlocked for ' + S.user.email);
      } else if (wasCompanyMode) {
        toast('Company workspace ready', S.user.company + ' stamp is set for your crew');
      }
    },

    async editProfile() { S.onboardMode = 'individual'; S.user = S.user || {}; go('boot'); },

    pickLogo() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          S.user = S.user || {};
          S.user.logo = await compressLogo(f);
          await DB.setMeta('user', S.user);
          render();
          toast('Logo added', 'It now appears on every report and quotation');
        } catch (e) {
          toast('Could not read that image', String((e && e.message) || e));
        }
      };
      input.click();
    },

    async removeLogo() {
      if (!S.user) return;
      delete S.user.logo;
      await DB.setMeta('user', S.user);
      render();
      toast('Logo removed');
    },

    setTrade(t) { S.trade = t; if (S.user) { S.user.trade = t; DB.setMeta('user', S.user); } render(); },
    search(v) { S.search = v; const el = $('iSearch'); render(); const n = $('iSearch'); if (n) { n.focus(); n.setSelectionRange(v.length, v.length); } },

    set(path, value) {
      const parts = path.split('.');
      let o = S.job;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      o[parts[parts.length - 1]] = value;
      if (path === 'labour') S.job.labour = Number(value) || 0;
      saveJob();
    },
    setMat(i, k, v) {
      S.job.materials[i][k] = (k === 'desc') ? v : Number(v) || 0;
      saveJob();
    },
    addMaterial() { S.job.materials.push({ desc: '', qty: 1, unitPrice: 0 }); saveJob(); render(); },
    delMat(i) { S.job.materials.splice(i, 1); saveJob(); render(); },

    voice(key, btn) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return toast('Voice typing is not supported here', 'Chrome on Android works best');
      const rec = new SR();
      rec.lang = 'en-NG'; rec.interimResults = false; rec.maxAlternatives = 1;
      btn.classList.add('rec');
      rec.onresult = e => {
        const said = e.results[0][0].transcript;
        S.job[key] = (S.job[key] ? S.job[key] + ' ' : '') + said;
        saveJob(); render();
        toast('Added', said);
      };
      rec.onerror = () => toast('Could not hear you', 'Check microphone permission');
      rec.onend = () => btn.classList.remove('rec');
      rec.start();
    },

    gps() {
      getGps(p => {
        S.job.site.lat = p.lat; S.job.site.lng = p.lng;
        if (!S.job.site.address) S.job.site.address = p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
        saveJob();
        const el = $('fAddr'); if (el) el.value = S.job.site.address;
        const gl = $('gpsLine');
        if (gl) gl.innerHTML = '<b>' + ICON('map-pin',12) + ' GPS captured</b> · ' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + ' · ±' + Math.round(p.acc) + ' m';
        toast('Location captured', 'This is stamped onto every photo and the report');
      });
    },

    async startJob() {
      S.job = await newJob();
      await saveJob();
      go('newjob');
    },
    async openJob(id) {
      S.job = (await DB.all('jobs')).find(j => j.id === id);
      if (!S.job) return toast('Job not found');
      S.trade = S.job.trade;
      await loadPhotos(id);
      // The owner's copy of an assigned job opens read-only: the next
      // update file would overwrite any edit made here.
      if (TEAM.isShadow(S.job)) return go('teamjob');
      // First touch by the assigned technician moves it to in progress,
      // so the owner's dashboard tells the truth without anyone typing.
      if (TEAM.isMine(S.job) && S.job.status === 'assigned') {
        S.job.status = 'in-progress';
        await saveJob();
      }
      go(S.job.lockedAt ? 'report' : 'jobcard');
    },
    async saveDraft() { await saveJob(); toast('Draft saved'); go('jobs'); },
    async toJobCard() {
      if (!S.job.jobType) return toast('Choose a job type first');
      await saveJob(); go('jobcard');
    },

    tick(i) {
      const it = S.job.checklist.items[i];
      it.passed = !it.passed;
      saveJob(); render();
    },
    doneChecklist() {
      const blocked = S.job.checklist.items.filter(i => i.critical && !i.passed);
      if (blocked.length) return toast(blocked.length + ' critical item(s) not done', blocked[0].l);
      saveJob(); go('photos');
    },

    pick(stage) { pickPhoto(stage); },
    async delPhoto(id) {
      await DB.del('photos', id);
      await loadPhotos(S.job.id);
      render(); toast('Photo removed');
    },

    clearSig(role) {
      if (S._sig && S._sig[role]) S._sig[role].clear();
      const ph = $('ph' + role[0].toUpperCase());
      if (ph) ph.style.display = '';
    },
    async saveSig(role) {
      const cv = $(role === 'customer' ? 'cvC' : 'cvT');
      const nameEl = $(role === 'customer' ? 'sigCustName' : 'sigTechName');
      const dataUrl = cv.toDataURL('image/png');
      // blank check
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) ink++;
      if (ink < 40) return toast('Nothing to save', 'Ask them to sign in the box');
      S.job.signatures[role] = { dataUrl: dataUrl, name: nameEl.value.trim() || 'Signed', at: new Date().toISOString() };
      if (role === 'customer' && !S.job.customer.name) S.job.customer.name = nameEl.value.trim();
      await saveJob();
      render(); toast((role === 'customer' ? 'Customer' : 'Technician') + ' signature saved');
    },

    async finish() {
      if (!S.job) return toast('Open a job first');
      const s = S.job.signatures || {};
      if (!s.customer || !s.technician) return toast('Both signatures are needed', 'That is what locks the job as evidence');
      if (!(await canGenerateReport(S.job))) return showPaywall();
      S.job.completedAt = new Date().toISOString();
      S.job.lockedAt = new Date().toISOString();
      S.job.status = 'completed';
      await saveJob();
      await refreshEquipment();
      go('report');
    },

    back() {
      const hasProfile = Boolean(S.user && S.user.name);
      const map = {
        actions: 'home', library: hasProfile ? 'home' : 'boot', libdetail: 'library',
        diagnose: (S.job && !S.job.lockedAt) ? 'jobcard' : 'actions',
        newjob: 'actions',
        jobcard: 'newjob', checklist: 'jobcard', photos: 'jobcard', signoff: 'photos',
        report: hasProfile ? 'signoff' : 'boot', quote: 'report', passport: 'home',
        team: hasProfile ? 'settings' : 'boot', teamjob: 'team', company: 'team'
      };
      go(map[S.view] || (hasProfile ? 'home' : 'boot'));
    },

    /* --- V3 fault diagnosis ----------------------------------------- */
    openDiagnose() {
      S.diag.trade = (S.job && S.job.trade) || S.trade || 'solar';
      if (S.job && !S.job.lockedAt && S.job.fault && !S.diag.fault) {
        S.diag.fault = S.job.fault;
      }
      go('diagnose');
    },
    setDiag(key, val) {
      S.diag[key] = val;
      if (key === 'trade') render();
    },
    clearDiag() {
      S.diag.fault = '';
      S.diag.code = '';
      S.diag.equipment = '';
      S.diag.result = null;
      render();
    },
    voiceDiag(btn) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return toast('Voice typing is not supported here', 'Chrome on Android works best');
      const rec = new SR();
      rec.lang = 'en-NG'; rec.interimResults = false; rec.maxAlternatives = 1;
      btn.classList.add('rec');
      rec.onresult = e => {
        const said = e.results[0][0].transcript;
        S.diag.fault = (S.diag.fault ? S.diag.fault + ' ' : '') + said;
        render();
        toast('Added', said);
      };
      rec.onerror = () => toast('Could not hear you', 'Check microphone permission');
      rec.onend = () => btn.classList.remove('rec');
      rec.start();
    },
    async runDiagnose() {
      if (!S.online) {
        return toast('You are offline', 'AI diagnosis needs a connection — use the offline Troubleshooting library');
      }
      const fEl = $('dFault'), cEl = $('dCode'), tEl = $('dTrade');
      if (fEl) S.diag.fault = fEl.value.trim();
      if (cEl) S.diag.code = cEl.value.trim();
      if (tEl) S.diag.trade = tEl.value;
      if (!S.diag.fault && !S.diag.code) {
        return toast('Describe the fault first', 'Enter what the customer reported or the error code');
      }
      S.diag.busy = true;
      render();
      try {
        const r = await DIAG.diagnose({
          trade: S.diag.trade,
          fault: S.diag.fault,
          code: S.diag.code,
          equipment: S.diag.equipment
        });
        S.diag.busy = false;
        render();
        if (!r.ok) {
          if (r.error === 'offline') return toast('You are offline', 'Use the offline Troubleshooting library');
          return toast('Describe the fault first');
        }
        if (r.result.status === 'refused') {
          return toast('Out of scope', 'Requires a ' + r.result.specialist);
        }
        if (r.result.status === 'no_match') {
          return toast('No verified entry in the library', 'We do not guess on live equipment');
        }
        toast('Diagnosis ready', 'Confirm the cause you verify on site before it enters the job card');
      } catch (e) {
        S.diag.busy = false;
        render();
        toast('Could not run diagnosis', String((e && e.message) || e));
      }
    },
    async confirmCause(index) {
      const r = await DIAG.confirmCause(index);
      if (!r.ok) return toast('Pick a verified cause first');
      go(r.view);
      toast('Cause confirmed — added to job card', r.cause.t);
    },

    // Was inline as "S.passportEq=null;render()" — neither S nor render is
    // reachable from the page, so the button was dead.
    closePassport() { S.passportEq = null; render(); },

    /* Share-sheet actions. These used to be bolted onto ACT from inside
       showShareSheet(), which meant no audit could see them and a throw
       before the assignment left the buttons dead. Declared here instead. */
    dl(url, filename) {
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      toast('Saved to Downloads');
    },
    quote() {
      $('paywall').classList.remove('show');
      S.quote = null;
      go('quote');
    },

    openLib(id) { S.libEntry = DATA.LIBRARY.find(e => e.id === id); go('libdetail'); },
    async jobFromLib() {
      S.job = await newJob();
      S.job.trade = S.libEntry.trade;
      S.job.fault = S.libEntry.symptom + (S.libEntry.code ? ' (' + S.libEntry.code + ')' : '');
      S.job.materials = S.libEntry.parts.filter(p => p.price).map(p => ({ desc: p.d, qty: 1, unitPrice: p.price }));
      await saveJob();
      go('newjob');
      toast('Started from the guide', 'Fill in the customer and location');
    },

    async pdf() {
      if (!S.job) return toast('Open a job first');
      if (!(await canGenerateReport(S.job))) return showPaywall();
      try {
        toast('Building PDF…');
        const blob = await makeReportPdf();
        S.job.status = 'sent';
        await saveJob();
        await shareOrDownload(blob, S.job.ref + '.pdf',
          'Service report ' + S.job.ref + ' — ' + ((S.user && S.user.company) || 'REHOTEQ Technologies'));
      } catch (e) {
        console.error(e);
        toast('Could not build the PDF', String(e.message || e));
      }
    },

    async quotePdf() {
      try {
        toast('Building quotation…');
        const bytes = REPORT.buildQuote(S.quote, S.job, docProfile());
        await shareOrDownload(pdfBlob(bytes), S.quote.number + '.pdf',
          'Quotation ' + S.quote.number + ' — ' + money(S.quote.total));
      } catch (e) { console.error(e); toast('Could not build the PDF', String(e.message || e)); }
    },

    setQuote(k, v) { S.quote[k] = (k === 'notes' || k === 'terms' || k === 'subject') ? v : Number(v) || 0; render(); },
    addQuoteItem() { S.quote.items.push({ desc: '', qty: 1, unitPrice: 0 }); render(); },
    delQuoteItem(i) { S.quote.items.splice(i, 1); render(); },
    setQuoteItem(i, k, v) { S.quote.items[i][k] = (k === 'desc') ? v : Number(v) || 0; render(); },

    goPlan() { showPaywall(); },
    closePaywall() { $('paywall').classList.remove('show'); },

    payMonthly() { openPayment(payLink('monthly'), 'Flutterwave'); },
    payAnnual() { openPayment(payLink('annual'), 'Flutterwave'); },
    payBusiness() { openPayment(payLink('business'), 'Flutterwave'); },

    subscribe() {
      const msg = 'Hello REHOTEQ — I would like to subscribe to REHOTEQ Field Pro ' +
        '(' + money(DATA.PLANS.pro.price) + ' / month). My name is ' + ((S.user && S.user.name) || '') + '.';
      window.open(CONFIG.waUrl(msg), '_blank');
      toast('WhatsApp opened', 'Send the message and we will switch Pro on for you');
    },

    contact() {
      window.open(CONFIG.waUrl('Hello REHOTEQ — '), '_blank');
    },
    // Sign-in is a redirect, so the app reloads and firebase.js calls
    // finishRedirect() on the way back in. A failure here must never
    // leave the technician stuck: the app is usable without an account.
    async signIn() {
      if (!window.FB || !window.FB.enabled()) {
        return toast('Sign-in is not switched on yet', 'Everything else works without it');
      }
      DB.setMeta('welcomeSeen', true);
      try {
        await window.FB.signIn();
      } catch (e) {
        toast('Could not reach the sign-in page', 'Check your connection and try again');
      }
    },
    async enterApp() {
      await DB.setMeta('welcomeSeen', true);
      go(S.user ? 'home' : 'boot');
    },
    async signOut() {
      if (!window.FB) return;
      try { await window.FB.signOut(); } catch (e) { /* already out */ }
      S.fbUser = null;
      render();
      toast('Signed out', 'Your job cards stay on this phone');
    },

    togglePlan(el) {
      S.user.plan = S.user.plan === 'free' ? 'pro' : 'free';
      el.classList.toggle('on', S.user.plan !== 'free');
      DB.setMeta('user', S.user);
      toast(S.user.plan === 'pro' ? 'Switched to Pro' : 'Switched to Free');
      setTimeout(render, 500);
    },

    openPassport(id) { S.passportEq = (S.equipment || []).find(e => e.id === id); render(); },
    printQr() {
      const cv = $('qrCv');
      const w = window.open('', '_blank');
      if (!w) return toast('Allow pop-ups to print');
      w.document.write('<html><head><title>Solar passport</title><style>' +
        'body{font-family:system-ui;text-align:center;padding:30px}' +
        'h2{margin:0 0 4px;font-size:18px}p{margin:0 0 14px;color:#555;font-size:13px}' +
        'img{width:260px;image-rendering:pixelated}.ref{font-family:monospace;font-size:11px;color:#888;margin-top:10px}' +
        '@media print{button{display:none}}</style></head><body>' +
        '<h2>REHOTEQ Field — Solar passport</h2>' +
        '<p>' + esc(S.passportEq.customerName || '') + '</p>' +
        '<img src="' + cv.toDataURL() + '">' +
        '<div class="ref">' + esc(S.passportEq.serial) + '</div>' +
        '<div class="ref">' + esc(S.passportEq.capacity || '') + ' ' + esc(S.passportEq.model || '') + '</div>' +
        '<p style="margin-top:16px;font-size:12px">Scan for warranty, service history and fault reporting</p>' +
        '<button onclick="window.print()" style="padding:10px 18px;margin-top:6px">Print</button>' +
        '</body></html>');
      w.document.close();
    },

    async syncInfo() {
      const p = await DB.pending();
      toast(p.length + ' item(s) waiting to sync',
        'Supabase sync lands in Phase 3. Nothing is lost — everything is on this device.');
    },

    /* --- BACKUP ------------------------------------------------------
       A backup you cannot restore from is not a backup. Export writes
       everything — jobs, photos and settings — and Restore reads it back
       onto any device. Until this exists, real job data lives only in
       one phone's IndexedDB, which is one dropped phone from gone.
       ---------------------------------------------------------------- */
    async exportAll(withPhotos) {
      const jobs = await DB.all('jobs');
      const photos = await DB.all('photos');
      const photoRecs = [];
      let skipped = 0;
      if (withPhotos) {
        for (const p of photos) {
          let image = null;
          // One unreadable photo must never take the whole backup down.
          try {
            if (p.blob) image = await blobToBase64(p.blob);
          } catch (e) {
            skipped++;
          }
          if (!image) skipped += (p.blob ? 0 : 1);
          photoRecs.push({
            id: p.id, jobId: p.jobId, stage: p.stage, sha256: p.sha256,
            capturedAt: p.capturedAt, lat: p.lat, lng: p.lng, w: p.w, h: p.h,
            device: p.device, image: image
          });
        }
      }
      const out = {
        format: 'rehoteq-field-backup', version: 1,
        exportedAt: new Date().toISOString(), user: S.user || null,
        jobs: jobs,
        photos: withPhotos ? photoRecs : [],
        photoCount: photos.length,
        team: TEAM.serialize()
      };
      const json = JSON.stringify(out);
      const blob = new Blob([json], { type: 'application/json' });
      const stamp = new Date().toISOString().slice(0, 10);
      const name = 'rehoteq-field-backup-' + stamp + (withPhotos ? '-full' : '-text') + '.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      await DB.setMeta('lastBackup', new Date().toISOString());
      S.lastBackup = new Date().toISOString();
      toast('Backup saved — ' + name,
        (blob.size / 1024 / 1024).toFixed(1) + ' MB · ' + jobs.length + ' jobs' +
        (withPhotos
          ? ' · ' + (photoRecs.length - skipped) + '/' + photos.length + ' photos' +
            (skipped ? ' · ' + skipped + ' image(s) missing' : '')
          : ' · no photos'));
      render();
    },

    // Share the backup off the phone — a file sitting in Downloads is one
    // factory reset away from gone too.
    async shareBackup() {
      const jobs = await DB.all('jobs');
      const photos = await DB.all('photos');
      const recs = [];
      for (const p of photos) {
        let image = null;
        try { if (p.blob) image = await blobToBase64(p.blob); } catch (e) { /* skip */ }
        recs.push({
          id: p.id, jobId: p.jobId, stage: p.stage, sha256: p.sha256,
          capturedAt: p.capturedAt, lat: p.lat, lng: p.lng, w: p.w, h: p.h,
          image: image
        });
      }
      const out = {
        format: 'rehoteq-field-backup', version: 1,
        exportedAt: new Date().toISOString(), user: S.user || null,
        jobs: jobs, photos: recs, photoCount: photos.length,
        team: TEAM.serialize()
      };
      const file = new File([JSON.stringify(out)],
        'rehoteq-field-backup-' + new Date().toISOString().slice(0, 10) + '.json',
        { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'REHOTEQ Field backup' });
          await DB.setMeta('lastBackup', new Date().toISOString());
          S.lastBackup = new Date().toISOString();
          render();
          return toast('Backup sent', 'Keep it somewhere off this phone — email it to yourself');
        } catch (e) { /* cancelled */ }
      }
      toast('Sharing not available here', 'Use "Download backup" and move the file yourself');
    },

    importBackup() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const data = JSON.parse(text);
          if (data.format !== 'rehoteq-field-backup') {
            return toast('That is not a REHOTEQ backup file', 'Pick the file the app downloaded');
          }
          const jobs = Array.isArray(data.jobs) ? data.jobs : [];
          const photos = Array.isArray(data.photos) ? data.photos : [];
          if (!jobs.length && !photos.length) return toast('That backup is empty');

          // merge, never blind-replace: a restore must not destroy newer work
          let addedJ = 0, updatedJ = 0;
          for (const j of jobs) {
            const existing = await DB.get('jobs', j.id);
            if (!existing) addedJ++; else updatedJ++;
            await DB.put('jobs', j);
          }
          let addedP = 0, noImage = 0;
          for (const p of photos) {
            const rec = Object.assign({}, p);
            if (rec.image) {
              try { rec.blob = base64ToBlob(rec.image, 'image/jpeg'); }
              catch (e) { rec.blob = null; noImage++; }
            } else { noImage++; }
            delete rec.image;
            const existing = await DB.get('photos', rec.id);
            if (!existing) addedP++;
            await DB.put('photos', rec);
          }
          if (data.user) { S.user = data.user; await DB.setMeta('user', data.user); }
          // Backups from before teams existed carry no team key at all;
          // restore() treats that as "nothing to do" rather than an error.
          const teamNote = data.team ? await TEAM.restore(data.team) : null;

          await refreshJobs();
          await loadUsageLedger();
          await refreshEquipment();
          const all = await DB.all('photos');
          all.forEach(p => { if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob); });
          S.photos = {};
          go('home');
          toast('Restored ' + addedJ + ' jobs, ' + addedP + ' photos',
            (noImage ? noImage + ' photo(s) had no image data · ' : '') +
            (teamNote && (teamNote.company || teamNote.membersAdded)
              ? 'crew restored · ' : '') +
            (updatedJ ? updatedJ + ' existing job(s) updated' : 'Nothing overwritten'));
        } catch (e) {
          toast('Could not read that file', String(e.message || e));
        }
      };
      input.click();
    },

    async wipe() {
      if (!confirm('Delete every job, photo and setting on this device? This cannot be undone.')) return;
      const ledger = await loadUsageLedger();
      for (const s of ['jobs', 'photos', 'customers', 'equipment', 'meta', 'outbox']) {
        const all = await DB.all(s);
        for (const r of all) {
          // The device-wide free-report ledger is intentionally outside the
          // wipe boundary so a fresh profile cannot reclaim used free slots.
          if (s === 'meta' && r.id === 'usageLedger') continue;
          await DB.del(s, r.id);
        }
      }
      await persistUsageLedger(ledger);
      S.job = null; S.jobs = []; S.user = null; S.equipment = [];
      S.accounts = []; S.team = null; S.photos = {}; S.draftProfile = null;
      S.onboardMode = 'individual';
      go('boot'); toast('Everything deleted', 'Your free report usage stays on this device');
    },

    async loadDemo() {
      const j = await newJob();
      j.isDemo = true;
      j.trade = 'solar';
      j.jobType = 'Inverter fault diagnosis';
      j.customer = { name: 'Mr. Adewale Ade', phone: '0803 000 0000', address: '14 Adeyemi St, Okitipupa' };
      j.site = { address: '14 Adeyemi St, Okitipupa, Ondo State', lat: 6.4975, lng: 4.7814 };
      j.equipment = {
        category: 'Hybrid inverter', model: 'SMS-II 6.2K', serial: 'SMS62-2024-88314',
        capacity: '6.2 kVA', installDate: '2025-07-24'
      };
      j.fault = 'Low battery warning; E03 on load. Inverter shuts down when the fridge starts.';
      j.diagnosis = 'Loose DC terminal on battery 3. Bank drops to 44.1 V under load, triggering overcurrent protection.';
      j.work = 'Re-terminated DC lugs, torqued to 12 Nm, rebalanced bank, ran a 15-minute load test at 2.1 kW.';
      j.recommendation = 'Battery bank at 71% state of health. Budget for replacement within 6 months.';
      j.materials = [
        { desc: '35 mm² copper lug', qty: 2, unitPrice: 1500 },
        { desc: 'Heat-shrink kit', qty: 1, unitPrice: 1500 }
      ];
      j.labour = 25000;
      j.checklist = {
        name: 'Inverter fault diagnosis', version: 1,
        items: DATA.CHECKLISTS['solar|Inverter fault diagnosis'].items.map((i, n) => Object.assign({}, i, { passed: n < 9 }))
      };
      j.completedAt = new Date().toISOString();
      j.lockedAt = new Date().toISOString();
      j.status = 'completed';
      j.hashes = ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'];
      S.job = j;
      await saveJob();
      await refreshEquipment();
      S.photos[j.id] = { before: [], during: [], after: [], serial: [] };
      go('report');
      toast('Demo job loaded', 'Tap Generate PDF to see the real output');
    },

    /* --- TEAM ----------------------------------------------------------
       Every transfer below is a file the technician sends on WhatsApp.
       Nothing here needs a server, a signal, or an account.
       ---------------------------------------------------------------- */
    async openTeam() { await TEAM.load(); go('team'); },

    async createCompany() {
      const r = await TEAM.createCompany();
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      render();
      toast('Crew created — ' + r.company.name, 'Invite your technicians next');
    },

    async saveCompany() {
      const v = id => { const el = $(id); return el ? el.value.trim() : ''; };
      const r = await TEAM.saveCompany({ name: v('cName') || 'My company',
        address: v('cAddr'), phone: v('cPhone'), email: v('cEmail'), bank: v('cBank'), bio: v('cBio') });
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      go('team');
      toast('Company stamp saved', 'It prints on every PDF your crew sends');
    },

    pickCompanyLogo() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const logo = await compressLogo(f);
          await TEAM.saveCompany({ logo: logo });
          render();
          toast('Stamp logo added', 'It now appears on every crew PDF');
        } catch (e) { toast('Could not read that image', String((e && e.message) || e)); }
      };
      input.click();
    },

    async removeCompanyLogo() {
      await TEAM.saveCompany({ logo: null });
      render();
      toast('Stamp logo removed');
    },

    async createWorkerLogin() {
      const field = $('workerLoginName');
      const name = field ? field.value.trim() : '';
      const r = await TEAM.createWorkerLogin({ name: name });
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      render();
      toast('Worker login created', r.worker.code + ' · send the login file to your worker');
    },

    async sendWorkerLogin(code) {
      const file = TEAM.workerLoginFile(code);
      if (!file) return toast('Worker login is no longer available', 'Create a new code for this worker');
      return ACT.shareWorkerFile(file, 'rehoteq-worker-login-' + file.code + '.json',
        'Worker login ready — code ' + file.code);
    },

    async shareWorkerFile(file, filename, sentMessage) {
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'worker-login') {
        return toast('Worker login file is invalid');
      }
      return shareTeamFile(file, filename || ('rehoteq-worker-login-' + file.code + '.json'),
        sentMessage || ('Worker login ready — code ' + file.code));
    },

    async makeInvite() {
      const r = await TEAM.makeInvite();
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      ACT.go('teamadd');
      await shareTeamFile(r.file, 'rehoteq-invite-' + r.invite.code + '.json',
        'Invite sent — code ' + r.invite.code);
      render();
    },

    async resendInvite(code) {
      const f = TEAM.inviteFile(code);
      if (!f) return toast('That invite is gone', 'Create a fresh one');
      await shareTeamFile(f, 'rehoteq-invite-' + code + '.json', 'Invite sent — code ' + code);
    },

    async revokeInvite(code) {
      if (!confirm('Revoke invite ' + code + '?')) return;
      await TEAM.revokeInvite(code);
      render();
      toast('Invite revoked');
    },

    receiveFile() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        let data;
        try { data = JSON.parse(await f.text()); }
        catch (e) { return toast('Could not read that file', 'Pick the .json file the app sent'); }
        if (data.format === 'rehoteq-field-backup') {
          const e = teamErr('backup'); return toast(e[0], e[1]);
        }
        if (!data || data.format !== TEAM_FORMAT || !data.kind) {
          const e = teamErr('notteam'); return toast(e[0], e[1]);
        }
        if (data.kind === 'worker-login') {
          const imported = await TEAM.importWorkerLogin(data);
          if (!imported.ok) { const e = teamErr(imported.error); return toast(e[0], e[1]); }
          S.workerCode = imported.code;
          if (!S.user) {
            S.accounts = await loadAccounts();
            S.onboardMode = 'login';
            go('boot');
          } else { render(); }
          return toast('Worker login file imported', 'Enter ' + imported.code + ' under Log in / Worker');
        }
        await TEAM.load();
        let r;
        if (data.kind === 'invite') r = await TEAM.applyInvite(data);
        else if (data.kind === 'acceptance') r = await TEAM.applyAcceptance(data);
        else if (data.kind === 'assignment') r = await TEAM.applyAssignment(data);
        else if (data.kind === 'update') r = await TEAM.applyUpdate(data);
        else if (data.kind === 'removal') r = await TEAM.applyRemoval(data);
        else { const e = teamErr('notteam'); return toast(e[0], e[1]); }
        if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
        if (data.kind === 'invite') {
          go('team');
          return toast('You joined ' + r.company, 'Now send your acceptance back');
        }
        if (data.kind === 'acceptance') {
          render();
          const s = TEAM.seats();
          return toast(r.member.name + ' joined your crew',
            r.again ? 'Details updated' : 'Seat ' + s.used + ' of ' + s.paid);
        }
        if (data.kind === 'assignment') {
          render();
          return toast('New job from ' + (data.ownerName || 'your oga') + ' — ' + r.job.ref,
            (r.photos ? r.photos + ' photo(s) came with it · ' : '') + 'Open it from My jobs');
        }
        if (data.kind === 'update') {
          render();
          return toast('Update on ' + r.job.ref + ' — ' + TEAM.statusLabel(r.job.status),
            TEAM.memberName(r.job.assignedTo));
        }
        if (data.kind === 'removal') {
          render();
          return toast('You were removed from ' + r.company, 'Your job cards stay on this phone');
        }
      };
      input.click();
    },

    async sendAcceptance() {
      const f = TEAM.acceptanceFile();
      if (!f) return toast('Nothing to send', 'Join a crew first');
      await shareTeamFile(f, 'rehoteq-acceptance-' + f.code + '.json', 'Acceptance sent');
      await TEAM.markAcceptanceSent();
      render();
    },

    assignJob() {
      const t = teamState();
      if (!t.members.length) return toast('Invite a technician first', 'There is nobody to assign to yet');
      const rows = t.members.map(m => `
        <div class="rowitem" onclick="ACT.pickAssignee('${m.memberId}')">
          <div class="dotg"></div><div style="flex:1"><div class="jt">${esc(m.name)}</div>
          <div class="js">${esc(m.phone || 'No number')}</div></div>
          <div style="color:#94A3B8">›</div></div>`).join('');
      const sheet = $('paywall');
      sheet.innerHTML = `
        <div class="pwsheet"><div class="center" style="margin-bottom:12px">
          <div style="font-size:15px;font-weight:750">Assign ${esc(S.job.ref)} to…</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:4px">
            They get the job as a file — instructions pinned, your stamp on it.</div></div>
          <div class="card">${rows}</div>
          <button class="btn ghost sm" onclick="ACT.closePaywall()">Cancel</button></div>`;
      sheet.classList.add('show');
    },

    async pickAssignee(memberId) {
      $('paywall').classList.remove('show');
      const r = await TEAM.makeAssignment(S.job.id, memberId);
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      await shareTeamFile(r.file, 'rehoteq-job-' + S.job.ref + '.json',
        'Assigned to ' + r.member.name);
      go('team');
    },

    async sendUpdate() {
      const r = await TEAM.makeUpdate(S.job.id);
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      await shareTeamFile(r.file, 'rehoteq-update-' + S.job.ref + '.json', 'Update sent to your oga');
    },

    async removeMember(memberId) {
      const m = memberById(memberId);
      if (!m) return;
      if (!confirm('Remove ' + m.name + ' from your crew? Their seat frees up.')) return;
      const r = await TEAM.makeRemoval(memberId);
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      render();
      await shareTeamFile(r.file,
        'rehoteq-removal-' + m.name.replace(/[^A-Za-z0-9]+/g, '') + '.json',
        m.name + ' removed — send them this notice');
      render();
    },

    async leaveTeam() {
      if (!confirm('Leave your crew? Your job cards stay, but new PDFs lose the company stamp.')) return;
      const r = await TEAM.leaveTeam();
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      render();
      toast('You left ' + r.company, 'Your job cards stay on this phone');
    },

    toggleMember(id) {
      const t = teamState();
      t.sel = (t.sel === id) ? null : id;
      render();
    },

    nudgeMember(memberId) {
      const m = memberById(memberId);
      if (!m) return;
      const num = CONFIG.waNumber(m.phone || '');
      if (!num) return toast('No usable number for ' + m.name, 'Ask them for it and update their record');
      window.open('https://wa.me/' + num + '?text=' +
        encodeURIComponent('Hello ' + m.name + ' — update your REHOTEQ jobs when you can.'), '_blank');
    },

    buySeats() {
      const s = TEAM.seats();
      const biz = DATA.PLANS.business;
      const sheet = $('paywall');
      sheet.innerHTML = '<div class="pwsheet"><div class="center" style="margin-bottom:12px">' +
        '<div style="font-size:15px;font-weight:750">Add seats</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:4px">' +
        s.used + ' of ' + s.paid + ' seats used · extra seats ' + money(biz.extraSeat) + ' / month each</div></div>' +
        '<div class="field"><label class="fl">How many extra seats?</label>' +
        '<input id="seatN" type="number" value="1" min="1" max="20"></div>' +
        (payLink('business')
          ? '<button class="btn primary" onclick="ACT.payBusiness()">Pay on Flutterwave</button>'
          : '<button class="btn primary" onclick="ACT.seatsWhatsApp()">Message us to pay</button>') +
        '<button class="btn ghost sm" style="margin-top:9px" onclick="ACT.claimSeats()">I have paid — add the seats</button>' +
        '<button class="btn ghost sm" style="margin-top:9px" onclick="ACT.closePaywall()">Cancel</button>' +
        '<div class="center" style="font-size:10.5px;color:#94A3B8;margin-top:12px;line-height:1.6">' +
        'Seats are added on your word and recorded for sync — REHOTEQ verifies payment when the server lands.</div></div>';
      sheet.classList.add('show');
    },

    async claimSeats() {
      const el = $('seatN');
      const r = await TEAM.claimSeats(el ? el.value : 1);
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      $('paywall').classList.remove('show');
      render();
      toast(r.added + ' seat(s) added — ' + r.paid + ' total', 'Recorded for REHOTEQ to verify');
    },

    seatsWhatsApp() {
      const msg = 'Hello REHOTEQ — I need extra Business seats for my crew. My name is ' +
        ((S.user && S.user.name) || '') + '.';
      window.open(CONFIG.waUrl(msg), '_blank');
    },

    // Test seams: these let the suite verify real screen transitions and
    // report guards without copying the app's private state machine.
    _view() { return S.view; },
    _setJobForTest(job) { S.job = job ? cloneRecord(job) : null; }
  };
  window.ACT = ACT;

  /* ---------------- share / download --------------------------------- */
  async function shareOrDownload(blob, filename, text) {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename, text: text });
        toast('Sent', 'Choose WhatsApp from the share sheet');
        return;
      } catch (e) { /* user cancelled — fall through */ }
    }
    showShareSheet(blob, filename, text);
  }

  function showShareSheet(blob, filename, text) {
    const url = URL.createObjectURL(blob);
    const sheet = $('paywall');
    // This PDF is going to the customer, so aim at their number when the
    // job card has one. With no number the link still opens WhatsApp and
    // the technician picks the chat — on their own phone that is a normal
    // action, unlike the passport page, where a member of the public must
    // land on REHOTEQ's line rather than guess who to message.
    const num = (S.job && S.job.customer) ? CONFIG.waNumber(S.job.customer.phone) : '';
    const waUrl = num
      ? 'https://wa.me/' + num + '?text=' + encodeURIComponent(text)
      : 'https://wa.me/?text=' + encodeURIComponent(text);
    sheet.innerHTML = `
      <div class="pwsheet">
        <div class="center" style="margin-bottom:14px">
          <div style="margin-bottom:5px">${ICON('file-text', 34)}</div>
          <div style="font-size:15.5px;font-weight:750">${esc(filename)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:4px">
            ${(blob.size / 1024).toFixed(0)} KB · ready to send</div>
        </div>
        <button class="btn wa" onclick="window.open('${waUrl}','_blank')">${ICON('message-circle', 16)} Send to WhatsApp</button>
        <div class="grid2" style="margin-top:9px">
          <button class="btn ghost sm" onclick="ACT.dl('${url}','${filename}')">${ICON('download', 15)} Save PDF</button>
          <button class="btn ghost sm" onclick="window.open('${url}','_blank')">${ICON('eye', 15)} Preview</button>
        </div>
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.quote()">${ICON('receipt', 15)} Also send a quotation</button>
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.closePaywall()">Done</button>
        <div class="center" style="font-size:10.5px;color:#94A3B8;margin-top:12px;line-height:1.6">
          WhatsApp opens with your message ready — attach the PDF from the paperclip.
        </div>
      </div>`;
    sheet.classList.add('show');
  }

  /* ---------------- equipment / passport ------------------------------ */
  async function refreshEquipment() {
    const jobs = (await DB.all('jobs')).filter(j => !j.deletedAt);
    const seen = {};
    jobs.forEach(j => {
      const s = j.equipment && j.equipment.serial;
      if (!s) return;
      if (!seen[s]) {
        seen[s] = {
          id: 'EQ-' + s.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20),
          serial: s, model: j.equipment.model || '', capacity: j.equipment.capacity || '',
          installDate: j.equipment.installDate || j.completedAt || j.startedAt,
          warrantyMonths: 24, customerName: j.customer.name, trade: j.trade
        };
        seen[s].slug = seen[s].id.replace('EQ-', '');
      }
    });
    S.equipment = Object.values(seen);
  }

  /* ---------------- boot ---------------------------------------------- */
  async function boot() {
    S.user = await DB.getMeta('user');
    S.accounts = (await DB.getMeta('accounts')) || [];
    S.lastBackup = await DB.getMeta('lastBackup');
    if (S.user && S.user.trade) S.trade = S.user.trade;
    await refreshJobs();
    await refreshEquipment();
    await teamLoad();
    await loadUsageLedger();
    if (S.user) await saveAccount(S.user);
    // hydrate photo urls for any job we render. A photo restored from a
    // backup may have no blob; createObjectURL would throw and leave the
    // technician with a white screen he cannot clear from the UI.
    const all = await DB.all('photos');
    all.forEach(p => { if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob); });
    S.welcomeSeen = await DB.getMeta('welcomeSeen');
    go(S.user ? 'home' : (S.welcomeSeen ? 'boot' : 'welcome'));
  }

  // Last line of defence. If boot ever throws, the technician must still get
  // a screen he can act on — a dead white page on a roof is not an option.
  function bootFailed(err) {
    console.error('boot failed', err);
    app().innerHTML =
      '<div class="pad" style="padding-top:56px">' +
      '<div class="empty">' + ICON('alert-triangle',26) + '' +
      '<div class="et">REHOTEQ Field could not start</div>' +
      '<div class="ed">Your job cards are still on this device. Reload first; ' +
      'if that fails, use Reset to clear local data and restore your last backup.</div></div>' +
      '<button class="btn primary" onclick="location.reload()">Reload</button>' +
      '<button class="btn ghost sm" style="margin-top:10px" onclick="ACT.wipe()">Reset this device</button>' +
      '<div class="center mono" style="font-size:10px;color:#94A3B8;margin-top:14px;line-height:1.6">' +
      esc(String((err && err.message) || err)) + '</div></div>';
  }

  window.addEventListener('online', () => { S.online = true; render(); });
  window.addEventListener('offline', () => { S.online = false; render(); });

  // The entitlement record (users/{uid}) is written by Cloud Functions
  // and read on sign-in. A network failure here must never block the app.
  function hydrateEntitlement() {
    if (!window.FB || !window.FB.profile) return;
    window.FB.profile().then(function (rec) {
      if (!rec || !S.user) return;
      const t = rec.trialEndsAt;
      S.user.plan = rec.plan || S.user.plan || 'free';
      S.user.trialEndsAt = t
        ? (t.toDate ? t.toDate().toISOString() : new Date(t).toISOString())
        : null;
      DB.setMeta('user', S.user);
      if (S.view === 'home' || S.view === 'settings') render();
    }).catch(function () { /* offline: the app keeps working */ });
  }

  // Firebase is optional and inert until config.js switches it on. When it
  // is off, none of this runs and the app is untouched by any of it.
  if (window.FB && window.FB.enabled()) {
    window.FB.finishRedirect().then(function (u) {
      if (u) {
        S.fbUser = u;
        if (isOwnerAccount(S.user, u) && S.user) {
          S.user.ownerAccess = true;
          if (!S.user.plan || S.user.plan === 'free') S.user.plan = 'business';
          DB.setMeta('user', S.user);
        }
        hydrateEntitlement();
      }
    }).catch(function () { /* no redirect pending, carry on */ });
    window.FB.onUser(function (u) {
      S.fbUser = u;
      if (u && isOwnerAccount(S.user, u) && S.user) {
        S.user.ownerAccess = true;
        if (!S.user.plan || S.user.plan === 'free') S.user.plan = 'business';
        DB.setMeta('user', S.user);
      }
      if (u) hydrateEntitlement();
      if (S.view === 'settings' || S.view === 'home') render();
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // updateViaCache:'none' keeps the update check honest. Without it the
      // browser may serve its own cached copy of sw.js for as long as the
      // host's cache headers say (ten minutes on GitHub Pages), and a
      // published update simply never arrives on the phone.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        // A new worker sitting in `installed` while this page is already
        // controlled means one thing: an update downloaded, but the screen
        // is still running the old app. Never yank the page away mid-job —
        // offer the reload and let the technician choose the moment.
        function announce() {
          if (document.getElementById('swUpdate')) return;
          const bar = document.createElement('div');
          bar.id = 'swUpdate';
          bar.style.cssText = 'position:absolute;left:10px;right:10px;bottom:10px;z-index:70;' +
            'background:#0F172A;color:#fff;border-radius:13px;padding:12px 14px;' +
            'display:flex;align-items:center;gap:10px;box-shadow:0 12px 30px rgba(15,23,42,.35)';
          bar.innerHTML =
            '<div style="flex:1;font-size:12px;line-height:1.5">A new version of REHOTEQ Field is installed.' +
            '<span style="display:block;font-size:10.5px;opacity:.72">Reload to switch to it. Your job cards are safe.</span></div>' +
            '<button id="swUpdateGo" style="border:0;background:#0E7C5A;color:#fff;font:inherit;font-weight:700;' +
            'font-size:12px;padding:9px 14px;border-radius:9px;cursor:pointer">Reload</button>' +
            '<button id="swUpdateX" aria-label="Dismiss" style="border:0;background:none;color:#94A3B8;' +
            'font:inherit;font-size:16px;cursor:pointer;padding:4px">×</button>';
          document.getElementById('shell').appendChild(bar);
          bar.querySelector('#swUpdateGo').onclick = () => location.reload();
          bar.querySelector('#swUpdateX').onclick = () => bar.remove();
        }
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            // controller!=null means this is an update, not the very first
            // install — nobody needs telling that the app arrived.
            if (nw.state === 'installed' && navigator.serviceWorker.controller) announce();
          });
        });
        if (reg.waiting && navigator.serviceWorker.controller) announce();
      }).catch(() => {});
    });
  }

  boot().catch(bootFailed);
})();

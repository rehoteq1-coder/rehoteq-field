/* =====================================================================
   app.js — REHOTEQ Field
   The flow: Technician -> Job -> Checklist -> Photos -> Sign-off ->
             Report -> PDF -> WhatsApp

   V1 deliberately contains no AI. The troubleshooting library is
   curated and deterministic: it works offline, costs nothing per query,
   and cannot give anyone a dangerous answer.
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
    team: null
  };

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
    if (!S.team) S.team = { company: null, members: [], invites: [], seats: null, sel: null };
    if (!S.team.seats) S.team.seats = { paid: DATA.PLANS.business.seats, selfDeclared: false, claimedAt: null };
    if (!Array.isArray(S.team.members)) S.team.members = [];
    if (!Array.isArray(S.team.invites)) S.team.invites = [];
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
    await DB.setMeta('teamSeats', t.seats);
  }

  async function teamLoad() {
    const t = teamState();
    t.company = await DB.getMeta('company');
    t.members = (await DB.getMeta('teamMembers')) || [];
    t.invites = (await DB.getMeta('teamInvites')) || [];
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
      const code = makeCode();
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
      }
    },

    async applyAcceptance(file) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      if (!file || file.format !== TEAM_FORMAT || file.kind !== 'acceptance') return { ok: false, error: 'notaccept' };
      if (file.companyId !== t.company.id) return { ok: false, error: 'wrongcrew' };
      const inv = t.invites.find(i => i.code === file.code);
      if (!inv) return { ok: false, error: 'nocode' };
      const m = file.member || {};
      if (!m.memberId || !m.name) return { ok: false, error: 'damaged' };
      // Re-importing an acceptance (the file got sent twice) updates the
      // record instead of eating a second seat.
      const dup = t.members.find(x => x.memberId === m.memberId);
      if (dup) {
        dup.name = m.name; dup.phone = m.phone || dup.phone;
        inv.status = 'joined';
        await teamSave();
        return { ok: true, member: dup, again: true };
      }
      const s = TEAM.seats();
      if (s.used >= s.paid) return { ok: false, error: 'full' };
      const rec = { memberId: m.memberId, name: m.name, phone: m.phone || '',
        joinedAt: m.joinedAt || new Date().toISOString(), code: file.code };
      t.members.push(rec);
      inv.status = 'joined';
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
      return { ok: true, company: name };
    },

    async leaveTeam() {
      if (!S.user || !S.user.memberOf) return { ok: false, error: 'none' };
      const m = S.user.memberOf;
      const name = (m.branding && m.branding.name) || 'your crew';
      delete S.user.memberOf;
      await DB.setMeta('user', S.user);
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
      if (!t.company && !t.members.length && !t.invites.length) return null;
      return { company: t.company, members: t.members, invites: t.invites, seats: t.seats };
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

  /* ---------------- views ------------------------------------------- */
  const V = {};

  V.boot = () => `
    <div class="pad" style="padding-top:52px">
      <div class="center" style="margin-bottom:28px">
        <div style="width:64px;height:64px;border-radius:19px;margin:0 auto 14px;
          background:linear-gradient(145deg,#0E7C5A,#0A5C42);display:grid;place-items:center;
          box-shadow:0 14px 32px rgba(14,124,90,.3)">
          <span style="font-size:26px;font-weight:800;color:#fff">R</span></div>
        <div style="font-size:24px;font-weight:800;letter-spacing:-.03em">REHOTEQ <span style="color:#0E7C5A">Field</span></div>
        <div style="font-size:12.5px;color:#64748B;margin-top:6px;line-height:1.6">Diagnose it. Prove it. Get paid.</div>
      </div>
      <div class="field"><label class="fl">Your name</label>
        <input id="iName" placeholder="Toye Adewale" value="${esc((S.user && S.user.name) || '')}"></div>
      <div class="field"><label class="fl">Phone</label>
        <input id="iPhone" inputmode="tel" placeholder="0803 000 0000" value="${esc((S.user && S.user.phone) || '')}"></div>
      <div class="field"><label class="fl">Main trade</label>
        <select id="iTrade">${DATA.TRADES.map(t =>
          `<option value="${t.id}" ${(S.user && S.user.trade === t.id) || (!S.user && t.id === 'solar') ? 'selected' : ''}>${t.name}</option>`
        ).join('')}</select></div>
      <div class="field"><label class="fl">Business name (optional)</label>
        <input id="iCompany" placeholder="REHOTEQ Technologies" value="${esc((S.user && S.user.company) || '')}"></div>
      ${S.user ? `
        <div class="sec" style="margin:16px 0 2px">Printed on every document</div>
        <div class="card" style="margin-bottom:12px"><div class="cb">
          <div class="field"><label class="fl">Business address</label>
            <input id="iAddress" placeholder="12 Sapele Road, Benin City" value="${esc(S.user.address || '')}"></div>
          <div class="field"><label class="fl">Email (optional)</label>
            <input id="iEmail" inputmode="email" placeholder="hello@rehoteq.com" value="${esc(S.user.email || '')}"></div>
          <div class="field"><label class="fl">Bank details (printed on quotations)</label>
            <input id="iBank" placeholder="GTBank · 0123456789 · REHOTEQ Technologies" value="${esc(S.user.bank || '')}"></div>
          <div class="field"><label class="fl">About your business (printed on quotations)</label>
            <textarea id="iBio" maxlength="300" rows="3"
              placeholder="We design, install and maintain solar and inverter systems across Ondo State — 8 years, 400+ installations."
              >${esc(S.user.bio || '')}</textarea>
            <div class="hintline">Two or three lines. It goes on every quotation you send.</div></div>
          <div class="field" style="margin-bottom:0"><label class="fl">Logo</label>
            ${S.user.logo ? `
              <div style="display:flex;align-items:center;gap:10px">
                <img src="${esc(S.user.logo.dataUrl)}" alt=""
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
      <button class="btn primary" style="margin-top:6px" onclick="ACT.saveProfile()">${S.user ? 'Save profile' : 'Get started'}</button>
      <div class="center" style="font-size:10.5px;color:#94A3B8;margin-top:14px;line-height:1.6">
        No account needed. Everything is stored on this device until you choose to sync.
      </div>
    </div>`;

  V.home = () => {
    const plan = (S.user && S.user.plan) || 'free';
    // Company work is covered by the crew's subscription, so it never
    // burns the technician's own free reports.
    const used = S.jobs.filter(j => (j.status === 'sent' || j.lockedAt) && !companyJob(j)).length;
    const limit = plan === 'free' ? 3 : -1;
    const pct = limit < 0 ? 0 : Math.min(100, (used / limit) * 100);
    const cont = S.jobs.filter(j => !j.lockedAt && j.status !== 'sent').slice(0, 2);
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
          <div class="lab"><b>${plan === 'free' ? used + ' of 3 free reports used' : 'Pro — unlimited reports'}</b>
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
        <button class="tile locked" onclick="ACT.toast('AI fault diagnosis','Ships in V3, once we have the job corpus to train it on')">
          <span class="lock">V3</span><span class="ic">${ICON('brain', 22)}</span><span class="t">Diagnose a fault</span><span class="d">AI-ranked causes</span></button>
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
          <div class="srow"><span class="si">${ICON('star', 17)}</span>
            <span class="sl">Plan<br><span style="font-size:11px;color:var(--muted);font-weight:500">
              ${plan === 'free' ? 'Free · 3 reports/month' : 'Pro · unlimited'}</span></span>
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
          REHOTEQ Field v1.0 · PWA<br>Built for the man holding the phone.
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
        <div class="btnrow">
          <button class="btn primary sm" style="flex:1" onclick="ACT.makeInvite()">${ICON('user-plus', 15)} Invite</button>
          <button class="btn ghost sm" style="flex:1" onclick="ACT.go('company')">${ICON('briefcase', 15)} Stamp</button>
        </div>
        <div class="btnrow" style="margin-top:9px">
          <button class="btn ghost sm" style="flex:1" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Receive file</button>
          <button class="btn ghost sm" style="flex:1" onclick="ACT.buySeats()">${ICON('plus', 15)} Seats</button>
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
           <div class="ed">Tap Invite — the invite travels as a file over WhatsApp, and their
           acceptance comes back the same way.</div></div>`}
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
          <b>How crews work before the server lands.</b> Jobs, invites and updates travel as
          files over WhatsApp — nothing arrives by itself. Your stamp prints on every PDF
          your crew sends, and every update they send back lands on this dashboard.</div>
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
          <button class="btn ghost sm" style="flex:1" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Receive file</button>
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
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Join with an invite file</button>
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
            Your report is ready. One extra job a year pays for this.</div>
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
          <div class="feat"><span class="tk">${ICON('check', 12)}</span>All 4 trades + full checklists</div>
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
    const v = S.view;
    const titles = {
      home: null, actions: tradeName(S.trade), library: 'Troubleshooting',
      libdetail: 'Guide', newjob: 'New job card',
      jobcard: S.job ? S.job.ref : 'Job card', checklist: 'Checklist',
      photos: 'Job evidence', signoff: 'Sign-off', report: 'Service report',
      quote: 'Quotation', jobs: 'My jobs', settings: 'Settings', passport: 'Solar passport',
      team: 'My team', teamjob: S.job ? S.job.ref : 'Crew job', company: 'Company stamp'
    };
    let bar = '';
    if (v !== 'boot' && v !== 'home') {
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
    const body = v === 'report' ? V.report() : `<div class="scroll">${(V[v] || V.home)()}</div>`;
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

    async saveProfile() {
      const name = $('iName').value.trim();
      if (!name) return toast('Enter your name');
      const prev = S.user || {};
      S.user = {
        name: name, phone: $('iPhone').value.trim(), trade: $('iTrade').value,
        company: $('iCompany').value.trim() || 'REHOTEQ Technologies',
        plan: prev.plan || 'free',
        // carried through untouched — these are edited on the same screen
        // once a profile exists, and must not be wiped on first run
        bank: prev.bank || '', address: prev.address || '',
        email: prev.email || '', logo: prev.logo || null,
        bio: prev.bio || ''
      };
      // the document fields are only rendered when editing an existing
      // profile, so read them defensively rather than assuming they exist
      const pick = id => { const el = $(id); return el ? el.value.trim() : null; };
      if (pick('iAddress') !== null) S.user.address = pick('iAddress');
      if (pick('iEmail') !== null) S.user.email = pick('iEmail');
      if (pick('iBank') !== null) S.user.bank = pick('iBank');
      if (pick('iBio') !== null) S.user.bio = pick('iBio');
      S.trade = S.user.trade;
      await DB.setMeta('user', S.user);
      await refreshJobs();
      await refreshEquipment();
      go('home');
    },

    async editProfile() { S.user = S.user || {}; go('boot'); },

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
      const s = S.job.signatures;
      if (!s.customer || !s.technician) return toast('Both signatures are needed', 'That is what locks the job as evidence');
      S.job.completedAt = new Date().toISOString();
      S.job.lockedAt = new Date().toISOString();
      S.job.status = 'completed';
      await saveJob();
      await refreshEquipment();
      go('report');
    },

    back() {
      const order = ['actions', 'library', 'newjob', 'jobcard', 'checklist', 'photos', 'signoff', 'report', 'quote'];
      const map = {
        actions: 'home', library: 'home', libdetail: 'library', newjob: 'actions',
        jobcard: 'newjob', checklist: 'jobcard', photos: 'jobcard', signoff: 'photos',
        report: 'signoff', quote: 'report', passport: 'home',
        team: 'settings', teamjob: 'team', company: 'team'
      };
      go(map[S.view] || 'home');
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
      const plan = (S.user && S.user.plan) || 'free';
      const used = S.jobs.filter(j => (j.status === 'sent' || j.lockedAt) && !companyJob(j)).length;
      if (plan === 'free' && used >= 3 && !companyJob(S.job)) return showPaywall();
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
      try {
        await window.FB.signIn();
      } catch (e) {
        toast('Could not reach the sign-in page', 'Check your connection and try again');
      }
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
      for (const s of ['jobs', 'photos', 'customers', 'equipment', 'meta', 'outbox']) {
        const all = await DB.all(s);
        for (const r of all) await DB.del(s, r.id);
      }
      S.job = null; S.jobs = []; S.user = null; S.equipment = [];
      go('boot'); toast('Everything deleted');
    },

    async loadDemo() {
      const j = await newJob();
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

    async makeInvite() {
      const r = await TEAM.makeInvite();
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      render();
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

    // The test suite's eyes: without this it can tap a button but cannot
    // prove the tap landed on the right screen.
    _view() { return S.view; }
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
    S.lastBackup = await DB.getMeta('lastBackup');
    if (S.user && S.user.trade) S.trade = S.user.trade;
    await refreshJobs();
    await refreshEquipment();
    await teamLoad();
    // hydrate photo urls for any job we render. A photo restored from a
    // backup may have no blob; createObjectURL would throw and leave the
    // technician with a white screen he cannot clear from the UI.
    const all = await DB.all('photos');
    all.forEach(p => { if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob); });
    go(S.user ? 'home' : 'boot');
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

  // Firebase is optional and inert until config.js switches it on. When it
  // is off, none of this runs and the app is untouched by any of it.
  if (window.FB && window.FB.enabled()) {
    window.FB.finishRedirect().then(function (u) {
      if (u) S.fbUser = u;
    }).catch(function () { /* no redirect pending, carry on */ });
    window.FB.onUser(function (u) {
      S.fbUser = u;
      if (S.view === 'settings') render();
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

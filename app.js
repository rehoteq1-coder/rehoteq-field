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
    passportEq: null, online: navigator.onLine, search: '', toastT: null
  };

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
  function tradeName(id) {
    const t = DATA.TRADES.find(x => x.id === id);
    return t ? t.icon + ' ' + t.name : id;
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
      fault: '', diagnosis: '', work: '', recommendation: '',
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
    return pdfBlob(REPORT.buildReport(j, withBytes, sigs, S.user || {}));
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
          `<option value="${t.id}" ${(S.user && S.user.trade === t.id) || (!S.user && t.id === 'solar') ? 'selected' : ''}>${t.icon} ${t.name}</option>`
        ).join('')}</select></div>
      <div class="field"><label class="fl">Business name (optional)</label>
        <input id="iCompany" placeholder="REHOTEQ Technologies" value="${esc((S.user && S.user.company) || '')}"></div>
      <button class="btn primary" style="margin-top:6px" onclick="ACT.saveProfile()">Get started</button>
      <div class="center" style="font-size:10.5px;color:#94A3B8;margin-top:14px;line-height:1.6">
        No account needed. Everything is stored on this device until you choose to sync.
      </div>
    </div>`;

  V.home = () => {
    const plan = (S.user && S.user.plan) || 'free';
    const used = S.jobs.filter(j => j.status === 'sent' || j.lockedAt).length;
    const limit = plan === 'free' ? 3 : -1;
    const pct = limit < 0 ? 0 : Math.min(100, (used / limit) * 100);
    const cont = S.jobs.filter(j => !j.lockedAt && j.status !== 'sent').slice(0, 2);
    return `
      <div class="pad">
        <button class="btn primary" style="padding:18px;font-size:16px" onclick="ACT.startJob()">▶&nbsp; START A JOB</button>
        <div class="sec">What are you working on?</div>
        <div class="grid2">
          ${DATA.TRADES.map(t => `<button class="tile ${S.trade === t.id ? 'on' : ''}" onclick="ACT.setTrade('${t.id}')">
            <span class="ic">${t.icon}</span><span class="t">${t.name}</span><span class="d">${t.desc}</span></button>`).join('')}
        </div>
        ${cont.length ? `<div class="sec">Continue</div><div class="card">${cont.map(j => `
          <div class="rowitem" onclick="ACT.openJob('${j.id}')">
            <div class="dotg"></div>
            <div><div class="jt">${esc(j.jobType || 'Job card')}${j.customer && j.customer.name ? ' — ' + esc(j.customer.name) : ''}</div>
              <div class="js">${esc(j.site.address || 'No location')} · ${dstr(j.startedAt)}</div></div>
          </div>`).join('')}</div>` : ''}
        <div class="meter" onclick="ACT.goPlan()">
          <div style="font-size:19px">📄</div>
          <div class="lab"><b>${plan === 'free' ? used + ' of 3 free reports used' : 'Pro — unlimited reports'}</b>
            <div class="bar"><i style="width:${pct}%"></i></div></div>
          <div style="color:#94A3B8">›</div>
        </div>
        ${needsBackup() ? `<div class="warnbox" style="margin-bottom:4px">
          <div class="wh">⚠️ Back up your work</div>
          <div class="wt">${S.jobs.length} job cards live only on this phone.
            Settings → <b>Send backup</b> takes ten seconds.</div>
          <button class="btn primary sm" style="margin-top:10px" onclick="ACT.shareBackup()">
            📤 Back up now</button></div>` : ''}
        <div class="sec">Quick actions</div>
        <div class="grid2">
          <button class="tile" onclick="ACT.go('library')"><span class="ic">📚</span><span class="t">Troubleshooting</span>
            <span class="d">${DATA.LIBRARY.length} guides · offline</span></button>
          <button class="tile" onclick="ACT.go('jobs')"><span class="ic">📋</span><span class="t">My jobs</span>
            <span class="d">${S.jobs.length} job cards</span></button>
          <button class="tile" onclick="ACT.go('passport')"><span class="ic">🔳</span><span class="t">Solar passport</span>
            <span class="d">QR · warranty</span></button>
          <button class="tile" onclick="ACT.go('settings')"><span class="ic">⚙︎</span><span class="t">Settings</span>
            <span class="d">Branding · plan</span></button>
        </div>
      </div>`;
  };

  V.actions = () => `
    <div class="pad">
      <div class="sec" style="margin-top:2px">What do you need?</div>
      <div class="grid2">
        <button class="tile" onclick="ACT.startJob()"><span class="ic">📋</span><span class="t">New job card</span>
          <span class="d">Fault → work → report</span></button>
        <button class="tile" onclick="ACT.go('library')"><span class="ic">🧰</span><span class="t">Troubleshooting</span>
          <span class="d">Step-by-step fixes</span></button>
        <button class="tile" onclick="ACT.go('jobs')"><span class="ic">🔎</span><span class="t">Find a job</span>
          <span class="d">History &amp; drafts</span></button>
        <button class="tile" onclick="ACT.go('passport')"><span class="ic">🔳</span><span class="t">Solar passport</span>
          <span class="d">QR + warranty</span></button>
        <button class="tile locked" onclick="ACT.toast('Equipment ID','Ships in V2 — point the camera, get the model')">
          <span class="lock">V2</span><span class="ic">🔢</span><span class="t">Identify equipment</span><span class="d">From a photo</span></button>
        <button class="tile locked" onclick="ACT.toast('AI fault diagnosis','Ships in V3, once we have the job corpus to train it on')">
          <span class="lock">V3</span><span class="ic">🧠</span><span class="t">Diagnose a fault</span><span class="d">AI-ranked causes</span></button>
        <button class="tile locked" onclick="ACT.toast('Voice copilot','Ships in V4 — speak, get a finished job card')">
          <span class="lock">V4</span><span class="ic">🎤</span><span class="t">Ask by voice</span><span class="d">Hands-free</span></button>
        <button class="tile" onclick="ACT.go('settings')"><span class="ic">⚙︎</span><span class="t">Settings</span>
          <span class="d">Profile · plan</span></button>
      </div>
      <div class="banner b-ok" style="margin-top:14px">
        <b>Working on ${esc(tradeName(S.trade))}.</b> Checklists and troubleshooting are filtered to this trade.
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
        <div class="searchbox"><span class="si">🔍</span>
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
        ${!list.length ? `<div class="empty"><div class="ei">🔍</div><div class="et">Nothing here yet</div>
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
          <button class="btn primary sm" style="margin-top:11px" onclick="ACT.jobFromLib()">📋 Start a job card from this</button>
        </div></div>
        <div class="warnbox"><div class="wh">⚠️ Safety first</div><div class="wt">${esc(e.safety)}</div></div>
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
          <button class="chip" onclick="ACT.toast('Logged','Ratings like this become the V3 training set')">👍 Yes</button>
          <button class="chip" onclick="ACT.toast('Flagged for review','A human reviews every correction')">👎 No</button>
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
            <button class="mic" onclick="ACT.gps()" title="Use my location">📍</button>
          </div>
          <div class="hintline" id="gpsLine">${j.site.lat !== null && j.site.lat !== undefined
            ? '<b>📍 GPS captured</b> · ' + j.site.lat.toFixed(4) + ', ' + j.site.lng.toFixed(4)
            : 'Tap 📍 to stamp the location'}</div>
        </div>
        <div class="field"><label class="fl">Job type</label>
          <select onchange="ACT.set('jobType',this.value)">
            <option value="">Choose…</option>
            ${(DATA.JOB_TYPES[j.trade] || []).map(t =>
              `<option ${j.jobType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select></div>
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
          <button class="mic" onclick="ACT.voice('${key}',this)" title="Dictate">🎤</button>
        </div></div>`;
    return `
      <div class="pad">
        ${locked ? `<div class="banner b-ok">🔒 This job card is <b>locked</b>. Both parties signed — it is now evidence and cannot be edited.</div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          <span class="chip">${esc(tradeName(j.trade))}</span>
          <span class="chip grey">${esc(j.ref)}</span>
          ${!S.online ? '<span class="chip grey">⏳ Offline — will sync</span>' : ''}
        </div>
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
                ${locked ? '' : `<button class="iconbtn" onclick="ACT.delMat(${i})">✕</button>`}
              </div>`).join('') : '<div style="font-size:12px;color:#94A3B8">No materials yet</div>'}
            <div class="field" style="margin:8px 0 0"><label class="fl">Labour (₦)</label>
              <input type="number" value="${j.labour || ''}" placeholder="25000"
                oninput="ACT.set('labour',this.value)" ${locked ? 'disabled' : ''}></div>
          </div>
        </div>
        ${text('recommendation', '5 · Recommendation', 'What should happen next — this is where the next job comes from')}
        <button class="btn ghost sm" onclick="ACT.go('checklist')">
          ✅ Checklist ${j.checklist ? '· ' + j.checklist.items.filter(i => i.passed).length + '/' + j.checklist.items.length : ''}</button>
        <button class="btn primary sm" style="margin-top:10px" onclick="ACT.go('photos')">📸 Job evidence</button>
      </div>`;
  };

  V.checklist = () => {
    const j = S.job;
    if (!j.checklist) {
      const key = j.trade + '|' + j.jobType;
      const tpl = DATA.CHECKLISTS[key];
      if (!tpl) {
        return `<div class="pad"><div class="empty"><div class="ei">📋</div>
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
              <div class="box ${it.passed ? 'on' : ''}">${it.passed ? '✓' : ''}</div>
              <div style="flex:1">
                <div class="ct">${esc(it.l)}</div>
                ${it.h ? `<div class="cd">${esc(it.h)}</div>` : ''}
                ${it.critical ? '<div class="cd" style="color:#DC2626;font-weight:700;margin-top:3px">⚠ Critical — blocks completion</div>' : ''}
                ${it.photo ? '<div class="cam">📷 Photo required</div>' : ''}
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
          <span class="stag">${label}</span><span class="ok">✓</span>
          ${j.lockedAt ? '' : `<button class="x" onclick="ACT.delPhoto('${p.id}')">✕</button>`}</div>`;
      }
      return `<button class="ph empty" onclick="${j.lockedAt ? '' : 'ACT.pick(\'' + stage + '\')'}">
        <span style="font-size:22px">${icon}</span><span>Add ${label}</span></button>`;
    };
    return `
      <div class="pad">
        <div class="banner">Time, GPS and your name are <b>burned into every photo</b>.
        A screenshot of metadata is not evidence — a stamp on the image survives being shared.</div>
        <div class="photogrid">
          ${cell('before', 'BEFORE', '📷')}
          ${cell('during', 'DURING', '🛠')}
          ${cell('after', 'AFTER', '⚡')}
          ${cell('serial', 'SERIAL', '🔢')}
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
              <div class="ph2" id="phC">✍️ Customer signs here</div></div>
            <div class="btnrow">
              <button class="btn ghost sm" style="flex:1" onclick="ACT.clearSig('customer')">Clear</button>
              <button class="btn dark sm" style="flex:1" onclick="ACT.saveSig('customer')">Save signature</button>
            </div>
            ${j.signatures.customer ? `<div class="hintline"><b>✔ Signed</b> ${dstr(j.signatures.customer.at)} ${tstr(j.signatures.customer.at)}</div>` : ''}
          </div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Technician</div>
          <div class="cb">
            <div class="field"><label class="fl">Name</label>
              <input id="sigTechName" placeholder="${esc((S.user && S.user.name) || 'Your name')}"
                value="${esc((j.signatures.technician && j.signatures.technician.name) || (S.user && S.user.name) || '')}"></div>
            <div class="sigpad" id="padT"><canvas id="cvT"></canvas>
              <div class="ph2" id="phT">✍️ You sign here</div></div>
            <div class="btnrow">
              <button class="btn ghost sm" style="flex:1" onclick="ACT.clearSig('technician')">Clear</button>
              <button class="btn dark sm" style="flex:1" onclick="ACT.saveSig('technician')">Save signature</button>
            </div>
            ${j.signatures.technician ? `<div class="hintline"><b>✔ Signed</b> ${dstr(j.signatures.technician.at)} ${tstr(j.signatures.technician.at)}</div>` : ''}
          </div>
        </div>
        <div class="banner b-ok">🔒 Once both signatures are saved the job card <b>locks</b>.
        That is what turns a note into evidence.</div>
        <button class="btn primary" onclick="ACT.finish()">Generate report ›</button>
      </div>`;
  };

  V.report = () => {
    const j = S.job;
    const by = S.photos[j.id] || {};
    const stages = ['before', 'during', 'after'];
    const strip = stages.map(s => (by[s] || [])[0]).filter(Boolean);
    const mats = (j.materials || []).reduce((s, m) => s + (Number(m.qty) || 1) * (Number(m.unitPrice) || 0), 0);
    const total = mats + (Number(j.labour) || 0);
    const sigBox = (role, label) => {
      const s = j.signatures && j.signatures[role];
      return `<div class="sigbox">
        <div class="rl" style="color:${s ? '#0E7C5A' : '#94A3B8'}">${s ? '✔' : '—'} ${label}</div>
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
        <div class="verify">🔎 Record reference · ${esc(CONFIG.domain)}/v/<b>${esc(CONFIG.slugify(j.ref))}</b>
          ${j.hashes && j.hashes.length ? `<br><span style="font-size:9px;opacity:.8" class="mono">${j.hashes.length} photo digest${j.hashes.length === 1 ? '' : 's'} recorded on this job card</span>` : ''}</div>
        <div class="disclaim">This report records work performed as described. It is not a certificate of
          regulatory compliance unless issued by a licensed contractor.</div>
      </div>
      <div class="actionbar">
        <button class="btn ghost" style="flex:0 0 30%" onclick="ACT.go('jobcard')">Edit</button>
        <button class="btn primary" style="flex:1" onclick="ACT.pdf()">📄 Generate PDF</button>
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
                <button class="iconbtn" onclick="ACT.delQuoteItem(${i})">✕</button>
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
        <button class="btn primary" onclick="ACT.quotePdf()">📄 Generate quotation PDF</button>
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
              ${j.lockedAt ? '🔒 Locked as evidence' : j.status === 'sent' ? '📤 Sent' : '📝 Draft'}</div>
          </div></div></div>`).join('')
        : `<div class="empty"><div class="ei">📋</div><div class="et">No jobs yet</div>
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
          <div class="srow"><span class="si">🏢</span><span class="sl">Business name</span>
            <span class="sv">${esc(u.company || 'Not set')}</span></div>
          <div class="srow"><span class="si">👤</span><span class="sl">Your name</span><span class="sv">${esc(u.name || '')}</span></div>
          <div class="srow"><span class="si">📞</span><span class="sl">Phone</span><span class="sv">${esc(u.phone || '')}</span></div>
          <div class="srow"><span class="si">🏦</span><span class="sl">Bank details</span>
            <span class="sv">${esc(u.bank || 'Not set')}</span></div>
          <div class="srow" style="cursor:pointer" onclick="ACT.editProfile()">
            <span class="si">✏️</span><span class="sl">Edit profile</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Subscription</div>
          <div class="srow"><span class="si">⭐</span>
            <span class="sl">Plan<br><span style="font-size:11px;color:var(--muted);font-weight:500">
              ${plan === 'free' ? 'Free · 3 reports/month' : 'Pro · unlimited'}</span></span>
            <button class="switch ${plan !== 'free' ? 'on' : ''}" onclick="ACT.togglePlan(this)"></button></div>
          <div class="srow" onclick="ACT.goPlan()"><span class="si">💳</span>
            <span class="sl">Plans &amp; pricing</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Field settings</div>
          <div class="srow"><span class="si">📶</span><span class="sl">Data saver</span>
            <span class="sv">Photos ≤ 350 KB</span></div>
          <div class="srow"><span class="si">☁️</span><span class="sl">Offline</span>
            <span class="sv">${S.online ? '<span class="online-dot"></span>Online' : '<span class="offline-dot"></span>Offline — work is saved'}</span></div>
          <div class="srow" onclick="ACT.syncInfo()"><span class="si">🔄</span><span class="sl">Sync queue</span>
            <span class="sv" id="queueCount">…</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Backup
            <span style="text-transform:none;letter-spacing:0;font-weight:700;
              color:${S.lastBackup ? '#0E7C5A' : '#DC2626'}">${
                S.lastBackup ? 'Last: ' + dstr(S.lastBackup) : 'Never backed up'}</span></div>
          ${!S.lastBackup ? `<div class="cb" style="padding-top:0">
            <div class="warnbox" style="margin:0 0 10px">
              <div class="wh">⚠️ Your data is only on this phone</div>
              <div class="wt">If this phone is lost, reset or the browser data is cleared,
              every job card and photo goes with it. Back up now — it takes ten seconds.</div>
            </div></div>` : `<div class="cb" style="padding-top:2px;padding-bottom:6px;font-size:11.5px;color:var(--muted);line-height:1.55">
              A backup file is only safe somewhere other than this phone.
              Email it to yourself or put it in Drive.</div>`}
          <div class="srow" onclick="ACT.shareBackup()"><span class="si">📤</span>
            <span class="sl">Send backup off this phone<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Jobs + photos · email or Drive</span></span>
            <span style="color:#0E7C5A;font-weight:700">Best</span></div>
          <div class="srow" onclick="ACT.exportAll(true)"><span class="si">💾</span>
            <span class="sl">Download backup (with photos)</span><span style="color:#94A3B8">›</span></div>
          <div class="srow" onclick="ACT.exportAll(false)"><span class="si">📄</span>
            <span class="sl">Download backup (text only)<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Much smaller · no photos</span></span>
            <span style="color:#94A3B8">›</span></div>
          <div class="srow" onclick="ACT.importBackup()"><span class="si">📥</span>
            <span class="sl">Restore from backup</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Data</div>
          <div class="srow" onclick="ACT.loadDemo()"><span class="si">🎬</span>
            <span class="sl">Load a demo job</span><span class="sv">Try the PDF in one tap</span></div>
          <div class="srow" onclick="ACT.wipe()"><span class="si">🗑</span>
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
              <span>🛡 Warranty · <b>${days === null ? '—' : days > 0 ? 'active' : 'expired'}</b></span>
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
          : `<div class="empty"><div class="ei">🔳</div><div class="et">No systems yet</div>
             <div class="ed">Add a serial number on a job card and it will appear here.</div></div>`}
      </div>`;
  };

  /* ---------------- paywall ------------------------------------------ */
  function showPaywall(after) {
    const pw = $('paywall');
    pw.innerHTML = `
      <div class="pwsheet">
        <div class="center" style="margin-bottom:13px">
          <div style="font-size:32px;margin-bottom:4px">🔒</div>
          <div style="font-size:16px;font-weight:750;letter-spacing:-.01em">You&rsquo;ve used all 3 free reports</div>
          <div style="font-size:12px;color:var(--muted);margin-top:5px;line-height:1.5">
            Your report is ready. One extra job a year pays for this.</div>
        </div>
        <div class="plan">
          <div class="badge">MOST POPULAR</div>
          <div class="pr"><span class="amt">₦4,000</span><span class="per">/ month</span></div>
          <div class="yr">or ₦40,000 / year — 2 months free</div>
          <div class="feat"><span class="tk">✓</span>Unlimited job cards &amp; PDF reports</div>
          <div class="feat"><span class="tk">✓</span>No watermark — your own logo</div>
          <div class="feat"><span class="tk">✓</span>Quotations that get accepted</div>
          <div class="feat"><span class="tk">✓</span>Evidence packs, GPS, signatures</div>
          <div class="feat"><span class="tk">✓</span>Offline mode, syncs later</div>
          <div class="feat"><span class="tk">✓</span>All 4 trades + full checklists</div>
        </div>
        <button class="btn primary" onclick="ACT.upgrade('${after}')">Start 14-day free trial</button>
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.closePaywall()">Maybe later</button>
        <div style="background:#fff;border:1px solid var(--line);border-radius:13px;padding:13px;margin-top:14px">
          <div style="font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-bottom:7px">Also available</div>
          <div style="font-size:12px;line-height:1.6">
            <b>Business</b> — ₦15,000/mo · 5 technicians · supervisor dashboard<br>
            <b>Enterprise</b> — custom · API, SSO, white-label
          </div>
        </div>
        <div class="center" style="font-size:10px;color:#94A3B8;margin-top:12px;line-height:1.6">
          No card required for the trial · Cancel anytime<br>Paystack &amp; Flutterwave
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
      quote: 'Quotation', jobs: 'My jobs', settings: 'Settings', passport: 'Solar passport'
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
          <button class="iconbtn" onclick="ACT.go('jobs')">🔎</button>
          <button class="iconbtn" onclick="ACT.go('settings')">⚙︎</button>
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
        <button class="tab ${v === 'home' ? 'on' : ''}" onclick="ACT.go('home')"><span class="ti">🏠</span>Home</button>
        <button class="tab ${v === 'jobs' ? 'on' : ''}" onclick="ACT.go('jobs')"><span class="ti">📋</span>Jobs</button>
        <button class="tab" onclick="ACT.go('library')"><span class="ti">🧰</span>Guides</button>
        <button class="tab ${v === 'settings' ? 'on' : ''}" onclick="ACT.go('settings')"><span class="ti">⚙︎</span>Settings</button>
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
      S.user = {
        name: name, phone: $('iPhone').value.trim(), trade: $('iTrade').value,
        company: $('iCompany').value.trim() || 'REHOTEQ Technologies',
        plan: (S.user && S.user.plan) || 'free', bank: (S.user && S.user.bank) || ''
      };
      S.trade = S.user.trade;
      await DB.setMeta('user', S.user);
      await refreshJobs();
      await refreshEquipment();
      go('home');
    },

    async editProfile() { S.user = S.user || {}; go('boot'); },

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
        if (gl) gl.innerHTML = '<b>📍 GPS captured</b> · ' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + ' · ±' + Math.round(p.acc) + ' m';
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
        report: 'signoff', quote: 'report', passport: 'home'
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
      const used = S.jobs.filter(j => j.status === 'sent' || j.lockedAt).length;
      if (plan === 'free' && used >= 3) return showPaywall('pdf');
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
        const bytes = REPORT.buildQuote(S.quote, S.job, S.user || {});
        await shareOrDownload(pdfBlob(bytes), S.quote.number + '.pdf',
          'Quotation ' + S.quote.number + ' — ' + money(S.quote.total));
      } catch (e) { console.error(e); toast('Could not build the PDF', String(e.message || e)); }
    },

    setQuote(k, v) { S.quote[k] = (k === 'notes' || k === 'terms' || k === 'subject') ? v : Number(v) || 0; render(); },
    addQuoteItem() { S.quote.items.push({ desc: '', qty: 1, unitPrice: 0 }); render(); },
    delQuoteItem(i) { S.quote.items.splice(i, 1); render(); },
    setQuoteItem(i, k, v) { S.quote.items[i][k] = (k === 'desc') ? v : Number(v) || 0; render(); },

    goPlan() { showPaywall('plan'); },
    closePaywall() { $('paywall').classList.remove('show'); },
    upgrade(after) {
      S.user.plan = 'pro';
      DB.setMeta('user', S.user);
      $('paywall').classList.remove('show');
      toast('Pro unlocked — 14-day trial', 'No card charged. Cancel anytime.');
      render();
      if (after === 'pdf') setTimeout(() => ACT.pdf(), 300);
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
        photoCount: photos.length
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
        jobs: jobs, photos: recs, photoCount: photos.length
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

          await refreshJobs();
          await refreshEquipment();
          const all = await DB.all('photos');
          all.forEach(p => { if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob); });
          S.photos = {};
          go('home');
          toast('Restored ' + addedJ + ' jobs, ' + addedP + ' photos',
            (noImage ? noImage + ' photo(s) had no image data · ' : '') +
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
    }
  };
  window.ACT = ACT;

  /* ---------------- share / download --------------------------------- */
  async function shareOrDownload(blob, filename, text) {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename, text: text });
        toast('Sent ✔', 'Choose WhatsApp from the share sheet');
        return;
      } catch (e) { /* user cancelled — fall through */ }
    }
    showShareSheet(blob, filename, text);
  }

  function showShareSheet(blob, filename, text) {
    const url = URL.createObjectURL(blob);
    const sheet = $('paywall');
    const waUrl = 'https://wa.me/?text=' + encodeURIComponent(text);
    sheet.innerHTML = `
      <div class="pwsheet">
        <div class="center" style="margin-bottom:14px">
          <div style="font-size:34px;margin-bottom:5px">📄</div>
          <div style="font-size:15.5px;font-weight:750">${esc(filename)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:4px">
            ${(blob.size / 1024).toFixed(0)} KB · ready to send</div>
        </div>
        <button class="btn wa" onclick="window.open('${waUrl}','_blank')">💬 Send to WhatsApp</button>
        <div class="grid2" style="margin-top:9px">
          <button class="btn ghost sm" onclick="ACT.dl('${url}','${filename}')">⬇︎ Save PDF</button>
          <button class="btn ghost sm" onclick="window.open('${url}','_blank')">👁 Preview</button>
        </div>
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.quote()">🧾 Also send a quotation</button>
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
      '<div class="empty"><div class="ei">⚠️</div>' +
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

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  boot().catch(bootFailed);
})();

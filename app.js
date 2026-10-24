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

  // One place the version lives. It is printed in Settings and written
  // into every cloud backup label, so "which build made this backup" is
  // answerable months later.
  const APP_VERSION = '1.9.0';

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
    workerCode: '',
    // v1.9.0 cloud backup. `latest` is the label for the backup sitting in
    // the signed-in account's storage — the cached copy is read at boot so
    // the screen is right before the network answers, and refreshed from
    // Firestore as soon as sign-in resolves. `busy` stops a second tap
    // while an upload or a restore is in flight.
    cloud: { latest: null, busy: false, fromCache: false, lastRestore: null },
    // v1.8.4 account self-diagnosis: what the last "Account check" found,
    // so the answer stays on the screen instead of scrolling past in a
    // toast.
    accountCheck: null
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
    const fbU = fb !== undefined ? fb : S.fbUser;
    // Owner access is decided by the signed-in Google identity only. The
    // editable profile email must never grant it: anyone could type an
    // owner address into Edit profile and unlock every plan for free.
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

     v1.8.4 — the card is also the self-diagnosis for the wrong-account
     problem. Everything that disappointed a user (an invite that "did
     not act", a Field HQ row that never appeared) hangs off ONE thing:
     which Google account the phone is actually signed in as, which is
     not necessarily the address typed into the profile in Settings.
     So the signed-in Google account is printed plainly, and when it
     differs from the profile email the card says so and offers the way
     out. Two addresses on one phone is the bug we keep finding; this is
     how the technician sees it without asking anyone.
     ------------------------------------------------------------------ */
  // The comparison both the card and the check agree on.
  function accountDiagnosis() {
    const fb = S.fbUser;
    const out = {
      signedIn: !!fb,
      google: (fb && fb.email) || '',
      profile: ((S.user && S.user.email) || '').trim(),
      name: (fb && (fb.name || fb.email)) || '',
      owner: !!fb && isOwnerAccount(),
      mismatch: false
    };
    out.mismatch = !!(out.google && out.profile &&
      out.google.trim().toLowerCase() !== out.profile.toLowerCase());
    return out;
  }

  // The result of the last "Account check", rendered in the card. Kept in
  // one place so a signed-out phone shows it too: after the check has named
  // a wrong account, signing out must not wipe the explanation off the
  // screen before it has been read.
  function accountCheckPanel() {
    if (!S.accountCheck) return '';
    return `<div class="cb" style="padding-top:0">
            <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Checked ${esc(tstr(S.accountCheck.at))}</div>
            ${S.accountCheck.lines.map(l => `<div style="display:flex;gap:7px;align-items:flex-start;font-size:11.5px;
              line-height:1.5;margin-bottom:5px">
              <span style="flex:none;color:${l.ok ? '#0E7C5A' : '#B45309'};margin-top:1px">${
                ICON(l.ok ? 'check' : 'alert-triangle', 13)}</span>
              <span>${esc(l.text)}</span></div>`).join('')}
          </div>`;
  }

  function accountCard() {
    const u = S.fbUser;
    if (u) {
      const d = accountDiagnosis();
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
          <div class="cb" style="padding-top:9px;padding-bottom:2px;font-size:11.5px;color:var(--muted);line-height:1.55">
            Signed in with Google as <b>${esc(d.google)}</b>. Team invites, seat changes and
            Field HQ follow <b>this</b> Google account — not the email typed into your profile.
          </div>
          ${d.mismatch ? `<div class="cb" style="padding-top:2px">
            <div class="warnbox" style="margin:0">
              <div class="wh">${ICON('alert-triangle', 14)} Two different addresses on this phone</div>
              <div class="wt">Your profile says <b>${esc(d.profile)}</b>, but Google signed you in as
              <b>${esc(d.google)}</b>. An invite sent to one address will not act on the other, and
              the Field HQ row unlocks on the Google account only. If that is the wrong account,
              sign out below and pick the right one.</div>
            </div></div>` : ''}
          <div class="srow" onclick="ACT.accountCheck()"><span class="si">${ICON('eye', 17)}</span>
            <span class="sl">Account check<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Who this phone is signed in as, and what the server says</span></span>
            <span style="color:#94A3B8">›</span></div>
          ${accountCheckPanel()}
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
        ${accountCheckPanel()}
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
  function toast(msg, sub, ms) {
    const t = $('toast');
    t.innerHTML = esc(msg) + (sub ? '<span class="s">' + esc(sub) + '</span>' : '');
    t.classList.add('show');
    clearTimeout(S.toastT);
    S.toastT = setTimeout(() => t.classList.remove('show'), ms || 2800);
  }
  // Say WHY sign-in failed, and leave it up long enough to read. A refused
  // web address is not "check your connection", and a trip to Google that
  // comes back empty is not "nothing happened". firebase.js maps the code;
  // an older cached copy without the mapper still gets an honest line.
  function signInFailed(err) {
    const F = window.FB;
    const why = F && typeof F.authErrorText === 'function'
      ? F.authErrorText(err)
      : 'Check your connection and try again';
    toast('Sign-in did not finish', why, 9000);
  }
  function go(view) { S.view = view; render(); }

  /* ---------------- cloud backup helpers ------------------------------ */

  function mbLine(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  // "3 jobs · 21 photos · 18.4 MB" — what is actually up in the cloud,
  // printed from the label rather than guessed.
  function cloudLine(latest) {
    if (!latest) return '';
    const j = Number(latest.jobs) || 0, p = Number(latest.photos) || 0;
    return j + ' job' + (j === 1 ? '' : 's') + ' · ' + p + ' photo' + (p === 1 ? '' : 's') +
      (latest.bytes ? ' · ' + mbLine(latest.bytes) : '');
  }
  function cloudWhy(err) {
    const F = window.FB;
    if (F && typeof F.cloudErrText === 'function') return F.cloudErrText(err);
    return 'The cloud did not answer. Check your data or Wi-Fi, then try again.';
  }
  // A restore fails in one of two ways and they are not the same sentence:
  // the cloud did not hand the file over, or the file it handed over cannot
  // be opened. The second one is ours to fix, and the technician must not
  // be told to check his data for it.
  function restoreWhy(err) {
    const msg = String((err && err.message) || err || '');
    if (/not a REHOTEQ backup|not a zip|damaged zip|truncated zip|unsupported compression|unreadable|refused/i.test(msg)) {
      return 'The backup behind this account could not be opened (' + msg + '). Tell REHOTEQ — do not delete anything on this phone.';
    }
    return cloudWhy(err);
  }

  // Ask the cloud what it holds for the signed-in account. Never throws:
  // an offline phone keeps the screen it already had.
  async function refreshCloudInfo() {
    if (!S.fbUser || !window.FB || typeof window.FB.cloudLatest !== 'function') return null;
    try {
      const latest = await window.FB.cloudLatest();
      if (latest) {
        S.cloud.latest = latest;
        S.cloud.fromCache = false;
        await DB.setMeta('cloudBackup', latest);
      }
      if (S.view === 'settings' || S.view === 'boot' || S.view === 'home') render();
      return latest;
    } catch (e) { return null; }
  }

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

  /* ---------------- BACKUP — one file that is the whole phone ---------
     Everything the technician owns: the job cards, the photos with their
     stamps, the company profile, the crew record. zip.js writes it, and
     zip.js reads it — the same code path whether the file arrived from
     the cloud, from Downloads, or from a friend's phone over WhatsApp.

     Why a zip and not the JSON the file backup has always used: photos.
     In JSON every photo is base64 — a third bigger, and the whole archive
     has to exist in memory as one string. A technician with 300 job
     photos has a phone, not a workstation.

       backup.json       — format, version, exportedAt, user, jobs, team,
                           and one row per photo (its evidence metadata
                           plus the name of its file in the archive)
       photos/<id>.jpg   — the image bytes, untouched

     A zip of one of these opens on any phone, laptop or customer's PC,
     which is the point: an archive the technician cannot open is not
     really his.

     Photos are stored, never deflated: a JPEG is already compressed, so
     deflating it again spends battery to save nothing.
     -------------------------------------------------------------------- */
  const BACKUP = (function () {
    const FORMAT = 'rehoteq-field-backup';
    const VERSION = 2;

    function safeName(id) {
      return String(id === null || id === undefined ? 'photo' : id).replace(/[^A-Za-z0-9._-]+/g, '_');
    }

    // The manifest plus the image entries, built together so a photo row
    // can never name a file that is not in the archive.
    async function collect() {
      const jobs = await DB.all('jobs');
      const photos = await DB.all('photos');
      const rows = [];
      const entries = [];
      for (const p of photos) {
        let file = null;
        if (p.blob) {
          try {
            entries.push({ name: 'photos/' + safeName(p.id) + '.jpg', data: await IMG.blobToBytes(p.blob) });
            file = 'photos/' + safeName(p.id) + '.jpg';
          } catch (e) { file = null; }
        }
        rows.push({
          id: p.id, jobId: p.jobId, stage: p.stage, sha256: p.sha256,
          capturedAt: p.capturedAt, lat: p.lat, lng: p.lng, w: p.w, h: p.h,
          file: file
        });
      }
      const manifest = {
        format: FORMAT, version: VERSION,
        exportedAt: new Date().toISOString(),
        user: S.user || null,
        jobs: jobs,
        photos: rows,
        photoCount: photos.length,
        team: TEAM.serialize()
      };
      return { manifest: manifest, entries: entries, photos: photos.length,
        jobs: jobs.length, images: entries.length };
    }

    async function pack() {
      const c = await collect();
      const bytes = ZIP.build([{ name: 'backup.json', data: JSON.stringify(c.manifest) }].concat(c.entries));
      return {
        blob: new Blob([bytes], { type: 'application/zip' }),
        bytes: bytes.length,
        name: 'rehoteq-field-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
        at: c.manifest.exportedAt,
        jobs: c.jobs,
        photos: c.images,
        missing: c.photos - c.images,
        manifest: c.manifest
      };
    }

    // Read one back. Accepts a File, a Blob, a Uint8Array or an ArrayBuffer.
    // Returns exactly the shape applyRestore() wants, so the cloud path and
    // the file path cannot drift apart.
    async function unpack(input) {
      const files = await ZIP.read(input);
      const byName = {};
      files.forEach(f => { byName[f.name] = f; });
      const man = byName['backup.json'];
      if (!man) throw new Error('this is not a REHOTEQ backup (no backup.json inside)');

      let data;
      try { data = JSON.parse(ZIP.toText(man.data)); }
      catch (e) { throw new Error('the backup list inside the file is unreadable'); }
      if (!data || data.format !== FORMAT) throw new Error('this is not a REHOTEQ backup file');

      let damaged = 0;
      const photos = (Array.isArray(data.photos) ? data.photos : []).map(row => {
        const f = row.file ? byName[row.file] : null;
        const good = f && f.crcOk !== false;
        if (f && f.crcOk === false) damaged++;
        return Object.assign({}, row, {
          blob: good ? new Blob([f.data], { type: 'image/jpeg' }) : null
        });
      });

      return {
        format: FORMAT,
        data: data,
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        photos: photos,
        team: data.team || null,
        user: data.user || null,
        exportedAt: data.exportedAt || null,
        photoCount: photos.length,
        withImages: photos.filter(p => p.blob).length,
        damaged: damaged
      };
    }

    return { FORMAT: FORMAT, VERSION: VERSION, pack: pack, unpack: unpack, collect: collect };
  })();
  window.BACKUP = BACKUP;

  // The old .json backup — every photo carried as base64 inside the JSON.
  // Still readable: a technician who backed up in v1.8.x must never lose
  // that file to an upgrade.

  // v1.9.3 — the cloud copy was not always today's zip. Older builds kept
  // the backup as one JSON file, and an interrupted upload leaves a zip
  // with no end-of-directory record. The file-restore path already
  // tolerates the JSON shape (readJsonBackup); the cloud path now does
  // too, and when the stored copy is neither shape the error names its
  // size and first bytes, so a support ask can be answered in one look.
  async function unpackCloudCopy(copy) {
    let bytes;
    if (copy instanceof Uint8Array) bytes = copy;
    else if (copy instanceof ArrayBuffer) bytes = new Uint8Array(copy);
    else bytes = new Uint8Array(await copy.arrayBuffer());
    if (ZIP.isZip(bytes)) {
      try { return await BACKUP.unpack(bytes); }
      catch (e) {
        const msg = String((e && e.message) || e);
        if (/no end-of-directory|damaged zip|runs past the end|truncated/i.test(msg)) {
          throw new Error('the stored copy is ' + mbLine(bytes.length) +
            ' of an unfinished zip upload (' + msg + ') — nothing was deleted');
        }
        throw e;
      }
    }
    const text = (typeof copy.text === 'function') ? await copy.text()
      : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const trimmed = String(text).replace(/\s+/g, '');
    if (trimmed.charAt(0) === '{') {
      try { return await readJsonBackup(new Blob([text], { type: 'application/json' })); } catch (e) { /* fall through */ }
    }
    if (trimmed.slice(0, 4) === 'UEsD' && /^[A-Za-z0-9+/=]{8,}$/.test(trimmed.slice(0, 4096))) {
      try {
        const bin = atob(trimmed);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        if (ZIP.isZip(u8)) return await BACKUP.unpack(u8);
      } catch (e) { /* fall through */ }
    }
    const head = Array.prototype.map.call(bytes.subarray(0, 24),
      function (b) { return (b >= 32 && b < 127) ? String.fromCharCode(b) : '.'; }).join('');
    throw new Error('not a REHOTEQ backup (the stored copy is ' + mbLine(bytes.length) +
      ' and begins "' + head + '")');
  }

  async function readJsonBackup(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { throw new Error('that file is not readable as a backup'); }
    if (!data || data.format !== BACKUP.FORMAT) throw new Error('that is not a REHOTEQ backup file');
    const photos = (Array.isArray(data.photos) ? data.photos : []).map(row => {
      const rec = Object.assign({}, row);
      let blob = null;
      if (typeof rec.image === 'string' && rec.image) {
        try { blob = base64ToBlob(rec.image, 'image/jpeg'); } catch (e) { blob = null; }
      }
      delete rec.image;
      return Object.assign(rec, { blob: blob });
    });
    return {
      format: BACKUP.FORMAT, data: data,
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      photos: photos,
      team: data.team || null,
      user: data.user || null,
      exportedAt: data.exportedAt || null,
      photoCount: photos.length,
      withImages: photos.filter(p => p.blob).length,
      damaged: 0
    };
  }

  // Merge a backup in. Never a blind replace: a restore must not destroy
  // newer work on the phone that is being restored onto.
  async function applyRestore(p) {
    const jobs = Array.isArray(p.jobs) ? p.jobs : [];
    const photos = Array.isArray(p.photos) ? p.photos : [];
    if (!jobs.length && !photos.length && !p.team) throw new Error('that backup is empty');

    // Merge, never clobber. The restore asks first and then promises that
    // work already on this phone is merged, not deleted, so every record
    // is compared before it is written: the copy edited more recently
    // wins, and a photo this phone already holds keeps its real bytes
    // when the backup row arrives without image data.
    function jobStamp(j) {
      return String(j.updatedAt || j.lockedAt || j.completedAt || j.createdAt || j.startedAt || '');
    }

    let addedJ = 0, updatedJ = 0, keptJ = 0;
    for (const j of jobs) {
      if (!j || !j.id) continue;
      const existing = await DB.get('jobs', j.id);
      if (!existing) { addedJ++; await DB.put('jobs', j); continue; }
      const mine = jobStamp(existing), theirs = jobStamp(j);
      if (mine && (!theirs || mine >= theirs)) { keptJ++; continue; }
      updatedJ++;
      await DB.put('jobs', j);
    }

    let addedP = 0, noImage = 0, keptP = 0;
    for (const row of photos) {
      const rec = Object.assign({}, row);
      delete rec.file;
      if (!rec.blob) noImage++;
      if (!rec.id) continue;
      const existing = await DB.get('photos', rec.id);
      if (!existing) { addedP++; await DB.put('photos', rec); continue; }
      if (!rec.blob && existing.blob) { rec.blob = existing.blob; keptP++; }
      await DB.put('photos', rec);
    }

    if (p.user) { S.user = p.user; await DB.setMeta('user', p.user); }
    // Backups from before teams existed carry no team key at all;
    // restore() treats that as "nothing to do" rather than an error.
    const teamNote = p.team ? await TEAM.restore(p.team) : null;

    await refreshJobs();
    await loadUsageLedger();
    await refreshEquipment();
    const all = await DB.all('photos');
    all.forEach(x => { if (!x.url && x.blob) x.url = URL.createObjectURL(x.blob); });
    S.photos = {};
    go('home');
    return { addedJ: addedJ, updatedJ: updatedJ, keptJ: keptJ, addedP: addedP, noImage: noImage, keptP: keptP, teamNote: teamNote };
  }

  function restoreNote(r) {
    return (r.noImage ? r.noImage + ' photo(s) had no image data · ' : '') +
      (r.teamNote && (r.teamNote.company || r.teamNote.membersAdded) ? 'crew restored · ' : '') +
      (r.updatedJ ? r.updatedJ + ' existing job(s) updated' : 'Nothing overwritten') +
      (r.keptJ ? ' · ' + r.keptJ + ' newer edit(s) kept from this phone' : '');
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
    scheduleSync();
    await refreshJobs();
  }

  async function refreshJobs() {
    S.jobs = (await DB.all('jobs')).filter(j => !j.deletedAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /* ---------------- live sync (stage 1: job records) -----------------
     Phone to phone. Every job this phone saves, assigns or receives is
     pushed to the cloud jobs collection the moment the outbox flushes,
     and a listener applies what other signed-in phones write, so the
     boss's phone and the crew's phones see the same work without a
     backup tap or a WhatsApp file. The newer-edit-wins stamp that
     governs restore governs this too: the copy edited more recently
     wins, whatever wrote it last.

     Honest limits of this edition (stated on screen, not just here):
     - job records travel live; photo files still travel with the
       backup, so a job that arrived live shows its facts but its
       pictures wait until that phone restores
     - deletions stay local until the next backup; a job removed on one
       phone is not erased on the others yet
     ------------------------------------------------------------------ */

  let syncTimer = null;
  let syncStop = null;

  // The same precedence restore uses: the copy edited more recently wins.
  function jobStampOf(j) {
    return String(j.updatedAt || j.lockedAt || j.completedAt || j.createdAt || j.startedAt || '');
  }

  function liveSyncLabel() {
    if (!S.fbUser) return '<span style="color:#94A3B8">Off · sign in</span>';
    if (!S.online) return 'Waiting for signal';
    return '<span class="online-dot"></span>On';
  }

  function liveSyncInfo() {
    if (!S.fbUser) {
      toast('Live sync is off. Sign in with Google on every phone that should share, and jobs will travel between them on their own.');
      return;
    }
    if (!S.online) {
      toast('Live sync is waiting for signal. Work is saved on this phone and pushes the moment you are back online.');
      return;
    }
    toast('Live sync is on. Jobs you save reach your other signed-in phones within seconds, and theirs reach this one. Photo files still travel with the backup.');
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      await flushSync();
    }, 1500);
  }

  // Drain the outbox's job ops to the cloud. Every other kind of op stays
  // queued for the backup, the only rail that can carry it.
  async function flushSync() {
    if (!S.fbUser || !S.online) return;
    if (!window.FB || typeof window.FB.syncPush !== 'function') return;
    const ops = (await DB.pending()).filter(o => o.op &&
      (o.op.type === 'job.upsert' || o.op.type === 'team.assign' || o.op.type === 'team.update'));
    for (const o of ops) {
      const j = await DB.get('jobs', o.op.id);
      if (!j || j.deletedAt) { await DB.markSynced(o.id); continue; }
      try {
        const doc = JSON.parse(JSON.stringify(j));
        // The cloud job keeps the owner it was born with: a worker pushing
        // an assigned job must not claim the boss's record. A job this
        // phone created itself carries its owner now.
        if (!doc.ownerId) doc.ownerId = S.fbUser.uid;
        await window.FB.syncPush(doc);
        await DB.markSynced(o.id);
      } catch (e) {
        // One refused push must not stop the rest; the op stays queued and
        // the next flush (a save, a reconnect, a sign-in) tries again.
      }
    }
  }

  // A copy another phone wrote. Newer wins; this phone's own work is
  // never clobbered by an older copy, and a job this phone never saw is
  // simply added.
  async function applyRemoteJob(id, remote) {
    if (!id || !remote || remote.deletedAt) return;
    if (remote.id && remote.id !== id) remote = Object.assign({}, remote, { id: id });
    const local = await DB.get('jobs', id);
    if (!local) {
      await DB.put('jobs', remote);
      await refreshJobs();
      return;
    }
    const mine = jobStampOf(local), theirs = jobStampOf(remote);
    if (mine && (!theirs || mine >= theirs)) return;
    await DB.put('jobs', remote);
    if (S.job && S.job.id === id) S.job = JSON.parse(JSON.stringify(remote));
    await refreshJobs();
  }

  function startSyncWatch() {
    if (syncStop || !S.fbUser || !S.online) return;
    if (!window.FB || typeof window.FB.syncWatch !== 'function') return;
    syncStop = window.FB.syncWatch(async (id, remote) => {
      try { await applyRemoteJob(id, remote); } catch (e) { /* the next copy will land again */ }
    });
  }

  function stopSyncWatch() {
    if (syncStop) { syncStop(); syncStop = null; }
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
    // An invite that arrived by link waits here until the worker taps Join.
    S.pendingInvite = (await DB.getMeta('linkInvite')) || null;
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

  // URL-safe base64 for invite links. The payload rides in the URL, so
  // the alphabet must survive WhatsApp, browsers and the address bar.
  function enc64url(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function dec64url(str) {
    let t = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return decodeURIComponent(escape(atob(t)));
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

    async makeInvite(opts) {
      const t = teamState();
      if (myRole() !== 'owner' || !t.company) return { ok: false, error: 'notowner' };
      const o = opts || {};
      let code = makeCode();
      while (t.invites.some(i => i && i.code === code) ||
             t.workerLogins.some(w => w && w.code === code)) code = makeCode();
      const inv = { code: code, companyId: t.company.id, role: o.role === 'lead' ? 'lead' : 'tech', status: 'waiting', createdAt: new Date().toISOString() };
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
        role: inv.role || 'tech', ownerName: t.company.ownerName, branding: brandSnapshot(t.company), createdAt: inv.createdAt };
    },

    // The invite packed into a link: same payload as the file, minus the
    // logo bytes (too big for a URL). A worker taps the link in WhatsApp
    // and the app opens with the join card waiting — no file to import.
    // No server round trip: the whole invite rides in the URL, so it works
    // exactly as offline as everything else in this app.
    inviteLink(code) {
      const f = TEAM.inviteFile(code);
      if (!f) return null;
      const slim = Object.assign({}, f, { branding: Object.assign({}, f.branding, { logo: null }) });
      let json;
      try { json = JSON.stringify(slim); } catch (e) { return null; }
      return CONFIG.origin + '/?invite=' + enc64url(json);
    },

    inviteFromLink(url) {
      let raw = '';
      try {
        const u = new URL(String(url || ''));
        raw = u.searchParams.get('invite') || '';
        if (!raw && u.hash && u.hash.indexOf('invite=') >= 0) raw = u.hash.split('invite=')[1].split('&')[0];
      } catch (e) { return null; }
      if (!raw) return null;
      let f = null;
      try { f = JSON.parse(dec64url(raw)); } catch (e) { return null; }
      if (!f || f.format !== TEAM_FORMAT || f.kind !== 'invite') return null;
      if (!f.companyId || !f.branding || !f.branding.name) return null;
      if (!/^RQ-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(f.code || ''))) return null;
      f.role = f.role === 'lead' ? 'lead' : 'tech';
      return f;
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
        role: file.role === 'lead' ? 'lead' : 'tech',
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
        role: m.role || 'tech',
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
        dup.role = file.role === 'lead' ? 'lead' : (dup.role || 'tech');
        if (inv) inv.status = 'joined';
        if (workerLogin) { workerLogin.status = 'joined'; workerLogin.memberId = m.memberId; }
        await teamSave();
        return { ok: true, member: dup, again: true };
      }
      const s = TEAM.seats();
      if (s.used >= s.paid) return { ok: false, error: 'full' };
      const rec = { memberId: m.memberId, name: m.name, phone: m.phone || '',
        role: file.role === 'lead' ? 'lead' : 'tech',
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
      scheduleSync();
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
      scheduleSync();
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
  // when the device has one, Downloads when it does not. A share the user
  // dismisses (or the platform drops) is NOT a sent file: the caller gets
  // false and a line on screen, so the button stays live for a retry and
  // nothing downstream is marked "sent" on a promise the phone never kept.
  async function shareTeamFile(obj, filename, sentMsg) {
    const json = JSON.stringify(obj);
    const file = new File([json], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        toast(sentMsg || 'Sent', 'Choose WhatsApp from the share sheet');
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          toast('Nothing was sent', 'The share sheet closed — tap again and choose WhatsApp');
          return false;
        }
        // A real share failure (no target app, the WebView dropped the
        // sheet): fall through to the download path so the file still
        // leaves the phone instead of vanishing silently.
      }
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
  const WELCOME_MARK_SVG = `<svg class="w-svg" viewBox="0 0 120 120" role="img" aria-label="REHOTEQ Field mark"><defs><linearGradient id="wFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#1E1B4B"/></linearGradient><linearGradient id="wNeon" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#A78BFA"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs><path class="w-hex" d="M 53.94 9.50 Q 60.00 6.00 66.06 9.50 L 100.70 29.50 Q 106.77 33.00 106.77 40.00 L 106.77 80.00 Q 106.77 87.00 100.70 90.50 L 66.06 110.50 Q 60.00 114.00 53.94 110.50 L 19.30 90.50 Q 13.23 87.00 13.23 80.00 L 13.23 40.00 Q 13.23 33.00 19.30 29.50 L 53.94 9.50 Z" fill="url(#wFill)"/><path class="w-hex" d="M 53.94 9.50 Q 60.00 6.00 66.06 9.50 L 100.70 29.50 Q 106.77 33.00 106.77 40.00 L 106.77 80.00 Q 106.77 87.00 100.70 90.50 L 66.06 110.50 Q 60.00 114.00 53.94 110.50 L 19.30 90.50 Q 13.23 87.00 13.23 80.00 L 13.23 40.00 Q 13.23 33.00 19.30 29.50 L 53.94 9.50 Z" fill="none" stroke="url(#wNeon)" stroke-width="4.5" stroke-linejoin="round"/><path class="w-sweep w-sweep-soft" d="M 53.94 9.50 Q 60.00 6.00 66.06 9.50 L 100.70 29.50 Q 106.77 33.00 106.77 40.00 L 106.77 80.00 Q 106.77 87.00 100.70 90.50 L 66.06 110.50 Q 60.00 114.00 53.94 110.50 L 19.30 90.50 Q 13.23 87.00 13.23 80.00 L 13.23 40.00 Q 13.23 33.00 19.30 29.50 L 53.94 9.50 Z" stroke-dasharray="9.0 307.6" stroke-dashoffset="0"/><path class="w-sweep w-sweep-core" d="M 53.94 9.50 Q 60.00 6.00 66.06 9.50 L 100.70 29.50 Q 106.77 33.00 106.77 40.00 L 106.77 80.00 Q 106.77 87.00 100.70 90.50 L 66.06 110.50 Q 60.00 114.00 53.94 110.50 L 19.30 90.50 Q 13.23 87.00 13.23 80.00 L 13.23 40.00 Q 13.23 33.00 19.30 29.50 L 53.94 9.50 Z" stroke-dasharray="9.0 307.6" stroke-dashoffset="0"/><text class="w-r" x="60" y="75" text-anchor="middle" font-size="53" font-weight="800" fill="#fff">R</text><g class="w-wrench"><path d="M 26.22 41.78 L 24.69 39.85 L 23.62 37.63 L 23.07 35.23 L 23.07 32.77 L 23.62 30.37 L 24.69 28.15 L 26.22 26.22 L 28.15 24.69 L 30.37 23.62 L 32.77 23.07 L 35.23 23.07 L 37.63 23.62 L 39.85 24.69 L 41.78 26.22 L 119.78 104.22 L 121.31 106.15 L 122.38 108.37 L 122.93 110.77 L 122.93 113.23 L 122.38 115.63 L 121.31 117.85 L 119.78 119.78 L 117.85 121.31 L 115.63 122.38 L 113.23 122.93 L 110.77 122.93 L 108.37 122.38 L 106.15 121.31 L 104.22 119.78 Z M 121.66 137.21 L 119.33 137.99 L 116.95 138.54 L 114.52 138.88 L 112.08 139.00 L 109.63 138.90 L 107.20 138.57 L 104.82 138.03 L 102.49 137.27 L 100.24 136.30 L 98.08 135.14 L 96.04 133.78 L 94.14 132.25 L 92.37 130.54 L 90.78 128.69 L 89.35 126.70 L 88.11 124.58 L 87.07 122.37 L 86.23 120.07 L 85.61 117.70 L 85.20 115.28 L 85.01 112.84 L 85.05 110.39 L 85.30 107.96 L 85.78 105.56 L 86.47 103.21 L 87.37 100.93 L 88.48 98.74 L 89.78 96.67 L 91.26 94.72 L 92.91 92.91 L 94.72 91.26 L 96.67 89.78 L 98.74 88.48 L 100.93 87.37 L 103.21 86.47 L 105.56 85.78 L 107.96 85.30 L 110.39 85.05 L 112.84 85.01 L 115.28 85.20 L 117.70 85.61 L 120.07 86.23 L 122.37 87.07 L 124.58 88.11 L 126.70 89.35 L 128.69 90.78 L 130.54 92.37 L 132.25 94.14 L 133.78 96.04 L 135.14 98.08 L 136.30 100.24 L 137.27 102.49 L 138.03 104.82 L 138.57 107.20 L 138.90 109.63 L 139.00 112.08 L 138.88 114.52 L 138.54 116.95 L 137.99 119.33 L 137.21 121.66 L 126.85 111.29 L 111.29 126.85 Z M 42.00 34.00 L 41.61 31.53 L 40.47 29.30 L 38.70 27.53 L 36.47 26.39 L 34.00 26.00 L 31.53 26.39 L 29.30 27.53 L 27.53 29.30 L 26.39 31.53 L 26.00 34.00 L 26.39 36.47 L 27.53 38.70 L 29.30 40.47 L 31.53 41.61 L 34.00 42.00 L 36.47 41.61 L 38.70 40.47 L 40.47 38.70 L 41.61 36.47 L 42.00 34.00 Z" fill="#fff" transform="translate(87 83.5) scale(0.13) translate(-110 -110)"/></g></svg>`;

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
            ${WELCOME_MARK_SVG}
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
    // v1.9.0: a new or wiped phone lands here, signed in with the same
    // Google account, and the one thing that matters is one tap away.
    // Only shown when signed in AND a backup actually exists — the banner
    // is never an advert.
    const cloud = S.fbUser && S.cloud.latest && S.cloud.latest.updatedAt ? S.cloud.latest : null;
    return `
    <div class="pad" style="padding-top:${isEditing ? '24px' : '18px'}">
      ${cloud ? `
        <div class="card" style="margin-bottom:12px;border:1.5px solid var(--primary)">
          <div class="cb">
            <div style="display:flex;align-items:center;gap:9px;margin-bottom:7px">
              <span style="color:var(--primary-d)">${ICON('cloud', 18)}</span>
              <b style="font-size:13.5px">Your work is in the cloud</b>
            </div>
            <div style="font-size:12px;color:var(--muted);line-height:1.55;margin-bottom:11px">
              Signed in as <b>${esc(S.fbUser.email || '')}</b>. A backup from
              <b>${esc(dstr(cloud.updatedAt))}</b> is waiting: ${esc(cloudLine(cloud))}.
              Restore it and this phone becomes that backup — job cards, photos, profile and crew.
            </div>
            <button class="btn primary" style="width:100%" onclick="ACT.cloudRestore()">
              ${ICON('download', 17)} Restore from the cloud</button>
            <button class="btn ghost sm" style="width:100%;margin-top:8px" onclick="ACT.go('settings')">
              Start fresh instead</button>
          </div>
        </div>` : ''}
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
          <div style="position:relative;width:126px;height:112px;margin:0 auto 10px;display:grid;place-items:center">
            <svg viewBox="0 0 100 100" style="position:absolute;inset:0;width:100%;height:100%" aria-hidden="true">
              <defs><linearGradient id="hexglow" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#A78BFA"/><stop offset="1" stop-color="#22D3EE"/>
              </linearGradient></defs>
              <polygon points="50,5 91,27.5 91,72.5 50,95 9,72.5 9,27.5" fill="none" stroke="url(#hexglow)" stroke-width="3.4" stroke-linejoin="round" style="filter:drop-shadow(0 0 9px rgba(124,58,237,.55))"/>
            </svg>
            <div style="width:56px;height:56px;border-radius:17px;
              background:linear-gradient(145deg,#7C3AED,#4C1D95);display:grid;place-items:center;
              box-shadow:0 12px 28px rgba(76,29,149,.38)">
              <span style="font-size:23px;font-weight:800;color:#fff">R</span></div>
          </div>
          <div style="font-size:21px;font-weight:800;letter-spacing:-.03em">REHOTEQ <span style="color:#6D28D9">Field</span></div>
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
            <div class="ch">Ranked causes <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#6D28D9">
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
          <div class="ch">Possible issue <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#6D28D9">${e.causes.length} found</span></div>
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
          <div class="ch">4 · Materials used <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#6D28D9"
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
        <div class="bar" style="margin-bottom:14px"><i style="width:${(done / items.length) * 100}%;background:linear-gradient(90deg,#6D28D9,#A78BFA)"></i></div>
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
        <div style="padding:0 16px 10px">
          <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.06em;margin:2px 0 7px">SEND TO THE CLIENT</div>
          <div class="btnrow">
            <button class="btn ghost sm" style="flex:1" onclick="ACT.shareClientReport('wa')">${ICON('share-2', 14)} WhatsApp</button>
            <button class="btn ghost sm" style="flex:1" onclick="ACT.shareClientReport('mail')">${ICON('send', 14)} Email</button>
            <button class="btn ghost sm" style="flex:1" onclick="ACT.shareClientReport('copy')">${ICON('clipboard-list', 14)} Copy link</button>
          </div>
          <div class="hintline" style="margin-top:8px">The link opens the report in any browser — no app, no account. Photos and signatures travel with the PDF.</div>
        </div>
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
            ${owner ? `<button class="switch ${plan !== 'free' ? 'on' : ''}" onclick="ACT.togglePlan(this)"></button>` : ''}</div>
          <div class="srow" onclick="ACT.goPlan()"><span class="si">${ICON('credit-card', 17)}</span>
            <span class="sl">Plans &amp; pricing</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Field settings</div>
          <div class="srow"><span class="si">${ICON('signal', 17)}</span><span class="sl">Data saver</span>
            <span class="sv">Photos ≤ 350 KB</span></div>
          <div class="srow"><span class="si">${ICON('cloud', 17)}</span><span class="sl">Offline</span>
            <span class="sv">${S.online ? '<span class="online-dot"></span>Online' : '<span class="offline-dot"></span>Offline — work is saved'}</span></div>
          <div class="srow" onclick="ACT.liveSyncInfo()"><span class="si">${ICON('users', 17)}</span><span class="sl">Live sync</span>
            <span class="sv">${liveSyncLabel()}</span></div>
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
          ${S.fbUser ? `
          <div class="srow" onclick="ACT.cloudBackup()"><span class="si">${ICON('cloud', 17)}</span>
            <span class="sl">Back up this phone to the cloud<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">${
                S.cloud.busy ? (S.cloud.progress != null ? 'Downloading — ' + S.cloud.progress + '% — do not close the app' : 'Working — do not close the app')
                : S.cloud.latest && S.cloud.latest.updatedAt
                  ? 'Saved ' + dstr(S.cloud.latest.updatedAt) + ' · ' + cloudLine(S.cloud.latest) + (S.cloud.latest.email ? ' · ' + S.cloud.latest.email : '')
                  : 'One tap · jobs + photos · says the date when it is done'}</span></span>
            <span style="color:#0E7C5A;font-weight:700">${S.cloud.busy ? '…' : (S.cloud.latest && S.cloud.latest.updatedAt ? 'Update' : 'Best')}</span></div>
          <div class="srow" onclick="ACT.cloudRestore()"><span class="si">${ICON('download', 17)}</span>
            <span class="sl">Restore from the cloud<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">${
                S.cloud.latest && S.cloud.latest.updatedAt
                  ? 'Backup of ' + dstr(S.cloud.latest.updatedAt) + ' · asks before it changes anything'
                  : 'Nothing saved on this account yet'}</span></span>
            <span style="color:#94A3B8">›</span></div>` : ''}
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
            <span class="sl">Restore from backup<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">A .zip from the cloud, or an older .json file</span></span>
            <span style="color:#94A3B8">›</span></div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Support</div>
          <div class="srow" onclick="ACT.sendFeedback()"><span class="si">${ICON('send', 17)}</span>
            <span class="sl">Send feedback to REHOTEQ<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Ideas, bugs, what to build next</span></span>
            <span style="color:#94A3B8">›</span></div>
          <div class="srow" onclick="ACT.contact()"><span class="si">${ICON('message-circle', 17)}</span>
            <span class="sl">Message REHOTEQ on WhatsApp<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">${esc(CONFIG.support.whatsappLabel)}</span></span>
            <span style="color:#94A3B8">›</span></div>
          ${owner ? `
          <div class="srow" onclick="ACT.openAdmin()"><span class="si">${ICON('shield-check', 17)}</span>
            <span class="sl">Field HQ (admin only)<br>
              <span style="font-size:11px;color:var(--muted);font-weight:500">Usage, users, internal feedback · owner email only</span></span>
            <span style="color:#94A3B8">›</span></div>` : ''}
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="ch">Data</div>
          <div class="srow" onclick="ACT.loadDemo()"><span class="si">${ICON('play', 17)}</span>
            <span class="sl">Load a demo job</span><span class="sv">Try the PDF in one tap</span></div>
          <div class="srow" onclick="ACT.wipe()"><span class="si">${ICON('trash-2', 17)}</span>
            <span class="sl" style="color:#DC2626">Delete everything on this device</span><span style="color:#94A3B8">›</span></div>
        </div>
        <div class="center" style="font-size:10.5px;color:#94A3B8;line-height:1.7">
          REHOTEQ Field v${APP_VERSION} · PWA<br>Built for the people holding the phone.
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
          <div style="background:linear-gradient(150deg,#4C1D95,#1E1B4B);color:#fff;border-radius:18px;padding:17px;margin-bottom:12px">
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
            <div class="ch">QR sticker <span style="text-transform:none;letter-spacing:0;font-weight:700;color:#6D28D9"
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
          <div style="font-size:11px;font-weight:800;color:#6D28D9">STEP 1 · CREATE THE INVITE</div>
          ${stepShare ? `
            <div style="text-align:center;margin:10px 0 2px">
              <div style="font-size:10px;color:var(--muted);letter-spacing:.06em">INVITE CODE</div>
              <div class="mono" style="font-size:24px;font-weight:800;letter-spacing:.08em;color:var(--ink)">${esc(stepShare.code)}</div>
            </div>`
          : `
            <div style="font-size:12px;color:var(--muted);margin:6px 0 9px">One tap. Seats left: ${Math.max(0, s.paid - s.used)}.</div>
            <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.06em;margin-bottom:6px">THEIR ROLE</div>
            <div class="btnrow" style="margin-bottom:9px">
              <button class="btn ${(S.inviteRole || 'tech') !== 'lead' ? 'primary' : 'ghost'} sm" style="flex:1" onclick="ACT.setInviteRole('tech')">${ICON('user-plus', 14)} Technician</button>
              <button class="btn ${(S.inviteRole || 'tech') === 'lead' ? 'primary' : 'ghost'} sm" style="flex:1" onclick="ACT.setInviteRole('lead')">${ICON('shield-check', 14)} Team lead</button>
            </div>
            <button class="btn primary sm" style="width:100%" onclick="ACT.makeInvite()" ${full ? 'disabled' : ''}>
              ${ICON('user-plus', 15)} Create the invite</button>
            ${full ? '<div class="hintline" style="margin-top:8px">All seats are used — add seats first.</div>' : ''}`}
        </div></div>
        ${stepShare ? `
        <div class="card" style="margin-top:12px"><div class="cb">
          <div style="font-size:11px;font-weight:800;color:#6D28D9">STEP 2 · SEND IT ON WHATSAPP</div>
          <div style="font-size:12px;color:var(--muted);margin:6px 0 9px">Tap below, choose their chat, and send. The file carries the invite code automatically.</div>
          <button class="btn primary sm" style="width:100%" onclick="ACT.resendInvite('${esc(stepShare.code)}')">
            ${ICON('send', 15)} Send the invite file</button>
          <div class="btnrow" style="margin-top:9px">
            <button class="btn ghost sm" style="flex:1" onclick="ACT.shareInviteLink('${esc(stepShare.code)}')">${ICON('share-2', 14)} Share the link</button>
            <button class="btn ghost sm" style="flex:1" onclick="ACT.copyInviteLink('${esc(stepShare.code)}')">${ICON('clipboard-list', 14)} Copy link</button>
          </div>
          <div class="hintline" style="margin-top:8px">The link is the easy way: they tap it, the app opens, they tap Join. The file still works too.</div>
        </div></div>
        <div class="card" style="margin-top:12px"><div class="cb">
          <div style="font-size:11px;font-weight:800;color:#6D28D9">STEP 3 · WHAT THEY DO</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.8;margin-top:6px">
            With the link: they tap it, tap <b>Join</b>, then <b>Send acceptance</b> — and they appear here when you import it.<br><br>
            With the file: Team tab, <b>Import file from WhatsApp</b>, pick the file, then <b>Send acceptance</b>. You import the acceptance the same way.</div>
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
    if (t.company) return teamStrangerView(t);
    return teamNoneView();
  };

  // The phone still holds a crew, but this profile is neither its owner
  // nor a member. The generic landing read as if the crew had vanished;
  // this says exactly whose crew it is and how to get back into it.
  function teamStrangerView(t) {
    const me = (S.user && S.user.name) || 'this profile';
    return `
      <div class="pad">
        <div class="empty"><div class="ei">${ICON('users', 26)}</div>
          <div class="et">${esc(t.company.name || 'A crew')}</div>
          <div class="ed">This crew is saved on this phone, but <b>${esc(me)}</b> is not
          signed in as its owner or a member. If you run the crew, log back in as
          ${esc(t.company.ownerName || 'the owner')}; if you are a technician, import
          the invite or worker file they sent.</div></div>
        <button class="btn primary sm" onclick="ACT.loginAccount('${esc(t.company.ownerId || '')}')">${ICON('user', 15)} Log in as ${esc(t.company.ownerName || 'the owner')}</button>
        <button class="btn ghost sm" style="margin-top:9px" onclick="ACT.receiveFile()">${ICON('inbox', 15)} Join a company (import the invite they sent)</button>
      </div>`;
  }

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
                <div class="jt">${esc(m.name)}${m.role === 'lead' ? ' · Lead' : ''}</div>
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
              <div class="js">Sent ${dstr(i.createdAt)} — ${i.role === 'lead' ? 'team lead' : 'technician'} invite, waiting for their acceptance</div>
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
    const inv = S.pendingInvite;
    if (inv && inv.branding && inv.branding.name) {
      return `
      <div class="pad">
        <div class="card"><div class="cb">
          <div style="font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted)">TEAM INVITE</div>
          <div style="font-size:17px;font-weight:800;margin:3px 0">${esc(inv.branding.name)}</div>
          <div style="font-size:12px;color:var(--muted)">${inv.ownerName ? esc(inv.ownerName) + ' invited you' : 'You were invited'} ·
            ${inv.role === 'lead' ? 'Team lead' : 'Technician'}</div>
        </div></div>
        <button class="btn primary sm" style="width:100%;margin-top:12px" onclick="ACT.joinFromLink()">${ICON('user-plus', 15)} Join ${esc(inv.branding.name)}</button>
        <button class="btn ghost sm" style="width:100%;margin-top:9px" onclick="ACT.clearLinkInvite()">Not now</button>
        <div class="hintline" style="margin-top:9px">New here? Create your profile first, then come back to Team and tap Join.</div>
      </div>`;
    }
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
        <div style="font-size:12px;color:rgba(255,255,255,.82);margin-top:7px">
          Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'},
          <b style="color:#fff">${esc((S.user && S.user.name) || 'there')}</b>
          ${!S.online ? ' · <span style="color:#FFC9C2">offline</span>' : ''}
        </div></div>`;
    }
    const hasTab = ['home', 'jobs', 'settings'].includes(v);
    const body = v === 'welcome' ? V.welcome() : (v === 'report' ? V.report() : `<div class="scroll">${(V[v] || V.home)()}</div>`);
    app().innerHTML = bar + body +
      (hasTab ? `<div class="tabbar">
        <button class="tab t-home ${v === 'home' ? 'on' : ''}" onclick="ACT.go('home')"><span class="ti">${ICON('house', 20)}</span>Home</button>
        <button class="tab t-jobs ${v === 'jobs' ? 'on' : ''}" onclick="ACT.go('jobs')"><span class="ti">${ICON('clipboard-list', 20)}</span>Jobs</button>
        <button class="tab t-library" onclick="ACT.go('library')"><span class="ti">${ICON('wrench', 20)}</span>Guides</button>
        <button class="tab t-settings ${v === 'settings' ? 'on' : ''}" onclick="ACT.go('settings')"><span class="ti">${ICON('settings-2', 20)}</span>Settings</button>
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
    // Test hook only: the harness cannot reach the module-scoped S, so it
    // simulates a signed-in Google account through this setter. It mirrors
    // exactly what firebase.js writes on a real sign-in, nothing more.
    _fbUser(u) { S.fbUser = u; },
    _flushSyncForTest: flushSync,
    _applyRemoteForTest: applyRemoteJob,
    liveSyncInfo: () => liveSyncInfo(),
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

      // Owner access follows the signed-in Google account, never this
      // form: saving a profile email can neither grant nor keep it.
      const wasOwnerProfile = isOwnerEmail(prev.email) || Boolean(prev.ownerAccess);
      S.user.ownerAccess = isOwnerAccount(S.user, S.fbUser);
      if (S.user.ownerAccess && (!prev.plan || prev.plan === 'free')) S.user.plan = 'business';
      if (!S.user.ownerAccess && wasOwnerProfile && (!prev.plan || prev.plan === 'business')) {
        S.user.plan = 'free';
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
    // Field HQ console (admin.html). The row only renders for the owner
    // account; admin.html and firestore.rules keep the data owner-only even
    // if someone reaches the page directly.
    openAdmin() {
      location.assign('admin.html');
    },
    // The internal feedback box: one note straight to the feedback
    // collection, which only the owner can read (firestore.rules).
    async sendFeedback() {
      const t = (window.prompt('What should we improve, fix, or build next?') || '').trim();
      if (!t) return;
      if (!window.FB || !FB.enabled() || !S.fbUser) {
        toast('Sign in first', 'Feedback syncs with your account, so it needs you signed in');
        return;
      }
      try {
        await FB.sendFeedback(t);
        toast('Thank you', 'Your feedback reached REHOTEQ HQ');
      } catch (e) {
        toast('Not sent', 'You seem to be offline. Try again when you have data');
      }
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
        signInFailed(e);   // the real reason, e.g. an address missing from the allow-list
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
      if (!isOwnerAccount(S.user, S.fbUser)) { toast('Owner only', 'Plan switching stays with the account owner'); return; }
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
      if (!p.length) {
        return toast('Sync queue is clear', 'Everything this phone has done is already in your cloud backup.');
      }
      toast(p.length + ' item(s) waiting to sync',
        S.fbUser
          ? 'That is work done since your last cloud backup. Tap Back up this phone to the cloud to carry it up — the count clears when the backup finishes.'
          : 'Your work is safe on this device. Sign in with Google in Settings → Account, then tap Back up this phone to the cloud to copy it to your account.');
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

    // A .zip from the cloud (or from a friend's phone) or an older .json
    // file. The file is routed by its bytes, not its name, so a renamed
    // file still opens.
    importBackup() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,.zip,application/json,application/zip';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          // Routed by its bytes, not by its name: a zip is a zip even if it
          // was renamed on the way through WhatsApp, and a .json from
          // v1.8.x is still read as what it is.
          const bytes = new Uint8Array(await f.arrayBuffer());
          const p = ZIP.isZip(bytes) ? await BACKUP.unpack(bytes) : await readJsonBackup(f);
          const r = await applyRestore(p);
          toast('Restored ' + r.addedJ + ' jobs, ' + r.addedP + ' photos', restoreNote(r));
        } catch (e) {
          toast('Could not read that file', String(e.message || e));
        }
      };
      input.click();
    },

    /* ---- v1.9.0 cloud backup -----------------------------------------
       One tap on a good connection for the technician; one tap and a
       confirmation for the phone that lost everything. Both live behind
       a Google sign-in, because a backup has to belong to somebody.
       ---------------------------------------------------------------- */
    async cloudBackup() {
      if (S.cloud.busy) return;
      if (!S.fbUser) {
        return toast('Sign in first', 'Settings → Account → Sign in with Google. The backup belongs to your account.');
      }
      if (!window.FB || typeof window.FB.cloudUpload !== 'function') {
        return toast('Cloud backup needs the new version', 'Reload the app (or update it) and try again');
      }
      if (!S.online) {
        return toast('No connection right now', 'A cloud backup uploads the file — try again when you have data');
      }
      S.cloud.busy = true;
      render();
      let bundle = null;
      try {
        bundle = await BACKUP.pack();
      } catch (e) {
        // Reading this phone failed, which is not the cloud's fault and
        // must not be reported as if it were.
        S.cloud.busy = false;
        return toast('Could not read this phone to back it up',
          String((e && e.message) || e) + ' — nothing was sent', 8000);
      }
      try {
        await window.FB.cloudUpload(bundle.blob, {
          jobs: bundle.jobs, photos: bundle.photos,
          bytes: bundle.bytes, appVersion: APP_VERSION
        });
        const at = new Date().toISOString();
        S.lastBackup = at;
        S.cloud.latest = {
          updatedAt: at, jobs: bundle.jobs, photos: bundle.photos,
          bytes: bundle.bytes, appVersion: APP_VERSION
        };
        await DB.setMeta('lastBackup', at);
        await DB.setMeta('cloudBackup', S.cloud.latest);
        // The backup just carried this phone's work to the cloud, so the
        // sync queue has nothing left to wait for. Drain it here — the
        // only place "synced" may be claimed, because this is where the
        // copy verifiably exists on the account.
        const carried = await DB.markAllSynced();
        toast('Backed up to the cloud — ' + dstr(at),
          bundle.jobs + ' jobs · ' + bundle.photos + ' photos · ' + mbLine(bundle.bytes) +
          (carried ? ' · ' + carried + ' queued item(s) carried up' : '') +
          (bundle.missing ? ' · ' + bundle.missing + ' photo(s) had no image data' : ''));
      } catch (e) {
        toast('Cloud backup did not finish', cloudWhy(e), 8000);
      }
      S.cloud.busy = false;
      render();
    },

    // The phone is new, or wiped, or came back from a repair. Sign in with
    // the same Google account and this turns it into the backup. It asks
    // first, and it merges rather than wipes: work done on this phone since
    // the backup is not thrown away.
    async cloudRestore() {
      if (S.cloud.busy) return;
      if (!S.fbUser) {
        return toast('Sign in first', 'Settings → Account → Sign in with Google — the same account that made the backup');
      }
      if (!window.FB || typeof window.FB.cloudDownload !== 'function') {
        return toast('Cloud restore needs the new version', 'Reload the app (or update it) and try again');
      }
      if (!S.online) {
        return toast('No connection right now', 'A restore downloads the file — try again when you have data');
      }
      const latest = S.cloud.latest;
      if (!latest || !latest.updatedAt) {
        return toast('Nothing saved on this account yet',
          'The cloud backup lives under the Google account that made it. Settings → Account shows who is signed in; Back up this phone to the cloud puts a copy on this account.');
      }
      const when = dstr(latest.updatedAt);
      const what = ' (' + cloudLine(latest) + (latest.email ? ' · ' + latest.email : '') + ')';
      if (!confirm('Restore the cloud backup' + (when ? ' from ' + when : '') + what + '?\n\n' +
        'Everything in that backup comes back onto this phone: job cards, photos, your profile ' +
        'and your crew. Work already on this phone is merged, not deleted.\n\n' +
        'Use this on a new or wiped phone — not to undo a job you finished ten minutes ago.')) {
        return;
      }
      S.cloud.busy = true;
      S.cloud.progress = null;
      render();
      try {
        const blob = await window.FB.cloudDownload(function (pct) {
          S.cloud.progress = pct;
          if (S.view === 'settings') render();
        });
        const p = await unpackCloudCopy(blob);
        S.cloud.lastRestore = { at: new Date().toISOString(), from: p.exportedAt };
        const r = await applyRestore(p);
        S.lastBackup = S.lastBackup || p.exportedAt || new Date().toISOString();
        await DB.setMeta('lastBackup', S.lastBackup);
        toast('Restored ' + r.addedJ + ' jobs, ' + r.addedP + ' photos' +
          (p.exportedAt ? ' — backup of ' + dstr(p.exportedAt) : ''), restoreNote(r), 7000);
      } catch (e) {
        toast('Cloud restore did not finish', restoreWhy(e), 8000);
      }
      S.cloud.busy = false;
      render();
    },

    // v1.8.4 — the answer to "why is my invite not acting?" on the screen
    // instead of in a support chat. It reports what this device knows and
    // what the server said, and it names the mismatch when there is one.
    async accountCheck() {
      const d = accountDiagnosis();
      if (!d.signedIn) {
        S.accountCheck = { at: new Date().toISOString(), lines: [
          { ok: false, text: 'No Google account is signed in on this phone. Team invites, seat changes and Field HQ need one — tap Sign in with Google above.' }
        ] };
        return render();
      }
      const lines = [
        { ok: true, text: 'Google account signed in on this phone: ' + d.google },
        { ok: !d.mismatch, text: d.mismatch
          ? 'The profile in Settings says ' + d.profile + ' — a different address. Invites act on the Google account, so send them to ' + d.google + '.'
          : (d.profile ? 'The profile email matches the Google account (' + d.profile + ').'
                       : 'No profile email set yet — that is fine, the Google account above is what counts.') },
        { ok: d.owner, text: d.owner
          ? 'This account IS the owner account — the Field HQ row is unlocked.'
          : 'Not an owner account, so the Field HQ row is meant to be hidden. Admin is owner-only.' }
      ];

      // What the server says. The trial clock and the plan are written by
      // a Cloud Function; if this comes back empty the account record is
      // missing, which is the other half of the wrong-account problem.
      let rec = null;
      try { rec = await window.FB.profile(); } catch (e) { rec = null; }
      if (rec) {
        const t = rec.trialEndsAt
          ? (rec.trialEndsAt.toDate ? rec.trialEndsAt.toDate().toISOString() : String(rec.trialEndsAt))
          : null;
        lines.push({ ok: true, text: 'Server record found: plan ' + (rec.plan || 'free') +
          (t ? ', trial ends ' + dstr(t) : '') + '.' });
      } else {
        lines.push({ ok: false, text: S.online
          ? 'No server record came back for this account. If you paid or started a trial on another Google account, that is where it lives.'
          : 'Offline, so the server could not be asked. This is not an error — try the check again with data.' });
      }
      lines.push({ ok: true, text: 'Cloud backup: ' + (S.cloud.latest && S.cloud.latest.updatedAt
        ? 'a backup from ' + dstr(S.cloud.latest.updatedAt) + ' is on this account'
        : 'nothing backed up on this account yet') + '.' });

      S.accountCheck = { at: new Date().toISOString(), lines: lines };
      await refreshCloudInfo();
      render();
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
      const r = await TEAM.makeInvite({ role: S.inviteRole === 'lead' ? 'lead' : 'tech' });
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

    async setInviteRole(role) {
      S.inviteRole = role === 'lead' ? 'lead' : 'tech';
      render();
    },

    async shareInviteLink(code) {
      const link = TEAM.inviteLink(code);
      if (!link) return toast('That invite is gone', 'Create a fresh one');
      const t = teamState();
      const text = 'Join ' + ((t.company && t.company.name) || 'our crew') + ' on REHOTEQ Field: ' + link;
      if (navigator.share) {
        try { await navigator.share({ title: 'REHOTEQ Field invite', text: text, url: link }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
      }
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
    },

    async copyInviteLink(code) {
      const link = TEAM.inviteLink(code);
      if (!link) return toast('That invite is gone', 'Create a fresh one');
      let copied = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(link); copied = true; } } catch (e) { /* fall through */ }
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = link; document.body.appendChild(ta); ta.select();
          copied = document.execCommand('copy'); document.body.removeChild(ta);
        } catch (e) { /* fall through */ }
      }
      toast(copied ? 'Link copied' : 'Could not copy', copied ? 'Paste it in their WhatsApp chat' : 'Use Share the link instead');
    },

    async shareClientReport(kind) {
      const j = S.job;
      if (!j || !j.ref) return toast('No report on screen', 'Open a job first');
      // Photo COUNTS ride in the link; photo bytes cannot. The client
      // page states the count and points at the PDF for the images.
      const by = S.photos[j.id] || {};
      const counts = {};
      ['before', 'during', 'after', 'serial'].forEach(st => {
        const n = (by[st] || []).length;
        if (n) counts[st] = n;
      });
      const link = REPORT.clientLink(Object.assign({}, j, { _photoCounts: counts }), docProfile());
      if (!link) return toast('Could not build the link', 'Send the PDF file instead');
      const prof = docProfile();
      const title = 'Service report ' + j.ref + ' — ' + ((prof && prof.company) || 'REHOTEQ Field');
      const text = title + '\n' + link;
      if (kind === 'wa') {
        const num = CONFIG.waNumber(j.customer && j.customer.phone) || '';
        window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(text), '_blank');
        return;
      }
      if (kind === 'mail') {
        const to = (j.customer && j.customer.email) || '';
        window.open('mailto:' + to + '?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(text), '_blank');
        return;
      }
      let copied = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(link); copied = true; } } catch (e) { /* fall through */ }
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = link; document.body.appendChild(ta); ta.select();
          copied = document.execCommand('copy'); document.body.removeChild(ta);
        } catch (e) { /* fall through */ }
      }
      toast(copied ? 'Link copied' : 'Could not copy', copied ? "Paste it in the client's chat or email" : 'Use WhatsApp or Email instead');
    },

    async joinFromLink() {
      const f = S.pendingInvite;
      if (!f) return toast('No invite waiting', 'Ask your oga to resend the link');
      if (!S.user) {
        toast('Create your profile first', 'Then come back to Team and tap Join');
        return ACT.go('boot');
      }
      const r = await TEAM.applyInvite(f);
      if (!r.ok) { const e = teamErr(r.error); return toast(e[0], e[1]); }
      S.pendingInvite = null;
      await DB.setMeta('linkInvite', null);
      ACT.go('team');
      toast('Joined ' + r.company, 'Send your acceptance so you appear on their dashboard');
    },

    async clearLinkInvite() {
      S.pendingInvite = null;
      await DB.setMeta('linkInvite', null);
      render();
      toast('Invite dismissed');
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
      // Only a share that actually happened marks the acceptance sent. A
      // dismissed sheet leaves the button up, so the technician taps it
      // again instead of the send vanishing with no way to retry — and
      // the oga's dashboard never waiting on a file that was never sent.
      const sent = await shareTeamFile(f, 'rehoteq-acceptance-' + f.code + '.json', 'Acceptance sent');
      if (!sent) return;
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
    _setJobForTest(job) { S.job = job ? cloneRecord(job) : null; },
    // v1.9.0 — drives the cloud screens without a real Google round trip,
    // exactly as _setJobForTest drives a job card. The shape is the same
    // one FB.onUser hands the app.
    _setFbUserForTest(u) {
      S.fbUser = u ? { uid: u.uid, email: u.email || '', name: u.name || '', photo: u.photo || '' } : null;
      render();
    },
    _setCloudForTest(latest) { S.cloud.latest = latest || null; render(); },
    _cloudForTest() { return { user: S.fbUser, cloud: S.cloud, check: S.accountCheck }; }
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
    // A client opening a report link sees one branded report page and
    // nothing else: no database, no navigation, nothing writable. The
    // app itself does not even start for them.
    // A half-updated offline cache can pair a new app.js with an old
    // report.js. The boot route must degrade, never crash: if the helper
    // is missing, a plain URL carries no report anyway.
    const clientReport = (typeof REPORT !== 'undefined' && REPORT.clientFromLink)
      ? REPORT.clientFromLink(location.href) : null;
    if (clientReport) { REPORT.renderClient(app(), clientReport); return; }
    S.user = await DB.getMeta('user');
    S.accounts = (await DB.getMeta('accounts')) || [];
    S.lastBackup = await DB.getMeta('lastBackup');
    // What the cloud held last time we looked. The cache is only allowed
    // to be shown when someone is signed in, and refreshCloudInfo()
    // replaces it with the truth as soon as sign-in resolves.
    const cachedCloud = await DB.getMeta('cloudBackup');
    if (cachedCloud && cachedCloud.updatedAt) {
      S.cloud.latest = cachedCloud;
      S.cloud.fromCache = true;
    }
    if (S.user && S.user.trade) S.trade = S.user.trade;
    await refreshJobs();
    await refreshEquipment();
    await teamLoad();
    // An invite arriving by link (?invite=...) is stashed before the first
    // render, so the join card can offer it wherever the user lands. The
    // parameter is then cleaned off the address bar so a refresh or a
    // re-share of the URL cannot re-trigger the join.
    const linkInvite = TEAM.inviteFromLink(location.href);
    if (linkInvite) {
      S.pendingInvite = linkInvite;
      await DB.setMeta('linkInvite', linkInvite);
      try {
        const clean = new URL(location.href);
        clean.searchParams.delete('invite');
        history.replaceState(null, '', clean.pathname + (clean.searchParams.toString() ? '?' + clean.searchParams.toString() : ''));
      } catch (e) { /* cosmetic only */ }
    }
    await loadUsageLedger();
    if (S.user) await saveAccount(S.user);
    // hydrate photo urls for any job we render. A photo restored from a
    // backup may have no blob; createObjectURL would throw and leave the
    // technician with a white screen he cannot clear from the UI.
    const all = await DB.all('photos');
    all.forEach(p => { if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob); });
    S.welcomeSeen = await DB.getMeta('welcomeSeen');
    if (S.pendingInvite && S.user && !S.user.memberOf && myRole() === 'none' && !teamState().company) {
      go('team');
    } else {
      go(S.user ? 'home' : (S.welcomeSeen ? 'boot' : 'welcome'));
    }
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

  window.addEventListener('online', () => { S.online = true; render(); flushSync(); startSyncWatch(); });
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
        refreshCloudInfo();
        return;
      }
      // Back from Google without an account: say why, instead of quietly
      // showing the Sign in button again. Only a sign-in this tab started
      // is ever reported, so an ordinary open never sees this.
      const err = typeof window.FB.redirectError === 'function' ? window.FB.redirectError() : null;
      if (err) signInFailed(err);
    }).catch(function () { /* no redirect pending, carry on */ });
    window.FB.onUser(function (u) {
      S.fbUser = u;
      if (u && isOwnerAccount(S.user, u) && S.user) {
        S.user.ownerAccess = true;
        if (!S.user.plan || S.user.plan === 'free') S.user.plan = 'business';
        DB.setMeta('user', S.user);
      }
      if (u) hydrateEntitlement();
      if (u) refreshCloudInfo();     // v1.9.0: what the cloud holds for THIS account
      if (u) FB.touchLastActive();   // Field HQ: last-active register, silent on failure
      // Live sync follows the signed-in account: watch the shared jobs
      // feed, push what is queued, and stop watching on sign-out.
      if (u) { startSyncWatch(); flushSync(); } else stopSyncWatch();
      // A fresh sign-in invalidates the last account check — its lines name
      // the account that was signed in a moment ago.
      S.accountCheck = null;
      if (S.view === 'settings' || S.view === 'home' || S.view === 'boot') render();
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
            '<button id="swUpdateGo" style="border:0;background:#6D28D9;color:#fff;font:inherit;font-weight:700;' +
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

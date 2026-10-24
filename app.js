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
  const R_MARK_SRC = "data:image/png;base64,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";

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

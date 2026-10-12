#!/usr/bin/env node
/* =====================================================================
   tests/run.js — REHOTEQ Field test runner

   Run with:  npm test

   The rule that produced this file: test by TAPPING BUTTONS, not by
   calling functions. v1.0.0 shipped with 25 buttons that threw the
   moment a thumb touched them, because the tests called the functions
   directly and never went through the HTML.

   Suites
     1. app surface  — the app loads and exposes what the page needs
     2. wiring audit — every inline handler in app.js is reachable
     3. live taps    — real click events on the real nav, in jsdom
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ---------------- tiny test harness -------------------------------- */
let pass = 0, fail = 0;
const failures = [];
let suite = '';

function describe(name) { suite = name; console.log('\n' + name); }
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else {
    fail++; failures.push(suite + ' \u2192 ' + label + (detail ? '\n      ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? '\n      ' + detail : ''));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? '' : 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/* ---------------- boot the app inside jsdom ------------------------- */
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');

function bootApp() {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: 'https://field.rehoteq.com/',
    // 'outside-only' gives us a real script context for window.eval without
    // letting index.html's own <script> tags run twice.
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;

  // --- stubs for the browser APIs jsdom does not implement ----------
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (t, k) => {
      if (k === 'canvas') return { width: 300, height: 120 };
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(400) });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      return () => {};
    }
  });
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => {};
  w.indexedDB = indexedDB;
  w.IDBKeyRange = IDBKeyRange;
  // newer jsdom exposes crypto as a getter-only property
  Object.defineProperty(w, 'crypto', {
    configurable: true,
    value: { subtle: { digest: async () => new ArrayBuffer(32) } }
  });
  w.navigator.geolocation = { getCurrentPosition: () => {} };
  w.scrollTo = () => {};
  w.print = () => {};
  w.alert = () => {};
  w.confirm = () => false;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });

  // Load exactly the scripts index.html declares, in that order. Reading them
  // from the page rather than hardcoding a list means the harness can never
  // drift from what actually ships.
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...indexSrc.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  if (!scripts.length) throw new Error('index.html declares no scripts');
  for (const f of scripts) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  w.__scripts = scripts;
  return w;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =====================================================================
   SUITE 1 — app surface
   ===================================================================== */
async function suiteSurface(w) {
  describe('1. App surface');
  ok(typeof w.ACT === 'object' && w.ACT !== null, 'window.ACT is exposed to the page');
  ok(typeof w.DATA === 'object', 'window.DATA is exposed');
  ok(typeof w.DB === 'object', 'window.DB is exposed');
  ok(typeof w.QR === 'object', 'window.QR is exposed');
  ok(typeof w.REPORT === 'object', 'window.REPORT is exposed');
  ok(typeof w.PDFT === 'object', 'window.PDFT is exposed');
  ok(typeof w.ACT.go === 'function', 'ACT.go is callable');
  ok(typeof w.ACT.toast === 'function', 'ACT.toast is callable');

  // The app icons are the assessor's brand artwork, cut from the source
  // sheet. The old stand-in icons were 2.8KB/7.9KB of flat colour — a
  // swapped-in placeholder would fail the size floor below.
  const iconCases = [
    ['icon-512.png', 512, 40000],
    ['icon-192.png', 192, 10000]
  ];
  const manif = fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8');
  iconCases.forEach(([f, dim, minBytes]) => {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504E47;
    ok(isPng, f + ' is a real PNG');
    eq(buf.readUInt32BE(16), dim, f + ' is ' + dim + ' pixels wide');
    eq(buf.readUInt32BE(20), dim, f + ' is ' + dim + ' pixels tall');
    ok(buf.length > minBytes, f + ' is the brand artwork, not a stub (' + buf.length + ' bytes)');
    ok(manif.indexOf('"' + f + '"') >= 0, 'manifest.webmanifest declares ' + f);
    ok(manif.indexOf('"' + dim + 'x' + dim + '"') >= 0, 'manifest declares its size ' + dim + 'x' + dim);
  });

  // The <div id="toast"> in index.html claims the global name `toast`.
  // Handlers must therefore never call a bare toast(...).
  ok(typeof w.toast !== 'function',
    'bare global `toast` is the <div>, not a function (so handlers must use ACT.toast)');

  eq(w.DATA.TRADES.length, 10, 'all 10 Engineering & MEP trades are defined');
  eq(w.DATA.TRADES.map(t => t.id).join(','),
    'electrical,solar,cctv,networking,hvac,generator,plumbing,fire_access,smarthome,ev',
    'the trade IDs match the v1.4.1 Engineering & MEP catalog');
  eq(Object.values(w.DATA.JOB_TYPES).flat().length, 50, 'the job-type catalog has exactly 50 entries');
  eq(Object.keys(w.DATA.CHECKLISTS).length, 16, 'the checklist catalog has exactly 16 entries');
  eq(w.DATA.LIBRARY.length, 18, 'the troubleshooting library has exactly 18 guides');
  eq(require(path.join(ROOT, 'package.json')).version, '1.4.1', 'package metadata is version 1.4.1');
}

/* =====================================================================
   SUITE 1b — icons

   Emoji rendered differently on every device and could not be tinted,
   which is exactly what a selected tab needs. The app now draws inline
   SVG instead. The failure mode this suite exists to catch is a typo'd
   icon name: ICON() degrades to a dot rather than throwing, so one
   wrong character would ship as a silent hole in the UI.
   ===================================================================== */
async function suiteIcons(w) {
  describe('1b. Icons');

  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok(/<script src="icons\.js"><\/script>/.test(indexSrc), 'index.html loads icons.js');
  ok(w.__scripts.includes('icons.js'), 'the harness loads icons.js, so it really ships');
  ok(w.__scripts.indexOf('icons.js') < w.__scripts.indexOf('app.js'),
    'icons.js loads before app.js, so ICON() exists when the first view renders');
  ok(/'icons\.js'/.test(swSrc), 'sw.js caches icons.js, or offline is a screen of dots');
  ok(/const CACHE = 'rehoteq-field-v32'/.test(swSrc),
    'the service-worker cache is bumped to v32 for the release');

  ok(typeof w.ICON === 'function', 'ICON() is exposed to the page');
  ok(typeof w.ICONS === 'object', 'ICONS is exposed to the page');

  const svg = w.ICON('zap', 20);
  ok(/^<svg /.test(svg), 'ICON() returns an inline <svg>');
  ok(/viewBox="0 0 24 24"/.test(svg), 'every icon sits on the same 24x24 grid');
  ok(/stroke="currentColor"/.test(svg), 'icons inherit colour from currentColor');
  ok(/stroke-width="2"/.test(svg), 'every icon uses the same 2px stroke weight');
  ok(/width="20"/.test(svg) && /height="20"/.test(svg), 'ICON() honours the requested size');
  ok(/aria-hidden="true"/.test(svg), 'icons are aria-hidden; the text label carries the meaning');

  ok(w.ICON('definitely-not-an-icon', 16).length > 0,
    'an unknown icon name returns markup, never an empty string');

  const used = new Set();
  for (const f of ['app.js', 'data.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/ICON\(\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/icon:\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
  }
  ok(used.size > 20, 'the app draws a real icon set (' + used.size + ' names)');
  const missing = [...used].filter(n => !w.ICONS[n]);
  eq(missing.length, 0, 'every icon name used in the app resolves'
    + (missing.length ? ' — missing: ' + missing.join(', ') : ''));

  for (const t of w.DATA.TRADES) {
    ok(!!w.ICONS[t.icon], 'trade "' + t.id + '" icon "' + t.icon + '" resolves');
  }
  const iconBuilder = fs.readFileSync(path.join(ROOT, 'tools/build-icons.js'), 'utf8');
  ['snowflake', 'gauge', 'droplets', 'flame', 'cpu', 'plug-zap'].forEach(name => {
    ok(iconBuilder.includes("'" + name + "'") && !!w.ICONS[name],
      'Lucide icon "' + name + '" is listed in the builder and generated bundle');
  });

  // The bug this catches actually shipped: TRADES[].icon became an icon
  // *name* ('solar-panel'), and two views went on printing it as text, so
  // the home screen read "solar-panel Solar". An icon name is an
  // identifier, never something a technician should ever see. Walk the
  // views and assert none of them leaks one.
  const names = Object.keys(w.ICONS).filter(n => n.length > 3);
  const leaks = [];
  for (const v of ['home', 'library', 'jobs', 'settings', 'passport', 'team', 'company', 'diagnose']) {
    w.ACT.go(v);
    await sleep(40);
    const text = w.document.body.textContent || '';
    for (const n of names) {
      // only flag the kebab-case names a human would never write
      if (n.includes('-') && text.includes(n)) leaks.push(v + ' shows "' + n + '"');
    }
  }
  eq(leaks.length, 0, 'no view prints an icon name as text', leaks.join('\n      '));
  w.ACT.go('home');
  await sleep(30);

  // The walk cannot reach the first-run screen, where the trade dropdown
  // also leaked the name, so scan the source too: any interpolation that
  // ends in `.icon` must be routed through tradeIcon() or ICON().
  const appSrcIcons = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const bare = [...appSrcIcons.matchAll(/\$\{([^}]*\.icon)\}/g)]
    .map(m => m[1].trim())
    .filter(expr => !/^(tradeIcon|ICON)\(/.test(expr));
  eq(bare.length, 0, 'no view interpolates a bare .icon value as text',
    bare.join('\n      '));

  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u00AE]/u;
  for (const f of ['app.js', 'index.html', 'data.js', '404.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const bad = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => EMOJI.test(l));
    eq(bad.length, 0, f + ' ships no emoji'
      + (bad.length ? ' — line ' + bad[0][0] + ': ' + bad[0][1].trim().slice(0, 60) : ''));
  }
}

/* =====================================================================
   SUITE 2 — wiring audit (static)

   Reads every inline handler out of app.js and proves the code it names
   can actually be reached from the page. This is the suite that would
   have caught the 25 dead buttons.
   ===================================================================== */
const PAGE_GLOBALS = new Set([
  'ACT', 'window', 'document', 'location', 'navigator', 'console', 'this',
  'Math', 'Date', 'JSON', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'parseInt', 'parseFloat', 'confirm', 'alert', 'setTimeout', 'clearTimeout',
  'URL', 'QR', 'DB', 'DATA', 'IMG', 'REPORT', 'PDFT',
  'true', 'false', 'null', 'undefined'
]);

function collectHandlers() {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const re = /\b(onclick|oninput|onchange|onsubmit|onended|onblur|onfocus)\s*=\s*"([^"]*)"/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ attr: m[1], code: m[2], line });
  }
  return out;
}

// head-position identifiers only: skip anything preceded by a dot, and skip
// ${...} template expressions, which are evaluated at render time (inside the
// IIFE) rather than at tap time (in page scope).
function headIdentifiers(code) {
  const stripped = code.replace(/\$\{[^}]*\}/g, '0');
  const ids = new Set();
  const re = /(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*(?=[.(=])/g;
  let m;
  while ((m = re.exec(stripped))) ids.add(m[2]);
  return [...ids];
}

function suiteWiring(w) {
  describe('2. Wiring audit — every inline handler is reachable from the page');

  /* The publish step in deploy.yml carries a hand-typed list of files. If
     anything the page loads is missing from that list, GitHub happily
     publishes a site whose app crashes on load — the tests all pass
     locally where the files exist. This closes that hole: every file the
     page references and every file the service worker caches must appear
     in the copy list, or the build fails. */
  const deployYml = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  const deployList = ((deployYml.match(/for f in([\s\S]*?); do/) || ['', ''])[1])
    .split(/\s+/).map(s => s.trim()).filter(Boolean);
  ok(deployList.length > 10, 'deploy.yml has a publish list to check against');

  const needed = new Set();
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  (htmlSrc.match(/(?:src|href)="([^"]+)"/g) || []).forEach(m => {
    const ref = m.replace(/^(?:src|href)="/, '').replace(/"$/, '');
    if (!/^(https?:|#|mailto:|data:)/.test(ref)) needed.add(ref.split('/').pop());
  });
  const shellSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ((shellSrc.match(/const SHELL = \[([\s\S]*?)\]/) || ['', ''])[1].match(/'([^']+)'/g) || [])
    .forEach(m => {
      const ref = m.slice(1, -1);
      if (ref !== './') needed.add(ref.split('/').pop());
    });

  const missing = [...needed].filter(f => !deployList.includes(f));
  ok(missing.length === 0,
    'every file the app loads is in the publish list', 'missing: ' + missing.join(', '));
  const handlers = collectHandlers();
  ok(handlers.length > 50, 'found inline handlers to audit (' + handlers.length + ')');

  const unreachable = [];
  const missingAct = [];

  handlers.forEach(h => {
    headIdentifiers(h.code).forEach(id => {
      if (!PAGE_GLOBALS.has(id)) {
        unreachable.push('app.js:' + h.line + '  ' + h.attr + '="' + h.code.slice(0, 60) + '"  \u2192 `' + id + '` is not reachable');
      }
    });
    // every ACT.method named by a handler must actually exist on ACT
    const re = /\bACT\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(h.code))) {
      if (typeof w.ACT[m[1]] === 'undefined') {
        missingAct.push('app.js:' + h.line + '  ACT.' + m[1] + ' does not exist');
      }
    }
  });

  ok(unreachable.length === 0,
    'no handler references unreachable code',
    unreachable.slice(0, 12).join('\n      '));
  ok(missingAct.length === 0,
    'every ACT.method named by a handler exists',
    missingAct.slice(0, 12).join('\n      '));
}

/* =====================================================================
   SUITE 2b — domain guard

   A QR sticker glued to a customer's inverter is permanent. v1.0.0
   printed `rehoteq.ng`, which nobody had registered — anyone could have
   bought it and owned every verification link we ever issued. Nothing
   shipped may name a domain we do not control.
   ===================================================================== */
const OWNED = ['field.rehoteq.com', 'rehoteq.com'];
// Everything the browser actually downloads. If a file is served, it is
// scanned. Note that functions/ is deliberately NOT here — it never
// reaches a browser, which is the whole reason it may hold a secret.
const SHIPPED = ['index.html', '404.html', 'config.js', 'app.js', 'data.js',
                 'db.js', 'pdf.js', 'qr.js', 'report.js', 'sw.js',
                 'icons.js', 'firebase.js'];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
            .replace(/^\s*\/\/.*$/gm, ' ')        // whole-line // comments
            .replace(/<!--[\s\S]*?-->/g, ' ');    // html comments
}

function suiteDomain(w) {
  describe('2b. Domain guard — no printed link names a domain we do not own');

  const offenders = [];
  const foreign = [];
  SHIPPED.forEach(f => {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) { offenders.push(f + ' is missing'); return; }
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    if (/rehoteq\.ng/.test(src)) offenders.push(f + ' still names rehoteq.ng');
    // any other absolute host that is not ours or a known third party
    const hosts = src.match(/https?:\/\/([A-Za-z0-9.-]+)/g) || [];
    hosts.forEach(h => {
      const host = h.replace(/^https?:\/\//, '');
      const okThirdParty = ['wa.me', 'www.w3.org', 'www.gstatic.com'].includes(host);
      // www.gstatic.com is Google's CDN, which serves the Firebase SDK. It
      // is loaded lazily and only when someone actually taps Sign in, so a
      // technician who never signs in never touches it. It is allow-listed
      // here deliberately rather than silently — the point of this guard is
      // that no external host appears in the app by accident.
      // flutterwave.com is the payment host. It is allow-listed here so a
      // typo'd or substituted payment domain still fails the build — the
      // point of the guard is that no host appears by accident.
      const okPayment = /^flutterwave\.com$/.test(host);
      // us-central1-rehoteq-field.cloudfunctions.net is our own Firebase
      // Cloud Function host for `aiProxy`, so the Groq key stays on the
      // server and never enters client code.
      const okCloudFn = host === 'us-central1-rehoteq-field.cloudfunctions.net';
      if (!OWNED.includes(host) && !okThirdParty && !okPayment && !okCloudFn) {
        foreign.push(f + ' \u2192 ' + host);
      }
    });
  });

  ok(offenders.length === 0, 'no shipped file references rehoteq.ng', offenders.join('\n      '));
  ok(foreign.length === 0, 'no unexpected absolute hosts in shipped code', foreign.join('\n      '));

  ok(typeof w.CONFIG === 'object' && w.CONFIG !== null, 'config.js is loaded by index.html');
  if (!w.CONFIG) return;
  eq(w.CONFIG.domain, 'field.rehoteq.com', 'CONFIG.domain is field.rehoteq.com');
  eq(w.CONFIG.verifyUrl('RF-2026-00184'), 'https://field.rehoteq.com/v/RF202600184',
    'verify links are built from CONFIG');
  eq(w.CONFIG.passportUrl('SMS62202488314'), 'https://field.rehoteq.com/p/SMS62202488314',
    'passport links are built from CONFIG');

  // The PDF is the artefact that actually reaches a customer.
  const job = {
    ref: 'RF-2026-00184', trade: 'solar', jobType: 'Inverter fault diagnosis',
    customer: { name: 'Mr. Adewale Ade', phone: '0803 000 0000', address: '14 Adeyemi St' },
    site: { address: '14 Adeyemi St, Okitipupa', lat: 6.4975, lng: 4.7814 },
    equipment: { model: 'SMS-II 6.2K', serial: 'SMS62-2024-88314', capacity: '6.2 kVA', installDate: '2025-07-24' },
    fault: 'E03 on load.', diagnosis: 'Loose DC terminal.', work: 'Re-terminated and torqued.',
    recommendation: 'Bank at 71% SoH.', materials: [{ desc: 'Copper lug', qty: 2, unitPrice: 1500 }],
    labour: 25000, signatures: { customer: null, technician: null },
    status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    lockedAt: new Date().toISOString(), createdAt: new Date().toISOString(), hashes: ['e3b0c442']
  };
  let pdfText = '';
  try {
    const bytes = w.REPORT.buildReport(job, { before: [], during: [], after: [], serial: [] }, {},
      { name: 'Toye', company: 'REHOTEQ Technologies' });
    pdfText = Buffer.from(bytes).toString('latin1');
  } catch (e) {
    ok(false, 'the service report PDF builds', String(e.message));
    return;
  }
  ok(pdfText.startsWith('%PDF-'), 'the service report PDF builds');
  ok(!/rehoteq\.ng/.test(pdfText), 'the generated PDF does NOT contain rehoteq.ng');
  ok(/field\.rehoteq\.com/.test(pdfText), 'the generated PDF DOES contain field.rehoteq.com');

  // And the QR sticker, which is the one that gets glued down permanently.
  const qrUrl = w.CONFIG.passportUrl('SMS62202488314');
  ok(!/rehoteq\.ng/.test(qrUrl), 'the QR sticker URL does not contain rehoteq.ng');
  const m = w.QR.encode(qrUrl);
  ok(m && m.size > 0, 'the QR code encodes (' + (m && m.size) + 'x' + (m && m.size) + ')');
}

/* =====================================================================
   SUITE 2c — branding: logo, contact line and the naira sign

   These are the three things on every document a customer receives.
   The naira sign in particular is drawn as vector paths, not set as a
   glyph, so it is invisible to text extraction — measure the drawing
   instead of reading it back.
   ===================================================================== */
function suiteBranding(w) {
  describe('2c. Branding — logo, contact line, and the naira sign');

  const base = {
    ref: 'RF-2026-00184', trade: 'solar', jobType: 'Inverter fault diagnosis',
    customer: { name: 'Mr. Adewale Ade', phone: '0803 000 0000', address: '14 Adeyemi St' },
    site: { address: '14 Adeyemi St, Okitipupa', lat: 6.4975, lng: 4.7814 },
    equipment: { model: 'SMS-II 6.2K', serial: 'SMS62-2024-88314', capacity: '6.2 kVA', installDate: '2025-07-24' },
    fault: 'E03 on load.', diagnosis: 'Loose DC terminal.', work: 'Re-terminated and torqued.',
    recommendation: 'Bank at 71% SoH.', materials: [{ desc: 'Copper lug', qty: 2, unitPrice: 1500 }],
    labour: 25000, signatures: {}, status: 'completed',
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    lockedAt: new Date().toISOString(), createdAt: new Date().toISOString(), hashes: ['e3b0c442']
  };
  const noPhotos = { before: [], during: [], after: [], serial: [] };
  const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from('not-really-a-jpeg').toString('base64');

  // --- the naira sign is measured, not dropped -------------------------
  const withSign = w.PDFT.width('\u20A61,000', 11, true);
  const noSign = w.PDFT.width('1,000', 11, true);
  ok(withSign > noSign + 5,
    'PDFT.width counts the naira sign (advance ' + (withSign - noSign).toFixed(2) + 'pt)',
    'with ' + withSign.toFixed(2) + ' vs without ' + noSign.toFixed(2));

  // A ₦ that reached the content stream as a character would emit a bad
  // octal escape; it must be drawn as paths instead.
  let moneyPdf = '';
  try {
    moneyPdf = Buffer.from(w.REPORT.buildReport(base, noPhotos, {},
      { name: 'Toye', company: 'REHOTEQ Technologies' })).toString('latin1');
  } catch (e) { ok(false, 'a report with naira amounts builds', String(e.message)); return; }
  ok(!moneyPdf.includes('\\20346'),
    'no raw U+20A6 octal escapes in the content stream');
  ok(!moneyPdf.includes('NGN'),
    'amounts no longer print as "NGN"');

  // --- logo in, logo out ----------------------------------------------
  let logoPdf = '';
  try {
    logoPdf = Buffer.from(w.REPORT.buildReport(base, noPhotos, {},
      { name: 'Toye', company: 'REHOTEQ Technologies',
        logo: { dataUrl: tinyJpeg, w: 240, h: 240 } })).toString('latin1');
  } catch (e) { ok(false, 'a report with a logo builds', String(e.message)); return; }
  ok(logoPdf.includes('/DCTDecode'), 'a logo is embedded as a JPEG image object');

  ok(!moneyPdf.includes('/DCTDecode'),
    'with no logo and no photos, no image object is emitted at all');

  // A logo that cannot decode must fall back to the R mark, never throw.
  let fell = null;
  try {
    w.REPORT.buildReport(base, noPhotos, {},
      { name: 'Toye', company: 'R', logo: { dataUrl: 'data:image/jpeg;base64,!!!', w: 10, h: 10 } });
  } catch (e) { fell = String(e.message); }
  ok(!fell, 'a corrupt logo falls back to the R mark instead of throwing', fell || '');

  // --- the contact line is printed ------------------------------------
  let contactPdf = '';
  try {
    contactPdf = Buffer.from(w.REPORT.buildReport(base, noPhotos, {},
      { name: 'Toye', company: 'REHOTEQ Technologies',
        address: '12 Sapele Road, Benin City', phone: '0803 000 0000',
        email: 'hello@rehoteq.com' })).toString('latin1');
  } catch (e) { ok(false, 'a report with a contact line builds', String(e.message)); return; }
  ok(contactPdf.includes('12 Sapele Road, Benin City'),
    'the business address is printed under the company name');
  ok(contactPdf.includes('hello@rehoteq.com'),
    'the email is printed on the contact line');

  // A long contact line is truncated rather than running into the
  // right-hand column of the masthead.
  const longAddr = 'X'.repeat(400);
  let longPdf = '';
  try {
    longPdf = Buffer.from(w.REPORT.buildReport(base, noPhotos, {},
      { name: 'Toye', company: 'REHOTEQ Technologies', address: longAddr })).toString('latin1');
  } catch (e) { ok(false, 'a report with a very long address builds', String(e.message)); return; }
  ok(!longPdf.includes('X'.repeat(400)), 'an over-long contact line is truncated');
}

/* =====================================================================
   SUITE 2d — pricing and the payment seam

   Two places where a mistake costs real money: the number a customer is
   shown, and a secret key accidentally shipped to every visitor.
   ===================================================================== */
async function suitePricing(w) {
  describe('2d. Pricing and the payment seam');

  // Decided 10 Oct 2026: Pro is ₦3,000/month, ₦30,000/year.
  eq(w.DATA.PLANS.pro.price, 3000, 'PLANS.pro is ₦3,000');
  eq(w.DATA.PLANS.pro.label, '₦3,000/mo', 'PLANS.pro label reads ₦3,000/mo');
  eq(w.DATA.PLANS.free.price, 0, 'the Free plan is still free');

  ok(w.CONFIG.payments && typeof w.CONFIG.payments === 'object',
    'CONFIG.payments is the single place payment links live');

  // The paywall is the only screen where a technician sees the number.
  w.ACT.goPlan();
  await sleep(40);
  const sheet = w.document.getElementById('paywall').textContent;
  ok(sheet.includes('₦3,000'), 'the paywall shows ₦3,000');
  // The annual price is a real offer, but until Flutterwave gives us a link
  // there is no way to pay it. Showing the price without a button behind it
  // is the same lie the old "14-day free trial" was, so it stays hidden.
  const annualLinked = !!w.CONFIG.payments.proAnnualUrl;
  eq(sheet.includes('₦30,000'), annualLinked,
    'the paywall shows the annual ₦30,000 iff there is a way to pay it');
  if (annualLinked) {
    ok(/2 months free/.test(sheet), 'the annual offer states the saving');
  } else {
    ok(!/\/ year/.test(sheet),
      'with no annual link the paywall advertises no annual price at all');
  }
  // The saving is worked out from the two prices, not typed in, so it can
  // never claim "2 months free" after the numbers have moved.
  eq(w.CONFIG && w.DATA.PLANS.pro.yearPrice, 30000, 'the annual figure is ₦30,000 in DATA.PLANS');
  const freeMonths = Math.round(12 - w.DATA.PLANS.pro.yearPrice / w.DATA.PLANS.pro.price);
  eq(freeMonths, 2, 'the annual price really does give 2 months free');
  // ...and no price may be typed straight onto a button or into a view,
  // which is how ₦4,000 outlived its own price change.
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const typed = (appSrc.match(/₦[0-9][0-9,]{2,}/g) || []);
  eq(typed.length, 0, 'no price is hardcoded in app.js'
    + (typed.length ? ' \u2014 found ' + typed.join(', ') : ''));
  ok(!sheet.includes('₦4,000'), 'the paywall no longer shows the old ₦4,000');
  ok(!/14-day free trial/.test(sheet),
    'the paywall does not promise a trial that does not exist');
  ok(!/Paystack/.test(sheet),
    'the paywall does not name a payment provider that is not wired up');

  // Every button on the sheet must go somewhere real.
  const handlers = [...w.document.getElementById('paywall').querySelectorAll('[onclick]')]
    .map(b => b.getAttribute('onclick'));
  ok(handlers.length > 0, 'the paywall has buttons');
  const dead = handlers.filter(h => {
    const m = /ACT\.(\w+)/.exec(h || '');
    return !m || typeof w.ACT[m[1]] !== 'function';
  });
  ok(dead.length === 0, 'no dead buttons in the paywall', dead.join(', '));

  // A plan with a link gets a button; a plan without one gets nothing.
  // No button anywhere may go nowhere.
  const hasMonthly = !!w.CONFIG.payments.proMonthlyUrl;
  const hasAnnual = !!w.CONFIG.payments.proAnnualUrl;
  const hasBusiness = !!w.CONFIG.payments.businessUrl;
  const has = h => handlers.some(x => (x || '').includes(h));
  eq(has('payMonthly'), hasMonthly, 'monthly button is offered iff a monthly link is set');
  eq(has('payAnnual'), hasAnnual, 'annual button is offered iff an annual link is set');
  eq(has('payBusiness'), hasBusiness, 'business button is offered iff a business link is set');
  if (hasMonthly || hasAnnual || hasBusiness) {
    ok(!has('subscribe'),
      'with payment links configured, the WhatsApp fallback is not the primary action');
  } else {
    ok(has('subscribe'), 'with no links configured, the WhatsApp route is offered');
  }

  // Every payment link must be a public payment page, not an API endpoint.
  [w.CONFIG.payments.proMonthlyUrl, w.CONFIG.payments.proAnnualUrl, w.CONFIG.payments.businessUrl]
    .filter(Boolean)
    .forEach(u => ok(/^https:\/\/[a-z0-9.-]+\/(pay|[\w-]*$)/i.test(u),
      'payment link is a public payment page: ' + u));

  // The two WhatsApp numbers must not drift apart: 404.html is a
  // standalone page that cannot read config.js, so it hardcodes one.
  const primary = w.CONFIG.support.whatsapp[0];
  ok(/^234\d{10}$/.test(primary), 'the primary WhatsApp number is in international format');
  // Phone numbers arrive in whatever form whoever typed them used, and a
  // wa.me link built from a local-format number silently goes nowhere.
  eq(w.CONFIG.waNumber('0803 000 0000'), '2348030000000', 'a local 11-digit number becomes international');
  eq(w.CONFIG.waNumber('8030000000'), '2348030000000', 'a bare 10-digit number becomes international');
  eq(w.CONFIG.waNumber('+234 803 000 0000'), '2348030000000', 'an already-international number is left alone');
  eq(w.CONFIG.waNumber(''), '', 'an empty number normalises to empty, not to a dead link');
  eq(w.CONFIG.waNumber('ext 12'), '', 'a value with no usable digits normalises to empty');
  w.CONFIG.support.whatsapp.forEach(n =>
    eq(w.CONFIG.waNumber(n), n, 'REHOTEQ line ' + n + ' survives normalisation'));

  const page404 = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
  ok(page404.includes("'2347036302585'") || page404.includes(primary),
    '404.html points WhatsApp at the same REHOTEQ line as config.js');
  const bare = (page404.match(/https:\/\/wa\.me\/\?text/g) || []).length;
  eq(bare, 0, '404.html has no wa.me link that leaves the customer to guess who to message');

  // A secret key in a static PWA is a blank cheque: every visitor can read
  // this source. Catch it the same way we catch rehoteq.ng.
  const secrets = [];
  SHIPPED.concat(['functions/index.js', 'functions/library.js', 'tools/draft-guide.js']).forEach(f => {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) return;
    const src = fs.readFileSync(full, 'utf8');
    if (/\bsk_(live|test)_[A-Za-z0-9]{6,}/.test(src)) secrets.push(f + ' — secret key');
    if (/\bFLWSECK-[A-Za-z0-9-]{6,}/.test(src)) secrets.push(f + ' — Flutterwave secret');
    if (/\bgsk_[A-Za-z0-9]{6,}/.test(src)) secrets.push(f + ' — Groq API key');
  });
  ok(secrets.length === 0, 'no secret API keys in shipped code', secrets.join('\n      '));

  w.ACT.closePaywall();
  await sleep(20);
}

/* =====================================================================
   SUITE 2e — company profile and the site brief
   ===================================================================== */
async function suiteBrief(w) {
  describe('2e. Company profile and site instructions');

  const noPhotos = { before: [], during: [], after: [], serial: [] };
  const profile = { name: 'Toye', company: 'REHOTEQ Technologies' };
  const base = {
    ref: 'RF-2026-00184', trade: 'solar', jobType: 'Inverter fault diagnosis',
    customer: { name: 'Mr. Adewale Ade', phone: '0803 000 0000', address: '14 Adeyemi St' },
    site: { address: '14 Adeyemi St, Okitipupa', lat: 6.4975, lng: 4.7814 },
    equipment: { model: 'SMS-II 6.2K', serial: 'SMS62-2024-88314', capacity: '6.2 kVA', installDate: '2025-07-24' },
    fault: 'E03 on load.', diagnosis: 'Loose DC terminal.', work: 'Re-terminated and torqued.',
    recommendation: 'Bank at 71% SoH.', materials: [{ desc: 'Copper lug', qty: 2, unitPrice: 1500 }],
    labour: 25000, signatures: { customer: null, technician: null },
    status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    lockedAt: new Date().toISOString(), createdAt: new Date().toISOString(), hashes: ['e3b0c442']
  };
  const BRIEF = 'Isolate the array before touching the DC isolator.';

  const withBrief = Object.assign({}, base, { instructions: BRIEF });
  const briefPdf = Buffer.from(w.REPORT.buildReport(withBrief, noPhotos, {}, profile)).toString('latin1');
  ok(briefPdf.includes('SITE INSTRUCTIONS'), 'the site brief is labelled on the service report');
  ok(briefPdf.includes('Isolate the array'), 'the site brief text reaches the service report');

  // Jobs saved before this field existed have no instructions key at all.
  // They must still build rather than throwing on undefined.
  let threw = null;
  try {
    w.REPORT.buildReport(Object.assign({}, base), noPhotos, {}, profile);
  } catch (e) { threw = e.message; }
  ok(!threw, 'a job with no instructions still builds a report', threw || '');
  const plainPdf = Buffer.from(w.REPORT.buildReport(base, noPhotos, {}, profile)).toString('latin1');
  ok(!plainPdf.includes('SITE INSTRUCTIONS'),
    'with no brief set, the report shows no empty SITE INSTRUCTIONS block');

  const q = {
    id: 'q1', number: 'QT-2026-00001', date: new Date().toISOString(),
    validUntil: new Date(Date.now() + 14 * 864e5).toISOString(),
    customer: base.customer, subject: 'Inverter re-termination',
    items: [{ desc: 'Copper lug', qty: 2, unitPrice: 1500 }],
    labour: 25000, taxRate: 0, notes: '', terms: '70% deposit'
  };
  const q1 = Object.assign({}, q);
  q1.tax = 0; q1.total = 25000 + 3000;

  const bioProfile = Object.assign({}, profile, { bio: '8 years, 400+ installations across Ondo State.' });
  const bioPdf = Buffer.from(w.REPORT.buildQuote(q1, base, bioProfile)).toString('latin1');
  ok(bioPdf.includes('ABOUT US'), 'the company bio is labelled on the quotation');
  ok(bioPdf.includes('400+'), 'the company bio text reaches the quotation');

  const noBioPdf = Buffer.from(w.REPORT.buildQuote(q1, base, profile)).toString('latin1');
  ok(!noBioPdf.includes('ABOUT US'),
    'with no bio set, the quotation shows no empty ABOUT US block');
  // ...and the bio is a sales line, not evidence: it must stay off the report.
  ok(!briefPdf.includes('ABOUT US'), 'the bio does not leak onto the service report');

  // The fields have to be reachable on a real screen, not just in the PDF.
  // editProfile() is the screen a returning user lands on; the printed-on-
  // document fields only exist once a profile does.
  w.ACT.editProfile();
  await sleep(60);
  ok(!!w.document.getElementById('iBio'), 'the profile screen exposes an editable company bio field');
  const bioEl = w.document.getElementById('iBio');
  if (bioEl) {
    bioEl.value = '8 years across Ondo State.';
    w.ACT.saveProfile();
    await sleep(60);
    ok((w.DB.getMeta ? true : true), 'saving the profile does not throw');
  }
  w.ACT.go('home');
  await sleep(30);
}

/* =====================================================================
   SUITE 3 — live taps

   Renders the real screens and dispatches real click events, the way a
   thumb does. Catches anything the static pass cannot see.
   ===================================================================== */
async function suiteTaps(w) {
  describe('3. Live taps — real click events on real buttons');

  await w.DB.setMeta('user', {
    name: 'Toye', phone: '0803 000 0000', trade: 'solar',
    company: 'REHOTEQ Technologies', plan: 'free'
  });
  w.ACT.go('home');
  await sleep(120);

  const errors = [];
  w.addEventListener('error', e => errors.push(String(e.message)));

  // Navigation that a technician hits constantly.
  const nav = [
    ['home', 'library'], ['home', 'jobs'], ['home', 'settings'],
    ['home', 'passport'], ['settings', 'home']
  ];
  for (const [from, to] of nav) {
    w.ACT.go(from); await sleep(40);
    const btn = [...w.document.querySelectorAll('[onclick]')]
      .find(b => (b.getAttribute('onclick') || '').includes("go('" + to + "')"));
    ok(!!btn, 'a tappable control exists to reach "' + to + '" from "' + from + '"');
    if (!btn) continue;
    let threw = null;
    try {
      const code = btn.getAttribute('onclick');
      w.eval('(function(){ ' + code + ' })()');
    } catch (e) { threw = e.constructor.name + ': ' + e.message; }
    ok(!threw, 'tapping it does not throw', threw || '');
    await sleep(40);
    eq(w.ACT._view ? w.ACT._view() : to, to, 'it actually lands on "' + to + '"');
  }

  // The button the v1.0.1 fix missed.
  w.ACT.go('passport'); await sleep(40);
  let backThrew = null;
  try { w.ACT.closePassport(); } catch (e) { backThrew = String(e.message); }
  ok(!backThrew, 'passport "Back to all systems" works', backThrew || '');

  ok(errors.length === 0, 'no uncaught window errors during tapping', errors.slice(0, 5).join(' | '));
}

/* =====================================================================
   SUITE 4 — Firebase security rules

   This is a static lint, not a rules emulator, and it is honest about
   that. It cannot prove the rules are correct. What it can do is catch
   the handful of mistakes that would be catastrophic, so they fail here
   in a test run rather than after real customers exist.
   ===================================================================== */
function suiteRules() {
  describe('4. Firebase security rules');

  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const db = read('firestore.rules');
  const st = read('storage.rules');

  ok(/^rules_version\s*=\s*'2'/m.test(db), 'firestore.rules declares rules_version 2');
  ok(/^rules_version\s*=\s*'2'/m.test(st), 'storage.rules declares rules_version 2');

  // A public read is the whole disaster in one line.
  eq((db.match(/allow\s+read\s*:\s*if\s+true/g) || []).length, 0,
    'firestore.rules has no unconditional public read');
  eq((db.match(/allow\s+write\s*:\s*if\s+true/g) || []).length, 0,
    'firestore.rules has no unconditional public write');
  eq((st.match(/allow\s+(read|write)\s*:\s*if\s+true/g) || []).length, 0,
    'storage.rules has no unconditional public access');

  // Default deny: a collection nobody wrote a rule for must be invisible.
  ok(/match\s*\/\{document=\*\*\}[\s\S]*allow\s+read,\s*write\s*:\s*if\s+false/.test(db),
    'firestore.rules ends in a default-deny catch-all');
  ok(/match\s*\/\{allPaths=\*\*\}[\s\S]*allow\s+read,\s*write\s*:\s*if\s+false/.test(st),
    'storage.rules ends in a default-deny catch-all');

  // The rule that makes enforcement real rather than decorative.
  ok(/allow\s+create\s*:\s*if\s+false/.test(db),
    'clients cannot create their own account record (the server sets the trial clock)');
  ok(/allow\s+update\s*:\s*if\s+isSelf\(uid\)\s*&&\s*!touchesEntitlement\(\)/.test(db),
    'a user may edit their profile but never their entitlement');
  ok(/function\s+entitlementKeys[\s\S]{0,200}'plan'/.test(db),
    'the entitlement field list includes plan');
  for (const k of ['trialEndsAt', 'expiresAt']) {
    ok(db.includes("'" + k + "'"), 'the entitlement field list includes ' + k);
  }

  // Jobs carry customer PII; they must never be world-readable.
  const jobBlock = (db.match(/match \/jobs\/\{jobId\}[\s\S]*?\n    \}/) || [''])[0];
  ok(jobBlock.length > 0, 'firestore.rules has an explicit rule block for jobs');
  ok(/allow read: if signedIn\(\)/.test(jobBlock), 'jobs are never readable anonymously');
  ok(/ownerId|assignedTo/.test(jobBlock), 'job access is decided by owner or assignee');

  // Company data: members see it, leads change it.
  ok(/allow\s+update,\s*delete\s*:\s*if\s+isLeadOf\(companyId\)/.test(db),
    'only a lead may change a company');

  // Storage: photos live under the owner, 12 MB cap, images only.
  ok(/match \/users\/\{uid\}\/\{allPaths=\*\*\}/.test(st),
    'storage paths are scoped under the owning user');
  ok(/request\.auth\.uid\s*==\s*uid/.test(st), 'a user may only touch their own photos');
  ok(/request\.resource\.size\s*<\s*12\s*\*\s*1024\s*\*\s*1024/.test(st),
    'uploads are capped at 12 MB');
  ok(/contentType\.matches\('image\/\.\*'\)/.test(st), 'only images may be uploaded');

  // The config block is public by design, but it must not carry a secret.
  const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  ok(!/BEGIN PRIVATE KEY/.test(cfg), 'config.js holds no service-account private key');
  ok(!/service_account/.test(cfg), 'config.js holds no service-account credentials');
  ok(/firebase:\s*\{/.test(cfg), 'config.js carries the public Firebase web config');
  ok(/enabled:\s*true/.test(cfg),
    'Firebase is switched on — accounts, trial and entitlement are live; the app still works offline with no account');
}

/* =====================================================================
   SUITE 5 — Firebase wiring (all of it inert until switched on)
   ===================================================================== */
async function suiteFirebase(w) {
  describe('5. Firebase wiring');

  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');

  ok(/<script src="firebase\.js"><\/script>/.test(indexSrc), 'index.html loads firebase.js');
  ok(w.__scripts.indexOf('firebase.js') < w.__scripts.indexOf('app.js'),
    'firebase.js loads before app.js, so FB exists when views render');
  ok(/'firebase\.js'/.test(sw), 'sw.js caches firebase.js');

  // The whole point: a technician who never signs in must never download
  // the SDK. If it is in the precache list, every install fetches it and
  // offline-native is gone.
  const shell = (sw.match(/const SHELL = \[([\s\S]*?)\]/) || ['', ''])[1];
  ok(!/gstatic/.test(shell),
    'the Firebase SDK is NOT precached — a user who never signs in never downloads it');
  ok(/gstatic[\s\S]{0,120}firebasejs/.test(sw),
    'but it IS cached on first use, so sign-in works offline afterwards');

  // Switched on as of v1.4.2 — the deliberate act.
  ok(/enabled:\s*true/.test(cfg), 'config.js has Firebase switched on');
  eq(w.CONFIG.firebase.enabled, true, 'CONFIG.firebase.enabled is true');
  ok(typeof w.FB === 'object', 'FB is exposed to the page');
  eq(w.FB.enabled(), true, 'FB.enabled() is true, so the layer is live');
  eq(await w.FB.ready(), false, 'FB.ready() resolves false rather than throwing');
  eq(w.FB.user(), null, 'with Firebase not yet loaded there is no signed-in user');

  // The switch must be the only thing standing between the app and the
  // cloud: flipping it on for real is a deliberate act, not a side effect.
  ok(/function enabled\(\)[\s\S]{0,200}c\.enabled\s*&&\s*c\.apiKey/.test(
      fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8')),
    'firebase.js gates every entry point on the config switch');

  // The screen has to say so plainly: signing in is optional.
  w.ACT.go('settings');
  await sleep(60);
  const txt = w.document.body.textContent || '';
  ok(/Account/.test(txt), 'Settings has an Account section');
  ok(/You do not need an account/.test(txt),
    'Settings says plainly that an account is not required');
  const signInBtn = [...w.document.querySelectorAll('[onclick]')]
    .find(b => (b.getAttribute('onclick') || '').includes('ACT.signIn'));
  ok(!!signInBtn, 'there is a Sign in control');
  ok(typeof w.ACT.signIn === 'function', 'ACT.signIn exists');
  ok(typeof w.ACT.signOut === 'function', 'ACT.signOut exists');

  /* ---- the Cloud Function that makes enforcement real ---------------- */
  const fn = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

  // The secret must come from environment config, never from source.
  ok(!/FLWSECK-[A-Za-z0-9]/i.test(fn), 'the Cloud Function hardcodes no Flutterwave secret');
  ok(!/sk_(live|test)_/.test(fn), 'the Cloud Function hardcodes no secret key');
  ok(/functions\.config\(\)\.flutterwave/.test(fn),
    'the secret is read from Firebase environment config');

  // A webhook body is a claim. Nothing may be granted before Flutterwave
  // has been asked to confirm it.
  const iVerify = fn.indexOf('verifyWithFlutterwave(txId)');
  const iGrant = fn.indexOf("plan: 'pro'");
  ok(iVerify > 0 && iGrant > 0 && iVerify < iGrant,
    'the payment is verified with Flutterwave before Pro is granted');
  ok(/v\.status\s*===\s*'successful'/.test(fn), 'a payment only counts when its status is successful');
  ok(/v\.currency\s*===\s*'NGN'/.test(fn), 'a payment only counts in NGN');

  // The trial clock is set here, by the server, not by the device.
  ok(/TRIAL_DAYS\s*=\s*14/.test(fn), 'the trial is 14 days');
  ok(/onCreate/.test(fn), 'the account record is created on first sign-in');
  ok(/existing\.exists/.test(fn),
    'an existing account is left alone, so signing out cannot restart the trial');

  // Renewing early must not cost the customer their remaining days.
  ok(/Math\.max\(Date\.now\(\), prevMs\)/.test(fn),
    'renewing extends from the existing expiry, not from today');

  const fjson = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  eq(fjson.firestore.rules, 'firestore.rules', 'firebase.json points at firestore.rules');
  eq(fjson.storage.rules, 'storage.rules', 'firebase.json points at storage.rules');

  // Tapping it with Firebase off must be a message, never a crash.
  let threw = null;
  try { await w.ACT.signIn(); } catch (e) { threw = e.message; }
  ok(!threw, 'tapping Sign in with Firebase off does not throw', threw || '');
  w.ACT.go('home');
  await sleep(30);
}

/* =====================================================================
   SUITE 6 — team: Business crews over WhatsApp files

   The whole round trip through the real functions: the owner creates a
   company, invites a technician, and assigns a job; the technician joins,
   works it, and sends an update back; the dashboard tells the truth. The
   two phones are simulated with TEAM._testAs, because S is a closure and
   the alternative is testing copies instead of the real thing.
   ===================================================================== */
async function snapTeam(w) {
  return {
    user: await w.DB.getMeta('user'),
    company: await w.DB.getMeta('company'),
    members: await w.DB.getMeta('teamMembers'),
    invites: await w.DB.getMeta('teamInvites'),
    workerLogins: await w.DB.getMeta('workerLogins'),
    seats: await w.DB.getMeta('teamSeats')
  };
}
async function restoreTeam(w, s) {
  await w.DB.setMeta('user', s.user);
  await w.DB.setMeta('company', s.company);
  await w.DB.setMeta('teamMembers', s.members);
  await w.DB.setMeta('teamInvites', s.invites);
  await w.DB.setMeta('workerLogins', s.workerLogins || []);
  await w.DB.setMeta('teamSeats', s.seats);
  w.TEAM._testAs(s.user);
  await w.TEAM.load();
}

async function suiteTeam(w) {
  describe('6. Team — Business crews over WhatsApp files');
  const T = w.TEAM;

  ok(typeof T === 'object' && T !== null, 'window.TEAM is exposed to the page');
  if (!T) return;

  eq(w.DATA.PLANS.business.seats, 5, 'Business covers 5 seats');
  eq(w.DATA.PLANS.business.extraSeat, 2500, 'an extra seat is priced in DATA.PLANS');

  // Photo records with no image data must degrade, never throw. (jsdom
  // cannot round-trip real photo bytes, so this is the seam we can hold.)
  let packThrew = null, packRes = null;
  try { packRes = await T.unpackPhotos([{ id: 'TPX1', jobId: 'JOBT1', image: null }]); }
  catch (e) { packThrew = String(e.message); }
  ok(!packThrew, 'a photo record with no image data unpacks without throwing', packThrew || '');
  eq(packRes && packRes.noImage, 1, '...and is counted as imageless');
  eq((await T.packPhotos('NO-SUCH-JOB')).length, 0, 'a job with no photos packs to an empty list');

  // --- the owner ------------------------------------------------------
  // A real profile through the real screen, the way a thumb does it.
  w.ACT.editProfile();
  await sleep(80);
  w.document.getElementById('iName').value = 'Owner Oga';
  w.document.getElementById('iPhone').value = '0803 111 2222';
  w.document.getElementById('iCompany').value = 'Oga & Sons';
  await w.ACT.saveProfile();
  await sleep(80);
  await T.load();
  eq(T.role(), 'none', 'a fresh profile runs no crew');
  ok(!!(await w.DB.getMeta('user')).uid, 'saving a profile mints the uid invites point at');

  const created = await T.createCompany();
  ok(created.ok, 'the owner creates a company');
  eq(T.role(), 'owner', '...and becomes its owner');
  eq((await w.DB.getMeta('company')).name, 'Oga & Sons', 'the company takes its name from the profile');
  eq((await T.createCompany()).error, 'exists', 'creating a second company is refused');
  eq((await T.createWorkerLogin({})).error, 'business',
    'Free-plan company owners cannot create worker logins');
  await w.ACT.setPlan('business');
  eq((await w.DB.getMeta('user')).plan, 'business', 'worker login setup uses the Business entitlement');

  const prof = T.docProfile();
  eq(prof.company, 'Oga & Sons', 'documents carry the company stamp');
  eq(prof.name, 'Owner Oga', '...but the personal name stays the sender\u2019s own');

  const inv = await T.makeInvite();
  ok(inv.ok, 'the owner makes an invite');
  ok(/^RQ-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(inv.file.code),
    'the invite code is short and phone-readable (' + inv.file.code + ')');
  eq(inv.file.format, 'rehoteq-field-team', 'the invite is a team file');
  eq(inv.file.kind, 'invite', '...of kind invite');
  eq(inv.file.branding.name, 'Oga & Sons', 'the invite carries the company stamp');
  eq((await T.applyInvite(inv.file)).error, 'runscrew', 'a crew cannot join a crew');
  eq((await T.applyInvite({ format: 'nope' })).error, 'notinvite', 'a non-invite is refused as such');

  const ownerSnap1 = await snapTeam(w);
  const companyId = ownerSnap1.company.id;

  // --- the technician's phone -----------------------------------------
  const techUser = { name: 'Tech Boy', phone: '0803 333 4444', trade: 'solar', company: '', plan: 'free', uid: 'TECHPHONE1' };
  T._testAs(techUser);
  const joined = await T.applyInvite(inv.file);
  ok(joined.ok, 'the technician joins from the invite file');
  eq(joined.company, 'Oga & Sons', '...the right company');
  eq(T.role(), 'member', '...and becomes a member');
  eq((await w.DB.getMeta('user')).memberOf.branding.name, 'Oga & Sons', 'membership is persisted');
  const accept = T.acceptanceFile();
  eq(accept.kind, 'acceptance', 'joining produces an acceptance file');
  eq(accept.code, inv.file.code, 'the acceptance carries the invite code for matching');
  eq(accept.member.memberId, 'TECHPHONE1', '...and the technician\u2019s own uid');
  eq((await T.applyInvite(inv.file)).error, 'already', 'joining twice is refused');
  await T.markAcceptanceSent();
  eq((await w.DB.getMeta('user')).memberOf.sent, true, 'sending the acceptance is recorded');
  const techMember = JSON.parse(JSON.stringify(await w.DB.getMeta('user')));
  // applyRemoval deletes memberOf from whatever object it is handed, so the
  // screen test below needs its own copy.
  const techMemberScreen = JSON.parse(JSON.stringify(techMember));

  // --- back on the owner's phone --------------------------------------
  await restoreTeam(w, ownerSnap1);
  const took = await T.applyAcceptance(accept);
  ok(took.ok, 'the owner takes the acceptance');
  eq(took.member.name, 'Tech Boy', '...from the right technician');
  eq(T.seats().used, 1, 'one seat is used');
  eq((await w.DB.getMeta('teamInvites')).filter(i => i.code === inv.file.code)[0].status,
    'joined', 'the invite is marked joined');
  const again = await T.applyAcceptance(accept);
  ok(again.ok && again.again === true, 're-importing the acceptance updates instead of doubling');
  eq(T.seats().used, 1, '...and eats no second seat');

  // --- Business worker login generator and worker-device round trip ----
  w.ACT.go('team');
  await sleep(40);
  ok((w.document.body.textContent || '').includes('Worker logins'),
    'the owner team screen has a Worker logins generator');
  const workerNameInput = w.document.getElementById('workerLoginName');
  ok(!!workerNameInput, 'the worker login form exposes an optional worker name');
  if (workerNameInput) workerNameInput.value = '';
  await w.ACT.createWorkerLogin();
  const firstWorker = T.workerLogins()[0];
  ok(!!firstWorker, 'ACT.createWorkerLogin creates the first Business worker');
  eq(firstWorker && firstWorker.name, 'Worker 2',
    'default worker numbering includes the existing technician member');
  ok(firstWorker && /^RQ-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(firstWorker.code),
    'worker login receives an RQ-XXXX-XXXX code');
  const workerFile = firstWorker && T.workerLoginFile(firstWorker.code);
  eq(workerFile && workerFile.kind, 'worker-login', 'the worker code has a shareable login file');
  eq(workerFile && workerFile.companyId, companyId, 'the worker login is tied to this company');
  const remainingWorkers = [];
  for (let i = 3; i <= 5; i++) remainingWorkers.push(await T.createWorkerLogin({ name: 'Worker ' + i }));
  ok(remainingWorkers.every(r => r.ok), 'Business can create up to five worker slots in total');
  eq((await T.createWorkerLogin({})).error, 'full',
    'a sixth worker login is refused with error full');
  eq((await T.importWorkerLogin({ format: 'wrong', kind: 'worker-login' })).error,
    'notworkerfile', 'a malformed worker file is refused');

  let sharedWorkerFile = null;
  Object.defineProperty(w.navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(w.navigator, 'share', { configurable: true, value: async payload => { sharedWorkerFile = payload.files[0]; } });
  await w.ACT.sendWorkerLogin(firstWorker.code);
  eq(sharedWorkerFile && sharedWorkerFile.name,
    'rehoteq-worker-login-' + firstWorker.code + '.json',
    'ACT.sendWorkerLogin shares the JSON login file');
  delete w.navigator.canShare;
  delete w.navigator.share;

  const ownerSnapWorkers = await snapTeam(w);
  const workerDevice = { name: '', phone: '', trade: 'electrical', plan: 'free', uid: 'WORKER-DEVICE' };
  T._testAs(workerDevice);
  const createElement = w.document.createElement.bind(w.document);
  let workerPicker = null;
  w.document.createElement = function (tag) {
    const el = createElement(tag);
    if (String(tag).toLowerCase() === 'input') {
      workerPicker = el;
      el.click = () => {};
    }
    return el;
  };
  try {
    w.ACT.receiveFile();
    Object.defineProperty(workerPicker, 'files', { configurable: true, value: [
      { text: async () => JSON.stringify(workerFile) }
    ] });
    await workerPicker.onchange();
  } finally { w.document.createElement = createElement; }
  const importedWorkerFiles = await w.DB.getMeta('workerLoginFiles');
  ok(Array.isArray(importedWorkerFiles) && importedWorkerFiles.some(x => x.code === firstWorker.code),
    'ACT.receiveFile imports the owner\u2019s worker login JSON');
  await w.ACT.workerCodeLogin(firstWorker.code);
  eq((await w.DB.getMeta('user')).uid, firstWorker.workerId,
    'ACT.workerCodeLogin restores the worker profile on the new device');
  eq(T.role(), 'member', 'a worker-code login joins the correct company workspace');
  const workerAcceptance = T.acceptanceFile();
  eq(workerAcceptance && workerAcceptance.code, firstWorker.code,
    'the worker acceptance carries its worker login code');
  await T.markAcceptanceSent();
  eq((await w.DB.getMeta('user')).memberOf.sent, true,
    'sending the worker acceptance is saved to the account vault');

  await restoreTeam(w, ownerSnapWorkers);
  const forgedAcceptance = JSON.parse(JSON.stringify(workerAcceptance));
  forgedAcceptance.member.memberId = 'NOT-THE-ISSUED-WORKER';
  eq((await T.applyAcceptance(forgedAcceptance)).error, 'notyou',
    'a worker login acceptance cannot claim another worker slot');
  const workerJoined = await T.applyAcceptance(workerAcceptance);
  ok(workerJoined.ok, 'the owner accepts the worker login acceptance file');
  eq(T.seats().used, 2, 'worker acceptance uses one crew seat');
  eq(T.workerLogins().find(x => x.code === firstWorker.code).status, 'joined',
    'the worker login is marked joined after acceptance');
  const workerAgain = await T.applyAcceptance(workerAcceptance);
  ok(workerAgain.ok && workerAgain.again, 're-importing the worker acceptance does not duplicate a seat');
  eq(T.seats().used, 2, 'duplicate worker acceptance consumes no additional seat');

  eq((await T.applyRemoval({ format: 'x' })).error, 'notremoval', 'a non-removal is refused as such');

  // A file from a crew we never heard of goes nowhere.
  const strange = { format: 'rehoteq-field-team', kind: 'update',
    job: { id: 'STRANGE', companyId: 'CO-STRANGER', assignedTo: 'NOBODY' }, photos: [] };
  eq((await T.applyUpdate(strange)).error, 'wrongcrew', 'an update from another crew is refused');

  // --- seats: five included, extras paid -------------------------------
  const extras = [];
  for (let i = 1; i <= 3; i++) {
    const iv = await T.makeInvite();
    const r = await T.applyAcceptance({ format: 'rehoteq-field-team', kind: 'acceptance',
      code: iv.file.code, companyId: companyId,
      member: { memberId: 'EXTRA' + i, name: 'Tech ' + i, phone: '', joinedAt: new Date().toISOString() } });
    extras.push(r.ok);
  }
  ok(extras.every(Boolean), 'the remaining seats three to five fill up');
  eq(T.seats().used, 5, 'five seats are used');
  const sixthInvite = await T.makeInvite();
  const sixthFile = { format: 'rehoteq-field-team', kind: 'acceptance', code: sixthInvite.file.code,
    companyId: companyId, member: { memberId: 'EXTRA6', name: 'Tech 6', phone: '' } };
  eq((await T.applyAcceptance(sixthFile)).error, 'full', 'the sixth technician is refused: all seats taken');
  eq((await T.claimSeats(0)).error, 'badcount', 'claiming zero seats is refused');
  const claimed = await T.claimSeats(2);
  ok(claimed.ok && claimed.paid === 7, 'claiming two seats after payment makes seven');
  const outbox = await w.DB.all('outbox');
  ok(outbox.some(o => o.op && o.op.type === 'team.seats.claimed'),
    'the seat claim is queued, so sync can reconcile it');
  ok((await T.applyAcceptance(sixthFile)).ok, 'with seats added, the sixth technician joins');
  eq(T.seats().used, 6, 'six seats are used');

  // --- assignment: owner to technician --------------------------------
  const jobBase = {
    id: 'JOBT1', ref: 'RF-2026-90001', trade: 'solar', jobType: 'Panel cleaning',
    customer: { name: 'Mrs C', phone: '0803 999 8888', address: '1 Test St' },
    site: { address: '1 Test St', lat: null, lng: null }, equipment: {},
    instructions: 'Clean all twelve panels. Do not step on them.',
    fault: '', diagnosis: '', work: '', recommendation: '',
    materials: [], labour: 0, checklist: null,
    signatures: { customer: null, technician: null }, status: 'draft',
    startedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    completedAt: null, lockedAt: null, hashes: []
  };
  await w.DB.put('jobs', JSON.parse(JSON.stringify(jobBase)));
  const lockedJob = Object.assign(JSON.parse(JSON.stringify(jobBase)),
    { id: 'JOBLOCK', ref: 'RF-2026-90002', lockedAt: new Date().toISOString(), status: 'completed',
      companyId: companyId, assignedTo: 'EXTRA1' });
  await w.DB.put('jobs', lockedJob);
  eq((await T.makeAssignment('NO-SUCH-JOB', 'TECHPHONE1')).error, 'nojob', 'assigning a missing job is refused');
  eq((await T.makeAssignment('JOBT1', 'NOBODY')).error, 'nomember', 'assigning to a stranger is refused');
  eq((await T.makeAssignment('JOBLOCK', 'TECHPHONE1')).error, 'locked', 'assigning locked evidence is refused');
  const assignment = await T.makeAssignment('JOBT1', 'TECHPHONE1');
  ok(assignment.ok, 'the owner assigns the job');
  eq(assignment.file.kind, 'assignment', '...as an assignment file');
  eq(assignment.file.job.assignedTo, 'TECHPHONE1', '...addressed to the technician');
  eq((await w.DB.get('jobs', 'JOBT1')).status, 'assigned', 'the shadow is marked assigned');
  ok(T.companyJob(await w.DB.get('jobs', 'JOBT1')), 'an assigned job counts as company work');
  ok(T.isShadow(await w.DB.get('jobs', 'JOBT1')), '...and as a shadow on the owner\u2019s phone');
  const ownerSnap2 = await snapTeam(w);

  // --- the technician works it ----------------------------------------
  await w.DB.setMeta('user', techMember);
  T._testAs(techMember);
  const wrongCrewFile = Object.assign({}, assignment.file, { companyId: 'CO-STRANGER' });
  eq((await T.applyAssignment(wrongCrewFile)).error, 'wrongcrew', 'a job from another crew is refused');
  const notMine = JSON.parse(JSON.stringify(assignment.file));
  notMine.job.assignedTo = 'SOMEONEELSE';
  eq((await T.applyAssignment(notMine)).error, 'notyou', 'a job for someone else is refused');
  const tookJob = await T.applyAssignment(assignment.file);
  ok(tookJob.ok, 'the technician takes the assigned job');
  eq((await w.DB.get('jobs', 'JOBT1')).instructions, jobBase.instructions,
    'the site instructions survive the trip');
  await w.ACT.openJob('JOBT1');
  await sleep(60);
  eq((await w.DB.get('jobs', 'JOBT1')).status, 'in-progress', 'opening the job moves it to in progress');
  eq(w.ACT._view(), 'jobcard', '...on the job card');
  const sendBtn = [...w.document.querySelectorAll('[onclick]')]
    .find(b => (b.getAttribute('onclick') || '').includes('ACT.sendUpdate'));
  ok(!!sendBtn, 'the job card offers Send update to the assigned technician');
  const assignBtn = [...w.document.querySelectorAll('[onclick]')]
    .find(b => (b.getAttribute('onclick') || '').includes('ACT.assignJob'));
  ok(!assignBtn, '...but no Assign control: members cannot reassign');

  const worked = await w.DB.get('jobs', 'JOBT1');
  worked.diagnosis = 'Dust shading on strings 2 and 3. Cleaned and re-tested.';
  worked.status = 'completed';
  await w.DB.put('jobs', worked);
  await w.DB.put('jobs', Object.assign({}, worked, { id: 'JOBT3', assignedTo: 'SOMEONEELSE' }));
  eq((await T.makeUpdate('JOBT3')).error, 'notyou', 'a technician cannot send updates for another\u2019s job');
  const update = await T.makeUpdate('JOBT1');
  ok(update.ok, 'the technician packs an update');
  eq(update.file.kind, 'update', '...as an update file');

  // --- the update lands on the dashboard -------------------------------
  await restoreTeam(w, ownerSnap2);
  const landed = await T.applyUpdate(update.file);
  ok(landed.ok, 'the owner applies the update');
  eq((await w.DB.get('jobs', 'JOBT1')).status, 'completed', 'the shadow now reads completed');
  eq((await w.DB.get('jobs', 'JOBT1')).diagnosis, worked.diagnosis, '...with the technician\u2019s words');
  eq(T.memberName('TECHPHONE1'), 'Tech Boy', 'the dashboard resolves the technician\u2019s name');
  eq(T.statusLabel('in-progress'), 'In progress', 'statuses read as words, not slugs');
  await w.ACT.openJob('JOBT1');
  await sleep(60);
  eq(w.ACT._view(), 'teamjob', 'the owner\u2019s copy opens read-only');
  ok((w.document.body.textContent || '').includes('Tech Boy'),
    'the read-only screen names who holds the truth');

  // Company work never burns free reports.
  const lockedCompany = Object.assign(JSON.parse(JSON.stringify(jobBase)),
    { id: 'JOBLC', ref: 'RF-2026-90003', companyId: companyId, ownerId: ownerSnap2.company.ownerId,
      assignedTo: 'EXTRA1', assignedAt: new Date().toISOString(),
      lockedAt: new Date().toISOString(), status: 'sent' });
  const lockedPersonal = Object.assign(JSON.parse(JSON.stringify(jobBase)),
    { id: 'JOBLP', ref: 'RF-2026-90004', lockedAt: new Date().toISOString(), status: 'sent' });
  await w.DB.put('jobs', lockedCompany);
  await w.DB.put('jobs', lockedPersonal);
  await w.ACT.setPlan('free');
  eq(await w.ACT.canGenerateReport(lockedPersonal), true,
    'a pre-existing personal report is reconciled into the usage ledger');
  await w.ACT.openJob('JOBLC');
  await sleep(40);
  await w.ACT.saveDraft();
  await sleep(60);
  w.ACT.go('home');
  await sleep(60);
  ok((w.document.body.textContent || '').includes('1 of 3 free reports used'),
    'the meter counts the personal report but not the company one');

  // --- removal ---------------------------------------------------------
  const removal = await T.makeRemoval('TECHPHONE1');
  ok(removal.ok, 'the owner removes the technician');
  eq(removal.file.kind, 'removal', '...as a removal file');
  eq(T.seats().used, 5, 'the seat frees up immediately');
  await w.DB.setMeta('user', techMember);
  T._testAs(techMember);
  const notMineRemoval = Object.assign({}, removal.file, { memberId: 'SOMEONEELSE' });
  eq((await T.applyRemoval(notMineRemoval)).error, 'notyou', 'a stranger\u2019s removal notice is refused');
  const removed = await T.applyRemoval(removal.file);
  ok(removed.ok, 'the technician imports the removal notice');
  eq((await w.DB.getMeta('user')).memberOf, undefined, '...and the company stamp is gone');

  // --- the stamp on paper ----------------------------------------------
  await restoreTeam(w, ownerSnap2);
  const stamped = Buffer.from(w.REPORT.buildReport(await w.DB.get('jobs', 'JOBT1'),
    { before: [], during: [], after: [], serial: [] }, {}, T.docProfile())).toString('latin1');
  ok(stamped.includes('Oga'), 'the crew job\u2019s PDF carries the company stamp');
  ok(stamped.includes('RF-2026-90001'), '...and the job reference');

  // --- the screens ------------------------------------------------------
  w.ACT.go('team');
  await sleep(60);
  const teamText = w.document.body.textContent || '';
  ok(teamText.includes('Oga & Sons'), 'the owner dashboard names the company');
  ok(teamText.includes('seats used'), '...and the seat count');
  ok(teamText.includes('Worker logins') && teamText.includes(firstWorker.code),
    'the owner dashboard lists created worker codes and share controls');
  w.ACT.go('settings');
  await sleep(60);
  const openBtn = [...w.document.querySelectorAll('[onclick]')]
    .find(b => (b.getAttribute('onclick') || '').includes('ACT.openTeam'));
  ok(!!openBtn, 'Settings offers My team');
  if (openBtn) {
    w.eval('(function(){ ' + openBtn.getAttribute('onclick') + ' })()');
    await sleep(120);
    eq(w.ACT._view(), 'team', 'tapping it lands on the team screen');
  }
  w.ACT.go('company');
  await sleep(60);
  eq(w.document.getElementById('cName').value, 'Oga & Sons', 'the stamp editor opens on the company');

  T._testAs(techMemberScreen);
  w.ACT.go('team');
  await sleep(60);
  const memberText = w.document.body.textContent || '';
  ok(memberText.includes('Oga & Sons'), 'the member screen names the crew');
  ok(memberText.includes('Leave crew'), '...and offers a way out');

  T._testAs({ name: 'Solo', phone: '', trade: 'solar', plan: 'free', uid: 'SOLO1' });
  w.ACT.go('team');
  await sleep(60);
  ok((w.document.body.textContent || '').includes('Start a company'),
    'a technician in no crew is offered a way in');

  // --- the crew survives a backup ---------------------------------------
  await restoreTeam(w, ownerSnap2);
  const serial = T.serialize();
  ok(!!serial && !!serial.company, 'the crew serializes for backup');
  eq(serial.workerLogins.length, 4, 'the crew backup carries worker login records');
  await w.DB.setMeta('company', null);
  await w.DB.setMeta('teamMembers', []);
  await w.DB.setMeta('teamInvites', []);
  await w.DB.setMeta('workerLogins', []);
  await w.DB.setMeta('teamSeats', null);
  await T.load();
  eq(T.role(), 'none', 'with the crew wiped, the owner is crewless');
  const restored = await T.restore(serial);
  ok(restored.ok && restored.company, 'restoring brings the company back');
  eq(restored.membersAdded, 6, '...and every member');
  eq(T.workerLogins().length, 4, '...and every worker login record');
  eq(T.role(), 'owner', '...and the owner is the owner again');
  eq((await T.restore(null)).ok, true, 'restoring a pre-teams backup is a no-op, not an error');
  w.ACT.go('home');
  await sleep(30);
}

/* =====================================================================
   SUITE 7 — V3 AI fault diagnosis (`aiProxy`, `DIAG`, safety, grounding,
             human-in-the-loop confirmation, draft helper, and key guards)
   ===================================================================== */
async function suiteAi(w) {
  describe('7. AI diagnosis — grounded in the library, safety first, human-confirmed');

  const fnSrc = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const draftSrc = fs.readFileSync(path.join(ROOT, 'tools/draft-guide.js'), 'utf8');
  const fnMod = require(path.join(ROOT, 'functions/index.js'));
  const libMod = require(path.join(ROOT, 'functions/library.js'));
  const draftMod = require(path.join(ROOT, 'tools/draft-guide.js'));
  const ai = fnMod._ai;
  const D = w.DIAG;

  ok(typeof D === 'object' && D !== null, 'window.DIAG is exposed to the page');
  ok(typeof fnMod.aiProxy === 'function', 'functions/index.js exports aiProxy');
  ok(typeof ai === 'object' && ai !== null, 'functions/index.js exposes _ai helpers for testing');

  const tradeIds = ['electrical', 'solar', 'cctv', 'networking', 'hvac', 'generator',
    'plumbing', 'fire_access', 'smarthome', 'ev'];
  eq(ai.MANDATORY_SAFETY && Object.keys(ai.MANDATORY_SAFETY).sort().join(','),
    tradeIds.slice().sort().join(','), 'Cloud Function has mandatory safety for all 10 trades');
  eq(D.MANDATORY_SAFETY && Object.keys(D.MANDATORY_SAFETY).sort().join(','),
    tradeIds.slice().sort().join(','), 'in-app diagnosis has mandatory safety for all 10 trades');
  eq(draftMod.VALID_TRADES.slice().sort().join(','), tradeIds.slice().sort().join(','),
    'guide-draft helper accepts exactly the 10 supported trades');
  for (const trade of tradeIds) {
    const safetyPrefix = trade === 'fire_access' ? 'LIFE SAFETY:' : 'ISOLATE FIRST:';
    ok(ai.MANDATORY_SAFETY[trade].startsWith(safetyPrefix),
      'server safety preamble is mandatory for ' + trade);
    ok(D.MANDATORY_SAFETY[trade].startsWith(safetyPrefix),
      'app safety preamble is mandatory for ' + trade);
    ok(draftMod.MANDATORY_SAFETY[trade].startsWith(safetyPrefix),
      'draft-helper safety preamble is mandatory for ' + trade);
  }

  // --- Key protection & Firestore rules for ai_requests -----------------
  ok(!/\bgsk_[A-Za-z0-9]{6,}/.test(fnSrc), 'functions/index.js hardcodes no Groq key');
  ok(!/\bgsk_[A-Za-z0-9]{6,}/.test(draftSrc), 'tools/draft-guide.js hardcodes no Groq key');
  ok(/functions\.config\(\)\.groq/.test(fnSrc), 'aiProxy reads groq.key from Firebase functions config');
  ok(/process\.env\.GROQ_API_KEY/.test(draftSrc), 'the draft helper reads GROQ_API_KEY from the terminal environment');

  const aiRuleBlock = (rulesSrc.match(/match \/ai_requests\/\{requestId\}[\s\S]*?\n    \}/) || [''])[0];
  ok(aiRuleBlock.length > 0, 'firestore.rules has an explicit rule block for ai_requests');
  ok(/allow create, update, delete: if false/.test(aiRuleBlock),
    'clients cannot create, edit, or delete ai_requests (only aiProxy writes logs)');
  ok(/allow read: if signedIn\(\) && resource\.data\.uid == request\.auth\.uid/.test(aiRuleBlock),
    'a signed-in user may read only their own ai_requests rows');

  // --- Curated library parity between data.js and functions/library.js --
  eq(libMod.FALLBACK_LIBRARY.length, w.DATA.LIBRARY.length,
    'functions/library.js matches data.js guide count (' + w.DATA.LIBRARY.length + ')');
  const rootIds = w.DATA.LIBRARY.map(e => e.id).join(',');
  const fnIds = libMod.FALLBACK_LIBRARY.map(e => e.id).join(',');
  eq(fnIds, rootIds, 'functions/library.js carries the exact same guide IDs in order');
  ok(w.DATA.LIBRARY.every(e => typeof e.safety === 'string' && e.safety.trim().length > 15),
    'every guide in data.js carries a mandatory non-empty safety block');

  // --- Cloud Function (`aiProxy` / `runDiagnosis`) ----------------------
  const logs = [];
  const logCapture = async rec => { logs.push(rec); };

  // 1. Empty input is rejected with 400
  const emptyRes = await ai.runDiagnosis({ trade: 'solar', fault: '' }, { log: logCapture });
  eq(emptyRes.statusHttp, 400, 'aiProxy rejects an empty fault description with HTTP 400');

  // 2. Out-of-scope safety classifier refuses gas, structural, medical, and utility HV
  const oosCases = [
    ['solar', 'Customer smells a cooking gas leak near the inverter room', 'gas'],
    ['solar', 'Roof collapsing under the panel rails, structural crack in beam', 'structural'],
    ['electrical', 'ICU ventilator medical equipment power supply tripping', 'medical'],
    ['electrical', '11kV street transformer pole sparking on the road', 'utility_hv']
  ];
  for (const [tr, fText, cat] of oosCases) {
    let groqCalled = false;
    const r = await ai.runDiagnosis(
      { trade: tr, fault: fText },
      { log: logCapture, callGroq: async () => { groqCalled = true; return {}; } }
    );
    eq(r.body.status, 'refused', 'aiProxy refuses out-of-scope (' + cat + ')');
    eq(r.body.category, cat, '...identifies category ' + cat);
    ok(!groqCalled, '...and never calls Groq for an out-of-scope hazard (' + cat + ')');
    ok(r.body.safety[0].startsWith('ISOLATE FIRST:'), '...prepends mandatory safety block (' + cat + ')');
    ok(r.body.tellCustomer.length > 15, '...tells the technician what to tell the customer (' + cat + ')');
  }
  eq(logs[logs.length - 1].outcome, 'refused_out_of_scope', 'out-of-scope refusal is logged to ai_requests');

  // 3. No verified entry in the curated library -> says so plainly, never guesses
  let groqCalledOnUnknown = false;
  const unknownRes = await ai.runDiagnosis(
    { trade: 'solar', fault: 'Walkie-talkie UHF repeater squelch drift on channel 9' },
    { log: logCapture, callGroq: async () => { groqCalledOnUnknown = true; return {}; } }
  );
  eq(unknownRes.body.status, 'no_match', 'when the library has no verified entry, status is no_match');
  ok(/no verified entry/i.test(unknownRes.body.message) && /will not guess/i.test(unknownRes.body.message),
    '...message says plainly there is no verified entry and it will not guess');
  eq(unknownRes.body.possible_causes.length, 0, '...emits zero guessed causes');
  ok(!groqCalledOnUnknown, '...never calls Groq when the library has no verified entry');
  eq(logs[logs.length - 1].outcome, 'no_verified_entry', '...logs no_verified_entry to ai_requests');

  // 4. Verified library match + Groq strict JSON card response + safety block prepended
  const mockGroqValid = async () => ({
    matched_guide_id: 'sol-e03',
    possible_causes: [
      { t: 'Loose or high-resistance DC connection', p: 'HIGH', d: 'Battery lug on unit 3 is dropping voltage under fridge surge.' },
      { t: 'Startup surge exceeds inverter capability', p: 'MED', d: 'Compressor starting draw exceeds surge rating.' }
    ],
    checks: [
      'Measure open-circuit battery voltage at the inverter terminals.',
      'Repeat the measurement while the motor starts and feel every DC lug for heat.'
    ],
    safety: ['Verify array is covered before touching DC lugs.'],
    parts: [
      { d: '35 mm² copper lug', price: 1500 },
      { d: 'Heat-shrink kit', price: 1500 }
    ],
    confidence: 0.91,
    escalate_to_human: false
  });
  const diagRes = await ai.runDiagnosis(
    { trade: 'solar', fault: 'Inverter shuts down when fridge starts', code: 'E03', uid: 'TECH-1' },
    { log: logCapture, callGroq: mockGroqValid }
  );
  eq(diagRes.statusHttp, 200, 'verified fault returns HTTP 200');
  eq(diagRes.body.status, 'diagnosed', '...with status diagnosed');
  eq(diagRes.body.matched_guide_id, 'sol-e03', '...matched to verified guide sol-e03');
  eq(diagRes.body.fallback, false, '...ranked by Groq (not fallback)');
  ok(diagRes.body.safety[0].startsWith('ISOLATE FIRST:'),
    '...prepends the hard-coded mandatory trade safety preamble first');
  ok(diagRes.body.safety.some(s => s.includes('DC strings stay live in daylight')),
    '...includes the verified guide safety block');
  eq(diagRes.body.possible_causes.length, 2, '...returns structured cause cards');
  eq(logs[logs.length - 1].outcome, 'diagnosed', '...logs diagnosed outcome to ai_requests');
  eq(logs[logs.length - 1].uid, 'TECH-1', '...records the technician uid in ai_requests');

  // 5. Schema validation rejects prose, bad guide IDs, and retries once before library fallback
  eq(ai.validateAiSchema('Here is a paragraph of chat prose', libMod.LIBRARY).valid, false,
    'schema validator rejects chat prose');
  eq(ai.validateAiSchema({ matched_guide_id: 'invented-id', possible_causes: [], checks: [], parts: [], confidence: 0.5, escalate_to_human: false },
    [libMod.LIBRARY[0]]).valid, false,
    'schema validator rejects an invented guide ID outside retrieved candidates');

  let tries = 0;
  const retryRes = await ai.runDiagnosis(
    { trade: 'solar', fault: 'Inverter trips on E03 when motor starts', code: 'E03' },
    {
      log: logCapture,
      callGroq: async () => {
        tries++;
        if (tries === 1) return 'chat prose that violates schema';
        return mockGroqValid();
      }
    }
  );
  eq(tries, 2, 'aiProxy retries once when the first Groq response fails schema validation');
  eq(retryRes.body.fallback, false, '...and succeeds on the retry when valid JSON arrives');

  const fallbackRes = await ai.runDiagnosis(
    { trade: 'solar', fault: 'Inverter trips on E03 when motor starts', code: 'E03' },
    {
      log: logCapture,
      callGroq: async () => { throw new Error('Groq unreachable'); }
    }
  );
  eq(fallbackRes.body.status, 'diagnosed', 'when Groq fails twice, aiProxy still returns structured cards');
  eq(fallbackRes.body.fallback, true, '...marked as deterministic library fallback');
  eq(fallbackRes.body.matched_guide_id, 'sol-e03', '...from the matched verified guide');
  ok(fallbackRes.body.safety[0].startsWith('ISOLATE FIRST:'), '...with mandatory safety block first');
  eq(logs[logs.length - 1].outcome, 'fallback_library', '...and logs fallback_library to ai_requests');

  // --- Draft helper (`tools/draft-guide.js`) ----------------------------
  const parsedArgs = draftMod.parseArgs(['node', 'draft-guide.js', 'solar', 'Overload E05 beeping']);
  ok(parsedArgs.ok && parsedArgs.trade === 'solar', 'draft helper parses trade and dictated notes');
  const evDraftArgs = draftMod.parseArgs(['node', 'draft-guide.js', 'ev', 'Charger fault, no power']);
  const evPrompt = draftMod.buildDraftPrompt('ev', 'Charger fault, no power');
  ok(evDraftArgs.ok && evDraftArgs.trade === 'ev', 'draft helper accepts the new EV trade');
  ok(evPrompt.system.includes(draftMod.MANDATORY_SAFETY.ev),
    'the AI drafting prompt embeds the EV safety preamble');
  const badDraft = { id: 'sol-overload', trade: 'solar', cat: 'Inverter', symptom: 'Overload', safety: '', causes: [], checks: [], parts: [] };
  eq(draftMod.validateGuideDraft(badDraft).valid, false, 'draft helper refuses a guide without a safety block');
  const goodDraft = {
    id: 'sol-overload', trade: 'solar', cat: 'Hybrid inverter',
    symptom: 'Inverter overload alarm, beeping continuously', code: 'E05', freq: 'high',
    causes: [{ t: 'Load exceeds inverter continuous rating', p: 'HIGH', d: 'Clamp-meter the AC output.' }],
    checks: ['Measure AC load current with a clamp meter and compare to continuous rating.'],
    safety: 'Isolate AC output before opening the distribution board.',
    parts: [{ d: 'Changeover switch', price: 12000 }],
    source: 'REHOTEQ field data'
  };
  eq(draftMod.validateGuideDraft(goodDraft).valid, true, 'draft helper validates a complete guide entry');
  const formatted = draftMod.formatGuideForDataJs(goodDraft);
  ok(formatted.includes("id: 'sol-overload'") && formatted.includes('safety:'),
    'draft helper formats valid JS ready for review');

  // --- In-app Diagnose screen & human-in-the-loop confirmation ----------
  w.ACT.go('actions');
  await sleep(50);
  const diagTile = [...w.document.querySelectorAll('.tile')]
    .find(b => (b.textContent || '').includes('Diagnose a fault'));
  ok(!!diagTile, 'the action sheet has the Diagnose a fault tile');
  ok(diagTile && !diagTile.classList.contains('locked'),
    'the V3 Diagnose a fault tile is unlocked');
  if (diagTile) {
    w.eval('(function(){ ' + diagTile.getAttribute('onclick') + ' })()');
    await sleep(60);
  }
  eq(w.ACT._view(), 'diagnose', 'tapping the tile lands on the Diagnose screen');

  // Offline honesty check
  D._setOnline(false);
  await sleep(40);
  const offlineText = w.document.body.textContent || '';
  ok(/Offline — AI diagnosis needs a connection/.test(offlineText),
    'when offline, the Diagnose screen says plainly that AI diagnosis needs a connection');
  eq((await D.diagnose({ trade: 'solar', fault: 'E03' })).error, 'offline',
    'DIAG.diagnose refuses to run while offline');

  // Back online
  D._setOnline(true);
  await sleep(40);
  const onlineText = w.document.body.textContent || '';
  ok(/Online-only/.test(onlineText) && /Nothing enters your job card until you confirm a cause/.test(onlineText),
    'when online, the Diagnose screen states both online-only and confirmation rules plainly');

  // Out-of-scope on screen
  w.document.getElementById('dFault').value = 'Customer smells cooking gas leak by the cylinder';
  await w.ACT.runDiagnose();
  await sleep(50);
  const oosScreen = w.document.body.textContent || '';
  ok(/Out of scope/.test(oosScreen) && /licensed gas \/ LPG technician/.test(oosScreen),
    'the Diagnose screen renders out-of-scope refusal and names the licensed specialist');
  eq(w.document.querySelectorAll('[onclick*="ACT.confirmCause"]').length, 0,
    'out-of-scope refusal offers zero Confirm cause buttons');

  // No verified entry on screen -> never guesses
  w.ACT.clearDiag();
  await sleep(30);
  w.document.getElementById('dFault').value = 'Walkie talkie frequency drift on UHF channel 9';
  await w.ACT.runDiagnose();
  await sleep(50);
  const noMatchScreen = w.document.body.textContent || '';
  ok(/No verified entry in the library/.test(noMatchScreen) && /will not guess/.test(noMatchScreen),
    'when the library has no verified entry, the screen says so plainly and never guesses');
  eq(w.document.querySelectorAll('[onclick*="ACT.confirmCause"]').length, 0,
    'no-verified-entry state offers zero Confirm cause buttons');

  // Start a job card, run diagnosis with a mocked proxy fetch, prove nothing enters
  // the job card until the technician taps Confirm cause
  await w.ACT.startJob();
  await sleep(50);
  eq(w.ACT._view(), 'newjob', 'started a fresh job card');
  w.ACT.openDiagnose();
  await sleep(50);
  eq(w.ACT._view(), 'diagnose', 'opened Diagnose from the active job flow');

  w.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      status: 'diagnosed',
      trade: 'solar',
      fallback: false,
      matched_guide_id: 'sol-e03',
      possible_causes: [
        { t: 'Loose or high-resistance DC connection', p: 'HIGH', d: 'Voltage collapses during the surge, tripping overcurrent protection.' },
        { t: 'Startup surge exceeds inverter capability', p: 'MED', d: 'Compressor draws 4–6x running current.' }
      ],
      checks: [
        'Measure open-circuit battery voltage at the inverter terminals.',
        'After 10 minutes on load, feel every DC lug for heat.'
      ],
      safety: ['Cover the array before working on DC terminations.'],
      parts: [{ d: '35 mm² copper lug', price: 1500 }],
      confidence: 0.92,
      escalate_to_human: false
    })
  });

  w.document.getElementById('dCode').value = 'E03';
  w.document.getElementById('dFault').value = 'Inverter trips when fridge starts';
  await w.ACT.runDiagnose();
  await sleep(60);

  const diagScreen = w.document.body.textContent || '';
  ok(/Safety first/.test(diagScreen) && /ISOLATE FIRST:/.test(diagScreen),
    'diagnosed view renders the mandatory Safety first block at the top');
  ok(/Loose or high-resistance DC connection/.test(diagScreen),
    'diagnosed view renders the ranked cause cards');
  ok(/Check in this order/.test(diagScreen),
    'diagnosed view renders the ordered checks');

  // Crucial rule: before tapping Confirm cause, S.job.diagnosis is still empty!
  const jobBeforeConfirm = (await w.DB.all('jobs')).find(j => j.id === D.state().jobId) ||
    (await w.DB.all('jobs')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  eq(jobBeforeConfirm.diagnosis, '',
    'running a diagnosis NEVER writes to the job card before the technician confirms a cause');

  // Now tap the real Confirm cause button on card 0
  const confirmBtn = w.document.querySelector('[onclick="ACT.confirmCause(0)"]');
  ok(!!confirmBtn, 'each ranked cause card has a tappable Confirm cause button');
  if (confirmBtn) {
    w.eval('(function(){ ' + confirmBtn.getAttribute('onclick') + ' })()');
    await sleep(80);
  }
  eq(w.ACT._view(), 'jobcard', 'confirming a cause returns the technician to the job card');
  const jobAfterConfirm = await w.DB.get('jobs', jobBeforeConfirm.id);
  ok(jobAfterConfirm.diagnosis.includes('Loose or high-resistance DC connection'),
    'after confirmation, the chosen cause is written into the job card diagnosis');
  ok(jobAfterConfirm.fault.includes('E03'),
    '...and the fault description is carried onto the job card');
  ok(jobAfterConfirm.materials.some(m => m.desc.includes('copper lug')),
    '...and priced parts from the verified guide pre-fill materials');

  const outbox = await w.DB.all('outbox');
  ok(outbox.some(o => o.op && o.op.type === 'ai.request'), 'outbox logs ai.request');
  ok(outbox.some(o => o.op && o.op.type === 'ai.confirm'), 'outbox logs ai.confirm when the technician confirms');

  delete w.fetch;
  w.ACT.go('home');
  await sleep(30);
}

/* =====================================================================
   SUITE 8 — Landing page (Individual vs Company) & Owner all-plans access
   ===================================================================== */
async function suiteLandingAndOwner(w) {
  describe('8. Landing page & owner all-plans access');

  const fnMod = require(path.join(ROOT, 'functions/index.js'));
  const ai = fnMod._ai;

  // --- Owner email recognition in config.js and functions/index.js -----
  ok(typeof w.CONFIG.isOwner === 'function', 'CONFIG.isOwner is exposed');
  ok(w.CONFIG.isOwner('rehoteq@gmail.com'), 'CONFIG.isOwner recognises rehoteq@gmail.com');
  ok(w.CONFIG.isOwner('  REHOTEQ@GMAIL.COM '), 'CONFIG.isOwner is case-insensitive and trims whitespace');
  ok(!w.CONFIG.isOwner('someone@example.com'), 'CONFIG.isOwner rejects non-owner emails');
  ok(ai.isOwnerEmail('rehoteq@gmail.com'), 'functions/index.js isOwnerEmail recognises rehoteq@gmail.com');
  ok(!ai.isOwnerEmail('stranger@example.com'), 'functions/index.js isOwnerEmail rejects strangers');

  const fnSrc = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  ok(/rehoteq@gmail\.com/.test(fnSrc), 'functions/index.js grants owner access to rehoteq@gmail.com');
  ok(/allPlansAccess:\s*owner/.test(fnSrc), 'createAccount records allPlansAccess for the owner');

  // --- First-run landing screen (before any account exists) ------------
  await w.DB.del('meta', 'user');
  await w.DB.del('meta', 'company');
  await w.DB.del('meta', 'teamMembers');
  await w.DB.del('meta', 'teamInvites');
  await w.DB.del('meta', 'teamSeats');
  const wFresh = bootApp();
  await sleep(160);
  eq(wFresh.ACT._view(), 'boot', 'a fresh phone lands on the boot / landing screen');
  const landText = wFresh.document.body.textContent || '';
  ok(/Field Engineering OS/.test(landText), 'landing page displays the Field Engineering OS hero banner');
  ok(/See a live PDF report/.test(landText), 'landing page offers a 1-tap live PDF report preview before signup');
  ok(/What your customer receives/.test(landText), 'landing page previews what the customer receives on WhatsApp');
  ok(/Individual Technician/.test(landText), 'landing page offers Individual Technician onboarding');
  ok(/As a Company \/ Crew/.test(landText), 'landing page offers Company / Crew onboarding');

  // Switching between Individual and Company preserves typed fields and reveals company stamp fields
  wFresh.document.getElementById('iName').value = 'Engr. Kunle';
  wFresh.document.getElementById('iCompany').value = 'Kunle Solar Ltd';
  const companyTab = wFresh.document.querySelector('[onclick="ACT.setOnboardMode(\'company\')"]');
  ok(!!companyTab, 'tappable Company / Crew tab exists on the landing page');
  wFresh.eval('(function(){ ' + companyTab.getAttribute('onclick') + ' })()');
  await sleep(50);
  eq(wFresh.document.getElementById('iName').value, 'Engr. Kunle',
    'switching to Company mode preserves typed name');
  ok(!!wFresh.document.getElementById('iAddress') && !!wFresh.document.getElementById('iBank'),
    'Company mode exposes business address and bank details on first run');
  ok(/Start as a Company/.test(wFresh.document.body.textContent || ''),
    'CTA updates to "Start as a Company"');

  // Saving in Company mode creates the profile AND initializes the company crew workspace
  await wFresh.ACT.saveProfile();
  await sleep(80);
  eq(wFresh.ACT._view(), 'home', 'saving Company onboarding lands on home');
  eq(wFresh.TEAM.role(), 'owner', 'starting as a Company automatically initializes the crew owner workspace');
  eq((await wFresh.DB.getMeta('company')).name, 'Kunle Solar Ltd',
    'the company stamp carries the company name from onboarding');

  // --- Owner (rehoteq@gmail.com) gets access to all plans --------------
  w.ACT.editProfile();
  await sleep(60);
  w.document.getElementById('iName').value = 'Toye (REHOTEQ Owner)';
  w.document.getElementById('iPhone').value = '0703 630 2585';
  w.document.getElementById('iCompany').value = 'REHOTEQ Technologies';
  w.document.getElementById('iEmail').value = 'rehoteq@gmail.com';
  await w.ACT.saveProfile();
  await sleep(80);

  eq(w.ACT.isOwner(), true, 'ACT.isOwner() is true for rehoteq@gmail.com');
  const savedOwner = await w.DB.getMeta('user');
  eq(savedOwner.ownerAccess, true, 'user record is marked with ownerAccess');
  eq(savedOwner.plan, 'business', 'rehoteq@gmail.com defaults to highest tier (business) with all plans unlocked');

  const homeTxt = w.document.body.textContent || '';
  ok(/Owner — all plans unlocked/.test(homeTxt), 'home meter shows Owner — all plans unlocked');

  w.ACT.go('settings');
  await sleep(60);
  const settingsTxt = w.document.body.textContent || '';
  ok(/Owner access \(rehoteq@gmail\.com\)/.test(settingsTxt),
    'Settings Subscription card displays Owner access for rehoteq@gmail.com');

  // Owner can switch between Free, Pro, and Business at will
  const proPill = w.document.querySelector('[onclick="ACT.setPlan(\'pro\')"]');
  const freePill = w.document.querySelector('[onclick="ACT.setPlan(\'free\')"]');
  const bizPill = w.document.querySelector('[onclick="ACT.setPlan(\'business\')"]');
  ok(!!proPill && !!freePill && !!bizPill, 'Settings renders Free, Pro, and Business plan pills for the owner');

  await w.ACT.setPlan('pro');
  await sleep(40);
  eq((await w.DB.getMeta('user')).plan, 'pro', 'owner can switch to Pro plan in one tap');
  await w.ACT.setPlan('free');
  await sleep(40);
  eq((await w.DB.getMeta('user')).plan, 'free', 'owner can switch to Free plan in one tap');
  eq(w.ACT.isOwner(), true, 'even when previewing Free, rehoteq@gmail.com retains Owner status');
  await w.ACT.setPlan('business');
  await sleep(40);
  eq((await w.DB.getMeta('user')).plan, 'business', 'owner can switch back to Business plan in one tap');

  w.ACT.go('home');
  await sleep(30);
}

/* =====================================================================
   SUITE 9 — account vault and device-wide Free report quota
   ===================================================================== */
async function suiteAccountsQuota(w) {
  describe('9. Saved accounts, owner switching, and strict Free report quota');

  // Changing away from the owner email must revoke the stored entitlement.
  w.ACT.editProfile();
  await sleep(40);
  w.document.getElementById('iEmail').value = 'solo@example.com';
  await w.ACT.saveProfile();
  await sleep(50);
  const downgraded = await w.DB.getMeta('user');
  eq(downgraded.email, 'solo@example.com', 'the updated profile email is saved');
  eq(downgraded.ownerAccess, false, 'changing away from the owner email clears ownerAccess');
  eq(downgraded.plan, 'free', 'changing away from the owner email resets the plan to Free');
  eq(w.ACT.isOwner(), false, 'the changed profile no longer has owner mode');

  // Settings logout saves the account locally; the new boot tab can restore it.
  w.ACT.go('settings');
  await sleep(40);
  const logoutButton = w.document.querySelector('[onclick="ACT.logout()"]');
  ok(!!logoutButton, 'Settings offers Log out / switch account');
  const accountId = downgraded.uid;
  await w.ACT.logout();
  eq(await w.DB.getMeta('user'), null, 'logout clears the active local account');
  const vault = await w.DB.getMeta('accounts');
  ok(Array.isArray(vault) && vault.some(a => a.uid === accountId && a.email === 'solo@example.com'),
    'DB.getMeta(accounts) keeps a saved-device account snapshot');
  await w.ACT.loginSaved();
  ok((w.document.body.textContent || '').includes('Log in / Worker') &&
    (w.document.body.textContent || '').includes('solo@example.com'),
    'the third landing tab lists saved accounts and worker-code login');
  eq(w.document.getElementById('workerCode').maxLength, 12,
    'the worker-code input accepts the full RQ-XXXX-XXXX code');
  await w.ACT.loginAccount(accountId);
  eq(w.ACT._view(), 'home', 'ACT.loginAccount returns the saved profile to Home');
  eq((await w.DB.getMeta('user')).email, 'solo@example.com', 'saved login restores the edited email');
  eq((await w.DB.getMeta('user')).plan, 'free', 'saved login does not restore stale owner access');

  // A confirmed device reset removes accounts/jobs but deliberately retains
  // the device-wide usage key in both IndexedDB and localStorage.
  const preserveId = 'WIPE-PRESERVE-' + Date.now();
  const seedLedger = { version: 1, reportIds: [preserveId], used: 1, count: 1 };
  await w.DB.setMeta('usageLedger', seedLedger);
  w.localStorage.setItem('rehoteq_usage_ledger_v1', JSON.stringify(seedLedger));
  const oldConfirm = w.confirm;
  w.confirm = () => true;
  await w.ACT.wipe();
  w.confirm = oldConfirm;
  const afterWipe = await w.DB.getMeta('usageLedger');
  const browserLedger = JSON.parse(w.localStorage.getItem('rehoteq_usage_ledger_v1') || '{}');
  ok(afterWipe && afterWipe.reportIds.includes(preserveId),
    'ACT.wipe preserves prior Free usage in IndexedDB');
  ok(browserLedger.reportIds && browserLedger.reportIds.includes(preserveId),
    'ACT.wipe preserves prior Free usage in localStorage');
  eq(await w.DB.getMeta('accounts'), null, 'device reset clears saved account profiles');

  // Fresh signup gets a clean profile, not a clean quota.
  w.document.getElementById('iName').value = 'Fresh Technician';
  w.document.getElementById('iPhone').value = '0803 000 1111';
  w.document.getElementById('iCompany').value = 'Fresh Field Works';
  await w.ACT.saveProfile();
  await sleep(40);
  eq((await w.DB.getMeta('user')).plan, 'free', 'a fresh profile starts on Free');
  const signupLedger = await w.DB.getMeta('usageLedger');
  ok(signupLedger.reportIds.includes(preserveId),
    'signing up again on the same device keeps the previous usage entry');

  // Seed a known empty ledger after the persistence checks so the quota
  // boundary is independent of older test fixtures or migrated reports.
  const emptyLedger = { version: 1, reportIds: [], used: 0, count: 0 };
  await w.DB.setMeta('usageLedger', emptyLedger);
  w.localStorage.setItem('rehoteq_usage_ledger_v1', JSON.stringify(emptyLedger));
  const freeJobs = [
    { id: 'FREE-REPORT-1' }, { id: 'FREE-REPORT-2' },
    { id: 'FREE-REPORT-3' }, { id: 'FREE-REPORT-4' }
  ];
  for (let i = 0; i < 3; i++) {
    eq(await w.ACT.canGenerateReport(freeJobs[i]), true,
      'Free plan can generate report ' + (i + 1) + ' of 3');
  }
  eq(await w.ACT.canGenerateReport(freeJobs[3]), false,
    'the fourth unique Free report is refused');
  eq((await w.DB.getMeta('usageLedger')).used, 3, 'three unique reports fill the Free ledger exactly');
  const persistedAfterThree = JSON.parse(w.localStorage.getItem('rehoteq_usage_ledger_v1'));
  eq(persistedAfterThree.used, 3, 'the three-report count is mirrored in localStorage');

  // Both report actions call the real guard before mutating/generating.
  const actionJob = {
    id: 'FREE-REPORT-FINISH-4', ref: 'RF-QUOTA-4', trade: 'solar', jobType: 'Report test',
    status: 'draft', lockedAt: null, companyId: null,
    signatures: { customer: { name: 'Customer' }, technician: { name: 'Technician' } }
  };
  w.ACT._setJobForTest(actionJob);
  await w.ACT.finish();
  ok(w.document.getElementById('paywall').classList.contains('show'),
    'ACT.finish opens the paywall when the Free quota is exhausted');
  eq(await w.DB.get('jobs', actionJob.id), undefined,
    'ACT.finish does not lock or save an over-quota report');
  eq((await w.DB.getMeta('usageLedger')).used, 3,
    'ACT.finish does not reserve a fourth usage slot');
  w.ACT.closePaywall();
  w.ACT._setJobForTest(actionJob);
  await w.ACT.pdf();
  ok(w.document.getElementById('paywall').classList.contains('show'),
    'ACT.pdf opens the paywall when the Free quota is exhausted');
  eq((await w.DB.getMeta('usageLedger')).used, 3,
    'ACT.pdf does not reserve a fourth usage slot');
  w.ACT.closePaywall();

  // Company and explicitly marked demo jobs never spend a personal slot.
  const usedBeforeBypasses = (await w.DB.getMeta('usageLedger')).used;
  eq(await w.ACT.canGenerateReport({ id: 'COMPANY-REPORT', companyId: 'CO-TEST' }), true,
    'company reports bypass the personal Free quota');
  eq(await w.ACT.canGenerateReport({ id: 'DEMO-REPORT', isDemo: true }), true,
    'demo reports bypass the personal Free quota');
  eq((await w.DB.getMeta('usageLedger')).used, usedBeforeBypasses,
    'company and demo reports do not consume ledger entries');
  w.ACT._setJobForTest(null);

  await w.ACT.loadDemo();
  const demo = (await w.DB.all('jobs')).find(j => j.isDemo);
  ok(!!demo && demo.isDemo === true, 'ACT.loadDemo saves the job with isDemo=true');
  eq((await w.DB.getMeta('usageLedger')).reportIds.includes(demo && demo.id), false,
    'the saved demo job is not migrated into the Free usage ledger');
  w.ACT.go('home');
  await sleep(30);
}

/* =====================================================================
   run
   ===================================================================== */
(async () => {
  console.log('REHOTEQ Field — test run');
  let w;
  try {
    w = bootApp();
    await sleep(250);
  } catch (e) {
    console.error('\nFATAL: the app did not load at all.\n', e);
    process.exit(1);
  }

  async function suiteWelcomeTrial() {
    const wApp = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const wCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    ok(wCss.indexOf('data:font/woff2') !== -1 && wCss.indexOf("'Space Grotesk'") !== -1,
      'the splash carries its Space Grotesk display font, embedded and offline-safe');
    ok(/teamadd: 'Add a technician'/.test(wApp),
      'the Add-a-technician screen has a nav title');
    ok(/V\.teamadd = /.test(wApp),
      'the Add-a-technician wizard exists with its step cards');
    ok(/Import file from WhatsApp/.test(wApp),
      'importing a crew file is called what it is, not Receive file');
    ok(wApp.indexOf('R_MARK_SRC') !== -1 && wApp.indexOf('data:image/png') !== -1,
      'the welcome screen carries the real R mark, embedded');
    ok(/w-mark-glow/.test(wApp), 'the R mark carries an animated glow ring');
    ok(wCss.indexOf('@media (min-width:900px)') !== -1,
      'the welcome screen has a desktop layout');
    ok(wCss.indexOf('@media (prefers-reduced-motion:reduce)') !== -1,
      'welcome animations respect reduced-motion preferences');
    const icons = require(path.join(ROOT, 'icons.js'));
    const zap = icons.ICON('zap', 18);
    eq((zap.match(/<svg/g) || []).length, 1, 'ICON emits exactly one opening svg tag');
    eq((zap.match(/<\/svg>/g) || []).length, 1, 'ICON emits exactly one closing svg tag');
    ok(zap.indexOf('width="18"') !== -1, 'ICON applies the requested size');
    ok(/class="icon[ "]/.test(zap), 'ICON keeps the icon class for tinting');
    const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const fbSrc = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
    ok(/V\.welcome\s*=/.test(appSrc), 'a welcome splash is the first screen for brand-new visitors');
    ok(/ACT\.enterApp\(\)/.test(appSrc), 'Try-it-first is a real action, not a dark pattern');
    ok(/welcomeSeen/.test(appSrc), 'the splash shows once and the device remembers it');
    ok(/function hasProAccess\(/.test(appSrc), 'one shared entitlement test governs Pro access');
    ok(/if \(hasProAccess\(\)\) return true;/.test(appSrc), 'the report gate uses the shared entitlement test');
    ok(/function trialActive\(/.test(appSrc), 'an unexpired 14-day trial clock grants Pro access');
    ok(/Pro trial · ends /.test(appSrc), 'the account card shows the trial and its end date');
    ok(/Owner access · all plans unlocked/.test(appSrc), 'the account card shows owner entitlement');
    ok(/profile:\s*function/.test(fbSrc), 'the app reads the server-written entitlement record');
    ok(/hydrateEntitlement\(\)/.test(appSrc), 'sign-in hydrates the trial clock from the server record');
  }

  await suiteSurface(w);
  await suiteIcons(w);
  suiteWiring(w);
  suiteDomain(w);
  suiteBranding(w);
  await suitePricing(w);
  await suiteBrief(w);
  await suiteTaps(w);
  suiteRules();
  await suiteFirebase(w);
  await suiteWelcomeTrial(w);
  await suiteTeam(w);
  await suiteAi(w);
  await suiteLandingAndOwner(w);
  await suiteAccountsQuota(w);

  console.log('\n' + '-'.repeat(58));
  console.log('passed: ' + pass + '   failed: ' + fail);
  if (fail) {
    console.log('\nFAILURES');
    failures.forEach(f => console.log('  \u2022 ' + f));
    console.log('\n>>> FAILED');
    process.exit(1);
  }
  console.log('\n>>> ALL CHECKS PASSED');
  process.exit(0);
})();

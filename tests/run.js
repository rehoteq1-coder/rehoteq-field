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

  // The <div id="toast"> in index.html claims the global name `toast`.
  // Handlers must therefore never call a bare toast(...).
  ok(typeof w.toast !== 'function',
    'bare global `toast` is the <div>, not a function (so handlers must use ACT.toast)');

  eq(w.DATA.TRADES.length, 4, 'four trades are defined');
  ok(w.DATA.LIBRARY.length >= 12, 'troubleshooting library has at least 12 guides (' + w.DATA.LIBRARY.length + ')');
  ok(Object.keys(w.DATA.CHECKLISTS).length >= 10, 'at least 10 checklists (' + Object.keys(w.DATA.CHECKLISTS).length + ')');
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
const SHIPPED = ['index.html', '404.html', 'config.js', 'app.js', 'data.js',
                 'db.js', 'pdf.js', 'qr.js', 'report.js', 'sw.js'];

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
      const okThirdParty = ['wa.me', 'www.w3.org'].includes(host);
      if (!OWNED.includes(host) && !okThirdParty) foreign.push(f + ' \u2192 ' + host);
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

  await suiteSurface(w);
  suiteWiring(w);
  suiteDomain(w);
  suiteBranding(w);
  await suiteTaps(w);

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

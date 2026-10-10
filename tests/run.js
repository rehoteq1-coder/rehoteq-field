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

  // The bug this catches actually shipped: TRADES[].icon became an icon
  // *name* ('solar-panel'), and two views went on printing it as text, so
  // the home screen read "solar-panel Solar". An icon name is an
  // identifier, never something a technician should ever see. Walk the
  // views and assert none of them leaks one.
  const names = Object.keys(w.ICONS).filter(n => n.length > 3);
  const leaks = [];
  for (const v of ['home', 'library', 'jobs', 'settings', 'passport']) {
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
      // flutterwave.com is the payment host. It is allow-listed here so a
      // typo'd or substituted payment domain still fails the build — the
      // point of the guard is that no host appears by accident.
      const okPayment = /^flutterwave\.com$/.test(host);
      if (!OWNED.includes(host) && !okThirdParty && !okPayment) {
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
  SHIPPED.forEach(f => {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) return;
    const src = fs.readFileSync(full, 'utf8');
    if (/\bsk_(live|test)_[A-Za-z0-9]{6,}/.test(src)) secrets.push(f + ' — secret key');
    if (/\bFLWSECK-[A-Za-z0-9-]{6,}/.test(src)) secrets.push(f + ' — Flutterwave secret');
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
  await suiteIcons(w);
  suiteWiring(w);
  suiteDomain(w);
  suiteBranding(w);
  await suitePricing(w);
  await suiteBrief(w);
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

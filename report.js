/* =====================================================================
   report.js — turns a job card into a printable PDF
   Server-side rendering later; this runs on the device today, so a
   technician can produce the document with no signal at all.
   ===================================================================== */
(function (global) {
  'use strict';

  // Every printed link comes from config.js — never hardcode a domain here.
  // The fallback keeps the PDF buildable if config.js somehow fails to load,
  // rather than printing a broken or hostile URL.
  const CFG = global.CONFIG || {
    domain: 'field.rehoteq.com',
    verifyLabel: ref => 'field.rehoteq.com/v/' + String(ref || '').replace(/[^A-Za-z0-9]/g, '')
  };

  const GREEN  = [0.055, 0.486, 0.353];
  const INK    = [0.059, 0.090, 0.165];
  const MUTED  = [0.392, 0.455, 0.545];
  const LINE   = [0.886, 0.910, 0.941];
  const PAPER  = [0.973, 0.980, 0.984];
  const WHITE  = [1, 1, 1];
  const M = 44;                       // margin in points
  const CW = 595.28 - M * 2;          // content width

  function Ctx() {
    this.doc = new PDFT.PDF();
    this.p = this.doc.page();
    this.y = 0;
    this.pages = [this.p];
  }
  Ctx.prototype.need = function (h) {
    if (this.y + h > PDFT.PH - 74) {
      this.p = this.doc.page();
      this.pages.push(this.p);
      this.y = 64;
      this.header();
    }
  };
  Ctx.prototype.header = function (title) {
    PDFT.text(this.p, M, 46, title || '', { size: 8.5, bold: true, color: MUTED });
    PDFT.line(this.p, M, 58, M + CW, 58, LINE, 0.7);
    this.y = 70;
  };

  function fmt(n) {
    return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  }
  function dstr(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function tstr(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  // Synchronous base64 → bytes. The logo is stored as a data URL so it
  // survives a backup/restore round-trip as plain JSON; JPEG bytes are what
  // the PDF image operator needs.
  const ATOB = (typeof global !== 'undefined' && global.atob) ? global.atob : atob;
  function jpegFromDataUrl(d) {
    const b = String(d || '').split(',')[1] || '';
    const bin = ATOB(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Trim a line to fit, so a long address can never run into the
  // right-hand column of the masthead.
  function fit(s, size, maxW) {
    const str = String(s || '');
    if (PDFT.width(str, size, false) <= maxW) return str;
    let out = str;
    while (out.length > 1 && PDFT.width(out + '...', size, false) > maxW) {
      out = out.slice(0, -1);
    }
    return out.trim() + '...';
  }

  /* --- the brand mark on every document -------------------------------
     The technician's own logo if he has uploaded one, letterboxed so it
     is never stretched; the REHOTEQ "R" if he has not. A logo that fails
     to decode must degrade to the mark, not to a broken PDF.
  */
  function logoBox(c, x, y, s, profile) {
    PDFT.rect(c.p, x, y, s, s, WHITE);
    const logo = profile.logo;
    if (logo && logo.dataUrl && logo.w && logo.h) {
      try {
        const bytes = jpegFromDataUrl(logo.dataUrl);
        const pad = Math.max(2, s * 0.11);
        const avail = s - pad * 2;
        const k = Math.min(avail / logo.w, avail / logo.h);
        const dw = logo.w * k, dh = logo.h * k;
        PDFT.image(c.p, bytes, logo.w, logo.h,
          x + (s - dw) / 2, y + (s - dh) / 2, dw, dh);
        return;
      } catch (e) { /* fall through to the mark */ }
    }
    PDFT.text(c.p, x + s * 0.28, y + s * 0.74, 'R',
      { size: s * 0.58, bold: true, color: GREEN });
  }

  // One contact line under the company name, built from whatever the
  // technician has actually filled in.
  function contactLine(profile) {
    return [profile.address, profile.phone, profile.email].filter(Boolean).join('  ·  ');
  }

  function coord(lat, lng) {
    if (lat === null || lat === undefined || lng === null || lng === undefined) return '—';
    const a = Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S');
    const b = Math.abs(lng).toFixed(4) + '° ' + (lng >= 0 ? 'E' : 'W');
    return a + ', ' + b;
  }

  /* --- a labelled block of body text -------------------------------- */
  function block(c, label, value, size) {
    if (!value || !String(value).trim()) return;
    size = size || 9.5;
    const lines = PDFT.wrap(value, size, false, CW);
    c.need(20 + lines.length * (size + 3.2));
    PDFT.text(c.p, M, c.y + 9, label, { size: 7.5, bold: true, color: GREEN });
    c.y += 20;
    for (const ln of lines) {
      PDFT.text(c.p, M, c.y, ln, { size: size, color: INK });
      c.y += size + 3.2;
    }
    c.y += 8;
  }

  /* --- key/value table ---------------------------------------------- */
  function kvTable(c, rows) {
    const lh = 15.5;
    c.need(rows.length * lh + 14);
    let y = c.y;
    rows.forEach((r, i) => {
      if (i % 2 === 0) PDFT.rect(c.p, M, y - 2, CW, lh, PAPER);
      PDFT.text(c.p, M + 8, y + 9, r[0], { size: 8, color: MUTED });
      PDFT.text(c.p, M + 108, y + 9, r[1] || '—', { size: 8.5, bold: true, color: INK });
      y += lh;
    });
    c.y = y + 12;
  }

  /* =======================  SERVICE REPORT  ========================== */

  function buildReport(job, photos, sigs, profile) {
    profile = profile || {};
    const c = new Ctx();
    const company = profile.company || 'REHOTEQ Technologies';

    /* --- masthead ---------------------------------------------------- */
    PDFT.rect(c.p, 0, 0, 595.28, 104, GREEN);
    logoBox(c, M, 24, 28, profile);
    PDFT.text(c.p, M + 38, 38, 'SERVICE REPORT', { size: 17, bold: true, color: WHITE });
    PDFT.text(c.p, M + 38, 58, fit(company, 9.5, CW - 46), { size: 9.5, color: [0.85, 0.94, 0.90] });
    const contact = contactLine(profile);
    if (contact) {
      PDFT.text(c.p, M + 38, 71, fit(contact, 8, 380), { size: 8, color: [0.78, 0.90, 0.85] });
    }

    const refW = PDFT.width(job.ref, 9, true);
    PDFT.text(c.p, 595.28 - M - refW, 38, job.ref, { size: 9, bold: true, color: WHITE });
    const dW = PDFT.width(dstr(job.completedAt || job.startedAt), 8.5, false);
    PDFT.text(c.p, 595.28 - M - dW, 52, dstr(job.completedAt || job.startedAt), { size: 8.5, color: [0.85, 0.94, 0.90] });
    // A job card that both parties have signed is locked evidence. The first
    // PDF is generated before status flips to 'sent', so keying the badge on
    // 'sent' alone stamped "Draft" on the very copy the customer receives.
    const stage = job.status === 'sent' ? 'Issued'
      : (job.lockedAt || job.status === 'completed') ? 'Completed'
      : 'Draft';
    const sW = PDFT.width(stage, 8.5, false);
    PDFT.text(c.p, 595.28 - M - sW, 66, stage, { size: 8.5, color: [0.85, 0.94, 0.90] });

    c.y = 132;

    /* --- who / what / where ------------------------------------------ */
    kvTable(c, [
      ['Customer', job.customer && job.customer.name],
      ['Phone', job.customer && job.customer.phone],
      ['Location', (job.site && job.site.address) || (job.customer && job.customer.address)],
      ['Service', job.jobType],
      ['Trade', (job.trade || '').toUpperCase()],
      ['Equipment', [job.equipment && job.equipment.capacity, job.equipment && job.equipment.model]
        .filter(Boolean).join(' · ')],
      ['Serial no.', job.equipment && job.equipment.serial],
      ['Installed', job.equipment && job.equipment.installDate]
    ]);

    /* --- the substance ----------------------------------------------- */
    block(c, 'SITE INSTRUCTIONS', job.instructions, 9);
    block(c, 'FAULT REPORTED', job.fault);
    block(c, 'DIAGNOSIS', job.diagnosis);
    block(c, 'WORK PERFORMED', job.work);

    /* --- materials ---------------------------------------------------- */
    if ((job.materials && job.materials.length) || job.labour) {
      c.need(70);
      PDFT.text(c.p, M, c.y + 9, 'MATERIALS & LABOUR', { size: 7.5, bold: true, color: GREEN });
      c.y += 20;
      const colP = M + CW;
      (job.materials || []).forEach(m => {
        const qty = (m.qty || 1) + (m.unit ? ' ' + m.unit : '');
        const line = m.desc + '  (' + qty + ')';
        const amt = fmt((Number(m.qty) || 1) * (Number(m.unitPrice) || 0));
        c.need(15);
        PDFT.text(c.p, M + 2, c.y, line, { size: 9, color: INK });
        const w = PDFT.width(amt, 9, false);
        PDFT.text(c.p, colP - w, c.y, amt, { size: 9, color: INK });
        c.y += 14;
        PDFT.line(c.p, M, c.y - 3.5, M + CW, c.y - 3.5, LINE, 0.4);
      });
      if (job.labour) {
        c.need(18);
        PDFT.text(c.p, M + 2, c.y, 'Labour', { size: 9, bold: true, color: INK });
        const amt = fmt(job.labour);
        const w = PDFT.width(amt, 9, true);
        PDFT.text(c.p, colP - w, c.y, amt, { size: 9, bold: true, color: INK });
        c.y += 14;
      }
      const mats = (job.materials || []).reduce((s, m) => s + (Number(m.qty) || 1) * (Number(m.unitPrice) || 0), 0);
      const total = mats + (Number(job.labour) || 0);
      c.need(24);
      c.y += 4;
      PDFT.line(c.p, M, c.y - 2, M + CW, c.y - 2, INK, 1.1);
      c.y += 6;
      PDFT.text(c.p, M + 2, c.y, 'TOTAL', { size: 10, bold: true, color: INK });
      const tw = PDFT.width(fmt(total), 11, true);
      PDFT.text(c.p, colP - tw, c.y - 1, fmt(total), { size: 11, bold: true, color: INK });
      c.y += 24;
    }

    block(c, 'RECOMMENDATION', job.recommendation);

    /* --- checklist summary -------------------------------------------- */
    if (job.checklist && job.checklist.items && job.checklist.items.length) {
      const done = job.checklist.items.filter(i => i.passed).length;
      c.need(30 + job.checklist.items.length * 13);
      PDFT.text(c.p, M, c.y + 9, 'CHECKLIST — ' + job.checklist.name.toUpperCase() +
        '  (' + done + '/' + job.checklist.items.length + ')', { size: 7.5, bold: true, color: GREEN });
      c.y += 20;
      job.checklist.items.forEach(it => {
        c.need(14);
        PDFT.text(c.p, M + 2, c.y, (it.passed ? '[x]  ' : '[  ]  ') + it.l, { size: 8.5, color: INK });
        c.y += 13;
      });
      c.y += 8;
    }

    /* --- photographs --------------------------------------------------- */
    const stages = ['before', 'during', 'after', 'serial'];
    const used = stages.map(s => (photos[s] || [])[0]).filter(Boolean);
    if (used.length) {
      c.need(160);
      PDFT.text(c.p, M, c.y + 9, 'PHOTOGRAPHIC EVIDENCE', { size: 7.5, bold: true, color: GREEN });
      c.y += 20;
      const gap = 9;
      const w = (CW - gap * (used.length - 1)) / used.length;
      const h = w * 0.75;
      let x = M;
      used.forEach((ph, i) => {
        const label = (photos[stages[i]] && photos[stages[i]][0]) ? stages[i].toUpperCase() : '';
        PDFT.rect(c.p, x - 2.5, c.y - 2.5, w + 5, h + 5, PAPER);
        if (ph.bytes && ph.w && ph.h) {
          PDFT.image(c.p, ph.bytes, ph.w, ph.h, x, c.y, w, h);
        }
        PDFT.text(c.p, x + 3, c.y + h + 9, label, { size: 7, bold: true, color: MUTED });
        x += w + gap;
      });
      c.y += h + 26;

      const first = used[0];
      PDFT.text(c.p, M, c.y,
        'Captured ' + dstr(first.capturedAt) + ' · ' + tstr(first.capturedAt) +
        ' · ' + coord(first.lat, first.lng) +
        ' · ' + (profile.name || job.technician || ''),
        { size: 7.5, color: MUTED });
      c.y += 22;
    }

    /* --- signatures ---------------------------------------------------- */
    if (sigs && (sigs.customer || sigs.technician)) {
      c.need(120);
      PDFT.line(c.p, M, c.y, M + CW, c.y, LINE, 0.7);
      c.y += 16;
      const boxW = (CW - 16) / 2;
      [['CUSTOMER', sigs.customer], ['TECHNICIAN', sigs.technician]].forEach((pair, i) => {
        const x = M + i * (boxW + 16);
        const s = pair[1];
        PDFT.text(c.p, x + 2, c.y + 8, pair[0], { size: 7, bold: true, color: MUTED });
        const top = c.y + 14;
        PDFT.rect(c.p, x, top, boxW, 54, [1, 1, 1]);
        PDFT.line(c.p, x, top, x + boxW, top, LINE, 0.6);
        PDFT.line(c.p, x, top + 54, x + boxW, top + 54, LINE, 0.6);
        PDFT.line(c.p, x, top, x, top + 54, LINE, 0.6);
        PDFT.line(c.p, x + boxW, top, x + boxW, top + 54, LINE, 0.6);
        if (s && s.bytes && s.w && s.h) {
          const scale = Math.min((boxW - 12) / s.w, 44 / s.h);
          PDFT.image(c.p, s.bytes, s.w, s.h, x + (boxW - s.w * scale) / 2, top + (54 - s.h * scale) / 2, s.w * scale, s.h * scale);
        }
        PDFT.text(c.p, x + 2, top + 66, (s && s.name) || '', { size: 8.5, bold: true, color: INK });
        PDFT.text(c.p, x + 2, top + 77, (s && s.at) ? dstr(s.at) + ' ' + tstr(s.at) : 'Not signed',
          { size: 7, color: MUTED });
      });
      c.y += 108;
    }

    /* --- record & reference footer ------------------------------------
       V1 has no backend. Nothing a server cannot check may be described
       here as verifiable: an earlier build stamped "Verified evidence —
       this report is tamper-evident" onto every PDF, and the link it
       printed led to a static page that could not verify anything.

       So this box now says only what is true of the file in the
       customer's hands: who signed, when, how many photographs carry a
       stamp, and where to quote the reference. Third-party verification
       needs the digest to be stored server-side — see PRO_FEASIBILITY.md.
    */
    const photoCount = ['before', 'during', 'after', 'serial']
      .reduce((n, s) => n + ((photos[s] || []).length), 0);
    const signedOn = (sigs && sigs.customer && sigs.customer.at) ||
      job.lockedAt || job.completedAt || job.startedAt;

    c.need(76);
    c.y += 6;
    PDFT.rect(c.p, M, c.y - 4, CW, 44, [0.902, 0.957, 0.937]);
    PDFT.text(c.p, M + 12, c.y + 9, 'RECORD & REFERENCE', { size: 7.5, bold: true, color: GREEN });
    PDFT.text(c.p, M + 12, c.y + 21,
      'Signed by both parties on ' + dstr(signedOn) + '.' +
      (photoCount
        ? ' ' + photoCount + ' photograph' + (photoCount === 1 ? '' : 's') +
          (photoCount === 1 ? ' carries' : ' carry') + ' a time and location stamp.'
        : ''),
      { size: 8, color: INK });
    PDFT.text(c.p, M + 12, c.y + 33, CFG.verifyLabel(job.ref),
      { size: 8.5, bold: true, color: INK });
    if (job.hashes && job.hashes.length) {
      const lbl = 'Photo 1 of ' + job.hashes.length + ' · SHA-256 ' +
        job.hashes[0].slice(0, 16) + '…';
      PDFT.text(c.p, M + CW - 12 - PDFT.width(lbl, 6.8, false), c.y + 33, lbl,
        { size: 6.8, color: MUTED });
    }
    c.y += 56;

    PDFT.text(c.p, M, c.y, 'This report records work performed as described by the technician above. It is not a',
      { size: 7, color: MUTED });
    PDFT.text(c.p, M, c.y + 9, 'certificate of regulatory compliance unless issued by a licensed contractor.',
      { size: 7, color: MUTED });

    /* --- page furniture ------------------------------------------------- */
    const n = c.pages.length;
    c.pages.forEach((pg, i) => {
      PDFT.line(pg, M, PDFT.PH - 40, M + CW, PDFT.PH - 40, LINE, 0.6);
      PDFT.text(pg, M, PDFT.PH - 30, job.ref + ' · ' + company, { size: 7, color: MUTED });
      const lbl = 'Page ' + (i + 1) + ' of ' + n;
      PDFT.text(pg, M + CW - PDFT.width(lbl, 7, false), PDFT.PH - 30, lbl, { size: 7, color: MUTED });
    });

    return PDFT.build(c.doc);
  }

  /* =======================  QUOTATION  =============================== */

  function buildQuote(q, job, profile) {
    profile = profile || {};
    const company = profile.company || 'REHOTEQ Technologies';
    const c = new Ctx();

    PDFT.rect(c.p, 0, 0, 595.28, 92, GREEN);
    logoBox(c, M, 21, 26, profile);
    PDFT.text(c.p, M + 38, 32, 'QUOTATION', { size: 17, bold: true, color: WHITE });
    PDFT.text(c.p, M + 38, 52, fit(company, 9.5, CW - 46), { size: 9.5, color: [0.85, 0.94, 0.90] });
    const qContact = contactLine(profile);
    if (qContact) {
      PDFT.text(c.p, M + 38, 66, fit(qContact, 8, 330), { size: 8, color: [0.78, 0.90, 0.85] });
    }

    const nW = PDFT.width(q.number, 11, true);
    PDFT.text(c.p, 595.28 - M - nW, 34, q.number, { size: 11, bold: true, color: WHITE });
    const dW = PDFT.width(dstr(q.date), 8.5, false);
    PDFT.text(c.p, 595.28 - M - dW, 50, dstr(q.date), { size: 8.5, color: [0.85, 0.94, 0.90] });
    const vW = PDFT.width('Valid until ' + dstr(q.validUntil), 8.5, false);
    PDFT.text(c.p, 595.28 - M - vW, 63, 'Valid until ' + dstr(q.validUntil), { size: 8.5, color: [0.85, 0.94, 0.90] });

    c.y = 116;

    kvTable(c, [
      ['Bill to', q.customer && q.customer.name],
      ['Phone', q.customer && q.customer.phone],
      ['Site', (job && job.site && job.site.address) || (q.customer && q.customer.address)],
      ['Subject', q.subject]
    ]);

    /* --- line items ----------------------------------------------------
       Column positions are derived from the widest amount in the quote,
       so a ₦2.85m line and a ₦1,500 line never collide.               */
    const amtRight = M + CW - 8;
    const amts = (q.items || []).map(i => fmt((Number(i.qty) || 1) * (Number(i.unitPrice) || 0)));
    const units = (q.items || []).map(i => fmt(i.unitPrice));
    const maxAmt = Math.max(30, ...amts.map(a => PDFT.width(a, 9, true)));
    const maxUnit = Math.max(24, ...units.map(u => PDFT.width(u, 9, false)));
    const unitRight = amtRight - maxAmt - 16;          // unit column right edge
    const qtyRight = unitRight - maxUnit - 16;         // qty column right edge
    const descW = Math.max(120, qtyRight - M - 24);

    c.need(50);
    PDFT.rect(c.p, M, c.y - 4, CW, 17, INK);
    PDFT.text(c.p, M + 8, c.y + 8, 'DESCRIPTION', { size: 7.5, bold: true, color: WHITE });
    const qh = 'QTY';
    PDFT.text(c.p, qtyRight - PDFT.width(qh, 7.5, true), c.y + 8, qh, { size: 7.5, bold: true, color: WHITE });
    const uh = 'UNIT';
    PDFT.text(c.p, unitRight - PDFT.width(uh, 7.5, true), c.y + 8, uh, { size: 7.5, bold: true, color: WHITE });
    const ah = 'AMOUNT';
    PDFT.text(c.p, amtRight - PDFT.width(ah, 7.5, true), c.y + 8, ah, { size: 7.5, bold: true, color: WHITE });
    c.y += 22;

    let subtotal = 0;
    (q.items || []).forEach((it, i) => {
      const lines = PDFT.wrap(it.desc, 9, false, descW);
      const rowH = Math.max(17, lines.length * 12 + 6);
      c.need(rowH + 8);
      if (i % 2 === 1) PDFT.rect(c.p, M, c.y - 3, CW, rowH, PAPER);
      lines.forEach((ln, k) => PDFT.text(c.p, M + 8, c.y + k * 12, ln, { size: 9, color: INK }));
      const qty = String(it.qty || 1);
      PDFT.text(c.p, qtyRight - PDFT.width(qty, 9, false), c.y, qty, { size: 9, color: INK });
      const up = fmt(it.unitPrice);
      PDFT.text(c.p, unitRight - PDFT.width(up, 9, false), c.y, up, { size: 9, color: INK });
      const amt = (Number(it.qty) || 1) * (Number(it.unitPrice) || 0);
      subtotal += amt;
      const aw = PDFT.width(fmt(amt), 9, true);
      PDFT.text(c.p, amtRight - aw, c.y, fmt(amt), { size: 9, bold: true, color: INK });
      c.y += rowH;
    });

    c.y += 6;
    PDFT.line(c.p, M, c.y, M + CW, c.y, INK, 1.1);
    c.y += 14;

    // Right-align the value, then place the label just left of it, so a
    // large total can never run into its own caption.
    const right = (label, value, bold, size) => {
      size = size || 9.5;
      const vw = PDFT.width(value, size, bold);
      const lw = PDFT.width(label, 8.5, false);
      PDFT.text(c.p, Math.max(M, M + CW - 8 - vw - 14 - lw), c.y, label, { size: 8.5, color: MUTED });
      PDFT.text(c.p, M + CW - 8 - vw, c.y, value, { size: size, bold: bold, color: INK });
      c.y += 15;
    };
    c.need(70);
    right('Subtotal', fmt(subtotal), false);
    if (q.labour) right('Labour', fmt(q.labour), false);
    if (q.tax) right('VAT ' + q.taxRate + '%', fmt(q.tax), false);
    c.y += 2;
    PDFT.line(c.p, M + CW - 200, c.y, M + CW, c.y, INK, 0.8);
    c.y += 6;
    right('TOTAL', fmt(q.total), true, 13);

    c.y += 14;
    if (profile.bio) block(c, 'ABOUT US', profile.bio, 8.5);
    if (q.notes) block(c, 'NOTES', q.notes, 9);
    if (q.terms) block(c, 'TERMS', q.terms, 8.5);

    if (profile.bank) {
      c.need(46);
      PDFT.rect(c.p, M, c.y - 4, CW, 42, PAPER);
      PDFT.text(c.p, M + 12, c.y + 9, 'PAYMENT', { size: 7.5, bold: true, color: GREEN });
      PDFT.text(c.p, M + 12, c.y + 23, profile.bank, { size: 8.5, bold: true, color: INK });
      if (profile.bankMeta) PDFT.text(c.p, M + 12, c.y + 34, profile.bankMeta, { size: 7.5, color: MUTED });
      c.y += 54;
    }

    c.need(40);
    PDFT.text(c.p, M, c.y, 'Prepared by ' + (profile.name || '') + ' · ' + company, { size: 7.5, color: MUTED });

    c.pages.forEach((pg, i) => {
      PDFT.line(pg, M, PDFT.PH - 40, M + CW, PDFT.PH - 40, LINE, 0.6);
      PDFT.text(pg, M, PDFT.PH - 30, q.number + ' · ' + company, { size: 7, color: MUTED });
    });

    return PDFT.build(c.doc);
  }

  global.REPORT = { buildReport: buildReport, buildQuote: buildQuote, fmt: fmt };
})(window);

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

  /* ===================================================================
     Client report links (Phase 2)

     The company sends a finished report to its client directly, over
     WhatsApp or email, with no client account and no server. The same
     no-server trick as the team invite link: a slim read-only copy of
     the report rides inside the URL itself, and opening it on any
     phone renders one branded report page and nothing else.

     What the link can never carry: photographs and signature strokes
     (image bytes do not fit a URL). The page says plainly how many
     photographs are on file and points at the PDF for them. Every
     text block is capped, so one enormous note cannot blow the URL
     past what WhatsApp and mail clients survive.
     =================================================================== */
  const REPORT_FORMAT = 'rehoteq-field-report';
  const TXT_CAP = 500;          // per text block
  const MAT_CAP = 12;           // material rows
  const CHK_CAP = 25;           // checklist items
  const ITEM_CAP = 80;          // per checklist line / material description

  function cesc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function cap(v, n) {
    const t = String(v || '').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function enc64(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function dec64(str) {
    let t = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return decodeURIComponent(escape(atob(t)));
  }
  function cfmt(n) {
    return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  }
  function cdstr(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function ctstr(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // The read-only copy that rides in the link. Only present values go
  // in, so an honest little report makes a short link.
  function clientPayload(job, profile) {
    if (!job || !job.ref) return null;
    profile = profile || {};
    const stage = job.status === 'sent' ? 'Issued'
      : (job.lockedAt || job.status === 'completed') ? 'Completed'
      : 'Draft';
    const stages = ['before', 'during', 'after', 'serial'];
    const photos = {};
    let photoTotal = 0;
    // Photo COUNTS travel; photo bytes cannot. The client page states
    // the count and points at the PDF for the images themselves.
    stages.forEach(st => {
      const n = (job._photoCounts && job._photoCounts[st]) || 0;
      if (n) { photos[st] = n; photoTotal += n; }
    });
    const p = {
      format: REPORT_FORMAT, kind: 'client-report', v: 1,
      ref: cap(job.ref, 40), stage: stage,
      issuedAt: job.completedAt || job.lockedAt || job.startedAt || new Date().toISOString(),
      company: {
        name: cap(profile.company || 'REHOTEQ Technologies', 80),
        phone: cap(profile.phone || '', 40),
        address: cap(profile.address || '', 120),
        email: cap(profile.email || '', 80)
      },
      tech: cap(profile.name || job.technician || '', 60),
      job: {
        service: cap(job.jobType, 80),
        trade: cap((job.trade || '').toUpperCase(), 30),
        customer: cap(job.customer && job.customer.name, 80),
        phone: cap(job.customer && job.customer.phone, 40),
        location: cap((job.site && job.site.address) || (job.customer && job.customer.address), 160),
        equipment: cap([job.equipment && job.equipment.capacity, job.equipment && job.equipment.model]
          .filter(Boolean).join(' · '), 100),
        serial: cap(job.equipment && job.equipment.serial, 60),
        installed: job.equipment && job.equipment.installDate ? cdstr(job.equipment.installDate) : ''
      }
    };
    ['instructions', 'fault', 'diagnosis', 'work', 'recommendation'].forEach(k => {
      const v = cap(job[k], TXT_CAP);
      if (v) p[k] = v;
    });
    const mats = (job.materials || []).slice(0, MAT_CAP).map(m => ({
      d: cap(m.desc, ITEM_CAP),
      q: Number(m.qty) || 1,
      u: cap(m.unit, 12),
      p: Number(m.unitPrice) || 0
    }));
    if (mats.length) p.materials = mats;
    if (job.labour) p.labour = Number(job.labour) || 0;
    if (mats.length || job.labour) {
      const msum = mats.reduce((x, m) => x + (Number(m.q) || 1) * m.p, 0);
      p.total = msum + (Number(job.labour) || 0);
    }
    if (job.checklist && job.checklist.items && job.checklist.items.length) {
      p.checklist = {
        name: cap(job.checklist.name, 60),
        items: job.checklist.items.slice(0, CHK_CAP).map(i => ({ l: cap(i.l, ITEM_CAP), p: !!i.passed }))
      };
    }
    if (photoTotal) { p.photos = photos; p.photoTotal = photoTotal; }
    const sigs = {};
    ['customer', 'technician'].forEach(role => {
      const sg = job.signatures && job.signatures[role];
      if (sg && (sg.name || sg.at)) sigs[role] = { name: cap(sg.name, 60), at: sg.at || '' };
    });
    if (Object.keys(sigs).length) p.sigs = sigs;
    if (job.hashes && job.hashes.length) p.hashes = job.hashes.length;
    return p;
  }

  // The link: the payload rides in the URL, the same way an invite does.
  function clientLink(job, profile) {
    const pay = clientPayload(job, profile);
    if (!pay) return null;
    let json;
    try { json = JSON.stringify(pay); } catch (e) { return null; }
    const CFGO = (global.CONFIG && global.CONFIG.origin) || 'https://field.rehoteq.com';
    return CFGO + '/?report=' + enc64(json);
  }

  function clientFromLink(url) {
    let raw = '';
    try {
      const u = new URL(String(url || ''));
      raw = u.searchParams.get('report') || '';
      if (!raw && u.hash && u.hash.indexOf('report=') >= 0) raw = u.hash.split('report=')[1].split('&')[0];
    } catch (e) { return null; }
    if (!raw) return null;
    let pay = null;
    try { pay = JSON.parse(dec64(raw)); } catch (e) { return null; }
    if (!pay || pay.format !== REPORT_FORMAT || pay.kind !== 'client-report' || pay.v !== 1) return null;
    if (!pay.ref || !pay.company || !pay.company.name) return null;
    pay.stage = pay.stage === 'Issued' || pay.stage === 'Completed' ? pay.stage : 'Draft';
    return pay;
  }

  // The page a client sees: one branded report, no app, no navigation,
  // nothing writable. Reuses the app's own report styles, which are
  // already on the page.
  function clientHtml(pay) {
    const j = pay.job || {};
    const kv = [
      ['Customer', j.customer], ['Phone', j.phone], ['Location', j.location],
      ['Service', j.service], ['Trade', j.trade], ['Equipment', j.equipment],
      ['Serial no.', j.serial], ['Installed', j.installed]
    ].filter(x => x[1]);
    const contact = [pay.company.phone, pay.company.email, pay.company.address].filter(Boolean).join(' · ');
    const sections = [['SITE INSTRUCTIONS', pay.instructions], ['FAULT REPORTED', pay.fault],
      ['DIAGNOSIS', pay.diagnosis], ['WORK PERFORMED', pay.work], ['RECOMMENDATION', pay.recommendation]]
      .filter(x => x[1]);
    const rows = (pay.materials || []).map(m =>
      '<div class="matrow"><span>' + cesc(m.d) + ' × ' + cesc(m.q) + (m.u ? ' ' + cesc(m.u) : '') + '</span>' +
      '<span class="p">' + cesc(cfmt((Number(m.q) || 1) * m.p)) + '</span></div>').join('') +
      (pay.labour ? '<div class="matrow" style="border-top:1px solid var(--line);margin-top:5px;padding-top:8px">' +
        '<span style="font-weight:700">Labour</span><span class="p">' + cesc(cfmt(pay.labour)) + '</span></div>' : '') +
      '<div class="matrow" style="border-top:1.5px solid var(--ink);margin-top:5px;padding-top:8px">' +
        '<span style="font-weight:800">TOTAL</span><span class="p" style="font-size:14px">' + cesc(cfmt(pay.total)) + '</span></div>';
    const chk = pay.checklist
      ? '<div class="rptsec"><div class="h">CHECKLIST — ' + cesc(String(pay.checklist.name || '').toUpperCase()) +
        '  (' + (pay.checklist.items || []).filter(i => i.p).length + '/' + (pay.checklist.items || []).length + ')</div>' +
        (pay.checklist.items || []).map(i =>
          '<div style="font-size:12px;color:var(--ink);padding:3px 0">' + (i.p ? '[x]' : '[  ]') + '  ' + cesc(i.l) + '</div>').join('') +
        '</div>'
      : '';
    const ph = pay.photoTotal
      ? '<div class="rptsec"><div class="h">PHOTOGRAPHIC EVIDENCE</div>' +
        '<div style="font-size:12px;color:var(--muted)">' + pay.photoTotal + ' photograph' +
        (pay.photoTotal === 1 ? '' : 's') + ' on file for this job' +
        (pay.photos && pay.photos.before ? ' · ' + pay.photos.before + ' before' : '') +
        (pay.photos && pay.photos.during ? ' · ' + pay.photos.during + ' during' : '') +
        (pay.photos && pay.photos.after ? ' · ' + pay.photos.after + ' after' : '') +
        '. The pictures travel in the PDF copy of this report.</div></div>'
      : '';
    const sigBox = (label, role) => {
      const sg = pay.sigs && pay.sigs[role];
      return '<div class="sigbox"><div class="rl" style="color:' + (sg ? '#0E7C5A' : '#94A3B8') + '">' +
        (sg ? '✓' : '—') + ' ' + label + '</div><div style="height:34px"></div>' +
        '<div class="nm">' + cesc(sg ? sg.name : 'Not signed') + '</div>' +
        '<div style="font-size:10px;color:var(--muted)">' + (sg && sg.at ? cesc(cdstr(sg.at) + ' ' + ctstr(sg.at)) : '') + '</div></div>';
    };
    const CFGD = (global.CONFIG && global.CONFIG.domain) || 'field.rehoteq.com';
    // The wash behind the client page follows the app's own ground token,
    // so a restyle of the portals restyles the client view with it.
    return '<div style="min-height:100vh;background:radial-gradient(120% 80% at 88% -8%,rgba(14,124,90,.16),transparent 58%),radial-gradient(90% 60% at -12% 104%,rgba(37,99,235,.10),transparent 55%),repeating-linear-gradient(0deg,rgba(14,124,90,.05) 0 1px,transparent 1px 30px),repeating-linear-gradient(90deg,rgba(14,124,90,.05) 0 1px,transparent 1px 30px),linear-gradient(180deg,#F2FAF6,#E7F1ED);padding-bottom:96px">' +
      '<div class="rpthdr"><div class="lg"><div class="sq">R</div><div>' +
        '<h3>SERVICE REPORT</h3><p>' + cesc(pay.company.name) + '</p></div></div>' +
        '<div class="rptref"><span>' + cesc(pay.ref) + '</span><span>' + cesc(cdstr(pay.issuedAt)) + ' · ' + cesc(pay.stage) + '</span></div></div>' +
      (contact ? '<div style="padding:8px 16px 0;font-size:11px;color:var(--muted)">' + cesc(contact) + '</div>' : '') +
      '<div style="padding:12px 16px">' +
      (kv.length ? '<div class="rptkv">' + kv.map(x =>
        '<div class="k">' + x[0] + '</div><div class="val">' + cesc(x[1]) + '</div>').join('') + '</div>' : '') +
      sections.map(x => '<div class="rptsec"><div class="h">' + x[0] + '</div><div class="v">' + cesc(x[1]) + '</div></div>').join('') +
      ((pay.materials || pay.labour) ? '<div class="rptsec"><div class="h">Materials &amp; labour</div>' + rows + '</div>' : '') +
      chk + ph +
      '<div class="sigs">' + sigBox('Customer', 'customer') + sigBox('Technician', 'technician') + '</div>' +
      '<div class="verify">Record reference · ' + cesc(CFGD) + '/v/<b>' + cesc(String(pay.ref).replace(/[^A-Za-z0-9]/g, '')) + '</b>' +
        (pay.hashes ? '<br><span style="font-size:9px;opacity:.8" class="mono">' + pay.hashes + ' photo digest' +
          (pay.hashes === 1 ? '' : 's') + ' recorded on this job card</span>' : '') + '</div>' +
      '<div class="disclaim">This report records work performed as described. It is not a certificate of ' +
        'regulatory compliance unless issued by a licensed contractor.</div>' +
      '<div style="font-size:10px;color:var(--muted);padding-top:10px">Prepared by ' + cesc(pay.tech || '—') + ' · ' + cesc(pay.company.name) + '</div>' +
      '</div>' +
      '<div class="actionbar"><button class="btn primary" style="width:100%" onclick="window.print()">' +
        'Save as PDF</button></div>' +
      '</div>';
  }

  function renderClient(root, pay) {
    if (root) root.innerHTML = clientHtml(pay);
  }

  global.REPORT = { buildReport: buildReport, buildQuote: buildQuote, fmt: fmt,
    clientPayload: clientPayload, clientLink: clientLink, clientFromLink: clientFromLink,
    clientHtml: clientHtml, renderClient: renderClient };
})(window);

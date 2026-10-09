/* =====================================================================
   pdf.js — minimal, zero-dependency PDF writer for REHOTEQ Field
   A4 · Helvetica / Helvetica-Bold (standard 14, no embedding needed)
   JPEG images embedded raw via DCTDecode

   Why no library: the app must work offline, on cheap Android, with no
   CDN. A PDF is mostly text and a couple of JPEGs — we don't need 400 KB
   of jsPDF to produce one.
   ===================================================================== */
(function (global) {
  'use strict';

  const PW = 595.28, PH = 841.89;   // A4 portrait in points

  // Adobe Helvetica AFM widths (per 1000 units)
  const W_REG = {
    ' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,"'":191,'(':333,')':333,'*':389,'+':584,
    ',':278,'-':333,'.':278,'/':278,'0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,
    '8':556,'9':556,':':278,';':278,'<':584,'=':584,'>':584,'?':556,'@':1015,
    'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':500,'K':667,'L':556,
    'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,
    'Y':667,'Z':611,'[':278,'\\':278,']':278,'^':469,'_':556,'`':333,
    'a':556,'b':556,'c':500,'d':556,'e':556,'f':278,'g':556,'h':556,'i':222,'j':222,'k':500,'l':222,
    'm':833,'n':556,'o':556,'p':556,'q':556,'r':333,'s':500,'t':278,'u':556,'v':500,'w':722,'x':500,
    'y':500,'z':500,'{':334,'|':260,'}':334,'~':584
  };
  const W_BOLD = {
    ' ':278,'!':333,'"':474,'#':556,'$':556,'%':889,'&':722,"'":238,'(':333,')':333,'*':389,'+':584,
    ',':278,'-':333,'.':278,'/':278,'0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,
    '8':556,'9':556,':':333,';':333,'<':584,'=':584,'>':584,'?':611,'@':975,
    'A':722,'B':722,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':556,'K':722,'L':611,
    'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,
    'Y':667,'Z':611,'[':333,'\\':278,']':333,'^':584,'_':556,'`':333,
    'a':556,'b':611,'c':556,'d':611,'e':556,'f':333,'g':611,'h':611,'i':278,'j':278,'k':556,'l':278,
    'm':889,'n':611,'o':611,'p':611,'q':611,'r':389,'s':556,'t':333,'u':611,'v':556,'w':778,'x':556,
    'y':556,'z':500,'{':389,'|':280,'}':389,'~':584
  };

  /* --- text helpers ------------------------------------------------- */

  // Widths for the handful of Latin-1 glyphs we actually emit.
  const W_EXTRA = { '°': 400, '²': 350, '³': 350, '·': 278, '×': 584, 'µ': 556, '½': 556 };

  // The standard-14 fonts use WinAnsiEncoding, so printable ASCII plus the
  // Latin-1 supplement (0xA0–0xFF) are all renderable. Anything outside
  // that is transliterated or dropped. ₦ is absent from WinAnsi, so Naira
  // amounts are written "NGN 25,000.00" — embed a TTF if we ever need the
  // real glyph.
  function sanitize(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/₦/g, 'NGN ')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/[✓✔✅]/g, '-')
      .replace(/⚠/g, '!')
      .replace(/•/g, '-')
      .replace(/[ΩΩ]/g, 'ohm')
      .replace(/µ/g, 'µ')
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
  }
  // Escape to a PDF literal string. Everything outside printable ASCII
  // becomes a 3-digit octal escape, so the whole content stream stays
  // single-byte and the xref offsets stay honest.
  function esc(s) {
    const t = sanitize(s);
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c === 0x28 || c === 0x29 || c === 0x5C) out += '\\' + t[i];
      else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
      else out += t[i];
    }
    return out;
  }
  function width(s, size, bold) {
    const t = bold ? W_BOLD : W_REG;
    let w = 0;
    const str = sanitize(s);
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (W_EXTRA[c] !== undefined) w += W_EXTRA[c];
      else w += (t[c] !== undefined ? t[c] : 556);
    }
    return (w / 1000) * size;
  }
  function wrap(s, size, bold, maxW) {
    const words = sanitize(s).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (width(test, size, bold) > maxW && line) { lines.push(line); line = word; }
      else { line = test; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  /* --- document ----------------------------------------------------- */

  class PDF {
    constructor() { this.pages = []; }
    page() {
      const p = { ops: [], imgs: [] };
      this.pages.push(p);
      return p;
    }
  }

  /* --- drawing ops (top-down y coordinates, like the web) ------------ */

  function text(p, x, topY, str, o) {
    o = o || {};
    const size = o.size || 10;
    const bold = !!o.bold;
    const c = o.color || [0, 0, 0];
    const y = PH - topY;
    p.ops.push(
      'BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' +
      c[0].toFixed(3) + ' ' + c[1].toFixed(3) + ' ' + c[2].toFixed(3) + ' rg ' +
      '1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + esc(str) + ') Tj ET'
    );
  }

  // colours are [r,g,b] in 0..1
  function rect(p, x, topY, w, h, color) {
    const c = color || [0, 0, 0];
    const y = PH - topY - h;
    p.ops.push(
      c[0].toFixed(3) + ' ' + c[1].toFixed(3) + ' ' + c[2].toFixed(3) + ' rg ' +
      x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re f'
    );
  }

  function line(p, x1, topY1, x2, topY2, color, w) {
    const c = color || [0.8, 0.82, 0.85];
    p.ops.push(
      (w || 0.6).toFixed(2) + ' w ' +
      c[0].toFixed(3) + ' ' + c[1].toFixed(3) + ' ' + c[2].toFixed(3) + ' RG ' +
      x1.toFixed(2) + ' ' + (PH - topY1).toFixed(2) + ' m ' +
      x2.toFixed(2) + ' ' + (PH - topY2).toFixed(2) + ' l S'
    );
  }

  function image(p, jpegBytes, pxW, pxH, x, topY, drawW, drawH) {
    const name = 'Im' + (p.imgs.length + 1);
    p.imgs.push({ name: name, bytes: jpegBytes, w: pxW, h: pxH });
    const y = PH - topY - drawH;
    p.ops.push(
      'q ' + drawW.toFixed(2) + ' 0 0 ' + drawH.toFixed(2) + ' ' +
      x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /' + name + ' Do Q'
    );
  }

  /* --- serialisation ------------------------------------------------- */

  function build(doc) {
    const enc = new TextEncoder();
    const nPages = doc.pages.length;

    const CAT = 1, PAGES = 2, F1 = 3, F2 = 4;
    let nextId = 5;
    const pageIds = doc.pages.map(() => ({ page: nextId++, content: nextId++ }));
    doc.pages.forEach(p => p.imgs.forEach(im => { im.id = nextId++; }));

    const bodies = new Array(nextId - 1);
    bodies[CAT - 1] = '<< /Type /Catalog /Pages ' + PAGES + ' 0 R >>';
    bodies[PAGES - 1] = '<< /Type /Pages /Kids [' +
      pageIds.map(o => o.page + ' 0 R').join(' ') + '] /Count ' + nPages + ' >>';
    bodies[F1 - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    bodies[F2 - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    doc.pages.forEach((p, i) => {
      let res = '<< /Font << /F1 ' + F1 + ' 0 R /F2 ' + F2 + ' 0 R >>';
      if (p.imgs.length) {
        res += ' /XObject << ' + p.imgs.map(im => '/' + im.name + ' ' + im.id + ' 0 R').join(' ') + ' >>';
      }
      res += ' >>';
      bodies[pageIds[i].page - 1] =
        '<< /Type /Page /Parent ' + PAGES + ' 0 R /MediaBox [0 0 ' +
        PW.toFixed(2) + ' ' + PH.toFixed(2) + '] /Resources ' + res +
        ' /Contents ' + pageIds[i].content + ' 0 R >>';

      const stream = p.ops.join('\n');
      bodies[pageIds[i].content - 1] = {
        head: '<< /Length ' + enc.encode(stream).length + ' >>\nstream\n',
        body: stream,
        tail: '\nendstream'
      };

      p.imgs.forEach(im => {
        bodies[im.id - 1] = {
          head: '<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h +
                ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
                im.bytes.length + ' >>\nstream\n',
          bin: im.bytes,
          tail: '\nendstream'
        };
      });
    });

    const chunks = [];
    let off = 0;
    function push(bytes) { chunks.push(bytes); off += bytes.length; }

    push(enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const offsets = new Array(bodies.length);

    for (let i = 0; i < bodies.length; i++) {
      offsets[i] = off;
      const b = bodies[i];
      push(enc.encode((i + 1) + ' 0 obj\n'));
      if (typeof b === 'string') {
        push(enc.encode(b + '\nendobj\n'));
      } else {
        push(enc.encode(b.head));
        if (b.body) push(enc.encode(b.body));
        if (b.bin) push(b.bin);
        push(enc.encode(b.tail + '\nendobj\n'));
      }
    }

    const xrefOff = off;
    let xref = 'xref\n0 ' + (bodies.length + 1) + '\n0000000000 65535 f \n';
    for (let i = 0; i < bodies.length; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    push(enc.encode(xref));
    push(enc.encode('trailer\n<< /Size ' + (bodies.length + 1) + ' /Root ' + CAT +
                    ' 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n'));

    // concat
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  global.PDFT = {
    PDF: PDF, build: build, text: text, rect: rect, line: line, image: image,
    width: width, wrap: wrap, sanitize: sanitize, PW: PW, PH: PH
  };
})(window);

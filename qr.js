/* =====================================================================
   qr.js — QR Code encoder, byte mode, error correction level M
   Supports versions 1–6 (up to ~134 bytes) which is far more than a
   verification URL needs. No dependencies, so the passport screen works
   offline and the sticker prints from any device.
   ===================================================================== */
(function (global) {
  'use strict';

  const MODE_BYTE = 4;
  const ECL_M = 0;            // format bits: M = 00

  // version -> { totalCodewords, ecPerBlock, blocks: [dataCodewords,...] }
  const SPEC = {
    1:  { total: 26,  ec: 10, blocks: [16] },
    2:  { total: 44,  ec: 16, blocks: [28] },
    3:  { total: 70,  ec: 26, blocks: [44] },
    4:  { total: 100, ec: 18, blocks: [32, 32] },
    5:  { total: 134, ec: 24, blocks: [43, 43] },
    6:  { total: 172, ec: 16, blocks: [27, 27, 27, 27] }
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]
  };

  /* --- GF(256) arithmetic ------------------------------------------- */
  const EXP = new Array(256), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  })();
  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }
  // Generator polynomial G(x) = PROD (x + a^i), i = 0..degree-1.
  // Built lowest-power-first, then reversed and returned HIGHEST-first
  // with the leading 1 dropped — the order rsRemainder expects:
  //   [g(n-1), g(n-2), ..., g(0)]
  function rsDivisor(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const r = EXP[i];
      const next = new Array(poly.length + 1).fill(0);
      for (let k = 0; k < poly.length; k++) {
        next[k + 1] ^= poly[k];          // multiply by x
        next[k] ^= mul(poly[k], r);      // multiply by a^i
      }
      poly = next;
    }
    return poly.reverse().slice(1);      // drop the leading 1
  }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ result.shift();
      result.push(0);
      for (let i = 0; i < divisor.length; i++) result[i] ^= mul(divisor[i], factor);
    }
    return result;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  /* --- bit stream ---------------------------------------------------- */
  function makeBitBuffer(bytes, version) {
    const bits = [];
    function append(val, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    append(MODE_BYTE, 4);
    append(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) append(b, 8);

    const spec = SPEC[version];
    const dataCapacityBits = (spec.total - spec.ec) * 8;   // approx; ec*blocks computed below
    const ecTotal = spec.ec * spec.blocks.length;
    const capacityBits = (spec.total - ecTotal) * 8;

    // terminator
    const term = Math.min(4, capacityBits - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    // pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);
    // pad codewords
    const pads = [0xEC, 0x11];
    let pi = 0;
    while (bits.length < capacityBits) { append(pads[pi % 2], 8); pi++; }

    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    return out;
  }

  function addEcc(data, version) {
    const spec = SPEC[version];
    const blocks = spec.blocks.slice();
    // split into blocks
    const dataBlocks = [];
    let at = 0;
    for (const size of blocks) { dataBlocks.push(data.slice(at, at + size)); at += size; }
    const divisor = rsDivisor(spec.ec);
    const ecBlocks = dataBlocks.map(b => rsRemainder(b, divisor));

    // interleave
    const maxData = Math.max.apply(null, blocks);
    const out = [];
    for (let i = 0; i < maxData; i++)
      for (let b = 0; b < dataBlocks.length; b++)
        if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    for (let i = 0; i < spec.ec; i++)
      for (let b = 0; b < ecBlocks.length; b++)
        out.push(ecBlocks[b][i]);
    return out;
  }

  /* --- matrix -------------------------------------------------------- */
  function encode(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
      else { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }

    let version = 0;
    for (let v = 1; v <= 6; v++) {
      const spec = SPEC[v];
      const capacity = spec.total - spec.ec * spec.blocks.length;
      if (bytes.length <= capacity - (v < 10 ? 2 : 3)) { version = v; break; }
    }
    if (!version) return null;

    const data = addEcc(makeBitBuffer(bytes, version), version);
    const size = version * 4 + 17;
    const mods = [];
    const isFn = [];
    for (let y = 0; y < size; y++) { mods.push(new Array(size).fill(false)); isFn.push(new Array(size).fill(false)); }

    function setFn(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      mods[y][x] = dark; isFn[y][x] = true;
    }

    // timing
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    // finders
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    });
    // alignment
    const ap = ALIGN[version];
    for (const x of ap) for (const y of ap) {
      if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    // Temporary format bits (mask 0) — this also marks every format
    // position as a function module. Redrawn after the mask is chosen.
    drawFormat(0);

    function drawFormat(mask) {
      const d = (ECL_M << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
      setFn(8, 7, getBit(bits, 6));
      setFn(8, 8, getBit(bits, 7));
      setFn(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
      setFn(8, size - 8, true);
    }

    // data placement
    let i = 0;
    const totalBits = data.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < totalBits) {
            mods[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    // choose the best of the 8 masks
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const s = penalty();
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m); // undo
    }
    applyMask(best); drawFormat(best);

    function maskBit(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      }
      return false;
    }
    function applyMask(mask) {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
        if (!isFn[y][x] && maskBit(mask, x, y)) mods[y][x] = !mods[y][x];
    }

    function fh(run, hist) {
      if (hist[0] === 0) run += size;
      hist.pop(); hist.unshift(run);
    }
    function fCount(hist) {
      const n = hist[1];
      const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) +
             (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
    }
    function fTerm(runColor, run, hist) {
      if (runColor) { fh(run, hist); run = 0; }
      run += size; fh(run, hist);
      return fCount(hist);
    }
    function penalty() {
      let result = 0;
      for (let y = 0; y < size; y++) {
        let runColor = false, runX = 0; let hist = [0, 0, 0, 0, 0, 0, 0];
        for (let x = 0; x < size; x++) {
          if (mods[y][x] === runColor) { runX++; if (runX === 5) result += 3; else if (runX > 5) result++; }
          else { fh(runX, hist); if (!runColor) result += fCount(hist) * 40; runColor = mods[y][x]; runX = 1; }
        }
        result += fTerm(runColor, runX, hist) * 40;
      }
      for (let x = 0; x < size; x++) {
        let runColor = false, runY = 0; let hist = [0, 0, 0, 0, 0, 0, 0];
        for (let y = 0; y < size; y++) {
          if (mods[y][x] === runColor) { runY++; if (runY === 5) result += 3; else if (runY > 5) result++; }
          else { fh(runY, hist); if (!runColor) result += fCount(hist) * 40; runColor = mods[y][x]; runY = 1; }
        }
        result += fTerm(runColor, runY, hist) * 40;
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = mods[y][x];
        if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) result += 3;
      }
      let dark = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mods[y][x]) dark++;
      const total = size * size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      result += k * 10;
      return result;
    }

    return { size: size, modules: mods, version: version, mask: best, text: text };
  }

  /* --- renderers ----------------------------------------------------- */
  function toSvg(qr, margin, scale) {
    margin = margin === undefined ? 4 : margin;
    scale = scale === undefined ? 8 : scale;
    const dim = (qr.size + margin * 2) * scale;
    let r = '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
            '" viewBox="0 0 ' + (qr.size + margin * 2) + ' ' + (qr.size + margin * 2) +
            '" shape-rendering="crispEdges" style="display:block">' +
            '<rect width="100%" height="100%" fill="#ffffff"/>';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) {
        r += '<rect x="' + (x + margin) + '" y="' + (y + margin) + '" width="1" height="1" fill="#0F172A"/>';
      }
    }
    return r + '</svg>';
  }

  function drawToCanvas(canvas, qr, margin) {
    margin = margin === undefined ? 4 : margin;
    const dim = qr.size + margin * 2;
    canvas.width = dim * 6; canvas.height = dim * 6;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0F172A';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect((x + margin) * 6, (y + margin) * 6, 6, 6);
    }
    return canvas;
  }

  global.QR = { encode: encode, toSvg: toSvg, drawToCanvas: drawToCanvas,
    _internals: { makeBitBuffer: makeBitBuffer, addEcc: addEcc, SPEC: SPEC, rsDivisor: rsDivisor, rsRemainder: rsRemainder, mul: mul, EXP: EXP } };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.QR;
})(typeof window !== 'undefined' ? window : globalThis);

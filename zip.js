/* =====================================================================
   zip.js — a zip reader and writer with no dependency at all.

   Why this file exists: a cloud backup has to carry the photos, and the
   JSON backup could only do that by base64-ing every image — a third
   bigger, all of it held in memory as one string. On a phone with 300
   job photos that is the difference between a backup and a crash.

   A zip is the format every phone, laptop and operating system can open,
   so the same file is useful in three places: uploaded to the cloud,
   saved to Downloads, or handed to a customer's Windows PC.

   What is supported:
     • write: stored (uncompressed) entries — JPEGs are already compressed,
       so deflating them again costs battery and saves almost nothing
     • read: stored AND deflated entries, so a zip made by any other tool
       (a laptop's right-click → Compress, python's zipfile) still opens
     • CRC-32 on both sides: every entry is checksummed on write and
       verified on read, and a mismatch is reported rather than served

   Not supported, on purpose: zip64 (archives over 4 GB), encryption and
   multi-disk archives. The cloud backup caps at 500 MB by rule, so a
   zip64 writer would be code no one ever runs.

   Verified against Python's `zipfile` module: archives written here are
   read by python3, and archives written by python3 are read here. Both
   directions are checked by the test suite.
   ===================================================================== */
(function (global) {
  'use strict';

  const SIG_LOCAL = 0x04034b50;   // "PK\3\4"  — a local file header
  const SIG_CENTRAL = 0x02014b50; // "PK\1\2"  — a central directory entry
  const SIG_EOCD = 0x06054b50;    // "PK\5\6"  — end of central directory

  const U32 = 0xFFFFFFFF;
  const MAX16 = 0xFFFF;

  /* ---- CRC-32 (the check byte every zip carries) --------------------- */

  let TABLE = null;
  function table() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      TABLE[n] = c >>> 0;
    }
    return TABLE;
  }

  // bytes: Uint8Array. Returns an unsigned 32-bit number.
  function crc32(bytes, seed) {
    const t = table();
    let c = ((seed === undefined ? 0 : seed) >>> 0) ^ U32;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ U32) >>> 0;
  }

  /* ---- bytes in, bytes out ------------------------------------------ */

  function fromText(str) {
    return new TextEncoder().encode(String(str));
  }
  function toText(bytes) {
    return new TextDecoder().decode(bytes);
  }
  // Anything reasonable becomes a Uint8Array: string, Blob, ArrayBuffer
  // or a typed-array view over either.
  async function asBytes(input) {
    if (input === null || input === undefined) throw new Error('nothing to read');
    if (typeof input === 'string') return fromText(input);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      return new Uint8Array(await input.arrayBuffer());
    }
    if (typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
    throw new Error('cannot read that as bytes');
  }

  function bytesOf(data) {
    if (data === null || data === undefined) return new Uint8Array(0);
    if (typeof data === 'string') return fromText(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return fromText(String(data));
  }

  function concat(list) {
    let n = 0;
    list.forEach(p => { n += p.length; });
    const out = new Uint8Array(n);
    let at = 0;
    list.forEach(p => { out.set(p, at); at += p.length; });
    return out;
  }

  /* ---- DOS time -----------------------------------------------------
     A zip stores the timestamp the way MS-DOS did in 1980: two packed
     sixteenth-bit words, seconds rounded to the nearest two. It is the
     format's one piece of archaeology, and the reason every unzipped
     file shows a time that is a little bit off.                              */

  function dosStamp(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function dosToDate(time, date) {
    try {
      return new Date(1980 + ((date >> 9) & 0x7F), ((date >> 5) & 0x0F) - 1, date & 0x1F,
        (time >> 11) & 0x1F, (time >> 5) & 0x3F, (time & 0x1F) << 1);
    } catch (e) { return null; }
  }

  /* ---- write --------------------------------------------------------
     entries: [{ name: 'photos/AB12.jpg', data: Uint8Array|string, date? }]
     Returns the archive as a Uint8Array.                                     */

  function build(entries, opts) {
    opts = opts || {};
    const list = (entries || []).filter(e => e && e.name !== undefined && e.name !== null);
    if (list.length > MAX16) throw new Error('this zip writer tops out at 65535 files');
    const when = opts.date instanceof Date ? opts.date : new Date();

    const parts = [];
    const central = [];
    let offset = 0;

    list.forEach(e => {
      const name = fromText(e.name);
      const data = bytesOf(e.data);
      if (data.length > U32) throw new Error('entry too big for this zip writer: ' + e.name);
      const crc = crc32(data);
      const stamp = dosStamp(e.date instanceof Date ? e.date : when);

      const head = new Uint8Array(30 + name.length);
      const hv = new DataView(head.buffer);
      hv.setUint32(0, SIG_LOCAL, true);
      hv.setUint16(4, 20, true);       // version needed to extract (2.0)
      hv.setUint16(6, 0x0800, true);   // names are UTF-8
      hv.setUint16(8, 0, true);        // method 0 = stored
      hv.setUint16(10, stamp.time, true);
      hv.setUint16(12, stamp.date, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, data.length, true);
      hv.setUint32(22, data.length, true);
      hv.setUint16(26, name.length, true);
      hv.setUint16(28, 0, true);       // no extra field
      head.set(name, 30);

      const dir = new Uint8Array(46 + name.length);
      const dv = new DataView(dir.buffer);
      dv.setUint32(0, SIG_CENTRAL, true);
      dv.setUint16(4, 20, true);       // version made by
      dv.setUint16(6, 20, true);       // version needed
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);       // stored
      dv.setUint16(12, stamp.time, true);
      dv.setUint16(14, stamp.date, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, data.length, true);
      dv.setUint32(24, data.length, true);
      dv.setUint16(28, name.length, true);
      dv.setUint16(30, 0, true);       // extra
      dv.setUint16(32, 0, true);       // comment
      dv.setUint16(34, 0, true);       // disk number
      dv.setUint16(36, 0, true);       // internal attributes
      dv.setUint32(38, 0, true);       // external attributes
      dv.setUint32(42, offset, true);  // where the local header starts
      dir.set(name, 46);

      parts.push(head, data);
      central.push(dir);
      offset += head.length + data.length;
    });

    const cdSize = central.reduce((n, c) => n + c.length, 0);
    if (offset > U32 || cdSize > U32) throw new Error('archive too big for this zip writer');

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);          // this disk
    ev.setUint16(6, 0, true);          // disk with the directory
    ev.setUint16(8, list.length, true);
    ev.setUint16(10, list.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);    // where the directory starts
    ev.setUint16(20, 0, true);         // no comment

    return concat(parts.concat(central, [eocd]));
  }

  /* ---- read ---------------------------------------------------------
     Input: Uint8Array, ArrayBuffer, Blob or File.
     Returns: [{ name, data, size, method, crc, crcOk, date }]
     Throws on structural damage. A single entry whose checksum does not
     match comes back with crcOk:false rather than throwing, so a restore
     can report the one bad photo instead of losing the whole backup.       */

  async function read(input) {
    const bytes = await asBytes(input);
    if (bytes.length < 22) throw new Error('not a zip file (too short)');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const eocd = findEOCD(view, bytes.length);
    if (eocd < 0) throw new Error('not a zip file (no end-of-directory record)');

    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOff = view.getUint32(eocd + 16, true);
    if (count === MAX16 || cdOff === U32 || cdSize === U32) {
      throw new Error('zip64 archives are not supported');
    }
    if (cdOff + cdSize > bytes.length) throw new Error('damaged zip (directory runs past the end)');

    const out = [];
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('damaged zip directory');
      }
      const method = view.getUint16(p + 10, true);
      const time = view.getUint16(p + 12, true);
      const date = view.getUint16(p + 14, true);
      const crc = view.getUint32(p + 16, true);
      const compSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const name = toText(bytes.subarray(p + 46, p + 46 + nameLen));

      if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== SIG_LOCAL) {
        throw new Error('damaged zip entry: ' + name);
      }
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (dataOff + compSize > bytes.length) throw new Error('truncated zip entry: ' + name);

      const raw = bytes.subarray(dataOff, dataOff + compSize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('unsupported compression (method ' + method + ') in ' + name);

      out.push({
        name: name,
        data: data,
        size: size,
        method: method,
        crc: crc,
        crcOk: crc32(data) === crc,
        date: dosToDate(time, date)
      });

      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  // The end record sits at the end, after an optional archive comment of
  // up to 64 KB, so the only way to find it is to scan backwards.
  function findEOCD(view, len) {
    const floor = Math.max(0, len - (MAX16 + 22));
    for (let p = len - 22; p >= floor; p--) {
      if (view.getUint32(p, true) === SIG_EOCD) {
        const commentLen = view.getUint16(p + 20, true);
        if (p + 22 + commentLen <= len) return p;
      }
    }
    return -1;
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('this browser cannot open compressed zip entries'));
    }
    // 'deflate-raw' is the raw DEFLATE stream a zip entry carries — no
    // zlib wrapper, no gzip header. Every browser that can install this
    // app has it (Chrome 80+, and the store build wraps Chrome).
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(b => new Uint8Array(b));
  }

  /* ---- a quick sniff, so a picked file can be routed by its bytes
     rather than by its name -------------------------------------------- */

  function isZip(input) {
    const bytes = bytesOf(input);
    if (bytes.length < 4) return false;
    const sig = (bytes[0]) | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    return (sig >>> 0) === SIG_LOCAL || (sig >>> 0) === SIG_EOCD;
  }

  global.ZIP = {
    crc32: crc32,
    build: build,
    read: read,
    isZip: isZip,
    fromText: fromText,
    toText: toText,
    bytes: bytesOf
  };
})(typeof window !== 'undefined' ? window : globalThis);

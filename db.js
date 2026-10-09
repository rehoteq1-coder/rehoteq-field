/* =====================================================================
   db.js — local-first storage for REHOTEQ Field

   IndexedDB today; Supabase tomorrow. Every function here is the seam
   where the swap happens: when you're ready, keep these signatures and
   replace the bodies with Supabase calls. Nothing else in the app
   touches storage directly.

   Stores:
     jobs       — job cards (the record of work)
     photos     — JPEG blobs, keyed separately so job docs stay small
     customers  — people
     equipment  — first-class: serial numbers, install date, warranty
     meta       — user profile, counters, settings (keyPath 'id')
     outbox     — pending sync operations (Supabase upload queue)
   ===================================================================== */
(function (global) {
  'use strict';

  const DB_NAME = 'rehoteq-field';
  const DB_VER = 1;
  const STORES = ['jobs', 'photos', 'customers', 'equipment', 'meta', 'outbox'];

  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        STORES.forEach(s => {
          if (!db.objectStoreNames.contains(s)) {
            db.createObjectStore(s, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
    return dbp;
  }

  function tx(store, mode) {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const DB = {
    put: (store, value) => tx(store, 'readwrite').then(s => wrap(s.put(value))),
    get: (store, id) => tx(store, 'readonly').then(s => wrap(s.get(id))),
    all: store => tx(store, 'readonly').then(s => wrap(s.getAll())),
    del: (store, id) => tx(store, 'readwrite').then(s => wrap(s.delete(id))),

    /* --- meta: simple key/value on top of the meta store --- */
    getMeta: key => DB.get('meta', key).then(r => (r ? r.value : null)),
    setMeta: (key, value) => DB.put('meta', { id: key, value: value }),

    /* --- outbox: the offline sync queue -------------------------------
       Every write also lands here. When a connection exists, the sync
       runner drains it to Supabase. Today it just records intent so the
       behaviour is right from day one.                                */
    queue: op => DB.put('outbox', {
      id: (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      op: op, at: new Date().toISOString(), synced: false
    }),
    pending: () => DB.all('outbox').then(r => r.filter(x => !x.synced))
  };

  /* --- utilities ---------------------------------------------------- */

  async function sha256(blobOrBuffer) {
    const buf = blobOrBuffer instanceof Blob
      ? await blobOrBuffer.arrayBuffer()
      : blobOrBuffer;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function uid() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
  }

  /* --- image pipeline ------------------------------------------------
     Compress to <= maxKB, then burn the provenance stamp INTO THE
     PIXELS. Metadata beside an image is not evidence; a stamp on the
     image survives being screenshotted, shared and re-shared.
     ---------------------------------------------------------------- */
  async function processPhoto(file, stamp, maxKB) {
    maxKB = maxKB || 350;
    const bmp = await loadBitmap(file);

    const MAX_EDGE = 1600;
    let w = bmp.width, h = bmp.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();

    drawStamp(ctx, w, h, stamp);

    let quality = 0.82;
    let blob = await canvasToBlob(cv, quality);
    while (blob.size > maxKB * 1024 && quality > 0.35) {
      quality -= 0.08;
      blob = await canvasToBlob(cv, quality);
    }

    return { blob: blob, width: w, height: h, bytes: blob.size, quality: quality };
  }

  function drawStamp(ctx, w, h, s) {
    const barH = Math.max(64, Math.round(h * 0.11));
    const fs = Math.max(11, Math.round(barH * 0.20));

    const grad = ctx.createLinearGradient(0, h - barH - h * 0.06, 0, h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, h - barH - h * 0.06, w, barH + h * 0.06);

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 ' + fs + 'px -apple-system, system-ui, Segoe UI, Roboto, sans-serif';
    ctx.textBaseline = 'bottom';

    const pad = Math.round(w * 0.035);
    ctx.fillText(s.line1 || '', pad, h - barH + fs * 1.35);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.font = '500 ' + (fs * 0.92).toFixed(0) + 'px -apple-system, system-ui, Segoe UI, Roboto, sans-serif';
    ctx.fillText(s.line2 || '', pad, h - barH + fs * 2.75);

    // small REHOTEQ mark, bottom-right
    ctx.font = '700 ' + (fs * 0.86).toFixed(0) + 'px -apple-system, system-ui, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    const mark = 'REHOTEQ FIELD';
    ctx.fillText(mark, w - pad - ctx.measureText(mark).width, h - Math.round(barH * 0.12));
  }

  function canvasToBlob(cv, q) {
    return new Promise(res => cv.toBlob(res, 'image/jpeg', q));
  }

  function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).catch(() => viaImage(file));
    }
    return viaImage(file);
  }
  function viaImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = e => { URL.revokeObjectURL(url); rej(e); };
      img.src = url;
    });
  }

  function blobToBytes(blob) {
    return blob.arrayBuffer().then(b => new Uint8Array(b));
  }
  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  global.DB = DB;
  global.IMG = { processPhoto, sha256, uid, blobToBytes, blobToDataURL, drawStamp };
})(window);

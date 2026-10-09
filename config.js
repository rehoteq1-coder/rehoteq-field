/* =====================================================================
   config.js — every public link the app prints, in one place.

   Why this file exists: v1.0.0 hardcoded `rehoteq.ng` in four places.
   Nobody had registered that domain. Every PDF and every QR sticker
   pointed at an address a stranger could have bought and taken over.

   A QR sticker glued to a customer's inverter is forever. If this ever
   needs to change, change it HERE and nowhere else.

   ⚠️ rehoteq.com expires 24 March 2027. Keep auto-renew on at Namecheap.
   ===================================================================== */
(function (global) {
  'use strict';

  const DOMAIN = 'field.rehoteq.com';

  // Refs are printed and scanned by humans, so strip anything that is not
  // alphanumeric before it reaches a URL.
  function slugify(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[^A-Za-z0-9]/g, '');
  }

  const CONFIG = {
    domain: DOMAIN,
    origin: 'https://' + DOMAIN,

    // Service report verification — printed on the PDF, typed by a customer.
    verifyUrl: ref => 'https://' + DOMAIN + '/v/' + slugify(ref),
    verifyLabel: ref => DOMAIN + '/v/' + slugify(ref),

    // Solar passport — encoded into the QR sticker on the DB board.
    passportUrl: slug => 'https://' + DOMAIN + '/p/' + slugify(slug),
    passportLabel: slug => DOMAIN + '/p/' + slugify(slug),

    slugify: slugify
  };

  global.CONFIG = CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);

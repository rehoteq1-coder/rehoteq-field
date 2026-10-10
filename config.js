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

    /* --- payments -----------------------------------------------------
       Left empty until the Flutterwave payment links exist. The paywall
       reads these and hides the pay buttons when they are blank, rather
       than shipping a button that goes nowhere.

       ⚠️ NEVER put a Flutterwave SECRET key (sk_live_… / sk_test_…) in
       this file, or anywhere else in this app. It is a static site: every
       visitor can read this source. A secret key here would let anyone
       create charges, issue refunds and move money. Only a PUBLIC key
       (pk_live_…) or a plain payment-link URL belongs in client code.
       ---------------------------------------------------------------- */
    payments: {
      proMonthlyUrl: '',      // Flutterwave payment link — ₦3,000 / month
      proAnnualUrl: ''        // Flutterwave payment link — ₦30,000 / year
    },

    slugify: slugify
  };

  global.CONFIG = CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);

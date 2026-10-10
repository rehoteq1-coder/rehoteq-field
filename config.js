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
       Flutterwave *payment links*, created in the Flutterwave dashboard.
       A link is just a public URL, so no API key of any kind lives in
       this app.

       ⚠️ NEVER put a Flutterwave SECRET key (sk_live_… / sk_test_… /
       FLWSECK-…) in this file, or anywhere else in this app. It is a
       static site: every visitor can read this source. A secret key here
       would let anyone create charges, issue refunds and move money.
       Only a PUBLIC key (pk_live_…) or a plain link belongs here.

       A plan with a blank URL simply does not get a button — the paywall
       never renders a control that goes nowhere.
       ---------------------------------------------------------------- */
    payments: {
      proMonthlyUrl: 'https://flutterwave.com/pay/dvf5gvhvpcl4',   // Pro ₦3,000 / month
      proAnnualUrl: '',                                            // no annual link yet
      businessUrl: 'https://flutterwave.com/pay/8xo4xkokxwkg'      // Business ₦15,000 / month
    },

    /* --- support ------------------------------------------------------
       REHOTEQ's own lines, in international format for wa.me. The first
       is the one used for in-app links; both are shown where a customer
       needs to reach a human.
       ---------------------------------------------------------------- */
    support: {
      whatsapp: ['2347036302585', '2348166519177'],
      whatsappLabel: '0703 630 2585 · 0816 651 9177'
    },

    // A pre-filled WhatsApp link to REHOTEQ. Used for subscribe, support
    // and anything a customer needs to ask a human about.
    waUrl(text) {
      return 'https://wa.me/' + CONFIG.support.whatsapp[0] +
        '?text=' + encodeURIComponent(text || '');
    },

    // Normalise a phone number to the international form wa.me needs.
    // Nigerians write 0803 000 0000 locally and 2348030000000
    // internationally, and the same field gets both depending on who
    // typed it. Anything unrecognisable returns '' so the caller falls
    // back rather than building a link that goes nowhere.
    waNumber(raw) {
      const d = String(raw == null ? '' : raw).replace(/\D/g, '');
      if (d.length === 11 && d.charAt(0) === '0') return '234' + d.slice(1);
      if (d.length === 10) return '234' + d;
      if (d.length >= 12 && d.length <= 15) return d;
      return '';
    },

    // ------------------------------------------------------------------
    // Firebase. This block is PUBLIC BY DESIGN — it ships to every
    // browser, and Google intends it to. It identifies the project; it
    // does not grant access to anything.
    //
    // What actually protects customer data is firestore.rules and
    // storage.rules. Those are load-bearing. This is not.
    //
    // Still worth doing in the Firebase console:
    //   • restrict the API key to HTTP referrer field.rehoteq.com
    //   • enable App Check, so only the real app can call the project
    //   • set a billing budget alert — Cloud Storage is the billable one
    // ------------------------------------------------------------------
    firebase: {
      // Flipped on once the SDK loader and rules are both in place. Until
      // then the app never fetches Firebase at all, and stays fully
      // offline-native with no account.
      enabled: false,
      apiKey: 'AIzaSyApTJ1tHCUoaFfdPiq2j7j79qOOserw9vY',
      authDomain: 'rehoteq-field.firebaseapp.com',
      projectId: 'rehoteq-field',
      storageBucket: 'rehoteq-field.firebasestorage.app',
      messagingSenderId: '1083351168714',
      appId: '1:1083351168714:web:049bc950acd50e6e492633'
    },

    slugify: slugify
  };

  global.CONFIG = CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);

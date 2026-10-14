/* REHOTEQ Field — Firebase, loaded only when someone asks for it
   =========================================================================
   The one thing this file must not break: offline-native with no account.

   A technician who never signs in must never download Firebase and must
   never need the network. So the SDK is NOT in the service worker's
   precache list — it is fetched at the moment someone taps Sign in, and
   the service worker caches it on the way past. First sign-in needs a
   connection, which is fair; every one after that does not.

   Consequences of that choice, stated plainly:
     • the core app keeps working with no network and no account
     • signing in requires one connection the first time
     • a user who never signs in pays nothing in data
   ========================================================================= */
(function (global) {
  'use strict';

  var VERSION = '13.0.0';
  var BASE = 'https://www.gstatic.com/firebasejs/' + VERSION + '/';

  var state = { app: null, auth: null, db: null, mods: null, user: null, ready: false };
  var loading = null;          // the in-flight init promise, so we load once
  var listeners = [];
  var redirectErr = null;      // why the sign-in this tab started did not finish

  function cfg() { return (global.CONFIG && global.CONFIG.firebase) || null; }

  // An Error with a stable code, so authErrorText() can explain it.
  function coded(code, message, cause) {
    var e = new Error(message || code);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  // A note that survives the trip to Google and back. Written just before
  // signInWithRedirect hands the tab over; read and cleared by the next
  // finishRedirect(). sessionStorage is per tab, so the note can never
  // leak into another tab or a later visit, and storage that refuses to
  // work (some private modes) simply means no note, never an exception.
  var PENDING_KEY = 'rehoteq-field:signin-pending';
  function notePending() {
    try { global.sessionStorage.setItem(PENDING_KEY, String(Date.now())); } catch (e) {}
  }
  function takePending() {
    try {
      var had = global.sessionStorage.getItem(PENDING_KEY) !== null;
      global.sessionStorage.removeItem(PENDING_KEY);
      return had;
    } catch (e) { return false; }
  }

  /* ---- why sign-in failed, in plain words -----------------------------
     Keyed on the error CODE: the default Firebase message is only
     "Firebase: Error (auth/…).", which tells a technician nothing. Each
     answer ends with its code, so a screenshot sent on WhatsApp says
     exactly what happened. These are the codes a Google redirect sign-in
     raises; anything else is still named by its code, never blank. */
  var NO_STORAGE = 'This browser is blocking the storage Google sign-in needs ' +
    '(private tabs and in-app browsers do this). Open the page in your normal browser and try again.';
  var CANCELLED = 'Sign-in was cancelled at Google. Tap Sign in to try again.';
  var BAD_KEY = 'The Firebase web key in config.js is not valid for this project.';
  var AUTH_TEXT = {
    'auth/network-request-failed': 'No connection reached Google. Check your data or Wi-Fi, then try again.',
    'rehoteq/sdk-unreachable': 'Could not load Google sign-in. Check your data or Wi-Fi, then try again.',
    'auth/user-cancelled': CANCELLED,
    'auth/redirect-cancelled-by-user': CANCELLED,
    'auth/web-storage-unsupported': NO_STORAGE,
    'auth/operation-not-supported-in-this-environment': NO_STORAGE,
    // Back from Google with nobody signed in and no error at all. When the
    // sign-in page lives on another domain (authDomain is firebaseapp.com,
    // the app is field.rehoteq.com), a browser that partitions third-party
    // storage blocks the hand-off and the SDK reports "no redirect".
    'rehoteq/redirect-empty': 'Google sent you back without signing you in. If you did not cancel, ' +
      'this browser blocked the hand-off from Google\'s sign-in page (private tabs, in-app browsers ' +
      'and strict tracking protection do this). Try again in your normal browser; if it keeps ' +
      'happening, tell REHOTEQ.',
    'auth/user-disabled': 'This Google account has been disabled for REHOTEQ Field. Contact REHOTEQ.',
    'auth/account-exists-with-different-credential': 'This email already has an account with a different sign-in method.',
    'auth/invalid-credential': 'Google\'s sign-in answer was rejected as invalid or expired. Try again.',
    'auth/too-many-requests': 'Too many sign-in attempts from this device. Wait a few minutes, then try again.',
    // Project setup: fixed by the owner in the Firebase / Google Cloud console.
    'auth/unauthorized-domain': 'This web address is not on the sign-in allow-list. In the Firebase ' +
      'console: Authentication → Settings → Authorized domains → add {host}.',
    'auth/operation-not-allowed': 'Google sign-in is switched off for this project. In the Firebase ' +
      'console: Authentication → Sign-in method → enable Google.',
    'auth/admin-restricted-operation': 'New accounts are blocked for this project. In the Firebase ' +
      'console: Authentication → Settings → User actions.',
    'auth/invalid-api-key': BAD_KEY,
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': BAD_KEY,
    'auth/app-not-authorized': 'The Firebase web key refuses this web address. Check the key\'s website ' +
      'restrictions in the Google Cloud console → Credentials.',
    'auth/internal-error': 'Google sign-in hit an internal error. Try again; if it keeps happening, tell REHOTEQ.',
    'rehoteq/not-enabled': 'Sign-in is switched off in this build (config.js → firebase.enabled).'
  };

  function host() {
    try { return global.location.hostname || 'this address'; } catch (e) { return 'this address'; }
  }

  // Accepts an error, a bare code, or nothing. Never throws, never blank
  // for a real error: an unknown code is still named.
  function authErrorText(err) {
    if (!err) return '';
    var code = typeof err === 'string' ? err : String(err.code || '');
    var text = AUTH_TEXT[code];
    if (text) return text.replace('{host}', host()) + ' (' + code + ')';
    if (code) return 'Google sign-in failed (' + code + '). Try again; if it keeps happening, tell REHOTEQ.';
    var msg = String((err && err.message) || err).slice(0, 160);
    return 'Google sign-in failed: ' + msg;
  }

  // The switch in config.js. Until it is true this module is inert and the
  // app behaves exactly as it did before Firebase existed.
  function enabled() {
    var c = cfg();
    return !!(c && c.enabled && c.apiKey && c.projectId);
  }

  // Firebase ships as ES modules; dynamic import() works from a classic
  // script, so no bundler and no build step is introduced. A failed fetch
  // reads differently in every browser ("Failed to fetch dynamically
  // imported module", "Importing a module script failed"…), so it gets
  // one code a page can explain.
  function load(name) {
    return import(BASE + 'firebase-' + name + '.js').catch(function (err) {
      throw coded('rehoteq/sdk-unreachable', 'Could not load firebase-' + name + '.js', err);
    });
  }

  function init() {
    if (!enabled()) return Promise.reject(coded('rehoteq/not-enabled', 'Firebase is not enabled'));
    if (loading) return loading;

    loading = Promise.all([load('app'), load('auth'), load('firestore')])
      .then(function (m) {
        var app_ = m[0], auth_ = m[1], fs_ = m[2];
        var c = cfg();
        var app = app_.initializeApp({
          apiKey: c.apiKey,
          authDomain: c.authDomain,
          projectId: c.projectId,
          storageBucket: c.storageBucket,
          messagingSenderId: c.messagingSenderId,
          appId: c.appId
        });
        state.app = app;
        state.auth = auth_.getAuth(app);
        state.db = fs_.getFirestore(app);
        state.mods = { app: app_, auth: auth_, fs: fs_ };
        auth_.onAuthStateChanged(state.auth, function (u) {
          state.user = u ? shape(u) : null;
          // From this moment on, null means SIGNED OUT, not unknown. A
          // listener that arrives after this point gets the answer at
          // once (see onUser) instead of waiting for an event that has
          // already fired and will never fire again.
          state.ready = true;
          listeners.forEach(function (fn) {
            try { fn(state.user); } catch (e) { /* one bad listener must not stop the rest */ }
          });
        });
        return state;
      })
      .catch(function (err) {
        loading = null;   // allow a retry rather than caching the failure
        throw err;
      });

    return loading;
  }

  function shape(u) {
    return {
      uid: u.uid,
      email: u.email || '',
      name: u.displayName || '',
      photo: u.photoURL || ''
    };
  }

  /* ---- public surface ------------------------------------------------ */

  global.FB = {

    enabled: enabled,

    // Safe to call anywhere: resolves false rather than throwing when
    // Firebase is off or unreachable, so no caller can break the app.
    ready: function () {
      if (!enabled()) return Promise.resolve(false);
      return init().then(function () { return true; })
                   .catch(function () { return false; });
    },

    user: function () { return state.user; },

    // Register interest in sign-in state. Fires immediately with the
    // current state once auth has resolved, then on every change.
    onUser: function (fn) {
      listeners.push(fn);
      // A listener that arrives AFTER the auth event must still hear the
      // answer — even when the answer is "nobody is signed in". Before
      // this, only a signed-in user triggered the immediate callback, so
      // a late listener on a signed-out browser waited forever. That was
      // the Field HQ outage of Oct 2026: admin.js registered inside
      // finishRedirect's .then(), after the signed-out event had already
      // fired, and the page sat on "Loading…" for ever.
      if (state.ready) {
        try { fn(state.user); } catch (e) {}
      } else if (enabled()) {
        init().catch(function () { /* stay signed out */ });
      }
      return fn;
    },

    // Redirect, never popup. In an installed PWA on Android the popup path
    // is unreliable; redirect hands off to the browser and comes back.
    // A rejection here means the tab never left: the caller should show
    // authErrorText(err), since an address missing from the allow-list
    // fails right here, on the tap, not on the way back.
    signIn: function () {
      return init().then(function (s) {
        var provider = new s.mods.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        notePending();   // so the way back knows a sign-in was started
        return s.mods.auth.signInWithRedirect(s.auth, provider);
      }).catch(function (err) {
        takePending();   // never left the page: nothing to report on return
        throw err;
      });
    },

    // Called once on every page load. This is what completes a redirect
    // sign-in after the browser hands control back to us.
    //
    // It still never throws (every caller treats it as optional), but it
    // no longer swallows the reason: when a sign-in THIS TAB started comes
    // back without a user, the why is kept for redirectError(). Without a
    // pending note nothing is recorded, so an ordinary offline open is
    // never reported as a failed sign-in.
    finishRedirect: function () {
      if (!enabled()) return Promise.resolve(null);
      var pending = takePending();
      return init().then(function (s) {
        return s.mods.auth.getRedirectResult(s.auth).then(function (r) {
          if (r && r.user) { state.user = shape(r.user); return state.user; }
          if (pending && !s.auth.currentUser) {
            redirectErr = coded('rehoteq/redirect-empty', 'Returned from Google with nobody signed in');
          }
          return null;
        }, function (err) {
          if (pending) redirectErr = err || coded('auth/internal-error', 'getRedirectResult failed');
          return null;
        });
      }, function (err) {
        // The SDK would not load. Straight back from Google, that is the
        // answer; on any other open it is just a phone without data.
        if (pending) redirectErr = err;
        return null;
      }).catch(function () { return null; });   // the never-throws promise holds
    },

    // Why the sign-in this tab started did not finish, or null. Read it
    // after finishRedirect() resolves and show authErrorText() of it.
    redirectError: function () { return redirectErr; },

    authErrorText: authErrorText,

    signOut: function () {
      if (!state.auth) { state.user = null; return Promise.resolve(); }
      return state.mods.auth.signOut(state.auth).then(function () {
        state.user = null;
        listeners.forEach(function (fn) {
          try { fn(null); } catch (e) {}
        });
      });
    },

    // The entitlement record (users/{uid}) written by Cloud Functions.
    // Resolves null rather than throwing when Firebase is off or offline.
    profile: function () {
      if (!enabled() || !state.user || !state.db) return Promise.resolve(null);
      return state.mods.fs.getDoc(state.mods.fs.doc(state.db, 'users', state.user.uid))
        .then(function (snap) { return (snap && snap.exists()) ? snap.data() : null; })
        .catch(function () { return null; });
    },

    // ---- admin surface (Field HQ) -------------------------------------
    // Marks the signed-in user's own record as active. lastActive is not
    // an entitlement field, so the rules allow the client to write it, and
    // only to their own record. Silent by design: a failed write must
    // never disturb sign-in or the app itself.
    touchLastActive: function () {
      if (!enabled() || !state.user || !state.db) return Promise.resolve();
      var fs = state.mods.fs;
      return fs.setDoc(fs.doc(state.db, 'users', state.user.uid),
        { lastActive: fs.serverTimestamp() }, { merge: true })
        .catch(function () { /* offline is fine, next open retries */ });
    },

    // Internal feedback box. Any signed-in user may post a note to HQ;
    // only the owner may read them (firestore.rules /feedback).
    sendFeedback: function (text) {
      if (!enabled() || !state.user || !state.db) return Promise.reject(new Error('offline'));
      var fs = state.mods.fs;
      return fs.addDoc(fs.collection(state.db, 'feedback'), {
        uid: state.user.uid,
        email: state.user.email || '',
        text: String(text || '').slice(0, 2000),
        createdAt: fs.serverTimestamp()
      });
    },
    listFeedback: function () {
      if (!enabled() || !state.db) return Promise.resolve([]);
      var fs = state.mods.fs;
      return fs.getDocs(fs.query(fs.collection(state.db, 'feedback'),
        fs.orderBy('createdAt', 'desc'), fs.limit(200)))
        .then(function (snap) {
          var out = [];
          snap.forEach(function (d) { out.push(d.data()); });
          return out;
        });
    },

    // Owner-only read of every account record for the admin page. Returns
    // [] when Firebase is off or signed out; THROWS on permission-denied
    // so the admin page can tell "not an owner account" from "no data".
    listUsers: function () {
      if (!enabled() || !state.db) return Promise.resolve([]);
      var fs = state.mods.fs;
      return fs.getDocs(fs.query(fs.collection(state.db, 'users'),
        fs.orderBy('createdAt', 'desc'), fs.limit(500)))
        .then(function (snap) {
          var out = [];
          snap.forEach(function (d) {
            var v = d.data();
            v.uid = d.id;
            out.push(v);
          });
          return out;
        });
    },

    db: function () { return state.db; }
  };
})(window);

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

  var state = { app: null, auth: null, db: null, mods: null, user: null };
  var loading = null;          // the in-flight init promise, so we load once
  var listeners = [];

  function cfg() { return (global.CONFIG && global.CONFIG.firebase) || null; }

  // The switch in config.js. Until it is true this module is inert and the
  // app behaves exactly as it did before Firebase existed.
  function enabled() {
    var c = cfg();
    return !!(c && c.enabled && c.apiKey && c.projectId);
  }

  // Firebase ships as ES modules; dynamic import() works from a classic
  // script, so no bundler and no build step is introduced.
  function load(name) {
    return import(BASE + 'firebase-' + name + '.js');
  }

  function init() {
    if (!enabled()) return Promise.reject(new Error('Firebase is not enabled'));
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
    // current state, then on every change.
    onUser: function (fn) {
      listeners.push(fn);
      if (state.user !== null) {
        try { fn(state.user); } catch (e) {}
      } else if (enabled()) {
        init().catch(function () { /* stay signed out */ });
      }
      return fn;
    },

    // Redirect, never popup. In an installed PWA on Android the popup path
    // is unreliable; redirect hands off to the browser and comes back.
    signIn: function () {
      return init().then(function (s) {
        var provider = new s.mods.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return s.mods.auth.signInWithRedirect(s.auth, provider);
      });
    },

    // Called once on every page load. This is what completes a redirect
    // sign-in after the browser hands control back to us.
    finishRedirect: function () {
      if (!enabled()) return Promise.resolve(null);
      return init().then(function (s) {
        return s.mods.auth.getRedirectResult(s.auth);
      }).then(function (r) {
        if (r && r.user) { state.user = shape(r.user); return state.user; }
        return null;
      }).catch(function () { return null; });
    },

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

    db: function () { return state.db; }
  };
})(window);

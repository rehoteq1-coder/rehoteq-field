/* REHOTEQ Field — admin page (Field HQ)
   =========================================================================
   Owner-only view of who is using the app. The security model:

     • the page is public, but it is just a shell — it holds no data
     • the data lives behind Firestore rules: only an owner email may list
       the users collection, so a stranger's browser gets permission-denied
     • this page does not trust itself: "am I the owner?" is answered by
       whether the QUERY succeeds, never by anything it computes locally
   ========================================================================= */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function show(id) {
    ['loading', 'signedout', 'denied', 'ready'].forEach(function (s) {
      $(s).hidden = (s !== id);
    });
    $('refresh').hidden = (id !== 'ready');
  }

  function ms(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    return Number(ts) || 0;
  }

  function rel(ts) {
    var t = ms(ts);
    if (!t) return 'never';
    var d = Date.now() - t;
    var m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var days = Math.floor(h / 24);
    if (days < 30) return days + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function joined(ts) {
    var t = ms(ts);
    return t ? new Date(t).toLocaleDateString() : '—';
  }

  function pill(doc) {
    var plan = doc.plan || 'free';
    var cls = 'p-' + plan;
    var label = plan;
    if (plan === 'free' && doc.trialEndsAt && ms(doc.trialEndsAt) > Date.now()) {
      cls = 'p-trial'; label = 'trial';
    }
    if (doc.allPlansAccess) label += ' · owner';
    return '<span class="pill ' + cls + '">' + label + '</span>';
  }

  function render(users) {
    var now = Date.now();
    var week = 0, paying = 0, trial = 0;
    users.forEach(function (u) {
      if (ms(u.lastActive) > now - 7 * 86400000) week++;
      if (u.plan === 'pro' || u.plan === 'business') paying++;
      if (u.plan === 'free' && u.trialEndsAt && ms(u.trialEndsAt) > now) trial++;
    });

    $('stats').innerHTML =
      stat(users.length, 'accounts') +
      stat(week, 'active this week') +
      stat(paying, 'on Pro or Business') +
      stat(trial, 'on trial');

    var sorted = users.slice().sort(function (a, b) {
      return ms(b.lastActive) - ms(a.lastActive);
    });

    $('rows').innerHTML = sorted.map(function (u) {
      var name = u.name || (u.email || '').split('@')[0] || '—';
      return '<tr>' +
        '<td><b>' + esc(name) + '</b><br><span class="muted" style="font-size:12px">' +
          esc(u.email) + '</span></td>' +
        '<td>' + pill(u) + '</td>' +
        '<td>' + rel(u.lastActive) + '</td>' +
        '<td class="hide-sm muted">' + joined(u.createdAt) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="4" class="muted">No accounts yet.</td></tr>';

    $('rowcount').textContent = 'showing ' + users.length +
      (users.length >= 500 ? ' most recent accounts' : ' accounts');
    show('ready');
  }

  function stat(n, label) {
    return '<div class="stat"><b>' + n + '</b><span>' + label + '</span></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtWhen(v) {
    try {
      var d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
      return d ? d.toLocaleString() : '';
    } catch (e) { return ''; }
  }

  function loadFeedback() {
    FB.listFeedback().then(function (items) {
      $('fbrows').innerHTML = items.length ? items.map(function (f) {
        return '<tr><td><b>' + esc(f.email || 'unknown') + '</b></td>' +
          '<td>' + esc(f.text) + '</td>' +
          '<td class="hide-sm muted">' + esc(fmtWhen(f.createdAt)) + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="muted">No feedback yet.</td></tr>';
      $('fbcount').textContent = items.length ? items.length + ' message(s)' : '';
    }).catch(function () {
      // Offline, or the feedback rules are not deployed yet.
      $('fbrows').innerHTML = '<tr><td colspan="3" class="muted">Could not load feedback.</td></tr>';
    });
  }

  function load() {
    // Capture who is asking NOW: on a poor network the session can drop
    // mid-query, and by the time the error arrives FB.user() is already
    // null — which used to print the paradox "signed in as [nobody]".
    var me = FB.user();
    if (!me) { show('signedout'); return; }
    FB.listUsers().then(render).catch(function (err) {
      // The session dropped while the query was in flight. The honest
      // card is "sign in again", not "not authorised".
      if (!FB.user()) { show('signedout'); return; }
      var code = err && err.code ? String(err.code) : '';
      var msg = err && err.message ? String(err.message) : '';
      try { console.error('listUsers failed:', code, msg, err); } catch (e) {}
      var who = (me && me.email) || FB.user().email || '';
      $('deniedEmail').textContent = who + ownerHint(who) +
        (code || msg ? ' [debug: ' + (code || msg) + ']' : '');
      show('denied');
    });
    loadFeedback();
  }

  // Name WHICH dead end a refused account hit: wrong Google account
  // (switch accounts) or right account but Firestore still said no
  // (the rules were probably never deployed). CONFIG rides along in
  // admin.html but is absent in tests, hence the guard.
  function ownerHint(who) {
    var C = global.CONFIG;
    if (!who || !C || typeof C.isOwner !== 'function') return '';
    return C.isOwner(who)
      ? ' — owner account, but Firestore said no (rules not deployed?)'
      : ' — not the owner account (sign out and switch)';
  }

  // Say WHY sign-in failed. Before this, every failure (a web address
  // missing from the allow-list, a browser that blocked the hand-off from
  // Google, a cancelled account chooser) ended the same way: back on the
  // Sign in card with no word about what went wrong. The typeof guard
  // keeps an older cached firebase.js working in the middle of an update.
  function signInProblem(err) {
    try { console.error('sign-in failed:', err && err.code, err); } catch (e) {}
    if (FB.user()) return;            // someone IS signed in: nothing to explain
    var why = typeof FB.authErrorText === 'function'
      ? FB.authErrorText(err)
      : String((err && (err.code || err.message)) || 'unknown error');
    $('signinError').textContent = 'Sign-in did not finish. ' + why;
    $('signinError').hidden = false;
    show('signedout');
  }

  function clearSignInProblem() {
    $('signinError').textContent = '';
    $('signinError').hidden = true;
  }

  function start() {
    if (!FB.enabled()) { show('signedout'); return; }
    // Register FIRST, before finishRedirect() resolves. The signed-out
    // event fires exactly once, and a listener that arrives after it
    // hears nothing — the page sat on "Loading…" forever. (firebase.js
    // now also answers late listeners at once; this ordering means we
    // never depend on that safety net.)
    FB.onUser(function (u) {
      if (!u) { show('signedout'); return; }
      clearSignInProblem();   // signed in: an old failure must not resurface at sign-out
      load();          // the query is the authorisation check
      FB.touchLastActive();
    });
    // finishRedirect never throws; it keeps the reason a returning
    // sign-in failed instead. Guarded, like signInProblem.
    FB.finishRedirect().then(function () {
      var err = typeof FB.redirectError === 'function' ? FB.redirectError() : null;
      if (err) signInProblem(err);
    }).catch(function () { /* no redirect pending, carry on */ });
    // Safety net: on a network too poor to fetch the Firebase SDK at all,
    // auth never resolves and the listener above never fires. Never leave
    // the owner staring at "Loading…" — fall back to the sign-in card,
    // whose button retries the whole chain.
    setTimeout(function () {
      if (!$('loading').hidden) show('signedout');
    }, 15000);
  }

  // The tap itself can fail before the page ever leaves for Google: an
  // address missing from the allow-list, no connection, Google sign-in
  // switched off. That rejection used to vanish unheard, so the button
  // looked dead. Wrapped so even a synchronous throw lands on the card.
  $('signin').addEventListener('click', function () {
    clearSignInProblem();
    Promise.resolve().then(function () { return FB.signIn(); }).catch(signInProblem);
  });
  $('signout').addEventListener('click', function () { FB.signOut(); });
  $('refresh').addEventListener('click', load);

  start();
})(window);

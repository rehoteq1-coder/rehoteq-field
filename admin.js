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

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  function load() {
    FB.listUsers().then(render).catch(function () {
      $('deniedEmail').textContent = FB.user() ? FB.user().email : '';
      show('denied');
    });
  }

  function start() {
    if (!FB.enabled()) { show('signedout'); return; }
    FB.finishRedirect().then(function () {
      FB.onUser(function (u) {
        if (!u) { show('signedout'); return; }
        load();          // the query is the authorisation check
        FB.touchLastActive();
      });
    });
  }

  $('signin').addEventListener('click', function () { FB.signIn(); });
  $('signout').addEventListener('click', function () { FB.signOut(); });
  $('refresh').addEventListener('click', load);

  start();
})(window);

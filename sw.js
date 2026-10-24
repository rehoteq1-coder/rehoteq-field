/* REHOTEQ Field — service worker
   Cache the app shell so the technician can open the app in a basement,
   on a rooftop, or anywhere else the network has given up. */
// Bump this on every deploy, or installed phones keep serving the old app.
const CACHE = 'rehoteq-field-v54';
const SHELL = [
  './', 'index.html', '404.html', 'admin.html', 'admin.js', 'styles.css', 'config.js', 'icons.js', 'data.js', 'qr.js',
  'pdf.js', 'zip.js', 'db.js', 'report.js', 'firebase.js', 'app.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Firebase's same-site sign-in helper lives under /__/ (/__/auth/handler,
// /__/auth/iframe, /__/firebase/init.json). Never cache it and never serve
// the offline index.html fallback in its place.
function isAuthHelper(url) {
  const u = new URL(url);
  return u.origin === self.location.origin && u.pathname.indexOf('/__/') === 0;
}

// Same-origin shell, plus the Firebase SDK once it has actually been
// asked for. Nothing else from a third party is stored.
function isCacheable(url) {
  const u = new URL(url);
  if (u.origin === self.location.origin) return u.pathname.indexOf('/__/') !== 0;
  return u.origin === 'https://www.gstatic.com' && u.pathname.indexOf('/firebasejs/') === 0;
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (isAuthHelper(e.request.url)) return;
  // The offline shell fallback is for the app's own pages only. A failed
  // data request (Firebase Storage, Firestore, anything cross-origin) must
  // fail loudly: serving index.html in its place would hand a data reader
  // the app shell and make a network hiccup look like a broken backup
  // (v1.9.3: that is exactly what a cloud restore once received).
  const shellEligible = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) {
        // stale-while-revalidate: instant load, quiet update behind it
        fetch(e.request).then(res => {
          if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(e.request).then(res => {
        if (res && res.ok && isCacheable(e.request.url)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => shellEligible ? caches.match('index.html') : Promise.reject(new Error('offline')));
    })
  );
});

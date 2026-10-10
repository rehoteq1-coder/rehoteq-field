#!/usr/bin/env node
/* =====================================================================
   tools/build-icons.js — generate icons.js from lucide-static

   Run with:  npm run icons

   Why this exists: the app used emoji for every icon. Emoji render
   differently on every device and OS, which is why the UI looked
   different on a Tecno than on an iPhone, and you cannot set their
   colour or weight. A consistent line-icon set fixes all three.

   The icons come from Lucide (https://lucide.dev), ISC licensed, which
   permits commercial use. Every icon is 24x24 on one grid with a 2px
   stroke, so they are consistent with each other by construction.

   This script is a BUILD-TIME tool. The generated icons.js is committed,
   so the app itself still ships with zero runtime dependencies and no
   build step — you only need npm if you want to add an icon.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'lucide-static', 'icons');
const OUT = path.join(ROOT, 'icons.js');

if (!fs.existsSync(SRC)) {
  console.error('\nlucide-static is not installed. Run: npm install\n');
  process.exit(1);
}

/* The icons the app actually uses. Add here, run `npm run icons`, commit. */
const NEEDED = [
  // navigation
  'house', 'clipboard-list', 'wrench', 'search', 'settings-2',
  // trades
  'zap', 'cctv', 'router',
  // job flow
  'camera', 'mic', 'map-pin', 'pen-tool', 'list-checks', 'check', 'x',
  'plus', 'chevron-left', 'arrow-right', 'qr-code', 'file-text',
  'share-2', 'download', 'upload', 'save', 'lock', 'shield-check',
  'alert-triangle', 'trash-2', 'hammer', 'pencil-line',
  // documents
  'receipt', 'eye',
  // settings rows
  'building-2', 'user', 'phone', 'mail', 'landmark', 'image', 'pencil',
  'star', 'credit-card', 'signal', 'cloud', 'cloud-off', 'refresh-cw',
  'message-circle', 'play',
  // library
  'book-open', 'thumbs-up', 'thumbs-down', 'brain', 'scan-line'
];

/* One icon Lucide does not have: a solar panel. Stood-in by a generic sun
   it reads as "weather", not "solar", which is a real distinction when a
   technician is picking a trade in a hurry. Drawn on the same 24 grid
   with the same 2px stroke so it cannot look out of place. */
const CUSTOM = {
  'solar-panel':
    '<path d="M4 14 L8 6 H20 L16 14 Z"/>' +
    '<path d="M8.67 14 L12.67 6"/>' +
    '<path d="M13.33 14 L17.33 6"/>' +
    '<path d="M10 14 V19"/>' +
    '<path d="M6.5 19 H13.5"/>'
};

// Pull the inner shapes out of Lucide's <svg> wrapper. The wrapper is
// identical for every icon, so we keep one copy of it in icons.js.
function inner(name) {
  const raw = fs.readFileSync(path.join(SRC, name + '.svg'), 'utf8');
  const body = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>'));
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const icons = {};
const missing = [];
NEEDED.forEach(n => {
  if (!fs.existsSync(path.join(SRC, n + '.svg'))) missing.push(n);
  else icons[n] = inner(n);
});
if (missing.length) {
  console.error('\nThese icons are not in lucide-static: ' + missing.join(', ') + '\n');
  process.exit(1);
}
Object.assign(icons, CUSTOM);

const names = Object.keys(icons).sort();
const body = names.map(n => '  ' + JSON.stringify(n) + ': ' + JSON.stringify(icons[n])).join(',\n');

const out = `/* =====================================================================
   icons.js — the app's icon set. GENERATED FILE — do not edit by hand.

   Regenerate with:  npm install && npm run icons

   Source: Lucide (https://lucide.dev) v1.55.0, ISC licensed.
   ISC permits commercial use provided the copyright notice and this
   licence are included, which they are below.

   Every icon is 24x24 on a single grid with a 2px stroke and round
   caps, so they are consistent with each other by construction and
   inherit their colour from CSS via currentColor.

   \u26A0\uFE0F  One icon is ours: 'solar-panel'. Lucide has no solar panel, and
   a generic sun reads as "weather" rather than "solar" — a real
   difference when a technician is choosing a trade in a hurry.

   ISC License

   Copyright (c) 2026 Lucide Icons and Contributors

   Permission to use, copy, modify, and/or distribute this software for any
   purpose with or without fee is hereby granted, provided that the above
   copyright notice and this permission notice appear in all copies.

   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
   ===================================================================== */
(function (global) {
  'use strict';

  const ICONS = {
${body}
  };

  /* Inline SVG, so there is no network request and it works offline.
     currentColor means the icon takes the text colour of whatever it
     sits in, which is how the tab bar and the buttons tint it. */
  function ICON(name, size, cls) {
    const body = ICONS[name];
    // A missing icon must never blank out a screen: show a dot instead,
    // and say so on the console where a developer will see it.
    if (!body) {
      if (typeof console !== 'undefined') console.warn('icon not found: ' + name);
      return '<svg class="icon ' + (cls || '') + '" width="' + (size || 20) +
        '" height="' + (size || 20) + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="2" fill="currentColor"/></svg>';
    }
    return '<svg class="icon ' + (cls || '') + '" width="' + (size || 20) +
      '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  global.ICONS = ICONS;
  global.ICON = ICON;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ICONS: ICONS, ICON: ICON };
  }
})(typeof window !== 'undefined' ? window : globalThis);
`;

fs.writeFileSync(OUT, out);
console.log('icons.js written — ' + names.length + ' icons (' +
  Object.keys(CUSTOM).length + ' custom)');

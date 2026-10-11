#!/usr/bin/env node
/* =====================================================================
   tools/draft-guide.js — structure rough field notes into a library draft

   Run from your terminal (the key stays in your computer's environment,
   never in any file in this repo):

     GROQ_API_KEY="YOUR_KEY" npm run draft -- solar "Inverter overload E05..."

   Rule 4 from SESSION_PROMPT.md:
     "If I haven't seen it on a real job, it doesn't go in."
   So this script NEVER writes directly into `data.js`. It takes what you
   dictated from a real job, formats it into the exact `DATA.LIBRARY`
   schema (mandatory safety block first, ranked causes, ordered checks,
   parts with Naira prices), validates every field, and prints the JS
   block to your terminal so you can check it before pasting.
   ===================================================================== */
'use strict';

const https = require('https');

const VALID_TRADES = ['solar', 'electrical', 'cctv', 'networking'];
const GROQ_MODEL = 'llama-3.3-70b-versatile';

function parseArgs(argv) {
  const args = (argv || []).slice(2);
  if (!args.length) return { ok: false, error: 'missing_args' };
  const first = String(args[0] || '').toLowerCase().trim();
  if (VALID_TRADES.includes(first)) {
    const notes = args.slice(1).join(' ').trim();
    if (!notes) return { ok: false, error: 'missing_notes' };
    return { ok: true, trade: first, notes: notes };
  }
  const notes = args.join(' ').trim();
  return { ok: true, trade: 'solar', notes: notes };
}

function buildDraftPrompt(trade, notes) {
  const t = VALID_TRADES.includes(trade) ? trade : 'solar';
  const system = [
    'You format rough technician field notes from real Nigerian jobs into a structured REHOTEQ Field troubleshooting library entry.',
    'STRICT RULES:',
    '1. Do not invent facts outside the technician’s notes — structure what they saw.',
    '2. `safety` is MANDATORY and must state isolation/discharge/PPE steps clearly.',
    '3. Output STRICT JSON only — no prose, no markdown fences.',
    'Required JSON schema:',
    '{"id":"string (e.g. sol-overload)","trade":"' + t + '","cat":"string","symptom":"string",' +
      '"code":"string","freq":"high|med","causes":[{"t":"string","p":"HIGH|MED|LOW","d":"string"}],' +
      '"checks":["string"],"safety":"REQUIRED non-empty safety block","parts":[{"d":"string","price":0}],' +
      '"source":"REHOTEQ field data"}'
  ].join('\n');

  const user = JSON.stringify({
    trade: t,
    dictated_notes: String(notes || '').trim()
  });

  return { system: system, user: user };
}

function validateGuideDraft(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, reason: 'draft is not an object' };
  }
  if (typeof entry.id !== 'string' || !/^[a-z]+-[a-z0-9-]+$/.test(entry.id.trim())) {
    return { valid: false, reason: 'id must look like "sol-overload" or "elec-rcd"' };
  }
  if (!VALID_TRADES.includes(entry.trade)) {
    return { valid: false, reason: 'trade must be one of: ' + VALID_TRADES.join(', ') };
  }
  if (typeof entry.cat !== 'string' || !entry.cat.trim()) {
    return { valid: false, reason: 'cat is required' };
  }
  if (typeof entry.symptom !== 'string' || !entry.symptom.trim()) {
    return { valid: false, reason: 'symptom is required' };
  }
  if (typeof entry.safety !== 'string' || entry.safety.trim().length < 15) {
    return { valid: false, reason: 'safety block is mandatory and cannot be blank' };
  }
  if (!Array.isArray(entry.causes) || entry.causes.length < 1) {
    return { valid: false, reason: 'at least one cause is required' };
  }
  for (let i = 0; i < entry.causes.length; i++) {
    const c = entry.causes[i];
    if (!c || typeof c.t !== 'string' || !c.t.trim() || !['HIGH', 'MED', 'LOW'].includes(c.p) || typeof c.d !== 'string' || !c.d.trim()) {
      return { valid: false, reason: 'each cause needs t, p (HIGH|MED|LOW) and d' };
    }
  }
  if (!Array.isArray(entry.checks) || entry.checks.length < 1) {
    return { valid: false, reason: 'at least one ordered check is required' };
  }
  for (let i = 0; i < entry.checks.length; i++) {
    if (typeof entry.checks[i] !== 'string' || !entry.checks[i].trim()) {
      return { valid: false, reason: 'every check must be a non-empty string' };
    }
  }
  if (!Array.isArray(entry.parts)) {
    return { valid: false, reason: 'parts must be an array' };
  }
  for (let i = 0; i < entry.parts.length; i++) {
    const p = entry.parts[i];
    if (!p || typeof p.d !== 'string' || !p.d.trim() || typeof p.price !== 'number' || p.price < 0) {
      return { valid: false, reason: 'each part needs d and a non-negative Naira price' };
    }
  }
  return { valid: true };
}

function formatGuideForDataJs(entry) {
  const check = validateGuideDraft(entry);
  if (!check.valid) throw new Error('Invalid guide draft: ' + check.reason);
  const q = s => "'" + String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const causes = entry.causes.map(c =>
    '        { t: ' + q(c.t) + ', p: ' + q(c.p) + ',\n          d: ' + q(c.d) + ' }'
  ).join(',\n');
  const checks = entry.checks.map(c => '        ' + q(c)).join(',\n');
  const parts = entry.parts.map(p => '        { d: ' + q(p.d) + ', price: ' + (Number(p.price) || 0) + ' }').join(',\n');
  return [
    '    {',
    '      id: ' + q(entry.id.trim()) + ', trade: ' + q(entry.trade) + ', cat: ' + q(entry.cat.trim()) + ',',
    '      symptom: ' + q(entry.symptom.trim()) + ',',
    '      code: ' + q(entry.code || '') + ', freq: ' + q(entry.freq === 'med' ? 'med' : 'high') + ',',
    '      causes: [',
    causes,
    '      ],',
    '      checks: [',
    checks,
    '      ],',
    '      safety: ' + q(entry.safety.trim()) + ',',
    '      parts: [',
    parts,
    '      ],',
    '      source: ' + q(entry.source || 'REHOTEQ field data'),
    '    }'
  ].join('\n');
}

function requestGroqDraft(trade, notes, apiKey) {
  const key = apiKey || process.env.GROQ_API_KEY || '';
  if (!key) {
    return Promise.reject(new Error('GROQ_API_KEY is not set in your terminal environment'));
  }
  const messages = buildDraftPrompt(trade, notes);
  const payload = JSON.stringify({
    model: GROQ_MODEL,
    temperature: 0.1,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.user }
    ]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Groq HTTP ' + res.statusCode));
        }
        try {
          const parsed = JSON.parse(body);
          const content = parsed && parsed.choices && parsed.choices[0] &&
            parsed.choices[0].message && parsed.choices[0].message.content;
          const draft = JSON.parse(content);
          const check = validateGuideDraft(draft);
          if (!check.valid) return reject(new Error(check.reason));
          resolve(draft);
        } catch (e) {
          reject(new Error('Could not parse Groq draft response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

if (require.main === module) {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    console.error('\nUsage:\n  GROQ_API_KEY="YOUR_KEY" npm run draft -- <trade> "<dictated job notes>"\n');
    console.error('Example:\n  GROQ_API_KEY="YOUR_KEY" npm run draft -- solar "Inverter overload E05 beeping when AC starts"\n');
    process.exit(1);
  }
  if (!process.env.GROQ_API_KEY) {
    console.error('\nGROQ_API_KEY is not set in your terminal environment.');
    console.error('Set it on your computer only — never paste it into a repo file or chat.\n');
    process.exit(1);
  }
  requestGroqDraft(parsed.trade, parsed.notes)
    .then(draft => {
      console.log('\n// Review every line before adding to data.js:\n');
      console.log(formatGuideForDataJs(draft));
      console.log('');
    })
    .catch(err => {
      console.error('\nDraft failed: ' + err.message + '\n');
      process.exit(1);
    });
}

module.exports = {
  VALID_TRADES,
  parseArgs,
  buildDraftPrompt,
  validateGuideDraft,
  formatGuideForDataJs,
  requestGroqDraft
};

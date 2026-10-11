/* REHOTEQ Field — Cloud Functions
   =========================================================================
   Three jobs, all impossible (or unsafe) on the device:

   1. Create the account record when someone first signs in, and set the
      14-day trial clock. firestore.rules FORBIDS the app from doing this,
      which is exactly what keeps `plan` out of the user's hands. The
      server is the clock.

   2. Take Flutterwave's webhook after a payment, verify it against
      Flutterwave's own API, and only then grant Pro.

   3. Proxy V3 fault diagnosis (`aiProxy`): retrieve against the curated
      REHOTEQ troubleshooting library, call Groq with a strict JSON card
      schema (never chat prose), prepend the mandatory hard-coded safety
      block, and log every request to `ai_requests`. If the curated
      library has no verified entry for the fault, say so plainly and
      never guess.

   Secret keys live in Firebase environment config, never in this file
   and never in the app. Set them once from a terminal — and never paste
   the values into any file in this repo, not even a comment:

     firebase functions:config:set flutterwave.secret="PASTE-SECRET-HERE"
     firebase functions:config:set groq.key="PASTE-GROQ-KEY-HERE"

   ========================================================================= */
const https = require('https');
const { LIBRARY } = require('./library');

let functions, admin, db;
try {
  functions = require('firebase-functions/v1');
  admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  db = admin.firestore();
} catch (e) {
  // Allows the root test suite (`npm test` in CI) to require and exercise
  // this file directly without installing `functions/node_modules`.
  functions = {
    config: () => ({}),
    auth: { user: () => ({ onCreate: fn => fn }) },
    https: { onRequest: fn => fn }
  };
  admin = {
    firestore: {
      Timestamp: { fromMillis: ms => ({ toMillis: () => ms }) },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
    }
  };
  db = {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      add: async () => ({ id: 'stub' })
    })
  };
}

const TRIAL_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
const OWNER_EMAILS = ['rehoteq@gmail.com', 'rehoteq1@gmail.com'];

function isOwnerEmail(email) {
  return OWNER_EMAILS.includes(String(email || '').trim().toLowerCase());
}

/* ------------------------------------------------------------------ 1 */

/**
 * Runs the first time a user signs in.
 *
 * Sets plan = 'free' and trialEndsAt = now + 14 days for normal accounts,
 * or full owner access across all plans for rehoteq@gmail.com. The device
 * can set neither, and cannot restart the trial by signing out and back
 * in — an existing record is left untouched.
 */
exports.createAccount = functions.auth.user().onCreate(async (user) => {
  const ref = db.collection('users').doc(user.uid);
  const email = (user.email || '').trim().toLowerCase();
  const owner = isOwnerEmail(email);

  const existing = await ref.get();
  if (existing.exists) {
    if (owner) {
      await ref.set({
        email: email,
        plan: 'business',
        allPlansAccess: true,
        role: 'owner',
        expiresAt: null,
        entitlementSource: 'owner'
      }, { merge: true });
    }
    return null;
  }

  await ref.set({
    email: email,
    name: user.displayName || '',
    photo: user.photoURL || '',
    plan: owner ? 'business' : 'free',
    allPlansAccess: owner,
    role: owner ? 'owner' : 'technician',
    trialEndsAt: owner ? null : admin.firestore.Timestamp.fromMillis(Date.now() + TRIAL_DAYS * DAY),
    expiresAt: null,
    entitlementSource: owner ? 'owner' : 'trial',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return null;
});

/* ------------------------------------------------------------------ 2 */

function verifyWithFlutterwave(transactionId) {
  const cfg = functions.config().flutterwave || {};
  if (!cfg.secret) return Promise.reject(new Error('flutterwave.secret is not configured'));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.flutterwave.com',
      path: '/v3/transactions/' + encodeURIComponent(transactionId) + '/verify',
      method: 'GET',
      headers: { Authorization: 'Bearer ' + cfg.secret }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Flutterwave returned something that is not JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Grant Pro after a verified payment.
 *
 * A webhook body is a claim, not proof — anyone can POST JSON to a public
 * URL. Nothing is granted until Flutterwave's own API confirms the
 * transaction id, the currency, and the status.
 *
 * Matching a payment to a user: the payment links in config.js are static,
 * so Flutterwave does not know our uid. It does collect the payer's email
 * at checkout, and Firebase Auth gives us the same email — so we match on
 * that. If the addresses differ, the payment is held for manual matching
 * rather than granted to the wrong person.
 */
exports.flutterwaveWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const data = req.body && req.body.data;
  const txId = data && (data.id || data.tx_ref);
  if (!txId) return res.status(400).send('no transaction id');

  let verified;
  try {
    verified = await verifyWithFlutterwave(txId);
  } catch (e) {
    console.error('verify failed', e.message);
    return res.status(502).send('could not verify');
  }

  const v = verified && verified.data;
  const ok = v
    && v.status === 'successful'
    && v.currency === 'NGN'
    && Number(v.amount) >= 3000;

  if (!ok) {
    console.warn('payment not successful', txId, v && v.status, v && v.currency);
    return res.status(402).send('not successful');
  }

  const email = v.customer && v.customer.email
    ? String(v.customer.email).toLowerCase().trim()
    : '';

  if (!email) {
    console.warn('verified payment with no customer email', txId);
    return res.status(202).send('no email — held for manual match');
  }

  // Find the account by email. Firestore cannot query case-insensitively,
  // so the createAccount function stores email already lowercased and we
  // look it up the same way.
  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) {
    console.warn('paid but no account with that email', email, txId);
    return res.status(202).send('no matching account — held for manual match');
  }

  const ref = snap.docs[0].ref;
  const prev = snap.docs[0].data();
  const months = Number(v.amount) >= 30000 ? 12 : 1;

  // Renew early without costing the customer their remaining days.
  const prevMs = prev.expiresAt && prev.expiresAt.toMillis ? prev.expiresAt.toMillis() : 0;
  const start = Math.max(Date.now(), prevMs);

  await ref.set({
    plan: 'pro',
    entitlementSource: 'flutterwave',
    lastPaymentRef: String(v.tx_ref || txId),
    expiresAt: admin.firestore.Timestamp.fromMillis(start + months * 30 * DAY)
  }, { merge: true });

  console.log('granted pro', email, months + ' month(s)');
  return res.status(200).send('ok');
});

/* ------------------------------------------------------------------ 3
   V3 AI fault diagnosis proxy (`aiProxy`)
   Spec §7 Layer 3 — four non-negotiables:
     1. Safety block first, always (hard-coded, not model-dependent).
     2. Render as cards, never chat prose.
     3. Never write a diagnosis into the job card without the technician
        confirming it (enforced on the client; proxy returns candidates).
     4. Refuse out of scope (domestic gas, structural, medical, utility HV).
   And the honesty rule: if the curated library has no verified entry for
   the fault, say so plainly — never guess.
   -------------------------------------------------------------------- */

const GROQ_MODEL = 'llama-3.3-70b-versatile';

const MANDATORY_SAFETY = {
  electrical: 'ISOLATE FIRST: Switch off at the main isolator, lock off, and prove dead with a tested meter on every conductor before opening the DB board or touching terminations.',
  solar: 'ISOLATE FIRST: Switch off AC supply and inverter before opening any panel. PV strings stay live in daylight — cover panels or open the DC isolator before touching terminations. Remove rings, watches and bangles.',
  cctv: 'ISOLATE FIRST: Disconnect camera and NVR power before re-terminating. Use a stable ladder and never work at height in rain, wind or near overhead mains.',
  networking: 'ISOLATE FIRST: Never run data cable in the same conduit as mains power. Never look into an open fibre connector or open the ISP ONT.',
  hvac: 'ISOLATE FIRST: Isolate indoor and outdoor unit supplies, lock off and prove dead before opening. Wait for capacitors to discharge; do not vent refrigerant or open a sealed circuit unless qualified.',
  generator: 'ISOLATE FIRST: Run generators outdoors only because carbon monoxide can kill without warning. Disable automatic start, isolate generator and utility sources, and prevent back-feed before servicing.',
  plumbing: 'ISOLATE FIRST: Shut off and depressurise water before opening pipework; let hot water cool. Keep clear of nearby electrical equipment and isolate it safely if water is present.',
  fire_access: 'LIFE SAFETY: Notify the site responsible person and monitoring station before testing, obtain an impairment permit and fire watch, and never leave alarm or sprinkler zones bypassed.',
  smarthome: 'ISOLATE FIRST: Isolate and prove dead before opening mains-connected smart devices. Keep extra-low-voltage wiring separate from mains and never collect a customer password.',
  ev: 'ISOLATE FIRST: EV charger circuits carry sustained high current. Isolate, lock off and prove dead; verify earthing and DC-capable residual-current protection to OEM and local requirements.'
};

const OUT_OF_SCOPE_RULES = [
  {
    id: 'gas',
    re: /\b(gas\s+(leak|cylinder|cooker|pipe|smell|burner|valve|line)|lpg|cooking\s+gas|butane|propane)\b/i,
    specialist: 'licensed gas / LPG technician',
    tellCustomer: 'Ventilate the area immediately, do not operate any electrical switch or inverter, close the cylinder valve if safe, and call a licensed LPG/gas technician.'
  },
  {
    id: 'structural',
    re: /\b(structural\s+crack|roof\s+collaps|load[- ]bearing\s+wall|building\s+sinking|foundation\s+crack|slab\s+collaps)\b/i,
    specialist: 'licensed structural / civil engineer',
    tellCustomer: 'Stop work and keep load off the roof or wall until a licensed structural engineer has inspected and cleared the building.'
  },
  {
    id: 'medical',
    re: /\b(medical\s+(device|equipment)|life[- ]support|ventilator|dialysis|defibrillator|x[- ]ray\s+machine|patient\s+monitor|icu\s+equipment)\b/i,
    specialist: 'licensed biomedical engineer',
    tellCustomer: 'Clinical and life-support equipment requires a manufacturer-certified biomedical engineer. Do not open or modify the medical unit.'
  },
  {
    id: 'utility_hv',
    re: /\b(11\s*kv|33\s*kv|high[- ]voltage\s+line|transformer\s+pole|overhead\s+ht|disco\s+pole|nepa\s+pole|phcn\s+pole|street\s+transformer)\b/i,
    specialist: 'DISCO / licensed high-voltage linesman',
    tellCustomer: 'Keep everyone clear of the pole or transformer and report the fault directly to the electricity distribution company (DISCO).'
  }
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'when', 'from', 'that', 'this', 'have', 'has',
  'not', 'are', 'was', 'were', 'but', 'all', 'any', 'can', 'out', 'off', 'into',
  'only', 'one', 'two', 'after', 'before', 'what', 'why', 'how', 'customer',
  'says', 'said', 'very', 'some', 'more', 'than', 'its', 'there', 'their',
  'on', 'in', 'to', 'at', 'by', 'or', 'is', 'it', 'no', 'so', 'up', 'do', 'if',
  'my', 'we', 'be', 'as', 'an', 'of', 'channel', 'unit', 'system', 'work', 'working'
]);

const SHORT_TECH_TOKENS = new Set(['ac', 'dc', 'pv', 'db', 'ir', 'ap', 'ip', 'tv', 'ht']);

function normaliseTrade(t) {
  const s = String(t || '').toLowerCase().trim();
  return MANDATORY_SAFETY[s] ? s : 'solar';
}

function classifySafety(input) {
  const trade = normaliseTrade(input && input.trade);
  const text = [
    (input && input.fault) || '',
    (input && input.code) || '',
    (input && input.equipment) || '',
    (input && input.measurements) || ''
  ].join(' ');
  for (let i = 0; i < OUT_OF_SCOPE_RULES.length; i++) {
    const r = OUT_OF_SCOPE_RULES[i];
    if (r.re.test(text)) {
      return {
        outOfScope: true,
        category: r.id,
        specialist: r.specialist,
        message: 'This needs a ' + r.specialist + '. Here is what to tell your customer.',
        tellCustomer: r.tellCustomer,
        safety: [MANDATORY_SAFETY[trade], r.tellCustomer]
      };
    }
  }
  return { outOfScope: false, safety: [MANDATORY_SAFETY[trade]] };
}

function tokenise(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => (w.length >= 3 || SHORT_TECH_TOKENS.has(w)) && !STOP_WORDS.has(w));
}

function tokenMatch(hayTokens, needle) {
  for (let i = 0; i < hayTokens.length; i++) {
    const h = hayTokens[i];
    if (h === needle) return true;
    if (needle.length >= 5 && h.length >= 5 && (h.startsWith(needle.slice(0, 5)) || needle.startsWith(h.slice(0, 5)))) {
      return true;
    }
  }
  return false;
}

/**
 * Retrieve verified guides from the curated library.
 * Returns only entries with a real symptom/code/cause match.
 * If nothing in the curated library matches, returns [] so the caller
 * tells the technician plainly that there is no verified entry yet.
 */
function retrieveGuides(query, library) {
  const lib = Array.isArray(library) ? library : LIBRARY;
  const trade = normaliseTrade(query && query.trade);
  const rawCode = String((query && query.code) || '').trim().toUpperCase();
  const text = [
    (query && query.fault) || '',
    (query && query.code) || '',
    (query && query.equipment) || '',
    (query && query.measurements) || ''
  ].join(' ');
  const qTokens = tokenise(text);

  if (!rawCode && !qTokens.length) return [];

  const scored = [];
  for (let i = 0; i < lib.length; i++) {
    const entry = lib[i];
    const entryCode = String(entry.code || '').trim().toUpperCase();
    const exactCode = Boolean(rawCode && entryCode && rawCode === entryCode) ||
      Boolean(entryCode && qTokens.includes(entryCode.toLowerCase()));

    if (entry.trade !== trade && !exactCode) continue;

    let score = 0;
    if (exactCode) score += 50;

    const symTokens = tokenise(entry.symptom + ' ' + entry.cat);
    const causeTitleTokens = tokenise((entry.causes || []).map(c => c.t).join(' '));
    const causeDescTokens = tokenise((entry.causes || []).map(c => c.d).join(' '));

    let primaryHits = 0;
    for (let j = 0; j < qTokens.length; j++) {
      const tok = qTokens[j];
      if (tokenMatch(symTokens, tok)) { score += 6; primaryHits++; }
      else if (tokenMatch(causeTitleTokens, tok)) { score += 5; primaryHits++; }
      else if (tokenMatch(causeDescTokens, tok)) { score += 2; }
    }

    if (primaryHits >= 2) score += 4;
    if ((exactCode || primaryHits >= 1) && score >= 6) {
      scored.push({ entry: entry, score: score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => s.entry);
}

function prependSafetyBlock(trade, guideSafety, modelSafety) {
  const t = normaliseTrade(trade);
  const mandatory = MANDATORY_SAFETY[t];
  const out = [mandatory];
  if (guideSafety && String(guideSafety).trim()) {
    out.push(String(guideSafety).trim());
  }
  if (Array.isArray(modelSafety)) {
    modelSafety.forEach(s => {
      const clean = String(s || '').trim();
      if (clean && !out.includes(clean)) out.push(clean);
    });
  }
  return out;
}

function fallbackFromGuide(guide, trade) {
  const t = normaliseTrade(trade || (guide && guide.trade));
  const safety = prependSafetyBlock(t, guide && guide.safety, []);
  const escalate = /EMERGENCY|do not re-energise|fire service/i.test((guide && guide.safety) || '');
  return {
    matched_guide_id: guide.id,
    symptom: guide.symptom,
    cat: guide.cat,
    code: guide.code || '',
    source: guide.source || 'REHOTEQ field data',
    possible_causes: (guide.causes || []).map(c => ({
      t: String(c.t),
      p: ['HIGH', 'MED', 'LOW'].includes(c.p) ? c.p : 'MED',
      d: String(c.d)
    })),
    checks: (guide.checks || []).map(String),
    safety: safety,
    parts: (guide.parts || []).map(p => ({ d: String(p.d), price: Number(p.price) || 0 })),
    confidence: 0.85,
    escalate_to_human: escalate
  };
}

function validateAiSchema(obj, candidates) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, reason: 'response is not a JSON object' };
  }
  const allowedIds = (candidates || []).map(c => c.id);
  const guideId = obj.matched_guide_id || (allowedIds[0] || '');
  if (allowedIds.length && !allowedIds.includes(guideId)) {
    return { valid: false, reason: 'matched_guide_id is not in retrieved library candidates' };
  }
  if (!Array.isArray(obj.possible_causes) || obj.possible_causes.length < 1 || obj.possible_causes.length > 6) {
    return { valid: false, reason: 'possible_causes must be a non-empty array of cards' };
  }
  for (let i = 0; i < obj.possible_causes.length; i++) {
    const c = obj.possible_causes[i];
    if (!c || typeof c !== 'object') return { valid: false, reason: 'cause is not an object' };
    if (typeof c.t !== 'string' || !c.t.trim()) return { valid: false, reason: 'cause missing title t' };
    if (!['HIGH', 'MED', 'LOW'].includes(c.p)) return { valid: false, reason: 'cause probability p must be HIGH, MED or LOW' };
    if (typeof c.d !== 'string' || !c.d.trim()) return { valid: false, reason: 'cause missing detail d' };
  }
  if (!Array.isArray(obj.checks) || obj.checks.length < 1) {
    return { valid: false, reason: 'checks must be a non-empty array' };
  }
  for (let i = 0; i < obj.checks.length; i++) {
    if (typeof obj.checks[i] !== 'string' || !obj.checks[i].trim()) {
      return { valid: false, reason: 'every check must be a non-empty string' };
    }
  }
  if (!Array.isArray(obj.parts)) {
    return { valid: false, reason: 'parts must be an array' };
  }
  for (let i = 0; i < obj.parts.length; i++) {
    const p = obj.parts[i];
    if (!p || typeof p.d !== 'string' || !p.d.trim() || typeof p.price !== 'number' || p.price < 0) {
      return { valid: false, reason: 'invalid part entry' };
    }
  }
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    return { valid: false, reason: 'confidence must be a number between 0 and 1' };
  }
  if (typeof obj.escalate_to_human !== 'boolean') {
    return { valid: false, reason: 'escalate_to_human must be a boolean' };
  }
  return { valid: true, matched_guide_id: guideId };
}

function buildPrompt(input, candidates) {
  const system = [
    'You are the REHOTEQ Field diagnosis ranker for field technicians in Nigeria.',
    'STRICT RULES:',
    '1. Ground every answer ONLY in the verified REHOTEQ library guides supplied below.',
    '2. Never invent a fault-code definition, cause, check, or part outside the supplied guides.',
    '3. Re-orderpossible_causes and checks to best match the technician’s fault description and measurements.',
    '4. Output STRICT JSON only — never prose or markdown.',
    'Required JSON schema:',
    '{"matched_guide_id":"string","possible_causes":[{"t":"string","p":"HIGH|MED|LOW","d":"string"}],' +
      '"checks":["string"],"safety":["string"],"parts":[{"d":"string","price":0}],' +
      '"confidence":0.85,"escalate_to_human":false}'
  ].join('\n');

  const user = JSON.stringify({
    trade: normaliseTrade(input && input.trade),
    fault_reported: String((input && input.fault) || '').slice(0, 600),
    fault_code: String((input && input.code) || '').slice(0, 40),
    equipment: String((input && input.equipment) || '').slice(0, 200),
    measurements: String((input && input.measurements) || '').slice(0, 300),
    verified_library_candidates: candidates.map(c => ({
      id: c.id,
      trade: c.trade,
      cat: c.cat,
      symptom: c.symptom,
      code: c.code,
      causes: c.causes,
      checks: c.checks,
      safety: c.safety,
      parts: c.parts
    }))
  });

  return { system: system, user: user };
}

function getGroqKey() {
  const cfg = (functions.config && functions.config().groq) || {};
  return cfg.key || process.env.GROQ_API_KEY || '';
}

function callGroq(messages, apiKey) {
  const key = apiKey || getGroqKey();
  if (!key) return Promise.reject(new Error('groq.key is not configured'));

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
          if (!content) return reject(new Error('Groq returned empty content'));
          resolve(JSON.parse(content));
        } catch (e) {
          reject(new Error('Groq returned non-JSON content'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function logAiRequest(record, customLogger) {
  if (typeof customLogger === 'function') {
    await customLogger(record);
    return;
  }
  try {
    await db.collection('ai_requests').add(Object.assign({}, record, {
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }));
  } catch (e) {
    console.error('ai_requests log failed', e.message);
  }
}

/**
 * Core V3 diagnosis pipeline.
 * Accepts optional `deps` ({ callGroq, log, library }) so tests can drive
 * the exact function with deterministic mocks and verify every branch.
 */
async function runDiagnosis(input, deps) {
  const opts = deps || {};
  const started = Date.now();
  const trade = normaliseTrade(input && input.trade);
  const fault = String((input && input.fault) || '').trim();
  const code = String((input && input.code) || '').trim();
  const equipment = String((input && input.equipment) || '').trim();
  const measurements = String((input && input.measurements) || '').trim();
  const uid = (input && input.uid) ? String(input.uid) : null;

  if (!fault && !code) {
    return { statusHttp: 400, body: { ok: false, error: 'fault description is required' } };
  }

  // 1. Safety & out-of-scope classifier always runs first.
  const safetyCheck = classifySafety({ trade, fault, code, equipment, measurements });
  if (safetyCheck.outOfScope) {
    const out = {
      ok: true,
      status: 'refused',
      trade: trade,
      category: safetyCheck.category,
      specialist: safetyCheck.specialist,
      message: safetyCheck.message,
      tellCustomer: safetyCheck.tellCustomer,
      safety: safetyCheck.safety,
      possible_causes: [],
      checks: [],
      parts: [],
      confidence: 0,
      escalate_to_human: true
    };
    await logAiRequest({
      uid: uid,
      trade: trade,
      input: { fault, code, equipment, measurements },
      matchedGuideId: null,
      candidateIds: [],
      outcome: 'refused_out_of_scope',
      model: 'safety-classifier',
      fallback: false,
      latencyMs: Date.now() - started,
      output: out
    }, opts.log);
    return { statusHttp: 200, body: out };
  }

  // 2. Retrieve verified entries from the curated library.
  const candidates = retrieveGuides({ trade, fault, code, equipment, measurements }, opts.library);
  if (!candidates.length) {
    const noMatch = {
      ok: true,
      status: 'no_match',
      trade: trade,
      matched_guide_id: null,
      message: 'We have no verified entry for this fault in the REHOTEQ library yet — we will not guess on live equipment.',
      safety: [MANDATORY_SAFETY[trade]],
      possible_causes: [],
      checks: [
        'Isolate the supply and prove dead before opening any enclosure.',
        'Photograph the nameplate, model number, and any error code shown on the unit.',
        'Record your meter readings on the job card so this fault can be reviewed and added to the library.'
      ],
      parts: [],
      confidence: 0,
      escalate_to_human: true
    };
    await logAiRequest({
      uid: uid,
      trade: trade,
      input: { fault, code, equipment, measurements },
      matchedGuideId: null,
      candidateIds: [],
      outcome: 'no_verified_entry',
      model: 'library-gate',
      fallback: false,
      latencyMs: Date.now() - started,
      output: noMatch
    }, opts.log);
    return { statusHttp: 200, body: noMatch };
  }

  // 3. Call Groq with strict JSON schema; validate, retry once, else fall back to library.
  const prompt = buildPrompt({ trade, fault, code, equipment, measurements }, candidates);
  const invoker = opts.callGroq || callGroq;
  let validated = null;
  let usedFallback = false;
  let modelUsed = GROQ_MODEL;
  let attempts = 0;

  while (attempts < 2 && !validated) {
    attempts++;
    try {
      const raw = await invoker(prompt);
      const check = validateAiSchema(raw, candidates);
      if (check.valid) {
        const matched = candidates.find(c => c.id === check.matched_guide_id) || candidates[0];
        validated = {
          matched_guide_id: matched.id,
          symptom: matched.symptom,
          cat: matched.cat,
          code: matched.code || '',
          source: matched.source || 'REHOTEQ field data',
          possible_causes: raw.possible_causes.map(c => ({
            t: c.t.trim(),
            p: c.p,
            d: c.d.trim()
          })),
          checks: raw.checks.map(c => c.trim()),
          safety: prependSafetyBlock(trade, matched.safety, raw.safety),
          parts: raw.parts.map(p => ({ d: p.d.trim(), price: Number(p.price) || 0 })),
          confidence: Math.round(raw.confidence * 100) / 100,
          escalate_to_human: Boolean(raw.escalate_to_human)
        };
      }
    } catch (e) {
      // retry once, then fall back deterministically to the curated library
    }
  }

  if (!validated) {
    usedFallback = true;
    modelUsed = 'curated-library-fallback';
    validated = fallbackFromGuide(candidates[0], trade);
  }

  const body = Object.assign({
    ok: true,
    status: 'diagnosed',
    trade: trade,
    fallback: usedFallback
  }, validated);

  // 4. Log every request and its structured result to ai_requests.
  await logAiRequest({
    uid: uid,
    trade: trade,
    input: { fault, code, equipment, measurements },
    matchedGuideId: body.matched_guide_id,
    candidateIds: candidates.map(c => c.id),
    outcome: usedFallback ? 'fallback_library' : 'diagnosed',
    model: modelUsed,
    attempts: attempts,
    fallback: usedFallback,
    latencyMs: Date.now() - started,
    output: body
  }, opts.log);

  return { statusHttp: 200, body: body };
}

exports.aiProxy = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://field.rehoteq.com');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const result = await runDiagnosis(req.body || {});
  return res.status(result.statusHttp).json(result.body);
});

exports._ai = {
  OWNER_EMAILS,
  isOwnerEmail,
  MANDATORY_SAFETY,
  OUT_OF_SCOPE_RULES,
  classifySafety,
  retrieveGuides,
  prependSafetyBlock,
  fallbackFromGuide,
  validateAiSchema,
  buildPrompt,
  runDiagnosis
};

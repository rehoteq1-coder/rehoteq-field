/* REHOTEQ Field — Cloud Functions
   =========================================================================
   Two jobs, both impossible on the device:

   1. Create the account record when someone first signs in, and set the
      14-day trial clock. firestore.rules FORBIDS the app from doing this,
      which is exactly what keeps `plan` out of the user's hands. The
      server is the clock.

   2. Take Flutterwave's webhook after a payment, verify it against
      Flutterwave's own API, and only then grant Pro.

   The secret key lives in Firebase environment config, never in this file
   and never in the app. Set it once from a terminal — and never paste the
   value into any file in this repo, not even a comment:

     firebase functions:config:set flutterwave.secret="PASTE-SECRET-HERE"

   ========================================================================= */
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const https = require('https');

admin.initializeApp();
const db = admin.firestore();

const TRIAL_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ 1 */

/**
 * Runs the first time a user signs in.
 *
 * Sets plan = 'free' and trialEndsAt = now + 14 days. The device can set
 * neither, and cannot restart the trial by signing out and back in —
 * an existing record is left untouched.
 */
exports.createAccount = functions.auth.user().onCreate(async (user) => {
  const ref = db.collection('users').doc(user.uid);

  const existing = await ref.get();
  if (existing.exists) return null;

  await ref.set({
    email: (user.email || '').toLowerCase(),
    name: user.displayName || '',
    photo: user.photoURL || '',
    plan: 'free',
    trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + TRIAL_DAYS * DAY),
    expiresAt: null,
    entitlementSource: 'trial',
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

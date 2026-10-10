# Firebase plan — accounts, real enforcement, and teams

Toye knows Firebase, so we build on it. This is the plan, not yet the code.

---

## The one rule that shapes everything

**The app must keep working with no account at all.**

Offline-native with no signup is the thing that makes us different — every
competitor is cloud software with a degraded offline mode. If Firebase becomes
_required_, we throw away our only real advantage and become a worse Jobber.

So: **IndexedDB stays the source of truth on the device, forever.** Firebase is
a layer you opt into, for three things only:

1. **Entitlement** — are you actually Pro? (real enforcement, real trial)
2. **Teams** — a Business account with technicians under it
3. **Sync** — a job assigned on your phone appears on your technician's phone

Everything else stays local.

---

## How enforcement actually works

This is the part that is impossible today, and the reason a server is not
optional.

```
1. You tap Subscribe  →  Flutterwave payment link        (already built)
2. Customer pays
3. Flutterwave calls  →  OUR CLOUD FUNCTION (webhook)
4. Cloud Function asks Flutterwave: "is this transaction real?"
        using the SECRET KEY — which lives only on the server
5. If real  →  Firestore: users/{uid}.plan = 'pro', expiresAt = ...
6. Phone reads that back on next sync. Pro is on.
```

**Step 4 is why the secret key must never enter this repository.** It has to
run somewhere the customer cannot read, and a static app has nowhere to hide
it. A Cloud Function does. This is the same rule already written into
`config.js`, finally with somewhere for the key to live.

### The trial works the same way

`trialEndsAt` is written **server-side** when the account is created and stored
in Firestore. The phone reads it. **The server is the clock**, so changing the
phone's date does nothing — which is precisely why a local trial was never
going to work.

---

## Data model

```
users/{uid}
  email, phone, displayName
  plan: 'free' | 'pro' | 'business'
  expiresAt, trialEndsAt
  company: { name, address, bio, email, bank, logo }

companies/{companyId}                  ← the Business plan unit
  name, ownerId, bio, ...
  members/{uid}
    role: 'lead' | 'tech'
    displayName, joinedAt

jobs/{jobId}
  ...mirrors the local job record...
  companyId, ownerId, assignedTo
  instructions                         ← the brief the lead sets
```

A technician sees jobs assigned to them, plus their company's jobs if they are
a lead. **Security rules enforce this — see gotcha 3.**

---

## Four things to know before you start

### 1. Cloud Functions need the Blaze plan

To verify a Flutterwave payment the function must make an outbound HTTPS
request to Flutterwave's API. Firebase's free **Spark** plan blocks outbound
network calls from functions.

You need **Blaze (pay-as-you-go)**. That sounds alarming and isn't: Blaze
includes a free monthly allowance (~2 million function invocations), so at your
volume the bill is genuinely zero. **But it requires a card on file.**

This is the single real cost gate in the whole plan.

### 2. The Firebase SDK must not break offline

The JS SDK loads from Google's CDN at runtime. Two mitigations, both required:

- **Load it lazily**, only when someone actually taps Sign in. A user who never
  signs in never downloads a byte of it, and never needs network.
- **Add it to the service worker cache** so once loaded it works offline.

Done right, the SDK is invisible to the offline user. Done wrong, we ship a
dependency that breaks in a basement.

### 3. Security rules are not a detail

A mistake here publishes every customer's name, phone number, and home address
to the internet. This is the one part of the build I would want to write
carefully and then test adversarially — deliberately trying to read another
company's jobs with a technician account.

Budget real time for it.

### 4. The project must be yours

It holds your customers' data and your billing. I can wire all of it, but the
account should be in your name, not mine.

---

## What I need from you

1. Create a Firebase project (your Google account).
2. Enable **Authentication** — Email/Password and Phone.
3. Enable **Firestore**.
4. Upgrade to **Blaze** (needed for the payment webhook; free allowance covers
   you at our volume).
5. Add a web app and send me the **config object** — the one with `apiKey`,
   `authDomain`, `projectId`.

**Do not send me the service-account JSON or any private key.** Those stay with
you, exactly like the Flutterwave secret. The web config is public by design —
it is meant to be in the browser — so it is safe to paste.

---

## Build order

| # | Stage | Needs Firebase? | Unblocks |
|---|-------|-----------------|----------|
| 1 | Company bio + site brief | No | ✅ **DONE** |
| 2 | Auth — sign in, stay signed in | Yes | everything below |
| 3 | Entitlement + 14-day trial | Yes | charging money at all |
| 4 | Flutterwave webhook (Cloud Function) | Yes | turning payment into Pro |
| 5 | Sub-users — invite a technician | Yes | the Business plan |
| 6 | Sync — assigned jobs reach the tech | Yes | teams actually working |
| 7 | Supervisor dashboard (web) | Yes | later |

Stage 1 shipped. Stages 2–4 are the minimum before you can honestly charge
anyone.

---

## What this does not change

- The app still runs offline, forever, with no account.
- Still no build step for the core app.
- Still no dependencies for a user who never signs in.
- Still one source of truth on the device.

Firebase is added on top. It is not allowed to become the floor.

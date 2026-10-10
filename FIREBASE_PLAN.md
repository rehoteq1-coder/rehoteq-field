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

## Which Firebase services, and what each one holds

Four services, and it is easy to enable three and wonder why nothing works.

| Service | Holds | Needed? |
|---|---|---|
| **Authentication** | Who you are. Sign-in, session, password reset. | **Yes** — the gate for everything else |
| **Firestore** | Structured data: accounts, `plan`, `trialEndsAt`, company profile, staff list, job records | **Yes** |
| **Cloud Storage** | The actual **photo files** — before / during / after / serial | **Yes** — and it is the one that will cost money |
| **Cloud Functions** | The Flutterwave payment webhook | **Yes** — the easiest to forget, and the one that makes money real |

### Firestore is for data you query. Storage is for files.

Never put a photo in Firestore. A Firestore document caps at 1 MB and you are
billed on reads; a single job photo would blow through both.

The correct split:

- **Cloud Storage** holds the image bytes.
- **Firestore** holds only the *reference* — the storage path, the SHA-256,
  the GPS stamp, the capture time.

That is already how the app works locally: `db.js` keeps photo blobs and job
records apart, and every photo carries its own hash. The cloud version mirrors
it rather than redesigning it.

### Storage is where the bill comes from

A job record is a few kilobytes. A job's photos are several megabytes. Firestore
will stay inside the free allowance effectively forever; **Cloud Storage is the
one to watch.** Twelve photos a job, twenty jobs a week, is gigabytes a year.

### Photos must never auto-upload on mobile data

Our user pays for his own data bundle. A feature that silently uploads twelve
site photos over MTN is a feature that costs him money he did not agree to
spend — and it will eat his bundle on the first job of the month.

So photo sync is:

- **Off by default on mobile data**
- **Automatic on Wi-Fi**
- **Always available as a manual "back up this job" tap**

The job record — the text, the checklist, the signatures — is small enough to
sync whenever. Only the photos wait.

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
  photos/{photoId}                     ← metadata only, not the image
    storagePath, sha256, stage, lat, lng, capturedAt

storage: jobs/{jobId}/{photoId}.jpg    ← the actual bytes, in Cloud Storage
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

## Naming the project

The **display name** can be changed later. The **project ID cannot** — it is
permanent and globally unique. So pick the ID carefully and let the name
follow it.

Rules: 6–30 characters, lowercase letters, digits and hyphens, must start with
a letter and cannot end with a hyphen.

**Use:**

| Project | ID | What it is for |
|---|---|---|
| Production | `rehoteq-field` | real customers, real money |
| Development | `rehoteq-field-dev` | building and breaking things |

If `rehoteq-field` is already taken globally (plausible — IDs are worldwide),
use `rehoteq-field-prod` and keep `-dev` matching.

**Why two.** The Firebase console looks *identical* for both. The commonest way
people destroy a business is deleting a collection in the wrong browser tab. A
`-dev` suffix in the URL is the only thing standing between you and that
mistake. Both projects share one billing account and both sit inside Blaze's
free allowance, so the second costs nothing.

**What not to use:** anything with a version in it (`rehoteq-v1`), or `test`,
`new`, `temp`. They are permanent and they will still be there in three years.

## Sequencing — sell Pro before you build Business

The build order above lists stages 2–4 (auth, entitlement, payment webhook)
before stages 5–6 (sub-users, sync). That ordering is deliberate and it is the
most important advice in this document.

**Stages 2–4 let you charge a solo technician.** That is the market you
actually have — one person with a toolbag, in Suleja or Okitipupa.

**Stages 5–6 are the Business plan**, and they are the hardest, most
security-sensitive part of the whole system. They also currently have **zero
customers waiting for them.** Nobody has asked you for sub-users except you.

So: build the ability to take money from one technician, get ten of them
paying, and build teams when the eleventh asks for it. Building teams first
means spending the hardest month of work on a feature with no buyer, and
discovering afterwards that you guessed the workflow wrong.

## Security rules — written, and waiting on you

`firestore.rules` and `storage.rules` are in the repo. **They do nothing until
they are deployed.** Rules sitting in a file protect nobody.

Two ways to put them live:

**Console (no tooling).** Firestore → Rules tab → paste `firestore.rules` →
Publish. Storage → Rules tab → paste `storage.rules` → Publish.

**CLI (better — rules then live in version control and deploy with the app):**
```
npm install -g firebase-tools
firebase login
firebase init firestore storage      # project: rehoteq-field
firebase deploy --only firestore:rules,storage:rules
```

Take the CLI path if you can. Rules that only exist pasted into a console tab
are rules nobody can review or revert.

### The one rule that makes enforcement real

In `firestore.rules`:

```
allow update: if isSelf(uid) && !touchesEntitlement();
```

You may edit your own name, phone, company and logo. You may **not** edit
`plan`, `trialEndsAt` or `expiresAt` — only the Cloud Function that verified a
Flutterwave payment writes those.

If the client could set `plan = 'pro'`, we would be straight back to the fake
enforcement we refused to build in the first place. **That single line is the
difference between a paywall and a suggestion.**

### A note on Cloud Storage

Photos are stored under `users/{uid}/...`, not a shared company path. That is
deliberate: it makes the storage rules obviously correct rather than clever.
Company-wide photo sharing gets designed properly when it is actually needed.

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

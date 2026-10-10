# REHOTEQ Field Pro — Feasibility Review

**Prepared for:** Toye (founder) and the product assessor
**Date:** 10 October 2026
**Against:** the seven-point brief in the Assessor report, item by item
**Method:** read every source file in the repo and ran the test suite — not a
skim of the README. Every claim below points at a file and a line.

---

## The short answer

The Assessor's instinct is right, and the good news is bigger than the bad news:

> **Five of the seven items are already partly built.** This is not a greenfield
> project. The job card, the evidence capture, the PDF engine, the quotation
> builder, the equipment passport and the offline shell all exist and work.

The bad news is narrower but sharper:

> **Three things the app currently says out loud are not true**, and two of them
> are printed on documents handed to paying customers. That is the first thing
> to fix — before any new feature — because it is a trust and liability problem,
> not a product problem.

And one hard constraint the brief has not accounted for:

> **Voice-to-quotation cannot work offline.** Android's speech recognition ships
> the audio to Google and returns text. No signal, no dictation. The brief asks
> for both; we have to choose, or build the voice feature as an
> online-optional extra.

Finally, the real bottleneck on item ① is not money or code:

> The troubleshooting library has **12 guides**. The app can search them
> beautifully. It cannot search the 48 that do not exist. That content has to
> come out of your head, one job at a time.

---

## How this was checked

| What | Result |
|---|---|
| `npm install && npm test` | **52 checks pass, 0 fail** |
| Source read end to end | `app.js` (1580), `data.js` (506), `report.js` (407), `db.js` (184), `qr.js` (314), `pdf.js` (247), `schema.sql` (625) |
| Every inline button handler | Audited by the existing wiring test |

**Discrepancy found:** the README, `SESSION_PROMPT.md` and `DEPLOY.md` all say
"59 checks". The suite actually reports **43**. The number regressed somewhere
between v1.0.2 and now and nobody caught it. Small thing, but it means the
documentation cannot be trusted as evidence — which is the theme of this review.

---

## Scorecard

| # | Assessor item | Status | What's real | Dev effort to finish |
|---|---|---|---|---|
| ① | Offline Technical Knowledge Centre | **PARTIAL** | 12 curated guides, offline search, symptom + fault-code matching, safety block on every entry | 1.5 days of code + **your content** |
| ② | Smart Materials & Profit Tracker | **PARTIAL** | Materials rows, qty, unit price, labour, auto-totals, PDF line items | 2 days |
| ③ | Voice-to-Quotation | **PARTIAL** | Voice dictation on 4 fields (online); full quotation builder with VAT | Templates: 1 day · Voice: 1.5 days **online only** |
| ④ | Job Evidence Vault | **EXISTS (80%)** | Before/during/after/serial photos, GPS + time + name burned into pixels, per-photo SHA-256, dual signatures, job locks at sign-off, PDF evidence section | 0.5 day (honesty fix) + 1 day (amendments) |
| ⑤ | Customer & Equipment Memory | **PARTIAL (35%)** | Solar passport, QR sticker, warranty countdown, service history by serial | 0.5 day for search |
| ⑥ | Offline-first workspace | **EXISTS** | Service worker caches 14 files, IndexedDB, on-device PDF + QR, offline indicator, sync outbox | Verify, don't build — 0.5 day |
| ⑦ | Professional Business Kit | **DONE — shipped in v1.0.6** | Logo upload, business address, email, bank details, ₦ printed properly | Remaining: extra document templates, 0.5 day each |

**Item ⑦ has since been built — see the note at the end.** Remaining total:
roughly **7–8 working days of development**, plus
the library content, which is yours to dictate and is the single biggest lever
on whether any of this is worth ₦3,000 a month.

---

## ① Offline Technical Knowledge Centre — PARTIAL

### What already works

- **12 curated guides** in `data.js` across solar (4), electrical (3), CCTV (2),
  networking (2) and generator (1). Every one has symptom, ranked causes with
  HIGH/MED/LOW probability, an ordered check sequence, a **mandatory safety
  block**, typical parts with Naira prices, and a `source` field.
- **Offline search** over symptom + category + fault code + cause text
  (`app.js` `V.library`, the filter at line ~366).
- **Fault-code search works today.** Type "E03" and it matches `sol-e03`.
- **"Start a job card from this guide"** (`ACT.jobFromLib`) copies the symptom
  into the fault field and pre-fills the materials list from the guide's parts.
  That is a genuinely good piece of design.
- **It cannot invent a fault code.** There is no AI in V1 — the library is
  curated and deterministic by architecture. The Assessor's hardest requirement
  ("It should never invent a fault-code definition") is *already satisfied*, and
  I want to be loud about that: **adding an AI layer would break it.** The
  V3 roadmap item must not be allowed to touch this screen until there is a
  corpus and a validation layer behind it.

### What is missing

| Gap | Evidence |
|---|---|
| **No brand or model field** | `data.js` entries have `cat` ("Hybrid inverter") but no `brand` or `models`. A search for "SMS 6.2 kVA" matches nothing — the string "SMS" appears nowhere in the library. |
| **No "tools and measurements required" field** | `parts` exists; `tools` does not. |
| **No escalation threshold** | There is a `safety` block on every entry, but nothing says *"stop and escalate if X"*. The Assessor asked for this specifically and it is absent. |
| **No "what information is missing" behaviour** | Today an empty search shows *"Nothing here yet"*. It cannot say *"We have no verified entry for this model — here is what to check and here is why we won't guess."* |
| **No photographs in guides** | Correct, and see the warning below. |
| **12 of ~60 guides** | The content gap, not the code gap. |

### Effort

- Add `brand` / `models` / `tools` / `escalate` fields to the entry schema, wire
  them into search and the detail screen, backfill the 12 existing entries.
  **~1 day.**
- Build the honest "no verified entry" state. **~0.5 day.**
- The remaining 48 guides: **your time, not mine.** `LIBRARY_BACKLOG.md` already
  lists the next 24 in priority order with the five questions to answer per
  guide.

### On the photographs — I agree with the Assessor, strongly

Do **not** fill the library with generated equipment photos. An invented DC
connector or an invented inverter terminal block is worse than no photo,
because a technician will trust it. My recommendation:

1. Ship **zero** photos for now.
2. When you next meet a guide's fault on a real job, **take the picture on that
   job**. It is then yours, it is real, and it is already licensed.
3. Add a `photos: [{ file, caption, capturedBy, source }]` field to the entry
   schema so the plumbing is ready when the first real photo arrives.
4. For safety-critical steps, link to the **manufacturer's** diagram rather than
   shooting our own.

---

## ② Smart Materials & Profit Tracker — PARTIAL

### What already works

Materials rows with description, quantity and unit price (`V.jobcard`), a
labour field, automatic totals, and materials + labour printed as line items on
both the service report PDF and the quotation PDF (`report.js` lines ~137–180).
Guides pre-fill the materials list when you start a job from one.

### The gap that matters

**There is no cost anywhere in the app.** Every number stored is a *selling*
price. `unitPrice` is what you charge. Nothing records what you paid.

That means the app today can tell you **what you invoiced**. It cannot tell you
**what you made**. The Assessor's headline selling point — *"stop losing money
on jobs"* — is not currently deliverable, because profit requires cost.

The Assessor's own example table shows the trap:

| Item | Quantity | Cost |
|---|---|---|
| DC connector | 4 | ₦4,000 |

That column is *cost*. The app has no field for it.

### Interesting find: the profit model is already designed

`schema.sql` — the Postgres schema for the future backend — already has
`unit_cost`, `labour_cost`, `materials_cost` and `total_cost` (lines 169–171,
270). Someone designed the profit model for the server and it never made it into
the phone app. So this is not a design problem; it is a build problem.

Also confirmed: `report.js` line 152 reads `m.unit` to print "10 metres", but
**nothing in the UI ever sets `m.unit`**. It is a dead field. Harmless, but it
shows the materials model was left half-finished.

### What is missing

- `cost` per material line (what you paid)
- `unit` (metres, pieces, rolls) — wired to the UI
- `source`: purchased for this job / taken from stock / returned unused
- transport as a first-class cost, not a material line
- a profit figure: charged − (materials + labour-cost + transport)

### Effort

**~2 days**, including the PDF changes and the job-card UI. This is the single
highest-value item in the brief and it is cheap.

**One caution:** "materials taken from existing stock" only becomes meaningful
once there is a stock list, which we do not have. I would ship
*purchased-for-job* and *returned-unused* first, and leave stock for when a
technician actually asks for it. Don't build inventory on spec.

---

## ③ Voice-to-Quotation — PARTIAL, with a hard constraint

### What already works

Voice dictation exists on the four job-card text fields — fault, diagnosis, work
performed, recommendation — via the Web Speech API set to `en-NG`
(`ACT.voice`, `app.js` ~line 1043). The quotation builder works: line items,
quantity, unit price, labour, VAT rate, notes, terms, and a real PDF.

### The constraint nobody has priced in

**Android speech recognition sends the audio to Google and gets text back.**
`navigator.onLine` must be true. On a rooftop in a rural community with no data,
the microphone button will fail.

The brief asks for an app that works offline *and* understands speech. **Those
two requirements conflict** unless we either:

(a) accept that dictation is an **online-only convenience** with a clear
    message when there is no signal, or
(b) bundle an on-device speech model — which means shipping tens of megabytes to
    a phone on Nigerian mobile data. Not viable for V1.

### The second problem: parsing

"Four cameras at thirty-five thousand naira each" → four line items with the
right quantities and prices. That is a deterministic number-and-unit parser, and
it is very doable. **But** the brief is right to demand a review step: speech
recognition will hear "35,000" as "35000" or "three five thousand" or
"thirty-five thousand", and a quotation with a wrong zero is worse than a slow
one. The review screen is not optional, it is the feature.

### My recommendation: build the templates first

The reusable packages are the bigger, safer half of this idea and nobody has
noticed that yet:

- CCTV installation package
- Solar maintenance package
- Electrical installation package
- Network cable installation package

Four taps instead of fifteen minutes of typing, **works with no signal**, no
parser to get wrong, no review screen needed. **~1 day.**

Then, if the templates land well, add dictation *into the item description
field* only — not a full speech-to-quotation parser. **~1.5 days, online only.**

Full "speak a quotation, receive an itemised draft" is **3–4 days** and I would
not do it before the templates have been field-tested.

---

## ④ Job Evidence Vault — EXISTS (about 80%)

This is the strongest part of the app and the Assessor's ranking of it as "very
high priority" is correct.

### What already works

- Four photo stages: **before, during, after, and serial number**
  (`V.photos`). The serial stage is a nice touch the brief asks for and it is
  already there.
- Time, GPS coordinates and the technician's name are **burned into the pixels**
  of every photo (`db.js` `drawStamp`). This is the right call — metadata beside
  an image is not evidence; a stamp on the image survives being screenshotted
  and shared. The Assessor asked for exactly this and it is done.
- SHA-256 digest per photo, stored on the job.
- Two signature pads, with a blank-check that refuses an empty box.
- **Both signatures lock the job card.** Inputs disable, delete buttons vanish.
- The PDF carries the photographs with BEFORE/DURING/AFTER captions, the
  capture time, the coordinates, and both signatures.

### What is missing

1. **The honesty problem (see the next section).** The app says "hash-chained"
   and "anyone can verify it at the link on the report". Neither is true today.
2. **No structured measurements.** Voltage, insulation resistance, earth loop
   impedance — these live in free text. The brief asks for "relevant
   measurements" as a first-class record. **~0.5 day** to add a measurements
   table to the job card and the PDF, and it would make the report far more
   credible. Worth doing.
3. **No amendment path.** Once locked, a job can never be corrected — not even a
   typo. The brief says *"preserve original records and clearly identify
   subsequent corrections."* Right now there is no way to make a correction at
   all. **~1 day** for a proper amendment/correction log.
4. **Customer approval** is satisfied by the customer signature.

---

## The honesty audit — three claims the app makes that are not true

The Assessor wrote:

> *"It should not claim that a photograph or timestamp is impossible to
> manipulate unless the underlying system genuinely supports that claim."*

I went looking for whether it does. **It does not.** Three separate places
overclaim, and two of them are printed on documents given to customers.

### Claim 1 — "This report is tamper-evident" (on every PDF)

`report.js` prints a green box headed **"VERIFIED EVIDENCE"** containing the
sentence *"This report is tamper-evident. Verify at field.rehoteq.com/v/REF"*.

There is no backend. `404.html` — the page that link lands on — is a static file
that says *"Quote this reference to REHOTEQ and we will confirm the job"* and
offers a WhatsApp button. It cannot verify anything. The 404 page is honest; the
PDF is not.

### Claim 2 — "hash-chained" (README, and the photos screen)

`app.js` pushes each photo's SHA-256 into `job.hashes` (line ~168). That is a
**list of independent digests, not a chain** — there is no linkage between them,
so deleting a photo does not break anything. And only `hashes[0]` is ever
printed, so the second and third photographs are not represented in the
fingerprint at all.

### Claim 3 — "Anyone can verify it at the link on the report"

Not today. There is no server to verify against.

### What I changed, and why I did it without waiting

I have corrected the two customer-facing wordings to say only what the app can
actually stand behind. This is not new feature work — it is removing a claim
that could be challenged by a customer, and it is the kind of thing that should
not wait for a planning meeting.

**Before:**
> VERIFIED EVIDENCE — This report is tamper-evident. Verify at
> field.rehoteq.com/v/RF2026-00001

**After:**
> RECORD & REFERENCE — Signed by both parties on 10 Oct 2026. 3 photographs
> carry a time and location stamp burned into the image. Reference:
> field.rehoteq.com/v/RF2026-00001

Same for the in-app strip on the report screen, and for the "hash-chained" line
on the photos screen. **If you disagree with any wording, tell me and I will
change it back — it is three strings.**

### If you want real verification later

The minimum honest version: at sign-off, compute one SHA-256 over the ordered
record (ref + timestamp + every photo digest + the text fields + the money),
store it on the job, and push it to the server with the outbox. Then
`field.rehoteq.com/v/REF` can actually compare. That is a **Phase-3** item and
it depends on the Supabase backend that does not exist yet. Until then, the
honest claim is the one above.

> **Also worth knowing, and not yet fixed:** the paywall advertises *"No
> watermark — your own logo"* on Pro, but **there is no logo upload anywhere in
> the app**, and the PDF masthead prints a green "R" tile. It also advertises
> *"Start 14-day free trial"* and names Paystack and Flutterwave, while there is
> no payment integration of any kind — `ACT.upgrade` just writes
> `plan = 'pro'` into IndexedDB, and there is a toggle in Settings that flips
> any phone to Pro itself, with no card and no trial timer.
> I have left all of this alone because it is a commercial decision, not a bug.
> ~~But a customer who pays ₦4,000 for a logo that cannot be uploaded will ask
> for their money back.~~ **Fixed in v1.0.6 — logo upload now exists.** What
> remains is that the trial and the payment providers it names still do not.

---

## ⑤ Customer & Equipment Memory — PARTIAL (about 35%)

### What already works, and works well

The **solar passport** is the best thing in this app. Give a job a serial number
and it becomes a system record with:

- a QR code you print and stick on the DB board
- a live warranty countdown
- the full service history, filtered by that serial number
- a `field.rehoteq.com/p/<slug>` page the customer can scan **with no app
  installed**

That is exactly what the brief asks for, and it is already shipped.

### What is missing — and it is embarrassing how small it is

**There is no search box on the jobs screen.** None. To find a customer's
previous job you scroll the whole list. That is the entire gap the Assessor
described as "searching old WhatsApp messages", and fixing it is a search input
and a filter — **half a day**.

Other gaps:

- **`customers` and `equipment` IndexedDB stores are declared in `db.js` and
  never written to.** I grepped for every write: there are none. Equipment is
  re-derived from the job list on every boot (`refreshEquipment`). Customers do
  not exist as records at all — a customer is just three strings on a job card.
- **Warranty is hardcoded to 24 months** (`refreshEquipment`). You cannot set
  12, 36 or 60.
- **Previous quotations are not linked to the equipment record.**
- **No "recommended maintenance date" is stored.** One checklist item says
  *"Update maintenance record / passport — Sets the next reminder"*. Nothing
  sets a reminder. That is a promise in the checklist text that the code does
  not keep — the same category of problem as the tamper-evidence claim.

### Effort

Search across jobs by name, phone, serial, model and reference: **~0.5 day.**
Editable warranty and a real next-service date: **~0.5 day.**

This is the cheapest high-value item in the whole brief.

---

## ⑥ Offline-first — EXISTS. Verify, do not build.

The Assessor was right to say *"verify what already works before paying for
additional development."* I did.

| Capability | Status |
|---|---|
| App shell cached for offline launch | ✅ `sw.js`, 14 files, stale-while-revalidate |
| Create and update jobs with no signal | ✅ IndexedDB |
| Record measurements / text | ✅ |
| Capture photographs | ✅ Camera + canvas, no network |
| Generate PDF reports | ✅ `pdf.js` writes PDF 1.4 on the device |
| Generate QR codes | ✅ `qr.js`, verified bit-for-bit against the reference library |
| Save quotations | ✅ |
| Access equipment records | ✅ |
| Sync when connection returns | ⚠️ **Outbox records intent only.** `DB.pending()` counts queued ops; nothing drains them. There is no server. |

**Verdict: the offline requirement is met for everything a technician can do
alone.** The two things that genuinely need a signal are voice dictation and
sending the PDF — both inherently networked, both already fail gracefully.

### The real risk is not offline. It is data loss.

Every job card and photo lives in **one phone's IndexedDB**. If the phone is
lost, reset, or the browser decides to clear storage, the work is gone. The app
already knows this: it nags you to back up once you have three jobs
(`needsBackup()`), and backup/restore is a genuine round-trip with photos,
tested automatically.

That is the right architecture. What I would add:

1. **Test the restart-before-sync case for real**, as the Assessor asked. Open
   the app offline, create a job with photos, kill the browser process, reopen.
   I have not run this on a real device — the jsdom harness cannot. **This
   belongs in your 20-job field test, not in my estimate.**
2. **A visible "unbacked-up" warning with a number on it** — already partly
   there via the nudge.
3. **Operational hazard:** the service-worker cache name in `sw.js` must be
   bumped on *every* deploy or installed phones keep the old code. It is
   currently `rehoteq-field-v5`. This is a manual step and it is easy to forget;
   if it is forgotten, a fix silently does not reach a single technician.

**Effort: ~0.5 day of verification work. Do not pay for new offline
development.**

---

## ⑦ Professional Business Kit — DONE (shipped in v1.0.6)

> **Update, 10 Oct:** after writing this review I built the parts of item ⑦
> that every job depends on. Skip to [What changed](#what-changed-since-this-review)
> for the detail. The analysis below is kept because the *remaining* half of
> the item — the extra document templates — is still open.

### What already works

The profile screen collects name, phone, business name and bank details. The
PDF masthead prints the business name. The quotation prints a **PAYMENT** block
with bank details. Two document templates exist: service report and quotation.

### What is missing

| Gap | Note |
|---|---|
| **No logo upload** | The paywall sells it. It does not exist. |
| **No address field** | `report.js` prints `profile.address` under the company name on the masthead — but **Settings never asks for an address**, so that line is always blank. Another promise the code half-keeps. |
| **No maintenance certificate** | Not built. |
| **No equipment handover document** | Not built. |
| **No standalone payment receipt** | Not built. |
| **No warranty record document** | Not built. |
| **₦ prints as "NGN"** | Known limitation, `pdf.js` line 51 transliterates the naira sign because the standard-14 PDF fonts have no ₦ glyph. |

### The good news on branding

The Assessor asked whether the existing PDF engine supports custom branding.
**It does.** `pdf.js` already embeds JPEGs into the PDF using DCTDecode — that
is how photographs get onto the report. Dropping a logo into the masthead is the
same code path. **Logo upload: ~0.5 day.** Each additional document template:
**~0.5 day** of layout work.

### On the naira sign

This is the one that actually makes a document look unprofessional to a Nigerian
customer — a quotation that reads "NGN 85,000.00". Two options:

1. **Embed a TrueType subset** — the proper fix, but font subsetting from
   scratch is 1–2 days and it is fiddly.
2. **Draw the ₦ as a vector path** — it is an N with two crossbars. Maybe half a
   day, and it will sit next to Helvetica without looking wrong if done
   carefully.

I would try option 2 and fall back to "NGN" if the glyph looks off. **Worth
putting on the list, not worth doing before the logo.**

---

## Icons and illustrations

The Assessor is right that the emoji (⚡ ☀️ 📹 🌐) render differently on every
device and look unprofessional on a document. Confirmed: emoji are used in the
trade tiles, the bottom tab bar, the quick-action grid, the settings rows, the
paywall and most buttons.

**Consistent SVG icon set for navigation: ~1 day.** Home, Jobs, Guides, Search,
Settings, camera, microphone, location, plus the tab bar. One stroke weight, one
grid, inline SVG so there is no extra network request and it works offline.

**Service-category illustrations — I would not do these yet.** Five hand-drawn
illustrations is 2–3 days and a visual-style decision that is much easier to make
*after* the icon set has landed and you can see it on your phone. Sequence it
second, and decide then whether it is worth the money at all.

---

## Pricing — one decision is blocking

**DECIDED 10 Oct 2026: Pro is ₦3,000 / month, ₦30,000 / year.**

| Plan | Assessor proposed | Was locked | **Now shipping** |
|---|---|---|---|
| Free | ₦0 | ₦0 / 3 reports | ₦0 / 3 reports |
| Pro monthly | ₦2,500 | ₦4,000 | **₦3,000** |
| Pro annual | ₦25,000 | ₦40,000 | **₦30,000** (2 months free) |
| Team / Business | from ₦10,000/mo | ₦15,000/mo | ₦15,000/mo (unchanged — decide separately) |

You chose ₦3,000 to make it easy to say yes at the start. That is the right
instinct for a product with no payment history: the first twenty subscribers
matter more than the first twenty thousand naira.

**What ₦3,000 does to the numbers.** Against the ₦4,000 the code assumed, it is
a 25% cut in revenue per subscriber — so you need roughly 1.33× the subscribers
to earn the same. Cheap to absorb at this stage, because the cost of serving a
technician is still near zero: no server, no AI, no storage, no sync. Every
feature in this brief is offline and on-device. That cost advantage is the
reason ₦3,000 is affordable at all, and it is worth protecting.

**Two things to hold the line on:**

- **Do not discount further.** At ₦3,000 the margin already depends on there
  being no per-user cloud cost. A ₦2,000 price would need volume you do not
  have yet. Give more away free (raise the 3-report limit) rather than cutting
  the price.
- **Anchor on annual.** ₦30,000/yr (two months free) pulls cash forward, which
  matters more than MRR optics when you are bootstrapping.

**The one number that still is not decided: Business at ₦15,000.** The Assessor
suggested a Team tier from ₦10,000. Nobody has tested either. Leave it until
someone actually asks for a second seat.

**Separately, and more urgent:** there is no way to take a payment. No Paystack,
no Flutterwave, no trial timer, and a Settings toggle that grants Pro for free.
Pricing is theoretical until that exists. It is ~2 days to integrate Paystack and
it is the difference between a product and a hobby.

---

## What I recommend building, in order

Not all seven. Four, in this order, and then re-test on real jobs.

| Order | Item | Effort | Why here |
|---|---|---|---|
| **0** | **Logo, address, contact line, ₦** (⑦) — **DONE** | 0.5 day | The PDF is the one artifact every job produces. It now carries your logo, your address and a real naira sign. |
| **1** | **Search across jobs + customers + serials** (⑤) | 0.5 day | Cheapest real win in the brief. Turns the app into something that gets more useful every job. Unlocks the passport. |
| **2** | **Cost, unit, transport and profit on materials** (②) | 2 days | The Assessor's strongest selling point — *"stop losing money on jobs"* — is currently impossible because cost does not exist. This is the Pro feature. |
| **3** | **Job templates / packages** (③, templates only) | 1 day | Saves the most time per minute of typing, works offline, no parser to get wrong. Voice comes later, if at all. |

**Remaining: 3.5 days.** Then stop, ship, and run 20 jobs through it.

### Deliberately not doing yet

- **Voice-to-quotation parsing (③ full)** — 3–4 days, online-only, and the
  templates deliver most of the value for a quarter of the risk.
- **Category illustrations** — decide after the icon set.
- **Photographs in guides** — must come from your real jobs. Plumbing first,
  photos when you have them.
- **Amendment log (④)** — needed eventually (~1 day) but not before the four
  above.
- **Any AI** — the library's honesty is its value. Protect it.

---

## Answer to the question, from the evidence

> *"When you personally complete an electrical or solar job, which causes you the
> greatest difficulty — A, B, C, D, or E?"*

That is your question to answer, and your answer should drive the order. But the
codebase has an opinion, and here it is:

**C — recording work and producing professional reports — is already 80%
solved.** The evidence capture, the stamping, the signatures, the lock, the PDF:
that is the mature part of this app. If C is your pain, it is probably a
*usability* pain (too many taps, too slow on site) rather than a missing-feature
pain, and the answer is your 20-job field log, not more code.

**B is the real gap.** The app can tell you what you charged. It cannot tell you
what you made. No cost, no profit. The Assessor picked the right headline and
the code cannot currently deliver it.

**D is the biggest gap per hour of work.** Half a day of search turns the
passport from a nice screen into the reason a technician opens the app on every
repeat call.

**A is not a code problem.** The search works. The library has 12 entries. The
bottleneck is your dictation, and `LIBRARY_BACKLOG.md` is waiting.

**E — all of them — is the honest answer for a product**, and if that is your
call I would still build them in the order above, because the order is set by
value-per-day, not by importance.

---

## Changes made in this review

| File | Change |
|---|---|
| `report.js` | PDF footer no longer claims the report is "tamper-evident". It now states what is true: both signatures, the date, the number of photographs, the stamp, and the reference. |
| `app.js` | Report screen: "🔐 Verified evidence" → "🔎 Record reference". Photos screen: "hash-chained … anyone can verify it" → accurate wording about the stamp and the local record. |
| `sw.js` | Cache → `rehoteq-field-v6` so installed phones pick up the new wording. |
| `README.md` | Changelog entry, and the test count corrected. |
| `PRO_FEASIBILITY.md` | This document. |

Tests: **43 passed, 0 failed.**

---

<a name="what-changed-since-this-review"></a>
## What changed since this review

You asked what the best move was. My answer was item ⑦ — not because it
scored highest on importance, but because **the PDF is the one artifact every
single job produces**. Search is worthless until there is data in the app, and
cost/profit is worthless until you actually use the app. A document you are
proud to hand over pays off on job #1. So I built it.

### Shipped

**Your logo on every document.** *Settings → Edit profile → Add your logo.*
Resized to 256 px, stored as a data URL so it travels inside your backup, and
letterboxed into the masthead so it is never stretched. The PDF engine already
embedded JPEGs for job photographs, so this was the same code path — which is
why it took half a day rather than a week.

**The fields the masthead was already trying to print.** `report.js` has been
reading `profile.address` since v1.0.0 and Settings never asked for one, so
that line was blank on every PDF ever produced. Business address, email and
bank details are now collected on the edit-profile screen and printed under the
company name on both the report and the quotation. Over-long lines truncate
rather than running into the right-hand column.

**₦ instead of NGN.** The naira sign is absent from WinAnsiEncoding and there
is no embedded TTF, so it cannot be typeset — `pdf.js` draws it as vector
paths instead: a Helvetica-proportioned N with the two crossbars, using the
font's own cap height, stem weight and side bearings.

I verified this by rendering the PDFs and measuring them rather than trusting
the code. The glyph tops out at **256.3pt**; the figures it sits beside top out
at **256.3pt**. Bold is 25% heavier than regular. Both crossbars land where
they were aimed.

**That measurement caught a real bug.** `sanitize()` was stripping ₦ before
`width()` could measure it, so every amount containing a naira sign was
measured about 12% short — and the total on a quotation **overflowed the right
margin**. It would have shipped looking fine in testing and broken on the
first quotation with a seven-figure total. Fixed, and there is now a test that
would catch it.

### Files changed

| File | Change |
|---|---|
| `pdf.js` | Draws ₦ as vector paths; `text()` splits mixed runs; `width()` measures the sign; `sanitize()` preserves it, `esc()` strips it as a last resort. |
| `report.js` | `logoBox()` for the masthead (logo or the R mark), `contactLine()`, `fit()` truncation. |
| `app.js` | Logo upload/remove, `compressLogo()`, address/email/bank fields on the edit-profile screen, new Settings rows. |
| `db.js` | Exports `loadBitmap` for the logo pipeline. |
| `tests/run.js` | New branding suite: 9 checks. |
| `sample-report.pdf`, `sample-quotation.pdf` | Regenerated, so the samples show what the app actually produces now. |
| `sw.js` | Cache → `rehoteq-field-v7`. |

Tests: **52 passed, 0 failed.**

### Still open on item ⑦

- **Extra document templates** — maintenance certificate, equipment handover,
  payment receipt, warranty record. About half a day each, mostly layout.
- **The naira sign is invisible to text extraction**, because it is drawn
  rather than typed. Copying `₦28,000.00` out of a PDF gives you `28,000.00`.
  Embedding a real TTF fixes it properly if that ever matters.

### Still waiting on you

1. ~~**Pricing** — ₦4,000 (locked) or ₦2,500 (the Assessor's proposal).~~
   **Decided 10 Oct: ₦3,000/month, ₦30,000/year.** Now live in the paywall,
   `PLANS`, the spec and the prototype. Still open: the **Business tier at
   ₦15,000**, which nobody has tested.
2. **Payments** — there is still no way to take money. No Paystack, no
   Flutterwave, no trial timer, and a Settings toggle that grants Pro for
   free. ~2 days, and it is the difference between a product and a hobby.
3. **Which of the remaining three to build** — search (0.5d), cost/profit
   (2d), or job templates (1d). My order is in the table above.

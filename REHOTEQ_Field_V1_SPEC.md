# REHOTEQ FIELD — V1 Product Specification

**The AI Field Assistant for Technicians**
*Version 1.0 — prepared 8 October 2026*
*Status: ready to build*

---

## 0. TL;DR — the decision in one page

| Decision | Answer |
|---|---|
| **Product name** | **REHOTEQ Field** (not "RehoTech AI" — see §1) |
| **Positioning** | *Diagnose it. Prove it. Get paid.* |
| **Who we sell to first** | The individual technician holding the phone — not the company |
| **V1 (no AI)** | Technician → Job Card → Checklist → Photos → Sign-off → PDF → WhatsApp |
| **V1 scope** | 4 trades: Electrical, Solar, CCTV, Networking |
| **Build stack** | Supabase (backend) + PWA front-end first, FlutterFlow native second |
| **Time to first paying user** | 4–6 weeks |
| **Price** | Free / **Pro ₦3,000/mo** (₦30,000/yr) / **Business ₦15,000/mo (5 seats)** / Enterprise custom |
| **North-star metric** | Technician sends his first PDF report on WhatsApp within 24 hours of install |
| **Kill criterion** | If <30% of technicians who finish one job card ever finish a second, the job card is not the wedge — pivot to Proof-only |

---

## 1. First correction: do not put "AI" in the name of a V1 that has no AI

You proposed **RehoTech AI**. I'd change it, for four reasons:

1. **V1 has no AI.** Naming it "AI" sets an expectation the first 100 users will immediately test and find hollow. First impressions in a word-of-mouth market (technicians talk) are not recoverable.
2. **"RehoTech" collides with "REHOTEQ Technologies."** Customers will not know if you are selling the company or the app.
3. **"AI" ages badly.** Every product is "AI" in 2026. In 2029 it reads as dated. "Field" reads as a category you own.
4. **"Field" is the actual insight you wrote.** *"I am standing at a customer's house with my phone in my hand."* That is the whole thesis. Put it on the tin.

### Recommended name

> # REHOTEQ **Field**
> ### Diagnose it. Prove it. Get paid.

Short, ownable, expandable, and it names the place where your advantage actually lives.

**Alternates if you don't like it:** `FieldDoc` · `JobCard` · `RehoCard` · `RehoProof`
*(`JobCard` is the strongest alternate — "job card" is already the universal word for this document in African technical work. It is descriptive rather than brandable, which is either a feature or a bug depending on ambition.)*

### Product architecture — one app, five modules

RehoProof and RehoSolar Care stop being companies. They become modules. This is the single biggest structural improvement to your plan: **one app, one subscription, five reasons to stay.**

| Module | What it is | Version |
|---|---|---|
| **Assist** | Troubleshooting. V1 = curated library. V3 = AI diagnosis. | V1 (static) |
| **JobCard** | Job → checklist → photos → report → PDF → WhatsApp | **V1 core** |
| **Quote** | Line items → quotation PDF → WhatsApp → accept/decline | V1 |
| **Proof** | Evidence pack: before/during/after, GPS, timestamp, serials, signatures, certificate | V1 |
| **Passport** | Solar QR digital passport + warranty + maintenance history (was RehoSolar Care) | V1.5 |

**RehoCheck** becomes **RehoVerify** (V3+): verified technician identity + verified job history = the trust layer that makes a REHOTEQ Field report *mean* something. See §8.

---

## 2. Two market corrections from the research

### 2.1 Truecaller Scam Checker is real — but it is not in Nigeria yet

Confirmed: Truecaller launched Scam Checker on **28 September 2026** — ten days ago. Free, no account needed, web + Android, checks phone numbers, URLs and pasted messages, expanding short links and following redirects, with community reports from ScamFeed. [1](https://tbreak.com/truecaller-scam-checker-web-launch/) [3](https://www.absolutegeeks.com/tech-news/truecallers-new-scam-checker-works-without-an-app-or-sign-in/)

**But:** the launch is **India-first**, with the Middle East named and expansion to Africa, Latin America and Southeast Asia "planned" with **no date announced**. [1](https://tbreak.com/truecaller-scam-checker-web-launch/)

**So your conclusion is right but your timing is wrong by about a year.** The window is not shut — it is open for roughly the next 6–18 months in Nigeria. We are not missing it; we are choosing not to walk through it, because a scam checker has no customer we already have and no data flywheel. Correct call for the wrong reason. Keep RehoCheck in the drawer as RehoVerify (§8).

### 2.2 Omni Field is strong — and it is South African, and it sells to the boss

Confirmed: Omni Field Pro is a genuinely capable AI-powered job/field-service platform — scheduling, dispatch, GPS tracking, inventory, invoicing, offline mode, 16+ trades — built for **South African** service businesses, with location pages for Johannesburg, Cape Town, Durban, Pretoria, Stellenbosch. [1](https://omnifieldpro.co.za/auth) [2](https://www.omnifieldpro.co.za/locations/stellenbosch)

Two gaps it leaves open, and they are exactly your wedge:

1. **Geography.** It is SA-first. Anglophone West Africa — Nigeria especially — is not its home turf.
2. **Buyer.** It sells to the **owner** (dispatch, scheduling, track your technicians, run your business). You sell to the **technician** (here is the thing that makes you look professional and gets you paid). Bottom-up, single-user, ₦3,000/month, zero setup, no training, no IT department.

Omni Field is the company you will be compared to in a pitch deck. It is not the company that will beat you for a solar technician in Okitipupa who wants to send a PDF to Mr. Ade.

### 2.3 The uncomfortable truth we should say out loud

Nigeria's solar market is full of competent installers offering 1–2 year warranties and after-sales care — SolarKobo, Ecowatt, Sun King and many more. [2](https://ecowatt.com.ng/services/renewable-energy/) [3](https://www.solarkobo.com/) **Proof-of-work is not a new problem, and we are not the first to see it.** Our edge is not the insight. Our edge is that we can ship a tool for it in six weeks while the big installers are still using WhatsApp and paper.

---

## 3. Positioning and the three jobs-to-be-done

A technician buys REHOTEQ Field for exactly three reasons. Every feature must serve one.

| # | Job to be done | Emotion | Feature |
|---|---|---|---|
| 1 | **Help me fix it** | *"I don't want to look stupid in front of the customer."* | Assist |
| 2 | **Prove I fixed it** | *"Don't let them say I didn't do the work."* | Proof |
| 3 | **Get me paid** | *"I want to look like a professional, not a roadside guy."* | Quote + JobCard PDF |

**The line on the website:**

> Not *"Manage your technicians."*
> **"Finish the job. Prove the job. Get paid for the job."**

**One-sentence pitch for a technician:**
> *"Do the job once. REHOTEQ Field turns it into a professional report you can send on WhatsApp in 60 seconds — with photos, location, time and the customer's signature."*

---

## 4. V1 screens (14 screens, 3 taps to first value)

### Screen 1 — Login
Phone number + OTP. **Guest mode available** ("Try without an account") — every screen you put between a technician and his first job card costs you users.
*Fields: `+234 ___ ___ ____` → OTP → name → trade → done.*

### Screen 2 — Home
```
┌─────────────────────────────┐
│  REHOTEQ FIELD        ⚙︎ 🔔  │
│  Good afternoon, Toye       │
├─────────────────────────────┤
│  ┌───────────────────────┐  │
│  │   ▶  START A JOB   ▶  │  │   ← 64dp green, the only
│  └───────────────────────┘  │     thing that matters
│                             │
│  WHAT ARE YOU WORKING ON?   │
│  ⚡ Electrical   ☀️ Solar     │
│  📹 CCTV        🌐 Network   │
│                             │
│  CONTINUE                   │
│  ● Inverter fault — Mr Ade  │
│    Okitipupa · 2 hrs ago    │
│                             │
│  THIS MONTH  3 / 3 reports  │  ← usage meter → paywall
├─────────────────────────────┤
│  🏠 Home  📋 Jobs  👤 Customers  │
└─────────────────────────────┘
```
Design rule: **nothing above the fold that is not Start a Job or Continue.** The trade grid is a filter, not a navigation menu.

### Screen 3 — Action sheet (after trade selected)
Nine tiles. V1 ships six; three are visibly locked with "Coming soon" (this is honest and creates anticipation):

| Tile | V1? |
|---|---|
| 📋 New job card | ✅ |
| 🧾 Create quotation | ✅ |
| 📸 Capture job evidence | ✅ |
| 📚 Troubleshooting guide | ✅ (curated library) |
| 🔢 Identify equipment | 🔒 V2 |
| 🧠 Diagnose a fault | 🔒 V3 |
| 🎤 Ask by voice | 🔒 V4 |
| 🔎 My jobs | ✅ |
| 👤 Customers | ✅ |

### Screen 4 — New job (4 fields, one screen)
Customer (search or +New) · Site/address (auto GPS + editable) · Job type (dropdown per trade) · Equipment (select existing or add).
**Voice-to-text on every free-text field.** A technician with gloves on cannot type. This is not a nicety; it is the difference between used and abandoned.

### Screen 5 — Job card (the work screen)
The core. Five sections, each collapsible, each with a mic button:
1. **Fault reported** (customer's words)
2. **Diagnosis** (what you found)
3. **Work performed** (what you did)
4. **Materials used** (qty + unit price → feeds the quotation and the parts price index)
5. **Recommendation** (what they should do next — this is where the next job comes from)

Plus: started / completed timestamps (auto), GPS (auto), job status (Draft → In progress → Completed → Sent).

### Screen 6 — Checklist
Trade- and job-type-specific, pre-built, editable, with photo optional per item.
*Solar install (18 items): array mounting torque, MC4 termination, DC isolator, earthing, battery venting, inverter config, load test, customer handover…*
*Inverter fault (9 items): battery voltage, AC input, load, error log, terminations, fuses, earth, ventilation, firmware.*
Checklists are the quiet moat — they encode REHOTEQ's actual standards and are what a Business customer really buys.

### Screen 7 — Evidence capture
Camera with three labelled slots: **BEFORE · DURING · AFTER** + a fourth **SERIAL NO.** slot.
On capture, automatically stamped onto the image: date/time, GPS coordinates, technician name, job reference, and a small **REHOTEQ Field** watermark.
Non-negotiables: compress to **≤350 KB** per photo (data cost is a real barrier in Nigeria), store locally first, upload on Wi-Fi by default with a manual "upload now."

### Screen 8 — Sign-off
Two signature pads: **Customer** and **Technician**, finger-drawn, plus printed name. Once signed, the job card **locks** (read-only) — this is what makes it evidence rather than a note.

### Screen 9 — Report preview
The money screen. Branded, one scroll, looks like it came from a real company.

```
┌───────────────────────────────────┐
│ [LOGO]   REHOTEQ SERVICE REPORT   │
│          REHOTEQ Technologies     │
├───────────────────────────────────┤
│ Ref      RF-2026-00184            │
│ Customer Mr. Adewale Ade          │
│ Location Okitipupa, Ondo State    │
│ Service  Solar inverter maint.    │
│ Equipment 6.2 kVA hybrid inverter │
│ Serial   SMS62-2024-88314         │
├───────────────────────────────────┤
│ FAULT REPORTED                    │
│ Low battery warning, E03 on load  │
│                                   │
│ DIAGNOSIS                         │
│ Loose DC terminal on battery 3;   │
│ bank dropping to 44.1 V on load   │
│                                   │
│ WORK PERFORMED                    │
│ Re-terminated DC lugs, torqued to │
│ 12 Nm, rebalanced bank, load test │
│                                   │
│ MATERIALS USED                    │
│ 2 × 35 mm² copper lug    ₦  3,000 │
│ 1 × heat shrink kit      ₦  1,500 │
│                                   │
│ RECOMMENDATION                    │
│ Battery bank at 71% SoH. Plan     │
│ replacement within 6 months.      │
├───────────────────────────────────┤
│ 📷 BEFORE   📷 DURING   📷 AFTER   │
│ 08 Oct 2026 09:14 · 6.4975 N,     │
│ 4.7814 E · Toye A.                │
│                                   │
│ ✔ Customer   ✔ Technician         │
│   A. Ade        T. Adewale        │
├───────────────────────────────────┤
│ Verified at rehoteq.ng/v/RF00184  │
└───────────────────────────────────┘
```

### Screen 10 — Share
**Generate PDF → Send to WhatsApp.** One tap does both.
Also: Download PDF · Copy share link · Send via SMS/email · Print.
The WhatsApp path is a `wa.me` deep link with prefilled message + Android share sheet for the PDF attachment. **No WhatsApp API needed in V1.**

### Screen 11 — Quotation
Line items (auto-filled from Materials Used) + labour + optional VAT + validity + terms + bank details. Numbered `QT-2026-00XXX`. Status: Draft → Sent → Accepted / Declined. → PDF → WhatsApp.
Quotation is the feature that makes the app *revenue-positive* for the technician, which is what makes renewal non-optional.

### Screen 12 — Jobs list
Filter by status/trade/customer/date. Search. Offline badge (⏳ pending sync). Swipe to duplicate (a repeat maintenance visit should cost 3 taps).

### Screen 13 — Paywall
**Placement is the entire strategy.** Not at signup. Not on the home screen. The paywall fires **immediately after the technician finishes his first job card and taps "Generate PDF."** He has already done the work. The report is on screen. He is looking at something that makes him look professional in front of Mr. Ade. *That* is the moment ₦3,000 is cheap.

```
        🔒 You've used all 3 free reports

   ┌─────────────────────────────────┐
   │ PRO                             │
   │ ₦3,000 / month                  │
   │ ₦30,000 / year  (2 months free) │
   │                                 │
   │ ✓ Unlimited job cards & PDFs    │
   │ ✓ No watermark                  │
   │ ✓ Quotations that get accepted  │
   │ ✓ Evidence packs + signatures   │
   │ ✓ Works offline                 │
   │ ✓ Customer & equipment history  │
   │ ✓ All 4 trades + checklists     │
   └─────────────────────────────────┘
   [  Start 14-day free trial  ]
   [  Maybe later  ]
```
No card required for the trial.

### Screen 14 — Settings
Business profile (name, logo, brand colour, address, phone, email) · Bank details (for quotations) · Technician name/signature · Default trade · Offline/sync status + "force sync" · Data saver (photo quality) · Language (English → Pidgin → Yoruba/Hausa/Igbo later) · Subscription · Export all my data.

### Screen 15 (V1.5) — Solar Passport
Generate QR per installation → sticker on the DB board → customer scans → public web view (no app needed):
**MY SOLAR SYSTEM** · Installed date · Capacity · Battery · Panels · Installer · Warranty status (live countdown) · Maintenance history · Service log · Serial numbers · Next maintenance due · Report a fault (creates a job in the installer's dashboard) · Verify certificate.
Installer gets a fleet dashboard of every system ever installed — **which is a warm list for maintenance contracts and battery replacements.**

---

## 5. Pricing

| | **Free** | **Pro** | **Business** | **Enterprise** |
|---|---|---|---|---|
| **Price** | ₦0 | **₦3,000/mo** (₦30,000/yr) | **₦15,000/mo** (5 seats) | Custom, from ₦75,000/mo |
| Job cards / month | 3 | Unlimited | Unlimited | Unlimited |
| PDF report | Watermarked | Clean, branded | Branded + logo | White-label |
| Trades | 1 | All 4 | All + custom | All + custom |
| Checklists | Basic | Full library | Custom checklists | Custom + SOP enforcement |
| Evidence pack | — | ✓ | ✓ | ✓ + chain of custody |
| Quotations | 2/mo, basic | Unlimited | Unlimited + approval flow | Unlimited |
| Customer & equipment history | 7 days | Unlimited | Unlimited | Unlimited |
| Offline mode | — | ✓ | ✓ | ✓ |
| Troubleshooting library | 10/mo | Unlimited | Unlimited | Unlimited |
| AI credits (V2+) | 5/mo | 50/mo | 100/seat/mo | Negotiated |
| Team / supervisor | — | — | ✓ Assignments, dashboard, analytics, warranty mgmt | ✓ + API, SSO, integrations, SLA |
| Solar Passports | — | 3/mo | 50/mo | Unlimited |
| Support | Community | Email/WhatsApp | Priority | Named CSM |

**Add-ons:** Extra AI credits ₦1,000 / 50 · Solar Passport ₦500 per system · Verified Technician badge ₦2,000/yr (V3).
**Extra seat:** ₦2,500/mo.
**Payments:** Paystack + Flutterwave, monthly and annual.
**Trial:** 14 days of Pro, no card.

### Pricing notes
- **₦3,000 is roughly one call-out fee.** Frame it that way in marketing: *"One extra job pays for the whole year."* That is the actual ROI, and it is true.
- **Anchor on annual.** ₦30,000/yr (2 months free) lifts cash up front, which matters more than MRR optics for a bootstrapped product.
- **Solar Passport at ₦500/system is the sleeper.** It is transactional, grows with the installer's business, has near-zero marginal cost, and physically glues REHOTEQ Field to every install they ever do. Push it hard.
- **Do not discount.** Discounting a ₦3,000 product destroys the unit economics and attracts the wrong users. Give more free trial instead.

---

## 6. Data model

Postgres on Supabase, Row Level Security on every table, org-scoped. Full DDL in `schema.sql`.

```
organisations ──┬── users (technician | supervisor | admin)
                ├── customers ──── sites ──── equipment ──┬── jobs ──┬── job_photos
                │                                         │          ├── checklist_runs
                │                                         │          ├── job_materials
                │                                         │          ├── signatures
                │                                         │          ├── evidence_packs
                │                                         │          └── reports
                │                                         └── warranties ── passport QR
                ├── quotations
                ├── subscriptions
                └── usage_counters

troubleshooting_library   (curated, versioned, offline-cached)
ai_requests               (the data flywheel — every call logged with outcome)
audit_log                 (who changed what, when, on which device)
```

**Design decisions that matter:**

- **`sites` is separate from `customers`.** A customer with three shops and a generator house is normal. Getting this wrong early is expensive later.
- **`equipment` is a first-class entity, not a text field.** Serial numbers, install dates and warranty periods are what make Passport and Proof possible. Never let this become free text.
- **Every photo row carries `sha256`.** A hash of the image bytes plus the job's prior hash gives a **tamper-evident chain**: the report can be re-verified at `rehoteq.ng/v/RF00184` and any edit breaks the chain. This is what turns a nice PDF into evidence. It costs almost nothing to build and it is almost impossible for a competitor to copy credibly once customers trust it.
- **`ai_requests` logs everything from day one** — input, model, latency, cost, and technician feedback. By V3 this table is your training set and your cost dashboard.
- **`sync_state` + `local_id` on mutable tables.** Offline is not a feature, it is a requirement; the schema must assume writes happen with no network.
- **Soft delete everywhere** (`deleted_at`). Technicians delete things by accident, and deleted evidence is worse than no evidence.

---

## 7. AI architecture (V2–V4 — the part we earn, not the part we start with)

### The reframe that matters most

Your V1→V4 sequence is right, but you framed it as *deferring the hard part*. It is the opposite.

> **The hard part is not the AI. The hard part is 10,000 structured, real Nigerian job cards.**
> A general-purpose model already knows what an inverter is. It does not know that a 6.2 kVA SMS hybrid in Ondo State throws E03 in April because of a swollen bank, or what a 35 mm² lug costs in Okitipupa this month.

So V1 is not a compromise before the AI. **V1 is the data-acquisition engine that makes V3 defensible.** Every job card completed is one labelled datapoint: *symptom → measurements → cause → fix → parts → price*. Google and OpenAI will never have that corpus. You will, because you will have collected it from your own technicians using your own app on real jobs.

### Layer 1 — V1: Curated library (deterministic, offline, zero cost, zero hallucination)
Author **~60 troubleshooting trees**: 4 trades × 15 most common fault codes/symptoms. Each tree: symptom → likely causes (ranked) → checks in order → safety note → parts typically needed.
Sourced from REHOTEQ's own job history and OEM manuals, reviewed and signed off by you. Ships inside the app, works offline, costs ₦0 per query, cannot hallucinate, and cannot electrocute anyone.
**This is better than AI for the first 10,000 users.** Say so in marketing. *"Real answers from real jobs — not guesses."*

### Layer 2 — V2: Equipment identification (vision)
Photo of nameplate/unit → cloud vision model → OCR + visual match → normalise against an `equipment_models` catalogue seeded from real jobs → return brand, model, capacity, spec sheet, common faults, manual link.
**Confidence gate:** below 70% confidence, show the top 3 and make the technician confirm or correct. Every correction writes to the catalogue. After 500 corrections the model is better than it was — and the catalogue is yours.

### Layer 3 — V3: Fault diagnosis (RAG)
```
Technician input (text / voice / photo / measurements)
        │
        ▼
  Supabase Edge Function  "ai-proxy"      ← API keys NEVER in the app
        │
        ├─► 1. Safety classifier (cheap, fast, always runs first)
        │        └─ if high-risk → prepend mandatory safety block
        │
        ├─► 2. Intent + equipment resolution (cheap model)
        │
        ├─► 3. Retrieval (pgvector) over:
        │        · curated troubleshooting library   (trusted, weighted highest)
        │        · anonymised historical job cards   (the moat)
        │        · OEM manuals & spec sheets
        │
        ├─► 4. Strong model → STRICT JSON response schema
        │        { possible_causes[], checks[], safety[], parts[],
        │          confidence, escalate_to_human: bool }
        │
        ├─► 5. Validate JSON against schema; retry once; else fall back to library
        │
        ├─► 6. Log to ai_requests (input, output, model, latency, cost)
        │
        ▼
   App renders STRUCTURED CARDS — never a wall of chat text
```

**Four non-negotiable rules for V3:**
1. **Safety block first, always.** No electrical procedure is ever emitted without an isolation/discharge/PPE preamble. Hard-coded, not model-dependent.
2. **Render as cards, not prose.** A technician with grease on his hands cannot read a paragraph. Ranked causes, numbered checks, one action per card.
3. **Never write a diagnosis into the report without the technician confirming it.** Human in the loop. This is both a safety and a liability decision.
4. **Refuse out of scope.** Domestic gas, structural, medical, and anything requiring a licence → *"This needs a licensed [X]. Here's what to tell your customer."*

### Layer 4 — V4: Copilot (agentic)
Voice in → structured job card out. Function calling: `create_job`, `add_material`, `generate_quote`, `generate_report`, `send_whatsapp`, `lookup_manual`, `book_return_visit`.
The technician speaks; the app does the admin. This is where your example conversation — diagnose → report → ₦185,000 quotation → send — becomes real.

### Unit economics of the AI
| Call | Model class | Est. cost | Notes |
|---|---|---|---|
| Library lookup (V1) | none — local | **₦0** | ~70% of queries should land here |
| Text/voice diagnosis (V3) | small/mid model | ₦8–₦25 | cache identical queries |
| Equipment ID from photo (V2) | vision model | ₦15–₦40 | compress image to ≤1024 px first |

At ₦3,000/mo with 50 AI credits and ~₦25 average cost, AI cost is ~₦1,250 worst case — **~42% of revenue**, before caching and before most queries hit the free library. Acceptable. Cache aggressively; the same ten fault codes will be 60% of all queries.

---

## 8. What happened to RehoCheck → RehoVerify

The scam-checker market is now Truecaller's to lose. But there is a piece of RehoCheck worth keeping, and it compounds with Field:

**RehoVerify (V3):** a technician's REHOTEQ Field history — verified ID, verified job count, verified customer ratings, verified evidence packs — becomes a **portable professional reputation**. A customer scanning a report's verification link sees not just "this report is genuine" but "this technician has completed 214 verified jobs with a 4.8 rating."

That is not a scam checker. It is a **trust layer for the informal technical trades**, and it is a moat, because reputation data cannot be scraped or bought. Truecaller can detect a scammer; it cannot tell you whether the man at your door is a good electrician. We can — because we watched him do the work.

---

## 9. Build path (no Android Studio, no getting lost)

### Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Backend | **Supabase** (Postgres + Auth + Storage + Edge Functions + pgvector) | One platform for everything; pgvector means the V3 RAG store is already there; generous free tier |
| Offline sync | **PowerSync** (SQLite ↔ Supabase auto-sync) | Purpose-built FlutterFlow/Supabase offline layer — the hardest requirement, solved off the shelf [1](https://blog.flutterflow.io/introducing-a-local-database-that-auto-syncs-with-supabase/) |
| Native app (later) | **FlutterFlow** | Real native Flutter, camera/GPS/signature/filesystem all native, **code export so you own the Dart** [2](https://hackceleration.com/labs/review/flutterflow) |
| PDF | **Server-side**, Supabase Edge Function | One template, identical output on every device, regenerable forever |
| WhatsApp | `wa.me` deep link + Android share sheet (V1) → WhatsApp Cloud API (Business tier) | No approvals needed to start |
| Payments | Paystack + Flutterwave | Nigeria-native |
| Vision/LLM | Routed through Edge Functions, never in the app | Keys stay server-side; per-plan rate limiting |

### The path I actually recommend: PWA first, native second

**Do not start with the native app.** Start with a **PWA** (progressive web app) on the *same Supabase backend*.

- Installable to the Android home screen from a link — **no Play Store review, no gate**
- Works offline via service worker + IndexedDB
- Ship in **3–4 weeks** instead of 8–12
- You can hand the link to 20 technicians tomorrow and watch what they do

Then, once you know which screens actually matter, rebuild those screens natively in FlutterFlow against the backend you already have. **Same backend, two front-ends, and you only pay to build the right thing once.** This is the single highest-leverage decision in the whole plan.

### Phased roadmap

| Phase | Weeks | Deliverable | Gate to proceed |
|---|---|---|---|
| **0. Ground truth** | 2 | Run 20 real REHOTEQ jobs on paper. Photograph everything. Write the checklists by hand from what you actually do. | Data model validated against reality |
| **1. V1 PWA core** | 4 | Login, job card, photos, PDF, WhatsApp share, paywall | **REHOTEQ's own 20 jobs all live in the app** |
| **2. Proof + Quote** | 4 | Checklists (4 trades), evidence packs, GPS/timestamp stamps, signatures, quotation → PDF | 10 external technicians, ≥5 have sent a report |
| **3. Native + Business** | 6–8 | FlutterFlow native app, PowerSync offline, supervisor dashboard, teams, Business tier | 50 job cards, 5 paying, ₦20k MRR |
| **4. V2 — Equipment ID** | 6 | Vision identification, equipment catalogue, confidence loop | 500 equipment records |
| **5. Passport** | 4 | Solar QR passport, customer web view, installer fleet dashboard, warranty tracking | 100 passports issued |
| **6. V3 — AI diagnosis** | 8 | RAG over library + job corpus, safety classifier, structured cards | 5,000 job cards in the corpus |
| **7. V4 — Copilot** | 8 | Voice → job card → quote → report → send | — |

### Budget (rough, bootstrapped)
| Item | Monthly |
|---|---|
| Supabase | $0 → $25 |
| PowerSync | free tier → ~$ |
| FlutterFlow (from Phase 3) | ~$30–70 |
| PDF service | $0–20 |
| AI inference (from Phase 4) | usage-based |
| **Total to first paying user** | **≈ ₦0–₦60,000/mo** |

### What NOT to build
- ❌ iOS in year one (Android is ~85%+ of the Nigerian market)
- ❌ A web dashboard for the solo technician tier
- ❌ Payments/invoicing inside the app (send the quotation; let them transfer — this is not the wedge and it invites regulation)
- ❌ Technician marketplace / job matching (tempting, distracting, and a different company)
- ❌ Any model training or fine-tuning before 10,000 job cards

---

## 10. Risks and what we do about them

| Risk | Severity | Mitigation |
|---|---|---|
| **AI gives unsafe electrical advice** | Critical | Safety block hard-coded; human confirmation before anything enters a report; out-of-scope refusal; clear disclaimer; professional indemnity cover before V3 launch |
| **Data cost / photo upload** | High | Compress to ≤350 KB; Wi-Fi-only default upload; data-saver setting; offline-first so a bad connection never blocks work |
| **Signature capture on cheap phones** | Medium | Big canvas, stylus-friendly, "sign on the customer's phone via link" as an alternative |
| **WhatsApp PDF friction** | Medium | One-tap share sheet; also offer a verification link (much lighter than a PDF) as the default share |
| **Collecting ₦3,000 from informal technicians** | High | Annual plan via bank transfer, airtime top-up equivalents, agent collection; annual-first pricing to reduce billing events |
| **Omni Field moves down-market into Nigeria** | Medium | Our defence is depth in the single-technician workflow + the evidence/tamper chain + local equipment corpus. Pick up Business/Enterprise accounts before they arrive; be the incumbent |
| **You get pulled back into RSMS** | High | Phase 0–2 have hard dates. RSMS is a business; REHOTEQ Field is a company. Do not let one eat the other. |

---

## 11. Why REHOTEQ is the first customer — and why that is the moat

You already wrote this, and it is the strongest sentence in the whole strategy, so I'll just make it operational:

**REHOTEQ Technologies runs every job through REHOTEQ Field from Phase 1.** No exceptions, no paper fallback. Every solar install, every inverter call-out, every CCTV job.

That gives you, at zero customer-acquisition cost:
- A **real corpus** of Nigerian jobs — the V3 training data nobody else can buy
- **Checklists validated in the field** rather than invented at a desk
- **Proof that the product works**, which is the only marketing that will convince a skeptical technician
- **A portfolio of genuine reports** to show a Business customer on day one

The risks of building a product nobody wants mostly disappear when the builder is the user. That is worth more than any amount of market research.

---

## 12. Immediate next steps (this week)

1. **Confirm the name.** My recommendation: **REHOTEQ Field**. Decide and lock it.
2. **Run Phase 0.** Twenty jobs, photographed, written up by hand. This is the highest-value two weeks in the plan and costs nothing but discipline.
3. **List the top 15 faults per trade** for the curated library (60 total). You can do this from memory in an afternoon — it is V1's entire "AI."
4. **Stand up Supabase** and create the tables in `schema.sql`.
5. **Pick the PWA builder** and get a login screen on your phone by Friday.

---

## Sources

[1] Truecaller Scam Checker web launch, 28 Sep 2026 — https://tbreak.com/truecaller-scam-checker-web-launch/
[2] Truecaller's new scam checker works without an app or sign-in — https://www.absolutegeeks.com/tech-news/truecallers-new-scam-checker-works-without-an-app-or-sign-in/
[3] Omni Field Pro — AI-powered job management — https://omnifieldpro.co.za/auth
[4] Omni Field Pro — field service management locations — https://www.omnifieldpro.co.za/locations/stellenbosch
[5] FlutterFlow — local database that auto-syncs with Supabase (PowerSync) — https://blog.flutterflow.io/introducing-a-local-database-that-auto-syncs-with-supabase/
[6] FlutterFlow Review 2026 — https://hackceleration.com/labs/review/flutterflow
[7] Ecowatt Nigeria — renewable energy and solar solutions — https://ecowatt.com.ng/services/renewable-energy/
[8] SolarKobo — solar installation and maintenance — https://www.solarkobo.com/

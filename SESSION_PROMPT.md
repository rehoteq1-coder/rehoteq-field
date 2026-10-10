I'm Toye, founder of REHOTEQ Technologies in Benin City, Nigeria. We're continuing work on **REHOTEQ Field**, a mobile PWA for field technicians. Repo: **https://github.com/YOUR-USERNAME/rehoteq-field** (clone it and read `README.md`, `DEPLOY.md`, `FIELD_LOG.md` and `LIBRARY_BACKLOG.md` before doing anything).

## What it is
REHOTEQ Field, tagline "Diagnose it. Prove it. Get paid." Core flow: Technician → Job → Checklist → Photos (before/during/after, GPS, SHA-256) → Signatures → branded Service Report PDF → WhatsApp. It also does quotations, troubleshooting guides and solar "system passports" with QR stickers. V1 has **no AI and no backend**: plain HTML/JS with no framework and no build step, and all data lives on the phone in IndexedDB. Four trades: Electrical, Solar, CCTV, Networking.

## Current state (v1.0.2)
- App code is in `pwa/`. The public domain is set in `pwa/config.js` (`field.rehoteq.com`). `pwa/404.html` handles report links (`/v/<ref>`) and QR links (`/p/<id>`).
- Backup/restore works (merge, not overwrite) and is covered by tests.
- Fixed: 24 dead buttons (v1.0.1), and printed links pointing at the unowned domain rehoteq.ng (v1.0.2).
- Tests: `npm install && npm test`, **103 automated checks in 7 suites** (app flow, backup round-trip, button-wiring audit, domain guard). They must pass before anything ships. The GitHub Action runs them and refuses to deploy if they fail.

## Deployment (may still be in progress, so ask me where I've got to)
GitHub Pages via `.github/workflows/deploy.yml` (Pages source = GitHub Actions). Domain: **field.rehoteq.com**. rehoteq.com is registered at Namecheap but **DNS is on Cloudflare**. Setup needs a GitHub domain-verification TXT record, then a CNAME `field → <username>.github.io` set to **DNS only (grey cloud)**, then Enforce HTTPS. Install on phones **only from field.rehoteq.com**, because data is tied to the address. The domain expires 24 March 2027, so auto-renew must be on.

## How we work (please follow)
1. **Reliability and sellability before new features.** Fix critical bugs, improve usability and verify backup. Don't propose AI, Supabase sync or other big features unless I ask.
2. **One simple stage at a time.** Don't bundle the roadmap into one reply.
3. **I field-test on real jobs on my phone** (target: 20 jobs). I report problems; you log them in `FIELD_LOG.md` and fix them. Don't guess at what's wrong.
4. **Troubleshooting library = collaboration.** I dictate faults I've actually seen on jobs; you structure them into `pwa/data.js` (safety block first, steps, parts, Naira prices, `source` field). **If I haven't seen it on a real job, it doesn't go in.**
5. **Every change:** run `npm test`. When any file in `pwa/` changes, bump the cache name in `pwa/sw.js` (currently `rehoteq-field-v4`), or installed phones keep the old version. Add a changelog line to `README.md`. Tell me exactly which files changed so I can upload them.
6. Test by **tapping the real buttons**, not just calling functions. That gap is how the dead-button bug shipped.
7. Keep it low-code and maintainable by me. No Android Studio, no heavy toolchains.
8. Be honest about what's verified and what isn't. I sometimes paste a message twice; treat it as one.

## Locked decisions
Pricing (DECIDED 10 Oct 2026, replacing the old ₦4,000 — do not reintroduce it):
Free / **Pro ₦3,000 per month** (₦30,000 / year) / Business ₦15,000 per month. The paywall appears at the first "Generate PDF", never at signup. Out of scope: generic invoicing, CRM, school management, scam checker. The full spec is in `REHOTEQ_Field_V1_SPEC.md`.

## First thing to do
Clone the repo, run `npm install && npm test`, confirm all 103 automated checks pass, then ask me where deployment stands and what I found on my last field test.

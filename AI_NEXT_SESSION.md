# V3 in-app AI diagnosis — architecture, honesty rules, and deployment

**Status:** Built on v1.4.0 (on top of v1.3.0 Business crews).
**Rule:** Grounded in the curated REHOTEQ troubleshooting library — never a free-form chatbot, never offline-pretend, and never allowed to guess on a fault the library has not verified.

---

## What is built in code

1. **`functions/index.js` (`exports.aiProxy`) + `functions/library.js`**
   - Takes `{ trade, fault, code, equipment, measurements, uid }`.
   - **Step 1 — Out-of-scope safety classifier:** Runs first. Refuses domestic gas/LPG, structural work, medical/life-support equipment, and high-voltage utility/DISCO lines with a plain refusal and what to tell the customer.
   - **Step 2 — Curated library retrieval:** Matches against `DATA.LIBRARY`. **If the library has no verified entry for the fault, it says so plainly (`status: 'no_match'`) and never calls the model to guess.**
   - **Step 3 — Groq strict JSON ranker:** Calls Groq (`llama-3.3-70b-versatile`) using `functions.config().groq.key` with a strict JSON card schema (`possible_causes`, `checks`, `safety`, `parts`, `confidence`, `escalate_to_human`, `matched_guide_id`). Validates the schema, retries once on failure, and falls back deterministically to the verified library entry if Groq is unreachable or returns invalid JSON.
   - **Step 4 — Mandatory safety block first:** Prepends the hard-coded per-trade isolation/discharge/PPE preamble plus the matched guide's `safety` block ahead of everything else.
   - **Step 5 — Audit & flywheel logging:** Logs every call and its outcome to `ai_requests` in Firestore.

2. **`app.js` (`window.DIAG` + `V.diagnose` + unlocked V3 tile)**
   - Unlocks the **Diagnose a fault** tile on the trade action sheet (and adds a quick button on open job cards).
   - **Online-only, stated plainly:** When the phone is offline, the screen says so and offers a one-tap button to the offline Troubleshooting library.
   - **Cards out, never chat prose:** Safety warning box first, ranked cause cards with HIGH/MED/LOW badges, ordered check steps, and typical parts with Naira prices.
   - **Human in the loop:** Running a diagnosis never writes to `S.job`. Nothing enters the job card until the technician taps **Confirm cause — use on job card** on the specific cause they verified on site.

3. **`firestore.rules`**
   - Explicit `/ai_requests/{requestId}` rule block: only the server (`aiProxy`) writes log entries; clients cannot create, edit, or delete them, and a signed-in user may read only their own.

4. **`tools/draft-guide.js` (`npm run draft`)**
   - Local CLI helper for turning Toye's rough dictated notes from real jobs into a validated `DATA.LIBRARY` entry draft for review before pasting into `data.js`. Reads `GROQ_API_KEY` from the computer's environment — never stored in the repo.

---

## Where the Groq key lives (and nowhere else)

A key in chat is a copy outside your machine, and a key in this public static repository gets scraped by bots in minutes. Your Groq key has **two homes only**:

1. **Your computer's terminal environment** (for `npm run draft`)
2. **Firebase Functions config** (for `aiProxy`, typed on your terminal)

The test suite scans every shipped file, `functions/`, and `tools/` and fails the build if a Groq key, Flutterwave secret, or `sk_live_` key ever appears in source.

---

## 5 steps on your side to put `aiProxy` and the rules live

All five run on your computer (since it is your Google account and your card):

1. Upgrade `rehoteq-field` to **Blaze** in the Firebase console (free monthly allowance covers our volume; Blaze is required for outbound HTTPS calls from Cloud Functions).
2. Install the CLI and select the project:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use rehoteq-field
   ```
3. Set the Groq key in Firebase Functions config (**type on your terminal, never in chat**):
   ```bash
   firebase functions:config:set groq.key="YOUR_GROQ_KEY_HERE"
   ```
4. Deploy security rules and Cloud Functions together:
   ```bash
   firebase deploy --only firestore:rules,storage:rules,functions
   ```
5. Paste the terminal output (without the key command) back so we can verify every rule and function deployed cleanly.

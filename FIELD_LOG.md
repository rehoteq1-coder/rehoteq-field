# Field test log — 20 real REHOTEQ jobs

**How to use this:** after each job, spend two minutes filling in one row.
Don't tidy it up — the messier the note, the more useful it is. If something
made you swear, write down exactly what you were doing when it happened.

## What a good bug report looks like

> ❌ "Photos didn't work."
>
> ✅ "After拍照 the third photo, the app went back to the job card and the
> photo was gone. Tecno Spark 10, Android 13, site had no network."

The second one I can fix in ten minutes. The first one I can't.

**Always tell me:** what you tapped, what you expected, what happened, and
the phone model. Screenshots help more than descriptions.

---

## Job log

| # | Date | Trade / job type | Phone | What went well | What broke or annoyed me | Severity | Status |
|---|------|------------------|-------|----------------|--------------------------|----------|--------|
| 1 |      |                  |       |                |                          |          |        |
| 2 |      |                  |       |                |                          |          |        |
| 3 |      |                  |       |                |                          |          |        |
| 4 |      |                  |       |                |                          |          |        |
| 5 |      |                  |       |                |                          |          |        |
| 6 |      |                  |       |                |                          |          |        |
| 7 |      |                  |       |                |                          |          |        |
| 8 |      |                  |       |                |                          |          |        |
| 9 |      |                  |       |                |                          |          |        |
| 10 |     |                  |       |                |                          |          |        |
| 11 |     |                  |       |                |                          |          |        |
| 12 |     |                  |       |                |                          |          |        |
| 13 |     |                  |       |                |                          |          |        |
| 14 |     |                  |       |                |                          |          |        |
| 15 |     |                  |       |                |                          |          |        |
| 16 |     |                  |       |                |                          |          |        |
| 17 |     |                  |       |                |                          |          |        |
| 18 |     |                  |       |                |                          |          |        |
| 19 |     |                  |       |                |                          |          |        |
| 20 |     |                  |       |                |                          |          |        |

**Severity:** `blocker` = I couldn't finish the job ·
`annoying` = slowed me down but I got there ·
`nitpick` = polish, can wait

---

## Questions I especially need answered

Answer these as they come up, not at the end.

- [ ] Did you finish the whole job **without any network**? What broke?
- [ ] Was the **PDF** something you'd actually send to a customer? What's missing?
- [ ] Did the **customer** understand the report? What did they ask about?
- [ ] How long from "job finished" to "PDF sent"? Target is under 2 minutes.
- [ ] Did **voice dictation** work, and did it understand Nigerian English/accents?
- [ ] Did the **camera** behave in bright sun / dark DB rooms?
- [ ] Did the **signature pad** work with a customer holding the phone?
- [ ] Did anyone ask "why do I need this?" — and what did you say?
- [ ] Would you pay ₦3,000/month for it? If not, what's missing?

---

## Open problems (I'll maintain this list)

| # | Problem | Severity | Reported | Fix | Status |
|---|---------|----------|----------|-----|--------|
| 001 | Most feature buttons don't respond | **Blocker** | Toye, first look on phone | `go()`/`toast()` weren't exposed to the page — 17 of 36 real taps threw `ReferenceError`. Exposed both; added a wiring audit to the tests. | ✅ Fixed v1.0.1 |
| 002 | PDFs and QR stickers linked to rehoteq.ng, an unregistered domain anyone could buy | **Critical** | Found while connecting field.rehoteq.com | All links moved to field.rehoteq.com via `config.js`; added `404.html` landing pages for /v/ and /p/; domain guard in tests | ✅ Fixed v1.0.2 |
|   |         |          |          |     |        |

---

## Known issues already on my list

These are **mine**, not things you need to re-report:

1. **No restore yet** — the app can export your data but cannot import it back.
   Fixed in the build after this one. Do not rely on export alone until then.
2. **Photos missing from export** — the JSON export contains photo records but
   not the images themselves. Being fixed at the same time.
3. **₦ renders as "NGN"** inside the PDF (a font-encoding limit, not a bug).
4. **Voice dictation** needs Chrome on Android; Safari/Firefox won't do it.
5. **Free plan allows 3 completed reports**, then the paywall fires.

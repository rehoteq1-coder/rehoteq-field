# Where your data lives

Plain English, because this is the one thing you need to understand before you
put twenty real customers on this app.

## Short version

**Every job you create is stored on the phone you created it on. Nowhere else.**

There is no server. There is no cloud. There is no copy at REHOTEQ. Nobody —
not me, not a hacker, not REHOTEQ — can see your customers from the internet,
because your customers are not on the internet.

That is why the app works in a basement with no signal and costs you nothing
per job. It is also why **losing the phone loses the jobs.**

## What is on the phone

| What | Where it lives |
|------|----------------|
| Job cards, customers, checklists, signatures, quotations | Phone storage |
| Photos (before / during / after / serial) | Phone storage |
| Equipment register + solar passports | Phone storage — rebuilt from your job serials, not stored separately |
| Your name, phone, trade, Pro status | Phone storage |

The equipment register is the one worth explaining: it is not a separate list
that could get out of step. It is worked out from the serials on your job
cards, so if the jobs are safe, the passports are safe.

## How you lose it

All of these destroy the data, and none of them warn you:

- the phone is lost or stolen
- the phone is reset
- **clearing the browser's "site data" / browsing data** for the app
- uninstalling the app
- a failed Android update, occasionally

Low battery, no network, closing the app, restarting the phone — **none of
these lose anything.** The data survives all of them. Connectivity is not the
risk here; the device is.

## The backup — and the trap

Settings → **Backup** gives you two ways out.

**✅ Send backup off this phone** — *this is the real one.* It hands the file
to WhatsApp, email, Drive, anywhere off the device. Use this one.

**⚠️ Download backup** — this saves the file to the phone's own Downloads
folder. That is not a backup. If the phone dies, the backup dies with it. Use
it only to then move the file somewhere else yourself.

A backup file is only safe somewhere **other** than the phone that made it.

### How often

Ideally after every job — it takes ten seconds. At minimum, once a week. The
app will start nudging you once you have three or more jobs and have never
backed up, and again after ten jobs if the backup is more than a week old. Do
not wait for the nudge.

## Restoring

Settings → Backup → restore. Pick the file the app gave you.

It **merges** rather than replaces: if the phone already has newer jobs, they
survive. A restore cannot destroy work by accident.

If a photo's image data was lost along the way, the job card and the record
of the photo still come back — the picture itself will be blank. The app tells
you how many came back missing.

## What is *not* in the backup

Almost nothing. The job cards carry their own customers and equipment, your
profile carries your Pro status, and the equipment register rebuilds itself.

The one thing that does not come back is the **"last backed up" date**, which
simply resets. Harmless.

## If you want a copy that survives without thinking about it

That needs a server, which means a monthly cost and a Supabase account. It is
deliberately not built — see the "Out of scope" list in the README. Until
then: **send the backup off the phone, and it is fine.**

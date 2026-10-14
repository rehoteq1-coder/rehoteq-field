# Where your data lives

Plain English, because this is the one thing you need to understand before you
put twenty real customers on this app.

## Short version

**Every job you create is stored on the phone you created it on.** Nothing
leaves the phone unless you send it.

There is no copy at REHOTEQ. Nobody — not me, not a hacker, not REHOTEQ — can
see your customers from the internet, because they are not on the internet.

Two things you can *choose* to do send a copy somewhere: sharing a backup file
(WhatsApp, email, Drive), and — if you sign in with Google — **the cloud backup
in v1.9.0**, which puts one file in **your own** Google account's storage. Both
are started by you, on a tap, and both can be ignored forever: the app works
completely without an account.

That is why the app works in a basement with no signal and costs you nothing
per job. It is also why **losing the phone loses the jobs unless you backed
them up.**

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

## The cloud backup (v1.9.0) — your account, not REHOTEQ's

Settings → Backup → **Back up this phone to the cloud**, if you are signed in
with Google. One tap, and it says the date when it is done.

Where it goes: `users/{your-uid}/cloud-backup/latest.zip` in the app's storage
bucket, plus a small label in the database. Both are readable by **your Google
account and nobody else** — the rules are written so that even REHOTEQ cannot
read another technician's backup, and so that no one can overwrite yours.

What it is: one zip with the job cards, the photos, your profile and your crew.
It opens in any unzip tool on any phone or laptop — you are not locked in.

What it is not: automatic. It is a tap, not a subscription. Nothing is uploaded
until you tap it, and the file is overwritten the next time you do.

## Restoring

Settings → Backup → restore. Pick the file the app gave you.

On a new or wiped phone, sign in with the **same Google account** and tap
**Restore from the cloud** — the boot screen offers it the moment you sign in
if a backup is waiting. It asks before it changes anything.

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

The cloud backup is the closest thing to it: one tap, and the copy is in your
own Google account rather than on the phone. It is still a tap — make it the
last thing you do before you put the phone in your pocket.

Anything more automatic (a sync that happens by itself, on every job) needs a
server with a monthly cost. It is deliberately not built — see the "Out of
scope" list in the README. Until then: **tap the backup, and it is fine.**

# Putting REHOTEQ Field on GitHub

Once this is done the app lives at **`https://field.rehoteq.com`**, served free by
GitHub Pages. Every change after that
is upload → wait about 2 minutes → live. No server to keep running.

Tests run automatically before every deploy. **If a change breaks the app,
GitHub refuses to publish it** and your phone keeps the last working version.

---

## One-time setup (about 10 minutes, all in the browser)

### 1. Create the repo
- github.com → **+** (top right) → **New repository**
- Name: `rehoteq-field`
- **Public** (GitHub Pages is free for public repos. Private repos need a paid plan.)
- Leave "Add a README" **unticked** — we already have one
- **Create repository**

> Public means anyone can read the code. Your **customer data is not in it**:
> that lives only on each phone, in IndexedDB. If you want the code private
> later, GitHub Pro is about $4/month, or we move hosting.

### 2. Upload the files
- Unzip `rehoteq-field-repo.zip` on your computer
- On the empty repo page, click **"uploading an existing file"**
- Open the unzipped folder, select **everything inside it**, and drag it into
  the browser — including the `.github` folder
- Commit message: `REHOTEQ Field v1.0.1` → **Commit changes**

> ⚠️ **The `.github` folder is hidden by default.** On Windows: View → tick
> *Hidden items*. On Mac: press **Cmd + Shift + .** in Finder.
> If it doesn't upload, nothing deploys. To check: the repo should show a
> `.github` folder at the top of the file list. If it's missing, see
> *"If the .github folder won't upload"* at the bottom.

### 3. Turn on Pages
- In the repo: **Settings → Pages**
- Under **Source**, choose **GitHub Actions** (*not* "Deploy from a branch")
- That's it — no other settings

### 4. Watch it go live
- Click the **Actions** tab. You'll see "Test and deploy" running.
- **Green tick** = live. Click into it — the deploy step shows your URL.
- **Red cross** = something failed. Screenshot it and send it to me.

### 5. Don't install yet
It's live at `YOUR-USERNAME.github.io/rehoteq-field/`, and you can open it to
check. But **install from field.rehoteq.com only** (next section), because
job data stays tied to the address you installed from.

---

## Making changes later

**When I send you updated files:**
1. Open the file in the repo on GitHub (e.g. `pwa/app.js`)
2. Pencil icon ✏️ → select all → paste the new version — *or* use
   **Add file → Upload files** and drop the new file in to replace it
3. **Commit changes**
4. Wait for the green tick in **Actions**
5. On your phone: close the app fully and reopen it **twice**
   (the first open downloads the update, the second one shows it)

**Golden rule:** whenever `app.js` changes, the version line at the top of
`pwa/sw.js` must change too (e.g. `rehoteq-field-v4` → `v5`). Otherwise installed
phones keep serving the old app for days. I'll always include it — just don't
skip it if you edit anything yourself.

---

## Connect field.rehoteq.com (do this before job #1)

> ### ⚠️ Your DNS is on **Cloudflare**, not Namecheap
> rehoteq.com is *registered* at Namecheap, but its nameservers are
> `burt.ns.cloudflare.com` and `hazel.ns.cloudflare.com`. **Records added in
> Namecheap's panel do nothing.** Everything below happens in Cloudflare.
> Your website and email (Namecheap Private Email) are untouched.

**Order matters: GitHub first, then Cloudflare.** If the DNS record exists
before GitHub knows about the domain, someone else's GitHub repo could claim it.

### A. Verify the domain with GitHub (one time, stops takeover)
1. GitHub → your **profile picture → Settings** (account settings, not the repo)
2. **Pages** in the left menu → **Add a domain** → `rehoteq.com` → Add
3. GitHub shows a **TXT** record. Copy the name (`_github-pages-challenge-…`)
   and the value
4. Cloudflare → rehoteq.com → **DNS → Records → Add record**
   - Type `TXT` · Name: paste the challenge name (without `.rehoteq.com`) · Content: paste the value
5. Back in GitHub, click **Verify**. Can take a few minutes.

### B. Tell the repo its domain
1. Repo → **Settings → Pages → Custom domain** → `field.rehoteq.com` → **Save**
2. It will complain that DNS isn't set up yet. That's expected.

### C. Point the subdomain at GitHub
Cloudflare → rehoteq.com → **DNS → Records → Add record**

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `field` |
| Target | `YOUR-GITHUB-USERNAME.github.io` *(no repo name, no https)* |
| Proxy status | **DNS only, grey cloud** ☁️ |
| TTL | Auto |

> **The grey cloud matters.** With the orange cloud on, GitHub can't issue
> the HTTPS certificate and you get a "too many redirects" error. Leave it
> grey. GitHub provides HTTPS and its own CDN.

### D. Switch on HTTPS
1. Wait 5–30 minutes. Repo → Settings → Pages should say *"DNS check successful"*
2. Tick **Enforce HTTPS** (greyed out until the certificate is ready, which
   can take up to an hour)
3. Open **https://field.rehoteq.com** on your phone → ⋮ → **Install app**

### Test that it worked
- `https://field.rehoteq.com` → the app opens
- `https://field.rehoteq.com/v/RF202600184` → the "Service report check" page
- `https://field.rehoteq.com/p/test` → the "System passport" page

Those last two are the pages customers land on from a report or a QR sticker.

### 📅 Renewal: put this in your calendar now
**rehoteq.com expires 24 March 2027.** Every PDF you send and every QR sticker
you put on a customer's inverter carries `field.rehoteq.com`. If the domain
lapses, all of them break, and someone else can buy it and take over those
links. **Turn on auto-renew in Namecheap** (Domain List → rehoteq.com →
Auto-Renew ON) and keep a valid card on file.

---

## If the `.github` folder won't upload

Some browsers skip hidden folders. Create the file by hand instead:

1. In the repo: **Add file → Create new file**
2. In the name box, type exactly: `.github/workflows/deploy.yml`
   (typing the `/` creates the folders)
3. Paste in the contents of `deploy.yml` from the zip
4. **Commit changes**

---

## Running the tests yourself (optional)

Needs Node.js 22+:

```
npm install
npm test
```

You should see `>>> ALL CHECKS PASSED`. GitHub runs exactly this on every push.

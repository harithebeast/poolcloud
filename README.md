# PoolDrive

**Turn several free Google accounts into one big drive.**

Each free Google account gives you about 15 GB. PoolDrive links several of them and shows them as **one
storage space** with a Google Drive–style website. Upload a file and PoolDrive puts it in whichever account
has the most room. If a file is too big for any single account, it is split into pieces across accounts and
joined back together when you download it. You always get exactly the file you uploaded.

You run PoolDrive on your own computer. Your files go straight from your computer to your own Google
accounts; there is no PoolDrive company server in between.

> **Status:** feature-complete for everyday use (sign-in, upload, folders, preview, sharing, trash,
> encryption, storage page). A final hardening pass is still planned. See [What is and is not done](#what-is-and-is-not-done).

---

## Contents

1. [What you get](#what-you-get)
2. [Before you start](#before-you-start)
3. [Setup, step by step](#setup-step-by-step)
4. [Using PoolDrive](#using-pooldrive)
5. [Which Gmail holds my file?](#which-gmail-holds-my-file)
6. [Everyday commands](#everyday-commands)
7. [If something goes wrong](#if-something-goes-wrong)
8. [Questions people ask](#questions-people-ask)
9. [What is and is not done](#what-is-and-is-not-done)
10. [For developers](#for-developers)

---

## What you get

- One combined storage bar that adds up all your linked Google accounts.
- Upload by clicking **New** or by dragging files (or whole folders) onto the page. A progress panel shows each upload.
- Folders, rename, move (drag onto a folder), search by name, grid and list views, dark mode.
- Preview images, PDFs, text, video and audio without downloading.
- **Trash** with restore, and automatic deletion after 30 days.
- **Share links** you can protect with a password, set to expire, or switch off at any time.
- Optional **encryption**: files are scrambled before they reach Google, so Google only ever holds unreadable data.
- A **Storage** page that shows each Google account, how full it is, tells you if one needs attention, and lets you **remove** an account safely (its files are moved to your other accounts first).
- You can see **which Gmail account stores each file** (admin only, see [below](#which-gmail-holds-my-file)).

## Before you start

You need:

| What                                        | Why                                                | Where to get it                                   |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| A Windows, Mac or Linux computer            | PoolDrive runs on it                               |                                                   |
| **Docker Desktop**                          | Runs PoolDrive's parts for you, no manual installs | <https://www.docker.com/products/docker-desktop/> |
| **Node.js 22** (only for one small command) | Creates your secret keys                           | <https://nodejs.org/> (pick "LTS")                |
| **Git**                                     | Downloads the project                              | <https://git-scm.com/downloads>                   |
| **2 or more Google accounts**               | The storage itself. Free accounts are fine         | Create extra Gmail accounts if you need them      |

Docker Desktop must be **running** (the whale icon in the tray) whenever you use PoolDrive.

## Setup, step by step

### Step 1: Download the project

Open a terminal (PowerShell on Windows, Terminal on Mac) and run:

```sh
git clone https://github.com/harithebeast/poolcloud.git
cd poolcloud
```

### Step 2: Create your secret keys

```sh
node scripts/init-env.mjs
```

This creates a file called `.env` with randomly generated passwords and an encryption key. It never overwrites an existing `.env`.

> **Important: back up the line that starts with `MASTER_KEYS=` somewhere safe** (a password manager is ideal).
> If you lose it, any file you encrypted can **never** be opened again, not even by you.
> Never share your `.env` file or put it on GitHub. It is already excluded from git.

### Step 3: Let PoolDrive talk to Google (one time)

PoolDrive needs permission from Google to store files in your accounts. This is free and takes about 10 minutes.
Follow the walkthrough in **[docs/google-setup.md](docs/google-setup.md)**. In short, you will:

1. Create a free project in Google Cloud Console and turn on the **Google Drive API**.
2. Set up the "consent screen" and add your Gmail addresses as **test users**.
3. Create an **OAuth client** and register this exact redirect address:

   ```
   http://localhost:4400/api/v1/accounts/google/callback
   ```

4. Paste the client ID and secret into your `.env` file:

   ```
   GOOGLE_CLIENT_ID=...your id...
   GOOGLE_CLIENT_SECRET=...your secret...
   ```

   Never paste these anywhere public.

Just want to look around first? Put `STORAGE_PROVIDER=fake` in `.env`. PoolDrive then pretends to have three
15 GB accounts in memory, with no Google needed. Files disappear when you restart, so it is only for trying things out.

### Step 4: Start it

```sh
docker compose up --build -d
```

The first run takes a few minutes while it builds. When it is done, check everything is healthy:

```sh
docker compose ps
```

You should see five services (`api`, `web`, `worker`, `postgres`, `redis`) all marked **healthy**.

### Step 5: Open the website

Go to **<http://localhost:3000>**.

The very first time, you will see **Create the admin account**. Enter your email and a password of **at least 12 characters**.
This account manages the storage pool. There is no public sign-up; the admin creates other users if you ever need them.

### Step 6: Link your Google accounts

1. Click **Storage** in the left menu.
2. Click **Link a Google account**.
3. Choose the Gmail account and approve the permission screen. Google may say the app is "not verified"; that is normal for
   your own private project. Click **Continue**.
4. You are sent back to PoolDrive, which shows the account and its space.
5. Repeat for each account. The bar at the top of the Storage page now shows the combined total.

You are ready. Go to **My files** and upload something.

## Using PoolDrive

| I want to...                    | Do this                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Upload files                    | **New → Upload files**, or drag files and folders onto the page                                         |
| Make a folder                   | **New → New folder**                                                                                    |
| Open a folder or preview a file | Double-click it                                                                                         |
| Download                        | Click the **⋮** next to a file, then **Download**                                                       |
| Rename, move, share, delete     | Right-click a file (or use **⋮**)                                                                       |
| Select many things              | Click the first, hold **Shift** or **Ctrl** and click others, then use the menu or drag them            |
| Move by dragging                | Drag a file onto a folder, or onto a folder name at the top                                             |
| Search                          | Type in the box at the top                                                                              |
| Get a file back after deleting  | **Trash** → **Restore**                                                                                 |
| Share with someone              | Right-click → **Share** → choose expiry or password → **Create link** → copy it                         |
| Stop sharing                    | Right-click → **Share** → **Revoke** next to the link                                                   |
| Encrypt files                   | **New → Encrypt new uploads** (tick it), or right-click a folder → **Encrypt new files in this folder** |
| See details                     | Click the **ⓘ** button at the top right, then click a file                                              |

Tips:

- A share link is shown **once**, right after you create it. Copy it then.
- Deleted items stay in **Trash** for 30 days, then are removed for good (and the space is freed in Google).
- Keyboard: arrow keys to move, **Enter** to open, **Delete** to trash, **F2** to rename, **Ctrl+A** to select all.

## Which Gmail holds my file?

PoolDrive makes your accounts look like one drive, but sometimes you want to know where a file really is.

1. Click the **ⓘ** (details) button at the top right of **My files**.
2. Click a file.
3. Look at **Stored in**. It lists the Gmail address(es) holding that file:
   - **Whole file** means the entire file is in that one account.
   - **3 parts** (or similar) means the file was too big for one account and was split. Every account holding a piece is listed.
   - **offline** next to an address means that account needs attention.

Only the **admin** sees this. Other users never see which Gmail accounts exist.

If a file is split and any one of its Gmail accounts is offline, **that file cannot be opened** until the account is reconnected,
because there is no spare copy. Small files that live whole in a healthy account are not affected. PoolDrive warns you in the
file list and on the Storage page when this happens, and **Re-authorise** on the Storage page fixes it. Nothing is ever deleted
when an account goes offline.

## Everyday commands

Run these in the project folder.

| Task                             | Command                                        |
| -------------------------------- | ---------------------------------------------- |
| Start                            | `docker compose up -d`                         |
| Stop (keeps all your data)       | `docker compose stop`                          |
| Start again after stopping       | `docker compose start`                         |
| See if it is healthy             | `docker compose ps`                            |
| Watch the API's log              | `docker compose logs -f api`                   |
| Watch everything                 | `docker compose logs -f`                       |
| Last 10 minutes of the API's log | `docker compose logs api --since 10m`          |
| Update after getting new code    | `git pull` then `docker compose up --build -d` |

The website is at <http://localhost:3000>; the API it talks to is at <http://localhost:4400>.

## If something goes wrong

**The page just says "Loading..." forever.**
Your browser cannot reach the API. Open <http://localhost:4400/health/ready>. If that does not show `"status":"ok"`, run
`docker compose ps` and `docker compose logs api`. If another program on your computer already uses port 4400, set
`API_HOST_PORT` (and `PUBLIC_API_URL`, and the Google redirect address) to a free port, then `docker compose up --build -d`.

**"Validation failed" or a password error when creating the account.**
The password must be at least 12 characters.

**Google says `redirect_uri_mismatch`.**
The address registered in Google Cloud must match this one exactly (no extra slash, `http` not `https`):
`http://localhost:4400/api/v1/accounts/google/callback`. After saving it in Google, wait a few minutes.

**Google says "Access blocked" or "app not verified" and will not continue.**
Add that Gmail address under **OAuth consent screen → Test users** in Google Cloud Console.

**An account suddenly shows "Needs re-authorisation".**
Normal while your Google app is in "Testing" mode: Google expires its access every 7 days. Click **Re-authorise** on the Storage page
and sign in with the _same_ Google account. Publishing the consent screen (see the Google setup guide) stops the weekly expiry.

**"Not enough free space".**
All linked accounts are full, or only their safety margin is left. Link another account, or empty the Trash. PoolDrive keeps 5% of each
account free on purpose, because Gmail and Photos share that same 15 GB.

**Nothing works after restarting my computer.**
Start Docker Desktop first, wait until it says it is running, then `docker compose up -d`.

**It uses too much memory.**
Run `docker compose stop` when you are not using it. To cap Docker's memory on Windows, create `C:\Users\<you>\.wslconfig` containing
`[wsl2]` and `memory=2GB`, then run `wsl --shutdown`.

More detail is in [docs/runbook.md](docs/runbook.md).

## Questions people ask

**Is it safe? Can Google see my files?**
Files you do **not** encrypt are stored as ordinary (but randomly named) files inside a folder in your own Google Drive, so Google can
read them like anything else in your Drive. Files you **do** encrypt are scrambled with AES-256 before upload, so Google only holds
unreadable data. Real file names are never sent to Google at all.

**Can PoolDrive see my whole Google Drive?**
No. It only asks for permission to touch files **it created itself** (Google's `drive.file` permission). Your other Drive files and your
Gmail are not accessible to it.

**Where are my folders and file names kept?**
In a database on your own computer (the `postgres` container). Google only holds the file contents. So **back up that database** and your
`.env` (see below); without them the pieces in Google cannot be put back together.

**Do I lose files if one Google account breaks?**
Files stored whole in other accounts are fine. Files that have a piece in the broken account are unavailable until it is reconnected.
There is no duplicate copy in this version. If an account is permanently lost, the files that were stored in it are lost too.

**How do I back up?**
Keep a copy of your `.env` (especially `MASTER_KEYS`), and dump the database:

```sh
docker compose exec postgres sh -c "pg_dump -U pooldrive pooldrive > /tmp/backup.sql"
docker compose cp postgres:/tmp/backup.sql ./backup.sql
```

**Can other people use it?**
The admin can create extra users, and you can share files by link. Everyone uses the same pooled Google accounts, which only the admin manages.

**Does it cost anything?**
No. Free Google accounts, free software, and it runs on your own computer.

## What is and is not done

Working today, and tested automatically (about 190 server tests, 27 browser tests including accessibility checks, a load test, and a 5 GB
streaming check that stays under 300 MB of memory):

- Sign-in and first-run setup, pooled storage, whole-file and split-file storage, encryption, trash, sharing, search, previews, alerts,
  background cleanup, and the storage page.

Not finished or not in this version:

- **No second copy of files**: a split file depends on all its accounts being online.
- **Two-factor login (TOTP)** is only a placeholder.
- **Sharing whole folders** is not available (single files only).
- Uploads cannot resume part-way after a dropped connection; they restart (safely, without duplicates).
- The connection to real Google has been built from Google's documentation and tested with a stand-in. Follow
  [docs/google-setup.md](docs/google-setup.md) carefully the first time and report anything unexpected.

## For developers

Everything below is optional if you only want to use the app.

```sh
corepack enable && pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
pnpm test                 # unit tests; database-backed tests skip without TEST_DATABASE_URL
```

Most API tests need a PostgreSQL where the user can create databases (each test file gets its own temporary one):

```sh
docker run -d --rm --name pooldrive-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:17-alpine
export TEST_DATABASE_URL=postgres://test:test@localhost:55432/test
pnpm --filter @pooldrive/api test:ci               # full suite plus the 80% coverage gate
SIZE_GB=1 pnpm --filter @pooldrive/api test:memory # streams N GB through the API and checks peak memory
```

Browser tests (Playwright, with accessibility checks) run on a separate stack that pretends to be Google. See
[docs/runbook.md](docs/runbook.md#verifying-a-release).

| Path              | What                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`        | NestJS (Fastify) API, storage core, database schema, job logic                                                                                                                                   |
| `apps/worker`     | Background jobs (cleanup, quota sync, trash purge, orphan scan)                                                                                                                                  |
| `apps/web`        | Next.js website                                                                                                                                                                                  |
| `packages/shared` | Shared configuration and types                                                                                                                                                                   |
| `docs`            | [Plan](docs/PLAN.md), [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [runbook](docs/runbook.md), [Google setup](docs/google-setup.md), [decisions (ADRs)](docs/adr) |

The interactive API reference is at <http://localhost:4400/docs> when the API runs outside production mode.

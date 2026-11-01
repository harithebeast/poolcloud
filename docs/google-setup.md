# Google setup

PoolDrive talks to Google only to store blobs in the Drive of the accounts you link. You need one OAuth
client for the whole installation. Skip this entire page while developing with `STORAGE_PROVIDER=fake`.

## 1. Create the project and enable the API

1. Open <https://console.cloud.google.com/> and sign in with any Google account (it does not have to be one you will link).
2. Project picker -> **New project** -> name it `pooldrive` -> **Create**, then select it.
3. **APIs & Services -> Library** -> search **Google Drive API** -> **Enable**.

## 2. Configure the OAuth consent screen

1. **APIs & Services -> OAuth consent screen** (may appear as **Google Auth platform -> Branding**).
2. User type **External** -> **Create**.
3. App name `PoolDrive`, a support email and a developer contact email. Logo and domains are not needed.
4. **Scopes** (Data access): add
   - `https://www.googleapis.com/auth/drive.file`
   - `openid` and `.../auth/userinfo.email` (to identify which Google account was linked)

   `drive.file` is non-sensitive: PoolDrive can only see files it created itself, never the rest of the user's Drive (see ADR-0003).

5. **Test users** (Audience): add the Gmail address of **every account you will link**. Only listed users can authorise while the app is in _Testing_.

### Testing vs. published

|                       | Testing                                    | In production                                            |
| --------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Who can link          | Only the listed test users (max 100)       | Anyone with the link (shows an "unverified app" warning) |
| Refresh token life    | **7 days**, then the account goes DEGRADED | Until revoked                                            |
| Verification required | No                                         | Not for non-sensitive scopes only                        |

For a personal pool, click **Publish app** on the consent screen once everything works. With only the
non-sensitive `drive.file`, `openid` and `email` scopes it does not need Google verification, and refresh
tokens stop expiring weekly. While in Testing, PoolDrive shows the account as DEGRADED when a token expires and
offers one-click re-authorise.

## 3. Create the OAuth client

1. **APIs & Services -> Credentials -> Create credentials -> OAuth client ID**.
2. Application type **Web application**, name `pooldrive-web`.
3. **Authorised redirect URIs** -> add exactly:

   ```
   http://localhost:4400/api/v1/accounts/google/callback
   ```

   For a deployment, add `https://<your-api-host>/api/v1/accounts/google/callback` as well.

4. **Create**, then copy the client ID and secret.

## 4. Configure PoolDrive

Put the values in `.env` (never commit it; it is git-ignored):

```
GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client secret>
STORAGE_PROVIDER=google
```

Restart the stack: `docker compose up -d`. Then open the app -> **Storage -> Add account** for each Gmail account.
Sign in as the account to link, tick the Drive permission, and consent. Repeat for 3 or more accounts.

If you only see "Access blocked: PoolDrive has not completed the Google verification process", the account is not in the
test-user list (step 2.5) or the app is neither in Testing nor published.

## Known Google limits

- A free account has 15 GB **shared** with Gmail and Photos, so real free space can be lower than 15 GB. PoolDrive reads
  the real quota from `about.get` rather than assuming 15 GB.
- Drive allows about 750 GB of uploads per account per day, and rate-limits with 403/429. PoolDrive retries with backoff.
- Revoking access at <https://myaccount.google.com/permissions> marks the account DEGRADED; re-authorise from the Storage page.
- `drive.file` access to `about.get` is documented but unverified here; confirm with the first real link (tracked in PLAN.md Risks).

# Lead CRM

Self-hosted CRM: leads, pipeline (kanban), automated email sequences with open/click/bounce/reply tracking, unsubscribe handling, and stats. Runs 24/7 on Railway — nothing depends on your local machine.

**Stack:** Node.js 20+, Express, PostgreSQL, Prisma, Resend (email), vanilla-JS dashboard (Hebrew RTL), node-cron scheduler inside the same service.

## How it works

| Piece | Where it runs |
|---|---|
| Web UI + API | Railway service (`npm start`) |
| Scheduler (every minute) | Same Railway service — materializes due sequence steps, sends queued email (throttled + daily cap), flags stale leads |
| Data | Railway Postgres |
| Email + tracking | Resend → webhooks back to `/webhooks/email` |

**No duplicate sends.** Each sequence step becomes exactly one `EmailMessage` row with a unique key `enr:<enrollmentId>:step:<n>`, claimed via a conditional update. Sending claims rows with `FOR UPDATE SKIP LOCKED`, and the same key is passed to Resend as its `Idempotency-Key`, so a crash between "provider accepted" and "DB marked SENT" is retried safely after 10 minutes. A Postgres advisory lock means only one replica runs a tick at a time.

**Auto rules:** first email sent → `NEW→CONTACTED`; click or reply → `ENGAGED` (forward-only, never touches WON/LOST). Reply, bounce, spam complaint or unsubscribe stops all sequences. No activity for `STALE_DAYS` → flagged "רדום" (cleared on next activity).

## Local setup

```bash
npm install
cp .env.example .env            # fill in values; EMAIL_PROVIDER=mock to skip real sending
npm run hash-password -- "a-long-password"   # paste output into ADMIN_PASSWORD_HASH
set -a; . ./.env; set +a
npm start                       # runs migrations, then the server on :3000
```

Tests (need a throwaway Postgres DB; it will be wiped):

```bash
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/crm_test \
DATABASE_URL=$TEST_DATABASE_URL npm test
```

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. In the project: **+ New → Database → PostgreSQL**.
4. Service → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_URL` = the public URL (Settings → Networking → **Generate Domain**, or your custom domain)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` (`openssl rand -hex 32`)
   - `RESEND_API_KEY`, `EMAIL_FROM`, `WEBHOOK_SECRET` (step 6)
   - `NODE_ENV=production`, optional `DAILY_SEND_CAP`, `SENDS_PER_MINUTE`, `STALE_DAYS`
5. Deploy. `railway.json` sets the start command (`prisma migrate deploy && node src/server.js`) and the `/healthz` health check. Keep **1 replica** (more is safe thanks to the advisory lock, but unnecessary). Don't enable "serverless/app sleeping" — the scheduler needs the process running.
6. **Resend webhook:** Resend → Webhooks → Add endpoint
   - URL: `https://<your-app>/webhooks/email`
   - Events: `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained` (+ `email.received` if you use Resend inbound for replies)
   - Copy the signing secret (`whsec_…`) into `WEBHOOK_SECRET` and redeploy.
   - Open/click tracking must be enabled on the domain in Resend.

## Domain DNS (deliverability)

Add your sending domain in Resend → Domains and create **exactly** the records it shows at your DNS provider:

| Type | Name (typical) | Purpose |
|---|---|---|
| MX | `send` | bounce/feedback handling (SPF return-path) |
| TXT | `send` | SPF: `v=spf1 include:amazonses.com ~all` (use Resend's value) |
| TXT | `resend._domainkey` | DKIM public key (from Resend) |
| TXT | `_dmarc` | DMARC — you add this yourself, start with `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`, move to `p=quarantine` once reports look clean |

Wait for "Verified" in Resend before sending. Warm up gradually (low `DAILY_SEND_CAP` for the first weeks).

## Replies

Reply detection works two ways:
- **Manual:** "סמן שהשיב" button on the lead (stops sequences, moves to ENGAGED).
- **Automatic:** if your Resend account supports receiving email, route replies to a Resend inbound address (set it as Reply-To or receive on your domain) and subscribe the webhook to `email.received`. The sender address is matched to a lead by email.

## CSV import

Headers in English or Hebrew: `name/שם, email/אימייל, phone/טלפון, company/חברה, source/מקור, tags/תגיות, notes/הערות, owner/אחראי`. Duplicates (within the file or already in the DB, case-insensitive) are skipped and reported. UTF-8 (with or without BOM).

## Template variables

`{{name}}`, `{{first_name}}`, `{{company}}`, `{{email}}`. Every email gets an unsubscribe link plus `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058 one-click, used by Gmail/Outlook). The unsubscribe page requires a button click so link scanners can't unsubscribe people.

## Known limitations

- Single admin user (by design).
- Daily cap resets at 00:00 UTC.
- Drag-and-drop on the board uses HTML5 DnD (desktop); on mobile, change the stage from the lead panel.
- Login throttling is in-memory (resets on redeploy).
- Funnel uses current stage as a proxy for "reached at least this stage".
- Open rates are approximate (Apple Mail Privacy Protection inflates opens).

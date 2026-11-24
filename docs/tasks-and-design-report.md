# CRM Tasks & Follow-ups + Design System: report (2026-11-24)

Repo: `lead-crm` (cloned to `Co-Work OS\lead-crm`). Nothing committed, pushed or deployed. A push to `main` deploys to Railway.

## Findings (existing system)
- Express + Prisma + Postgres, vanilla JS UI. `/followups` is the "היום" tab, driven by `Lead.nextAction` / `Lead.nextFollowUpAt` (one next step per lead, 5-day follow-up after a sent mail, 2-day reply task on a received mail).
- Lead management at `/gmdss` is a separate table (`GmdssLead`) with its own follow-up date. Tasks link to the main `Lead` (as the spec says "existing Leads"), not to `GmdssLead`.
- Activity history = `Activity` rows. Emails stay in `EmailMessage` / `Activity`; tasks never copy email content.

## Design decisions
- New `Task` table. `Lead.nextAction` / `nextFollowUpAt` are kept as a mirror of the single active Next Action task, so the old list, import and mail code keep working unchanged. Old code paths call `reconcileFromLead()` after they write those fields (idempotent, never a second Next Action).
- One active Next Action per lead is enforced by a partial unique index and in the API.
- Overdue is computed (Israel date < today and status not Completed/Cancelled). "This week" = next 7 days including today.
- Closing a lead cancels (keeps) its active tasks. Completed tasks cannot be deleted (cancel instead). Completing never changes the lead stage.
- Follow-up task after sending mail is offered in a dialog, never created automatically; `dedupeKey` prevents duplicates.
- Received mail: existing logic sets "reply" Next Action; the dashboard banner shows how many leads wait for review. Lead is never closed.
- 5-day follow-up for manually imported sent mail is unchanged (covered by a test).

## Migration
`prisma/migrations/20261124120000_tasks/migration.sql`: additive only. Creates `Task` (+ CHECK constraints, indexes, partial unique index) and backfills one Next Action task for each lead that already has `nextFollowUpAt`. Existing tables and columns are not altered. Verified on a legacy-style database.

## API (all under `/api`, auth + CSRF like the rest)
`GET /tasks` (view, q, org, country, leadType, priority, taskType, status, sort, dir) | `GET /tasks/summary` | `GET /tasks/meta` | `GET /tasks/no-next-action` | `POST /tasks` | `PATCH /tasks/:id` | `POST /tasks/:id/complete` (optional `next`) | `POST /tasks/:id/reschedule` | `POST /tasks/:id/next-action` | `DELETE /tasks/:id` | `GET /leads/:id/tasks`.
Timeline events added: `TASK_CREATED`, `TASK_COMPLETED`, `FOLLOWUP_DATE_CHANGED` (each written once per task).

## Changed files
New: `src/services/tasks.js`, `src/routes/tasks.js`, `public/tasks.js`, `test/tasks.test.js`, migration folder.
Edited: `prisma/schema.prisma`, `src/routes/api.js`, `src/services/leads.js`, `src/services/email.js`, `src/services/gmdss.js` (one line each, calling reconcile / cancel tasks on close), `public/app.js`, `public/index.html`, `public/styles.css`, `public/gmdss.html`, `public/gmdss.js`, `public/login.html` (colors moved to tokens).

## Design system
Palette as CSS variables in `public/styles.css` (`--navy`, `--blue`, `--ok-*`, `--warn-*`, `--danger-*`, `--bg`, `--ink`, `--muted`, `--line`). All hardcoded colors in the stylesheet, GMDSS page and JS were mapped to tokens. One status badge set (`.tkst`): Completed green, Open neutral, In Progress blue, Waiting yellow, Overdue red, Cancelled gray. Stage pills are light tints. Derived tints added (`--blue-tint`, `--tint-line`, `--hover`, `--muted-on-gray`).
Contrast (WCAG AA 4.5:1) checked for 19 pairs: `--muted` on `--bg` (4.28) and blue link on blue tint (4.14) failed; fixed with `--muted-on-gray #56657A` and a neutral row tint.

## Tests (embedded Postgres 17, UTF8)
37 tests: 36 pass, 1 fails. The failure (`gmdss-reply-match: logReply ... no match returns false`) is a fake-Prisma unit test that also failed before any change, unrelated to this work.
New tests (13) cover: multiple tasks per lead, one Next Action (including DB-level refusal), complete / reschedule / next-on-complete, overdue detection, filters / search / sort, dedupe, manual outreach and re-import without duplicates, received reply, lead close, full HTTP API with CSRF.
Browser check (local, seeded data): dashboard counters, filters, lead card sections, complete dialog with next action, mobile 375px, Hebrew RTL with English organization names, no console errors.

## Known gaps
- Not tested live: the follow-up offer dialog after sending mail (logic and dedupe covered by tests; dialog reuses the shared modal). Real sending was not run.
- GMDSS-table leads (`GmdssLead`) have no tasks; they keep their own follow-up date.
- Reminders are in-app only (counters, banner, nav badge). No push or email notifications were added.
- Cancelled tasks of a closed lead are not restored on reopen.

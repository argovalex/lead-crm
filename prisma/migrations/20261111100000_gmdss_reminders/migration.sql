-- Automatic reminders and access-code tracking for GMDSS leads.
ALTER TABLE "gmdss_leads"
    ADD COLUMN "reminder_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "last_reminder_at" TIMESTAMP(3),
    ADD COLUMN "code_sent_at" TIMESTAMP(3),
    ADD COLUMN "access_code" TEXT;

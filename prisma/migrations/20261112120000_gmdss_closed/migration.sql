-- Closed leads: no reminders, no mass sends.
ALTER TABLE "gmdss_leads" ADD COLUMN "closed_at" TIMESTAMP(3);

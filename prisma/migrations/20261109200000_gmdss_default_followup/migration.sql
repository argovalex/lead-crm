-- Default follow-up: 7 days after the last email, for leads that were already mailed and have no follow-up date.
UPDATE "gmdss_leads" SET "follow_up_at" = "last_emailed_at" + INTERVAL '7 days'
WHERE "last_emailed_at" IS NOT NULL AND "follow_up_at" IS NULL;

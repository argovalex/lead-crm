-- First email sent from the lead card was recorded as a reply (status not_sent + "answered"). Fix Bluewater Yachting.
UPDATE "gmdss_activities" SET "type" = 'first_sent'
 WHERE "type" = 'reply_sent' AND "lead_id" IN (SELECT "id" FROM "gmdss_leads" WHERE "email" = 'peter@bluewateryachting.com' AND "email_status" = 'not_sent');
UPDATE "gmdss_leads" SET "email_status" = 'sent', "last_emailed_at" = COALESCE((SELECT MAX("created_at") FROM "gmdss_activities" WHERE "lead_id" = "gmdss_leads"."id" AND "type" = 'first_sent'), NOW())
 WHERE "email" = 'peter@bluewateryachting.com' AND "email_status" = 'not_sent';

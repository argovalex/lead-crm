-- Customer card for GMDSS leads: activity timeline, notes, follow-up date, reply marker.
ALTER TABLE "gmdss_leads"
    ADD COLUMN "notes" TEXT,
    ADD COLUMN "follow_up_at" TIMESTAMP(3),
    ADD COLUMN "replied_at" TIMESTAMP(3);

CREATE TABLE "gmdss_activities" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gmdss_activities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gmdss_activities_lead_id_created_at_idx" ON "gmdss_activities"("lead_id", "created_at");
ALTER TABLE "gmdss_activities" ADD CONSTRAINT "gmdss_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "gmdss_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the timeline from what the lead rows already know.
INSERT INTO "gmdss_activities" ("lead_id", "type", "detail", "created_at")
SELECT id, 'sent', NULL, last_emailed_at FROM "gmdss_leads" WHERE last_emailed_at IS NOT NULL;
INSERT INTO "gmdss_activities" ("lead_id", "type", "detail", "created_at")
SELECT id, 'delivered', NULL, delivered_at FROM "gmdss_leads" WHERE delivered_at IS NOT NULL;
INSERT INTO "gmdss_activities" ("lead_id", "type", "detail", "created_at")
SELECT id, 'opened', NULL, opened_at FROM "gmdss_leads" WHERE opened_at IS NOT NULL;
INSERT INTO "gmdss_activities" ("lead_id", "type", "detail", "created_at")
SELECT id, 'clicked', last_click_link, clicked_at FROM "gmdss_leads" WHERE clicked_at IS NOT NULL;
INSERT INTO "gmdss_activities" ("lead_id", "type", "detail", "created_at")
SELECT id, 'bounced', NULL, bounced_at FROM "gmdss_leads" WHERE bounced_at IS NOT NULL;

-- Email templates for the GMDSS campaign, plus per-lead template link and delivery/open/click tracking.
CREATE TABLE "gmdss_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gmdss_templates_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "gmdss_leads"
    ADD COLUMN "template_id" INTEGER,
    ADD COLUMN "provider_id" TEXT,
    ADD COLUMN "delivered_at" TIMESTAMP(3),
    ADD COLUMN "opened_at" TIMESTAMP(3),
    ADD COLUMN "clicked_at" TIMESTAMP(3),
    ADD COLUMN "bounced_at" TIMESTAMP(3),
    ADD COLUMN "last_click_link" TEXT,
    ADD COLUMN "open_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "click_count" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "gmdss_leads_provider_id_key" ON "gmdss_leads"("provider_id");
ALTER TABLE "gmdss_leads" ADD CONSTRAINT "gmdss_leads_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "gmdss_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

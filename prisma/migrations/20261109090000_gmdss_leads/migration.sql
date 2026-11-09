-- New table for the GMDSS outreach campaign. Does not touch existing tables.
CREATE TABLE "gmdss_leads" (
    "id" SERIAL NOT NULL,
    "organization" TEXT NOT NULL,
    "country" TEXT,
    "segment" TEXT,
    "product_fit" TEXT,
    "why_theyd_buy" TEXT,
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "priority" TEXT,
    "email_status" TEXT NOT NULL DEFAULT 'not_sent',
    "last_emailed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmdss_leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmdss_leads_email_lower_key" ON "gmdss_leads" (LOWER("email")) WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX "gmdss_leads_org_country_key" ON "gmdss_leads" (LOWER("organization"), LOWER(COALESCE("country", ''))) WHERE "email" IS NULL;

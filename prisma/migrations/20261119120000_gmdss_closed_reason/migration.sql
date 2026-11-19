-- Why a lead was closed (not interested, no budget, ...).
ALTER TABLE "gmdss_leads" ADD COLUMN "closed_reason" TEXT;

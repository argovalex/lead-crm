-- Real-CRM fields: segment info from outreach lists + follow-up tracking.
ALTER TABLE "Lead" ADD COLUMN "country" TEXT;
ALTER TABLE "Lead" ADD COLUMN "segment" TEXT;
ALTER TABLE "Lead" ADD COLUMN "priority" TEXT;
ALTER TABLE "Lead" ADD COLUMN "website" TEXT;
ALTER TABLE "Lead" ADD COLUMN "nextAction" TEXT;
ALTER TABLE "Lead" ADD COLUMN "nextFollowUpAt" TIMESTAMP(3);
CREATE INDEX "Lead_nextFollowUpAt_idx" ON "Lead"("nextFollowUpAt");

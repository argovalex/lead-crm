-- Outbox review (DRAFT status) and dashboard-editable settings.
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
CREATE TABLE "Setting" ("key" TEXT NOT NULL, "value" TEXT NOT NULL, CONSTRAINT "Setting_pkey" PRIMARY KEY ("key"));

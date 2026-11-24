-- Additive only: new table, no changes to existing tables or data.
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "dueTime" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'B',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "isNextAction" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Task_status_chk" CHECK ("status" IN ('OPEN','IN_PROGRESS','WAITING','COMPLETED','CANCELLED')),
    CONSTRAINT "Task_priority_chk" CHECK ("priority" IN ('A','B','C')),
    CONSTRAINT "Task_type_chk" CHECK ("taskType" IN ('INITIAL_EMAIL','FOLLOWUP_EMAIL','PHONE_CALL','MEETING','SEND_PROPOSAL','PRODUCT_DEMO','NEGOTIATION','FINAL_DECISION','OTHER'))
);
CREATE UNIQUE INDEX "Task_dedupeKey_key" ON "Task"("dedupeKey");
CREATE INDEX "Task_leadId_idx" ON "Task"("leadId");
CREATE INDEX "Task_status_dueDate_idx" ON "Task"("status", "dueDate");
-- At most one active Next Action per lead.
CREATE UNIQUE INDEX "Task_one_next_action_per_lead" ON "Task"("leadId") WHERE "isNextAction" AND "status" NOT IN ('COMPLETED','CANCELLED');
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every lead that already has a planned next step gets exactly one Next Action task (existing columns are not modified).
INSERT INTO "Task" ("leadId", "title", "taskType", "dueDate", "priority", "status", "isNextAction")
SELECT l."id",
       COALESCE(NULLIF(BTRIM(l."nextAction"), ''), 'מעקב'),
       CASE
         WHEN l."nextAction" ~ 'טלפון|שיחה' THEN 'PHONE_CALL'
         WHEN l."nextAction" ~ 'פגישה' THEN 'MEETING'
         WHEN l."nextAction" ~ 'הצעה' THEN 'SEND_PROPOSAL'
         WHEN l."nextAction" ~ 'להשיב|מייל|מעקב' OR l."nextAction" IS NULL THEN 'FOLLOWUP_EMAIL'
         ELSE 'OTHER'
       END,
       l."nextFollowUpAt",
       CASE WHEN l."priority" IN ('A','B','C') THEN l."priority" ELSE 'B' END,
       'OPEN',
       true
FROM "Lead" l
WHERE l."nextFollowUpAt" IS NOT NULL;

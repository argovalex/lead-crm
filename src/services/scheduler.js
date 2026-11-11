const cron = require('node-cron');
const prisma = require('../db');
const email = require('./email');
const gmdssReminders = require('./gmdssReminders');

const LOCK_KEY = 72310451; // pg advisory lock id: only one replica runs a tick at a time

let running = false;

async function tick(now = new Date()) {
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    return await prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
      if (!locked) return { skipped: 'locked' };
      const queued = await email.materializeDueSteps(now);
      const result = await email.dispatch(now);
      const stale = await email.flagStale(now);
      return { queued, ...result, stale };
    }, { timeout: 120000, maxWait: 10000 });
  } finally {
    running = false;
  }
}

function start() {
  const task = cron.schedule('* * * * *', async () => {
    try {
      const r = await tick();
      if (r.queued || r.sent || r.failed || r.stale) console.log('[scheduler]', JSON.stringify(r));
    } catch (e) {
      console.error('[scheduler] tick failed', e);
    }
    try {
      const g = await gmdssReminders.runDue();
      if (g.sent || g.failed) console.log('[gmdss-reminders]', JSON.stringify(g));
    } catch (e) {
      console.error('[gmdss-reminders] tick failed', e);
    }
  });
  // Run once on boot so due work isn't delayed by up to a minute after a redeploy.
  setTimeout(() => tick()
    .then((r) => console.log('[scheduler] boot tick', JSON.stringify(r)))
    .catch((e) => console.error('[scheduler] boot tick failed', e)), 5000);
  return task;
}

module.exports = { tick, start };

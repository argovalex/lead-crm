const config = require('./config');

config.validate();

const { createApp } = require('./app');
const scheduler = require('./services/scheduler');
const prisma = require('./db');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`CRM listening on :${config.port}`);
  if (config.schedulerEnabled) {
    scheduler.start();
    console.log('Scheduler started (every minute)');
  }
});

async function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

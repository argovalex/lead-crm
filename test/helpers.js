process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/crm_test';
process.env.EMAIL_PROVIDER = 'mock';
process.env.WEBHOOK_SECRET = 'whsec_' + Buffer.from('test-secret-test-secret-32bytes!').toString('base64');
process.env.APP_URL = 'https://crm.test';
process.env.ADMIN_EMAIL = 'admin@test.dev';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('correct-horse-battery', 4);
process.env.SESSION_SECRET = 'test-session-secret';
process.env.SENDS_PER_MINUTE = '50';
process.env.DAILY_SEND_CAP = '1000';

const prisma = require('../src/db');
const provider = require('../src/services/provider');

async function reset() {
  await prisma.$executeRawUnsafe('TRUNCATE "Activity","EmailMessage","Enrollment","SequenceStep","Sequence","Lead","WebhookEvent","Setting" RESTART IDENTITY CASCADE');
  await prisma.setting.create({ data: { key: 'requireApproval', value: 'false' } }); // existing tests exercise immediate sending
  const mock = provider.mockProvider();
  provider.setProvider(mock);
  return mock;
}

module.exports = { prisma, reset };

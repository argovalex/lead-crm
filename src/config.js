const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

module.exports = {
  port: int(process.env.PORT, 3000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  adminEmail: process.env.ADMIN_EMAIL,
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  resendApiKey: process.env.RESEND_API_KEY,
  webhookSecret: process.env.WEBHOOK_SECRET,
  emailFrom: process.env.EMAIL_FROM,
  emailProvider: process.env.EMAIL_PROVIDER || 'resend',
  dailySendCap: int(process.env.DAILY_SEND_CAP, 200),
  sendsPerMinute: int(process.env.SENDS_PER_MINUTE, 10),
  staleDays: int(process.env.STALE_DAYS, 14),
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
  isProd: process.env.NODE_ENV === 'production',
};

module.exports.validate = function validate() {
  const required = ['DATABASE_URL', 'ADMIN_EMAIL', 'SESSION_SECRET', 'APP_URL', 'WEBHOOK_SECRET'];
  if (!process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) required.push('ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH)');
  if ((process.env.EMAIL_PROVIDER || 'resend') === 'resend') required.push('RESEND_API_KEY', 'EMAIL_FROM');
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
};

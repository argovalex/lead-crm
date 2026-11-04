const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const config = require('./config');
const prisma = require('./db');
const leads = require('./services/leads');
const email = require('./services/email');
const { verifyWebhook } = require('./services/provider');
const api = require('./routes/api');

const page = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f4f6f8;display:grid;place-items:center;min-height:100vh;margin:0;color:#1d2733}
.c{background:#fff;padding:32px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}
button{background:#1d2733;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer}</style></head>
<body><div class="c">${body}</div></body></html>`;

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.get('/healthz', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });

  // ---- Webhooks: raw body needed for signature verification ----
  app.post('/webhooks/email', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = verifyWebhook(req.body.toString('utf8'), req.headers);
    } catch {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    try {
      const r = await email.handleEvent(req.headers['svix-id'], event);
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[webhook]', e);
      res.status(500).json({ error: 'processing_failed' });
    }
  });

  // ---- Unsubscribe (public). GET shows a confirm button so link scanners don't unsubscribe;
  // POST is the RFC 8058 one-click endpoint used by Gmail/Outlook via List-Unsubscribe-Post. ----
  app.get('/u/:token', async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { unsubToken: req.params.token } });
    if (!lead) return res.status(404).send(page('לא נמצא', '<p>הקישור אינו תקף.</p>'));
    if (lead.unsubscribed) return res.send(page('הוסרת', '<h2>הוסרת מרשימת התפוצה</h2><p>לא תקבל/י מאיתנו מיילים נוספים.</p>'));
    res.send(page('הסרה מרשימת תפוצה', `<h2>הסרה מרשימת התפוצה</h2><p>${lead.email.replace(/[<>&"]/g, '')}</p>
      <form method="post"><button type="submit">הסר אותי</button></form>`));
  });
  app.post('/u/:token', express.urlencoded({ extended: false }), async (req, res) => {
    const lead = await leads.unsubscribe(req.params.token);
    if (!lead) return res.status(404).send(page('לא נמצא', '<p>הקישור אינו תקף.</p>'));
    res.send(page('הוסרת', '<h2>הוסרת מרשימת התפוצה</h2><p>לא תקבל/י מאיתנו מיילים נוספים.</p>'));
  });

  // ---- Auth ----
  app.use(cookieSession({
    name: 'crm_sess',
    keys: [config.sessionSecret || 'dev-only-secret'],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
  }));
  app.use(express.json({ limit: '1mb' }));

  const attempts = new Map(); // naive in-memory login throttle: 10 tries / 15 min / IP
  app.post('/auth/login', async (req, res) => {
    const ip = req.ip;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) return res.status(429).json({ error: 'too_many_attempts' });
    const { email: em, password } = req.body || {};
    const h = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest();
    const emailOk = typeof em === 'string' && !!config.adminEmail && crypto.timingSafeEqual(h(em), h(config.adminEmail));
    let passOk = false;
    if (typeof password === 'string') {
      if (config.adminPasswordHash) passOk = await bcrypt.compare(password, config.adminPasswordHash);
      else if (config.adminPassword) {
        const p = (s) => crypto.createHash('sha256').update(String(s)).digest();
        passOk = crypto.timingSafeEqual(p(password), p(config.adminPassword));
      }
    }
    if (!emailOk || !passOk) {
      a.n += 1; attempts.set(ip, a);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    attempts.delete(ip);
    req.session.user = config.adminEmail;
    req.session.csrf = crypto.randomBytes(16).toString('hex');
    res.json({ ok: true });
  });
  app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
  app.get('/auth/me', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
    res.json({ user: req.session.user, csrf: req.session.csrf });
  });

  const requireAuth = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
    if (req.method !== 'GET' && req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'csrf' });
    next();
  };
  app.use('/api', requireAuth, api);

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message });
  });
  return app;
}

module.exports = { createApp };

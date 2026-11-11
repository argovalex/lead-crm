const fs = require('fs');
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
const gmdssApi = require('./routes/gmdss');

const page = (title, body) => `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f4f6f8;display:grid;place-items:center;min-height:100vh;margin:0;color:#1d2733}
.c{background:#fff;padding:32px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}
button{background:#1d2733;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer}</style></head>
<body><div class="c">${body}</div></body></html>`;

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---- Security headers ----
  // Scripts only from this origin (no inline <script>, no inline handlers). Inline style attributes are
  // used all over the UI, so styles stay 'unsafe-inline'. Email previews render in srcdoc iframes, which
  // inherit this policy: they need remote images (signature, video thumbnails) but never scripts.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN', // the GMDSS view is a same-origin iframe
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

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
    if (!lead) return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
    if (lead.unsubscribed) return res.send(page('Unsubscribed', '<h2>You have been unsubscribed</h2><p>You will not receive further emails from us.</p>'));
    res.send(page('Unsubscribe', `<h2>Unsubscribe</h2><p>${lead.email.replace(/[<>&"]/g, '')}</p>
      <form method="post"><button type="submit">Unsubscribe me</button></form>`));
  });
  app.post('/u/:token', express.urlencoded({ extended: false }), async (req, res) => {
    const lead = await leads.unsubscribe(req.params.token);
    if (!lead) return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
    res.send(page('Unsubscribed', '<h2>You have been unsubscribed</h2><p>You will not receive further emails from us.</p>'));
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
  app.use('/api/gmdss', requireAuth, gmdssApi);
  app.use('/api', requireAuth, api);

  // ---- Static assets ----
  // Pages are always revalidated. Their JS/CSS references get a content hash (?v=...), and a request
  // carrying one is cached for a year: a deploy that changes a file changes its URL.
  const pub = path.join(__dirname, '..', 'public');
  const hashMemo = new Map();
  const assetVersion = (file) => {
    const full = path.join(pub, file);
    const { mtimeMs } = fs.statSync(full);
    const m = hashMemo.get(file);
    if (m && m.mtimeMs === mtimeMs) return m.v;
    const v = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
    hashMemo.set(file, { mtimeMs, v });
    return v;
  };
  const sendPage = (file) => (_req, res) => {
    const html = fs.readFileSync(path.join(pub, file), 'utf8')
      .replace(/(href|src)="\/([\w.-]+\.(?:js|css))"/g, (_m, attr, f) => `${attr}="/${f}?v=${assetVersion(f)}"`);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  };
  app.get(['/', '/index.html'], sendPage('index.html'));
  app.get(['/login', '/login.html'], sendPage('login.html'));
  app.get(['/gmdss', '/gmdss.html'], sendPage('gmdss.html'));
  app.use((req, res, next) => {
    if (req.query.v && /\.(js|css)$/.test(req.path)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  });
  app.use(express.static(pub, { extensions: ['html'] }));

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

// Email provider abstraction. Swap providers by implementing { send, verifyWebhook, parseEvent }.
const { Webhook } = require('svix');
const config = require('../config');

function resendProvider() {
  const { Resend } = require('resend');
  const client = new Resend(config.resendApiKey);
  return {
    name: 'resend',
    async send({ to, subject, html, text, headers, idempotencyKey }) {
      const { data, error } = await client.emails.send(
        { from: config.emailFrom, replyTo: config.emailReplyTo, to, subject, html, text, headers },
        { idempotencyKey },
      );
      if (error) throw new Error(`${error.name || 'resend_error'}: ${error.message}`);
      return { providerId: data.id };
    },
  };
}

// In-memory provider for tests / local dev. Mirrors provider-side idempotency.
function mockProvider() {
  const sent = [];
  const byKey = new Map();
  return {
    name: 'mock',
    sent,
    failNext: 0,
    async send(msg) {
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('mock_failure');
      }
      if (byKey.has(msg.idempotencyKey)) return { providerId: byKey.get(msg.idempotencyKey) };
      const providerId = `mock_${sent.length + 1}_${Date.now()}`;
      byKey.set(msg.idempotencyKey, providerId);
      sent.push({ ...msg, providerId });
      return { providerId };
    },
  };
}

let instance;
function getProvider() {
  if (!instance) instance = config.emailProvider === 'mock' ? mockProvider() : resendProvider();
  return instance;
}
function setProvider(p) {
  instance = p;
}

// Resend signs webhooks with Svix. Throws on invalid signature.
function verifyWebhook(rawBody, headers, secret = config.webhookSecret) {
  const wh = new Webhook(secret);
  wh.verify(rawBody, {
    'svix-id': headers['svix-id'],
    'svix-timestamp': headers['svix-timestamp'],
    'svix-signature': headers['svix-signature'],
  });
  return JSON.parse(rawBody);
}

module.exports = { getProvider, setProvider, mockProvider, verifyWebhook };

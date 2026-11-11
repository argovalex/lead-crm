// Which GMDSS lead an inbound reply is attached to. Uses an in-memory stand-in for Prisma, so it needs no database.
const test = require('node:test');
const assert = require('node:assert');
const { findReplyLead, logReply } = require('../src/services/gmdss');

function fakePrisma(rows) {
  const acts = [];
  const lc = (s) => String(s || '').toLowerCase();
  const match = (r, w) => {
    const e = w.email;
    if (e && e.equals !== undefined && lc(r.email) !== lc(e.equals)) return false;
    if (e && e.endsWith !== undefined && !lc(r.email).endsWith(lc(e.endsWith))) return false;
    if (w.lastEmailedAt && w.lastEmailedAt.not === null && r.lastEmailedAt == null) return false;
    return true;
  };
  return {
    acts, rows,
    gmdssLead: {
      findFirst: async ({ where }) => rows.find((r) => match(r, where)) || null,
      findMany: async ({ where }) => rows.filter((r) => match(r, where)),
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    },
    gmdssActivity: { create: async ({ data }) => { acts.push(data); return data; } },
  };
}

const L = (id, email, lastEmailedAt) => ({ id, email, lastEmailedAt: lastEmailedAt ? new Date(lastEmailedAt) : null, repliedAt: null });

test('exact address wins, case-insensitively', async () => {
  const p = fakePrisma([L(1, 'Info@Academy.org', '2026-11-10'), L(2, 'boss@academy.org', '2026-11-11')]);
  const m = await findReplyLead(p, 'info@academy.org');
  assert.equal(m.lead.id, 1);
  assert.equal(m.exact, true);
});

test('a colleague at the same organization matches the lead emailed most recently', async () => {
  const p = fakePrisma([L(1, 'info@academy.org', '2026-11-09'), L(2, 'office@academy.org', '2026-11-11'), L(3, 'x@other.org', '2026-11-11')]);
  const m = await findReplyLead(p, 'captain@academy.org');
  assert.equal(m.lead.id, 2);
  assert.equal(m.exact, false);
});

test('free-mail senders are never matched by domain', async () => {
  const p = fakePrisma([L(1, 'someone@gmail.com', '2026-11-10')]);
  assert.equal(await findReplyLead(p, 'other@gmail.com'), null);
});

test('same domain but never emailed, or unknown domain, is no match', async () => {
  const p = fakePrisma([L(1, 'info@academy.org', null)]);
  assert.equal(await findReplyLead(p, 'captain@academy.org'), null);
  assert.equal(await findReplyLead(p, 'a@nowhere.net'), null);
  assert.equal(await findReplyLead(p, ''), null);
  assert.equal(await findReplyLead(p, 'no-at-sign'), null);
});

test('logReply marks the lead and notes a different sender address', async () => {
  const p = fakePrisma([L(1, 'info@academy.org', '2026-11-10')]);
  const now = new Date('2026-11-12T10:00:00Z');
  assert.equal(await logReply(p, 'captain@academy.org', 'Re: GMDSS', 'Interested, call me', now), true);
  assert.equal(p.rows[0].repliedAt, now);
  assert.equal(p.acts.length, 1);
  assert.equal(p.acts[0].type, 'replied');
  const [subject, ...rest] = p.acts[0].detail.split('\n');
  assert.equal(subject, 'Re: GMDSS');
  assert.match(rest.join('\n'), /captain@academy\.org/);
  assert.match(rest.join('\n'), /Interested, call me/);
});

test('logReply from the exact address adds no sender note; no match returns false', async () => {
  const p = fakePrisma([L(1, 'info@academy.org', '2026-11-10')]);
  assert.equal(await logReply(p, 'info@academy.org', 'Re: hi', 'Yes please', new Date()), true);
  assert.equal(p.acts[0].detail, 'Re: hi\nYes please');
  assert.equal(await logReply(p, 'stranger@elsewhere.org', 'Re: hi', 'x', new Date()), false);
  assert.equal(p.acts.length, 1);
});

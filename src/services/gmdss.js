// GMDSS outreach: CSV parsing, contact splitting, import, merge-field rendering.
const { parse } = require('csv-parse/sync');

// Variable names are exactly the CSV headings (case-sensitive).
const VARIABLES = ['Organization', 'Country', 'Segment', 'Product Fit', "Why They'd Buy", 'Website', 'Email', 'Phone', 'Priority'];

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// "a@b.com / +33 4 93" -> { email, phone }. Detect by pattern, not position.
function splitContact(raw) {
  const out = { email: null, phone: null };
  for (const tok of String(raw ?? '').split(' / ').map((t) => t.trim()).filter(Boolean)) {
    if (tok.includes('@')) out.email = out.email || tok;
    else if (/^[+\d]/.test(tok)) out.phone = out.phone || tok;
  }
  return out;
}

function parseCsv(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: false });
  return rows.map((r) => {
    const { email, phone } = splitContact(r['Contact Email / Phone']);
    return {
      organization: clean(r['Organization']),
      country: clean(r['Country']),
      segment: clean(r['Segment']),
      productFit: clean(r['Product Fit']),
      whyTheydBuy: clean(r["Why They'd Buy"]),
      website: clean(r['Website']),
      email,
      phone,
      priority: clean(r['Priority']),
    };
  });
}

// Idempotent: a row is a duplicate if the email matches (case-insensitive) or,
// with no email, organization+country matches. Never merges or deletes.
async function importRows(prisma, rows) {
  const stats = { read: rows.length, inserted: 0, duplicates: 0, noEmail: 0, noPhone: 0 };
  for (const r of rows) {
    if (!r.email) stats.noEmail += 1;
    if (!r.phone) stats.noPhone += 1;
    if (!r.organization) throw new Error('row_without_organization');
    const existing = r.email
      ? await prisma.gmdssLead.findFirst({ where: { email: { equals: r.email, mode: 'insensitive' } } })
      : await prisma.gmdssLead.findFirst({
        where: {
          email: null,
          organization: { equals: r.organization, mode: 'insensitive' },
          country: r.country ? { equals: r.country, mode: 'insensitive' } : null,
        },
      });
    if (existing) { stats.duplicates += 1; continue; }
    await prisma.gmdssLead.create({ data: r });
    stats.inserted += 1;
  }
  return stats;
}

function valuesFor(lead) {
  return {
    Organization: lead.organization, Country: lead.country, Segment: lead.segment, 'Product Fit': lead.productFit,
    "Why They'd Buy": lead.whyTheydBuy, Website: lead.website, Email: lead.email, Phone: lead.phone, Priority: lead.priority,
  };
}

// Replaces {{Heading}} with the lead's value (empty string when missing). Unknown names stay untouched and are reported.
function merge(tpl, lead) {
  const vals = valuesFor(lead);
  const unknown = new Set();
  const out = String(tpl ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => {
    if (k in vals) return vals[k] ?? '';
    unknown.add(k);
    return m;
  });
  return { text: out, unknown: [...unknown] };
}

module.exports = { VARIABLES, splitContact, parseCsv, importRows, merge, valuesFor };

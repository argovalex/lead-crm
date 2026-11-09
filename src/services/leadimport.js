// Extra CSV headers (outreach research sheets): Organization, Product Fit, Why They'd Buy, Website,
// "Contact Email / Phone", Priority. Merged into the importer's HEADER_MAP.
const EXTRA_HEADERS = {
  organization: 'company', organisation: 'company', 'company name': 'company', 'ארגון': 'company',
  'product fit': 'fit', 'התאמה': 'fit',
  "why they'd buy": 'notes', 'why theyd buy': 'notes', 'why they would buy': 'notes', 'למה יקנו': 'notes',
  'website url': 'website', url: 'website',
  'contact email / phone': 'contact', 'email / phone': 'contact', 'contact': 'contact', 'contact email': 'contact', 'איש קשר': 'contact',
};

const FIT_LABEL = { simulator: 'סימולטור', course: 'קורס', both: 'קורס + סימולטור' };
const EMAIL_RE = /[^\s/,;<>()]+@[^\s/,;<>()]+\.[^\s/,;<>()]+/;

// Turns one parsed CSV record into lead fields: splits "email / phone", names the lead after the
// organization when there is no contact name, and turns Product Fit into a tag.
function normalizeRow(r) {
  const out = { ...r };
  if (out.contact && !out.email) {
    const m = String(out.contact).match(EMAIL_RE);
    if (m) out.email = m[0];
    const rest = String(out.contact).replace(EMAIL_RE, '').replace(/^[\s/,;|]+|[\s/,;|]+$/g, '').trim();
    if (rest && !out.phone) out.phone = rest;
  }
  if (!out.name && out.company) out.name = out.company;
  if (out.fit) {
    const label = FIT_LABEL[String(out.fit).trim().toLowerCase()] || String(out.fit).trim();
    out.tags = [...String(out.tags || '').split(/[,;|]/).map((t) => t.trim()).filter(Boolean), label].join(',');
  }
  return out;
}

const FILL_FIELDS = ['name', 'phone', 'company', 'source', 'country', 'segment', 'priority', 'website', 'notes'];

// For a lead that already exists: the fields from the sheet that the lead does not have yet.
function fillPatch(existing, r, normTags) {
  const patch = {};
  for (const f of FILL_FIELDS) {
    const v = r[f] != null ? String(r[f]).trim() : '';
    if (!v) continue;
    // A placeholder name (email prefix from an earlier broken import) is replaced by the organization.
    const placeholder = f === 'name' && existing.name === String(existing.email || '').split('@')[0];
    if (!existing[f] || placeholder) patch[f] = v;
  }
  const merged = [...new Set([...(existing.tags || []), ...normTags(r.tags)])];
  if (merged.length !== (existing.tags || []).length) patch.tags = merged;
  return patch;
}

const COUNTRIES = new Set(['france', 'spain', 'usa', 'us', 'uk', 'united kingdom', 'australia', 'canada', 'cyprus', 'latvia', 'finland', 'netherlands', 'germany', 'sweden', 'south africa', 'norway', 'new zealand', 'greece', 'croatia', 'ireland', 'singapore', 'antigua', 'mexico', 'italy', 'israel', 'turkey', 'denmark', 'portugal', 'malta', 'montenegro', 'slovenia', 'poland', 'estonia', 'lithuania', 'belgium', 'brazil', 'argentina', 'japan', 'china', 'india', 'uae', 'thailand', 'egypt', 'tunisia', 'morocco']);
const SEG_RE = /school|academy|college|charter|fleet|rescue|volunteer|club|federation|association|lms|learning|training|stcw|simulat|vendor|distributor|marina|marketplace|authority|institute|boating|yacht/i;
const URL_RE = /^(https?:\/\/|www\.)\S+$|^[a-z0-9-]+(\.[a-z0-9-]+)+\/?\S*$/i;

// Old imports dumped Priority / Product Fit / Segment / Country into one tags field
// ("priority-A, both, Sailing & Charter School, Greece, gmdss"). Moves each into its own field and
// removes the duplicated tags. Only fills empty fields; returns {} when nothing changes.
function splitTagsPatch(lead) {
  const patch = {};
  const keep = [];
  const country = () => patch.country || lead.country;
  const segment = () => patch.segment || lead.segment;
  for (const raw of lead.tags || []) {
    const s = String(raw).trim();
    const l = s.toLowerCase();
    let m;
    if ((m = l.match(/^(?:priority|prio|עדיפות)[\s:_-]*([abc])$/))) { if (!lead.priority && !patch.priority) patch.priority = m[1].toUpperCase(); if (!lead.priority && patch.priority !== m[1].toUpperCase()) keep.push(s); continue; }
    if (FIT_LABEL[l]) { keep.push(FIT_LABEL[l]); continue; }
    if (COUNTRIES.has(l)) { if (!country()) patch.country = s; if (String(country()).toLowerCase() === l) continue; keep.push(s); continue; }
    if (!lead.website && !patch.website && URL_RE.test(s) && /[./]/.test(s)) { patch.website = s; continue; }
    if (SEG_RE.test(s)) {
      if (!segment()) { patch.segment = s; continue; }
      if (String(segment()).toLowerCase() === l) continue;
    }
    keep.push(s);
  }
  const tags = [...new Set(keep)];
  if (tags.join('|') !== (lead.tags || []).join('|')) patch.tags = tags;
  return patch;
}

module.exports = { EXTRA_HEADERS, normalizeRow, fillPatch, splitTagsPatch };

// Manual lead from a link: fetches the page (plus its contact/about page when linked), and turns it
// into GMDSS lead fields. Uses Claude Haiku when ANTHROPIC_API_KEY is set; otherwise a regex fallback
// (title, emails, phones). The result is a draft the user reviews before saving.
const dns = require('dns').promises;
const net = require('net');
const config = require('../config');

const MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_BYTES = 1_500_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_G = /\+?\d[\d\s().-]{7,}\d/g;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function normUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw bad('url_required');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw bad('invalid_url'); }
  if (!/^https?:$/.test(u.protocol)) throw bad('invalid_url');
  return u;
}

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

// Blocks fetches into Railway's private network or localhost.
async function assertPublic(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) throw bad('url_not_allowed');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw bad('host_not_found'); });
  if (addrs.some((a) => privateIp(a.address))) throw bad('url_not_allowed');
}

async function fetchHtml(u, hops = 0) {
  await assertPublic(u);
  let r;
  try {
    r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en,he;q=0.8' }, signal: AbortSignal.timeout(15000) });
  } catch { throw bad('fetch_failed', 502); }
  if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
    if (hops >= 4) throw bad('too_many_redirects', 502);
    return fetchHtml(new URL(r.headers.get('location'), u), hops + 1);
  }
  if (!r.ok) throw bad(`fetch_status_${r.status}`, 502);
  const buf = Buffer.from(await r.arrayBuffer());
  return { html: buf.subarray(0, MAX_BYTES).toString('utf8'), finalUrl: u };
}

const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));

function parse(html, base) {
  const meta = (name) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'));
    return m ? decode(m[1]).trim() : '';
  };
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const mailto = [...html.matchAll(/href=["']mailto:([^"'?]+)/gi)].map((m) => decode(decodeURIComponent(m[1])).trim());
  const tel = [...html.matchAll(/href=["']tel:([^"']+)/gi)].map((m) => decode(decodeURIComponent(m[1])).trim());
  const links = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, ' ').trim() }));
  const contactLink = links.find((l) => /contact|kontakt|contacto|contatti|επικοινων|צור.?קשר/i.test(`${l.href} ${l.text}`) && !/^mailto:|^tel:/i.test(l.href));
  const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  let contactUrl = null;
  if (contactLink) { try { const c = new URL(contactLink.href, base); if (c.host === base.host && c.href !== base.href) contactUrl = c; } catch { /* ignore */ } }
  return { title, siteName: meta('og:site_name'), description: meta('description') || meta('og:description'), mailto, tel, text, contactUrl };
}

const uniq = (a) => [...new Set(a.map((s) => s.trim()).filter(Boolean))];
const goodEmail = (e) => !/\.(png|jpe?g|gif|webp|svg)$/i.test(e) && !/example\.|sentry|wixpress|domain\.com/i.test(e);

function fallback(pages, url) {
  const p = pages[0];
  const all = pages.map((x) => x.text).join('\n');
  const emails = uniq([...pages.flatMap((x) => x.mailto), ...(all.match(EMAIL_G) || [])]).filter(goodEmail);
  const phones = uniq([...pages.flatMap((x) => x.tel), ...(all.match(PHONE_G) || []).filter((s) => s.replace(/\D/g, '').length >= 9)]);
  const parts = p.title.split(/\s[|\-–·:]\s/).map((x) => x.trim()).filter((x) => x && !/^(home|homepage|welcome|contact( us)?|about( us)?|דף הבית|ראשי)$/i.test(x));
  const org = p.siteName || parts[0] || url.hostname.replace(/^www\./, '');
  return { organization: org.trim(), contactName: '', country: '', segment: '', productFit: '', whyTheydBuy: p.description.slice(0, 300), website: `${url.protocol}//${url.host}`, email: emails[0] || '', phone: phones[0] || '', priority: '' };
}

const SYSTEM = `You extract a B2B sales lead from a web page for Alexander Argov (alargov.com), who sells GMDSS / VHF-DSC radio training: a browser-based VHF-DSC radio simulator and an Introduction to GMDSS video course with a 210-question test bank. Typical buyers: maritime academies, sailing and yacht schools, charter companies, rescue and volunteer organisations, boating clubs and federations, training centres and LMS vendors.
Return ONLY a JSON object with these string keys: organization, contactName, country, segment, productFit, whyTheydBuy, email, phone, priority.
Rules:
- organization: the organisation's proper name (not the page title or slogan).
- contactName: a specific person to address (owner, director, head of training) only if the page names one; else "".
- country: English country name.
- segment: short English category; reuse one of the existing segments when it fits.
- productFit: exactly "Course", "Simulator" or "Both" (Both when unsure).
- whyTheydBuy: one English sentence on why this organisation would buy, based on what the page says.
- email: the best general or training-related address shown on the page; never invent one. phone: in international format if shown.
- priority: "A" (trains for radio/GMDSS/VHF certificates or many students), "B" (relevant boating training), "C" (weak fit).
Use "" for anything the page does not support. Never invent facts.`;

async function viaLlm(pages, url, segments) {
  const body = pages.map((p, i) => `PAGE ${i + 1}${i ? ' (contact page)' : ''}\nTitle: ${p.title}\nSite name: ${p.siteName}\nDescription: ${p.description}\nmailto: ${p.mailto.join(', ')}\ntel: ${p.tel.join(', ')}\nText:\n${p.text.slice(0, 9000)}`).join('\n\n=====\n\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 600, system: SYSTEM,
      messages: [{ role: 'user', content: `URL: ${url.href}\nExisting segments: ${segments.join('; ') || '(none)'}\n\n${body}` }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`llm_${r.status}`);
  const j = await r.json();
  const text = ((j.content || []).find((c) => c.type === 'text') || {}).text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('llm_no_json');
  return JSON.parse(m[0]);
}

const FIELDS = ['organization', 'contactName', 'country', 'segment', 'productFit', 'whyTheydBuy', 'website', 'email', 'phone', 'priority'];

async function extractLead(rawUrl, { segments = [] } = {}) {
  const url = normUrl(rawUrl);
  const first = await fetchHtml(url);
  const pages = [parse(first.html, first.finalUrl)];
  if (pages[0].contactUrl) {
    try { const c = await fetchHtml(pages[0].contactUrl); pages.push(parse(c.html, c.finalUrl)); } catch { /* the main page is enough */ }
  }
  const base = fallback(pages, first.finalUrl);
  let draft = base, source = 'regex', error = null;
  if (config.anthropicKey) {
    try {
      const ai = await viaLlm(pages, first.finalUrl, segments);
      draft = { ...base };
      for (const k of FIELDS) if (typeof ai[k] === 'string' && ai[k].trim()) draft[k] = ai[k].trim();
      source = 'ai';
    } catch (e) { error = e.message; }
  }
  if (!['Course', 'Simulator', 'Both'].includes(draft.productFit)) draft.productFit = draft.productFit ? 'Both' : '';
  if (!['A', 'B', 'C'].includes(draft.priority)) draft.priority = '';
  const found = pages.flatMap((p) => p.mailto.concat(p.text.match(EMAIL_G) || []));
  if (draft.email && !found.some((e) => e.toLowerCase() === draft.email.toLowerCase())) draft.email = base.email; // never keep an address the page does not show
  const emails = uniq(found).filter(goodEmail).slice(0, 10);
  return { draft, source, error, url: first.finalUrl.href, emails };
}

module.exports = { extractLead, normUrl };

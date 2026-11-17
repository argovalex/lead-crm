// A GMDSS lead's email field may hold several addresses separated by ";" (or ","). Helpers for that.
const EMAIL_RE = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;
const parseEmails = (s) => [...new Set(String(s || '').split(/[;,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
const validEmails = (s) => { const l = parseEmails(s); return l.length > 0 && l.every((x) => EMAIL_RE.test(x)); };
const normEmails = (s) => parseEmails(s).join('; ');
module.exports = { parseEmails, validEmails, normEmails };

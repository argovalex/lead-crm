const config = require('../config');

const MODEL = process.env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001';
const HEB = /[֐-׿]/;

const SYSTEM = `You draft email replies for Alexander Argov (alargov.com), who sells maritime safety and GMDSS training.
Write the reply to the LAST received message in the conversation.
Rules: same language as the last received message. Short and direct, 3 to 6 sentences. Answer exactly what was asked, then propose one concrete next step (a call, a date, sending details). No filler, no flattery, no em dashes. Do not write a signature or a subject line (the signature is added automatically). Never invent prices, dates, discounts or facts: if the answer needs data you do not have, write it in square brackets, for example [מחיר] or [date]. Output only the email body.`;

const SYSTEM_FUP = `You draft email follow-ups for Alexander Argov (alargov.com), who sells maritime safety and GMDSS training.
Write a short follow-up to the LAST email Alex sent, which has had no reply yet.
Rules: same language as that email. 2 to 4 sentences, polite and direct, one concrete next step (a short online demo or a question). No filler, no flattery, no em dashes, no pressure. Do not write a signature or a subject line (the signature is added automatically). Never invent prices, dates, discounts or facts: use square brackets for anything you do not know. Output only the email body.`;

function template(lead, lastIn) {
  const first = String(lead.name || '').split(/\s+/)[0] || '';
  const he = HEB.test(lastIn ? `${lastIn.subject} ${lastIn.body}` : lead.name || '');
  return he
    ? `שלום ${first},\nתודה על התשובה.\n[תשובה לשאלה שלך]\nמתאים לך שנקבע שיחה קצרה השבוע כדי לסגור את הפרטים?`
    : `Hi ${first},\nThanks for getting back to me.\n[answer to the question]\nWould a short call this week work to close the details?`;
}

// items: thread items in ascending order (dir 'in'|'out', subject, body, at).
async function suggestReply(lead, items, opts = {}) {
  const lastIn = [...items].reverse().find((i) => i.dir === 'in');
  const fup = !!opts.followUp && !lastIn;
  if (!config.anthropicKey || (!lastIn && !fup)) return { text: template(lead, lastIn), source: 'template' };
  const convo = items.slice(-8).map((i) => `${i.dir === 'in' ? 'FROM LEAD' : 'FROM ALEX'} (${new Date(i.at).toISOString().slice(0, 10)})${i.subject ? ` Subject: ${i.subject}` : ''}\n${String(i.body || '').slice(0, 2500)}`).join('\n\n---\n\n');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 700, system: fup ? SYSTEM_FUP : SYSTEM,
        messages: [{ role: 'user', content: `Lead: ${lead.name}${lead.company ? `, ${lead.company}` : ''}\n\nConversation:\n\n${convo}\n\n${fup ? 'Write the follow-up now.' : 'Write the reply now.'}` }],
      }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { text: template(lead, lastIn), source: 'template', error: 'llm_unreachable' };
  }
  if (!r.ok) return { text: template(lead, lastIn), source: 'template', error: `llm_${r.status}` };
  const j = await r.json();
  const text = ((j.content || []).find((c) => c.type === 'text') || {}).text;
  return text ? { text: text.trim(), source: 'ai' } : { text: template(lead, lastIn), source: 'template', error: 'llm_empty' };
}

module.exports = { suggestReply };

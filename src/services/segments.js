// Guesses the lead type from the company name. First match wins,
// so a "charter" business that also says "school" is classed as rental.
const RULES = [
  ['חברת השכרה', /השכר|שכיר|צ['’`]?רטר|charter|rental|\brent(al|s)?\b|\bhire\b/i],
  ['בית ספר', /בית[\s-]*ספר|ביה["”]?ס|בי["”]?ס\b|אקדמי|מכללה|מכון|הדרכה|קורס|סמינר|school|academy|college|institute|training|courses?|instruction/i],
  ['מועדון', /מועדון|אגודה|עמותה|club|association|society/i],
  ['מרינה / נמל', /מרינה|נמל|marina|harbou?r|\bport\b/i],
];

function classify(...texts) {
  const s = texts.filter(Boolean).join(' ');
  if (!s) return null;
  const hit = RULES.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

module.exports = { classify, SEGMENTS: RULES.map(([n]) => n) };

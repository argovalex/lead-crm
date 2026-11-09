// Email body rendering: plain text -> safe HTML with links, YouTube thumbnails and a signature.
//
// Writing syntax in a message body:
//   https://example.com             -> clickable link
//   [link text](https://example.com) -> link with custom text
//   [video:https://youtu.be/ID]      -> YouTube thumbnail that opens the video
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unesc = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function ytId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/))([\w-]{11})/);
  return m ? m[1] : null;
}

function renderRich(text) {
  const tokens = [];
  const keep = (html) => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let h = esc(text);
  h = h.replace(/\[video:(https?:\/\/[^\s\]]+)\]/g, (_, u) => {
    const raw = unesc(u);
    const id = ytId(raw);
    if (!id) return keep(`<a href="${u}" style="color:#1f6f54">${u}</a>`);
    return keep(`<a href="${u}" style="display:inline-block;margin:6px 0;text-decoration:none"><img src="https://img.youtube.com/vi/${id}/hqdefault.jpg" width="240" alt="&#9654; Watch the video" style="max-width:100%;height:auto;border:0;border-radius:8px;display:block"></a>`);
  });
  h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => keep(`<a href="${u}" style="color:#1f6f54">${t}</a>`));
  h = h.replace(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (u) => `<a href="${u}" style="color:#1f6f54">${u}</a>`);
  h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
  return h.replace(/\n/g, '<br>');
}

// Plain-text version of the body (for the text/plain part).
function renderPlain(text) {
  return String(text)
    .replace(/\[video:(https?:\/\/[^\s\]]+)\]/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '')
    .replace(/<\/(tr|p|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, (_, h, t) => (t.trim() === h || h.startsWith('mailto:') ? t : `${t} (${h})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { esc, renderRich, renderPlain, htmlToText, ytId };

'use strict';

const CHANNELS = ['linkedin', 'facebook', 'instagram', 'x', 'tiktok'];
const LIMITS = { linkedin: 2800, facebook: 5000, instagram: 2100, x: 270, tiktok: 2100 };

function plain(html) {
  return String(html || '')
    .replace(/<(?:script|style)[^>]*>[\s\S]*?<\/\s*(?:script|style)>/gi, ' ')
    .replace(/<\s*br\b[^>]*>|<\/\s*(?:p|div|h[1-6]|li|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function clean(value) { return String(value || '').replace(/\r/g, '').trim(); }
function url(post) { return 'https://blog.example.com/artigo/' + String(post.slug || ''); }
function cap(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return cut.slice(0, boundary > max * .65 ? boundary + 1 : cut.length).trimEnd() + '…';
}
function withLink(channel, body, post) {
  const link = url(post);
  if (channel === 'instagram' || channel === 'tiktok') return body;
  if (body.includes(link)) return body;
  const suffix = channel === 'linkedin' ? '\n\nArtigo completo: ' + link : '\n\n' + link;
  return cap(body, LIMITS[channel] - suffix.length) + suffix;
}
function draft(channel, post) {
  if (!CHANNELS.includes(channel)) throw new Error('Canal inválido.');
  const title = clean(post.title || post.titulo_final);
  const excerpt = clean(post.excerpt);
  const body = plain(post.content || post.content_html);
  let result;
  if (channel === 'linkedin') {
    // O trecho fica em torno de metade do artigo, respeitando o espaço do feed.
    const passage = cap(body, Math.min(Math.ceil(body.length * .5), 2000));
    result = [title, excerpt, passage].filter(Boolean).join('\n\n');
  } else if (channel === 'facebook') {
    result = [title, excerpt, cap(body, 900)].filter(Boolean).join('\n\n');
  } else if (channel === 'x') {
    result = [title, excerpt || cap(body, 90)].filter(Boolean).join(' — ');
  } else if (channel === 'instagram') {
    result = [title, excerpt || cap(body, 400), 'Artigo completo no blog.'].filter(Boolean).join('\n\n');
  } else {
    result = [title, excerpt || cap(body, 250)].filter(Boolean).join('\n\n');
  }
  return withLink(channel, cap(result, LIMITS[channel] - 140), post);
}
function approved(channel, post) {
  if (!CHANNELS.includes(channel)) throw new Error('Canal inválido.');
  const saved = post.social_copy && post.social_copy[channel];
  if (!saved) return draft(channel, post);
  const text = withLink(channel, clean(saved), post);
  if (!text || text.length > LIMITS[channel]) throw new Error('Texto do ' + channel + ' vazio ou acima do limite de ' + LIMITS[channel] + ' caracteres.');
  return text;
}
function validateCopy(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Textos de redes inválidos.');
  const result = {};
  for (const channel of CHANNELS) {
    if (input[channel] == null) continue;
    const value = clean(input[channel]);
    if (value.length > LIMITS[channel] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Texto do ' + channel + ' inválido ou longo demais.');
    if (value) result[channel] = value;
  }
  return result;
}

module.exports = { CHANNELS, LIMITS, plain, url, draft, approved, validateCopy };

'use strict';

const cheerio = require('cheerio');
const LazyMedia = require('./media-providers');

const EDITABLE_TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'div', 'span']);
const MEDIA_TAGS = new Set(['figure', 'img', 'iframe']);

function sanitizeText(html) {
  const $ = cheerio.load(String(html || ''), null, false);
  $('*').each((_, node) => {
    if (!node.parent) return;
    const tag = String(node.name || '').toLowerCase();
    if (MEDIA_TAGS.has(tag) || ['script', 'style', 'svg', 'object', 'embed', 'form', 'input', 'button'].includes(tag)) {
      $(node).remove();
      return;
    }
    if (!EDITABLE_TAGS.has(tag)) { $(node).replaceWith($(node).contents()); return; }
    for (const key of Object.keys(node.attribs || {})) {
      const value = node.attribs[key];
      const safeLink = tag === 'a' && key === 'href' && /^(https?:\/\/|mailto:|\/|#)/i.test(value);
      const safeColor = tag === 'span' && key === 'class' && /^ll-color-(cyan|blue|purple|pink|red|yellow|green)$/.test(value);
      if (!safeLink && !safeColor) $(node).removeAttr(key);
    }
    if (tag === 'a') $(node).attr('rel', 'noopener noreferrer');
  });
  return $.root().html() || '';
}

function sanitizeMedia(html) {
  const $ = cheerio.load(String(html || ''), null, false);
  $('*').each((_, node) => {
    if (!node.parent) return;
    const tag = String(node.name || '').toLowerCase();
    if (!['figure', 'figcaption', 'img', 'iframe', 'div', 'span'].includes(tag)) { $(node).remove(); return; }
    const embed = tag === 'iframe' && LazyMedia.video(node.attribs.src);
    if (tag === 'iframe' && (!embed || !['youtube', 'vimeo', 'drive'].includes(embed.provider) || embed.src !== node.attribs.src)) {
      $(node).remove(); return;
    }
    if (tag === 'img' && !/^(https:\/\/|\/)/i.test(node.attribs.src || '')) { $(node).remove(); return; }
    for (const key of Object.keys(node.attribs || {})) {
      const value = node.attribs[key];
      const keep = key === 'class' && /^[A-Za-z0-9 _-]{1,120}$/.test(value)
        || (key === 'data-gallery' || key === 'data-diagram') && /^[A-Za-z0-9_-]{1,120}$/.test(value)
        || key === 'src' && (tag === 'img' || tag === 'iframe')
        || (key === 'alt' || key === 'title' || key === 'loading') && (tag === 'img' || key === 'title' && tag === 'iframe')
        || key === 'allowfullscreen' && tag === 'iframe';
      if (!keep) $(node).removeAttr(key);
    }
  });
  return $.root().html() || '';
}

function sanitizeArticleCta(node, $) {
  const link = $(node).find('a.article-cta').first();
  const href = String(link.attr('href') || '');
  let url;
  try { url = new URL(href); } catch (_) { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const label = link.text().trim().slice(0, 90);
  if (!label) return '';
  const classes = String(link.attr('class') || '');
  const kind = ['link', 'github', 'download'].find(value => classes.split(/\s+/).includes('article-cta-' + value)) || 'link';
  const color = ['cyan', 'purple', 'pink', 'yellow', 'green'].find(value => classes.split(/\s+/).includes('article-cta-' + value)) || 'cyan';
  const safe = cheerio.load('<div class="article-cta-block"><a></a></div>', null, false);
  safe('a').attr('class', `article-cta article-cta-${kind} article-cta-${color}`).attr('href', url.href).attr('rel', 'noopener noreferrer').text(label);
  return safe.root().html();
}

function sanitizePromptBlock(node, $) {
  const text = $(node).find('.article-prompt-text').first().text().slice(0, 60000);
  if (!text.trim()) return '';
  const safe = cheerio.load('<figure class="article-prompt-block" contenteditable="false" translate="no"><div class="article-prompt-head"><span class="article-prompt-title">Prompt para IA</span><div class="article-prompt-actions"><button type="button" data-prompt-action="copy">Copiar</button><button type="button" data-prompt-action="download">Baixar .md</button><button type="button" class="article-prompt-edit" data-prompt-action="edit">Editar</button></div></div><div class="article-prompt-body"><pre><code class="article-prompt-text"></code></pre></div><div class="article-prompt-foot"><span>Copie e cole no seu assistente de IA</span><button type="button" data-prompt-action="toggle" aria-expanded="false">Ver prompt completo</button></div></figure>', null, false);
  safe('.article-prompt-text').text(text);
  return safe.root().html();
}

function sanitizeVideoBlock(node, $) {
  const input = $(node).attr('data-video-url') || $(node).find('iframe').first().attr('src');
  const media = LazyMedia.video(input);
  if (!media || !['youtube','vimeo','drive','instagram','tiktok'].includes(media.provider)) return '';
  const portrait = !!(media.portrait || $(node).hasClass('article-video-portrait'));
  const safe = cheerio.load('<figure class="article-video" contenteditable="false"><iframe loading="lazy" allowfullscreen></iframe></figure>', null, false);
  const figure = safe('figure');
  if (portrait) {
    figure.addClass('article-video-portrait');
    figure.prepend('<figcaption class="article-video-head"></figcaption>');
    figure.find('figcaption').text(({ instagram: 'Instagram Reel', tiktok: 'TikTok', youtube: 'YouTube Short' })[media.provider] || 'Vídeo curto');
  }
  figure.attr('data-video-provider', media.provider).attr('data-video-url', media.href || input);
  figure.find('iframe').attr('src', media.src).attr('title', 'Vídeo incorporado no artigo')
    .attr('allow', 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen')
    .attr('referrerpolicy', 'strict-origin-when-cross-origin');
  if (media.href) {
    figure.append('<a class="article-video-source" target="_blank" rel="noopener noreferrer"></a>');
    figure.find('a').attr('href', media.href).text('Abrir no ' + (({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' })[media.provider] || media.provider));
  }
  return safe.root().html();
}

function prepareArticle(html) {
  const $ = cheerio.load(String(html || ''), null, false);
  const media = [];
  $('figure, img, iframe, .article-cta-block').each((_, node) => {
    if (!node.parent || $(node).parents('figure, .article-cta-block').length) return;
    const marker = `[[MEDIA_${media.length + 1}]]`;
    media.push({ marker, html: $(node).hasClass('article-cta-block') ? sanitizeArticleCta(node, $)
      : $(node).hasClass('article-prompt-block') ? sanitizePromptBlock(node, $)
      : $(node).hasClass('article-video') ? sanitizeVideoBlock(node, $)
      : sanitizeMedia($.html(node)) });
    $(node).replaceWith(marker);
  });
  return { source: $.root().html() || '', media };
}

function finishArticle(answer, media) {
  let output = String(answer || '').trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '');
  if (!output) throw new Error('A IA devolveu um artigo vazio. O texto original foi preservado.');
  const found = Array.from(output.matchAll(/\[\[MEDIA_\d+\]\]/g), match => match[0]);
  const expected = media.map(item => item.marker);
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new Error('A IA alterou a posição das mídias ou dos botões. O texto original foi preservado.');
  }
  let result = '';
  for (const item of media) {
    const index = output.indexOf(item.marker);
    result += sanitizeText(output.slice(0, index)) + item.html;
    output = output.slice(index + item.marker.length);
  }
  result += sanitizeText(output);
  if (!cheerio.load(result, null, false).root().text().trim()) {
    throw new Error('A IA não devolveu conteúdo legível. O texto original foi preservado.');
  }
  return result;
}

function finishInline(answer) {
  const $ = cheerio.load(finishArticle(answer, []), null, false);
  $('p,h1,h2,h3,h4,li,div,blockquote,pre,ul,ol').each((_, node) => {
    if (node.parent) $(node).replaceWith($(node).contents());
  });
  $('hr').remove();
  return ($.root().html() || '').trim();
}

function splitLongText(text, limit) {
  const parts = [];
  let rest = String(text || '').trim();
  while (rest.length > limit) {
    let cut = Math.max(rest.lastIndexOf('. ', limit), rest.lastIndexOf('? ', limit), rest.lastIndexOf('! ', limit));
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// A transcrição pode conter um único parágrafo enorme. Divide antes de chamar
// o modelo e nunca envia figuras, iframes ou botões para a IA.
function splitArticleForAi(source, limit = 3500) {
  const chunks = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push({ html: current }); current = ''; };
  const append = html => {
    if (current.length + html.length > limit) flush();
    current += html;
  };
  for (const piece of String(source || '').split(/(\[\[MEDIA_\d+\]\])/g)) {
    if (!piece) continue;
    if (/^\[\[MEDIA_\d+\]\]$/.test(piece)) { flush(); chunks.push({ marker: piece }); continue; }
    const $ = cheerio.load(piece, null, false);
    for (const node of $.root()[0].children || []) {
      const html = $.html(node);
      if (html.length <= limit) { append(html); continue; }
      if (node.type === 'text') {
        for (const part of splitLongText(node.data, limit - 100)) {
          const escaped = cheerio.load('<p></p>', null, false);
          escaped('p').text(part);
          append(escaped.root().html());
        }
        continue;
      }
      // Em parágrafos ditados muito longos, a quebra vira parágrafos legíveis.
      // Blocos curtos com formatação continuam intactos.
      const text = $(node).text().trim();
      if (text && ['p', 'div', 'blockquote', 'li'].includes(node.name)) {
        for (const part of splitLongText(text, limit - 100)) {
          const escaped = cheerio.load('<p></p>', null, false);
          escaped('p').text(part);
          append(escaped.root().html());
        }
      } else append(html);
    }
  }
  flush();
  return chunks;
}

module.exports = { prepareArticle, finishArticle, finishInline, sanitizeText, splitArticleForAi };

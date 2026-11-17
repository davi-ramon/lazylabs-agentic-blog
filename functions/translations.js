/** Traduções publicáveis dos artigos via DeepSeek, preservando o HTML no servidor. */
const { createHash } = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');
let cheerio;
function parser() { if (!cheerio) cheerio = require('cheerio'); return cheerio; }

const LANGUAGES = Object.freeze({ en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch' });
const TARGETS = Object.keys(LANGUAGES);
const SOURCE_FIELDS = ['title', 'excerpt', 'seo_title', 'seo_description', 'category', 'cta_label'];
const MAX_SEGMENT = 1800;
const MAX_BATCH = 2200;
const NO_TRANSLATE = new Set(['script', 'style', 'pre', 'code', 'kbd', 'samp', 'svg', 'iframe']);

function sourceHash(post) {
  const source = {};
  for (const key of SOURCE_FIELDS) source[key] = String(post[key] || '');
  source.content = String(post.content || '');
  source.tags = Array.isArray(post.tags) ? post.tags : [];
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function hasProtectedDescendant(node) {
  if (NO_TRANSLATE.has(String(node.name || '').toLowerCase())) return true;
  return (node.children || []).some(hasProtectedDescendant);
}

function splitText(value) {
  const pieces = [];
  let remaining = String(value);
  while (remaining.length > MAX_SEGMENT) {
    let cut = remaining.lastIndexOf(' ', MAX_SEGMENT);
    if (cut < MAX_SEGMENT / 2) cut = MAX_SEGMENT;
    else cut += 1;
    pieces.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

function collectSegments($, node, textSegments) {
  const name = String(node.name || '').toLowerCase();
  if (NO_TRANSLATE.has(name) || node.attribs && node.attribs.translate === 'no') return;
  if (node.type === 'text') {
    if (node.data && node.data.trim()) {
      const leading = (node.data.match(/^\s*/) || [''])[0];
      const trailing = (node.data.match(/\s*$/) || [''])[0];
      textSegments.push({ node, leading, trailing, pieces: splitText(node.data.trim()) });
    }
    return;
  }
  for (const child of node.children || []) collectSegments($, child, textSegments);
}

function markupSignature(html) {
  const $ = parser().load(html, null, false);
  function walk(node) {
    if (node.type === 'tag') {
      const attrs = Object.entries(node.attribs || {}).sort(([a], [b]) => a.localeCompare(b));
      return [node.name, attrs, (node.children || []).filter(child => child.type === 'tag').map(walk)];
    }
    return null;
  }
  return JSON.stringify(($.root()[0].children || []).filter(child => child.type === 'tag').map(walk));
}

// A API às vezes remove espaços adjacentes a <strong>, <a>, <code> etc.
// Recupera apenas os limites de whitespace do HTML original, sem tocar na tradução.
function restoreInlineWhitespace(originalHtml, translatedHtml) {
  if (markupSignature(originalHtml) !== markupSignature(translatedHtml)) return translatedHtml;
  const source = parser().load(String(originalHtml || ''), null, false);
  const target = parser().load(String(translatedHtml || ''), null, false);
  function repair(sourceParent, targetParent) {
    const sourceChildren = sourceParent.children || [];
    const targetChildren = targetParent.children || [];
    const sourceTags = sourceChildren.filter(node => node.type === 'tag');
    const targetTags = targetChildren.filter(node => node.type === 'tag');
    for (let gap = 0; gap <= sourceTags.length; gap++) {
      const sourceStart = gap ? sourceChildren.indexOf(sourceTags[gap - 1]) + 1 : 0;
      const sourceEnd = gap < sourceTags.length ? sourceChildren.indexOf(sourceTags[gap]) : sourceChildren.length;
      const targetStart = gap ? targetChildren.indexOf(targetTags[gap - 1]) + 1 : 0;
      const targetEnd = gap < targetTags.length ? targetChildren.indexOf(targetTags[gap]) : targetChildren.length;
      const before = sourceChildren.slice(sourceStart, sourceEnd).filter(node => node.type === 'text').map(node => node.data).join('');
      const afterNodes = targetChildren.slice(targetStart, targetEnd).filter(node => node.type === 'text');
      if (!before || !afterNodes.length) continue;
      if (/^\s/.test(before) && !/^\s/.test(afterNodes[0].data)) afterNodes[0].data = ' ' + afterNodes[0].data;
      const sentenceBreak = /^([.,;:!?])\s+/.exec(before);
      if (gap && sentenceBreak && !/^[\s.,;:!?]/.test(afterNodes[0].data)) {
        const previousText = target(targetTags[gap - 1]).text();
        const separator = /[.,;:!?]\s*$/.test(previousText) ? '' : sentenceBreak[1];
        afterNodes[0].data = separator + ' ' + afterNodes[0].data;
      }
      const last = afterNodes[afterNodes.length - 1];
      if (/\s$/.test(before) && !/\s$/.test(last.data)) last.data += ' ';
    }
    sourceTags.forEach((node, index) => repair(node, targetTags[index]));
  }
  repair(source.root()[0], target.root()[0]);
  return target.root().html() || '';
}

async function translateGroups(items, mimeType, target, translateBatch) {
  const result = [];
  let batch = [];
  let size = 0;
  async function flush() {
    if (!batch.length) return;
    const translated = await translateBatch(batch, mimeType, target);
    if (!Array.isArray(translated) || translated.length !== batch.length || translated.some(x => !String(x || '').trim())) {
      throw new Error('Resposta incompleta do tradutor.');
    }
    result.push(...translated);
    batch = [];
    size = 0;
  }
  for (const item of items) {
    if (item.length > MAX_BATCH) throw new Error('Trecho grande demais para tradução.');
    if (size + item.length > MAX_BATCH) await flush();
    batch.push(item);
    size += item.length;
  }
  await flush();
  return result;
}

async function translateHtml(content, target, translateBatch) {
  const $ = parser().load(String(content || ''), null, false);
  const textSegments = [];
  // Never send article markup to the model. Only text nodes and selected alt/title
  // attributes are translated, so media, widgets and links stay in place.
  for (const node of $.root()[0].children || []) collectSegments($, node, textSegments);
  const textInput = textSegments.flatMap(segment => segment.pieces);
  const textOutput = await translateGroups(textInput, 'text/plain', target, translateBatch);
  let offset = 0;
  for (const segment of textSegments) {
    segment.node.data = segment.leading + textOutput.slice(offset, offset + segment.pieces.length).join('') + segment.trailing;
    offset += segment.pieces.length;
  }
  const attributes = [];
  $('img[alt], a[title]').each((_, node) => {
    const name = node.name === 'img' ? 'alt' : 'title';
    if ($(node).attr('translate') !== 'no' && String(node.attribs[name] || '').trim()) attributes.push({ node, name, value: node.attribs[name] });
  });
  const translatedAttributes = await translateGroups(attributes.map(item => item.value), 'text/plain', target, translateBatch);
  attributes.forEach((item, i) => { item.node.attribs[item.name] = translatedAttributes[i]; });
  return $.root().html() || '';
}

async function translatePost(post, target, translateBatch) {
  if (!LANGUAGES[target]) throw new Error('Idioma de destino inválido.');
  // A chave configurada no editor é lida somente no servidor, uma vez por artigo/idioma.
  if (!translateBatch) {
    const key = await deepseekKey();
    translateBatch = (contents, mimeType, language) => deepseekTranslateBatch(contents, mimeType, language, key, post.title);
  }
  const fields = [...SOURCE_FIELDS, ...(Array.isArray(post.tags) ? post.tags.map((_, i) => `tag:${i}`) : [])];
  const input = fields.map(field => field.startsWith('tag:') ? post.tags[Number(field.slice(4))] : post[field]);
  const nonempty = input.map((value, i) => ({ value: String(value || ''), i })).filter(x => x.value.trim());
  const [fieldOutput, content] = await Promise.all([
    translateGroups(nonempty.map(x => x.value), 'text/plain', target, translateBatch),
    translateHtml(post.content, target, translateBatch)
  ]);
  const translated = {};
  nonempty.forEach((entry, i) => { translated[fields[entry.i]] = fieldOutput[i]; });
  return {
    language: target,
    source_hash: sourceHash(post),
    model: 'deepseek-flash',
    translated_at: new Date().toISOString(),
    title: translated.title || '',
    excerpt: translated.excerpt || '',
    seo_title: translated.seo_title || translated.title || '',
    seo_description: translated.seo_description || translated.excerpt || '',
    category: translated.category || '',
    cta_label: translated.cta_label || '',
    tags: (post.tags || []).map((_, i) => translated[`tag:${i}`] || ''),
    content
  };
}

async function deepseekKey() {
  const snap = await getFirestore().doc('config/davi').get();
  const config = snap.data() || {};
  const key = String(config.deepseek_key || (config.provider === 'deepseek' ? config.api_key : '') || '').trim();
  if (!key) throw new Error('Chave DeepSeek ausente no servidor. Configure-a em Admin > Configurações > IA e integrações.');
  return key;
}

function translationPrompt(target) {
  const locales = { en: 'English for an international professional audience', es: 'Spanish for an international audience',
    fr: 'French for a francophone professional audience', de: 'German for a German-speaking professional audience' };
  return `Translate the texts array in the following JSON object from Brazilian Portuguese into ${locales[target]}. The article title is context only; do not include it as an extra item. Return only a JSON object of the form {"translations":["translated item 1","translated item 2"]}, preserving the item count and order. Write naturally for the target culture, but do not add, omit, embellish or change facts, numbers, names, brands, URLs, code, technical terms or calls to action. Keep the tone of the original author. Each item is plain text, never HTML. Do not translate markup or output Markdown.`;
}

async function deepseekTranslateBatch(contents, mimeType, target, key, articleTitle = '') {
  if (!contents.length) return [];
  if (mimeType !== 'text/plain' || !LANGUAGES[target]) throw new Error('Pedido de tradução inválido.');
  const apiKey = key || await deepseekKey();
  const body = JSON.stringify({
    model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0.3,
    response_format: { type: 'json_object' }, max_tokens: 8000,
    messages: [
      { role: 'system', content: translationPrompt(target) },
      { role: 'user', content: JSON.stringify({ article_title_context: String(articleTitle || '').slice(0, 300), texts: contents }) }
    ]
  });
  const maxAttempts = contents.length > 1 ? 2 : 3;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(90000)
      });
      if (!response.ok) {
        const error = new Error(response.status === 402 ? 'Saldo insuficiente na API DeepSeek.'
          : [401, 403].includes(response.status) ? 'Chave ou permissão DeepSeek inválida.'
            : `DeepSeek indisponível (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const choice = payload.choices && payload.choices[0];
      if (!choice || choice.finish_reason === 'length') {
        const error = new Error('A resposta da tradução foi cortada pelo DeepSeek.');
        error.incomplete = true;
        throw error;
      }
      let parsed;
      try { parsed = JSON.parse(choice.message && choice.message.content || ''); }
      catch (_) {
        const error = new Error('O DeepSeek devolveu JSON incompleto.');
        error.incomplete = true;
        throw error;
      }
      const translated = parsed.translations;
      if (!Array.isArray(translated) || translated.length !== contents.length
          || translated.some(value => typeof value !== 'string' || !value.trim())) {
        const error = new Error('O DeepSeek devolveu uma tradução incompleta.');
        error.incomplete = true;
        throw error;
      }
      return translated;
    } catch (error) {
      if (error.status && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      lastError = error;
      if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  // Respostas com itens faltando costumam vir de lotes com muitos trechos curtos.
  // Divide somente esse lote; cada trecho continua sendo validado antes de publicar.
  if (lastError && lastError.incomplete && contents.length > 1) {
    const middle = Math.floor(contents.length / 2);
    const left = await deepseekTranslateBatch(contents.slice(0, middle), mimeType, target, apiKey, articleTitle);
    const right = await deepseekTranslateBatch(contents.slice(middle), mimeType, target, apiKey, articleTitle);
    return left.concat(right);
  }
  throw lastError;
}

module.exports = { LANGUAGES, TARGETS, sourceHash, translateHtml, translatePost, restoreInlineWhitespace, deepseekTranslateBatch };

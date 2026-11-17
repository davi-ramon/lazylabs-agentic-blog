const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { sourceHash } = require('./translations');
const locales = require('./article-locales');

test('as quatro interfaces traduzidas cobrem todos os rótulos do artigo', () => {
  const keys = Object.keys(locales['pt-BR']).sort();
  const template = readFileSync(join(__dirname, 'article-template.html'), 'utf8');
  for (const [, key] of template.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) {
    assert.ok(keys.includes(key), `rótulo sem tradução: ${key}`);
  }
  for (const language of ['en', 'es', 'fr', 'de']) {
    assert.deepEqual(Object.keys(locales[language]).sort(), keys, language);
    assert.ok(locales[language].translationNotice);
  }
});

const originalPost = {
  slug: 'teste', title: 'Olá mundo', excerpt: 'Um artigo de teste', content: '<p>Olá mundo</p>',
  status: 'published', category: 'Tecnologia', tags: [], blog_id: 'your-blog',
  seo_title: '', seo_description: '', cta_label: 'Saiba mais', cta_url: 'https://example.com',
  translation_ready: ['en']
};
originalPost.translation_hash = sourceHash(originalPost);
const translated = {
  language: 'en', source_hash: originalPost.translation_hash, title: 'Hello world',
  excerpt: 'A test article', content: '<p>Hello world</p>', seo_title: 'Hello world',
  seo_description: 'A test article', category: 'Technology', cta_label: 'Learn more'
};
const authorSource = ['Engenharia de IA', 'Fundador da Lazy Labs'];
const author = {
  name: 'Equipe do Blog', nickname: 'Deyvid', photo_url: 'https://example.com/avatar.png',
  specialty: authorSource[0], bio: authorSource[1],
  profile_translations: { en: { source_hash: createHash('sha256').update(JSON.stringify(authorSource)).digest('hex'), specialty: 'AI Engineering', bio: 'Founder of Lazy Labs' } }
};
originalPost.author_id = 'deyvid';
originalPost.author_photo_url = author.photo_url;
originalPost.video_url = 'https://youtu.be/ABCDEFGHIJK';

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (name === 'firebase-admin/app') return { getApps: () => [{}], initializeApp: () => ({}) };
  if (name === 'firebase-admin/firestore') return { getFirestore: () => ({
    doc: path => ({ get: async () => {
      if (path === 'posts/teste') return { exists: true, data: () => originalPost };
      if (path === 'posts/teste/translations/en') return { exists: true, data: () => translated };
      if (path === 'authors/deyvid') return { exists: true, data: () => author };
      return { exists: false };
    } })
  }), FieldValue: {} };
  if (name === 'firebase-admin/auth') return { getAuth: () => ({}) };
  return originalLoad(name, parent, isMain);
};
const functions = require('./index');
Module._load = originalLoad;

async function article(path, userAgent = 'Mozilla/5.0') {
  const res = {
    statusCode: 200, body: '', headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(n) { this.statusCode = n; return this; },
    send(v) { this.body = v; return this; }
  };
  await functions.artigo({ path, headers: { 'user-agent': userAgent } }, res);
  return res;
}

test('página em inglês compartilha o layout completo e tem SEO próprio', async () => {
  const res = await article('/en/artigo/teste');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<html lang="en">/);
  assert.match(res.body, /window\.__POST__ = .*"Hello world"/);
  assert.match(res.body, /id="art-title"/);
  assert.match(res.body, /class="logo"/);
  assert.match(res.body, /id="nl-form-area"/);
  assert.match(res.body, /id="comments"/);
  assert.match(res.body, /id="sh-fb"/);
  assert.match(res.body, /id="sh-native"/);
  assert.match(res.body, /Unbounded/);
  assert.match(res.body, /window\.__ARTICLE_LANG__ = "en"/);
  assert.match(res.body, /rel="canonical" href="https:\/\/blog.example.com\/en\/artigo\/teste"/);
  assert.match(res.body, /hreflang="pt-BR"/);
  assert.match(res.body, /hreflang="en"/);
  assert.doesNotMatch(res.body, /hreflang="es"/);
  assert.match(res.body, /class='author-avatar'/);
  assert.match(res.body, /Founder of Lazy Labs/);
  assert.match(res.body, /AI Engineering/);
  assert.match(res.body, /i\.ytimg\.com\/vi\/ABCDEFGHIJK\/hqdefault\.jpg/);
  assert.match(res.body, /id='youtube-player'/);
});

test('bots recebem texto traduzido no HTML para indexação', async () => {
  const res = await article('/en/artigo/teste', 'Googlebot');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<h1>Hello world<\/h1>/);
  assert.match(res.body, /<p>Hello world<\/p>/);
  assert.match(res.body, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/ABCDEFGHIJK"/);
  assert.match(res.body, /Founder of Lazy Labs/);
});

test('gravação própria aparece como vídeo nativo no artigo e nas traduções', async () => {
  const previous = originalPost.video_url;
  const url = 'https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.webm';
  originalPost.video_url = url;
  try {
    const page = await article('/en/artigo/teste');
    assert.match(page.body, /video&&video\.provider==='file'/);
    assert.match(page.body, /"video_url":"https:\/\/blog\.example\.com\/media\/blog-video\//);
    const crawler = await article('/en/artigo/teste', 'Googlebot');
    assert.match(crawler.body, /<video controls playsinline preload="metadata" src="https:\/\/blog\.example\.com\/media\/blog-video\//);
    assert.doesNotMatch(crawler.body, /<iframe src="https:\/\/blog\.example\.com\/media\/blog-video\//);
  } finally { originalPost.video_url = previous; }
});

test('idioma ainda não traduzido retorna 404', async () => {
  const res = await article('/es/artigo/teste');
  assert.equal(res.statusCode, 404);
});

test('artigo português mantém SPA e expõe alternância', async () => {
  const res = await article('/artigo/teste');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /window\.__POST__/);
  assert.match(res.body, /hreflang="en"/);
  assert.match(res.body, /Idioma \/ Language/);
});

test('HTML do artigo remove script e atributos executáveis sem perder a galeria', async () => {
  const previous = originalPost.content;
  originalPost.content = '<p>Olá</p><figure class="article-gallery" data-gallery="true"><img src="https://example.com/a.png" onerror="alert(1)"></figure><script>alert(1)</script>';
  try {
    const res = await article('/artigo/teste', 'Googlebot');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<figure class="article-gallery" data-gallery="true">/);
    assert.doesNotMatch(res.body, /onerror=|<script>alert\(1\)<\/script>/);
  } finally { originalPost.content = previous; }
});

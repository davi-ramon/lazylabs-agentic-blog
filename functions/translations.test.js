const test = require('node:test');
const assert = require('node:assert/strict');
const translations = require('./translations');

const fakeApi = async (contents) => contents.map(text => text
  .replaceAll('Olá', 'Hello')
  .replaceAll('mundo', 'world')
  .replaceAll('Imagem', 'Image')
  .replaceAll('Saiba mais', 'Learn more'));

test('tradução preserva links e código e traduz texto alternativo da imagem', async () => {
  const html = '<p>Olá <strong>mundo</strong>. <a href="https://example.com">Saiba mais</a></p>'
    + '<img src="https://example.com/img.png" alt="Imagem do mundo"><pre><code>Olá mundo</code></pre>';
  const output = await translations.translateHtml(html, 'en', fakeApi);
  assert.match(output, /Hello <strong>world<\/strong>/);
  assert.match(output, /href="https:\/\/example.com"/);
  assert.match(output, /src="https:\/\/example.com\/img.png" alt="Image do world"/);
  assert.match(output, /<pre><code>Olá mundo<\/code><\/pre>/);
});

test('o tradutor recebe apenas texto e não pode modificar a estrutura HTML', async () => {
  const calls = [];
  const html = '<div><figure class="article-image" contenteditable="false"><img src="https://example.com/a.png" alt="Imagem"></figure><p>Olá <strong>mundo</strong>.</p></div>';
  const output = await translations.translateHtml(html, 'en', async (values, mime) => {
    calls.push({ values, mime });
    return fakeApi(values);
  });
  assert.ok(calls.every(call => call.mime === 'text/plain'));
  assert.ok(calls.every(call => call.values.every(value => !/<[^>]+>/.test(value))));
  assert.match(output, /<figure class="article-image" contenteditable="false"><img src="https:\/\/example.com\/a.png" alt="Image"><\/figure><p>Hello <strong>world<\/strong>\.<\/p>/);
});

test('galeria permanece entre os mesmos parágrafos nas traduções', async () => {
  const images = [1, 2, 3, 4].map(n => `<img src="https://example.com/${n}.png" alt="Imagem ${n}">`).join('');
  const html = `<p>Olá mundo</p><figure class="article-gallery" data-gallery="true">${images}</figure><p>Olá mundo</p>`;
  const output = await translations.translateHtml(html, 'en', fakeApi);
  assert.match(output, /<p>Hello world<\/p><figure class="article-gallery" data-gallery="true">/);
  assert.equal((output.match(/<img /g) || []).length, 4);
  assert.match(output, /<\/figure><p>Hello world<\/p>/);
});

test('vídeo e diagrama mantêm posição e estrutura nas traduções', async () => {
  const html = '<p>Olá mundo</p><figure class="article-video"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe></figure>'
    + '<figure class="article-diagram diagram-flow" data-diagram="true"><figcaption>Olá mundo</figcaption><div class="diagram-step"><span>Imagem</span></div></figure><p>Saiba mais</p>';
  const output = await translations.translateHtml(html, 'en', fakeApi);
  assert.match(output, /<p>Hello world<\/p><figure class="article-video"><iframe src="https:\/\/www.youtube-nocookie.com\/embed\/dQw4w9WgXcQ"><\/iframe><\/figure>/);
  assert.match(output, /<figcaption>Hello world<\/figcaption>/);
  assert.match(output, /<span>Image<\/span>/);
  assert.match(output, /<\/figure><p>Learn more<\/p>$/);
});

test('cores do texto permanecem nas versões traduzidas', async () => {
  const output = await translations.translateHtml('<p><span class="ll-color-cyan">Olá</span> <span class="ll-color-red">mundo</span></p>', 'en', fakeApi);
  assert.match(output, /<span class="ll-color-cyan">Hello<\/span>/);
  assert.match(output, /<span class="ll-color-red">world<\/span>/);
});

test('prompt copiável mantém texto literal nas traduções', async () => {
  const html = '<p>Olá mundo</p><figure class="article-prompt-block" translate="no"><button>Copiar</button><pre><code class="article-prompt-text">Olá mundo\n<literal></code></pre></figure>';
  const output = await translations.translateHtml(html, 'en', fakeApi);
  assert.match(output, /<p>Hello world<\/p>/);
  assert.match(output, /<figure class="article-prompt-block" translate="no"><button>Copiar<\/button>/);
  assert.match(output, /Olá mundo/);
});

test('espaços ao redor de marcação inline são recuperados sem alterar pontuação', () => {
  const original = '<p>Conectei o <strong>Supabase</strong>. Leia <a href="/">o artigo</a> agora.</p>';
  const translated = '<p>I connected the<strong>Supabase</strong>. Read<a href="/">the article</a>now.</p>';
  assert.equal(translations.restoreInlineWhitespace(original, translated),
    '<p>I connected the <strong>Supabase</strong>. Read <a href="/">the article</a> now.</p>');
  assert.equal(translations.restoreInlineWhitespace(original, translated),
    translations.restoreInlineWhitespace(original, translations.restoreInlineWhitespace(original, translated)));
  assert.equal(
    translations.restoreInlineWhitespace('<p>Conectei o <strong>Supabase</strong>. A ideia</p>', '<p>I connected the<strong>Supabase</strong>The idea</p>'),
    '<p>I connected the <strong>Supabase</strong>. The idea</p>'
  );
});

test('metadados e hash da fonte acompanham alterações do artigo', async () => {
  const post = { title: 'Olá mundo', excerpt: 'Olá mundo', seo_title: '', seo_description: '',
    category: 'Olá mundo', cta_label: 'Saiba mais', tags: ['Olá mundo'], content: '<p>Olá mundo</p>' };
  const translated = await translations.translatePost(post, 'en', fakeApi);
  assert.equal(translated.title, 'Hello world');
  assert.equal(translated.seo_title, 'Hello world');
  assert.deepEqual(translated.tags, ['Hello world']);
  assert.equal(translated.content, '<p>Hello world</p>');
  assert.equal(translated.source_hash, translations.sourceHash(post));
  assert.equal(translations.sourceHash({ ...post, updated_at: 'later' }), translated.source_hash);
  assert.notEqual(translations.sourceHash({ ...post, content: '<p>Outro texto</p>' }), translated.source_hash);
});

test('DeepSeek traduz os quatro idiomas com JSON estruturado e sem enviar HTML', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const input = JSON.parse(JSON.parse(options.body).messages[1].content).texts;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ translations: input.map(value => `translated: ${value}`) })
    } }] }) };
  };
  try {
    for (const lang of translations.TARGETS) {
      const output = await translations.deepseekTranslateBatch(['Olá mundo'], 'text/plain', lang, 'test-server-key', 'Título');
      assert.deepEqual(output, ['translated: Olá mundo']);
    }
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.url === 'https://api.deepseek.com/v1/chat/completions'));
    assert.ok(requests.every(request => request.options.headers.Authorization === 'Bearer test-server-key'));
    assert.ok(requests.every(request => request.body.model === 'deepseek-flash'
      && request.body.response_format.type === 'json_object' && request.body.thinking.type === 'disabled'));
    assert.ok(requests.every(request => !request.options.body.includes('<p>')));
  } finally { global.fetch = originalFetch; }
});

test('tradução incompleta não é publicada', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) });
  try {
    await assert.rejects(
      translations.deepseekTranslateBatch(['Texto'], 'text/plain', 'en', 'test-server-key'),
      /cortada/
    );
  } finally { global.fetch = originalFetch; }
});

test('lote incompleto é dividido sem perder nem reordenar os trechos', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_, options) => {
    const texts = JSON.parse(JSON.parse(options.body).messages[1].content).texts;
    requests.push(texts);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ translations: texts.length > 1 ? texts.slice(0, -1) : texts.map(text => `EN ${text}`) })
    } }] }) };
  };
  try {
    const result = await translations.deepseekTranslateBatch(['um', 'dois', 'três'], 'text/plain', 'en', 'test-server-key');
    assert.deepEqual(result, ['EN um', 'EN dois', 'EN três']);
    assert.ok(requests.some(batch => batch.length === 3));
    assert.ok(requests.some(batch => batch.length === 1));
  } finally { global.fetch = originalFetch; }
});

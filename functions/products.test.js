const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankProducts } = require('./product-ranking');
const { fields, salesPage, publicShape, handler, thirtyDayStats } = require('./products');
const admin = require('./admin');

test('contextual offers prefer course matching article topic and ignore drafts or other languages', () => {
  const article = { language: 'pt-BR', title: 'Edição de vídeo com IA', category: 'Edição de vídeo',
    tags: ['motion graphics', 'Codex'], excerpt: 'Animação e efeitos para vídeos curtos',
    content: '<p>Motion graphics com Codex na edição de vídeo.</p>' };
  const base = { status: 'published', offer_enabled: true, language: 'pt-BR', checkout_url: 'https://checkout.example/pagar' };
  const products = [
    { ...base, slug: 'outro', title: 'Vendas', category: 'Marketing', tags: ['vendas'] },
    { ...base, slug: 'curso', title: 'Motion graphics', category: 'Edição de vídeo', tags: ['Codex', 'motion graphics'] },
    { ...base, slug: 'rascunho', status: 'draft', tags: ['Codex'] },
    { ...base, slug: 'ingles', language: 'en', tags: ['Codex'] }
  ];
  assert.deepEqual(rankProducts(article, products).map(p => p.slug), ['curso']);
  assert.equal(rankProducts({ ...article, tags: [], title: 'Receitas', category: 'Culinária', excerpt: '', content: '' }, products).length, 0);
});

test('product publication requires checkout and rejects script URLs', () => {
  const base = { blog_id: 'your-blog', slug: 'curso', title: 'Curso', price_cents: 2790, status: 'published', description: 'Curso completo', cover_url: 'https://example.com/capa.png' };
  assert.throws(() => fields(base), /checkout/);
  assert.throws(() => fields({ ...base, checkout_url: 'javascript:alert(1)' }), /HTTPS/);
  assert.throws(() => fields({ ...base, checkout_url: 'https://checkout.example', cover_url: 'data:image/svg+xml,<svg>' }), /HTTPS/);
  const valid = fields({ ...base, checkout_url: 'https://checkout.example/pagar', tags: ['Codex'] });
  assert.equal(valid.price_cents, 2790);
  assert.equal(publicShape(valid).url, '/produto/curso');
});

test('sales page escapes text and routes checkout through measured redirect', () => {
  const product = fields({ blog_id: 'your-blog', slug: 'curso', title: '<script>alert(1)</script>',
    description: 'Aulas & exercícios', price_cents: 2790, status: 'published', cover_url: 'https://example.com/capa.png',
    checkout_url: 'https://checkout.example/pagar' });
  const html = salesPage(product);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('/api/products/go?slug=curso'));
  assert.ok(!html.includes('https://checkout.example/pagar'));
  assert.ok(html.includes('R$'));
});

test('management actions require administrator before reading or writing products', async () => {
  const original = admin.requireAdmin_;
  let checked = 0;
  admin.requireAdmin_ = async () => { checked++; return null; };
  try {
    const response = { set() { return this; }, status() { return this; }, json() { throw new Error('No data should be exposed'); } };
    await handler({ path: '/api/products/list', method: 'GET', query: {} }, response);
    await handler({ path: '/api/products/save', method: 'POST', body: {} }, response);
    await handler({ path: '/api/products/delete', method: 'POST', body: {} }, response);
    await handler({ path: '/api/products/stats', method: 'GET', query: {} }, response);
    await handler({ path: '/api/products/preview', method: 'GET', query: { slug: 'artigo' } }, response);
    assert.equal(checked, 5);
  } finally { admin.requireAdmin_ = original; }
});

test('last-30-day offer metrics exclude older and future events', () => {
  const stats = thirtyDayStats({ daily: {
    20260929: { impressions: 9 },
    20261029: { impressions: 3, article_clicks: 2 },
    20261030: { checkout_clicks: 1 },
    20261031: { impressions: 5 }
  } }, new Date('2026-10-30T12:00:00Z'));
  assert.deepEqual(stats, { impressions: 3, article_clicks: 2, checkout_clicks: 1 });
});

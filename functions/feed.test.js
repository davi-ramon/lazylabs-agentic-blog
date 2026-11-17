const { test } = require('node:test');
const assert = require('node:assert/strict');
const ranker = require('../public/feed/ranking');
const { feedExcerpt } = require('./posts');

const now = Date.parse('2026-10-30T12:00:00Z');
const posts = [
  { slug: 'crm-ia', status: 'published', title: 'CRM com agentes de IA', category: 'CRM e Automação', tags: ['CRM', 'agentes de IA'], published_at: '2026-09-10T12:00:00Z' },
  { slug: 'cinema', status: 'published', title: 'Cinema e filmes', category: 'Cultura', tags: ['cinema'], published_at: '2026-10-29T12:00:00Z' },
  { slug: 'oculto', status: 'draft', title: 'CRM oculto', category: 'CRM e Automação', tags: ['CRM'], published_at: '2026-10-30T12:00:00Z' }
];

test('feed padrão prioriza novidade e nunca mostra rascunhos', () => {
  assert.deepEqual(ranker.rank(posts, ranker.empty(), now).map(p => p.slug), ['cinema', 'crm-ia']);
});

test('interesse em CRM muda a ordem e tópicos são derivados dos artigos', () => {
  const profile = { enabled: true, terms: { crm: 20, agentes: 12, automacao: 8 }, seen: {} };
  assert.deepEqual(ranker.rank(posts, profile, now).map(p => p.slug), ['crm-ia', 'cinema']);
  assert.equal(ranker.topics(posts.filter(p => p.status === 'published'), profile)[0].label, 'CRM e Automação');
});

test('tokens normalizam acentos e rejeitam palavras vazias', () => {
  assert.deepEqual(ranker.tokens('Automação e IA: 123'), ['automacao']);
});

test('prévia entrega texto curto sem script ou HTML executável', () => {
  const result = feedExcerpt('<h2>Introdução</h2><p>Um projeto real &amp; aberto.</p><script>alert(1)</script>');
  assert.equal(result, 'Introdução Um projeto real & aberto.');
  assert.ok(!result.includes('alert'));
});

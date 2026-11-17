const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankRelated, thumbnail, youtubeId } = require('./recommendations');

test('related ranking favors shared tags and article vocabulary over publication date', () => {
  const source = { id: 'source', status: 'published', category: 'Agentes de IA', title: 'Blog automático com IA',
    tags: ['Automação', 'Newsletter', 'Apps Script'], excerpt: 'Um blog que publica conteúdo automaticamente',
    content: '<p>Newsletter e automação do blog. Newsletter para leitores com conteúdo.</p>' };
  const candidates = [
    { id: 'recent', status: 'published', category: 'Marketing', title: 'Vendas por telefone', tags: ['Vendas'], published_at: '2026-10-12T00:00:00Z' },
    { id: 'matching', status: 'published', category: 'Agentes de IA', title: 'Automação para o blog', tags: ['Automação', 'Newsletter'], published_at: '2025-01-01T00:00:00Z' },
    { id: 'source', status: 'published', title: 'Blog automático com IA', tags: ['Automação'] },
    { id: 'draft', status: 'draft', title: 'Newsletter', tags: ['Newsletter'] }
  ];
  const picked = rankRelated(source, candidates, 3);
  assert.equal(picked[0].id, 'matching');
  assert.deepEqual(picked.map(p => p.id).sort(), ['matching', 'recent']);
  assert.equal(picked[0].thumbnail_url, '/assets/related-fallback.svg');
});

test('article words influence matches when tags are absent', () => {
  const source = { id: 'one', status: 'published', title: 'Um relato', content: '<p>Privacidade e segurança. Privacidade para leitores. Segurança dos dados.</p>' };
  const pool = [
    { id: 'two', status: 'published', title: 'Privacidade e segurança dos dados', tags: [] },
    { id: 'three', status: 'published', title: 'Receitas de cozinha', tags: [] }
  ];
  assert.equal(rankRelated(source, pool)[0].id, 'two');
});

test('thumbnail uses cover, YouTube, then a local branded fallback', () => {
  const video = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.equal(youtubeId(video), 'dQw4w9WgXcQ');
  assert.equal(thumbnail({ cover_url: 'https://example.com/cover.png', video_url: video }), 'https://example.com/cover.png');
  assert.equal(thumbnail({ video_url: video }), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(thumbnail({ cover_url: 'javascript:alert(1)' }), '/assets/related-fallback.svg');
});

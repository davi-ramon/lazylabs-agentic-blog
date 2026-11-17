'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Taxonomy = require('./blog-taxonomy');

test('reutiliza categorias e tipos existentes ignorando caixa e acentos', () => {
  const items = Taxonomy.merge({ categories: ['Edição de Vídeo'], postTypes: [{ label: 'Guia Prático' }] });
  assert.equal(Taxonomy.resolveCategory('edição de vídeo', items), 'Edição de Vídeo');
  assert.deepEqual(Taxonomy.resolveType('TUTORIAL', items), { value: 'tutorial', label: 'Tutorial' });
  assert.deepEqual(Taxonomy.resolveType('guia pratico', items), { value: 'guia-pratico', label: 'Guia Prático' });
});

test('cria categoria e tipo novos com limites e sem HTML', () => {
  const items = Taxonomy.merge({});
  assert.equal(Taxonomy.resolveCategory('Edição de Vídeo', items), 'Edição de Vídeo');
  assert.deepEqual(Taxonomy.resolveType('Análise Técnica', items), { value: 'analise-tecnica', label: 'Análise Técnica' });
  assert.equal(Taxonomy.resolveCategory('<script>', items), '');
  assert.equal(Taxonomy.resolveType('Um tipo de post com nome longo demais', items), null);
});

test('salva opções no Firestore sem duplicar tags nem apagar padrões', async () => {
  let data = {};
  const store = { doc: () => ({ get: async () => ({ exists: true, data: () => data }) }), runTransaction: async callback => callback({
    get: async () => ({ exists: true, data: () => data }),
    set: (_ref, update) => { data = update; }
  }) };
  await Taxonomy.record(store, { category: 'Edição de Vídeo', postType: 'Tutorial', tags: ['Cloud Code', 'cloud code', 'Reels'] });
  await Taxonomy.record(store, { category: 'edição de vídeo', postType: 'tutorial', tags: ['Reels'] });
  const items = await Taxonomy.read(store);
  assert.equal(items.categories.filter(item => Taxonomy.key(item) === 'edicao de video').length, 1);
  assert.equal(items.postTypes.filter(item => item.value === 'tutorial').length, 1);
  assert.deepEqual(items.tags, ['Cloud Code', 'Reels']);
  assert.ok(items.categories.includes('Agentes de IA'));
});

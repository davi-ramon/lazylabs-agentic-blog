'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapPost } = require('./posts');

test('artigo salva categoria, tipo editorial e tags sem alterar post existente', () => {
  const row = mapPost({ titulo_final: 'Três repositórios para edição de vídeo', slug: 'tres-repositorios',
    categoria: 'Edição de Vídeo', tipo_post: 'tutorial', tipo_post_label: 'Tutorial',
    tags_csv: 'Claude Code, edição de vídeo', content_html: '<p>Passo a passo.</p>' }, null);
  assert.equal(row.category, 'Edição de Vídeo');
  assert.equal(row.post_type, 'tutorial');
  assert.equal(row.post_type_label, 'Tutorial');
  assert.deepEqual(row.tags, ['Claude Code', 'edição de vídeo']);
});

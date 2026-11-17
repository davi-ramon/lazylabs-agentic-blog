'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { activeModel } = require('./deepseek-model');
const { prepareArticle, finishArticle, finishInline, splitArticleForAi } = require('./editor-ai');
const { renderDiagram } = require('./article-diagram');

test('modelos DeepSeek aposentados usam o modelo atual', () => {
  assert.equal(activeModel('deepseek', 'deepseek-chat'), 'deepseek-flash');
  assert.equal(activeModel('deepseek', 'deepseek-reasoner'), 'deepseek-flash');
  assert.equal(activeModel('deepseek', 'deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(activeModel('groq', 'llama-test'), 'llama-test');
});

test('revisão mantém imagem e galeria na posição original e remove HTML perigoso da IA', () => {
  const original = '<p>Antes</p><figure class="article-gallery" onclick="bad()"><img src="https://example.com/a.jpg" onerror="bad()"></figure><p>Depois</p>';
  const prepared = prepareArticle(original);
  assert.equal(prepared.media.length, 1);
  assert.match(prepared.source, /\[\[MEDIA_1\]\]/);
  const edited = finishArticle('<p>Antes corrigido.</p>[[MEDIA_1]]<script>alert(1)</script><p>Depois corrigido.</p>', prepared.media);
  assert.match(edited, /Antes corrigido/);
  assert.match(edited, /Depois corrigido/);
  assert.match(edited, /article-gallery/);
  assert.doesNotMatch(edited, /onclick|onerror|<script/);
  assert.ok(edited.indexOf('Antes corrigido') < edited.indexOf('article-gallery'));
  assert.ok(edited.indexOf('article-gallery') < edited.indexOf('Depois corrigido'));
});

test('revisão recusa resposta que perdeu ou deslocou imagens', () => {
  const prepared = prepareArticle('<p>Um</p><img src="/a.png"><p>Dois</p><img src="/b.png">');
  assert.throws(() => finishArticle('<p>Texto</p>[[MEDIA_2]][[MEDIA_1]]', prepared.media), /posição/);
  assert.throws(() => finishArticle('<p>Texto</p>[[MEDIA_1]]', prepared.media), /posição/);
});

test('reescrita preserva botão inline e remove atributos perigosos', () => {
  const original = '<p>Antes</p><div class="article-cta-block"><a class="article-cta article-cta-github article-cta-purple" href="https://github.com/example/repo" onclick="bad()">Ver no GitHub</a></div><p>Depois</p>';
  const prepared = prepareArticle(original);
  assert.equal(prepared.media.length, 1);
  const edited = finishArticle('<p>Antes revisado</p>[[MEDIA_1]]<p>Depois revisado</p>', prepared.media);
  assert.match(edited, /article-cta-github article-cta-purple/);
  assert.match(edited, /https:\/\/github.com\/example\/repo/);
  assert.doesNotMatch(edited, /onclick/);
});

test('revisão preserva cores permitidas sem aceitar estilos ou eventos arbitrários', () => {
  const edited = finishArticle('<p><span class="ll-color-cyan" onclick="bad()" style="position:fixed">Destaque</span> <span class="ll-color-red">Alerta</span> <span class="outra-cor">Normal</span></p>', []);
  assert.match(edited, /class="ll-color-cyan"/);
  assert.match(edited, /class="ll-color-red"/);
  assert.doesNotMatch(edited, /onclick|style=|outra-cor/);
});

test('trecho parcial mantém apenas marcação inline segura', () => {
  const edited = finishInline('<p>Texto <strong>corrigido</strong> com <code>API</code>.</p><script>alert(1)</script>');
  assert.equal(edited, 'Texto <strong>corrigido</strong> com <code>API</code>.');
});

test('trecho completo preserva títulos e listas propostos pela IA', () => {
  const edited = finishArticle('<h2>Arquitetura</h2><ul><li>API</li><li>Banco de dados</li></ul>', []);
  assert.match(edited, /<h2>Arquitetura<\/h2>/);
  assert.match(edited, /<ul><li>API<\/li><li>Banco de dados<\/li><\/ul>/);
});

test('transcrição longa é dividida sem perder mídias e pode ser recomposta', () => {
  const source = '<p>' + 'Descrevo o fluxo do agente e do banco de dados. '.repeat(440) + '</p>'
    + '<figure class="article-video"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe></figure><p>Conclusão.</p>';
  const prepared = prepareArticle(source);
  const parts = splitArticleForAi(prepared.source);
  assert.ok(parts.filter(part => part.html).length >= 5);
  assert.ok(parts.filter(part => part.html).every(part => part.html.length <= 3500));
  assert.equal(parts.filter(part => part.marker).length, 1);
  const output = finishArticle(parts.map(part => part.html || part.marker).join('\n'), prepared.media);
  assert.match(output, /article-video/);
  assert.match(output, /youtube-nocookie\.com\/embed/);
  assert.match(output, /Conclusão/);
});

test('transcrição ditada como texto solto também é dividida', () => {
  const parts = splitArticleForAi('O agente consulta o servidor e retorna dados. '.repeat(500));
  assert.ok(parts.length >= 5);
  assert.ok(parts.every(part => part.html.length <= 3500));
  assert.match(parts[0].html, /^<p>/);
});

test('vídeo externo permitido é preservado e iframe arbitrário é removido', () => {
  const original = '<p>Vídeo</p><figure class="article-video"><iframe src="https://player.vimeo.com/video/12345" onclick="bad()"></iframe></figure>'
    + '<figure><iframe src="https://attacker.example/embed/x"></iframe></figure>';
  const prepared = prepareArticle(original);
  const edited = finishArticle('<p>Assista.</p>[[MEDIA_1]][[MEDIA_2]]', prepared.media);
  assert.match(edited, /player\.vimeo\.com\/video\/12345/);
  assert.doesNotMatch(edited, /attacker|onclick/);
});

test('diagrama é HTML controlado, escapa texto da IA e não executa scripts', () => {
  const diagram = renderDiagram({ title: 'Fluxo <script>', nodes: [
    { label: 'Cliente', detail: 'Inicia <script>alert(1)</script>' },
    { label: 'Servidor', detail: 'Responde' }
  ] }, { layout: 'flow', theme: 'neon', motion: 'trace' });
  assert.match(diagram, /article-diagram diagram-flow diagram-neon diagram-motion-trace/);
  assert.doesNotMatch(diagram, /<script>/);
  assert.match(diagram, /&lt;script&gt;/);
  const prepared = prepareArticle('<p>Contexto</p>' + diagram + '<p>Fim</p>');
  assert.match(finishArticle('<p>Contexto</p>[[MEDIA_1]]<p>Fim</p>', prepared.media), /diagram-track/);
});

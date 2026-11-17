'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { articleMarkdown, markdownFromHtml } = require('./article-markdown');

test('public article converts structure and media without executing markup', () => {
  const html = '<h2>Como funciona</h2><p>Leia <strong>agora</strong> o <a href="/artigo/exemplo">exemplo</a>.</p>'
    + '<ul><li>Primeiro passo</li><li>Segundo passo</li></ul>'
    + '<figure><img src="https://blog.example.com/media/capa.jpg" alt="Fluxo"><figcaption>Visão geral</figcaption></figure>'
    + '<pre><code>const value = 1;</code></pre><iframe src="https://www.youtube.com/embed/abc12345678"></iframe>';
  const markdown = markdownFromHtml(html);
  assert.match(markdown, /## Como funciona/);
  assert.match(markdown, /\*\*agora\*\*/);
  assert.match(markdown, /\[exemplo\]\(https:\/\/blog\.example\.com\/artigo\/exemplo\)/);
  assert.match(markdown, /- Primeiro passo\n- Segundo passo/);
  assert.match(markdown, /!\[Fluxo\]\(https:\/\/blog\.example\.com\/media\/capa\.jpg\)/);
  assert.match(markdown, /```\nconst value = 1;\n```/);
  assert.match(markdown, /\[Vídeo incorporado\]/);
  assert.doesNotMatch(markdown, /<iframe|<script/);
});

test('published Markdown includes source, language and article text only', () => {
  const post = {
    title: 'Projeto de IA', excerpt: 'Um resumo.', content: '<p>Texto completo.</p>',
    author_name: 'Editor', tags: ['IA', 'Apps Script'], internal_notes: 'segredo'
  };
  const markdown = articleMarkdown(post, 'pt-BR', 'https://blog.example.com/artigo/projeto-de-ia');
  assert.match(markdown, /^# Projeto de IA/);
  assert.match(markdown, /Fonte: https:\/\/blog\.example\.com\/artigo\/projeto-de-ia/);
  assert.match(markdown, /Idioma: pt-BR/);
  assert.match(markdown, /Texto completo\./);
  assert.doesNotMatch(markdown, /segredo/);
});

test('prompt panel exports full text without its UI controls', () => {
  const html = '<figure class="article-prompt-block" translate="no"><div><button>Copiar</button></div>'
    + '<pre><code class="article-prompt-text">Linha 1\nLinha 2 com ```</code></pre>'
    + '<button>Ver prompt completo</button></figure>';
  const markdown = markdownFromHtml(html);
  assert.match(markdown, /\*\*Prompt para IA\*\*/);
  assert.match(markdown, /````text\nLinha 1\nLinha 2 com ```\n````/);
  assert.doesNotMatch(markdown, /Copiar|Ver prompt completo/);
});

test('short video blocks expose their original link once in Markdown', () => {
  const html = '<figure class="article-video article-video-portrait" data-video-url="https://www.instagram.com/reel/C12345AbcDE/">'
    + '<figcaption>Instagram Reel</figcaption><iframe src="https://www.instagram.com/reel/C12345AbcDE/embed/"></iframe>'
    + '<a href="https://www.instagram.com/reel/C12345AbcDE/">Abrir no Instagram</a></figure>';
  const markdown = markdownFromHtml(html);
  assert.equal(markdown, '[Vídeo incorporado](https://www.instagram.com/reel/C12345AbcDE/)');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

test('article exposes Markdown in head without visible instruction', () => {
  const source = fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
  assert.match(source,/rel="alternate" type="text\/markdown"/);
  assert.doesNotMatch(source,/Para ler ou resumir este artigo com uma IA/);
  const template = fs.readFileSync(path.join(__dirname,'article-template.html'),'utf8');
  assert.doesNotMatch(template,/Para ler ou resumir este artigo com uma IA/);
  const $ = cheerio.load(template);
  assert.equal($('.art-meta .metric').length,4);
  $('script:not([src])').each((_,node) => { new Function($(node).html()); });
});

test('hosting routes reader API before generic API and feed opens articles directly', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname,'../firebase.json'),'utf8'));
  const routes = config.hosting.rewrites.map(item => item.source);
  assert.ok(routes.indexOf('/api/reader/**') < routes.indexOf('/api/**'));
  assert.ok(routes.includes('/favoritos'));
  const app = fs.readFileSync(path.join(__dirname,'../public/feed/app.js'),'utf8');
  assert.doesNotMatch(app,/previewDialog|openPreview|preview\.showModal/);
});

test('article sanitizer preserves only recognized video embeds', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const safeSource = source.slice(source.indexOf('function safeArticleHtml('), source.indexOf('function shareImage('));
  const safeArticleHtml = new Function('cheerio', 'LazyMedia', safeSource + '; return safeArticleHtml;')(cheerio, require('./media-providers'));
  const html = '<figure class="article-video article-video-portrait"><iframe src="https://www.instagram.com/reel/DfvN1Fpia8N/embed/"></iframe></figure>'
    + '<iframe src="https://evil.example/tracker"></iframe>';
  const $ = cheerio.load(safeArticleHtml(html));
  assert.equal($('iframe').length, 1);
  assert.equal($('iframe').attr('src'), 'https://www.instagram.com/reel/DfvN1Fpia8N/embed/');
});

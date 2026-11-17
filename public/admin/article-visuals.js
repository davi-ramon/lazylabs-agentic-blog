/* Embedded videos and AI-authored, code-rendered diagrams for the article editor. */
var articleVisualRange_ = null;
var articleVisualSelected_ = '';
var articleVisualPastedUrl_ = '';

function articleVisualRememberSelection() {
  var editor = document.getElementById('editor-area');
  var selection = window.getSelection();
  if (!editor || !selection.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
  articleVisualRange_ = selection.getRangeAt(0).cloneRange();
  if (!selection.isCollapsed) articleVisualSelected_ = selection.toString().trim();
}

function articleVisualInsertBlocks(blocks) {
  var editor = document.getElementById('editor-area');
  var range = articleVisualRange_;
  var node = range && range.endContainer;
  var top = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode);
  while (top && top !== editor && top.parentNode !== editor) top = top.parentNode;
  var paragraph = document.createElement('p'); paragraph.appendChild(document.createElement('br'));
  var nodes = blocks.concat(paragraph);
  if (top && top !== editor && top.parentNode === editor) {
    top.after.apply(top, nodes);
    if (!top.textContent.trim() && top.matches('p,div')) top.remove();
  } else editor.append.apply(editor, nodes);
  articleVisualRange_ = null;
  updateWordCount();
}

function articleVisualInsertBlock(block) { articleVisualInsertBlocks([block]); }

function articleVisualVideoInputs_(value) {
  var input = String(value || '').trim();
  if (!input) return [];
  // Um snippet HTML pode conter quebras de linha e scripts do provedor.
  // Interpretamos apenas seus atributos de URL; links simples vão um por linha.
  return input.startsWith('<') ? [input] : input.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
}

function articleVisualInsertPastedUrl_() {
  if (!articleVisualPastedUrl_) return;
  var editor = document.getElementById('editor-area');
  var range = articleVisualRange_;
  if (range && editor.contains(range.startContainer)) {
    range.deleteContents();
    var text = document.createTextNode(articleVisualPastedUrl_);
    range.insertNode(text);
    range.setStartAfter(text); range.collapse(true);
    var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  } else editor.appendChild(document.createTextNode(articleVisualPastedUrl_));
  updateWordCount();
}

function openInlineVideo(pastedUrl) {
  if (!pastedUrl) articleVisualRememberSelection();
  articleVisualPastedUrl_ = pastedUrl ? (LazyMedia.embeddedUrl(pastedUrl) || pastedUrl) : '';
  document.getElementById('article-video-url').value = pastedUrl || '';
  document.getElementById('article-video-error').hidden = true;
  document.getElementById('article-video-dialog').hidden = false;
  document.getElementById('article-video-url').focus();
}

function closeInlineVideo(saved) {
  document.getElementById('article-video-dialog').hidden = true;
  if (!saved) articleVisualInsertPastedUrl_();
  articleVisualPastedUrl_ = '';
  articleVisualRange_ = null;
}

async function saveInlineVideo() {
  var input = document.getElementById('article-video-url').value.trim();
  var inputs = articleVisualVideoInputs_(input);
  var error = document.getElementById('article-video-error');
  var button = document.getElementById('article-video-save');
  error.hidden = true;
  if (!inputs.length || inputs.length > 20) {
    error.textContent = 'Cole de 1 a 20 links públicos, um por linha, ou um código de incorporação.';
    error.hidden = false; return;
  }
  button.disabled = true; button.textContent = inputs.length > 1 ? 'Incorporando vídeos...' : 'Incorporando vídeo...';
  try {
    var items = [];
    for (var index = 0; index < inputs.length; index++) {
      var url = LazyMedia.embeddedUrl(inputs[index]);
      var media = LazyMedia.embedVideo(inputs[index]);
      if (!media && LazyMedia.shortVideoUrl(url)) {
        var resolved = await fbFetch_('/api/posts/resolveVideoLink', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) });
        if (!resolved || !resolved.ok) throw new Error(resolved && resolved.message || 'Não foi possível abrir o link curto.');
        url = resolved.url;
        media = LazyMedia.video(url);
      }
      if (!media || !['youtube','vimeo','drive','instagram','tiktok'].includes(media.provider))
        throw new Error('Linha ' + (index + 1) + ': use um link público do Instagram, TikTok, YouTube, Vimeo ou Drive.');
      items.push({ media: media, url: url });
    }
    if (document.getElementById('article-video-dialog').hidden) return;
    var figures = items.map(function (item) { return articleVisualVideoFigure_(item.media, item.url); });
    articleVisualInsertBlocks(figures);
    closeInlineVideo(true);
    showToast(figures.length > 1 ? figures.length + ' vídeos incorporados. Na prévia, vídeos verticais seguidos formam um carrossel.' : 'Vídeo incorporado entre os parágrafos.', 'success');
  } catch (exception) {
    error.textContent = exception.message || 'Não foi possível incorporar os vídeos.';
    error.hidden = false;
  } finally { button.disabled = false; button.textContent = 'Incorporar vídeo'; }
}

function articleVisualVideoFigure_(media, url) {
  var figure = document.createElement('figure');
  figure.className = 'article-video' + (media.portrait ? ' article-video-portrait' : '');
  figure.setAttribute('contenteditable', 'false');
  figure.setAttribute('data-video-provider', media.provider);
  figure.setAttribute('data-video-url', media.href || url);
  if (media.portrait) {
    var heading = document.createElement('figcaption');
    heading.className = 'article-video-head';
    heading.textContent = ({ instagram: 'Instagram Reel', tiktok: 'TikTok', youtube: 'YouTube Short' })[media.provider] || 'Vídeo curto';
    figure.appendChild(heading);
  }
  var iframe = document.createElement('iframe');
  iframe.src = media.src; iframe.title = 'Vídeo do ' + media.provider + ' incorporado no artigo'; iframe.loading = 'lazy';
  iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true; iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  figure.appendChild(iframe);
  if (media.href) {
    var source = document.createElement('a');
    source.className = 'article-video-source'; source.href = media.href;
    source.target = '_blank'; source.rel = 'noopener noreferrer';
    source.textContent = 'Abrir no ' + (({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' })[media.provider] || media.provider);
    figure.appendChild(source);
  }
  return figure;
}

function openInlineDiagram() {
  articleVisualRememberSelection();
  document.getElementById('article-selection-menu').hidden = true;
  var selected = articleVisualSelected_;
  if (selected.length < 80 || selected.length > 4500 || !articleVisualRange_) {
    showToast('Selecione uma explicação de 80 a 4.500 caracteres para gerar o diagrama.', 'error'); return;
  }
  document.getElementById('article-diagram-selection').textContent = selected.slice(0, 250) + (selected.length > 250 ? '…' : '');
  document.getElementById('article-diagram-error').hidden = true;
  document.getElementById('article-diagram-dialog').hidden = false;
}

function closeInlineDiagram() {
  document.getElementById('article-diagram-dialog').hidden = true;
}

async function generateInlineDiagram() {
  var editor = document.getElementById('editor-area');
  var before = editor.innerHTML;
  var selected = articleVisualSelected_;
  var button = document.getElementById('article-diagram-generate');
  var error = document.getElementById('article-diagram-error');
  button.disabled = true; button.textContent = 'Criando visual...'; error.hidden = true;
  try {
    var result = await fbFetch_('/api/davi/diagram', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: selected, layout: document.getElementById('article-diagram-layout').value,
        theme: document.getElementById('article-diagram-theme').value, motion: document.getElementById('article-diagram-motion').value }) });
    if (!result || !result.ok || !result.html) throw new Error(result && result.message || 'Não foi possível criar o diagrama.');
    if (editor.innerHTML !== before) throw new Error('O artigo mudou durante a geração. Selecione o trecho novamente para não perder alterações.');
    var template = document.createElement('template'); template.innerHTML = result.html;
    var figure = template.content.firstElementChild;
    if (!figure || !figure.classList.contains('article-diagram')) throw new Error('A IA devolveu um visual inválido.');
    articleVisualInsertBlock(figure);
    closeInlineDiagram();
    showToast('Diagrama inserido. Revise as etapas antes de publicar.', 'success');
  } catch (exception) {
    error.textContent = exception.message || 'Falha ao criar diagrama.'; error.hidden = false;
  } finally { button.disabled = false; button.textContent = 'Gerar diagrama'; }
}

document.addEventListener('DOMContentLoaded', function() {
  var editor = document.getElementById('editor-area');
  var action = document.getElementById('article-selection-menu');
  var diagramAction = document.getElementById('article-selection-action');
  editor.addEventListener('paste', function(event) {
    if (event.defaultPrevented || event.clipboardData.files.length) return;
    var text = event.clipboardData.getData('text/plain').trim();
    var inputs = articleVisualVideoInputs_(text);
    if (!inputs.length || inputs.length > 20 || !inputs.every(function (input) {
      var url = window.LazyMedia && LazyMedia.embeddedUrl(input);
      var media = window.LazyMedia && LazyMedia.embedVideo(input);
      return (media && ['youtube','vimeo','drive','instagram','tiktok'].includes(media.provider)) || LazyMedia.shortVideoUrl(url);
    })) return;
    event.preventDefault(); articleVisualRememberSelection(); openInlineVideo(text);
  });
  function selectionAction() {
    setTimeout(function() {
      var selection = window.getSelection();
      if (!selection.rangeCount || selection.isCollapsed || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) { action.hidden = true; return; }
      articleVisualRememberSelection();
      if (articleVisualSelected_.length < 15 || articleVisualSelected_.length > 25000) { action.hidden = true; return; }
      diagramAction.hidden = articleVisualSelected_.length < 80 || articleVisualSelected_.length > 4500;
      var rect = selection.getRangeAt(0).getBoundingClientRect();
      action.hidden = false;
      action.style.left = Math.max(8, Math.min(window.innerWidth - action.offsetWidth - 8, rect.left)) + 'px';
      action.style.top = Math.max(8, rect.top - action.offsetHeight - 8) + 'px';
    }, 0);
  }
  editor.addEventListener('mouseup', selectionAction);
  editor.addEventListener('keyup', selectionAction);
  document.getElementById('article-video-dialog').addEventListener('click', function(event) { if (event.target === this) closeInlineVideo(); });
  document.getElementById('article-diagram-dialog').addEventListener('click', function(event) { if (event.target === this) closeInlineDiagram(); });
  document.addEventListener('keydown', function(event) {
    if (event.key !== 'Escape') return;
    if (!document.getElementById('article-video-dialog').hidden) closeInlineVideo();
    if (!document.getElementById('article-diagram-dialog').hidden) closeInlineDiagram();
  });
});

/* Inline article actions and collapsible sections for the manual editor. */
var articleButtonTarget_ = null;
var articleButtonRange_ = null;
var ARTICLE_BUTTON_COLORS_ = ['cyan','purple','pink','yellow','green'];
var ARTICLE_BUTTON_KINDS_ = ['link','github','download'];

function articleButtonRememberCaret() {
  var editor = document.getElementById('editor-area');
  var selection = window.getSelection();
  if (editor && selection.rangeCount && editor.contains(selection.anchorNode)) articleButtonRange_ = selection.getRangeAt(0).cloneRange();
  else if (typeof _mediaRange !== 'undefined' && _mediaRange) articleButtonRange_ = _mediaRange.cloneRange();
}

function openArticleButtonEditor(block) {
  articleButtonTarget_ = block || null;
  if (!block) articleButtonRememberCaret();
  var link = block && block.querySelector('a.article-cta');
  var kind = link && ARTICLE_BUTTON_KINDS_.find(function(value) { return link.classList.contains('article-cta-' + value); });
  var color = link && ARTICLE_BUTTON_COLORS_.find(function(value) { return link.classList.contains('article-cta-' + value); });
  document.getElementById('article-button-kind').value = kind || 'link';
  document.getElementById('article-button-label').value = link ? link.textContent.trim() : '';
  document.getElementById('article-button-url').value = link ? link.getAttribute('href') || '' : '';
  document.getElementById('article-button-color').value = color || 'cyan';
  document.getElementById('article-button-error').hidden = true;
  ['up','down','delete'].forEach(function(action) { document.getElementById('article-button-' + action).hidden = !block; });
  document.getElementById('article-button-title').textContent = block ? 'Editar botão do artigo' : 'Adicionar botão ao artigo';
  document.getElementById('article-button-dialog').hidden = false;
  document.getElementById('article-button-label').focus();
}

function closeArticleButtonEditor() {
  document.getElementById('article-button-dialog').hidden = true;
  articleButtonTarget_ = null;
}

function articleButtonError_(message) {
  var error = document.getElementById('article-button-error');
  error.textContent = message;
  error.hidden = false;
}

function saveArticleButton() {
  var kind = document.getElementById('article-button-kind').value;
  var color = document.getElementById('article-button-color').value;
  var label = document.getElementById('article-button-label').value.trim();
  var rawUrl = document.getElementById('article-button-url').value.trim();
  var url;
  try { url = new URL(rawUrl); } catch (_) { return articleButtonError_('Informe um link HTTPS válido.'); }
  if (url.protocol !== 'https:' || url.username || url.password) return articleButtonError_('Use um link HTTPS sem usuário ou senha.');
  if (!label || label.length > 90) return articleButtonError_('Escreva um texto de até 90 caracteres.');
  if (!ARTICLE_BUTTON_KINDS_.includes(kind) || !ARTICLE_BUTTON_COLORS_.includes(color)) return articleButtonError_('Tipo ou cor inválidos.');

  var editor = document.getElementById('editor-area');
  var block = articleButtonTarget_;
  if (!block) {
    block = document.createElement('div');
    block.className = 'article-cta-block';
    block.setAttribute('contenteditable', 'false');
    var range = articleButtonRange_;
    var node = range && range.startContainer;
    if (node === editor) editor.insertBefore(block, editor.childNodes[range.startOffset] || null);
    else if (node && node.nodeType === Node.TEXT_NODE && node.parentNode === editor) {
      editor.insertBefore(block, node.splitText(range.startOffset));
    } else {
      var top = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode);
      while (top && top !== editor && top.parentNode !== editor) top = top.parentNode;
      if (top && top.parentNode === editor) top.after(block);
      else editor.appendChild(block);
    }
    if (!block.nextElementSibling || block.nextElementSibling.tagName !== 'P') {
      var paragraph = document.createElement('p'); paragraph.appendChild(document.createElement('br')); block.after(paragraph);
    }
  }
  var anchor = document.createElement('a');
  anchor.className = 'article-cta article-cta-' + kind + ' article-cta-' + color;
  anchor.href = url.href;
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = label;
  block.replaceChildren(anchor);
  closeArticleButtonEditor();
  articleButtonRange_ = null;
  updateWordCount();
  showToast('Botão salvo no artigo.', 'success');
}

function moveArticleButton(direction) {
  var block = articleButtonTarget_;
  var editor = document.getElementById('editor-area');
  if (!block || block.parentNode !== editor) return;
  var sibling = direction < 0 ? block.previousElementSibling : block.nextElementSibling;
  if (!sibling) return;
  if (direction < 0) sibling.before(block); else sibling.after(block);
  showToast('Botão movido.', 'success');
}

function deleteArticleButton() {
  if (articleButtonTarget_) articleButtonTarget_.remove();
  closeArticleButtonEditor();
  updateWordCount();
}

function initArticleButtonEditor_() {
  var editor = document.getElementById('editor-area');
  if (!editor) return;
  editor.addEventListener('click', function(event) {
    var block = event.target.closest('.article-cta-block');
    if (!block || !editor.contains(block)) return;
    event.preventDefault();
    openArticleButtonEditor(block);
  });
  document.getElementById('article-button-dialog').addEventListener('click', function(event) {
    if (event.target === this) closeArticleButtonEditor();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && !document.getElementById('article-button-dialog').hidden) closeArticleButtonEditor();
    if (event.key === 'Escape' && !document.getElementById('article-image-dialog').hidden) closeArticleImageGenerator();
  });
  document.getElementById('article-image-dialog').addEventListener('click', function(event) {
    if (event.target === this) closeArticleImageGenerator();
  });
}

function openArticleImageGenerator() {
  articleButtonRememberCaret();
  if (articleButtonRange_) _mediaRange = articleButtonRange_.cloneRange();
  document.getElementById('article-image-error').hidden = true;
  document.getElementById('article-image-dialog').hidden = false;
  document.getElementById('article-image-prompt').focus();
}

function closeArticleImageGenerator() {
  document.getElementById('article-image-dialog').hidden = true;
}

async function generateInlineArticleImage() {
  var article = (document.getElementById('editor-area').innerText || '').trim();
  var prompt = document.getElementById('article-image-prompt').value.trim();
  var error = document.getElementById('article-image-error');
  if (article.length < 150 || prompt.length < 8) {
    error.textContent = 'Escreva pelo menos 150 caracteres no artigo e descreva a imagem em 8 caracteres ou mais.';
    error.hidden = false; return;
  }
  var button = document.getElementById('article-image-generate-btn');
  button.disabled = true; button.textContent = 'Gerando...';
  closeArticleImageGenerator();
  var id = mediaPlaceholder();
  var placeholder = document.querySelector('[data-media-id="' + id + '"]');
  if (placeholder) placeholder.textContent = 'Gerando imagem com IA...';
  _mediaUploads++;
  try {
    var result = await fbFetch_('/api/davi/image', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ title:document.getElementById('f-title').value, article:article.slice(0, 12000), prompt:prompt }) });
    if (!result || !result.ok) throw new Error((result && result.message) || 'Falha ao gerar a imagem.');
    placeholder = document.querySelector('[data-media-id="' + id + '"]');
    if (placeholder) {
      var figure = document.createElement('figure'); figure.className = 'article-image';
      figure.setAttribute('contenteditable', 'false');
      var img = document.createElement('img'); img.src = result.url; img.alt = prompt.slice(0, 180); img.loading = 'lazy';
      figure.appendChild(img); placeholder.replaceWith(figure); updateWordCount();
    }
    showToast('Imagem criada no artigo. Revise antes de publicar.', 'success');
  } catch (exception) {
    placeholder = document.querySelector('[data-media-id="' + id + '"]');
    if (placeholder) placeholder.remove();
    showToast(exception.message || 'Falha ao gerar a imagem.', 'error');
  } finally { _mediaUploads--; button.disabled = false; button.textContent = 'Gerar imagem'; }
}

function initCollapsibleEditorSections_() {
  document.querySelectorAll('#section-escrever .left-col > .card').forEach(function(card, index) {
    var first = card.firstElementChild;
    if (!first) return;
    var head = document.createElement('div'); head.className = 'editor-collapse-head';
    var body = document.createElement('div'); body.className = 'editor-collapse-body';
    card.insertBefore(head, first); head.appendChild(first);
    while (head.nextSibling) body.appendChild(head.nextSibling);
    card.appendChild(body);
    var title = first.textContent.trim() || 'Seção';
    var toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'editor-collapse-toggle';
    toggle.setAttribute('aria-label', 'Recolher ou expandir ' + title);
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = 'Recolher';
    var top = document.createElement('div'); top.className = 'editor-collapse-top';
    head.appendChild(top); top.append(first, toggle);
    var actions = document.createElement('div'); actions.className = 'editor-collapse-actions';
    var actionSelectors = ['#ai-metadata-btn', '.editor-toolbar', '#ai-project-btn', '.builder-image-ai', '.social-composer-actions', '#ai-all-metadata-btn'];
    var action = body.querySelector(actionSelectors.join(','));
    if (action) actions.appendChild(action);
    if (index === 0) {
      var integrations = body.querySelector('[onclick="openIntegrationCenter_(\'ai\')"]');
      if (integrations) actions.appendChild(integrations);
    }
    if (actions.childElementCount) head.appendChild(actions);
    var collapsed = index === 2;
    function sync() { body.hidden = collapsed; toggle.textContent = collapsed ? 'Expandir' : 'Recolher'; toggle.setAttribute('aria-expanded', String(!collapsed)); }
    toggle.addEventListener('click', function() { collapsed = !collapsed; sync(); });
    sync();
  });
}

function updateCoverPromptCount_(input) {
  var count = document.getElementById('ai-cover-prompt-count');
  if (count) count.textContent = input.value.length + '/2000';
}

async function generateArticleCover() {
  var article = (document.getElementById('editor-area').innerText || '').trim();
  if (article.length < 150) return showToast('Escreva pelo menos 150 caracteres para gerar a capa.', 'error');
  var button = document.getElementById('ai-cover-btn');
  var gallery = document.getElementById('cover-variants');
  var count = Math.max(1, Math.min(3, Number(document.getElementById('ai-cover-count').value) || 2));
  var visualPrompt = (document.getElementById('ai-cover-prompt').value || '').trim();
  var generated = 0;
  button.disabled = true;
  gallery.replaceChildren();
  var status = document.createElement('p');
  status.className = 'builder-cover-status';
  status.textContent = 'Preparando ' + count + ' opção(ões) de capa...';
  gallery.appendChild(status);
  try {
    for (var n = 1; n <= count; n++) {
      button.textContent = 'Gerando ' + n + '/' + count + '...';
      status.textContent = 'Gerando opção ' + n + ' de ' + count + '. Cada opção usa uma chamada da API.';
      try {
        var result = await fbFetch_('/api/davi/image', { method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ title:document.getElementById('f-title').value, article:article.slice(0, 12000), prompt:visualPrompt, variant:n }) });
        if (!result || !result.ok || !result.url) throw new Error((result && result.message) || 'Falha ao gerar a capa.');
        generated++;
        let choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'builder-cover-choice';
        choice.setAttribute('aria-label', 'Usar opção de capa ' + n);
        var image = document.createElement('img');
        image.src = result.url;
        image.alt = 'Capa gerada, opção ' + n;
        image.loading = 'lazy';
        var label = document.createElement('span');
        label.textContent = 'Usar esta capa';
        choice.append(image, label);
        choice.addEventListener('click', (function(url) { return function() {
          document.getElementById('f-cover').value = url;
          gallery.querySelectorAll('.builder-cover-choice').forEach(function(item) { item.classList.toggle('selected', item === choice); });
          document.getElementById('f-cover').dispatchEvent(new Event('input', { bubbles:true }));
          showToast('Capa selecionada. Revise antes de publicar.', 'success');
        }; })(result.url));
        gallery.appendChild(choice);
      } catch (error) {
        if (!generated) throw error;
        status.textContent = 'Uma opção falhou: ' + (error.message || 'erro de imagem') + '. As capas prontas continuam disponíveis.';
        break;
      }
    }
    if (generated === count) status.textContent = 'Escolha uma das ' + generated + ' capas para preencher o campo de imagem.';
  } catch (error) { status.textContent = error.message || 'Falha ao gerar a capa.'; showToast(status.textContent, 'error'); }
  finally { button.disabled = false; button.textContent = 'Gerar opções de capa com IA'; }
}

var editorColorRange_ = null;
var EDITOR_COLORS_ = ['cyan', 'blue', 'purple', 'pink', 'red', 'yellow', 'green'];
function rememberEditorColorRange_() {
  editorColorRange_ = null;
  var editor = document.getElementById('editor-area');
  var selection = window.getSelection();
  if (editor && selection.rangeCount && !selection.isCollapsed && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
    editorColorRange_ = selection.getRangeAt(0).cloneRange();
  }
}
function toggleEditorColors_() {
  var options = document.getElementById('editor-color-options');
  var trigger = document.querySelector('.editor-color-trigger');
  options.hidden = !options.hidden;
  trigger.setAttribute('aria-expanded', String(!options.hidden));
}
function applyEditorColor_(color) {
  if (!EDITOR_COLORS_.includes(color)) return;
  var editor = document.getElementById('editor-area');
  var range = editorColorRange_;
  var options = document.getElementById('editor-color-options');
  options.hidden = true;
  document.querySelector('.editor-color-trigger').setAttribute('aria-expanded', 'false');
  if (!range || range.collapsed || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
    showToast('Selecione primeiro a palavra ou o trecho que deseja colorir.', 'error'); return;
  }
  var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  var nodes = [];
  while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode);
  nodes.forEach(function(node) {
    var start = node === range.startContainer ? range.startOffset : 0;
    var end = node === range.endContainer ? range.endOffset : node.length;
    if (start >= end || !node.data.slice(start, end).trim()) return;
    if (end < node.length) node.splitText(end);
    var selected = start ? node.splitText(start) : node;
    var span = document.createElement('span'); span.className = 'll-color-' + color;
    selected.replaceWith(span); span.appendChild(selected);
  });
  editorColorRange_ = null;
  editor.focus();
  updateWordCount();
}

function setScheduleOpen_(open) {
  var card = document.getElementById('sched-card');
  var button = card && card.querySelector('.sched-toggle');
  var body = document.getElementById('sched-card-body');
  if (!card || !button || !body) return;
  card.classList.toggle('is-open', !!open);
  button.setAttribute('aria-expanded', String(!!open));
  body.setAttribute('aria-hidden', String(!open));
  body.inert = !open;
}
function toggleSchedule_() {
  var card = document.getElementById('sched-card');
  setScheduleOpen_(!card.classList.contains('is-open'));
}

function clearEditorForNext_(automatic) {
  var grid = document.querySelector('#section-escrever .main-grid');
  if (grid) { grid.classList.remove('is-resetting'); void grid.offsetWidth; grid.classList.add('is-resetting'); }
  ['f-title','f-slug','f-excerpt','f-tags','f-cover','f-images','f-video','f-tiktok-video','f-audio','ai-cover-prompt',
   'f-github','f-demo','f-seo-title','f-seo-desc','f-problem','f-solution','f-tech','f-result','f-client','f-obs','f-sched-dt'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  ['cover-image-file','editor-image-files','editor-gallery-files','tiktok-video-file'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  ['f-featured','f-auto-nl','f-auto-li','f-auto-wa','f-auto-facebook','f-auto-instagram','f-auto-x','f-auto-tiktok','f-sched-nl'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.checked = false;
  });
  var blog = document.getElementById('ch-blog'); if (blog) blog.checked = true;
  var translation = document.getElementById('f-auto-translate'); if (translation) translation.checked = true;
  var speech = document.getElementById('f-tts-enabled'); if (speech) speech.checked = true;
  var privacy = document.getElementById('f-tiktok-privacy'); if (privacy) privacy.value = '';
  var status = document.getElementById('f-status'); if (status) status.value = 'draft';
  ['f-category','f-type','f-author'].forEach(function(id) { var el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  document.getElementById('f-cta-label').value = 'Quero algo parecido';
  document.getElementById('f-cta-url').value = 'https://example.com/agendar';
  document.getElementById('editor-area').innerHTML = '';
  if (typeof editorFormatReset_ === 'function') editorFormatReset_();
  document.getElementById('slug-preview').textContent = '...';
  ['f-seo-title','f-seo-desc'].forEach(function(id) { var el = document.getElementById(id); if (el) delete el.dataset.manual; });
  ['f-excerpt','f-seo-title','f-seo-desc'].forEach(function(id) { var el = document.getElementById(id); if (el) el.dispatchEvent(new Event('input', { bubbles:true })); });
  ['f-seo-title','f-seo-desc'].forEach(function(id) { var el = document.getElementById(id); if (el) delete el.dataset.manual; });
  var proposal = document.getElementById('ai-metadata-proposal'); if (proposal) { proposal.hidden = true; proposal.replaceChildren(); }
  var coverVariants = document.getElementById('cover-variants'); if (coverVariants) coverVariants.replaceChildren();
  updateCoverPromptCount_(document.getElementById('ai-cover-prompt'));
  var area = document.querySelector('.main-area'); if (area) area.dataset.editId = '';
  var last = document.getElementById('last-submit'); if (last) { last.className = 'last-submit'; last.textContent = ''; }
  var nl = document.getElementById('nl-dispatch-card'); if (nl) nl.classList.add('hidden');
  if (typeof previewActive !== 'undefined' && previewActive) togglePreview();
  var prev = document.getElementById('preview-area'); if (prev) prev.replaceChildren();
  if (typeof socialReset === 'function') socialReset();
  if (typeof socialPreviewClose === 'function') socialPreviewClose();
  setScheduleOpen_(false);
  if (typeof previewArticleMedia === 'function') previewArticleMedia();
  updateWordCount();
  updatePublishButton();
  if (grid) setTimeout(function() { grid.classList.remove('is-resetting'); }, 470);
  if (automatic) window.scrollTo({ top:0, behavior:'smooth' });
}
function startNewArticle_() {
  var hasWork = ['f-title','f-slug','f-excerpt'].some(function(id) { return document.getElementById(id).value.trim(); }) || document.getElementById('editor-area').innerText.trim();
  if (hasWork && !confirm('Começar um novo artigo? O conteúdo não salvo deste editor será perdido.')) return;
  clearEditorForNext_(false);
  window.scrollTo({ top:0, behavior:'smooth' });
  setTimeout(function() { document.getElementById('f-title').focus(); }, 240);
}

document.addEventListener('DOMContentLoaded', function() {
  initArticleButtonEditor_(); initCollapsibleEditorSections_();
  ['f-title','f-slug','f-excerpt','editor-area'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.addEventListener('input', updatePublishButton);
  });
  var blog = document.getElementById('ch-blog'); if (blog) blog.addEventListener('change', updatePublishButton);
  setScheduleOpen_(false);
  updatePublishButton();
});

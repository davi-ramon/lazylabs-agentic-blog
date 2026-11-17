var aiEditorProposal_ = null;
var aiEditorBefore_ = '';
var aiEditorBusy_ = false;
var aiEditorScope_ = 'article';
var aiEditorRange_ = null;

function closeAiEditorPreview() {
  document.getElementById('ai-edit-overlay').classList.remove('open');
  aiEditorProposal_ = null;
  aiEditorRange_ = null;
  aiEditorScope_ = 'article';
}

function applyAiEditorPreview() {
  if (!aiEditorProposal_) return;
  var editor = document.getElementById('editor-area');
  if (editor.innerHTML !== aiEditorBefore_) {
    showToast('O artigo mudou durante a revisão. Gere uma nova sugestão para não perder suas alterações.', 'error');
    closeAiEditorPreview();
    return;
  }
  if (aiEditorScope_ === 'selection') {
    if (!aiEditorRange_ || !editor.contains(aiEditorRange_.startContainer) || !editor.contains(aiEditorRange_.endContainer)) {
      showToast('A seleção mudou. Selecione o trecho novamente.', 'error'); closeAiEditorPreview(); return;
    }
    editor.focus();
    var selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(aiEditorRange_);
    if (!document.execCommand('insertHTML', false, aiEditorProposal_)) {
      showToast('Não foi possível aplicar a sugestão. O trecho original foi mantido.', 'error');
      closeAiEditorPreview(); return;
    }
  } else editor.innerHTML = aiEditorProposal_;
  updateWordCount();
  if (typeof editorFormatRefresh_ === 'function') editorFormatRefresh_();
  closeAiEditorPreview();
  editor.focus();
  showToast('Sugestão aplicada. Continue editando antes de publicar.', 'success');
}

function aiEditorBlock_(node, editor) {
  var element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  while (element && element !== editor) {
    if (element.matches('p,h1,h2,h3,h4,li,blockquote,pre')) return element;
    element = element.parentElement;
  }
  return null;
}

function aiEditorSelectedFragment_(editor) {
  var range = typeof articleVisualRange_ !== 'undefined' && articleVisualRange_;
  if (!range || range.collapsed || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  range = range.cloneRange();
  var fragment = document.createElement('div');
  fragment.appendChild(range.cloneContents());
  var selected = range.toString().trim();
  if (selected.length < 15 || selected.length > 25000 || !fragment.innerHTML.trim()) return null;
  var startBlock = aiEditorBlock_(range.startContainer, editor);
  var endBlock = aiEditorBlock_(range.endContainer, editor);
  var sameBlock = startBlock && startBlock === endBlock;
  var inline = !!(sameBlock && selected !== (startBlock.innerText || '').trim());
  return { range: range, html: fragment.innerHTML, inline: inline,
    contextTag: startBlock ? startBlock.tagName.toLowerCase() : '' };
}

async function runAiEditor(mode, options) {
  if (aiEditorBusy_) return;
  if (window.articleVoiceBusy_ && window.articleVoiceBusy_()) {
    showToast('Aguarde a transcrição terminar antes de usar a IA.', 'error'); return;
  }
  var editor = document.getElementById('editor-area');
  var fullArticle = editor.innerHTML;
  var selectionMode = !!(options && options.selection);
  var fragment = selectionMode && aiEditorSelectedFragment_(editor);
  if (selectionMode && !fragment) {
    showToast('Selecione de 15 a 25 mil caracteres de texto para editar somente esse trecho.', 'error'); return;
  }
  if (!(editor.innerText || '').trim()) { showToast('Escreva o artigo antes de usar a IA.', 'error'); return; }
  if (!selectionMode && fullArticle.length > 60000) { showToast('Artigo muito grande. Limite: 60 mil caracteres.', 'error'); return; }
  var rewrite = mode === 'rewrite';
  var id = selectionMode ? (rewrite ? 'article-selection-rewrite' : 'article-selection-proofread')
    : (rewrite ? 'ai-rewrite-btn' : 'ai-proofread-btn');
  var btn = document.getElementById(id);
  var label = btn.textContent;
  var buttons = ['ai-rewrite-btn','ai-proofread-btn','article-selection-rewrite','article-selection-proofread']
    .map(function (name) { return document.getElementById(name); }).filter(Boolean);
  aiEditorBusy_ = true;
  buttons.forEach(function (item) { item.disabled = true; });
  btn.textContent = rewrite ? 'Reescrevendo...' : 'Revisando...';
  var menu = document.getElementById('article-selection-menu');
  if (menu) menu.hidden = true;
  try {
    var response = await fetch('/api/davi/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode, html: selectionMode ? fragment.html : fullArticle,
        scope: selectionMode ? 'selection' : 'article', inline: selectionMode ? fragment.inline : false,
        contextTag: selectionMode ? fragment.contextTag : '' })
    });
    var raw = await response.text();
    var data;
    try { data = JSON.parse(raw); }
    catch (_) { throw new Error('A API devolveu HTML em vez de JSON (HTTP ' + response.status + '). Tente novamente.'); }
    if (!response.ok || !data.ok) throw new Error(data.message || 'Falha HTTP ' + response.status);
    if (editor.innerHTML !== fullArticle) throw new Error('O artigo mudou durante a edição. Selecione o trecho novamente.');
    aiEditorBefore_ = fullArticle;
    aiEditorProposal_ = data.html;
    aiEditorScope_ = selectionMode ? 'selection' : 'article';
    aiEditorRange_ = selectionMode ? fragment.range : null;
    document.getElementById('ai-edit-title').textContent = selectionMode
      ? (rewrite ? 'Trecho reescrito com IA' : 'Trecho revisado com IA')
      : (rewrite ? 'Artigo reescrito com IA' : 'Artigo revisado com IA');
    document.getElementById('ai-edit-apply-label').textContent = selectionMode ? 'Aplicar somente ao trecho' : 'Aplicar no artigo';
    document.getElementById('ai-edit-preview').innerHTML = data.html;
    document.getElementById('ai-edit-overlay').classList.add('open');
  } catch (error) {
    showToast(error.message || 'Falha ao editar com IA.', 'error');
  } finally {
    aiEditorBusy_ = false;
    buttons.forEach(function (item) { item.disabled = !!(window.articleVoiceBusy_ && window.articleVoiceBusy_()); });
    btn.textContent = label;
  }
}

document.getElementById('ai-edit-overlay').addEventListener('click', function(event) {
  if (event.target === this) closeAiEditorPreview();
});
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape' && document.getElementById('ai-edit-overlay').classList.contains('open')) closeAiEditorPreview();
});

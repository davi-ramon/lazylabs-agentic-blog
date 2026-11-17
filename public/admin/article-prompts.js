/* Authoring of prompt panels; the published block stores only plain text. */
(function () {
  'use strict';
  var editor = document.getElementById('editor-area');
  var dialog = document.getElementById('article-prompt-dialog');
  if (!editor || !dialog) return;
  var savedRange = null;
  var selectedText = '';
  var target = null;
  var field = document.getElementById('article-prompt-input');
  var error = document.getElementById('article-prompt-error');
  var deleteButton = document.getElementById('article-prompt-delete');
  var undoHtml = null;
  var changingBlock = false;

  function rememberSelection() {
    var selection = window.getSelection();
    if (selection.rangeCount && editor.contains(selection.anchorNode)) {
      savedRange = selection.getRangeAt(0).cloneRange();
      var preview = document.createElement('div');
      preview.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre-wrap';
      preview.appendChild(savedRange.cloneContents());
      document.body.appendChild(preview);
      selectedText = preview.innerText || savedRange.toString();
      preview.remove();
    }
  }

  function open(block) {
    target = block || null;
    if (!block) rememberSelection();
    field.value = block ? ((block.querySelector('.article-prompt-editor') || {}).value || (block.querySelector('.article-prompt-text') || {}).textContent || '') : selectedText;
    deleteButton.hidden = !block;
    error.hidden = true;
    dialog.hidden = false;
    field.focus();
  }

  function close() { dialog.hidden = true; target = null; savedRange = null; selectedText = ''; }

  function makeBlock(value) {
    var block = document.createElement('figure');
    block.className = 'article-prompt-block';
    block.setAttribute('contenteditable', 'false');
    block.setAttribute('translate', 'no');
    block.innerHTML = '<div class="article-prompt-head"><span class="article-prompt-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v16h4M16 4h4v16h-4M9 8l3 4-3 4m5 0h3"/></svg> Prompt para IA</span><div class="article-prompt-actions"><button type="button" data-prompt-action="copy" aria-label="Copiar prompt completo">Copiar</button><button type="button" data-prompt-action="download" aria-label="Baixar prompt em Markdown">Baixar .md</button><button type="button" class="article-prompt-edit" data-prompt-action="edit">Editar</button></div></div><div class="article-prompt-body"><pre><code class="article-prompt-text"></code></pre></div><div class="article-prompt-foot"><span>Copie e cole no seu assistente de IA</span><button type="button" data-prompt-action="toggle" aria-expanded="false">Ver prompt completo</button></div>';
    block.querySelector('.article-prompt-text').textContent = value;
    return block;
  }

  function save() {
    var value = field.value.trim();
    if (!value) { error.textContent = 'Escreva ou selecione o texto do prompt.'; error.hidden = false; return; }
    var before = window.LazyArticlePrompts.serialize(editor);
    changingBlock = true;
    if (target) {
      target.querySelector('.article-prompt-text').textContent = value;
      var inline = target.querySelector('.article-prompt-editor');
      if (inline) inline.value = value;
    }
    else {
      var block = makeBlock(value);
      editor.focus();
      if (savedRange && editor.contains(savedRange.startContainer) && editor.contains(savedRange.endContainer)) {
        var selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(savedRange);
        document.execCommand('insertHTML', false, block.outerHTML);
      } else editor.appendChild(block);
    }
    changingBlock = false;
    undoHtml = before;
    savedRange = null;
    selectedText = '';
    close();
    if (typeof updateWordCount === 'function') updateWordCount();
    if (typeof showToast === 'function') showToast('Prompt salvo no artigo.', 'success');
  }

  window.articlePromptRememberSelection = rememberSelection;
  window.openArticlePromptEditor = open;
  document.getElementById('article-prompt-save').addEventListener('click', save);
  document.getElementById('article-prompt-cancel').addEventListener('click', close);
  deleteButton.addEventListener('click', function () {
    if (target) { undoHtml = window.LazyArticlePrompts.serialize(editor); target.remove(); }
    close();
    if (typeof updateWordCount === 'function') updateWordCount();
  });
  editor.addEventListener('click', function (event) {
    var button = event.target.closest('[data-prompt-action="edit"],[data-prompt-action="unwrap"]');
    if (!button) return;
    event.preventDefault();
    var block = button.closest('.article-prompt-block');
    if (button.getAttribute('data-prompt-action') === 'edit') { open(block); return; }
    var inline = block.querySelector('.article-prompt-editor');
    var value = inline ? inline.value : (block.querySelector('.article-prompt-text') || {}).textContent || '';
    var escape = function (part) { return part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var html = '<p>' + value.split(/\n\s*\n/).map(function (part) { return escape(part).replace(/\n/g, '<br>'); }).join('</p><p>') + '</p>';
    undoHtml = window.LazyArticlePrompts.serialize(editor);
    var replacement = document.createElement('div'); replacement.innerHTML = html;
    block.replaceWith.apply(block, Array.from(replacement.childNodes));
    editor.focus();
    if (typeof updateWordCount === 'function') updateWordCount();
  });
  editor.addEventListener('input', function () { if (!changingBlock) undoHtml = null; });
  document.addEventListener('keydown', function (event) {
    if (!undoHtml || !dialog.hidden || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') return;
    if (document.activeElement !== editor && !editor.contains(document.activeElement)) return;
    event.preventDefault();
    editor.innerHTML = undoHtml;
    undoHtml = null;
    editor.focus();
    if (typeof updateWordCount === 'function') updateWordCount();
  });
  dialog.addEventListener('click', function (event) { if (event.target === dialog) close(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !dialog.hidden) close(); });
})();

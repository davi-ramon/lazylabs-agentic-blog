/* Formatting controls for the article's contenteditable editor. */
'use strict';

var editorFormatSavedRange_ = null;
var editorFormatSelectedRule_ = null;

function editorFormatEditor_() { return document.getElementById('editor-area'); }

function editorFormatInside_(node) {
  var editor = editorFormatEditor_();
  return !!(editor && node && editor.contains(node));
}

function editorFormatAncestor_(node, selector) {
  var element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  var found = element && element.closest(selector);
  return editorFormatInside_(found) ? found : null;
}

function editorFormatRange_() {
  var selection = window.getSelection();
  if (selection.rangeCount && editorFormatInside_(selection.anchorNode) && editorFormatInside_(selection.focusNode)) {
    return selection.getRangeAt(0);
  }
  if (editorFormatSavedRange_ && editorFormatInside_(editorFormatSavedRange_.startContainer)
      && editorFormatInside_(editorFormatSavedRange_.endContainer)) return editorFormatSavedRange_;
  return null;
}

function editorFormatRestore_() {
  var range = editorFormatRange_();
  if (!range) { showToast('Posicione o cursor ou selecione um trecho do artigo.', 'error'); return null; }
  var editor = editorFormatEditor_();
  editor.focus({ preventScroll: true });
  var selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range.cloneRange());
  return selection.getRangeAt(0);
}

function editorFormatRemember_() {
  var selection = window.getSelection();
  if (selection.rangeCount && editorFormatInside_(selection.anchorNode) && editorFormatInside_(selection.focusNode)) {
    editorFormatSavedRange_ = selection.getRangeAt(0).cloneRange();
  }
}

function editorFormatRefresh_() {
  editorFormatRemember_();
  var range = editorFormatRange_();
  var node = range && range.startContainer;
  var block = editorFormatAncestor_(node, 'h1,h2,h3,blockquote');
  var list = editorFormatAncestor_(node, 'ul,ol');
  var states = {
    bold: !!editorFormatAncestor_(node, 'b,strong'),
    italic: !!editorFormatAncestor_(node, 'i,em'),
    h1: !!(block && block.tagName === 'H1'),
    h2: !!(block && block.tagName === 'H2'),
    h3: !!(block && block.tagName === 'H3'),
    quote: !!editorFormatAncestor_(node, 'blockquote'),
    'ul-bullet': !!(list && list.tagName === 'UL' && list.classList.contains('ll-list-bullet')),
    'ul-dash': !!(list && list.tagName === 'UL' && !list.classList.contains('ll-list-bullet') && !list.classList.contains('ll-list-check')),
    'ul-check': !!(list && list.tagName === 'UL' && list.classList.contains('ll-list-check')),
    ol: !!(list && list.tagName === 'OL'),
    code: !!editorFormatAncestor_(node, 'code'),
    link: !!editorFormatAncestor_(node, 'a[href]'),
    hr: !!(editorFormatSelectedRule_ && editorFormatSelectedRule_.isConnected)
  };
  states.list = !!list;
  document.querySelectorAll('.editor-toolbar [data-editor-format]').forEach(function(button) {
    var action = button.dataset.editorFormat;
    if (action in states) {
      button.classList.toggle('is-active', states[action]);
      button.setAttribute('aria-pressed', String(states[action]));
    }
  });
}

function editorFormatCaretMarker_(range) {
  var marker = document.createComment('editor-caret');
  var insertion = range.cloneRange(); insertion.collapse(true); insertion.insertNode(marker);
  return marker;
}

function editorFormatRestoreMarker_(marker) {
  if (!marker || !marker.parentNode) return;
  var parent = marker.parentNode;
  var offset = Array.prototype.indexOf.call(parent.childNodes, marker);
  marker.remove();
  var range = document.createRange(); range.setStart(parent, offset); range.collapse(true);
  var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  editorFormatSavedRange_ = range.cloneRange();
}

function editorFormatSelectionMarkers_(range) {
  var end = document.createComment('editor-selection-end');
  var atEnd = range.cloneRange(); atEnd.collapse(false); atEnd.insertNode(end);
  var start = document.createComment('editor-selection-start');
  var atStart = range.cloneRange(); atStart.collapse(true); atStart.insertNode(start);
  return { start: start, end: end };
}

function editorFormatRestoreSelection_(markers) {
  if (!markers.start.parentNode || !markers.end.parentNode) return;
  var selectionRange = document.createRange();
  selectionRange.setStartAfter(markers.start);
  selectionRange.setEndBefore(markers.end);
  markers.start.remove(); markers.end.remove();
  var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(selectionRange);
  editorFormatSavedRange_ = selectionRange.cloneRange();
}

function editorFormatUnwrapQuote_(quote) {
  var output = document.createDocumentFragment();
  var paragraph = null;
  while (quote.firstChild) {
    var child = quote.firstChild;
    var isBlock = child.nodeType === Node.ELEMENT_NODE && /^(P|DIV|H1|H2|H3|UL|OL|PRE|BLOCKQUOTE|FIGURE)$/.test(child.tagName);
    if (isBlock) {
      paragraph = null;
      output.appendChild(child);
    } else {
      if (!paragraph) { paragraph = document.createElement('p'); output.appendChild(paragraph); }
      paragraph.appendChild(child);
    }
  }
  if (!output.firstChild) { paragraph = document.createElement('p'); paragraph.appendChild(document.createElement('br')); output.appendChild(paragraph); }
  quote.replaceWith(output);
}

function editorFormatUnquote_() {
  var range = editorFormatRange_();
  if (!range) return;
  var markers = editorFormatSelectionMarkers_(range);
  var quote = editorFormatAncestor_(markers.start, 'blockquote');
  while (quote) {
    editorFormatUnwrapQuote_(quote);
    quote = editorFormatAncestor_(markers.start, 'blockquote');
  }
  editorFormatRestoreSelection_(markers);
}

function editorFormatTopChild_(node, offset) {
  var editor = editorFormatEditor_();
  if (node === editor) return editor.childNodes[offset] || editor.lastChild;
  while (node && node.parentNode !== editor) node = node.parentNode;
  return node;
}

function editorFormatQuote_() {
  var range = editorFormatRange_();
  var editor = editorFormatEditor_();
  if (!range) return;
  if (editorFormatAncestor_(range.startContainer, 'blockquote')) { editorFormatUnquote_(); return; }
  var first = editorFormatTopChild_(range.startContainer, range.startOffset);
  var last = editorFormatTopChild_(range.endContainer, range.endOffset) || first;
  if (first && last) {
    var nodes = [];
    for (var current = first; current; current = current.nextSibling) {
      if (current.nodeType === Node.ELEMENT_NODE && current.matches('blockquote,figure,hr,.article-cta-block,.article-diagram')) {
        showToast('Selecione somente parágrafos para criar uma citação.', 'error'); return;
      }
      nodes.push(current);
      if (current === last) break;
    }
    if (nodes[nodes.length - 1] !== last) return;
  }
  var marker = editorFormatCaretMarker_(range);
  var quote = document.createElement('blockquote');
  if (first) {
    editor.insertBefore(quote, first);
    nodes.forEach(function(child) { quote.appendChild(child); });
  } else {
    var paragraph = document.createElement('p'); paragraph.appendChild(marker);
    paragraph.appendChild(document.createElement('br')); quote.appendChild(paragraph);
    editor.appendChild(quote);
  }
  editorFormatRestoreMarker_(marker);
}

function editorFormatCode_() {
  var range = editorFormatRange_();
  if (!range) return;
  var current = editorFormatAncestor_(range.startContainer, 'code');
  if (current) {
    var marker = editorFormatCaretMarker_(range);
    current.replaceWith.apply(current, Array.from(current.childNodes));
    editorFormatRestoreMarker_(marker);
    return;
  }
  if (range.collapsed || editorFormatTopChild_(range.startContainer, range.startOffset) !== editorFormatTopChild_(range.endContainer, range.endOffset)) {
    showToast('Selecione texto dentro de um parágrafo para aplicar código.', 'error'); return;
  }
  var code = document.createElement('code');
  code.appendChild(range.extractContents()); range.insertNode(code);
  range.selectNodeContents(code);
  var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}

function editorFormatLink_() {
  var range = editorFormatRange_();
  if (!range) return;
  if (editorFormatAncestor_(range.startContainer, 'a[href]')) { document.execCommand('unlink', false, null); return; }
  if (range.collapsed) { showToast('Selecione o texto que receberá o link.', 'error'); return; }
  var raw = window.prompt('URL do link (https://):');
  if (!raw) return;
  var url;
  try { url = new URL(raw); } catch (_) { showToast('Informe uma URL válida.', 'error'); return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) { showToast('Use um link HTTP ou HTTPS sem credenciais.', 'error'); return; }
  editorFormatRestore_();
  document.execCommand('createLink', false, url.href);
}

function editorFormatClear_() {
  var range = editorFormatRange_();
  if (!range || range.collapsed) { showToast('Selecione o trecho cuja formatação deseja remover.', 'error'); return; }
  var quote = editorFormatAncestor_(range.startContainer, 'blockquote');
  var list = editorFormatAncestor_(range.startContainer, 'ul,ol');
  document.execCommand('removeFormat', false, null);
  document.execCommand('unlink', false, null);
  if (quote) editorFormatUnquote_();
  if (list && list.isConnected) document.execCommand(list.tagName === 'UL' ? 'insertUnorderedList' : 'insertOrderedList', false, null);
  document.execCommand('formatBlock', false, 'p');
}

function editorFormatNormalizeLists_() {
  editorFormatEditor_().querySelectorAll('p > ul, p > ol').forEach(function(list) {
    var paragraph = list.parentElement;
    var onlyList = Array.from(paragraph.childNodes).every(function(child) {
      return child === list || child.nodeType === Node.COMMENT_NODE
        || (child.nodeType === Node.TEXT_NODE && !child.textContent.trim())
        || (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR');
    });
    if (onlyList) {
      var range = editorFormatRange_();
      var marker;
      if (range && list.contains(range.startContainer)) marker = editorFormatCaretMarker_(range);
      else {
        marker = document.createComment('editor-caret');
        (list.querySelector('li:last-child') || list).appendChild(marker);
      }
      paragraph.replaceWith(list);
      editorFormatRestoreMarker_(marker);
    }
  });
}

function editorFormatCommand_(action) {
  var menu = document.getElementById('editor-list-options');
  if (action === 'list') {
    menu.hidden = !menu.hidden;
    document.getElementById('editor-list-trigger').setAttribute('aria-expanded', String(!menu.hidden));
    return;
  }
  if (menu) { menu.hidden = true; document.getElementById('editor-list-trigger').setAttribute('aria-expanded', 'false'); }
  if (action === 'hr' && editorFormatSelectedRule_ && editorFormatSelectedRule_.isConnected) {
    editorFormatSelectedRule_.remove(); editorFormatSelectedRule_ = null;
  } else {
    var range = editorFormatRestore_();
    if (!range) return;
    if (action === 'bold' || action === 'italic') document.execCommand(action, false, null);
    else if (action === 'h1' || action === 'h2' || action === 'h3') {
      if (editorFormatAncestor_(range.startContainer, 'blockquote')) editorFormatUnquote_();
      var active = editorFormatAncestor_(editorFormatRange_().startContainer, 'h1,h2,h3');
      document.execCommand('formatBlock', false, active && active.tagName.toLowerCase() === action ? 'p' : action);
    } else if (action === 'quote') editorFormatQuote_();
    else if (action === 'ol') document.execCommand('insertOrderedList', false, null);
    else if (action.startsWith('ul-')) {
      var style = 'll-list-' + action.slice(3);
      var list = editorFormatAncestor_(range.startContainer, 'ul');
      var sameStyle = list && (list.classList.contains(style) || (style === 'll-list-dash' && !list.classList.contains('ll-list-bullet') && !list.classList.contains('ll-list-check')));
      if (sameStyle) document.execCommand('insertUnorderedList', false, null);
      else {
        if (!list) document.execCommand('insertUnorderedList', false, null);
        list = editorFormatAncestor_(editorFormatRange_().startContainer, 'ul');
        if (list) { list.classList.remove('ll-list-bullet', 'll-list-dash', 'll-list-check'); list.classList.add(style); }
      }
    }
    else if (action === 'code') editorFormatCode_();
    else if (action === 'link') editorFormatLink_();
    else if (action === 'hr') document.execCommand('insertHorizontalRule', false, null);
    else if (action === 'clear') editorFormatClear_();
    if (action === 'ol' || action.startsWith('ul-')) editorFormatNormalizeLists_();
  }
  editorFormatRemember_(); editorFormatRefresh_();
  editorFormatEditor_().dispatchEvent(new Event('input', { bubbles: true }));
}

function editorFormatInit_() {
  var toolbar = document.querySelector('#section-escrever .editor-toolbar');
  var editor = editorFormatEditor_();
  if (!toolbar || !editor) return;
  toolbar.addEventListener('pointerdown', function(event) {
    if (event.target.closest('[data-editor-format]')) event.preventDefault();
  });
  toolbar.addEventListener('click', function(event) {
    var button = event.target.closest('[data-editor-format]');
    if (button && toolbar.contains(button)) editorFormatCommand_(button.dataset.editorFormat);
  });
  editor.addEventListener('click', function(event) {
    if (editorFormatSelectedRule_) editorFormatSelectedRule_.classList.remove('editor-rule-selected');
    editorFormatSelectedRule_ = event.target.closest('hr');
    if (editorFormatSelectedRule_) editorFormatSelectedRule_.classList.add('editor-rule-selected');
    editorFormatRefresh_();
  });
  editor.addEventListener('keydown', function(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    var range = editorFormatRange_();
    var quote = range && range.collapsed && editorFormatAncestor_(range.startContainer, 'blockquote');
    if (!quote) return;
    var remainder = document.createRange(); remainder.selectNodeContents(quote);
    remainder.setStart(range.startContainer, range.startOffset);
    if (remainder.toString().trim()) return;
    event.preventDefault();
    while (editorFormatAncestor_(quote.parentNode, 'blockquote')) quote = quote.parentNode;
    var paragraph = document.createElement('p'); paragraph.appendChild(document.createElement('br'));
    quote.after(paragraph);
    var caret = document.createRange(); caret.selectNodeContents(paragraph); caret.collapse(true);
    var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(caret);
    editorFormatSavedRange_ = caret.cloneRange();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.addEventListener('selectionchange', editorFormatRefresh_);
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      var menu = document.getElementById('editor-list-options');
      if (menu && !menu.hidden) { menu.hidden = true; document.getElementById('editor-list-trigger').setAttribute('aria-expanded', 'false'); }
    }
  });
  document.addEventListener('pointerdown', function(event) {
    var picker = document.getElementById('editor-list-picker');
    var menu = document.getElementById('editor-list-options');
    if (picker && menu && !picker.contains(event.target)) { menu.hidden = true; document.getElementById('editor-list-trigger').setAttribute('aria-expanded', 'false'); }
  });
  editorFormatRefresh_();
}

function editorFormatReset_() {
  editorFormatSavedRange_ = null;
  if (editorFormatSelectedRule_) editorFormatSelectedRule_.classList.remove('editor-rule-selected');
  editorFormatSelectedRule_ = null;
  editorFormatRefresh_();
}

document.addEventListener('DOMContentLoaded', editorFormatInit_);

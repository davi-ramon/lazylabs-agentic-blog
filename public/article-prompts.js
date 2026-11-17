/* Prompt panels shared by the article, admin editor and admin preview. */
(function () {
  'use strict';

  var observed = new WeakSet();
  var resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(function (entries) {
    entries.forEach(function (entry) {
      var block = entry.target.closest('.article-prompt-block');
      if (block) refresh(block);
    });
  }) : null;

  function refresh(block) {
    var pre = block.querySelector('pre');
    var display = block.querySelector('.article-prompt-editor') || pre;
    if (!display || !display.getClientRects().length) return;
    var lineHeight = parseFloat(getComputedStyle(display).lineHeight) || 21;
    var fullHeight = display.scrollHeight;
    var more = fullHeight > lineHeight * 5 + 2;
    block.classList.toggle('has-more', more);
    block.style.setProperty('--prompt-full-height', Math.ceil(fullHeight) + 'px');
    var toggle = block.querySelector('[data-prompt-action="toggle"]');
    if (toggle) {
      toggle.hidden = !more;
      toggle.setAttribute('aria-expanded', String(block.classList.contains('is-expanded')));
    }
  }

  function makeButton(parent, action, label) {
    var button = parent.querySelector('[data-prompt-action="' + action + '"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-prompt-action', action);
      parent.appendChild(button);
    }
    if (button.textContent) button.textContent = '';
    button.setAttribute('aria-label', label);
    button.title = label;
    return button;
  }

  function enhance(container) {
    if (!container) return;
    container.querySelectorAll('.article-prompt-block').forEach(function (block) {
      var code = block.querySelector('.article-prompt-text');
      if (!code) return;
      var head = block.querySelector('.article-prompt-head');
      if (!head) { head = document.createElement('div'); head.className = 'article-prompt-head'; block.prepend(head); }
      var title = head.querySelector('.article-prompt-title');
      if (!title) { title = document.createElement('span'); title.className = 'article-prompt-title'; head.prepend(title); }
      if (title.textContent !== 'Prompt para IA' || title.querySelector('svg')) title.textContent = 'Prompt para IA';
      var actions = head.querySelector('.article-prompt-actions');
      if (!actions) { actions = document.createElement('div'); actions.className = 'article-prompt-actions'; head.appendChild(actions); }
      makeButton(actions, 'copy', 'Copiar prompt completo');
      makeButton(actions, 'download', 'Baixar prompt em Markdown').setAttribute('data-extension', '.md');
      var inEditor = !!block.closest('#editor-area');
      if (inEditor) {
        makeButton(actions, 'edit', 'Editar prompt').classList.add('article-prompt-edit');
        makeButton(actions, 'unwrap', 'Converter prompt em texto').classList.add('article-prompt-edit');
        var body = block.querySelector('.article-prompt-body');
        var editorField = body.querySelector('.article-prompt-editor');
        if (!editorField) {
          editorField = document.createElement('textarea');
          editorField.className = 'article-prompt-editor';
          editorField.setAttribute('aria-label', 'Texto do prompt. Edite diretamente aqui.');
          editorField.setAttribute('spellcheck', 'false');
          editorField.value = code.textContent;
          body.appendChild(editorField);
        }
      } else {
        var staleEditor = block.querySelector('.article-prompt-editor');
        if (staleEditor) staleEditor.remove();
        code.removeAttribute('contenteditable');
        code.removeAttribute('role');
        code.removeAttribute('aria-label');
        code.removeAttribute('aria-multiline');
        code.removeAttribute('tabindex');
      }
      var foot = block.querySelector('.article-prompt-foot');
      if (!foot) { foot = document.createElement('div'); foot.className = 'article-prompt-foot'; block.appendChild(foot); }
      var hint = foot.querySelector('span');
      if (!hint) { hint = document.createElement('span'); foot.prepend(hint); }
      var hintText = inEditor ? 'Clique no texto para editar' : 'Copie e cole no seu assistente de IA';
      if (hint.textContent !== hintText) hint.textContent = hintText;
      makeButton(foot, 'toggle', 'Expandir prompt completo');
      var pre = block.querySelector('pre');
      var measured = block.querySelector('.article-prompt-editor') || pre;
      if (measured && resizeObserver && !observed.has(measured)) { resizeObserver.observe(measured); observed.add(measured); }
      refresh(block);
    });
  }

  function serialize(container) {
    var copy = container.cloneNode(true);
    copy.querySelectorAll('.article-prompt-block').forEach(function (block) {
      var field = block.querySelector('.article-prompt-editor');
      var value = field ? field.value : (block.querySelector('.article-prompt-text') || {}).textContent || '';
      var clean = document.createElement('figure');
      clean.className = 'article-prompt-block';
      clean.setAttribute('translate', 'no');
      var body = document.createElement('div'); body.className = 'article-prompt-body';
      var pre = document.createElement('pre');
      var code = document.createElement('code'); code.className = 'article-prompt-text'; code.textContent = value;
      pre.appendChild(code); body.appendChild(pre); clean.appendChild(body); block.replaceWith(clean);
    });
    return copy.innerHTML.trim();
  }

  function start() {
    ['editor-area', 'preview-area', 'art-body'].forEach(function (id) {
      var container = document.getElementById(id);
      if (!container) return;
      enhance(container);
      var queued = false;
      var observer = new MutationObserver(function () {
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () { queued = false; enhance(container); });
      });
      observer.observe(container, { childList: true, subtree: true });
      if (id === 'editor-area') container.addEventListener('input', function (event) {
        var block = event.target.closest('.article-prompt-block');
        if (block && event.target.classList.contains('article-prompt-editor')) {
          block.querySelector('.article-prompt-text').textContent = event.target.value;
          refresh(block);
        }
      });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () {
      ['editor-area', 'preview-area', 'art-body'].forEach(function (id) { enhance(document.getElementById(id)); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.LazyArticlePrompts = { enhance: enhance, serialize: serialize, refresh: refresh };

  function promptText(block) {
    var field = block.querySelector('.article-prompt-editor');
    if (field) return field.value;
    var code = block.querySelector('.article-prompt-text');
    return code ? code.textContent : '';
  }

  async function copyPrompt(block, button) {
    var value = promptText(block);
    if (!value) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
      else {
        var field = document.createElement('textarea');
        field.value = value;
        field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.appendChild(field); field.select();
        if (!document.execCommand('copy')) throw new Error('clipboard');
        field.remove();
      }
      button.classList.add('is-copied');
      button.setAttribute('aria-label', 'Prompt copiado');
      button.title = 'Prompt copiado';
      setTimeout(function () {
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', 'Copiar prompt completo');
        button.title = 'Copiar prompt completo';
      }, 2200);
    } catch (_) {
      button.setAttribute('aria-label', 'Falha ao copiar');
      button.title = 'Falha ao copiar';
    }
  }

  function downloadPrompt(block, button) {
    var value = promptText(block);
    if (!value) return;
    var blob = new Blob([value.replace(/\s+$/, '') + '\n'], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url; link.download = 'prompt-lazy-labs.md';
    document.body.appendChild(link); link.click(); link.remove();
    button.classList.add('is-downloaded');
    button.title = 'Download iniciado';
    setTimeout(function () { button.classList.remove('is-downloaded'); button.title = 'Baixar prompt em Markdown'; }, 1800);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-prompt-action]');
    if (!button) return;
    var block = button.closest('.article-prompt-block');
    if (!block) return;
    event.preventDefault();
    var action = button.getAttribute('data-prompt-action');
    if (action === 'toggle') {
      refresh(block);
      var expanded = block.classList.toggle('is-expanded');
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', expanded ? 'Recolher prompt' : 'Expandir prompt completo');
      button.title = button.getAttribute('aria-label');
    } else if (action === 'copy') copyPrompt(block, button);
    else if (action === 'download') downloadPrompt(block, button);
  });
})();

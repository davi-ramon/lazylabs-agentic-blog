(function () {
  'use strict';
  var channels = ['linkedin', 'facebook', 'instagram', 'x', 'tiktok'];
  var names = { linkedin:'LinkedIn', facebook:'Facebook', instagram:'Instagram', x:'X', tiktok:'TikTok' };
  var pop, active = '', anchor = null, pinned = false, closeTimer = null;
  function field(id) { return document.getElementById(id); }
  function value(id) { var node = field(id); return node ? String(node.value || '').trim() : ''; }
  function node(tag, className, content) {
    var result = document.createElement(tag);
    if (className) result.className = className;
    if (content != null) result.textContent = content;
    return result;
  }
  function safeHttps(url) {
    try { var parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : ''; }
    catch (_) { return ''; }
  }
  function ownVideo() {
    var url = safeHttps(value('f-tiktok-video'));
    return /^https:\/\/blog\.example\.com\/media\/blog-video\/[0-9a-f-]{36}\.mp4$/i.test(url) ? url : '';
  }
  function imageSource() {
    var cover = safeHttps(value('f-cover'));
    if (cover) return cover;
    return (window.LazyMedia && LazyMedia.video(value('f-video')) || {}).thumbnail || '';
  }
  function articleUrl() { return 'https://blog.example.com/artigo/' + (value('f-slug') || 'meu-artigo'); }
  function caption(channel) {
    var text = value('social-copy-' + channel);
    if (!text) text = [value('f-title'), value('f-excerpt')].filter(Boolean).join('\n\n');
    if (!text) text = 'Prepare a versão da rede para visualizar o texto aqui.';
    var link = articleUrl();
    if (['linkedin','facebook','x'].includes(channel) && !text.includes(link))
      text += channel === 'linkedin' ? '\n\nArtigo completo: ' + link : '\n\n' + link;
    return text;
  }
  function mediaMode(channel) {
    var selected = value('social-mode-' + channel);
    if (channel === 'tiktok') return 'video';
    if (channel === 'linkedin') return selected === 'video' || (selected === 'auto' && ownVideo()) ? 'video' : 'link';
    if (channel === 'facebook') return selected === 'video' ? 'video' : (imageSource() ? 'image' : 'link');
    if (channel === 'instagram') return selected === 'video' ? 'video' : 'image';
    return selected === 'video' ? 'video' : 'link';
  }
  function media(channel, mode) {
    var wrap = node('div', 'sp-media sp-media-' + mode);
    var video = ownVideo(), image = imageSource();
    if (mode === 'video') {
      if (video) {
        var player = node('video', 'sp-video');
        player.src = video; player.controls = true; player.muted = true; player.playsInline = true; player.preload = 'metadata';
        if (image) player.poster = image;
        wrap.appendChild(player);
      } else {
        wrap.appendChild(node('div', 'sp-media-placeholder', '▶'));
        wrap.appendChild(node('span', 'sp-media-warning', 'Anexe um MP4 próprio para publicar neste modo.'));
      }
      wrap.appendChild(node('span', 'sp-media-badge', channel === 'facebook' || channel === 'instagram' ? 'REEL' : 'VÍDEO'));
    } else if (mode === 'image' || mode === 'link') {
      if (image) {
        var img = node('img', 'sp-image'); img.src = image; img.alt = 'Capa do artigo'; img.loading = 'lazy';
        img.onerror = function() { img.replaceWith(node('div', 'sp-image-fallback', 'Imagem indisponível')); };
        wrap.appendChild(img);
      } else wrap.appendChild(node('div', 'sp-image-fallback', 'LAZY LABS'));
      if (mode === 'link') {
        var info = node('div', 'sp-link-info');
        info.appendChild(node('small', '', 'LAZYLABS.BLOG'));
        info.appendChild(node('strong', '', value('f-title') || 'Título do artigo'));
        info.appendChild(node('span', '', value('f-excerpt') || 'Resumo do artigo'));
        wrap.appendChild(info);
      }
      if (channel === 'instagram' && !image) wrap.appendChild(node('span', 'sp-media-warning', 'Instagram exige capa HTTPS ou thumbnail do YouTube.'));
    }
    return wrap;
  }
  function render(channel) {
    if (!pop || !channel) return;
    pop.className = 'social-preview-popover network-' + channel;
    pop.replaceChildren();
    var head = node('div', 'sp-head');
    head.appendChild(node('span', 'sp-icon', channel === 'linkedin' ? 'in' : channel === 'facebook' ? 'f' : channel === 'instagram' ? '◎' : channel === 'tiktok' ? '♪' : '𝕏'));
    var account = node('div', 'sp-account');
    account.appendChild(node('strong', '', 'Lazy Labs'));
    account.appendChild(node('small', '', channel === 'x' ? '@lazylabs · agora' : 'Publicação · agora'));
    head.appendChild(account); head.appendChild(node('span', 'sp-dots', '•••'));
    pop.appendChild(node('div', 'sp-simulated', 'PRÉVIA SIMULADA · ' + names[channel].toUpperCase()));
    pop.appendChild(head);
    var mode = mediaMode(channel);
    var copy = node('div', 'sp-copy', caption(channel));
    if (channel === 'instagram' || channel === 'tiktok') {
      pop.appendChild(media(channel, mode)); pop.appendChild(copy);
    } else {
      pop.appendChild(copy); pop.appendChild(media(channel, mode));
    }
    var engagement = node('div', 'sp-engagement', channel === 'linkedin' ? 'Curtir     Comentar     Compartilhar' : channel === 'x' ? '♡     ↪     ♻     ↗' : channel === 'tiktok' ? '♡     Comentar     Compartilhar' : 'Curtir     Comentar     Compartilhar');
    pop.appendChild(engagement);
    var note = mode === 'video' && !ownVideo() ? 'Este modo ainda não pode ser publicado sem vídeo próprio.' : 'A aparência final pode variar conforme a plataforma.';
    pop.appendChild(node('div', 'sp-footnote', note));
  }
  function position() {
    if (!pop || !anchor || pop.hidden) return;
    var rect = anchor.getBoundingClientRect(), width = Math.min(390, window.innerWidth - 24);
    pop.style.width = width + 'px';
    var left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
    var height = Math.min(pop.scrollHeight, window.innerHeight - 24);
    var top = rect.bottom + 10;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 10);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function open(channel, button, keepOpen) {
    clearTimeout(closeTimer);
    if (anchor && anchor !== button) anchor.setAttribute('aria-expanded', 'false');
    active = channel; anchor = button; pinned = !!keepOpen;
    button.setAttribute('aria-expanded', 'true');
    pop.hidden = false; render(channel); position();
  }
  function close() {
    clearTimeout(closeTimer);
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    active = ''; anchor = null; pinned = false; pop.hidden = true;
    pop.querySelectorAll('video').forEach(function(video) { video.pause(); });
  }
  function laterClose() { clearTimeout(closeTimer); if (!pinned) closeTimer = setTimeout(close, 150); }
  window.socialPreviewClose = close;
  window.socialPreviewRefresh = function() { if (active) { render(active); position(); } };
  document.addEventListener('DOMContentLoaded', function() {
    pop = node('div', 'social-preview-popover'); pop.id = 'social-preview-popover'; pop.hidden = true;
    pop.setAttribute('role', 'region'); pop.setAttribute('aria-label', 'Prévia da publicação');
    document.body.appendChild(pop);
    pop.addEventListener('mouseenter', function() { clearTimeout(closeTimer); });
    pop.addEventListener('mouseleave', laterClose);
    channels.forEach(function(channel) {
      var item = field('social-copy-' + channel)?.closest('.social-composer-item');
      if (!item) return;
      var button = node('button', 'social-preview-eye'); button.type = 'button'; button.title = 'Visualizar prévia no ' + names[channel];
      button.setAttribute('aria-label', button.title); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', pop.id);
      button.innerHTML = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      item.appendChild(button);
      button.addEventListener('mouseenter', function() { open(channel, button, false); });
      button.addEventListener('mouseleave', laterClose);
      button.addEventListener('focus', function() { open(channel, button, false); });
      button.addEventListener('blur', laterClose);
      button.addEventListener('click', function() { if (active === channel && pinned) close(); else open(channel, button, true); });
      field('social-copy-' + channel).addEventListener('input', window.socialPreviewRefresh);
      var select = field('social-mode-' + channel); if (select) select.addEventListener('change', window.socialPreviewRefresh);
    });
    ['f-title','f-excerpt','f-slug','f-cover','f-video','f-tiktok-video'].forEach(function(id) {
      var el = field(id); if (el) { el.addEventListener('input', window.socialPreviewRefresh); el.addEventListener('change', window.socialPreviewRefresh); }
    });
    window.addEventListener('scroll', position, { passive:true }); window.addEventListener('resize', position);
    document.addEventListener('keydown', function(event) { if (event.key === 'Escape' && active) close(); });
    document.addEventListener('pointerdown', function(event) { if (pinned && !pop.contains(event.target) && event.target !== anchor) close(); });
  });
}());

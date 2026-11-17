(function () {
  'use strict';
  var channels = ['linkedin','facebook','instagram','x','tiktok'];
  var limits = { linkedin:2800, facebook:5000, instagram:2100, x:270, tiktok:2100 };
  var source = '';
  function field(id) { return document.getElementById(id); }
  function currentSource() {
    return JSON.stringify([field('f-title').value,field('f-slug').value,field('f-excerpt').value,
      field('editor-area').innerHTML,field('f-cover').value,field('f-video').value,field('f-tiktok-video').value]);
  }
  function input() {
    return { title:field('f-title').value.trim(), slug:field('f-slug').value.trim(), excerpt:field('f-excerpt').value.trim(),
      content:field('editor-area').innerHTML };
  }
  function message(value, error) {
    var el = field('social-composer-message');
    if (el) { el.textContent = value; el.style.color = error ? '#ff4d95' : ''; }
  }
  function count(channel) {
    var el = field('social-copy-' + channel), out = field('social-count-' + channel);
    if (!el || !out) return;
    out.textContent = el.value.length + '/' + limits[channel];
    out.style.color = el.value.length > limits[channel] ? '#ff4d95' : '';
  }
  window.socialCopyChanged = function (channel) { count(channel); field('social-approved').checked = false; if (window.socialPreviewRefresh) socialPreviewRefresh(); };
  window.socialPrepare = async function (ai) {
    var payload = input();
    if (!payload.title || !payload.slug || !field('editor-area').innerText.trim()) {
      message('Preencha título, slug e conteúdo antes de preparar as versões.', true); return;
    }
    var btn = field('social-ai-btn'); if (btn) btn.disabled = true;
    message(ai ? 'Adaptando o artigo com IA...' : 'Preparando versões por canal...');
    try {
      var endpoint = ai ? '/api/davi/socialDraft' : '/api/social/draft';
      var result = await fbFetch_(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
      if (!result || !result.ok) throw new Error((result && result.message) || 'Não foi possível criar as versões.');
      channels.forEach(function (channel) { field('social-copy-' + channel).value = result.drafts[channel] || ''; count(channel); });
      if (window.socialPreviewRefresh) socialPreviewRefresh();
      source = currentSource();
      field('social-approved').checked = false;
      message(ai ? 'Sugestões da IA prontas. Revise os fatos e aprove os canais.' : 'Versões prontas. Edite e aprove antes de publicar.');
    } catch (error) {
      message((error && error.message) || 'Falha ao preparar versões.', true);
    } finally { if (btn) btn.disabled = false; }
  };
  window.socialCollect = function () {
    var copy = {}, modes = {};
    channels.forEach(function (channel) {
      var value = field('social-copy-' + channel).value.trim();
      if (value) copy[channel] = value;
      var select = field('social-mode-' + channel);
      if (select) modes[channel] = select.value;
    });
    return { copy:copy, modes:modes };
  };
  window.socialReadyToPublish = function () {
    var active = channels.filter(function (channel) { return isChannelActive(channel); });
    if (!active.length) return true;
    if (!source || source !== currentSource()) {
      message('O artigo ou a mídia mudou. Prepare as versões novamente antes de publicar.', true);
      field('social-composer').scrollIntoView({ behavior:'smooth', block:'start' }); return false;
    }
    if (!field('social-approved').checked) {
      message('Revise e aprove as versões dos canais selecionados antes de publicar.', true);
      field('social-composer').scrollIntoView({ behavior:'smooth', block:'start' }); return false;
    }
    var own = /^https:\/\/blog\.example\.com\/media\/blog-video\/[0-9a-f-]{36}\.mp4$/i.test(field('f-tiktok-video').value.trim());
    var tiktokOwn = own;
    try {
      var videoUrl = new URL(field('f-tiktok-video').value.trim());
      var verified = field('social-tiktok-domain') && field('social-tiktok-domain').value.trim().toLowerCase();
      tiktokOwn = tiktokOwn || !!(verified && videoUrl.protocol === 'https:' && videoUrl.hostname.toLowerCase() === verified);
    } catch (_) {}
    var link = 'https://blog.example.com/artigo/' + field('f-slug').value.trim();
    for (var i = 0; i < active.length; i++) {
      var channel = active[i], value = field('social-copy-' + channel).value.trim();
      var suffix = channel === 'linkedin' ? '\n\nArtigo completo: ' + link : '\n\n' + link;
      var finalLength = value.length + (['linkedin','facebook','x'].indexOf(channel) !== -1 && value.indexOf(link) === -1 ? suffix.length : 0);
      if (!value || finalLength > limits[channel]) {
        message('Revise o texto do ' + channel + ': vazio ou acima de ' + limits[channel] + ' caracteres.', true); return false;
      }
      var select = field('social-mode-' + channel);
      if ((channel === 'tiktok' && !tiktokOwn) || (select && select.value === 'video' && !own)) {
        message('Para vídeo nativo no ' + channel + ', envie um MP4 próprio de até 20 MB no domínio verificado.', true); return false;
      }
    }
    return true;
  };
  window.socialRestore = function (post) {
    channels.forEach(function (channel) {
      field('social-copy-' + channel).value = (post.social_copy && post.social_copy[channel]) || '';
      var select = field('social-mode-' + channel);
      if (select) select.value = (post.social_modes && post.social_modes[channel]) || select.options[0].value;
      count(channel);
    });
    source = channels.some(function (channel) { return field('social-copy-' + channel).value; }) ? currentSource() : '';
    field('social-approved').checked = false;
    message(source ? 'Versões salvas carregadas. Revise e aprove novamente antes de distribuir.' : 'Prepare as versões quando quiser distribuir nas redes.');
    if (window.socialPreviewRefresh) socialPreviewRefresh();
  };
  window.socialReset = function () { window.socialRestore({}); };
  channels.forEach(function (channel) {
    count(channel);
    var select = field('social-mode-' + channel);
    if (select) select.addEventListener('change', function () { field('social-approved').checked = false; });
    var toggle = field('f-auto-' + channel);
    if (toggle) toggle.addEventListener('change', function () { field('social-approved').checked = false; });
  });
}());

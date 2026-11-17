var builderMetadata_ = null;
var builderSource_ = '';
var builderMediaTimer_ = null;
var tiktokConfigured_ = false;
var tiktokVideoUploading_ = false;
var blogTaxonomyLoad_ = null;

function taxonomyKey_(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function ensureTaxonomyOption_(id, value, label) {
  var select = document.getElementById(id);
  if (!select || !value) return '';
  var existing = Array.from(select.options).find(function (option) {
    return taxonomyKey_(option.value) === taxonomyKey_(value) || taxonomyKey_(option.textContent) === taxonomyKey_(label || value);
  });
  if (existing) return existing.value;
  var option = new Option(label || value, value);
  select.add(option);
  return option.value;
}
function renderTagSuggestions_(tags) {
  var target = document.getElementById('f-tag-suggestions');
  if (!target) return;
  target.replaceChildren();
  (Array.isArray(tags) ? tags.slice(-12).reverse() : []).forEach(function (tag) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'taxonomy-tag'; button.textContent = '+ ' + tag;
    button.title = 'Adicionar tag ' + tag;
    button.addEventListener('click', function () {
      var field = document.getElementById('f-tags');
      var current = field.value.split(',').map(function (part) { return part.trim(); }).filter(Boolean);
      if (!current.some(function (part) { return taxonomyKey_(part) === taxonomyKey_(tag); })) current.push(tag);
      field.value = current.join(', ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    target.appendChild(button);
  });
}
function loadBlogTaxonomy_() {
  if (!blogTaxonomyLoad_) blogTaxonomyLoad_ = fetch('/api/posts/taxonomyGet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store'
  }).then(function (response) { return response.json(); }).then(function (result) {
    if (!result || !result.ok || !result.taxonomy) return;
    (result.taxonomy.categories || []).forEach(function (category) { ensureTaxonomyOption_('f-category', category, category); });
    (result.taxonomy.postTypes || []).forEach(function (type) { ensureTaxonomyOption_('f-type', type.value, type.label); });
    renderTagSuggestions_(result.taxonomy.tags || []);
  }).catch(function () { blogTaxonomyLoad_ = null; });
  return blogTaxonomyLoad_;
}
document.addEventListener('DOMContentLoaded', loadBlogTaxonomy_);

function builderSlug_(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

async function suggestArticleMetadata(mode) {
  var editor = document.getElementById('editor-area');
  var source = editor.innerHTML;
  var all = mode === 'all';
  var button = document.getElementById(all ? 'ai-all-metadata-btn' : 'ai-metadata-btn');
  if ((editor.innerText || '').trim().length < 80) { showToast('Escreva pelo menos 80 caracteres no artigo.', 'error'); return; }
  button.disabled = true;
  button.textContent = 'Gerando sugestões...';
  try {
    var result = await fbFetch_('/api/davi/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: source, mode: all ? 'all' : 'basic' }) });
    if (!result || !result.ok) throw new Error(result && result.message || 'Falha ao gerar metadados.');
    builderSource_ = source;
    builderMetadata_ = { title: result.title, slug: builderSlug_(result.title), excerpt: result.excerpt,
      tags: result.tags.join(', '), category: result.category, postType: result.postType,
      postTypeLabel: result.postTypeLabel, seoTitle: result.seoTitle, seoDescription: result.seoDescription };
    if (all) applyBuilderProject_(result.project);
    var panel = document.getElementById('ai-metadata-proposal');
    panel.replaceChildren();
    var heading = document.createElement('strong');
    heading.textContent = all ? 'Metadados aplicados — revise antes de publicar' : 'Categoria, tipo e tags aplicados — revise as sugestões';
    panel.appendChild(heading);
    var rows = [['title','Título'],['slug','Slug'],['excerpt','Resumo'],['category','Categoria'],['postType','Tipo de post'],['tags','Tags']];
    if (all) rows.push(['seoTitle','Título SEO'],['seoDescription','Descrição SEO']);
    rows.forEach(function(row) {
      if (!builderMetadata_[row[0]]) return;
      var line = document.createElement('div'); line.className = 'builder-proposal-row';
      var label = document.createElement('span'); label.textContent = row[1];
      var value = document.createElement('p'); value.textContent = row[0] === 'postType' ? builderMetadata_.postTypeLabel : builderMetadata_[row[0]];
      var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'tb-btn'; apply.textContent = 'Aplicar';
      apply.addEventListener('click', function() { applyBuilderMetadata(row[0]); });
      line.append(label, value, apply); panel.appendChild(line);
    });
    if (all) {
      var applyAll = document.createElement('button'); applyAll.type = 'button'; applyAll.className = 'tb-btn';
      applyAll.textContent = 'Aplicar tudo';
      applyAll.addEventListener('click', function() { rows.forEach(function(row) { applyBuilderMetadata(row[0], true); }); showToast('Metadados aplicados. Revise antes de publicar.', 'success'); });
      panel.appendChild(applyAll);
    }
    panel.hidden = false;
    applyBuilderMetadata('category', true);
    applyBuilderMetadata('postType', true);
    applyBuilderMetadata('tags', true);
    try {
      var savedTaxonomy = await fbFetch_('/api/posts/taxonomyAdd', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          category: document.getElementById('f-category').value,
          postType: { value: document.getElementById('f-type').value,
            label: document.getElementById('f-type').selectedOptions[0].textContent },
          tags: result.tags
        }) });
      if (savedTaxonomy && savedTaxonomy.ok && savedTaxonomy.taxonomy) renderTagSuggestions_(savedTaxonomy.taxonomy.tags);
      else throw new Error('Não foi possível registrar as novas opções.');
    } catch (_) { showToast('As novas opções serão registradas ao salvar o artigo.', 'error'); }
    if (all) {
      rows.forEach(function(row) { applyBuilderMetadata(row[0], true); });
      showToast('Metadados e detalhes disponíveis aplicados. Revise antes de publicar.', 'success');
    }
  } catch (error) { showToast(error.message || 'Falha ao gerar metadados.', 'error'); }
  finally { button.disabled = false; button.textContent = all ? 'Gerar todos os metadados com IA' : 'Sugerir metadados, categoria e tipo com IA'; }
}

function applyBuilderProject_(project) {
  var ids = { problem:'f-problem', solution:'f-solution', technologies:'f-tech', result:'f-result', client:'f-client', internal_notes:'f-obs' };
  Object.keys(ids).forEach(function(key) {
    var element = document.getElementById(ids[key]);
    if (element && project && project[key]) {
      element.value = project[key];
      element.dispatchEvent(new Event('input', { bubbles:true }));
    }
  });
}

async function suggestProjectDetails() {
  var editor = document.getElementById('editor-area');
  var source = editor.innerHTML;
  var button = document.getElementById('ai-project-btn');
  if ((editor.innerText || '').trim().length < 80) return showToast('Escreva pelo menos 80 caracteres no artigo.', 'error');
  button.disabled = true; button.textContent = 'Lendo artigo...';
  try {
    var result = await fbFetch_('/api/davi/metadata', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ html:source, mode:'project' }) });
    if (!result || !result.ok) throw new Error(result && result.message || 'Falha ao gerar detalhes.');
    if (editor.innerHTML !== source) throw new Error('O artigo mudou durante a geração. Clique novamente.');
    applyBuilderProject_(result.project);
    showToast('Detalhes encontrados no artigo aplicados. Campos sem evidência ficaram vazios.', 'success');
  } catch (error) { showToast(error.message || 'Falha ao gerar detalhes.', 'error'); }
  finally { button.disabled = false; button.textContent = 'Preencher detalhes com IA'; }
}

function applyBuilderMetadata(field, quiet) {
  if (!builderMetadata_) return;
  if (document.getElementById('editor-area').innerHTML !== builderSource_) {
    showToast('O artigo mudou. Gere novas sugestões para evitar aplicar dados antigos.', 'error');
    document.getElementById('ai-metadata-proposal').hidden = true; return;
  }
  var ids = { title:'f-title', slug:'f-slug', excerpt:'f-excerpt', tags:'f-tags',
    category:'f-category', postType:'f-type', seoTitle:'f-seo-title', seoDescription:'f-seo-desc' };
  var element = document.getElementById(ids[field]); if (!element) return;
  if (!builderMetadata_[field]) return;
  element.value = field === 'category' ? ensureTaxonomyOption_('f-category', builderMetadata_.category, builderMetadata_.category)
    : field === 'postType' ? ensureTaxonomyOption_('f-type', builderMetadata_.postType, builderMetadata_.postTypeLabel)
    : field === 'tags' ? [...new Map((element.value + ',' + builderMetadata_.tags).split(',').map(function (tag) { return tag.trim(); })
        .filter(Boolean).map(function (tag) { return [taxonomyKey_(tag), tag]; })).values()].join(', ')
    : builderMetadata_[field];
  if (field === 'seoTitle' || field === 'seoDescription') element.dataset.manual = '1';
  element.dispatchEvent(new Event('input', { bubbles:true }));
  if (field === 'slug') document.getElementById('slug-preview').textContent = element.value;
  if (!quiet) showToast('Sugestão aplicada em ' + field + '.', 'success');
}

function previewArticleMedia() {
  clearTimeout(builderMediaTimer_);
  updateTiktokGate();
  builderMediaTimer_ = setTimeout(function() {
    var target = document.getElementById('builder-media-preview');
    var videoUrl = document.getElementById('f-video').value.trim();
    var audioUrl = document.getElementById('f-audio').value.trim();
    var ownVideoUrl = document.getElementById('f-tiktok-video').value.trim();
    target.replaceChildren();
    [[videoUrl, LazyMedia.video, 'Prévia do vídeo'], [audioUrl, LazyMedia.audio, 'Prévia do áudio']].forEach(function(item) {
      if (!item[0]) return;
      var media = item[1](item[0]);
      var box = document.createElement('div'); box.className = 'builder-media-box';
      var label = document.createElement('strong'); label.textContent = item[2]; box.appendChild(label);
      if (!media) {
        var hint = document.createElement('p'); hint.textContent = 'Link não reconhecido ou sem HTTPS. Use um provedor indicado acima.'; box.appendChild(hint);
      } else if (media.provider === 'file') {
        var player = document.createElement(item[2] === 'Prévia do vídeo' ? 'video' : 'audio');
        player.controls = true; player.preload = 'metadata'; player.src = media.src;
        if (player.tagName === 'VIDEO') player.style.cssText = 'display:block;width:100%;max-width:640px;aspect-ratio:16/9;border-radius:8px;background:#000';
        box.appendChild(player);
      } else {
        var frame = document.createElement('iframe'); frame.src = media.src; frame.title = item[2]; frame.loading = 'lazy';
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; frame.allowFullscreen = true;
        frame.style.height = item[2] === 'Prévia do vídeo' ? 'min(56vw,360px)' : (media.height || 232) + 'px';
        box.appendChild(frame);
      }
      target.appendChild(box);
    });
    if (ownVideoUrl) {
      var ownBox = document.createElement('div'); ownBox.className = 'builder-media-box';
      var ownLabel = document.createElement('strong'); ownLabel.textContent = 'Prévia do vídeo próprio para TikTok'; ownBox.appendChild(ownLabel);
      try {
        var ownUrl = new URL(ownVideoUrl);
        if (ownUrl.protocol !== 'https:') throw new Error();
        var ownPlayer = document.createElement('video'); ownPlayer.controls = true; ownPlayer.preload = 'metadata'; ownPlayer.src = ownUrl.href; ownPlayer.style.cssText = 'display:block;width:100%;max-width:640px;border-radius:8px';
        ownBox.appendChild(ownPlayer);
      } catch (_) { var ownHint = document.createElement('p'); ownHint.textContent = 'Use uma URL HTTPS válida para o vídeo próprio.'; ownBox.appendChild(ownHint); }
      target.appendChild(ownBox);
    }
  }, 450);
}

function updateTiktokGate() {
  var toggle = document.getElementById('f-auto-tiktok');
  var hasVideo = !!document.getElementById('f-tiktok-video').value.trim();
  toggle.disabled = !tiktokConfigured_ || !hasVideo;
  if (toggle.disabled) toggle.checked = false;
  document.getElementById('social-hint-tiktok').textContent = !tiktokConfigured_
    ? 'Configure a API e o domínio do vídeo em Configurações'
    : (hasVideo ? 'Vídeo próprio pronto para envio' : 'Anexe um vídeo próprio no campo Mídia e links');
}

async function onTiktokVideoPicked(input) {
  var file = input.files && input.files[0]; if (!file) return;
  var status = document.getElementById('tiktok-upload-status');
  if (file.size > 20 * 1024 * 1024 || file.type !== 'video/mp4') {
    status.textContent = 'Use MP4 de até 20 MB.'; input.value = ''; return;
  }
  var publish = document.getElementById('btn-publish');
  var draft = document.getElementById('btn-draft');
  publish.disabled = draft.disabled = true;
  tiktokVideoUploading_ = true;
  status.textContent = 'Enviando vídeo...';
  try {
    var user = await ensureFbUser_();
    var token = await user.getIdToken();
    var dataUrl = await new Promise(function(resolve, reject) {
      var reader = new FileReader(); reader.onload = function() { resolve(reader.result); }; reader.onerror = reject; reader.readAsDataURL(file);
    });
    var response = await fetch('/api/posts/uploadVideo', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token }, body:JSON.stringify({ base64:String(dataUrl).split(',')[1] }) });
    var result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'Falha no envio do vídeo.');
    document.getElementById('f-tiktok-video').value = result.url;
    status.textContent = 'Vídeo enviado para o blog.';
    previewArticleMedia();
  } catch (error) { status.textContent = error.message || 'Falha no envio do vídeo.'; }
  finally { tiktokVideoUploading_ = false; publish.disabled = draft.disabled = false; input.value = ''; if (typeof updatePublishButton === 'function') updatePublishButton(); }
}

async function loadTikTokCreator() {
  var toggle = document.getElementById('f-auto-tiktok');
  var select = document.getElementById('f-tiktok-privacy');
  if (!toggle.checked) { select.replaceChildren(new Option('Escolha o público do vídeo','')); return; }
  select.replaceChildren(new Option('Consultando opções da conta...',''));
  try {
    var result = await fbFetch_('/api/social/creator', { method:'GET' });
    if (!result || !result.ok) throw new Error((result && result.message) || 'Não foi possível consultar a conta TikTok.');
    select.replaceChildren(new Option('Escolha o público do vídeo',''));
    var labels = { PUBLIC_TO_EVERYONE:'Público', MUTUAL_FOLLOW_FRIENDS:'Amigos mútuos', FOLLOWER_OF_CREATOR:'Seguidores', SELF_ONLY:'Somente eu' };
    (result.privacyLevels || []).forEach(function(value) { select.add(new Option(labels[value] || value, value)); });
    if (!result.privacyLevels || !result.privacyLevels.length) throw new Error('A conta não oferece uma opção de público para esta integração.');
  } catch (error) {
    toggle.checked = false;
    select.replaceChildren(new Option('Escolha o público do vídeo',''));
    showToast(error.message || 'TikTok indisponível.', 'error');
  }
}

var socialFieldIds_ = {
  metaPageId:'social-meta-page-id', metaPageToken:'social-meta-page-token',
  instagramAccountId:'social-instagram-id', instagramToken:'social-instagram-token',
  xUserToken:'social-x-token', tiktokAccessToken:'social-tiktok-token',
  tiktokVerifiedDomain:'social-tiktok-domain'
};
var socialSecretKeys_ = ['metaPageToken','instagramToken','xUserToken','tiktokAccessToken'];

function showSocialConfig(config) {
  Object.keys(socialFieldIds_).forEach(function(key) {
    var el = document.getElementById(socialFieldIds_[key]);
    if (socialSecretKeys_.includes(key)) { el.value = ''; el.placeholder = config[key] ? 'Configurado no servidor — deixe vazio para manter' : 'Cole o token'; }
    else el.value = config[key] || '';
  });
  ['facebook','instagram','x','tiktok'].forEach(function(channel) {
    var enabled = !!(config.channels && config.channels[channel]);
    var toggle = document.getElementById('f-auto-' + channel);
    var hint = document.getElementById('social-hint-' + channel);
    toggle.disabled = !enabled;
    if (!enabled) toggle.checked = false;
    if (enabled) hint.textContent = 'Configurado · pronto para usar com as permissões da plataforma';
  });
  tiktokConfigured_ = !!(config.channels && config.channels.tiktok);
  updateTiktokGate();
  var count = Object.values(config.channels || {}).filter(Boolean).length;
  document.getElementById('msg-social').textContent = count + ' canal(is) configurado(s). A publicação depende das permissões e da validade dos tokens.';
}

async function refreshSocialConfig() {
  try {
    var result = await fbFetch_('/api/social/config', { method:'GET' });
    if (!result || !result.ok) throw new Error((result && result.message) || 'Não foi possível ler as integrações.');
    showSocialConfig(result.config);
  } catch (error) { document.getElementById('msg-social').textContent = error.message || 'Falha ao verificar conexões.'; }
}

async function saveSocialConfig() {
  var data = {}, clearSecrets = [];
  Object.keys(socialFieldIds_).forEach(function(key) {
    var value = document.getElementById(socialFieldIds_[key]).value.trim();
    if (!socialSecretKeys_.includes(key) || value) data[key] = value;
  });
  [['metaPageToken','social-clear-meta-page-token'],['instagramToken','social-clear-instagram-token'],
    ['xUserToken','social-clear-x-token'],['tiktokAccessToken','social-clear-tiktok-token']].forEach(function(item) {
    if (document.getElementById(item[1]).checked) clearSecrets.push(item[0]);
  });
  data.clearSecrets = clearSecrets;
  try {
    var result = await fbFetch_('/api/social/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    if (!result || !result.ok) throw new Error((result && result.message) || 'Falha ao salvar.');
    showSocialConfig(result.config);
    ['social-clear-meta-page-token','social-clear-instagram-token','social-clear-x-token','social-clear-tiktok-token'].forEach(function(id) { document.getElementById(id).checked = false; });
    showToast('Integrações sociais salvas.', 'success');
  } catch (error) { showToast(error.message || 'Falha ao salvar integrações.', 'error'); }
}

firebase.auth().onAuthStateChanged(function(user) { if (user) refreshSocialConfig(); });

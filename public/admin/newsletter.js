(function () {
  'use strict';
  var state = { subscribers: [], campaigns: [], selected: '', settings: { enabled: false, days: 60, min_sends: 3 }, busy: false };
  var $ = id => document.getElementById(id);
  var escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  var n = value => Number(value || 0);
  var fmt = value => { var time = Date.parse(value || ''); return Number.isFinite(time) ? new Date(time).toLocaleString('pt-BR') : '—'; };
  async function api(path, options) {
    var response = await fetch('/api/campaigns/' + path, Object.assign({ credentials: 'same-origin' }, options || {}));
    var data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || data.error || 'Falha ao carregar dados.');
    return data;
  }
  var post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function periodCampaigns() {
    var period = $('nl-period').value;
    if (period === 'all') return state.campaigns;
    var cutoff = new Date();
    if (period === 'today') cutoff.setHours(0, 0, 0, 0);
    else cutoff = new Date(Date.now() - Number(period) * 86400000);
    return state.campaigns.filter(c => (Date.parse(c.sent_at || '') || n(c.created_at)) >= cutoff.getTime());
  }
  function metric(label, value, hint) {
    return '<div class="nl-metric"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span>' + (hint ? '<small>' + escapeHtml(hint) + '</small>' : '') + '</div>';
  }
  function renderMetrics() {
    var subs = state.subscribers;
    var active = subs.filter(s => s.status === 'active').length;
    var eligible = subs.filter(s => s.status === 'active' && s.consent === true).length;
    $('nl-count-active').textContent = active;
    $('nl-count-total').textContent = subs.length;
    $('nl-count-consent').textContent = subs.filter(s => s.consent === true).length;
    $('nl-sub-badge').textContent = eligible + ' aptos para envio';
    var campaigns = periodCampaigns();
    var sum = field => campaigns.reduce((total, row) => total + n(row[field]), 0);
    $('nl-metrics').innerHTML = metric('Aptos para envio', eligible, 'Ativos com consentimento')
      + metric('Campanhas', campaigns.length, $('nl-period').selectedOptions[0].textContent)
      + metric('Aceitos pelo Resend', sum('sent'), 'Entrega verificada no detalhe')
      + metric('Falhas no envio', sum('failed'), 'Veja o motivo na campanha')
      + metric('Entregues', sum('delivered'), 'Status consultado no Resend')
      + metric('Aberturas', sum('opened'), 'Podem ser subcontadas')
      + metric('Cliques no artigo', sum('clicked'), 'Contatos únicos')
      + metric('Suspensos', subs.filter(s => s.status === 'suppressed').length, 'Fora de futuros envios');
    $('nl-updated-at').textContent = 'Atualizado ' + new Date().toLocaleTimeString('pt-BR');
  }
  function renderSubscribers() {
    var search = $('nl-search').value.trim().toLowerCase();
    var rows = state.subscribers.filter(s => !search || [s.first_name, s.last_name, s.nickname, s.email].join(' ').toLowerCase().includes(search));
    $('nl-list-count').textContent = rows.length + ' de ' + state.subscribers.length;
    if (!rows.length) { $('nl-sub-list').textContent = 'Nenhum contato encontrado.'; return; }
    $('nl-sub-list').innerHTML = '<div style="overflow-x:auto"><table class="sub-table"><thead><tr><th>Contato</th><th>E-mail</th><th>Origem</th><th>Status</th><th>Consent.</th><th>Última abertura</th><th>Ação</th></tr></thead><tbody>'
      + rows.map(s => '<tr><td>' + escapeHtml([s.first_name, s.last_name].filter(Boolean).join(' ') || s.nickname || '—') + '</td><td>' + escapeHtml(s.email) + '</td><td>' + escapeHtml(s.source || '—') + '</td><td><span class="nl-status ' + escapeHtml(s.status || '') + '">' + escapeHtml(s.status || '—') + '</span></td><td>' + (s.consent === true ? 'Sim' : 'Não') + '</td><td>' + escapeHtml(fmt(s.last_open_at)) + '</td><td>'
        + (s.status === 'active' ? '<button type="button" class="nl-sub-action" data-nl-sub-action="suppress" data-id="' + escapeHtml(s.id) + '">Remover do envio</button>' : s.status === 'suppressed' && ['manual','inactivity'].includes(s.suppressed_reason) ? '<button type="button" class="nl-sub-action" data-nl-sub-action="restore" data-id="' + escapeHtml(s.id) + '">Restaurar</button>' : '—') + '</td></tr>').join('')
      + '</tbody></table></div>';
    renderInactivityPreview();
  }
  function renderCampaigns() {
    var campaigns = periodCampaigns();
    if (!campaigns.length) { $('nl-camp-list').textContent = 'Nenhuma campanha neste período.'; return; }
    $('nl-camp-list').innerHTML = '<div class="nl-campaigns">' + campaigns.map(c => '<button type="button" class="nl-campaign' + (state.selected === c.id ? ' selected' : '') + '" data-campaign-id="' + escapeHtml(c.id) + '"><small>' + escapeHtml(fmt(c.sent_at)) + '</small><strong>' + escapeHtml(c.post_title || c.subject || 'Campanha') + '</strong><span>' + escapeHtml(c.subject || '') + '</span><div class="nl-campaign-metrics"><span>' + n(c.sent) + ' aceitos</span><span>' + n(c.failed) + ' falhas</span><span>' + n(c.delivered) + ' entregues</span><span>' + n(c.opened) + ' aberturas</span><span>' + n(c.clicked) + ' cliques</span></div></button>').join('') + '</div>';
  }
  function renderInactivityPreview() {
    var days = Number($('nl-auto-days').value || 60), minSends = Number($('nl-auto-min').value || 3);
    var cutoff = Date.now() - days * 86400000;
    var count = state.subscribers.filter(s => s.status === 'active' && s.consent === true && n(s.send_count) >= minSends && (Date.parse(s.first_sent_at || '') || Infinity) <= cutoff && Math.max(Date.parse(s.last_open_at || '') || 0, Date.parse(s.last_clicked_at || '') || 0) < cutoff).length;
    $('nl-auto-preview').textContent = count + ' contatos atenderiam à regra agora. Aberturas podem não ser registradas por alguns leitores de e-mail.';
  }
  async function loadSubscribers() {
    $('nl-sub-list').textContent = 'Carregando inscritos...';
    try {
      var data = await api('subscribers?blog_id=' + encodeURIComponent(window._currentBlogId || 'your-blog'));
      state.subscribers = data.subscribers || [];
      renderSubscribers(); renderMetrics();
    } catch (error) { $('nl-sub-list').textContent = error.message; }
  }
  async function loadCampaigns() {
    $('nl-camp-list').textContent = 'Carregando campanhas...';
    try {
      var data = await api('list?blog_id=' + encodeURIComponent(window._currentBlogId || 'your-blog'));
      state.campaigns = data.campaigns || [];
      renderCampaigns(); renderMetrics();
    } catch (error) { $('nl-camp-list').textContent = error.message; }
  }
  async function loadSettings() {
    try {
      var data = await api('settings');
      state.settings = data.settings;
      $('nl-auto-enabled').checked = !!data.settings.enabled;
      $('nl-auto-days').value = data.settings.days || 60;
      $('nl-auto-min').value = data.settings.min_sends || 3;
      renderInactivityPreview();
    } catch (error) { $('nl-auto-preview').textContent = error.message; }
  }
  async function loadDetail(id, refresh) {
    state.selected = id; renderCampaigns();
    var panel = $('nl-campaign-detail'); panel.hidden = false; panel.textContent = 'Carregando detalhes...';
    try {
      var data = await api('detail?id=' + encodeURIComponent(id) + (refresh ? '&refresh=1' : ''));
      var c = data.campaign, recipients = data.recipients || [];
      var headline = escapeHtml(c.post_title || c.subject || 'Campanha');
      var article = c.slug ? '<a href="https://blog.example.com/artigo/' + encodeURIComponent(c.slug) + '" target="_blank" rel="noopener noreferrer">Abrir artigo</a>' : '';
      panel.innerHTML = '<div class="nl-detail-head"><h3>' + headline + '</h3><div><button type="button" data-nl-refresh-detail="' + escapeHtml(id) + '">Atualizar status</button> <button type="button" data-nl-close-detail>Fechar</button></div></div><p>' + escapeHtml(fmt(c.sent_at)) + ' · ' + n(c.total) + ' destinatários · ' + n(c.sent) + ' aceitos · ' + n(c.failed) + ' falhas · ' + n(c.delivered) + ' entregues · ' + n(c.opened) + ' aberturas · ' + n(c.clicked) + ' cliques. ' + article + '</p>';
      if (!recipients.length) {
        panel.innerHTML += '<p>Esta campanha antiga guarda apenas totais. Os dados individuais e motivos de falha não foram registrados naquele disparo.</p>';
      } else {
        panel.innerHTML += '<div class="nl-table-wrap"><table><thead><tr><th>Destinatário</th><th>Envio</th><th>Entrega</th><th>Abertura</th><th>Clique</th><th>Erro</th></tr></thead><tbody>' + recipients.map(r => '<tr><td>' + escapeHtml(r.email) + '</td><td><span class="nl-status ' + escapeHtml(r.status) + '">' + escapeHtml(r.status === 'accepted' ? 'Aceito' : r.status === 'error' ? 'Falhou' : r.status || '—') + '</span></td><td>' + escapeHtml(r.delivered_at ? 'Entregue' : r.provider_status || 'Não confirmado') + '</td><td>' + escapeHtml(fmt(r.opened_at)) + '</td><td>' + escapeHtml(fmt(r.clicked_at)) + '</td><td>' + escapeHtml([r.error_code, r.error_message].filter(Boolean).join(' · ') || '—') + '</td></tr>').join('') + '</tbody></table></div>';
      }
      var found = state.campaigns.find(row => row.id === id);
      if (found) Object.assign(found, c);
      renderMetrics(); renderCampaigns();
    } catch (error) { panel.textContent = error.message; }
  }
  async function saveSettings() {
    var data = { enabled: $('nl-auto-enabled').checked, days: Number($('nl-auto-days').value), min_sends: Number($('nl-auto-min').value) };
    try { await post('settings', data); state.settings = data; $('nl-auto-preview').textContent = 'Regra salva. A verificação roda diariamente às 03h. '; renderInactivityPreview(); }
    catch (error) { $('nl-auto-preview').textContent = error.message; }
  }
  async function manualSend() {
    if (state.busy) return;
    var data = { blog_id: window._currentBlogId || 'your-blog', subject: $('nl-subject').value.trim(), post_title: $('nl-post-title').value.trim(), excerpt: $('nl-post-excerpt').value.trim(), slug: $('nl-post-slug').value.trim(), cover_url: $('nl-post-cover').value.trim(), cta_label: 'Ler artigo completo' };
    if (!data.post_title || !data.slug) { $('nl-manual-result').textContent = 'Preencha título e slug.'; return; }
    var eligible = state.subscribers.filter(s => s.status === 'active' && s.consent === true).length;
    if (!confirm('Disparar para ' + eligible + ' contatos ativos com consentimento?')) return;
    state.busy = true; $('nl-manual-result').textContent = 'Enviando para ' + eligible + ' contatos...';
    try {
      var result = await post('send', data);
      $('nl-manual-result').textContent = result.sent + ' aceitos pelo Resend; ' + result.failed + ' falhas. Abra a campanha para ver os destinatários e erros.';
      await Promise.all([loadSubscribers(), loadCampaigns()]);
      if (result.campaign_id) await loadDetail(result.campaign_id, false);
    } catch (error) { $('nl-manual-result').textContent = error.message; }
    finally { state.busy = false; }
  }
  window.carregarSubscribers = loadSubscribers;
  window.carregarCampanhas = loadCampaigns;
  window.dispararNewsletterManual = manualSend;
  window.logCampaign_ = function (data, result) { if (result && result.campaign_id) loadCampaigns(); };
  document.addEventListener('DOMContentLoaded', function () {
    $('nl-period').addEventListener('change', function () { renderMetrics(); renderCampaigns(); });
    $('nl-search').addEventListener('input', renderSubscribers);
    $('nl-auto-days').addEventListener('input', renderInactivityPreview);
    $('nl-auto-min').addEventListener('input', renderInactivityPreview);
    $('nl-auto-save').addEventListener('click', saveSettings);
    $('nl-refresh-all').addEventListener('click', function () { Promise.all([loadSubscribers(), loadCampaigns(), loadSettings()]); });
    $('nl-sub-list').addEventListener('click', async function (event) {
      var button = event.target.closest('[data-nl-sub-action]'); if (!button) return;
      var id = button.dataset.id, action = button.dataset.nlSubAction;
      var subscriber = state.subscribers.find(row => row.id === id);
      if (!subscriber || !confirm((action === 'suppress' ? 'Remover dos próximos envios: ' : 'Restaurar nos envios: ') + subscriber.email + '?')) return;
      button.disabled = true;
      try { await post('subscriber', { id, action }); await loadSubscribers(); }
      catch (error) { alert(error.message); button.disabled = false; }
    });
    $('nl-camp-list').addEventListener('click', function (event) { var button = event.target.closest('[data-campaign-id]'); if (button) loadDetail(button.dataset.campaignId, true); });
    $('nl-campaign-detail').addEventListener('click', function (event) {
      var refresh = event.target.closest('[data-nl-refresh-detail]');
      if (refresh) loadDetail(refresh.dataset.nlRefreshDetail, true);
      if (event.target.closest('[data-nl-close-detail]')) { $('nl-campaign-detail').hidden = true; state.selected = ''; renderCampaigns(); }
    });
    loadSettings();
    setInterval(function () {
      var section = $('section-newsletter');
      if (section && getComputedStyle(section).display !== 'none') {
        Promise.all([loadSubscribers(), loadCampaigns()]);
        if (state.selected && !$('nl-campaign-detail').hidden) loadDetail(state.selected, true);
      }
    }, 60000);
  });
})();

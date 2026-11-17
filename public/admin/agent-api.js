(() => {
  const scopes = [
    ['posts:read','Ler artigos'], ['posts:write','Criar e editar rascunhos'],
    ['posts:publish','Publicar e traduzir'], ['posts:schedule','Agendar publicação'],
    ['posts:delete','Excluir artigos'], ['media:write','Enviar e incorporar mídia'],
    ['newsletter:read','Ver campanhas'], ['newsletter:send','Enviar newsletter'],
    ['social:write','Publicar nas redes'], ['automations:read','Ver automações'],
    ['automations:write','Alterar automações']
  ];
  const el = id => document.getElementById(id);
  const status = message => { el('agent-api-status').textContent = message; };
  async function request(path, options) {
    const response = await fetch('/api/v1' + path, { ...options, headers:{ 'Content-Type':'application/json', ...(options?.headers || {}) } });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || 'Falha na API.');
    return data;
  }
  function showSecret(value) {
    const box = el('agent-api-secret');
    box.replaceChildren(); box.hidden = false;
    const label = document.createElement('strong'); label.textContent = 'Guarde este token agora. Ele aparece apenas uma vez.';
    const input = document.createElement('input'); input.value = value; input.readOnly = true; input.setAttribute('aria-label','Token do agente');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Copiar token';
    button.addEventListener('click', async () => { await navigator.clipboard.writeText(value); button.textContent = 'Copiado'; });
    box.append(label, input, button);
  }
  async function refresh() {
    const list = el('agent-api-list'); list.textContent = 'Carregando…';
    try {
      const data = await request('/tokens');
      list.replaceChildren();
      for (const token of data.tokens) {
        const row = document.createElement('div'); row.className = 'agent-api-token';
        const info = document.createElement('span');
        info.textContent = `${token.label} · ${token.prefix || token.id} · ${token.revoked ? 'revogado' : 'ativo'} · expira ${new Date(token.expiresAt).toLocaleDateString('pt-BR')}`;
        row.append(info);
        if (!token.revoked) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Revogar';
          button.addEventListener('click', async () => {
            if (!confirm(`Revogar o token “${token.label}”? O agente perderá acesso imediatamente.`)) return;
            try { await request('/tokens/' + encodeURIComponent(token.id), { method:'DELETE' }); await refresh(); status('Token revogado.'); }
            catch (error) { status(error.message); }
          });
          row.append(button);
        }
        list.append(row);
      }
      if (!data.tokens.length) list.textContent = 'Nenhum token criado.';
    } catch (error) { list.textContent = ''; status(error.message); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const choices = el('agent-api-scopes');
    for (const [value, label] of scopes) {
      const item = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = value;
      if (['posts:read','posts:write','posts:publish','media:write'].includes(value)) checkbox.checked = true;
      item.append(checkbox, document.createTextNode(label)); choices.append(item);
    }
    el('agent-api-create').addEventListener('click', async () => {
      const button = el('agent-api-create'); button.disabled = true; status('Gerando token…');
      try {
        const data = await request('/tokens', { method:'POST', body:JSON.stringify({
          label:el('agent-api-label').value.trim(),
          expiresInDays:Number(el('agent-api-days').value),
          scopes:[...choices.querySelectorAll('input:checked')].map(input => input.value)
        }) });
        showSecret(data.token); await refresh(); status('Token criado. Copie e guarde o segredo.');
      } catch (error) { status(error.message); }
      finally { button.disabled = false; }
    });
    el('agent-api-refresh').addEventListener('click', refresh);
    el('agent-api-card').addEventListener('focusin', () => { if (!el('agent-api-list').childNodes.length) refresh(); }, { once:true });
  });
})();

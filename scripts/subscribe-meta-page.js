'use strict';
// Execute localmente com META_SYSTEM_USER_TOKEN no ambiente. Não imprime o token.
const pageId = process.env.META_PAGE_ID || '';
const token = process.env.META_SYSTEM_USER_TOKEN;
if (!token || !/^\d{5,30}$/.test(pageId)) {
  console.error('Configure META_SYSTEM_USER_TOKEN e META_PAGE_ID.'); process.exit(1);
}
(async () => {
  const pageResponse = await fetch(`https://graph.facebook.com/v26.0/${pageId}?fields=access_token`, {
    headers:{ Authorization:`Bearer ${token}` }, signal:AbortSignal.timeout(12000) });
  const page = await pageResponse.json();
  if (!pageResponse.ok || !page.access_token) throw new Error(`Não foi possível obter token da Página: ${page.error?.code || pageResponse.status}`);
  const url = `https://graph.facebook.com/v26.0/${pageId}/subscribed_apps`;
  const response = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${page.access_token}`,
    'Content-Type':'application/x-www-form-urlencoded' },
    body:new URLSearchParams({ subscribed_fields:'feed,messages,messaging_postbacks' }), signal:AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Meta recusou inscrição: código ${data.error?.code || response.status}`);
  console.log('Inscrição da Página:', data.success === true ? 'confirmada' : 'verificar no painel da Meta');
})().catch(error => { console.error(error.message); process.exitCode = 1; });

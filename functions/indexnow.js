/**
 * Lazy Labs — IndexNow (protocolo aberto usado por Bing, DuckDuckGo e Yandex pra
 * avisar "essa URL mudou, vem indexar agora" — sem precisar verificar conta nenhuma,
 * so precisa hospedar a key num arquivo estatico na raiz do dominio).
 * Nao cobre o Google — o Google tem a propria Indexing API, restrita oficialmente a
 * paginas de vaga de emprego/live stream; pra blog normal o caminho e Search Console
 * (verificar propriedade + submeter o sitemap.xml).
 *
 * Key hospedada em /public/<KEY>.txt (deploy junto com o hosting).
 */
const KEY = 'YOUR_INDEXNOW_KEY';
const HOST = 'blog.example.com';
const KEY_LOCATION = 'https://blog.example.com/' + KEY + '.txt';

// A Function aguarda o POST: tarefas soltas podem ser encerradas ao fim da resposta.
async function ping(urls) {
  const urlList = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!urlList.length || !/^[a-f0-9]{32}$/.test(KEY)) return { ok: true, skipped: true };
  try {
  const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urlList })
  });
  console.log('[indexnow] ping', urlList.length, 'url(s) ->', response.status);
  return { ok: response.ok, status: response.status };
  } catch (err) {
    console.error('[indexnow] falhou', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { ping: ping, KEY: KEY, KEY_LOCATION: KEY_LOCATION };

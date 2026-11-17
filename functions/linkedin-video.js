'use strict';

const OwnVideo = require('./own-video');
const ENDPOINT = 'https://api.linkedin.com/rest/videos';

async function upload(t, sourceUrl, version) {
  const bytes = await OwnVideo.read(sourceUrl);
  const headers = { Authorization:'Bearer ' + t.access_token, 'LinkedIn-Version':version,
    'X-Restli-Protocol-Version':'2.0.0', 'Content-Type':'application/json' };
  const start = await fetch(ENDPOINT + '?action=initializeUpload', { method:'POST', headers,
    body:JSON.stringify({ initializeUploadRequest:{ owner:t.member_urn, fileSizeBytes:bytes.length,
      uploadCaptions:false, uploadThumbnail:false } }) });
  const startText = await start.text();
  if (start.status === 426 && /NONEXISTENT_VERSION/.test(startText)) return { badVersion:true };
  if (!start.ok) return { error:'LinkedIn não iniciou o vídeo: HTTP ' + start.status + ' ' + startText.slice(0, 180) };
  let info; try { info = JSON.parse(startText).value; } catch (_) { return { error:'Resposta inválida no início do vídeo.' }; }
  if (!info || !/^urn:li:video:/.test(info.video) || !Array.isArray(info.uploadInstructions) || !info.uploadInstructions.length) {
    return { error:'LinkedIn não retornou as instruções de envio do vídeo.' };
  }
  const parts = [];
  for (const part of info.uploadInstructions) {
    const uploadUrl = String(part.uploadUrl || '');
    if (!/^https:\/\/(?:www\.)?linkedin\.com\//.test(uploadUrl)) return { error:'URL de upload do LinkedIn inválida.' };
    const first = Number(part.firstByte), last = Number(part.lastByte);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || first >= bytes.length) return { error:'Intervalo de upload do LinkedIn inválido.' };
    const response = await fetch(uploadUrl, { method:'PUT', headers:{ 'Content-Type':'application/octet-stream' }, body:bytes.subarray(first, Math.min(last + 1, bytes.length)) });
    if (!response.ok) return { error:'Falha ao enviar parte do vídeo ao LinkedIn: HTTP ' + response.status };
    const etag = String(response.headers.get('etag') || '').replace(/^"|"$/g, '');
    if (!etag) return { error:'LinkedIn não confirmou uma parte do vídeo.' };
    parts.push(etag);
  }
  const end = await fetch(ENDPOINT + '?action=finalizeUpload', { method:'POST', headers,
    body:JSON.stringify({ finalizeUploadRequest:{ video:info.video, uploadToken:info.uploadToken || '', uploadedPartIds:parts } }) });
  if (!end.ok) return { error:'LinkedIn não finalizou o vídeo: HTTP ' + end.status + ' ' + (await end.text()).slice(0, 180) };
  for (let attempt = 0; attempt < 12; attempt++) {
    const stateResponse = await fetch(ENDPOINT + '/' + encodeURIComponent(info.video), { headers });
    if (stateResponse.status === 404 && attempt < 11) { await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
    if (!stateResponse.ok) return { error:'LinkedIn não confirmou o processamento do vídeo: HTTP ' + stateResponse.status };
    const state = await stateResponse.json();
    if (state.status === 'AVAILABLE') return { urn:info.video };
    if (state.status === 'PROCESSING_FAILED') return { error:'LinkedIn recusou o vídeo: ' + String(state.processingFailureReason || 'formato ou processamento inválido').slice(0, 160) };
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return { error:'LinkedIn ainda está processando o vídeo. Confira o canal antes de tentar publicar novamente.' };
}

module.exports = { upload };

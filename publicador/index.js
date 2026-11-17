// publicador/index.js — Reels do Instagram agendados na nuvem (codebase "publicador", separada de functions/).
//
// A Graph API do Instagram não aceita horário de publicação (responde "User must be on whitelist"), então:
//   reelsAgendar  (HTTP privado)  guarda o pedido em Firestore e agenda UMA tarefa no Cloud Tasks para 8 min antes;
//   reelPublicar  (tarefa)        entrega o link do vídeo ao Instagram, espera processar, publica na hora marcada,
//                                 grava o permalink e apaga o vídeo do Storage.
// Nada fica rodando de tempos em tempos: cada post custa uma execução de poucos minutos.
// O vídeo é enviado pelo PC para gs://your-firebase-project.firebasestorage.app/reels/<id>.mp4 com um token de download
// (ferramentas/postar.py no estúdio de vídeos). Detalhes em PUBLICADOR.md.

const { onRequest } = require('firebase-functions/v2/https');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getFunctions } = require('firebase-admin/functions');

if (!getApps().length) initializeApp();

const REGION = 'southamerica-east1';
const GRAPH = 'https://graph.facebook.com/v26.0';
const IG_ID = 'YOUR_INSTAGRAM_BUSINESS_ID';          // @blog.example.com (META_SOCIAL_SETUP.md)
const BUCKET = 'your-firebase-project.firebasestorage.app';
const COL = 'reels_agenda';
const ANTECEDENCIA_S = 8 * 60;              // prepara o contêiner antes da hora; o Instagram leva 1–5 min para processar
const PROCESSAR_MAX_MS = 18 * 60 * 1000;
const metaToken = defineSecret('META_SYSTEM_USER_TOKEN');

const db = () => getFirestore();
const fila = () => getFunctions().taskQueue(`locations/${REGION}/functions/reelPublicar`);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(metodo, caminho, params) {
  const url = new URL(`${GRAPH}/${caminho}`);
  const opcoes = { method: metodo };
  if (metodo === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else opcoes.body = new URLSearchParams(params);
  const d = await (await fetch(url, opcoes)).json();
  if (d.error) {
    const e = new Error(`${d.error.code}/${d.error.error_subcode || '-'} ${d.error.message}`);
    e.code = d.error.code;
    throw e;
  }
  return d;
}

function urlDoVideo(caminho, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(caminho)}?alt=media&token=${token}`;
}

function semToken(id, d) {
  const { downloadToken, ...resto } = d;
  return { id, ...resto, quando: d.quando.toDate().toISOString() };
}

// POST {id, video, downloadToken, legenda, capaMs, quando (ISO), teste?} agenda · DELETE ?id= cancela · GET lista os últimos
exports.reelsAgendar = onRequest(
  { region: REGION, memory: '256MiB', timeoutSeconds: 30, invoker: 'private', maxInstances: 2 },
  async (req, res) => {
    try {
      if (req.method === 'GET') {
        const s = await db().collection(COL).orderBy('quando', 'desc').limit(40).get();
        return res.json(s.docs.map((d) => semToken(d.id, d.data())));
      }
      if (req.method === 'DELETE') {
        await db().collection(COL).doc(String(req.query.id || '')).update({ status: 'cancelado' });
        return res.json({ ok: true });
      }
      if (req.method !== 'POST') return res.status(405).json({ erro: 'método' });
      const b = req.body || {};
      const quando = new Date(b.quando);
      if (!/^[a-z0-9_-]{3,90}$/i.test(String(b.id || '')) || !/^reels\/[\w.-]+\.mp4$/.test(String(b.video || ''))
          || !/^[0-9a-f-]{36}$/.test(String(b.downloadToken || '')) || !String(b.legenda || '').trim() || Number.isNaN(quando.getTime())) {
        return res.status(400).json({ erro: 'campos inválidos (id, video, downloadToken, legenda, quando)' });
      }
      const ref = db().collection(COL).doc(b.id);
      const atual = await ref.get();
      if (atual.exists && atual.data().status === 'publicado') return res.status(409).json({ erro: 'já publicado' });
      await ref.set({
        video: b.video, downloadToken: b.downloadToken, legenda: String(b.legenda).slice(0, 2200),
        capaMs: Math.max(0, Math.round(Number(b.capaMs) || 0)), quando: Timestamp.fromDate(quando), teste: !!b.teste,
        status: 'agendado', erro: FieldValue.delete(), conteiner: FieldValue.delete(), criado: FieldValue.serverTimestamp(),
      }, { merge: true });
      const inicio = new Date(Math.max(Date.now() + 5000, quando.getTime() - ANTECEDENCIA_S * 1000));
      await fila().enqueue({ id: b.id }, { scheduleTime: inicio, dispatchDeadlineSeconds: 1800, id: `${b.id}-${quando.getTime()}` });
      return res.json({ ok: true, id: b.id, preparaEm: inicio.toISOString() });
    } catch (e) {
      logger.error('reelsAgendar', e);
      return res.status(500).json({ erro: e.message });
    }
  },
);

exports.reelPublicar = onTaskDispatched(
  {
    region: REGION, memory: '256MiB', timeoutSeconds: 1500, secrets: [metaToken],
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60, maxBackoffSeconds: 300 },
    rateLimits: { maxConcurrentDispatches: 3 },
  },
  async (req) => {
    const ref = db().collection(COL).doc(req.data.id);
    const doc = (await ref.get()).data();
    if (!doc || ['publicado', 'cancelado', 'teste-ok'].includes(doc.status)) return;
    const tk = metaToken.value();
    await ref.update({ status: 'preparando', tentativas: FieldValue.increment(1) });
    try {
      let cid = doc.conteiner;
      if (cid) {  // nova tentativa: reaproveita o contêiner se ainda serve
        const s = await graph('GET', cid, { access_token: tk, fields: 'status_code' }).catch(() => ({}));
        if (!['FINISHED', 'IN_PROGRESS'].includes(s.status_code)) cid = null;
      }
      if (!cid) {
        const c = await graph('POST', `${IG_ID}/media`, {
          access_token: tk, media_type: 'REELS', video_url: urlDoVideo(doc.video, doc.downloadToken),
          caption: doc.legenda, share_to_feed: 'true', thumb_offset: String(doc.capaMs),
        });
        cid = c.id;
        await ref.update({ conteiner: cid });
      }
      const limite = Date.now() + PROCESSAR_MAX_MS;
      for (;;) {
        const s = await graph('GET', cid, { access_token: tk, fields: 'status_code,status' });
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
          await ref.update({ conteiner: FieldValue.delete() });
          throw new Error(`Instagram recusou o vídeo: ${s.status || s.status_code}`);
        }
        if (Date.now() > limite) throw new Error('Instagram não terminou de processar a tempo');
        await espera(15000);
      }
      if (doc.teste) {  // ensaio: processa e para antes de publicar
        await ref.update({ status: 'teste-ok', pronto: FieldValue.serverTimestamp() });
        await getStorage().bucket(BUCKET).file(doc.video).delete({ ignoreNotFound: true });
        return;
      }
      const falta = doc.quando.toMillis() - Date.now();
      if (falta > 0) await espera(Math.min(falta, 20 * 60 * 1000));
      const p = await graph('POST', `${IG_ID}/media_publish`, { access_token: tk, creation_id: cid });
      await ref.update({ status: 'publicado', mediaId: p.id, publicado: FieldValue.serverTimestamp(), erro: FieldValue.delete() });
      const m = await graph('GET', p.id, { access_token: tk, fields: 'permalink' }).catch(() => ({}));
      if (m.permalink) await ref.update({ permalink: m.permalink });
      await getStorage().bucket(BUCKET).file(doc.video).delete({ ignoreNotFound: true });
      logger.info('reel publicado', req.data.id, m.permalink || p.id);
    } catch (e) {
      logger.error('reelPublicar', req.data.id, e.message);
      await ref.update({ status: 'erro', erro: String(e.message).slice(0, 500) });
      throw e;  // a fila tenta de novo (até 3 vezes)
    }
  },
);

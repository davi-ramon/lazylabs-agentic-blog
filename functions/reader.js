'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const validSlug = slug => typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 200;

async function handler(req, res) {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok:false, message:'Use POST.' }); return; }
  const token = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
  if (!token) { res.status(401).json({ ok:false, message:'Entre na sua conta para ver os favoritos.' }); return; }
  let user;
  try { user = await getAuth().verifyIdToken(token, true); }
  catch (_) { res.status(401).json({ ok:false, message:'Sessão expirada. Entre novamente.' }); return; }
  const db = getFirestore();
  const action = req.path.split('/').filter(Boolean).at(-1);
  const favorites = db.collection('readerFavorites').doc(user.uid).collection('posts');
  try {
    if (action === 'list') {
      const snap = await favorites.orderBy('added_at', 'desc').limit(200).get();
      res.status(200).json({ ok:true, posts:snap.docs.map(doc => ({ slug:doc.id, ...doc.data() })) }); return;
    }
    const slug = String(req.body?.slug || '');
    if (!validSlug(slug)) { res.status(400).json({ ok:false, message:'Artigo inválido.' }); return; }
    const postRef = db.doc('posts/' + slug);
    const favoriteRef = favorites.doc(slug);
    if (action === 'status') {
      const [post, favorite] = await Promise.all([postRef.get(), favoriteRef.get()]);
      if (!post.exists || post.data().status !== 'published' || post.data().blog_id !== 'your-blog') {
        res.status(404).json({ ok:false, message:'Artigo não encontrado.' }); return;
      }
      res.status(200).json({ ok:true, saved:favorite.exists, count:Math.max(0,Number(post.data().favorite_count)||0) }); return;
    }
    if (action !== 'toggle') { res.status(404).json({ ok:false, message:'Rota inválida.' }); return; }
    const result = await db.runTransaction(async tx => {
      const [post, favorite] = await Promise.all([tx.get(postRef), tx.get(favoriteRef)]);
      if (!post.exists || post.data().status !== 'published' || post.data().blog_id !== 'your-blog') return null;
      const saved = !favorite.exists;
      const count = Math.max(0, (Number(post.data().favorite_count)||0) + (saved ? 1 : -1));
      if (saved) tx.set(favoriteRef, {
        title:String(post.data().title || '').slice(0,300),
        excerpt:String(post.data().excerpt || '').slice(0,500),
        cover_url:String(post.data().cover_url || ''),
        added_at:new Date().toISOString()
      });
      else tx.delete(favoriteRef);
      tx.update(postRef, { favorite_count:count });
      return { saved, count };
    });
    if (!result) { res.status(404).json({ ok:false, message:'Artigo não encontrado.' }); return; }
    res.status(200).json({ ok:true, ...result });
  } catch (error) {
    console.error('[reader] request failed', error.code || error.message);
    res.status(500).json({ ok:false, message:'Não foi possível atualizar os favoritos.' });
  }
}

module.exports = { handler, validSlug };

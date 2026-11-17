'use strict';

const { getStorage } = require('firebase-admin/storage');

const PATH = /^https:\/\/blog\.example\.com\/media\/(blog-video\/[0-9a-f-]{36}\.mp4)$/i;
function objectName(url) { const match = PATH.exec(String(url || '')); return match ? match[1] : ''; }
async function read(url) {
  const name = objectName(url);
  if (!name) throw new Error('Envie um MP4 próprio pelo editor para publicar vídeo nativo.');
  const file = getStorage().bucket('your-firebase-project.firebasestorage.app').file(name);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  if (size < 16 || size > 20 * 1024 * 1024 || metadata.contentType !== 'video/mp4') throw new Error('Vídeo MP4 próprio inválido ou acima de 20 MB.');
  const [bytes] = await file.download();
  if (bytes.length !== size || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('O arquivo MP4 não passou na verificação.');
  return bytes;
}
module.exports = { objectName, read };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { upload } = require('./linkedin-video');
const ownVideo = require('./own-video');

test('LinkedIn uploads own MP4 parts, finalizes and waits for available media', async () => {
  const originalFetch = global.fetch, originalRead = ownVideo.read;
  const calls = [];
  ownVideo.read = async () => Buffer.from('0000ftyp' + 'x'.repeat(20));
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('initializeUpload')) return { ok:true, status:200, text:async () => JSON.stringify({ value:{ video:'urn:li:video:abc',
      uploadToken:'session', uploadInstructions:[{ uploadUrl:'https://www.linkedin.com/dms-uploads/abc', firstByte:0, lastByte:27 }] } }) };
    if (url.includes('dms-uploads')) return { ok:true, headers:{ get:() => '"etag-1"' } };
    if (url.includes('finalizeUpload')) return { ok:true };
    return { ok:true, json:async () => ({ status:'AVAILABLE' }) };
  };
  try {
    const result = await upload({ access_token:'token', member_urn:'urn:li:person:1' }, 'https://blog.example.com/media/blog-video/own.mp4', '202609');
    assert.equal(result.urn, 'urn:li:video:abc');
    assert.equal(calls.length, 4);
    assert.deepEqual(JSON.parse(calls[2].options.body).finalizeUploadRequest.uploadedPartIds, ['etag-1']);
    assert.equal(calls[0].options.headers['LinkedIn-Version'], '202609');
  } finally { global.fetch = originalFetch; ownVideo.read = originalRead; }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('./media-providers');
const { resolveShortVideoUrl } = require('./posts');

test('Reel, TikTok and YouTube Short URLs become trusted portrait players', () => {
  const instagram = media.embedVideo('https://www.instagram.com/reel/C12345AbcDE/?igsh=tracking');
  assert.equal(instagram.provider, 'instagram');
  assert.equal(instagram.src, 'https://www.instagram.com/reel/C12345AbcDE/embed/');
  assert.equal(instagram.portrait, true);
  const tiktok = media.embedVideo('https://www.tiktok.com/@scout2015/video/6718335390845095173');
  assert.equal(tiktok.src, 'https://www.tiktok.com/player/v1/6718335390845095173');
  assert.equal(tiktok.portrait, true);
  const youtube = media.embedVideo('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share');
  assert.equal(youtube.src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(youtube.portrait, true);
  assert.equal(media.embedVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ').portrait, false);
});

test('provider embed snippets are parsed, never copied as executable markup', () => {
  const instagram = media.embedVideo('<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/reel/C12345AbcDE/?utm_source=ig_embed"></blockquote><script src="https://www.instagram.com/embed.js"></script>');
  assert.equal(instagram.src, 'https://www.instagram.com/reel/C12345AbcDE/embed/');
  const tiktok = media.embedVideo('<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@scout2015/video/6718335390845095173"></blockquote><script src="https://www.tiktok.com/embed.js"></script>');
  assert.equal(tiktok.src, 'https://www.tiktok.com/player/v1/6718335390845095173');
  const shorts = media.embedVideo('<iframe width="315" height="560" src="https://www.youtube.com/embed/dQw4w9WgXcQ" onload="alert(1)"></iframe>');
  assert.equal(shorts.portrait, true);
  assert.equal(shorts.src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(media.embedVideo('<iframe src="https://evil.example/video"></iframe>'), null);
});

test('short TikTok links resolve only through TikTok hosts', async () => {
  const request = async () => ({ status: 302, headers: new Headers({ location: 'https://www.tiktok.com/@scout2015/video/6718335390845095173?share=1' }) });
  assert.equal(await resolveShortVideoUrl('https://vm.tiktok.com/ZM12345/', request),
    'https://www.tiktok.com/@scout2015/video/6718335390845095173');
  await assert.rejects(resolveShortVideoUrl('https://vm.tiktok.com/ZM12345/', async () => ({ status: 302, headers: new Headers({ location: 'https://evil.example/' }) })), /saiu do TikTok/);
  await assert.rejects(resolveShortVideoUrl('https://evil.example/', request), /link curto/);
});

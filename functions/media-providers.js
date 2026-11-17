(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LazyMedia = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parse(value) {
    try {
      var url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return url;
    } catch (_) { return null; }
  }
  function host(url) { return url.hostname.toLowerCase().replace(/^www\./, ''); }
  function youtubeId(url) {
    var h = host(url), id = '';
    if (h === 'youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(h))
      id = url.pathname === '/watch' ? url.searchParams.get('v') : ((/^\/(?:embed|shorts|live)\/([^/]+)/.exec(url.pathname) || [])[1]);
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  }
  function driveId(url) {
    if (host(url) !== 'drive.google.com') return null;
    var id = ((/^\/file\/d\/([\w-]+)/.exec(url.pathname) || [])[1]) || url.searchParams.get('id');
    return /^[\w-]{10,}$/.test(id || '') ? id : null;
  }
  function shortVideoUrl(value) {
    var url = parse(value);
    return !!(url && ((['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname.toLowerCase())
      && /^\/[A-Za-z0-9]+\/?$/.test(url.pathname))
      || (['www.tiktok.com', 'tiktok.com'].includes(url.hostname.toLowerCase())
      && /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname))));
  }
  function embeddedUrl(value) {
    var input = String(value || '').trim();
    if (!input.startsWith('<')) return input;
    // Provider snippets can contain scripts. Read only their URL attributes and
    // rebuild a trusted iframe below; never insert the supplied markup.
    var attributes = /\b(?:data-instgrm-permalink|cite|src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    var match;
    while ((match = attributes.exec(input))) {
      var candidate = (match[1] || match[2] || match[3] || '').replace(/&amp;/gi, '&').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, function (_, hex, dec) {
        return String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10));
      });
      if (parse(candidate) && (video(candidate) || shortVideoUrl(candidate))) return candidate;
    }
    return '';
  }
  function video(value) {
    var url = parse(value); if (!url) return null;
    if (host(url) === 'blog.example.com' && !url.search && !url.hash && /^\/media\/blog-video\/[0-9a-f-]{36}\.(?:mp4|webm)$/i.test(url.pathname))
      return { provider: 'file', src: url.href };
    var yt = youtubeId(url);
    if (yt) {
      var short = /^\/shorts\//.test(url.pathname);
      return { provider: 'youtube', src: 'https://www.youtube-nocookie.com/embed/' + yt,
        href: 'https://www.youtube.com/' + (short ? 'shorts/' + yt : 'watch?v=' + yt), portrait: short,
        thumbnail: 'https://i.ytimg.com/vi/' + yt + '/hqdefault.jpg' };
    }
    if (['instagram.com', 'm.instagram.com'].includes(host(url))) {
      var instagram = /^\/(reel|p)\/([A-Za-z0-9_-]{5,50})(?:\/(?:embed(?:\/captioned)?)?)?\/?$/.exec(url.pathname);
      if (instagram) return { provider: 'instagram', src: 'https://www.instagram.com/' + instagram[1] + '/' + instagram[2] + '/embed/',
        href: 'https://www.instagram.com/' + instagram[1] + '/' + instagram[2] + '/', portrait: true };
    }
    if (['tiktok.com', 'm.tiktok.com'].includes(host(url))) {
      var tiktok = /^(?:\/@[A-Za-z0-9._-]+\/video\/|\/player\/v1\/|\/embed\/v2\/)(\d{8,25})\/?$/.exec(url.pathname);
      if (tiktok) return { provider: 'tiktok', src: 'https://www.tiktok.com/player/v1/' + tiktok[1],
        href: url.pathname.includes('/@') ? 'https://www.tiktok.com' + url.pathname : 'https://www.tiktok.com/player/v1/' + tiktok[1], portrait: true };
    }
    var vm = /^\/(?:video\/)?(\d+)(?:\/([\w-]+))?\/?$/.exec(url.pathname);
    if (['vimeo.com', 'player.vimeo.com'].includes(host(url)) && vm)
      return { provider: 'vimeo', src: 'https://player.vimeo.com/video/' + vm[1] + (vm[2] || url.searchParams.get('h') ? '?h=' + encodeURIComponent(vm[2] || url.searchParams.get('h')) : '') };
    var gd = driveId(url);
    if (gd) return { provider: 'drive', src: 'https://drive.google.com/file/d/' + gd + '/preview' };
    return null;
  }
  function embedVideo(value) {
    var input = String(value || '').trim();
    var url = embeddedUrl(input);
    var media = video(url);
    if (media && media.provider === 'youtube' && input.startsWith('<')) {
      var width = /\bwidth\s*=\s*["']?(\d+)/i.exec(input);
      var height = /\bheight\s*=\s*["']?(\d+)/i.exec(input);
      if (width && height && Number(height[1]) > Number(width[1]) * 1.3) media.portrait = true;
    }
    return media;
  }
  function audio(value) {
    var url = parse(value); if (!url) return null;
    var h = host(url);
    var sp = /^\/(track|episode|show|playlist)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (h === 'open.spotify.com' && sp) return { provider: 'spotify', src: 'https://open.spotify.com/embed/' + sp[1] + '/' + sp[2], height: 232 };
    if (['soundcloud.com', 'm.soundcloud.com'].includes(h)) return { provider: 'soundcloud', src: 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url.href), height: 166 };
    var gd = driveId(url);
    if (gd) return { provider: 'drive', src: 'https://drive.google.com/file/d/' + gd + '/preview', height: 166 };
    var yt = video(value);
    if (yt && yt.provider === 'youtube') return { provider: 'youtube', src: yt.src, height: 260 };
    if (/\.(mp3|m4a|ogg|wav)(?:$|\?)/i.test(url.pathname)) return { provider: 'file', src: url.href };
    return null;
  }
  return { video: video, embedVideo: embedVideo, embeddedUrl: embeddedUrl, shortVideoUrl: shortVideoUrl, audio: audio };
});

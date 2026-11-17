/* Read only the editorial text with the browser's Web Speech API. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LazyArticleSpeech = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var excluded = 'figure,pre,code,script,style,button,iframe,video,audio,.article-cta-block,.article-video-carousel,.article-prompt-block,.article-diagram,.article-gallery';
  var speaker = null;
  var voiceChangeHandler = null;
  var voicePreferenceKey = 'lazy_article_speech_voice';
  function extract(body, post) {
    if (!body) return [];
    var clone = body.cloneNode(true);
    clone.querySelectorAll(excluded).forEach(function (node) { node.remove(); });
    var blocks = [];
    if (post && post.title) blocks.push(String(post.title));
    if (post && post.excerpt) blocks.push(String(post.excerpt));
    clone.querySelectorAll('h1,h2,h3,h4,p,li,blockquote').forEach(function (node) {
      if (node.closest('li,blockquote') !== node && node.parentElement.closest('li,blockquote')) return;
      var value = node.textContent.replace(/\s+/g, ' ').trim();
      if (value) blocks.push(value);
    });
    return blocks;
  }
  function split(text) {
    var sentences = String(text || '').match(/[^.!?]+(?:[.!?]+["'”’)]*)?|[^.!?]+$/g) || [];
    var chunks = [], current = '';
    function append(part) {
      if (!part) return;
      if (current && (current + ' ' + part).length > 360) { chunks.push(current); current = part; }
      else current += (current ? ' ' : '') + part;
    }
    sentences.forEach(function (sentence) {
      var words = sentence.trim().split(/\s+/), part = '';
      words.forEach(function (word) {
        if (part && (part + ' ' + word).length > 360) { append(part); part = word; }
        else part += (part ? ' ' : '') + word;
      });
      append(part);
    });
    if (current) chunks.push(current);
    return chunks;
  }
  function voiceKey(voice) { return voice.voiceURI + '|' + voice.lang; }
  function chooseVoice(voices, locale, saved) {
    if (saved === 'browser-default') return null;
    if (saved) {
      var chosen = voices.find(function (voice) { return voiceKey(voice) === saved; });
      if (chosen) return chosen;
    }
    var language = String(locale || 'pt-BR').toLowerCase();
    var matches = voices.filter(function (voice) { return voice.lang.toLowerCase().startsWith(language.slice(0, 2)); });
    matches.sort(function (a, b) {
      function score(voice) {
        var name = voice.name.toLowerCase();
        return (voice.lang.toLowerCase() === language ? 100 : 0)
          + (/online|natural|neural/.test(name) ? 50 : 0)
          + (/francisca|clara|maria|elza|helena|camila/.test(name) ? 5 : 0)
          + (voice.default ? 1 : 0);
      }
      return score(b) - score(a);
    });
    return matches[0] || null;
  }
  function mount(post) {
    var panel = document.getElementById('art-speech');
    var body = document.getElementById('art-body');
    if (!panel || !body) return;
    if (speaker) { speechSynthesis.cancel(); speaker = null; }
    if (post.tts_enabled === false || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { panel.hidden = true; return; }
    var text = extract(body, post);
    if (!text.length) { panel.hidden = true; return; }
    var chunks = text.flatMap(split);
    var locale = document.documentElement.lang || 'pt-BR';
    var current = 0, stopped = true, paused = false, generation = 0;
    panel.hidden = false;
    panel.innerHTML = '<div class="art-speech-info"><span class="art-speech-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path d="M16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12"/></svg></span><div><strong>Escute este artigo</strong><small>Leitura do texto pelo navegador</small></div></div><div class="art-speech-actions"><label class="art-speech-voice-label">Voz <select data-speech="voice" aria-label="Escolher voz"><option value="browser-default">Padrão do navegador</option></select></label><button type="button" data-speech="play" aria-label="Ouvir artigo">Ouvir</button><button type="button" data-speech="stop" aria-label="Parar leitura" disabled>Parar</button></div><span class="art-speech-status" role="status" aria-live="polite">Pronto para ouvir</span>';
    var play = panel.querySelector('[data-speech="play"]');
    var stop = panel.querySelector('[data-speech="stop"]');
    var voiceSelect = panel.querySelector('[data-speech="voice"]');
    var status = panel.querySelector('.art-speech-status');
    var preferred = '';
    try { preferred = localStorage.getItem(voicePreferenceKey) || ''; } catch (_) {}
    function populateVoices() {
      var voices = speechSynthesis.getVoices();
      var available = voices.filter(function (voice) { return voice.lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()); });
      voiceSelect.replaceChildren(new Option('Padrão do navegador', 'browser-default'));
      available.forEach(function (voice) { voiceSelect.add(new Option(voice.name + ' (' + voice.lang + ')', voiceKey(voice))); });
      var choice = chooseVoice(available, locale, preferred);
      voiceSelect.value = choice ? voiceKey(choice) : 'browser-default';
      if (choice && !preferred) voiceSelect.title = 'Voz em português escolhida automaticamente';
    }
    if (voiceChangeHandler) speechSynthesis.removeEventListener('voiceschanged', voiceChangeHandler);
    voiceChangeHandler = populateVoices;
    speechSynthesis.addEventListener('voiceschanged', voiceChangeHandler);
    populateVoices();
    function update(label) { status.textContent = label; play.textContent = stopped ? 'Ouvir' : paused ? 'Continuar' : 'Pausar'; stop.disabled = stopped; }
    function speakNext() {
      if (stopped || current >= chunks.length) { stopped = true; paused = false; update('Leitura concluída'); return; }
      var utterance = new SpeechSynthesisUtterance(chunks[current]);
      utterance.lang = locale;
      utterance.rate = 0.96;
      var voices = speechSynthesis.getVoices();
      var voice = voices.find(function (item) { return voiceKey(item) === voiceSelect.value; });
      if (voice) utterance.voice = voice;
      var run = generation;
      utterance.onend = function () { if (run === generation && !stopped) { current++; speakNext(); } };
      utterance.onerror = function () { if (run === generation && !stopped) { stopped = true; paused = false; update('A leitura foi interrompida. Tente novamente.'); } };
      speechSynthesis.speak(utterance);
      update('Lendo trecho ' + (current + 1) + ' de ' + chunks.length);
    }
    play.addEventListener('click', function () {
      if (stopped) { generation++; speechSynthesis.cancel(); current = 0; stopped = false; paused = false; speaker = panel; populateVoices(); speakNext(); }
      else if (paused) { speechSynthesis.resume(); paused = false; update('Leitura retomada'); }
      else { speechSynthesis.pause(); paused = true; update('Leitura pausada'); }
    });
    stop.addEventListener('click', function () { generation++; stopped = true; paused = false; speechSynthesis.cancel(); update('Leitura parada'); });
    voiceSelect.addEventListener('change', function () {
      preferred = voiceSelect.value;
      try { localStorage.setItem(voicePreferenceKey, preferred); } catch (_) {}
      if (!stopped) { generation++; speechSynthesis.cancel(); paused = false; speakNext(); }
    });
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', function () { if (speaker) speechSynthesis.cancel(); });
  return { extract: extract, split: split, chooseVoice: chooseVoice, mount: mount };
});

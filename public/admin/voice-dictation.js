/* Ditado do artigo: trechos independentes de dois minutos mantêm a gravação
   contínua para o autor e deixam cada envio pequeno para o Groq Whisper. */
(function () {
  'use strict';
  var SEGMENT_MS = 120000;
  var MAX_RECORD_MS = 20 * 60000;
  var voice = {
    phase: 'idle', stream: null, recorder: null, mime: '', parts: [],
    segments: [], next: 0, active: false, failed: null,
    startAt: 0, rotateTimer: null, maxTimer: null, clock: null,
    context: null, analyser: null, frame: null, range: null, insertionNode: null, hideTimer: null, captureError: false, interrupted: false,
    disabledBefore: {}
  };

  function node(id) { return document.getElementById(id); }
  function secondsLabel(seconds) {
    var n = Math.max(0, Math.floor(seconds));
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }
  function busy() { return voice.phase !== 'idle'; }
  window.articleVoiceBusy_ = busy;

  function render(message) {
    var mic = node('editor-mic-btn');
    var status = node('editor-voice-status');
    if (!mic || !status) return;
    var recording = voice.phase === 'recording';
    var waiting = voice.phase === 'starting' || voice.phase === 'processing';
    mic.classList.toggle('recording', recording);
    mic.classList.toggle('processing', waiting);
    mic.disabled = !recording && voice.phase !== 'idle';
    mic.setAttribute('aria-pressed', recording ? 'true' : 'false');
    mic.setAttribute('aria-label', recording ? 'Parar e transcrever o ditado' : 'Começar a ditar o artigo');
    mic.title = recording ? 'Parar gravação e concluir transcrição' : 'Ditar conteúdo do artigo';
    status.hidden = voice.phase === 'idle' && !message;
    status.classList.toggle('processing', !recording);
    if (message) node('editor-voice-message').textContent = message;
    node('editor-voice-retry').hidden = !voice.failed || voice.phase === 'recording';
    node('editor-voice-download').hidden = !voice.failed || voice.phase === 'recording';
    node('editor-voice-discard').hidden = !voice.failed || voice.phase === 'recording';
    ['ai-rewrite-btn', 'ai-proofread-btn', 'btn-publish', 'btn-draft', 'btn-schedule'].forEach(function (id) {
      var control = node(id);
      if (!control) return;
      if (busy()) {
        if (!Object.prototype.hasOwnProperty.call(voice.disabledBefore, id)) voice.disabledBefore[id] = control.disabled;
        control.disabled = true;
      } else if (Object.prototype.hasOwnProperty.call(voice.disabledBefore, id)) {
        control.disabled = voice.disabledBefore[id];
        delete voice.disabledBefore[id];
      }
    });
  }

  function rememberCaret() {
    // O mesmo botão chama esta função ao iniciar e ao parar. Não deslocar o
    // ponto de inserção durante uma sessão de ditado.
    if (voice.phase !== 'idle') return;
    var editor = node('editor-area');
    var selection = window.getSelection && window.getSelection();
    if (selection && selection.rangeCount && editor && editor.contains(selection.anchorNode)) {
      voice.range = selection.getRangeAt(0).cloneRange();
      voice.range.collapse(false);
    }
  }
  window.articleVoiceRememberCaret = rememberCaret;

  function insertTranscript(text) {
    if (!text) return;
    var editor = node('editor-area');
    if (!editor) return;
    var clean = String(text).trim();
    if (!clean) return;
    // Um único nó recebe os trechos em ordem. Reusar Range.insertNode para
    // cada trecho podia recolocá-los antes dos anteriores se o DOM mudasse.
    if (voice.insertionNode && editor.contains(voice.insertionNode)) {
      voice.insertionNode.data += clean + ' ';
    } else {
      var range = voice.range;
      if (!range || !editor.contains(range.startContainer)) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      voice.insertionNode = document.createTextNode(clean + ' ');
      range.insertNode(voice.insertionNode);
      range.setStartAfter(voice.insertionNode);
      range.collapse(true);
      voice.range = range;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof updateWordCount === 'function') updateWordCount();
  }

  function pickMime() {
    var choices = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return typeof MediaRecorder.isTypeSupported === 'function'
      ? (choices.find(function (type) { return MediaRecorder.isTypeSupported(type); }) || '') : '';
  }

  function startSpectrogram() {
    try {
      voice.context = new (window.AudioContext || window.webkitAudioContext)();
      var source = voice.context.createMediaStreamSource(voice.stream);
      voice.analyser = voice.context.createAnalyser();
      voice.analyser.fftSize = 256;
      source.connect(voice.analyser);
      var canvas = node('editor-voice-spectro');
      var ctx = canvas.getContext('2d');
      var values = new Uint8Array(voice.analyser.frequencyBinCount);
      function draw() {
        if (voice.phase !== 'recording' || !voice.analyser) return;
        voice.analyser.getByteFrequencyData(values);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < 48; i++) {
          var height = Math.max(2, values[i * 2] / 255 * canvas.height);
          ctx.fillStyle = i % 2 ? '#a855f7' : '#00f0ff';
          ctx.fillRect(i * canvas.width / 48, (canvas.height - height) / 2, 2, height);
        }
        voice.frame = requestAnimationFrame(draw);
      }
      draw();
    } catch (_) { /* O ditado funciona mesmo sem o visualizador. */ }
  }

  function stopMedia() {
    clearTimeout(voice.rotateTimer);
    clearTimeout(voice.maxTimer);
    clearInterval(voice.clock);
    if (voice.frame) cancelAnimationFrame(voice.frame);
    voice.frame = null;
    if (voice.context) {
      try { Promise.resolve(voice.context.close()).catch(function () {}); } catch (_) {}
      voice.context = null;
    }
    voice.analyser = null;
    if (voice.stream) voice.stream.getTracks().forEach(function (track) { track.stop(); });
    voice.stream = null;
  }

  function recordSegment() {
    if (voice.phase !== 'recording' || !voice.stream) return;
    voice.parts = [];
    var options = { audioBitsPerSecond: 32000 };
    if (voice.mime) options.mimeType = voice.mime;
    var recorder = new MediaRecorder(voice.stream, options);
    voice.mime = recorder.mimeType || voice.mime;
    voice.recorder = recorder;
    recorder.ondataavailable = function (event) {
      if (event.data && event.data.size) voice.parts.push(event.data);
    };
    recorder.onerror = function () {
      voice.captureError = true;
      if (voice.phase === 'recording') stop();
    };
    recorder.onstop = function () {
      clearTimeout(voice.rotateTimer);
      voice.recorder = null;
      var blob = new Blob(voice.parts, { type: voice.mime });
      voice.parts = [];
      if (blob.size) voice.segments.push({ blob: blob, index: voice.segments.length });
      if (voice.captureError) {
        voice.captureError = false;
        voice.interrupted = true;
        if (blob.size) {
          voice.failed = voice.segments[voice.segments.length - 1];
          render('A gravação foi interrompida. O último trecho foi preservado para baixar ou tentar novamente.');
        } else {
          voice.phase = 'processing';
          render('A gravação foi interrompida; transcrevendo os trechos recuperados.');
          showToast('A gravação foi interrompida. O áudio anterior continua no artigo.', 'error');
        }
      }
      if (voice.phase === 'recording') {
        try { recordSegment(); }
        catch (error) { voice.failed = { blob: blob, index: voice.segments.length - 1 }; stop(); showToast(error.message, 'error'); }
      } else {
        stopMedia();
      }
      processQueue();
    };
    recorder.start();
    voice.rotateTimer = setTimeout(function () {
      if (voice.phase === 'recording' && recorder.state === 'recording') recorder.stop();
    }, SEGMENT_MS);
  }

  function blobBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '').split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('Não foi possível ler o áudio gravado.')); };
      reader.readAsDataURL(blob);
    });
  }

  async function transcribeSegment(segment) {
    var base64 = await blobBase64(segment.blob);
    var response = await fetch('/api/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: base64, mimeType: voice.mime.split(';')[0], provider: 'groq', lang: 'pt' })
    });
    var raw = await response.text();
    var data;
    try { data = JSON.parse(raw); }
    catch (_) { throw new Error('A transcrição respondeu HTTP ' + response.status + ' sem JSON.'); }
    if (!response.ok || !data.ok) throw new Error(data.message || 'Falha HTTP ' + response.status);
    return String(data.transcript || '').trim();
  }

  async function processQueue() {
    if (voice.active || voice.failed) return;
    voice.active = true;
    try {
      while (voice.next < voice.segments.length && !voice.failed) {
        var segment = voice.segments[voice.next];
        render('Transcrevendo trecho ' + (voice.next + 1) + ' de ' + voice.segments.length + ' via Groq...');
        try {
          var transcript = await transcribeSegment(segment);
          insertTranscript(transcript);
          segment.blob = null;
          voice.next++;
        } catch (error) {
          voice.failed = segment;
          render('Falha no trecho ' + (voice.next + 1) + ': ' + (error.message || 'erro de rede') + '. O áudio foi preservado.');
          break;
        }
      }
    } finally {
      voice.active = false;
      if (voice.phase === 'processing' && !voice.recorder && !voice.failed && voice.next === voice.segments.length) finish();
    }
  }

  function finish() {
    var count = voice.next;
    var interrupted = voice.interrupted;
    voice.phase = 'idle';
    voice.segments = [];
    voice.next = 0;
    voice.failed = null;
    voice.captureError = false;
    voice.interrupted = false;
    voice.range = null;
    voice.insertionNode = null;
    render((interrupted ? 'Gravação interrompida; recuperados ' : 'Transcrição concluída: ') + count + ' trecho(s). Revise o texto antes de reescrever com IA.');
    showToast(interrupted ? 'A gravação foi interrompida. Revise o texto recuperado.' : 'Ditado inserido no artigo. Revise o texto e use Reescrever com IA quando quiser.', interrupted ? 'error' : 'success');
    clearTimeout(voice.hideTimer);
    voice.hideTimer = setTimeout(function () { if (voice.phase === 'idle') render(); }, 8000);
  }

  async function start() {
    if (voice.phase !== 'idle') return;
    if (typeof aiEditorBusy_ !== 'undefined' && aiEditorBusy_) {
      showToast('Aguarde a edição com IA terminar antes de gravar.', 'error'); return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('Este navegador não oferece gravação de áudio.', 'error'); return;
    }
    rememberCaret();
    clearTimeout(voice.hideTimer);
    voice.phase = 'starting';
    voice.segments = [];
    voice.next = 0;
    voice.failed = null;
    voice.captureError = false;
    voice.interrupted = false;
    voice.insertionNode = null;
    render('Aguardando permissão do microfone...');
    try {
      voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      voice.mime = pickMime();
      voice.phase = 'recording';
      voice.startAt = Date.now();
      node('editor-voice-timer').textContent = '00:00';
      recordSegment();
      startSpectrogram();
      voice.clock = setInterval(function () {
        node('editor-voice-timer').textContent = secondsLabel((Date.now() - voice.startAt) / 1000);
        if (!voice.failed && !voice.active) render('Gravando · ' + voice.next + ' trecho(s) transcrito(s). Clique para parar.');
      }, 1000);
      voice.maxTimer = setTimeout(function () { stop(); showToast('Gravação encerrada após 20 minutos. Aguarde a transcrição.', 'success'); }, MAX_RECORD_MS);
      render('Gravando · clique no microfone para parar.');
    } catch (error) {
      stopMedia();
      voice.phase = 'idle';
      render();
      showToast('Microfone: ' + (error.message || 'não foi possível iniciar'), 'error');
    }
  }

  function stop() {
    if (voice.phase !== 'recording') return;
    voice.phase = 'processing';
    render(voice.failed ? 'Áudio preservado. Tente novamente a transcrição do trecho.' : 'Finalizando áudio e transcrição. Mantenha esta aba aberta...');
    clearTimeout(voice.rotateTimer);
    if (voice.recorder) {
      if (voice.recorder.state !== 'inactive') voice.recorder.stop();
      // Se já estava terminando um trecho, onstop entregará o Blob final.
    } else { stopMedia(); if (!voice.failed && !voice.active) processQueue(); }
  }

  window.articleVoiceToggle = function () {
    if (voice.phase === 'idle') return start();
    if (voice.phase === 'recording') return stop();
  };
  window.articleVoiceRetry = function () {
    if (voice.phase !== 'processing' || !voice.failed) return;
    voice.failed = null;
    render('Tentando novamente o trecho ' + (voice.next + 1) + '...');
    processQueue();
  };
  window.articleVoiceDownload = function () {
    if (!voice.failed || !voice.failed.blob) return;
    var url = URL.createObjectURL(voice.failed.blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'lazy-labs-ditado-trecho-' + (voice.next + 1) + (voice.mime.includes('mp4') ? '.mp4' : voice.mime.includes('ogg') ? '.ogg' : '.webm');
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  };
  window.articleVoiceDiscard = function () {
    if (voice.phase !== 'processing' || !voice.failed || !confirm('Descartar o áudio ainda não transcrito? O texto já inserido no artigo permanece.')) return;
    voice.phase = 'idle';
    voice.failed = null;
    voice.segments = [];
    voice.next = 0;
    voice.range = null;
    voice.insertionNode = null;
    render('Trecho pendente descartado. O texto já transcrito permanece no artigo.');
  };
})();

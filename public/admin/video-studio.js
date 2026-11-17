/* Lazy Labs — estúdio de vídeo do editor. A captura fica ativa enquanto o autor escreve. */
(function () {
  'use strict';
  const LIMIT = 1024 * 1024 * 1024;
  const state = {
    panel: null, canvas: null, ctx: null, videos: {}, streams: {}, recorder: null,
    chunks: [], bytes: 0, blob: null, blobUrl: '', mime: '', uploadTask: null,
    pendingFinalization: null, posterDataUrl: '', raf: 0, tick: 0, started: 0, pausedAt: 0,
    pausedMs: 0, audio: null, destination: null, audioNodes: {}, dragging: false
  };
  const $ = id => document.getElementById('studio-' + id);
  const sourceLabels = { screen: 'Tela principal', screen2: 'Segunda tela', camera: 'Câmera', mic: 'Microfone' };

  function notice(message, type) {
    const el = $('message');
    el.textContent = message;
    el.dataset.type = type || 'info';
  }
  function active() { return state.recorder && state.recorder.state !== 'inactive'; }
  function bytes(size) { return size < 1024 * 1024 ? Math.round(size / 1024) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB'; }
  function fmt(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(seconds / 3600)).padStart(2, '0') + ':' + String(Math.floor(seconds % 3600 / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'); }
  function currentMs() { return (state.pausedAt || performance.now()) - state.started - state.pausedMs; }

  function createPanel() {
    if (state.panel) return state.panel;
    const panel = document.createElement('section');
    panel.id = 'studio-panel'; panel.className = 'studio-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Estúdio de vídeo do artigo');
    panel.innerHTML = `
      <header class="studio-header" id="studio-header">
        <span class="studio-mark" aria-hidden="true">◉</span><strong>ESTÚDIO DE VÍDEO</strong>
        <span class="studio-badge" id="studio-badge">PRONTO</span>
        <button type="button" id="studio-minimize" aria-label="Recolher estúdio" title="Recolher estúdio">−</button>
        <button type="button" id="studio-close" aria-label="Fechar estúdio" title="Fechar estúdio">×</button>
      </header>
      <div class="studio-content" id="studio-content">
        <div class="studio-preview"><canvas id="studio-canvas" width="1280" height="720" aria-label="Prévia da gravação"></canvas><span class="studio-time" id="studio-time">00:00:00</span></div>
        <p class="studio-message" id="studio-message" role="status" aria-live="polite">Escolha uma tela, uma câmera ou ambas. O navegador pedirá permissão para cada fonte.</p>
        <div class="studio-pending" id="studio-pending" hidden><span>Há um vídeo enviado aguardando validação.</span><button type="button" id="studio-resume-upload">Concluir envio</button><button type="button" id="studio-discard-pending">Descartar pendência</button></div>
        <div class="studio-source-row">
          <button type="button" id="studio-screen">▣ Escolher tela</button>
          <button type="button" id="studio-screen2">▣ Segunda tela</button>
          <button type="button" id="studio-camera">◉ Câmera</button>
          <button type="button" id="studio-mic">♩ Microfone</button>
        </div>
        <div class="studio-selects">
          <label>Câmera <select id="studio-camera-device"><option value="">Padrão</option></select></label>
          <label>Microfone <select id="studio-mic-device"><option value="">Padrão</option></select></label>
          <label>Composição <select id="studio-layout"><option value="screen">Tela com câmera</option><option value="split">Duas telas lado a lado</option><option value="camera">Câmera em destaque</option></select></label>
          <label>Posição da câmera <select id="studio-camera-position"><option value="right">Direita</option><option value="left">Esquerda</option></select></label>
        </div>
        <div class="studio-audio-row">
          <label><input type="checkbox" id="studio-use-mic" checked> Microfone</label>
          <label><input type="checkbox" id="studio-use-screen" checked> Áudio da tela</label>
          <label><input type="checkbox" id="studio-use-screen2" checked> Áudio da segunda tela</label>
          <label><input type="checkbox" id="studio-auto-cover" checked> Usar frame como capa se estiver vazia</label>
        </div>
        <div class="studio-actions">
          <button type="button" class="studio-primary" id="studio-record">● Gravar</button>
          <button type="button" id="studio-pause" disabled>Pausar</button>
          <button type="button" id="studio-stop" disabled>Finalizar</button>
        </div>
        <div class="studio-output" id="studio-output" hidden>
          <video id="studio-playback" controls playsinline preload="metadata"></video>
          <div class="studio-output-actions"><span id="studio-size"></span><a id="studio-download" download="lazy-labs-gravacao.webm">Baixar cópia</a><button type="button" id="studio-upload" class="studio-primary">Enviar e anexar ao artigo</button></div>
          <div class="studio-progress" id="studio-progress" hidden><div id="studio-progress-bar"></div></div>
          <button type="button" id="studio-cancel-upload" hidden>Cancelar envio</button>
        </div>
        <p class="studio-hint">Formato 16:9 · 720p · até 1 GB. Grave por 10–15 minutos e baixe uma cópia antes de sair da página. O áudio do sistema depende da opção selecionada no navegador. Vídeo de rede social continua exigindo MP4 próprio no campo separado.</p>
      </div>`;
    document.body.appendChild(panel);
    state.panel = panel; state.canvas = $('canvas'); state.ctx = state.canvas.getContext('2d', { alpha: false });
    $('screen').addEventListener('click', () => captureScreen('screen'));
    $('screen2').addEventListener('click', () => captureScreen('screen2'));
    $('camera').addEventListener('click', () => captureDevice('camera'));
    $('mic').addEventListener('click', () => captureDevice('mic'));
    $('camera-device').addEventListener('change', () => { if (state.streams.camera) { stopStream('camera'); captureDevice('camera'); } });
    $('mic-device').addEventListener('change', () => { if (state.streams.mic) { stopStream('mic'); captureDevice('mic'); } });
    ['use-mic', 'use-screen', 'use-screen2'].forEach(id => $(id).addEventListener('change', updateGains));
    $('record').addEventListener('click', startRecording);
    $('pause').addEventListener('click', pauseRecording);
    $('stop').addEventListener('click', stopRecording);
    $('upload').addEventListener('click', uploadRecording);
    $('cancel-upload').addEventListener('click', () => { if (state.uploadTask) state.uploadTask.cancel(); });
    $('resume-upload').addEventListener('click', finalizeUpload);
    $('discard-pending').addEventListener('click', () => {
      state.pendingFinalization = null; try { localStorage.removeItem('ll_studio_pending'); } catch (_) {}
      $('pending').hidden = true; refreshSources(); notice('Pendência removida. O arquivo temporário será limpo automaticamente.', 'warn');
    });
    $('minimize').addEventListener('click', () => { panel.classList.toggle('is-minimized'); $('minimize').textContent = panel.classList.contains('is-minimized') ? '+' : '−'; });
    $('close').addEventListener('click', () => { if (active() || state.uploadTask) { panel.classList.add('is-minimized'); $('minimize').textContent = '+'; return; } panel.hidden = true; stopSources(); });
    setupDrag(panel);
    try {
      const saved = JSON.parse(localStorage.getItem('ll_studio_pending') || 'null');
      if (saved && /^[0-9a-f-]{36}$/.test(saved.id) && ['mp4','webm'].includes(saved.ext)) {
        state.pendingFinalization = saved; $('pending').hidden = false;
      }
    } catch (_) {}
    refreshSources();
    draw();
    return panel;
  }

  function setupDrag(panel) {
    const header = $('header'); let startX = 0, startY = 0, left = 0, top = 0;
    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const box = panel.getBoundingClientRect(); startX = e.clientX; startY = e.clientY; left = box.left; top = box.top;
      state.dragging = true; header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', e => {
      if (!state.dragging) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, left + e.clientX - startX)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 45, top + e.clientY - startY)) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    header.addEventListener('pointerup', () => { state.dragging = false; });
    header.addEventListener('pointercancel', () => { state.dragging = false; });
  }

  function toggle() {
    const panel = createPanel();
    if (!panel.hidden && (active() || state.uploadTask)) {
      panel.classList.toggle('is-minimized'); $('minimize').textContent = panel.classList.contains('is-minimized') ? '+' : '−'; return;
    }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { panel.classList.remove('is-minimized'); $('minimize').textContent = '−'; }
    else stopSources();
  }
  function stopStream(kind) {
    const stream = state.streams[kind]; if (!stream) return;
    stream.getTracks().forEach(track => track.stop());
    delete state.streams[kind];
    if (state.videos[kind]) { state.videos[kind].srcObject = null; delete state.videos[kind]; }
    if (state.audioNodes[kind]) { state.audioNodes[kind].source.disconnect(); state.audioNodes[kind].gain.disconnect(); delete state.audioNodes[kind]; }
    refreshSources();
  }
  function stopSources() { Object.keys(state.streams).forEach(stopStream); }
  function refreshSources() {
    Object.keys(sourceLabels).forEach(kind => {
      const button = $(kind); if (!button) return;
      button.classList.toggle('is-active', !!state.streams[kind]);
      button.textContent = state.streams[kind] ? '✓ ' + sourceLabels[kind] : (kind === 'camera' ? '◉ Câmera' : kind === 'mic' ? '♩ Microfone' : '▣ ' + (kind === 'screen2' ? 'Segunda tela' : 'Escolher tela'));
      button.title = state.streams[kind] ? 'Clique para desligar esta fonte' : '';
    });
    $('record').disabled = !!state.pendingFinalization || active() || (!state.streams.screen && !state.streams.screen2 && !state.streams.camera);
  }
  function attachVideo(kind, stream) {
    const video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true;
    video.srcObject = stream; video.play().catch(() => {}); state.videos[kind] = video;
  }
  function attachStream(kind, stream) {
    stopStream(kind);
    state.streams[kind] = stream;
    if (kind !== 'mic') attachVideo(kind, stream);
    stream.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (state.streams[kind] !== stream) return;
      stopStream(kind);
      if (active() && !state.streams.screen && !state.streams.screen2 && !state.streams.camera) stopRecording();
      notice(sourceLabels[kind] + ' foi desconectado.', 'warn');
    }, { once: true }));
    if (state.audio) attachAudio(kind, stream);
    refreshSources();
    notice(sourceLabels[kind] + ' conectada. Configure a composição e grave quando estiver pronto.', 'ok');
  }
  async function captureScreen(kind) {
    if (state.streams[kind]) { stopStream(kind); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { notice('Seu navegador não permite captura de tela nesta página.', 'error'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 }, audio: { echoCancellation: false, noiseSuppression: false }, systemAudio: 'include'
      });
      attachStream(kind, stream);
      if (!stream.getAudioTracks().length) notice('Tela conectada sem áudio do sistema. Se quiser som, escolha compartilhar áudio na janela do navegador.', 'warn');
    } catch (error) { if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') notice('Não foi possível capturar a tela: ' + error.message, 'error'); }
  }
  async function captureDevice(kind) {
    if (state.streams[kind]) { stopStream(kind); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { notice('Câmera e microfone não estão disponíveis neste navegador.', 'error'); return; }
    try {
      const chosen = $(kind + '-device').value;
      const options = kind === 'camera' ? { video: chosen ? { deviceId: { exact: chosen }, width: { ideal: 1280 }, height: { ideal: 720 } } : true, audio: false }
        : { video: false, audio: chosen ? { deviceId: { exact: chosen }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true } };
      const stream = await navigator.mediaDevices.getUserMedia(options);
      attachStream(kind, stream);
      await enumerateDevices();
    } catch (error) { notice('Não foi possível acessar ' + sourceLabels[kind].toLowerCase() + ': ' + error.message, 'error'); }
  }
  async function enumerateDevices() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    [['camera', 'videoinput'], ['mic', 'audioinput']].forEach(([kind, type]) => {
      const select = $(kind + '-device'), chosen = select.value;
      select.replaceChildren(new Option('Padrão', ''));
      devices.filter(device => device.kind === type).forEach((device, i) => select.add(new Option(device.label || sourceLabels[kind] + ' ' + (i + 1), device.deviceId)));
      select.value = chosen && [...select.options].some(option => option.value === chosen) ? chosen : '';
    });
  }

  function drawFitted(video, x, y, width, height, fill) {
    if (!video || video.readyState < 2 || !video.videoWidth) return false;
    const ratio = fill ? Math.max(width / video.videoWidth, height / video.videoHeight) : Math.min(width / video.videoWidth, height / video.videoHeight);
    const w = video.videoWidth * ratio, h = video.videoHeight * ratio;
    state.ctx.drawImage(video, x + (width - w) / 2, y + (height - h) / 2, w, h); return true;
  }
  function draw() {
    const { ctx, canvas } = state;
    if (ctx) {
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = '#070713'; ctx.fillRect(0, 0, w, h);
      const main = state.videos.screen || state.videos.screen2 || state.videos.camera;
      const layout = $('layout').value;
      let rendered = false;
      if (layout === 'camera' && state.videos.camera) rendered = drawFitted(state.videos.camera, 0, 0, w, h, true);
      else if (layout === 'split' && state.videos.screen && state.videos.screen2) {
        rendered = drawFitted(state.videos.screen, 0, 0, w / 2 - 4, h, false);
        drawFitted(state.videos.screen2, w / 2 + 4, 0, w / 2 - 4, h, false);
        ctx.fillStyle = '#00f0ff'; ctx.fillRect(w / 2 - 2, 0, 4, h);
      } else rendered = drawFitted(main, 0, 0, w, h, false);
      if (!rendered) {
        ctx.fillStyle = '#45456b'; ctx.textAlign = 'center'; ctx.font = '24px sans-serif';
        ctx.fillText('Escolha a tela ou a câmera para ver a prévia', w / 2, h / 2);
      }
      if (state.videos.camera && !(layout === 'camera' || main === state.videos.camera)) {
        const cw = 320, ch = 180, x = $('camera-position').value === 'left' ? 28 : w - cw - 28, y = h - ch - 28;
        ctx.save(); ctx.shadowColor = '#000'; ctx.shadowBlur = 24; ctx.fillStyle = '#000'; ctx.fillRect(x - 4, y - 4, cw + 8, ch + 8); ctx.restore();
        ctx.save(); ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, cw, ch, 12); else ctx.rect(x, y, cw, ch);
        ctx.clip(); drawFitted(state.videos.camera, x, y, cw, ch, true); ctx.restore();
        ctx.strokeStyle = '#00f0ff'; ctx.lineWidth = 3; ctx.strokeRect(x, y, cw, ch);
      }
    }
    if (Object.keys(state.streams).length || active()) state.raf = requestAnimationFrame(draw);
    else state.raf = setTimeout(draw, 250);
  }

  function attachAudio(kind, stream) {
    if (!state.audio || !stream.getAudioTracks().length) return;
    if (state.audioNodes[kind]) { state.audioNodes[kind].source.disconnect(); state.audioNodes[kind].gain.disconnect(); }
    const source = state.audio.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const gain = state.audio.createGain(); source.connect(gain); gain.connect(state.destination);
    state.audioNodes[kind] = { source, gain }; updateGains();
  }
  function updateGains() {
    Object.keys(state.audioNodes).forEach(kind => {
      const node = state.audioNodes[kind]; node.gain.gain.value = $('use-' + kind).checked ? 1 : 0;
    });
  }
  function supportedMime() {
    return ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || '';
  }
  function startRecording() {
    if (active()) return;
    if (state.pendingFinalization) { notice('Conclua a validação do vídeo enviado antes de gravar outro.', 'warn'); return; }
    if (!state.streams.screen && !state.streams.screen2 && !state.streams.camera) { notice('Conecte uma tela ou câmera primeiro.', 'error'); return; }
    if (!window.MediaRecorder || !state.canvas.captureStream) { notice('Este navegador não suporta gravação de vídeo por aqui.', 'error'); return; }
    const mime = supportedMime(); if (!mime) { notice('Nenhum formato de vídeo compatível neste navegador.', 'error'); return; }
    try {
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = ''; state.blob = null; state.chunks = []; state.bytes = 0; state.mime = mime; state.posterDataUrl = '';
      $('output').hidden = true; $('progress').hidden = true; $('progress-bar').style.width = '0%';
      $('upload').disabled = false; $('upload').textContent = 'Enviar e anexar ao artigo';
      const AudioEngine = window.AudioContext || window.webkitAudioContext;
      if (AudioEngine) {
        state.audio = new AudioEngine(); state.audio.resume().catch(() => {});
        state.destination = state.audio.createMediaStreamDestination();
        Object.keys(state.streams).forEach(kind => attachAudio(kind, state.streams[kind]));
      }
      const picture = state.canvas.captureStream(30);
      const combined = new MediaStream([...picture.getVideoTracks(), ...(state.destination ? state.destination.stream.getAudioTracks() : [])]);
      const recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
      state.recorder = recorder; state.started = performance.now(); state.pausedMs = 0; state.pausedAt = 0;
      recorder.ondataavailable = event => {
        if (event.data && event.data.size) { state.chunks.push(event.data); state.bytes += event.data.size; }
        if (state.bytes > LIMIT - 15 * 1024 * 1024 && active()) { notice('Limite de 1 GB próximo. Finalizando gravação.', 'warn'); stopRecording(); }
      };
      recorder.onerror = event => { notice('Falha na gravação: ' + ((event.error && event.error.message) || 'erro do navegador'), 'error'); stopRecording(); };
      recorder.onstop = finishRecording;
      recorder.start(1000);
      $('record').disabled = true; $('pause').disabled = false; $('stop').disabled = false;
      $('badge').textContent = '● GRAVANDO'; $('badge').classList.add('is-recording');
      notice('Gravando. Você pode recolher o estúdio e continuar escrevendo.', 'ok');
      clearInterval(state.tick); state.tick = setInterval(() => { $('time').textContent = fmt(currentMs()); }, 250);
    } catch (error) { notice('Não foi possível começar a gravação: ' + error.message, 'error'); cleanupAudio(); }
  }
  function pauseRecording() {
    const recorder = state.recorder; if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause(); state.pausedAt = performance.now(); $('pause').textContent = 'Continuar'; $('badge').textContent = 'PAUSADO';
      notice('Gravação pausada. As fontes continuam ativas.', 'warn');
    } else if (recorder.state === 'paused') {
      state.pausedMs += performance.now() - state.pausedAt; state.pausedAt = 0;
      recorder.resume(); $('pause').textContent = 'Pausar'; $('badge').textContent = '● GRAVANDO';
      notice('Gravação retomada.', 'ok');
    }
  }
  function stopRecording() {
    if (!active()) return;
    try { state.posterDataUrl = state.canvas.toDataURL('image/jpeg', 0.78); } catch (_) { state.posterDataUrl = ''; }
    $('stop').disabled = true; $('pause').disabled = true;
    try { state.recorder.stop(); } catch (error) { notice('Não foi possível finalizar: ' + error.message, 'error'); }
  }
  function cleanupAudio() {
    Object.values(state.audioNodes).forEach(node => { node.source.disconnect(); node.gain.disconnect(); });
    state.audioNodes = {}; if (state.audio) state.audio.close().catch(() => {});
    state.audio = null; state.destination = null;
  }
  function finishRecording() {
    clearInterval(state.tick); $('time').textContent = fmt(currentMs());
    if (!state.posterDataUrl) { try { state.posterDataUrl = state.canvas.toDataURL('image/jpeg', 0.78); } catch (_) {} }
    state.blob = new Blob(state.chunks, { type: state.mime }); state.chunks = [];
    state.blobUrl = URL.createObjectURL(state.blob);
    $('playback').src = state.blobUrl;
    const ext = state.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    $('download').href = state.blobUrl; $('download').download = 'lazy-labs-gravacao-' + Date.now() + '.' + ext;
    $('size').textContent = bytes(state.blob.size);
    $('output').hidden = false; $('record').disabled = false; $('pause').textContent = 'Pausar';
    $('badge').textContent = 'GRAVADO'; $('badge').classList.remove('is-recording');
    cleanupAudio(); stopSources(); refreshSources();
    notice('Vídeo pronto. Confira a prévia, baixe uma cópia e envie para anexar ao artigo.', 'ok');
  }

  async function finalizeUpload() {
    const pending = state.pendingFinalization; if (!pending) return;
    notice('Validando vídeo no servidor...', 'info'); $('upload').disabled = true;
    try {
      const result = await fbFetch_('/api/posts/finalizeStudioVideo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending)
      });
      if (!result || !result.ok) throw new Error((result && result.message) || 'Falha ao validar o vídeo.');
      state.pendingFinalization = null;
      try { localStorage.removeItem('ll_studio_pending'); } catch (_) {}
      $('pending').hidden = true; refreshSources();
      const field = document.getElementById('f-video'); field.value = result.url;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      $('upload').textContent = '✓ Anexado ao artigo';
      notice('Vídeo anexado ao artigo. Salve ou publique para concluir.', 'ok');
      const cover = document.getElementById('f-cover');
      if (cover && !cover.value.trim() && $('auto-cover').checked && state.posterDataUrl) {
        try {
          notice('Vídeo anexado. Enviando frame para a capa do artigo...', 'info');
          const image = await fbFetch_('/api/posts/uploadImage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: state.posterDataUrl.split(',')[1] })
          });
          if (!image || !image.ok) throw new Error((image && image.message) || 'Falha ao gerar capa.');
          if (!cover.value.trim()) { cover.value = image.url; cover.dispatchEvent(new Event('input', { bubbles: true })); }
          notice('Vídeo e capa anexados ao artigo. Salve ou publique para concluir.', 'ok');
        } catch (error) { notice('Vídeo anexado. A capa automática falhou: ' + error.message, 'warn'); }
      }
      if (typeof showToast === 'function') showToast('Vídeo anexado ao artigo.', 'success');
    } catch (error) {
      $('upload').disabled = false; $('upload').textContent = 'Tentar validar novamente';
      if (/Envio não encontrado|Vídeo inválido|Formato do vídeo/.test(error.message)) {
        state.pendingFinalization = null; try { localStorage.removeItem('ll_studio_pending'); } catch (_) {}
        $('pending').hidden = true; refreshSources();
      }
      notice(error.message, 'error');
    }
  }
  async function uploadRecording() {
    if (state.pendingFinalization) { await finalizeUpload(); return; }
    if (!state.blob || state.uploadTask) return;
    if (state.blob.size > LIMIT) { notice('Vídeo maior que 1 GB. Grave em partes menores.', 'error'); return; }
    if (!window.firebase || !firebase.storage) { notice('Módulo de armazenamento indisponível. Recarregue a página.', 'error'); return; }
    $('upload').disabled = true;
    try {
      const user = await ensureFbUser_(); await user.getIdToken(true);
      const id = crypto.randomUUID();
      const ext = state.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const type = 'video/' + ext;
      const ref = firebase.storage().ref('studio-uploads/' + user.uid + '/' + id + '.' + ext);
      $('progress').hidden = false; $('cancel-upload').hidden = false; $('upload').textContent = 'Enviando...';
      notice('Enviando vídeo em partes. Mantenha esta aba aberta.', 'info');
      const task = ref.put(state.blob, { contentType: type, customMetadata: { studioOwner: user.uid } }); state.uploadTask = task;
      await new Promise((resolve, reject) => task.on('state_changed', snapshot => {
        const pct = Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100);
        $('progress-bar').style.width = pct + '%'; $('upload').textContent = 'Enviando ' + pct + '%';
      }, reject, resolve));
      state.uploadTask = null; $('cancel-upload').hidden = true;
      state.pendingFinalization = { id, ext };
      try { localStorage.setItem('ll_studio_pending', JSON.stringify(state.pendingFinalization)); } catch (_) {}
      $('pending').hidden = false;
      await finalizeUpload();
    } catch (error) {
      state.uploadTask = null; $('cancel-upload').hidden = true; $('upload').disabled = false;
      $('upload').textContent = 'Tentar enviar novamente';
      notice(error.code === 'storage/canceled' ? 'Envio cancelado. O vídeo segue disponível para baixar e tentar de novo.' : 'Falha no envio: ' + error.message, 'error');
    }
  }

  window.addEventListener('beforeunload', event => {
    if (!active() && !state.uploadTask) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.LazyStudio = { toggle };
})();

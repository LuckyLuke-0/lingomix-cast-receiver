(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  const audio = document.getElementById('companion-audio');
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');

  playerManager.setMediaElement(video);

  const HARD_SYNC_DRIFT_SECONDS = 0.35;
  const SOFT_SYNC_DRIFT_SECONDS = 0.12;
  const SYNC_INTERVAL_MS = 500;

  let cues = [];
  let subtitleGeneration = 0;
  let useCompanionAudio = false;
  let syncTimer = null;
  let activeCastMethod = 'DIRECT_SOURCE';

  function showStatus(message) {
    document.body.classList.remove('playing');
    status.textContent = message;
    status.style.display = 'block';
  }

  function hideStatus() {
    document.body.classList.add('playing');
    status.style.display = 'none';
  }

  function clearSubtitles() {
    subtitleGeneration += 1;
    cues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
  }

  function parseTime(value) {
    const parts = String(value || '').trim().replace(',', '.').split(':').map(Number);
    if (parts.some(Number.isNaN)) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function decodeEntities(text) {
    return text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  function parseWebVtt(text) {
    const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
    const result = [];
    for (const block of normalized.split(/\n\n+/)) {
      const lines = block.split('\n').map(line => line.trimEnd());
      if (!lines.length || /^WEBVTT/.test(lines[0]) || /^NOTE(?:\s|$)/.test(lines[0])) continue;
      const timeIndex = lines.findIndex(line => line.includes('-->'));
      if (timeIndex < 0) continue;
      const timing = lines[timeIndex].split('-->');
      if (timing.length !== 2) continue;
      const start = parseTime(timing[0]);
      const end = parseTime(timing[1].trim().split(/\s+/)[0]);
      const cueText = decodeEntities(
        lines.slice(timeIndex + 1).join('\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
      ).trim();
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && cueText) {
        result.push({ start, end, text: cueText });
      }
    }
    return result.sort((a, b) => a.start - b.start);
  }

  function toRgba(hex, alpha) {
    const raw = String(hex || '#000000').replace('#', '');
    const value = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw.padEnd(6, '0').slice(0, 6);
    const number = Number.parseInt(value, 16);
    if (!Number.isFinite(number)) return `rgba(0,0,0,${alpha})`;
    return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
  }

  function applySubtitleStyle(style = {}) {
    const root = document.documentElement.style;
    const fontKey = String(style.fontFamily || 'sans_serif').toLowerCase();
    const fonts = {
      sans_serif: 'Arial, Helvetica, sans-serif',
      arial: 'Arial, Helvetica, sans-serif',
      verdana: 'Verdana, Geneva, sans-serif',
      condensed: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif',
      serif: 'Georgia, "Times New Roman", serif',
      serif_monospace: '"Courier New", Courier, monospace',
      monospace: '"Roboto Mono", "Courier New", monospace',
      casual: '"Comic Sans MS", "Trebuchet MS", cursive',
      cursive: 'cursive'
    };
    const size = Math.max(40, Math.min(80, Number(style.textSizePercent) || 60));
    const bottom = Math.max(0, Math.min(30, Number(style.bottomMarginPercent) || 4));
    const opacity = Math.max(0, Math.min(1, Number(style.backgroundOpacity) || 0));
    const outline = style.blackOutline === true;

    root.setProperty('--subtitle-size', String(size));
    root.setProperty('--subtitle-bottom', `${bottom}%`);
    root.setProperty('--subtitle-color', String(style.textColor || '#FFFFFF'));
    root.setProperty('--subtitle-font', fonts[fontKey] || fonts.sans_serif);
    root.setProperty('--subtitle-weight', style.isBold === false ? '400' : '700');
    root.setProperty('--subtitle-background', opacity > 0 ? toRgba(style.backgroundColor || '#000000', opacity) : 'transparent');
    root.setProperty('--subtitle-padding-x', opacity > 0 ? '0.38em' : '0');
    root.setProperty('--subtitle-padding-y', opacity > 0 ? '0.12em' : '0');
    root.setProperty('--subtitle-shadow', outline
      ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 2px rgba(0,0,0,.85)'
      : 'none');
  }

  async function loadSubtitles(url, style) {
    clearSubtitles();
    applySubtitleStyle(style || {});
    if (!url) return;
    const generation = subtitleGeneration;
    try {
      const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseWebVtt(await response.text());
      if (generation !== subtitleGeneration) return;
      cues = parsed;
    } catch (error) {
      console.error('Trevuxa subtitle loading failed', error);
    }
  }

  function renderSubtitle() {
    if (!cues.length || !Number.isFinite(video.currentTime)) {
      subtitle.style.display = 'none';
      subtitle.textContent = '';
      return;
    }
    const now = video.currentTime;
    const active = cues.filter(cue => now >= cue.start && now < cue.end);
    subtitle.textContent = active.map(cue => cue.text).join('\n');
    subtitle.style.display = active.length ? 'block' : 'none';
  }

  function stopSyncTimer() {
    if (syncTimer !== null) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function resetCompanionAudio() {
    stopSyncTimer();
    useCompanionAudio = false;
    try { audio.pause(); } catch (_) {}
    audio.removeAttribute('src');
    audio.load();
    video.muted = false;
  }

  function safeSetAudioTime(target) {
    if (!useCompanionAudio || !Number.isFinite(target) || audio.readyState < 1) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    const clamped = Math.max(0, Math.min(target, duration));
    try { audio.currentTime = clamped; } catch (error) { console.warn('Trevuxa audio seek failed', error); }
  }

  function synchronizeAudio(force = false) {
    if (!useCompanionAudio || audio.readyState < 1 || video.readyState < 1) return;
    const drift = audio.currentTime - video.currentTime;
    if (force || Math.abs(drift) > HARD_SYNC_DRIFT_SECONDS) {
      safeSetAudioTime(video.currentTime);
      audio.playbackRate = video.playbackRate || 1;
      return;
    }
    if (Math.abs(drift) > SOFT_SYNC_DRIFT_SECONDS) {
      const correction = drift > 0 ? -0.02 : 0.02;
      audio.playbackRate = Math.max(0.5, Math.min(2, (video.playbackRate || 1) + correction));
    } else {
      audio.playbackRate = video.playbackRate || 1;
    }
  }

  function startSyncTimer() {
    stopSyncTimer();
    syncTimer = setInterval(() => synchronizeAudio(false), SYNC_INTERVAL_MS);
  }

  async function playCompanionAudio() {
    if (!useCompanionAudio) return;
    synchronizeAudio(true);
    try {
      await audio.play();
      startSyncTimer();
    } catch (error) {
      console.error('Trevuxa companion audio playback failed', error);
      showStatus('Trevuxa: gekozen audio kon niet worden gestart');
    }
  }

  function configureCompanionAudio(nextAudioUrl, videoUrl) {
    resetCompanionAudio();
    const chosen = String(nextAudioUrl || '').trim();
    const picture = String(videoUrl || '').trim();
    if (!chosen || chosen === picture) return;

    useCompanionAudio = true;
    video.muted = true;
    audio.preload = 'auto';
    audio.src = chosen;
    audio.load();
  }

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    const media = request && request.media ? request.media : {};
    const custom = media.customData || {};
    activeCastMethod = String(custom.castMethod || 'DIRECT_SOURCE');
    media.contentType = 'video/mp4';

    if (custom.videoUrl) {
      media.contentId = custom.videoUrl;
      media.contentUrl = custom.videoUrl;
    }

    loadSubtitles(custom.subtitleUrl || '', custom.subtitleStyle || {});
    configureCompanionAudio(custom.audioUrl || '', custom.videoUrl || media.contentUrl || media.contentId || '');
    showStatus(useCompanionAudio
      ? 'Trevuxa: beeld en gekozen audio laden…'
      : 'Trevuxa: video laden…');
    return request;
  });

  video.addEventListener('loadedmetadata', () => {
    if (useCompanionAudio) synchronizeAudio(true);
  });
  video.addEventListener('timeupdate', renderSubtitle);
  video.addEventListener('seeking', () => {
    renderSubtitle();
    if (useCompanionAudio) {
      audio.pause();
      synchronizeAudio(true);
    }
  });
  video.addEventListener('seeked', () => {
    renderSubtitle();
    if (useCompanionAudio) {
      synchronizeAudio(true);
      if (!video.paused && !video.ended) playCompanionAudio();
    }
  });
  video.addEventListener('playing', () => {
    hideStatus();
    renderSubtitle();
    if (useCompanionAudio) playCompanionAudio();
  });
  video.addEventListener('play', () => {
    if (useCompanionAudio) playCompanionAudio();
  });
  video.addEventListener('pause', () => {
    stopSyncTimer();
    if (useCompanionAudio) audio.pause();
  });
  video.addEventListener('ratechange', () => {
    if (useCompanionAudio) audio.playbackRate = video.playbackRate || 1;
  });
  video.addEventListener('ended', () => {
    stopSyncTimer();
    if (useCompanionAudio) audio.pause();
  });
  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 'onbekend';
    const message = video.error && video.error.message ? ` – ${video.error.message}` : '';
    showStatus(`Trevuxa: videofout ${code}${message} [${activeCastMethod}]`);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (!useCompanionAudio) return;
    synchronizeAudio(true);
    if (!video.paused && !video.ended) playCompanionAudio();
  });
  audio.addEventListener('error', () => {
    if (!useCompanionAudio) return;
    const code = audio.error ? audio.error.code : 'onbekend';
    const message = audio.error && audio.error.message ? ` – ${audio.error.message}` : '';
    showStatus(`Trevuxa: audiofout ${code}${message}`);
  });

  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, () => {
    resetCompanionAudio();
    clearSubtitles();
  });

  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
})();

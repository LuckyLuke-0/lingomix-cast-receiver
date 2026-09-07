(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');

  playerManager.setMediaElement(video);

  let cues = [];
  let subtitleGeneration = 0;

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
    root.setProperty('--subtitle-weight', '700');
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

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    const media = request && request.media ? request.media : {};
    const custom = media.customData || {};
    media.contentType = 'video/mp4';
    loadSubtitles(custom.subtitleUrl || '', custom.subtitleStyle || {});
    showStatus('Trevuxa: video laden…');
    return request;
  });

  video.addEventListener('playing', hideStatus);
  video.addEventListener('timeupdate', renderSubtitle);
  video.addEventListener('seeking', renderSubtitle);
  video.addEventListener('seeked', renderSubtitle);
  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 'onbekend';
    showStatus(`Trevuxa: video kon niet worden afgespeeld (fout ${code})`);
  });

  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, clearSubtitles);

  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
})();

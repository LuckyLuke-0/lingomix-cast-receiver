(function () {
  'use strict';

  var core = typeof TrevuxaReceiverCore !== 'undefined' ? TrevuxaReceiverCore : null;
  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();
  var video = document.getElementById('media');
  var audio = document.getElementById('companion-audio');
  var subtitle = document.getElementById('subtitle');
  var status = document.getElementById('status');
  var SYNC_INTERVAL_MS = 500;
  var AUDIO_END_TOLERANCE_SECONDS = 1.5;
  var AUDIO_BUFFER_TIMEOUT_MS = 15000;

  var cues = [];
  var subtitleGeneration = 0;
  var subtitleRequest = null;
  var useCompanionAudio = false;
  var companionGeneration = 0;
  var playAttemptToken = 0;
  var companionPlayPending = false;
  var syncTimer = null;
  var companionBufferTimer = null;
  var companionBuffering = false;
  var companionBufferReady = false;
  var resumeVideoAfterCompanionBuffer = false;
  var internalBufferPausePending = false;
  var videoResumeToken = 0;
  var videoIsPlaying = false;
  var activeRoute = null;
  var activeCastMethod = 'DIRECT_SOURCE';
  var activeAppLanguageCode = 'nl';

  if (!core || !video || !audio || !subtitle || !status) {
    throw new Error('Trevuxa receiver kon niet initialiseren: vereiste receiver-onderdelen ontbreken.');
  }

  playerManager.setMediaElement(video);

  function uiText(dutch, english) {
    return activeAppLanguageCode === 'en' ? english : dutch;
  }

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
    var request = subtitleRequest;
    subtitleGeneration += 1;
    subtitleRequest = null;
    if (request) {
      try {
        request.abort();
      } catch (error) {
        console.warn('Trevuxa kon de vorige ondertitelaanvraag niet annuleren', error);
      }
    }
    cues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
  }

  function applySubtitleStyle(styleValue) {
    var style = core.normalizeSubtitleStyle(styleValue);
    var root = document.documentElement.style;
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth || 1280;
    var fontSizePixels = Math.max(22, Math.min(90, style.size * 0.00055 * viewportWidth));
    root.setProperty('--subtitle-size', String(style.size));
    root.setProperty('--subtitle-bottom', String(style.bottom) + '%');
    root.setProperty('--subtitle-color', style.textColor);
    root.setProperty('--subtitle-font', style.fontFamily);
    root.setProperty('--subtitle-weight', String(style.weight));
    root.setProperty('--subtitle-spacing', style.letterSpacing);
    root.setProperty('--subtitle-background', style.background);
    root.setProperty('--subtitle-padding-x', style.hasBackground ? '0.38em' : '0');
    root.setProperty('--subtitle-padding-y', style.hasBackground ? '0.12em' : '0');
    root.setProperty('--subtitle-shadow', style.blackOutline
      ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 2px rgba(0,0,0,.85)'
      : 'none');

    // First-generation Chromecast firmware predates reliable CSS custom-property support.
    // Mirror every dynamic value to an ordinary inline declaration so subtitles remain visible
    // and styled even when all var(...) declarations are ignored by the browser.
    subtitle.style.bottom = String(style.bottom) + '%';
    subtitle.style.color = style.textColor;
    subtitle.style.fontFamily = style.fontFamily;
    subtitle.style.fontSize = String(fontSizePixels) + 'px';
    subtitle.style.fontWeight = String(style.weight);
    subtitle.style.letterSpacing = style.letterSpacing;
    subtitle.style.background = style.background;
    subtitle.style.padding = style.hasBackground ? '0.12em 0.38em' : '0';
    subtitle.style.textShadow = style.blackOutline
      ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 2px rgba(0,0,0,.85)'
      : 'none';
  }

  function loadSubtitles(url, style) {
    var generation;
    var request;
    var finished = false;

    clearSubtitles();
    applySubtitleStyle(style);
    if (!url) {
      return;
    }

    generation = subtitleGeneration;
    request = new XMLHttpRequest();
    subtitleRequest = request;

    function finishWithError(message) {
      if (finished) {
        return;
      }
      finished = true;
      if (subtitleRequest === request) {
        subtitleRequest = null;
      }
      if (generation === subtitleGeneration) {
        console.error('Trevuxa subtitle loading failed: ' + message);
      }
    }

    request.onreadystatechange = function () {
      if (request.readyState !== 4 || finished) {
        return;
      }
      finished = true;
      if (subtitleRequest === request) {
        subtitleRequest = null;
      }
      if (generation !== subtitleGeneration) {
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        console.error('Trevuxa subtitle loading failed: HTTP ' + request.status);
        return;
      }
      cues = core.parseWebVtt(request.responseText);
      renderSubtitle();
      console.log('Trevuxa: ' + cues.length + ' ondertitelcues geladen');
    };
    request.onerror = function () {
      finishWithError('netwerk- of CORS-fout');
    };
    request.ontimeout = function () {
      finishWithError('time-out');
    };
    try {
      request.open('GET', url, true);
      request.timeout = 15000;
      request.send();
    } catch (error) {
      finishWithError(error && error.message ? error.message : 'onbekende fout');
    }
  }

  function renderSubtitle() {
    var text = core.activeCueText(cues, video.currentTime);
    if (!text) {
      if (subtitle.textContent) {
        subtitle.textContent = '';
      }
      subtitle.style.display = 'none';
      return;
    }
    if (subtitle.textContent !== text) {
      subtitle.textContent = text;
    }
    subtitle.style.display = 'table';
  }

  function stopSyncTimer() {
    if (syncTimer !== null) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function stopCompanionBufferTimer() {
    if (companionBufferTimer !== null) {
      clearTimeout(companionBufferTimer);
      companionBufferTimer = null;
    }
  }

  function clearCompanionBuffering() {
    stopCompanionBufferTimer();
    videoResumeToken += 1;
    companionBuffering = false;
    companionBufferReady = false;
    resumeVideoAfterCompanionBuffer = false;
    internalBufferPausePending = false;
  }

  function pauseCompanionAudio() {
    playAttemptToken += 1;
    companionPlayPending = false;
    stopSyncTimer();
    try {
      audio.pause();
    } catch (error) {
      console.warn('Trevuxa kon gekozen audio niet pauzeren', error);
    }
  }

  function resetCompanionAudio() {
    companionGeneration += 1;
    clearCompanionBuffering();
    pauseCompanionAudio();
    useCompanionAudio = false;
    audio.removeAttribute('src');
    audio.preload = 'none';
    try {
      audio.load();
    } catch (error) {
      console.warn('Trevuxa kon gekozen audio niet vrijgeven', error);
    }
    video.muted = false;
  }

  function safeSetAudioTime(target) {
    var clamped;
    if (!useCompanionAudio || audio.readyState < 1) {
      return;
    }
    clamped = core.clampMediaTime(target, audio.duration);
    try {
      audio.currentTime = clamped;
    } catch (error) {
      console.warn('Trevuxa audio seek failed', error);
    }
  }

  function synchronizeAudio(force) {
    var decision = core.decideAudioSync({
      enabled: useCompanionAudio,
      force: force === true,
      videoReadyState: video.readyState,
      audioReadyState: audio.readyState,
      videoTime: video.currentTime,
      audioTime: audio.currentTime,
      videoPlaybackRate: video.playbackRate
    });

    if (decision.action === 'wait') {
      return;
    }
    if (decision.action === 'seek') {
      safeSetAudioTime(decision.targetTime);
    }
    try {
      audio.playbackRate = decision.playbackRate;
    } catch (error) {
      console.warn('Trevuxa kon de audiosnelheid niet synchroniseren', error);
    }
  }

  function startSyncTimer() {
    stopSyncTimer();
    if (useCompanionAudio && videoIsPlaying) {
      syncTimer = setInterval(function () {
        synchronizeAudio(false);
      }, SYNC_INTERVAL_MS);
    }
  }

  function requestVideoPause() {
    try {
      playerManager.pause();
      return true;
    } catch (pauseError) {
      try {
        video.pause();
        return true;
      } catch (fallbackError) {
        console.warn('Trevuxa kon video niet pauzeren', fallbackError);
        return false;
      }
    }
  }

  function requestVideoPlay() {
    var playResult;
    var resumeToken = videoResumeToken + 1;
    videoResumeToken = resumeToken;

    function failed(error) {
      if (resumeToken !== videoResumeToken) {
        return;
      }
      pauseVideoAfterAudioFailure('Trevuxa kon video na audiobuffering niet hervatten', error);
    }

    try {
      playResult = playerManager.play();
    } catch (playError) {
      try {
        playResult = video.play();
      } catch (fallbackError) {
        failed(fallbackError);
        return;
      }
    }
    if (playResult && typeof playResult.then === 'function') {
      playResult.then(null, failed);
    }
  }

  function pauseVideoAfterAudioFailure(message, error) {
    clearCompanionBuffering();
    videoIsPlaying = false;
    pauseCompanionAudio();
    if (error) {
      console.error(message, error);
    } else {
      console.error(message);
    }
    requestVideoPause();
    showStatus(uiText(
      'Trevuxa: gekozen audio kon niet worden afgespeeld',
      'Trevuxa: selected audio could not be played'
    ));
  }

  function tryResumeAfterCompanionBuffering() {
    var shouldResume;
    if (!companionBuffering || !companionBufferReady || internalBufferPausePending) {
      return;
    }
    shouldResume = resumeVideoAfterCompanionBuffer && useCompanionAudio && !video.ended;
    clearCompanionBuffering();
    if (!shouldResume) {
      return;
    }
    synchronizeAudio(true);
    requestVideoPlay();
  }

  function pauseVideoForCompanionBuffering() {
    var sourceGeneration;
    if (!useCompanionAudio || !videoIsPlaying || companionBuffering) {
      return;
    }

    companionBuffering = true;
    companionBufferReady = false;
    resumeVideoAfterCompanionBuffer = true;
    internalBufferPausePending = true;
    sourceGeneration = companionGeneration;
    videoIsPlaying = false;
    pauseCompanionAudio();
    showStatus(uiText(
      'Trevuxa: gekozen audio buffert…',
      'Trevuxa: buffering selected audio…'
    ));
    companionBufferTimer = setTimeout(function () {
      companionBufferTimer = null;
      if (sourceGeneration === companionGeneration && companionBuffering && useCompanionAudio) {
        pauseVideoAfterAudioFailure('Trevuxa companion audio buffering timed out');
      }
    }, AUDIO_BUFFER_TIMEOUT_MS);
    if (!requestVideoPause()) {
      pauseVideoAfterAudioFailure('Trevuxa kon video tijdens audiobuffering niet pauzeren');
    }
  }

  function keepVideoPausedWhileCompanionBuffers() {
    if (!useCompanionAudio || !companionBuffering) {
      return false;
    }
    resumeVideoAfterCompanionBuffer = true;
    internalBufferPausePending = true;
    videoIsPlaying = false;
    pauseCompanionAudio();
    showStatus(uiText(
      'Trevuxa: gekozen audio buffert…',
      'Trevuxa: buffering selected audio…'
    ));
    if (!requestVideoPause()) {
      pauseVideoAfterAudioFailure('Trevuxa kon video tijdens audiobuffering niet pauzeren');
    }
    return true;
  }

  function markCompanionBufferReady() {
    if (!useCompanionAudio || !companionBuffering) {
      return;
    }
    companionBufferReady = true;
    tryResumeAfterCompanionBuffering();
  }

  function playCompanionAudio() {
    var sourceGeneration;
    var attemptToken;
    var playResult;

    if (!useCompanionAudio || !videoIsPlaying || companionPlayPending) {
      return;
    }
    synchronizeAudio(true);
    sourceGeneration = companionGeneration;
    attemptToken = playAttemptToken + 1;
    playAttemptToken = attemptToken;
    companionPlayPending = true;

    function completed() {
      if (sourceGeneration !== companionGeneration || attemptToken !== playAttemptToken) {
        return;
      }
      companionPlayPending = false;
      if (!useCompanionAudio || !videoIsPlaying) {
        pauseCompanionAudio();
        return;
      }
      synchronizeAudio(true);
      startSyncTimer();
    }

    function failed(error) {
      if (sourceGeneration !== companionGeneration || attemptToken !== playAttemptToken) {
        return;
      }
      companionPlayPending = false;
      if (!videoIsPlaying) {
        return;
      }
      pauseVideoAfterAudioFailure('Trevuxa companion audio playback failed', error);
    }

    try {
      playResult = audio.play();
      if (playResult && typeof playResult.then === 'function') {
        playResult.then(completed, failed);
      } else {
        completed();
      }
    } catch (error) {
      failed(error);
    }
  }

  function configureCompanionAudio(route) {
    resetCompanionAudio();
    if (!route.useCompanionAudio) {
      return;
    }

    useCompanionAudio = true;
    companionGeneration += 1;
    video.muted = true;
    audio.preload = 'auto';
    audio.src = route.audioUrl;
    try {
      audio.load();
    } catch (error) {
      pauseVideoAfterAudioFailure('Trevuxa kon de gekozen audiobron niet laden', error);
    }
  }

  function resetPlaybackState(showReadyStatus) {
    activeRoute = null;
    activeCastMethod = 'DIRECT_SOURCE';
    videoIsPlaying = false;
    resetCompanionAudio();
    clearSubtitles();
    if (showReadyStatus) {
      showStatus(uiText('Trevuxa: klaar om te casten', 'Trevuxa: ready to cast'));
    }
  }

  function applyLoadRequest(request) {
    var route = core.resolveLoadRoute(request);
    var media = route.media;

    videoIsPlaying = false;
    activeAppLanguageCode = route.appLanguageCode;
    document.documentElement.lang = activeAppLanguageCode;
    if (!route.hasMedia || !route.videoUrl) {
      resetPlaybackState(false);
      showStatus(uiText('Trevuxa: ongeldige video-opdracht', 'Trevuxa: invalid video request'));
      return null;
    }

    activeRoute = route;
    activeCastMethod = route.castMethod;
    media.contentType = 'video/mp4';
    media.contentUrl = route.videoUrl;
    if (route.customVideoUrl || !media.contentId) {
      media.contentId = route.videoUrl;
    }

    loadSubtitles(route.subtitleUrl, route.subtitleStyle);
    configureCompanionAudio(route);
    showStatus(route.useCompanionAudio
      ? uiText('Trevuxa: beeld en gekozen audio laden…', 'Trevuxa: loading video and selected audio…')
      : uiText('Trevuxa: video laden…', 'Trevuxa: loading video…'));
    return route;
  }

  function createInvalidLoadError() {
    var errorTypes = cast.framework.messages.ErrorType;
    var errorReasons = cast.framework.messages.ErrorReason;
    var error = new cast.framework.messages.ErrorData(
      errorTypes.LOAD_FAILED || errorTypes.LOAD_CANCELLED
    );
    error.reason = errorReasons.INVALID_PARAMS ||
      errorReasons.INVALID_PARAM ||
      errorReasons.INVALID_REQUEST;
    return error;
  }

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      return applyLoadRequest(request) ? request : createInvalidLoadError();
    }
  );

  function registerOptionalInterceptor(messageTypeName, interceptor) {
    var messageType = cast.framework.messages.MessageType[messageTypeName];
    if (messageType) {
      playerManager.setMessageInterceptor(messageType, interceptor);
    }
  }

  registerOptionalInterceptor('STOP', function (request) {
    resetPlaybackState(true);
    return request;
  });

  registerOptionalInterceptor('PAUSE', function (request) {
    clearCompanionBuffering();
    videoIsPlaying = false;
    pauseCompanionAudio();
    return request;
  });

  registerOptionalInterceptor('SESSION_STATE', function (response) {
    var sessionState = response && response.sessionState
      ? response.sessionState
      : response;
    if (activeRoute) {
      core.addRouteToSessionState(sessionState, activeRoute);
    }
    return response;
  });

  registerOptionalInterceptor('RESUME_SESSION', function (request) {
    var sessionState = request && request.sessionState;
    var loadRequest = sessionState && sessionState.loadRequestData;
    if (loadRequest) {
      applyLoadRequest(loadRequest);
    }
    return request;
  });

  video.addEventListener('loadstart', function () {
    videoIsPlaying = false;
    clearCompanionBuffering();
    pauseCompanionAudio();
  });
  video.addEventListener('loadedmetadata', function () {
    if (useCompanionAudio) {
      synchronizeAudio(true);
    }
  });
  video.addEventListener('timeupdate', renderSubtitle);
  video.addEventListener('seeking', function () {
    videoIsPlaying = false;
    renderSubtitle();
    if (useCompanionAudio) {
      clearCompanionBuffering();
      pauseCompanionAudio();
      synchronizeAudio(true);
    }
  });
  video.addEventListener('seeked', function () {
    renderSubtitle();
    if (useCompanionAudio) {
      synchronizeAudio(true);
      if (!video.paused && !video.ended && video.readyState >= 3) {
        videoIsPlaying = true;
        playCompanionAudio();
      }
    }
  });
  video.addEventListener('waiting', function () {
    videoIsPlaying = false;
    clearCompanionBuffering();
    pauseCompanionAudio();
  });
  video.addEventListener('playing', function () {
    if (keepVideoPausedWhileCompanionBuffers()) {
      return;
    }
    videoIsPlaying = true;
    hideStatus();
    renderSubtitle();
    playCompanionAudio();
  });
  video.addEventListener('pause', function () {
    videoIsPlaying = false;
    pauseCompanionAudio();
    if (companionBuffering && internalBufferPausePending) {
      internalBufferPausePending = false;
      tryResumeAfterCompanionBuffering();
      return;
    }
    clearCompanionBuffering();
  });
  video.addEventListener('ratechange', function () {
    if (useCompanionAudio) {
      synchronizeAudio(false);
    }
  });
  video.addEventListener('ended', function () {
    videoIsPlaying = false;
    clearCompanionBuffering();
    pauseCompanionAudio();
    renderSubtitle();
  });
  video.addEventListener('error', function () {
    var code = video.error ? video.error.code : 'onbekend';
    var message = video.error && video.error.message ? ' – ' + video.error.message : '';
    videoIsPlaying = false;
    clearCompanionBuffering();
    pauseCompanionAudio();
    showStatus(uiText('Trevuxa: videofout ', 'Trevuxa: video error ') +
      code + message + ' [' + activeCastMethod + ']');
  });

  audio.addEventListener('loadedmetadata', function () {
    if (!useCompanionAudio) {
      return;
    }
    synchronizeAudio(true);
    if (videoIsPlaying) {
      playCompanionAudio();
    }
  });
  audio.addEventListener('playing', function () {
    if (useCompanionAudio && videoIsPlaying) {
      synchronizeAudio(true);
      startSyncTimer();
    }
  });
  audio.addEventListener('waiting', function () {
    pauseVideoForCompanionBuffering();
  });
  audio.addEventListener('canplay', markCompanionBufferReady);
  audio.addEventListener('canplaythrough', markCompanionBufferReady);
  audio.addEventListener('ended', function () {
    var videoSecondsLeft = video.duration - video.currentTime;
    stopSyncTimer();
    if (useCompanionAudio && companionBuffering) {
      pauseVideoAfterAudioFailure('Trevuxa companion audio ended while buffering');
      return;
    }
    if (useCompanionAudio && videoIsPlaying &&
        (!isFinite(videoSecondsLeft) || videoSecondsLeft > AUDIO_END_TOLERANCE_SECONDS)) {
      pauseVideoAfterAudioFailure('Trevuxa companion audio ended before video');
    }
  });
  audio.addEventListener('error', function () {
    var code;
    var message;
    if (!useCompanionAudio) {
      return;
    }
    code = audio.error ? audio.error.code : 'onbekend';
    message = audio.error && audio.error.message ? ' – ' + audio.error.message : '';
    pauseVideoAfterAudioFailure('Trevuxa audiofout ' + code + message);
  });

  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, function () {
    resetPlaybackState(false);
  });

  var options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
}());

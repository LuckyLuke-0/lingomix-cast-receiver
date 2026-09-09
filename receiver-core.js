(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TrevuxaReceiverCore = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HARD_SYNC_DRIFT_SECONDS = 0.35;
  var SOFT_SYNC_DRIFT_SECONDS = 0.12;
  var SESSION_DATA_KEY = 'trevuxaReceiver';

  var FONT_MAP = {
    sans_serif: 'Arial, Helvetica, sans-serif',
    arial: 'Arial, Helvetica, sans-serif',
    verdana: 'Verdana, Geneva, sans-serif',
    condensed: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    serif_monospace: '"Courier New", Courier, monospace',
    monospace: '"Roboto Mono", "Courier New", monospace',
    casual: '"Comic Sans MS", "Trebuchet MS", cursive',
    cursive: 'cursive',
    light: 'Arial, Helvetica, sans-serif',
    medium: 'Arial, Helvetica, sans-serif',
    heavy: 'Arial, Helvetica, sans-serif'
  };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function trimmedString(value) {
    return typeof value === 'string' ? value.replace(/^\s+|\s+$/g, '') : '';
  }

  function boundedNumber(value, minimum, maximum, fallback) {
    var number = Number(value);
    if (!isFiniteNumber(number)) {
      number = fallback;
    }
    return Math.max(minimum, Math.min(maximum, number));
  }

  function parseVttTimestamp(value) {
    var normalized = trimmedString(String(value == null ? '' : value)).replace(',', '.');
    var parts = normalized.split(':');
    var hours = 0;
    var minutes;
    var seconds;

    if (parts.length !== 2 && parts.length !== 3) {
      return NaN;
    }
    if (parts.length === 3) {
      if (!/^\d+$/.test(parts[0])) {
        return NaN;
      }
      hours = Number(parts[0]);
      parts.shift();
    }
    if (!/^\d+$/.test(parts[0]) || !/^\d+(?:\.\d+)?$/.test(parts[1])) {
      return NaN;
    }

    minutes = Number(parts[0]);
    seconds = Number(parts[1]);
    if (!isFiniteNumber(hours) || !isFiniteNumber(minutes) || !isFiniteNumber(seconds)) {
      return NaN;
    }
    if (seconds >= 60 || (hours > 0 && minutes >= 60)) {
      return NaN;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }

  function characterFromCodePoint(codePoint) {
    var adjusted;
    if (!isFiniteNumber(codePoint) || codePoint <= 0 || codePoint > 0x10FFFF ||
        (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
      return null;
    }
    if (codePoint <= 0xFFFF) {
      return String.fromCharCode(codePoint);
    }
    adjusted = codePoint - 0x10000;
    return String.fromCharCode(0xD800 + (adjusted >> 10), 0xDC00 + (adjusted & 0x3FF));
  }

  function decodeEntities(text) {
    var named = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"',
      lrm: '\u200E',
      rlm: '\u200F'
    };

    return String(text == null ? '' : text).replace(
      /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot|lrm|rlm);/gi,
      function (match, entity) {
        var lower = entity.toLowerCase();
        var codePoint;
        var decoded;
        if (lower.charAt(0) !== '#') {
          return named[lower];
        }
        codePoint = lower.charAt(1) === 'x'
          ? parseInt(lower.slice(2), 16)
          : parseInt(lower.slice(1), 10);
        decoded = characterFromCodePoint(codePoint);
        return decoded === null ? match : decoded;
      }
    );
  }

  function cleanCueText(lines) {
    return decodeEntities(lines.join('\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''))
      .replace(/^\s+|\s+$/g, '');
  }

  function isMetadataBlock(firstLine) {
    return /^WEBVTT(?:\s|$)/.test(firstLine) ||
      /^NOTE(?:\s|$)/.test(firstLine) ||
      /^STYLE(?:\s|$)/.test(firstLine) ||
      /^REGION(?:\s|$)/.test(firstLine);
  }

  function parseWebVtt(text) {
    var normalized = String(text == null ? '' : text)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
    var blocks = normalized.split(/\n[\t ]*\n(?:[\t ]*\n)*/);
    var cues = [];
    var blockIndex;

    for (blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      var lines = blocks[blockIndex].split('\n');
      var timeIndex = -1;
      var lineIndex;
      var arrowIndex;
      var timingLine;
      var start;
      var endToken;
      var end;
      var cueText;

      for (lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        lines[lineIndex] = lines[lineIndex].replace(/[\t ]+$/g, '');
      }
      while (lines.length && !trimmedString(lines[0])) {
        lines.shift();
      }
      if (!lines.length || isMetadataBlock(trimmedString(lines[0]))) {
        continue;
      }
      for (lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (lines[lineIndex].indexOf('-->') >= 0) {
          timeIndex = lineIndex;
          break;
        }
      }
      if (timeIndex < 0) {
        continue;
      }

      timingLine = lines[timeIndex];
      arrowIndex = timingLine.indexOf('-->');
      if (timingLine.indexOf('-->', arrowIndex + 3) >= 0) {
        continue;
      }
      start = parseVttTimestamp(timingLine.slice(0, arrowIndex));
      endToken = trimmedString(timingLine.slice(arrowIndex + 3)).split(/\s+/)[0];
      end = parseVttTimestamp(endToken);
      cueText = cleanCueText(lines.slice(timeIndex + 1));

      if (isFiniteNumber(start) && isFiniteNumber(end) && end > start && cueText) {
        cues.push({ start: start, end: end, text: cueText });
      }
    }

    cues.sort(function (left, right) {
      return left.start - right.start;
    });
    return cues;
  }

  function activeCueText(cues, currentTime) {
    var active = [];
    var index;
    if (!Array.isArray(cues) || !isFiniteNumber(currentTime)) {
      return '';
    }
    for (index = 0; index < cues.length; index += 1) {
      if (currentTime >= cues[index].start && currentTime < cues[index].end) {
        active.push(cues[index].text);
      }
    }
    return active.join('\n');
  }

  function copyKnownCustomData(target, source) {
    var keys = [
      'videoUrl',
      'audioUrl',
      'subtitleUrl',
      'subtitleStyle',
      'castMethod',
      'singlePipeline',
      'preparedMedia',
      'trevuxaSignature',
      'appLanguageCode'
    ];
    var index;
    if (!isObject(source)) {
      return target;
    }
    for (index = 0; index < keys.length; index += 1) {
      if (Object.prototype.hasOwnProperty.call(source, keys[index])) {
        target[keys[index]] = source[keys[index]];
      }
    }
    return target;
  }

  function collectCustomData(request, media) {
    var custom = {};
    var requestCustom = isObject(request.customData) ? request.customData : {};
    var persisted = isObject(requestCustom[SESSION_DATA_KEY])
      ? requestCustom[SESSION_DATA_KEY]
      : {};
    copyKnownCustomData(custom, persisted);
    copyKnownCustomData(custom, requestCustom);
    copyKnownCustomData(custom, isObject(media.customData) ? media.customData : {});
    return custom;
  }

  function recognizedCastMethod(value) {
    return value === 'AUTOMATIC' ||
      value === 'DIRECT_SOURCE' ||
      value === 'RECEIVER_SEPARATE_TRACKS' ||
      value === 'PHONE_REMUX';
  }

  function resolveLoadRoute(requestValue) {
    var request = isObject(requestValue) ? requestValue : {};
    var media = isObject(request.media) ? request.media : null;
    var custom = collectCustomData(request, media || {});
    var customVideoUrl = trimmedString(custom.videoUrl);
    var videoUrl = customVideoUrl || trimmedString(media && media.contentUrl) ||
      trimmedString(media && media.contentId);
    var audioUrl = trimmedString(custom.audioUrl);
    var subtitleUrl = trimmedString(custom.subtitleUrl);
    var rawMethod = trimmedString(custom.castMethod).toUpperCase();
    var distinctAudio = Boolean(videoUrl && audioUrl && audioUrl !== videoUrl);
    var useCompanionAudio = false;
    var castMethod;

    if (rawMethod === 'RECEIVER_SEPARATE_TRACKS') {
      useCompanionAudio = distinctAudio && custom.singlePipeline !== true && custom.preparedMedia !== true;
    } else if (rawMethod === 'AUTOMATIC') {
      useCompanionAudio = distinctAudio && custom.singlePipeline !== true && custom.preparedMedia !== true;
    } else if (!rawMethod) {
      // Backwards compatibility for the last known working LingoMix sender, which had no mode field.
      useCompanionAudio = distinctAudio && custom.singlePipeline !== true && custom.preparedMedia !== true;
    }

    if (recognizedCastMethod(rawMethod)) {
      castMethod = rawMethod;
    } else if (!rawMethod) {
      castMethod = useCompanionAudio ? 'RECEIVER_SEPARATE_TRACKS' : 'DIRECT_SOURCE';
    } else {
      castMethod = 'DIRECT_SOURCE';
    }

    return {
      hasMedia: media !== null,
      media: media,
      customData: custom,
      customVideoUrl: customVideoUrl,
      videoUrl: videoUrl,
      audioUrl: audioUrl,
      subtitleUrl: subtitleUrl,
      subtitleStyle: isObject(custom.subtitleStyle) ? custom.subtitleStyle : {},
      castMethod: castMethod,
      trevuxaSignature: trimmedString(custom.trevuxaSignature),
      appLanguageCode: trimmedString(custom.appLanguageCode).toLowerCase() === 'en' ? 'en' : 'nl',
      useCompanionAudio: useCompanionAudio,
      singlePipeline: !useCompanionAudio,
      preparedMedia: custom.preparedMedia === true
    };
  }

  function persistedRouteData(route) {
    if (!isObject(route)) {
      return null;
    }
    return {
      videoUrl: trimmedString(route.videoUrl),
      audioUrl: route.useCompanionAudio ? trimmedString(route.audioUrl) : '',
      subtitleUrl: trimmedString(route.subtitleUrl),
      subtitleStyle: isObject(route.subtitleStyle) ? route.subtitleStyle : {},
      castMethod: trimmedString(route.castMethod) || 'DIRECT_SOURCE',
      singlePipeline: route.useCompanionAudio !== true,
      preparedMedia: route.preparedMedia === true,
      trevuxaSignature: trimmedString(route.trevuxaSignature),
      appLanguageCode: route.appLanguageCode === 'en' ? 'en' : 'nl'
    };
  }

  function addRouteToSessionState(sessionStateValue, route) {
    var sessionState = sessionStateValue;
    var loadRequest;
    var customData;
    var persisted = persistedRouteData(route);
    var key;
    if (!isObject(sessionState) || !persisted || !isObject(sessionState.loadRequestData)) {
      return sessionStateValue;
    }
    loadRequest = sessionState.loadRequestData;
    customData = {};
    if (isObject(loadRequest.customData)) {
      for (key in loadRequest.customData) {
        if (Object.prototype.hasOwnProperty.call(loadRequest.customData, key)) {
          customData[key] = loadRequest.customData[key];
        }
      }
    }
    customData[SESSION_DATA_KEY] = persisted;
    loadRequest.customData = customData;
    return sessionState;
  }

  function clampMediaTime(target, duration) {
    var safeTarget = isFiniteNumber(target) ? Math.max(0, target) : 0;
    if (isFiniteNumber(duration) && duration > 0) {
      return Math.min(safeTarget, duration);
    }
    return safeTarget;
  }

  function normalizePlaybackRate(value) {
    if (!isFiniteNumber(value)) {
      return 1;
    }
    return Math.max(0.5, Math.min(2, value));
  }

  function decideAudioSync(optionsValue) {
    var options = isObject(optionsValue) ? optionsValue : {};
    var videoTime = options.videoTime;
    var audioTime = options.audioTime;
    var baseRate = normalizePlaybackRate(options.videoPlaybackRate);
    var drift;
    var correction;

    if (options.enabled !== true || Number(options.videoReadyState) < 1 ||
        Number(options.audioReadyState) < 1 || !isFiniteNumber(videoTime)) {
      return { action: 'wait', playbackRate: baseRate };
    }
    if (!isFiniteNumber(audioTime)) {
      return { action: 'seek', targetTime: Math.max(0, videoTime), playbackRate: baseRate };
    }

    drift = audioTime - videoTime;
    if (options.force === true || Math.abs(drift) > HARD_SYNC_DRIFT_SECONDS) {
      return { action: 'seek', targetTime: Math.max(0, videoTime), playbackRate: baseRate };
    }
    if (Math.abs(drift) > SOFT_SYNC_DRIFT_SECONDS) {
      correction = drift > 0 ? -0.02 : 0.02;
      return {
        action: 'rate',
        playbackRate: normalizePlaybackRate(baseRate + correction),
        drift: drift
      };
    }
    return { action: 'steady', playbackRate: baseRate, drift: drift };
  }

  function normalizeHexColor(value, fallback) {
    var color = trimmedString(value);
    return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : fallback;
  }

  function toRgba(hex, alpha) {
    var raw = normalizeHexColor(hex, '#000000').slice(1);
    var number;
    if (raw.length === 3) {
      raw = raw.charAt(0) + raw.charAt(0) + raw.charAt(1) + raw.charAt(1) +
        raw.charAt(2) + raw.charAt(2);
    }
    number = parseInt(raw, 16);
    return 'rgba(' + ((number >> 16) & 255) + ',' + ((number >> 8) & 255) + ',' +
      (number & 255) + ',' + alpha + ')';
  }

  function normalizeSubtitleStyle(styleValue) {
    var style = isObject(styleValue) ? styleValue : {};
    var fontKey = trimmedString(style.fontFamily || 'sans_serif').toLowerCase();
    var opacity = boundedNumber(style.backgroundOpacity, 0, 1, 0);
    var weight;
    if (!Object.prototype.hasOwnProperty.call(FONT_MAP, fontKey)) {
      fontKey = 'sans_serif';
    }
    if (fontKey === 'light') {
      weight = 300;
    } else if (fontKey === 'medium') {
      weight = 500;
    } else if (fontKey === 'heavy') {
      weight = 900;
    } else {
      weight = style.isBold === false ? 400 : 700;
    }
    return {
      size: boundedNumber(style.textSizePercent, 40, 80, 60),
      bottom: boundedNumber(style.bottomMarginPercent, 0, 30, 4),
      textColor: normalizeHexColor(style.textColor, '#FFFFFF'),
      fontFamily: FONT_MAP[fontKey],
      fontKey: fontKey,
      weight: weight,
      letterSpacing: fontKey === 'verdana' ? '0.06em' : '0',
      background: opacity > 0
        ? toRgba(normalizeHexColor(style.backgroundColor, '#000000'), opacity)
        : 'transparent',
      hasBackground: opacity > 0,
      blackOutline: style.blackOutline === true
    };
  }

  return {
    HARD_SYNC_DRIFT_SECONDS: HARD_SYNC_DRIFT_SECONDS,
    SOFT_SYNC_DRIFT_SECONDS: SOFT_SYNC_DRIFT_SECONDS,
    SESSION_DATA_KEY: SESSION_DATA_KEY,
    activeCueText: activeCueText,
    addRouteToSessionState: addRouteToSessionState,
    clampMediaTime: clampMediaTime,
    decideAudioSync: decideAudioSync,
    decodeEntities: decodeEntities,
    normalizeSubtitleStyle: normalizeSubtitleStyle,
    parseVttTimestamp: parseVttTimestamp,
    parseWebVtt: parseWebVtt,
    persistedRouteData: persistedRouteData,
    resolveLoadRoute: resolveLoadRoute
  };
}));

'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var core = require('../receiver-core.js');

function loadRequest(customData) {
  return {
    media: {
      contentId: 'https://cdn.example/video.mp4',
      customData: customData || {}
    }
  };
}

test('parses realistic WebVTT cues, tags and entities', function () {
  var cues = core.parseWebVtt(
    '\uFEFFWEBVTT\n\n' +
    'cue-1\n00:00:01.000 --> 00:00:03.250 align:center\n' +
    '<v Speaker>Hallo &amp; welkom</v><br>regel twee\n\n' +
    '00:03.000 --> 00:04.000\n&#x1F44B; einde\n'
  );

  assert.deepEqual(cues, [
    { start: 1, end: 3.25, text: 'Hallo & welkom\nregel twee' },
    { start: 3, end: 4, text: '👋 einde' }
  ]);
  assert.equal(core.activeCueText(cues, 3.1), 'Hallo & welkom\nregel twee\n👋 einde');
  assert.equal(core.activeCueText(cues, 4), '');
});

test('rejects malformed timestamps and empty cues without throwing', function () {
  assert.ok(Number.isNaN(core.parseVttTimestamp('broken')));
  assert.ok(Number.isNaN(core.parseVttTimestamp('00:00:61.000')));
  assert.deepEqual(core.parseWebVtt('WEBVTT\n\n00:02.000 --> 00:01.000\nwrong'), []);
});

test('direct and prepared routes use one media pipeline', function () {
  var direct = core.resolveLoadRoute(loadRequest({
    subtitleUrl: 'https://cdn.example/subtitles.vtt',
    castMethod: 'DIRECT_SOURCE',
    singlePipeline: true,
    trevuxaSignature: 'direct-signature'
  }));
  var prepared = core.resolveLoadRoute(loadRequest({
    videoUrl: 'http://192.0.2.1:1234/token/video.mp4',
    audioUrl: 'https://cdn.example/audio.mp4',
    castMethod: 'PHONE_REMUX',
    preparedMedia: true,
    trevuxaSignature: 'prepared-signature'
  }));

  assert.equal(direct.videoUrl, 'https://cdn.example/video.mp4');
  assert.equal(direct.useCompanionAudio, false);
  assert.equal(direct.trevuxaSignature, 'direct-signature');
  assert.equal(prepared.videoUrl, 'http://192.0.2.1:1234/token/video.mp4');
  assert.equal(prepared.useCompanionAudio, false);
});

test('only the explicit receiver route enables distinct companion audio', function () {
  var route = core.resolveLoadRoute(loadRequest({
    videoUrl: 'https://cdn.example/picture.mp4',
    audioUrl: 'https://cdn.example/audio.mp4',
    castMethod: 'RECEIVER_SEPARATE_TRACKS',
    singlePipeline: false
  }));

  assert.equal(route.useCompanionAudio, true);
  assert.equal(route.singlePipeline, false);
  assert.equal(route.audioUrl, 'https://cdn.example/audio.mp4');
});

test('legacy sender data without a method remains supported', function () {
  var route = core.resolveLoadRoute(loadRequest({
    videoUrl: 'https://cdn.example/picture.mp4',
    audioUrl: 'https://cdn.example/audio.mp4'
  }));

  assert.equal(route.castMethod, 'RECEIVER_SEPARATE_TRACKS');
  assert.equal(route.useCompanionAudio, true);
});

test('receiver UI language is normalized and defaults safely to Dutch', function () {
  assert.equal(core.resolveLoadRoute(loadRequest({ appLanguageCode: 'EN' })).appLanguageCode, 'en');
  assert.equal(core.resolveLoadRoute(loadRequest({ appLanguageCode: 'fr' })).appLanguageCode, 'nl');
});

test('session persistence retains the complete route and sender signature', function () {
  var route = core.resolveLoadRoute(loadRequest({
    videoUrl: 'https://cdn.example/picture.mp4',
    audioUrl: 'https://cdn.example/audio.mp4',
    subtitleUrl: 'https://cdn.example/subtitles.vtt',
    subtitleStyle: { textSizePercent: 70 },
    castMethod: 'RECEIVER_SEPARATE_TRACKS',
    singlePipeline: false,
    trevuxaSignature: 'stable-signature',
    appLanguageCode: 'en'
  }));
  var state = { loadRequestData: { customData: { keep: 'value' } } };

  core.addRouteToSessionState(state, route);
  assert.equal(state.loadRequestData.customData.keep, 'value');
  assert.equal(
    state.loadRequestData.customData.trevuxaReceiver.trevuxaSignature,
    'stable-signature'
  );

  var restored = core.resolveLoadRoute({
    media: { contentId: 'https://cdn.example/fallback.mp4' },
    customData: state.loadRequestData.customData
  });
  assert.equal(restored.videoUrl, 'https://cdn.example/picture.mp4');
  assert.equal(restored.useCompanionAudio, true);
  assert.equal(restored.subtitleStyle.textSizePercent, 70);
  assert.equal(restored.appLanguageCode, 'en');
});

test('audio synchronization waits, seeks hard drift and gently corrects soft drift', function () {
  assert.equal(core.decideAudioSync({ enabled: false }).action, 'wait');
  assert.deepEqual(core.decideAudioSync({
    enabled: true,
    force: true,
    videoReadyState: 4,
    audioReadyState: 4,
    videoTime: 12,
    audioTime: 12,
    videoPlaybackRate: 1
  }), { action: 'seek', targetTime: 12, playbackRate: 1 });
  assert.equal(core.decideAudioSync({
    enabled: true,
    videoReadyState: 4,
    audioReadyState: 4,
    videoTime: 12,
    audioTime: 12.5,
    videoPlaybackRate: 1
  }).action, 'seek');
  assert.deepEqual(core.decideAudioSync({
    enabled: true,
    videoReadyState: 4,
    audioReadyState: 4,
    videoTime: 12,
    audioTime: 12.2,
    videoPlaybackRate: 1
  }), { action: 'rate', playbackRate: 0.98, drift: 0.1999999999999993 });
});

test('subtitle styling is bounded and rejects unsafe color values', function () {
  var style = core.normalizeSubtitleStyle({
    textSizePercent: 999,
    bottomMarginPercent: -20,
    textColor: 'url(javascript:bad)',
    backgroundColor: '#123',
    backgroundOpacity: 2,
    fontFamily: 'unknown',
    isBold: false,
    blackOutline: true
  });

  assert.equal(style.size, 80);
  assert.equal(style.bottom, 0);
  assert.equal(style.textColor, '#FFFFFF');
  assert.equal(style.fontKey, 'sans_serif');
  assert.equal(style.weight, 400);
  assert.equal(style.background, 'rgba(17,34,51,1)');
  assert.equal(style.blackOutline, true);
});

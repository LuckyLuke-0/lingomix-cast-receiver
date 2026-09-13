'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');
var vm = require('node:vm');
var core = require('../receiver-core.js');

function eventTarget(initialValue) {
  var listeners = {};
  var target = Object.assign({}, initialValue || {});
  target.addEventListener = function (type, listener) {
    if (!listeners[type]) {
      listeners[type] = [];
    }
    listeners[type].push(listener);
  };
  target.emit = function (type) {
    (listeners[type] || []).slice().forEach(function (listener) {
      listener();
    });
  };
  return target;
}

function createRuntime() {
  var interceptors = {};
  var contextListeners = {};
  var timeoutCallbacks = {};
  var nextTimerId = 1;
  var documentClasses = {};
  var cssProperties = {};
  var subtitle = {
    textContent: '',
    style: { display: 'none' }
  };
  var status = {
    textContent: 'Trevuxa Cast Receiver',
    style: { display: 'block' }
  };
  var video = eventTarget({
    currentTime: 0,
    duration: 120,
    ended: false,
    error: null,
    muted: false,
    paused: true,
    playbackRate: 1,
    readyState: 4,
    pauseCalls: 0,
    playCalls: 0
  });
  var audio = eventTarget({
    currentTime: 0,
    duration: 120,
    error: null,
    paused: true,
    playbackRate: 1,
    preload: 'none',
    readyState: 4,
    loadCalls: 0,
    pauseCalls: 0,
    playCalls: 0,
    src: ''
  });

  video.pause = function () {
    var changed = !video.paused;
    video.pauseCalls += 1;
    video.paused = true;
    if (changed) {
      video.emit('pause');
    }
  };
  video.play = function () {
    var changed = video.paused;
    video.playCalls += 1;
    video.paused = false;
    if (changed) {
      video.emit('playing');
    }
  };
  audio.pause = function () {
    audio.pauseCalls += 1;
    audio.paused = true;
  };
  audio.play = function () {
    audio.playCalls += 1;
    audio.paused = false;
  };
  audio.load = function () {
    audio.loadCalls += 1;
  };
  audio.removeAttribute = function (name) {
    if (name === 'src') {
      audio.src = '';
    }
  };

  var playerManager = {
    pauseCalls: 0,
    playCalls: 0,
    setMediaElement: function (element) {
      assert.equal(element, video);
    },
    setMessageInterceptor: function (type, interceptor) {
      interceptors[type] = interceptor;
    },
    pause: function () {
      playerManager.pauseCalls += 1;
      video.pause();
    },
    play: function () {
      playerManager.playCalls += 1;
      video.play();
    }
  };
  var receiverContext = {
    addEventListener: function (type, listener) {
      contextListeners[type] = listener;
    },
    getPlayerManager: function () {
      return playerManager;
    },
    start: function () {}
  };
  var elements = {
    'companion-audio': audio,
    media: video,
    status: status,
    subtitle: subtitle
  };
  var documentValue = {
    body: {
      classList: {
        add: function (name) {
          documentClasses[name] = true;
        },
        remove: function (name) {
          delete documentClasses[name];
        }
      }
    },
    documentElement: {
      clientWidth: 1280,
      lang: 'nl',
      style: {
        setProperty: function (name, value) {
          cssProperties[name] = value;
        }
      }
    },
    getElementById: function (id) {
      return elements[id];
    }
  };

  function FakeXmlHttpRequest() {
    this.readyState = 0;
    this.responseText = '';
    this.status = 0;
  }
  FakeXmlHttpRequest.prototype.abort = function () {};
  FakeXmlHttpRequest.prototype.open = function () {};
  FakeXmlHttpRequest.prototype.send = function () {
    this.readyState = 4;
    this.status = 200;
    this.responseText = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello';
    this.onreadystatechange();
  };

  var messageType = {
    LOAD: 'LOAD',
    PAUSE: 'PAUSE',
    RESUME_SESSION: 'RESUME_SESSION',
    SESSION_STATE: 'SESSION_STATE',
    STOP: 'STOP'
  };
  var sandbox = {
    TrevuxaReceiverCore: core,
    XMLHttpRequest: FakeXmlHttpRequest,
    cast: {
      framework: {
        CastReceiverContext: {
          getInstance: function () {
            return receiverContext;
          }
        },
        CastReceiverOptions: function () {},
        getLoggerLevel: function () {},
        messages: {
          ErrorData: function (type) {
            this.type = type;
          },
          ErrorReason: {
            INVALID_PARAMS: 'INVALID_PARAMS',
            INVALID_REQUEST: 'INVALID_REQUEST'
          },
          ErrorType: {
            LOAD_CANCELLED: 'LOAD_CANCELLED',
            LOAD_FAILED: 'LOAD_FAILED'
          },
          MessageType: messageType
        },
        system: { EventType: { SHUTDOWN: 'SHUTDOWN' } }
      }
    },
    clearInterval: function () {},
    clearTimeout: function (id) {
      delete timeoutCallbacks[id];
    },
    console: {
      error: function () {},
      log: function () {},
      warn: function () {}
    },
    document: documentValue,
    isFinite: isFinite,
    setInterval: function () {
      return nextTimerId += 1;
    },
    setTimeout: function (callback) {
      var id = nextTimerId += 1;
      timeoutCallbacks[id] = callback;
      return id;
    },
    window: { innerWidth: 1280 }
  };

  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '..', 'receiver-trevuxa.js'), 'utf8'),
    sandbox,
    { filename: 'receiver-trevuxa.js' }
  );

  return {
    audio: audio,
    contextListeners: contextListeners,
    documentClasses: documentClasses,
    documentValue: documentValue,
    interceptors: interceptors,
    playerManager: playerManager,
    runBufferTimeout: function () {
      Object.keys(timeoutCallbacks).forEach(function (id) {
        var callback = timeoutCallbacks[id];
        delete timeoutCallbacks[id];
        callback();
      });
    },
    status: status,
    subtitle: subtitle,
    timeoutCount: function () {
      return Object.keys(timeoutCallbacks).length;
    },
    video: video
  };
}

function loadSeparate(runtime, overrides) {
  var customData = Object.assign({
    appLanguageCode: 'en',
    audioUrl: 'https://cdn.example/audio.mp4',
    castMethod: 'RECEIVER_SEPARATE_TRACKS',
    singlePipeline: false,
    videoUrl: 'https://cdn.example/picture.mp4'
  }, overrides || {});
  var request = {
    media: {
      contentId: 'https://cdn.example/fallback.mp4',
      customData: customData
    }
  };
  assert.equal(runtime.interceptors.LOAD(request), request);
  return request;
}

test('invalid LOAD returns the documented CAF failure and reason', function () {
  var runtime = createRuntime();
  var error = runtime.interceptors.LOAD({});

  assert.equal(error.type, 'LOAD_FAILED');
  assert.equal(error.reason, 'INVALID_PARAMS');
  assert.equal(runtime.video.muted, false);
});

test('SESSION_STATE persists the active route inside the CAF response wrapper', function () {
  var runtime = createRuntime();
  loadSeparate(runtime, {
    subtitleUrl: 'https://cdn.example/subtitles.vtt',
    trevuxaSignature: 'runtime-signature',
    trevuxaContentSignature: 'runtime-content'
  });
  var response = {
    sessionState: {
      loadRequestData: { customData: { keep: 'yes' } }
    }
  };

  assert.equal(runtime.interceptors.SESSION_STATE(response), response);
  assert.equal(response.sessionState.loadRequestData.customData.keep, 'yes');
  assert.equal(
    response.sessionState.loadRequestData.customData.trevuxaReceiver.trevuxaSignature,
    'runtime-signature'
  );
  assert.equal(
    response.sessionState.loadRequestData.customData.trevuxaReceiver.trevuxaContentSignature,
    'runtime-content'
  );
  assert.equal(
    response.sessionState.loadRequestData.customData.trevuxaReceiver.audioUrl,
    'https://cdn.example/audio.mp4'
  );
});

test('split audio buffering pauses video and resumes only after audio is ready', function () {
  var runtime = createRuntime();
  loadSeparate(runtime);
  runtime.video.play();

  assert.equal(runtime.audio.playCalls, 1);
  runtime.audio.emit('waiting');

  assert.equal(runtime.video.paused, true);
  assert.equal(runtime.playerManager.pauseCalls, 1);
  assert.equal(runtime.status.textContent, 'Trevuxa: buffering selected audio…');
  assert.equal(runtime.timeoutCount(), 1);

  runtime.audio.emit('canplay');

  assert.equal(runtime.playerManager.playCalls, 1);
  assert.equal(runtime.video.paused, false);
  assert.equal(runtime.audio.playCalls, 2);
  assert.equal(runtime.timeoutCount(), 0);
  assert.equal(runtime.status.style.display, 'none');
});

test('a sender pause while split audio buffers prevents automatic resume', function () {
  var runtime = createRuntime();
  loadSeparate(runtime);
  runtime.video.play();
  runtime.audio.emit('waiting');

  runtime.interceptors.PAUSE({});
  runtime.audio.emit('canplaythrough');

  assert.equal(runtime.playerManager.playCalls, 0);
  assert.equal(runtime.video.paused, true);
  assert.equal(runtime.timeoutCount(), 0);
});

test('an early sender play cannot advance muted video while audio still buffers', function () {
  var runtime = createRuntime();
  loadSeparate(runtime);
  runtime.video.play();
  runtime.audio.emit('waiting');

  runtime.video.play();

  assert.equal(runtime.video.paused, true);
  assert.equal(runtime.playerManager.pauseCalls, 2);
  assert.equal(runtime.playerManager.playCalls, 0);
  assert.equal(runtime.status.textContent, 'Trevuxa: buffering selected audio…');

  runtime.audio.emit('canplay');
  assert.equal(runtime.playerManager.playCalls, 1);
  assert.equal(runtime.video.paused, false);
});

test('STOP fully clears route, subtitle, companion audio and pending resume', function () {
  var runtime = createRuntime();
  runtime.video.currentTime = 1;
  loadSeparate(runtime, { subtitleUrl: 'https://cdn.example/subtitles.vtt' });
  runtime.video.play();
  runtime.audio.emit('waiting');

  runtime.interceptors.STOP({});
  runtime.audio.emit('canplay');

  assert.equal(runtime.video.muted, false);
  assert.equal(runtime.audio.src, '');
  assert.equal(runtime.audio.preload, 'none');
  assert.equal(runtime.subtitle.textContent, '');
  assert.equal(runtime.subtitle.style.display, 'none');
  assert.equal(runtime.status.textContent, 'Trevuxa: ready to cast');
  assert.equal(runtime.playerManager.playCalls, 0);
  assert.equal(runtime.timeoutCount(), 0);

  var response = {
    sessionState: { loadRequestData: { customData: { keep: 'yes' } } }
  };
  runtime.interceptors.SESSION_STATE(response);
  assert.equal(response.sessionState.loadRequestData.customData.keep, 'yes');
  assert.equal(
    response.sessionState.loadRequestData.customData.trevuxaReceiver,
    undefined
  );
});

test('split audio buffering timeout fails closed with video paused', function () {
  var runtime = createRuntime();
  loadSeparate(runtime);
  runtime.video.play();
  runtime.audio.emit('waiting');

  runtime.runBufferTimeout();

  assert.equal(runtime.video.paused, true);
  assert.equal(runtime.playerManager.playCalls, 0);
  assert.equal(runtime.status.textContent, 'Trevuxa: selected audio could not be played');
  assert.equal(runtime.timeoutCount(), 0);
});

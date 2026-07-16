/* player.js - YouTube IFrame API wrapper + kid-safety behaviors */

(function () {
  var player = null;
  var apiReady = false;
  var pendingVideoId = null;
  var queue = [];
  var queueIndex = -1;
  var callbacks = {};
  var lastProgrammaticActionTime = 0;
  var PAUSE_DEBOUNCE_MS = 500;

  function loadApiScript() {
    if (document.getElementById('yt-iframe-api')) {
      return;
    }
    var tag = document.createElement('script');
    tag.id = 'yt-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    var firstScript = document.getElementsByTagName('script')[0];
    firstScript.parentNode.insertBefore(tag, firstScript);
  }

  // Called by the YouTube IFrame API script once it has loaded.
  window.onYouTubeIframeAPIReady = function () {
    apiReady = true;
    createPlayer();
  };

  function createPlayer() {
    player = new YT.Player('yt-player', {
      playerVars: {
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1,
        controls: 1,
        fs: 0,
        autoplay: 1,
        origin: location.origin
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onStateChange,
        onError: onPlayerError,
        onAutoplayBlocked: onAutoplayBlocked
      }
    });
  }

  function onPlayerReady() {
    if (pendingVideoId) {
      var videoId = pendingVideoId;
      pendingVideoId = null;
      lastProgrammaticActionTime = Date.now();
      player.loadVideoById(videoId);
    }
    if (callbacks.onReady) {
      callbacks.onReady();
    }
  }

  function onStateChange(e) {
    var state = e.data;
    if (state === YT.PlayerState.ENDED) {
      advanceQueue();
    } else if (state === YT.PlayerState.PAUSED) {
      var sinceProgrammatic = Date.now() - lastProgrammaticActionTime;
      if (sinceProgrammatic < PAUSE_DEBOUNCE_MS) {
        return;
      }
      if (callbacks.onPause) {
        callbacks.onPause();
      }
    } else if (state === YT.PlayerState.PLAYING) {
      if (callbacks.onPlaying) {
        callbacks.onPlaying();
      }
    }
  }

  function onPlayerError(e) {
    var code = e.data;
    if (code === 100 || code === 101 || code === 150) {
      if (callbacks.onError) {
        callbacks.onError();
      }
      advanceQueue();
    }
  }

  function onAutoplayBlocked() {
    if (player) {
      try {
        player.mute();
        player.playVideo();
      } catch (err) {
        // ignore - player may not be ready
      }
    }
    if (callbacks.onAutoplayBlocked) {
      callbacks.onAutoplayBlocked();
    }
  }

  function advanceQueue() {
    queueIndex++;
    if (queueIndex >= queue.length) {
      if (callbacks.onQueueEnd) {
        callbacks.onQueueEnd();
      }
      return;
    }
    var next = queue[queueIndex];
    lastProgrammaticActionTime = Date.now();
    if (player && apiReady) {
      player.loadVideoById(next.videoId);
    }
    if (callbacks.onVideoChange) {
      callbacks.onVideoChange(next, queueIndex);
    }
  }

  function play(videoList, startIndex) {
    queue = videoList;
    queueIndex = startIndex;
    var video = queue[queueIndex];
    lastProgrammaticActionTime = Date.now();
    if (!player || !apiReady) {
      pendingVideoId = video.videoId;
    } else {
      player.loadVideoById(video.videoId);
    }
    if (callbacks.onVideoChange) {
      callbacks.onVideoChange(video, queueIndex);
    }
  }

  function pause() {
    if (player) {
      try {
        // Reset the debounce window so the resulting PAUSED event always
        // reaches the pause screen, even right after a programmatic load.
        lastProgrammaticActionTime = 0;
        player.pauseVideo();
      } catch (err) {
        // ignore
      }
    }
  }

  function resume() {
    lastProgrammaticActionTime = Date.now();
    if (player) {
      player.playVideo();
    }
  }

  function stop() {
    if (player) {
      try {
        player.stopVideo();
      } catch (err) {
        // ignore
      }
    }
    queue = [];
    queueIndex = -1;
  }

  function unmuteOnGesture() {
    if (player) {
      try {
        player.unMute();
      } catch (err) {
        // ignore
      }
    }
  }

  function getCurrentVideo() {
    return queue[queueIndex] || null;
  }

  window.Player = {
    init: function (cbs) {
      callbacks = cbs || {};
      loadApiScript();
    },
    play: play,
    pause: pause,
    resume: resume,
    stop: stop,
    unmuteOnGesture: unmuteOnGesture,
    getCurrentVideo: getCurrentVideo
  };
})();

/* player.js - YouTube IFrame API wrapper + kid-safety behaviors */

(function () {
  var player = null;
  var playerReady = false;
  var pendingVideoId = null;
  var queue = [];
  var queueIndex = -1;
  var callbacks = {};
  var lastProgrammaticActionTime = 0;
  var PAUSE_DEBOUNCE_MS = 500;
  var watchdogTimer = null;
  var WATCHDOG_MS = 8000;

  function loadApiScript() {
    if (document.getElementById('yt-iframe-api')) {
      return;
    }
    var tag = document.createElement('script');
    tag.id = 'yt-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = function () {
      if (callbacks.onStuck) {
        callbacks.onStuck('Could not load the YouTube player (blocked or no network).');
      }
    };
    var firstScript = document.getElementsByTagName('script')[0];
    firstScript.parentNode.insertBefore(tag, firstScript);
  }

  // If a video is requested and playback never starts, surface it instead of
  // leaving a silent black screen (blocked iframe_api, file:// embed refusal…).
  function armWatchdog() {
    clearWatchdog();
    watchdogTimer = setTimeout(function () {
      if (callbacks.onStuck) {
        callbacks.onStuck("Video didn't start. Check the network, an ad blocker, or that the app is served over http(s).");
      }
    }, WATCHDOG_MS);
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // Called by the YouTube IFrame API script once it has loaded.
  window.onYouTubeIframeAPIReady = function () {
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
    playerReady = true;
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
      clearWatchdog();
      advanceQueue();
    } else if (state === YT.PlayerState.PAUSED) {
      clearWatchdog();
      var sinceProgrammatic = Date.now() - lastProgrammaticActionTime;
      if (sinceProgrammatic < PAUSE_DEBOUNCE_MS) {
        return;
      }
      if (callbacks.onPause) {
        callbacks.onPause();
      }
    } else if (state === YT.PlayerState.PLAYING) {
      clearWatchdog();
      if (callbacks.onPlaying) {
        callbacks.onPlaying();
      }
    } else if (state === YT.PlayerState.BUFFERING || state === YT.PlayerState.UNSTARTED) {
      // A pre-roll ad loading/playing reports as buffering/unstarted and can
      // legitimately take longer than the watchdog window - reset it instead
      // of treating this as stuck.
      armWatchdog();
    }
  }

  function onPlayerError(e) {
    // 2/5: bad id or HTML5 error; 100: removed/private; 101/150: embedding
    // disabled. All leave a dead player, so skip ahead in every case.
    if (callbacks.onError) {
      callbacks.onError(e.data);
    }
    advanceQueue();
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
      clearWatchdog();
      if (callbacks.onQueueEnd) {
        callbacks.onQueueEnd();
      }
      return;
    }
    var next = queue[queueIndex];
    lastProgrammaticActionTime = Date.now();
    if (playerReady) {
      player.loadVideoById(next.videoId);
    } else {
      pendingVideoId = next.videoId;
    }
    armWatchdog();
    if (callbacks.onVideoChange) {
      callbacks.onVideoChange(next, queueIndex);
    }
  }

  function play(videoList, startIndex) {
    queue = videoList;
    queueIndex = startIndex;
    var video = queue[queueIndex];
    lastProgrammaticActionTime = Date.now();
    if (playerReady) {
      player.loadVideoById(video.videoId);
    } else {
      pendingVideoId = video.videoId;
    }
    armWatchdog();
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
    clearWatchdog();
    pendingVideoId = null;
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

  function seekBy(seconds) {
    if (player && playerReady) {
      try {
        var t = player.getCurrentTime() || 0;
        player.seekTo(Math.max(0, t + seconds), true);
      } catch (err) {
        // ignore
      }
    }
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

  // webOS suspends the app on Home/app-switch (and possibly input switch) but
  // does not pause media for us — pause explicitly whenever we go hidden.
  function onVisibilityChange() {
    if (document.hidden && player && playerReady) {
      try {
        // Reset the debounce so the PAUSED event shows the pause screen,
        // giving a sane resume point when the app comes back.
        lastProgrammaticActionTime = 0;
        player.pauseVideo();
      } catch (err) {
        // ignore
      }
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('webkitvisibilitychange', onVisibilityChange);

  window.Player = {
    init: function (cbs) {
      callbacks = cbs || {};
      loadApiScript();
    },
    play: play,
    pause: pause,
    resume: resume,
    stop: stop,
    seekBy: seekBy,
    isActive: function () { return queueIndex >= 0 && queue.length > 0; },
    unmuteOnGesture: unmuteOnGesture,
    getCurrentVideo: getCurrentVideo
  };
})();

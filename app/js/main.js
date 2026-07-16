/* main.js - boot, load cache, render channel rows, screen state machine */

(function () {
  var el = {};
  var rows = []; // { title, videos, cardEls: [] }
  var focus = { rowIndex: 0, colIndex: 0 };
  var headerFocused = false; // reload button, above row 0
  var rowColMemory = [];
  var lastFocusedCard = null; // { rowIndex, colIndex } to restore after playback
  var pauseFocusIndex = 0; // 0 = Resume, 1 = Back to menu
  var titleBarTimer = null;
  var toastTimer = null;
  var waitingForUnmuteGesture = false;

  // Load thumbnails only as cards approach the viewport — a full grid is
  // hundreds of img.youtube.com requests if loaded eagerly. IntersectionObserver
  // exists on Chromium 51+, i.e. every webOS TV this app targets; the fallback
  // is the old eager behavior.
  var lazyObserver = null;
  if ('IntersectionObserver' in window) {
    lazyObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          var img = entries[i].target;
          img.src = img.getAttribute('data-src');
          lazyObserver.unobserve(img);
        }
      }
    }, { rootMargin: '300px' });
  }

  function qs(id) {
    return document.getElementById(id);
  }

  function boot() {
    el.loading = qs('loading-screen');
    el.error = qs('error-screen');
    el.home = qs('home-screen');
    el.player = qs('player-screen');
    el.pause = qs('pause-screen');
    el.rowsContainer = qs('rows');
    el.retryBtn = qs('retry-btn');
    el.playerContainer = qs('player-container');
    el.nowPlayingBar = qs('now-playing-bar');
    el.nowPlayingTitle = qs('now-playing-title');
    el.bufferIndicator = qs('buffer-indicator');
    el.toast = qs('toast');
    el.pauseTitle = qs('pause-title');
    el.btnResume = qs('btn-resume');
    el.btnBack = qs('btn-back');

    Remote.bindPointer(el.retryBtn, { onSelect: loadCache });

    el.reloadBtn = qs('reload-btn');
    Remote.bindPointer(el.reloadBtn, {
      onFocus: function () { headerFocused = true; applyHomeFocus(); },
      onSelect: loadCache
    });

    Remote.bindPointer(el.btnResume, {
      onFocus: function () { pauseFocusIndex = 0; applyPauseFocus(); },
      onSelect: resumeFromPause
    });
    Remote.bindPointer(el.btnBack, {
      onFocus: function () { pauseFocusIndex = 1; applyPauseFocus(); },
      onSelect: backToMenuFromPause
    });

    Player.init({
      onPause: handlePlayerPaused,
      onPlaying: handlePlayerPlaying,
      onVideoChange: handleVideoChange,
      onQueueEnd: goHome,
      onError: handlePlayerError,
      onStuck: handlePlayerStuck,
      onBuffering: handlePlayerBuffering,
      onAutoplayBlocked: function () { waitingForUnmuteGesture = true; }
    });

    el.exitHint = qs('exit-hint');

    // Magic Remote pointer show/hide (webOS 2.0+). When the pointer hides the
    // user has switched to D-pad — make sure the focused card is visible.
    document.addEventListener('cursorStateChange', function (e) {
      var pointerVisible = !!(e.detail && e.detail.visibility);
      document.body.className = pointerVisible ? 'pointer-mode' : 'dpad-mode';
      if (!pointerVisible && el.home.classList.contains('visible')) {
        applyHomeFocus();
      }
    });

    // Global: first keypress after an autoplay-block unmutes, no visual overlay.
    document.addEventListener('keydown', function () {
      if (waitingForUnmuteGesture) {
        waitingForUnmuteGesture = false;
        Player.unmuteOnGesture();
      }
    });

    Remote.init({});

    showScreen('loading');
    loadCache();
  }

  function loadCache() {
    showScreen('loading');
    var url = 'videos_cache.json?_=' + Date.now();
    fetch(url)
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        buildHome(data);
        showScreen('home');
      })
      .catch(function () {
        showScreen('error');
      });
  }

  /* ---------------- Home screen ---------------- */

  function buildHome(data) {
    if (lazyObserver) {
      lazyObserver.disconnect();
    }
    el.rowsContainer.innerHTML = '';
    rows = [];
    rowColMemory = [];
    focus = { rowIndex: 0, colIndex: 0 };
    headerFocused = false;

    // Learning collections come first, wrapped in the Math Corner zone, so
    // the curated rows are what the kid lands on when the app opens.
    var collections = data.collections || [];
    if (collections.length > 0) {
      var zone = document.createElement('div');
      zone.className = 'math-zone';
      var zoneHead = document.createElement('div');
      zoneHead.className = 'zone-head';
      zoneHead.innerHTML =
        '<div class="zone-badge">123</div>' +
        '<h2 class="zone-title">Math Corner</h2>' +
        '<p class="zone-hint">watch the episodes in order!</p>';
      zone.appendChild(zoneHead);
      el.rowsContainer.appendChild(zone);
      for (var j = 0; j < collections.length; j++) {
        addRow(collections[j].name, collections[j].videos, {
          container: zone,
          courseClass: COURSE_ACCENTS[j % COURSE_ACCENTS.length]
        });
      }
    }
    if (data.picks && data.picks.length > 0) {
      addRow('Picks', data.picks);
    }
    var channels = data.channels || [];
    for (var i = 0; i < channels.length; i++) {
      addRow(channels[i].name, channels[i].videos);
    }
  }

  // Cycled per row so kids can tell rows apart by color, not just text.
  var ROW_ACCENTS = ['candy-1', 'candy-2', 'candy-3', 'candy-4', 'candy-5'];
  // Course level colors, matching the official Numberblocks COURSE palette.
  var COURSE_ACCENTS = ['course-yellow', 'course-green', 'course-blue', 'course-grape'];

  function addRow(title, videos, opts) {
    opts = opts || {};
    var rowIndex = rows.length;
    var accent = ROW_ACCENTS[rowIndex % ROW_ACCENTS.length];
    var rowEl = document.createElement('div');
    rowEl.className = opts.courseClass ? 'row row--course ' + opts.courseClass : 'row';

    var titleEl = document.createElement('h2');
    titleEl.className = 'row-title';
    if (opts.courseClass) {
      // Square level chip: a white cube showing the course's number (parsed
      // from the name, e.g. "Numbers to 20" -> 20) next to the name.
      var levelNum = (title.match(/\d+/) || [])[0];
      if (levelNum) {
        var cube = document.createElement('span');
        cube.className = 'level-cube';
        cube.textContent = levelNum;
        titleEl.appendChild(cube);
      }
      titleEl.appendChild(document.createTextNode(title));
    } else {
      titleEl.textContent = title;
      titleEl.style.background = 'var(--' + accent + ')';
    }
    rowEl.appendChild(titleEl);

    var trackEl = document.createElement('div');
    trackEl.className = 'row-track';
    // The track is a horizontal scroller, so the browser latches vertical
    // wheel deltas onto it where they die (it can't move vertically) instead
    // of scrolling the page. Route vertical deltas to the page ourselves;
    // horizontal ones (trackpad swipe) keep native track scrolling.
    trackEl.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        return;
      }
      window.scrollBy(0, e.deltaY);
      e.preventDefault();
    }, { passive: false });
    rowEl.appendChild(trackEl);

    var cardEls = [];
    for (var i = 0; i < videos.length; i++) {
      cardEls.push(buildCard(videos[i], rowIndex, i, trackEl, accent, opts));
    }

    (opts.container || el.rowsContainer).appendChild(rowEl);
    rows.push({ title: title, videos: videos, el: rowEl, trackEl: trackEl, cardEls: cardEls });
    rowColMemory.push(0);
  }

  function buildCard(video, rowIndex, colIndex, trackEl, accent, opts) {
    var card = document.createElement('div');
    card.className = 'card';
    if (opts && opts.courseClass) {
      card.style.setProperty('--focus-color', 'var(--course-accent)');
      var badge = document.createElement('span');
      badge.className = 'ep-badge';
      badge.textContent = String(colIndex + 1);
      card.appendChild(badge);
    } else {
      card.style.setProperty('--focus-color', 'var(--' + accent + ')');
    }

    var img = document.createElement('img');
    img.className = 'card-thumb';
    img.alt = video.title;
    if (lazyObserver) {
      img.setAttribute('data-src', video.thumbnail);
      lazyObserver.observe(img);
    } else {
      img.src = video.thumbnail;
    }
    card.appendChild(img);

    var titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = video.title;
    card.appendChild(titleEl);

    Remote.bindPointer(card, {
      onFocus: function () {
        headerFocused = false;
        focus.rowIndex = rowIndex;
        focus.colIndex = colIndex;
        applyHomeFocus();
      },
      onSelect: function () {
        selectVideo(rowIndex, colIndex);
      }
    });

    trackEl.appendChild(card);
    return card;
  }

  function applyHomeFocus() {
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < rows[r].cardEls.length; c++) {
        rows[r].cardEls[c].classList.remove('focused');
      }
    }
    el.reloadBtn.classList.toggle('focused', headerFocused);
    if (headerFocused) {
      window.scrollTo(0, 0);
      return;
    }
    var row = rows[focus.rowIndex];
    if (!row) {
      return;
    }
    var card = row.cardEls[focus.colIndex];
    if (!card) {
      return;
    }
    card.classList.add('focused');
    scrollRowToCard(row.trackEl, card);
    scrollPageToRow(row.el);
  }

  function scrollRowToCard(trackEl, card) {
    var cardLeft = card.offsetLeft;
    var cardRight = cardLeft + card.offsetWidth;
    var viewLeft = trackEl.scrollLeft;
    var viewRight = viewLeft + trackEl.clientWidth;
    if (cardLeft < viewLeft) {
      trackEl.scrollLeft = cardLeft - 40;
    } else if (cardRight > viewRight) {
      trackEl.scrollLeft = cardRight - trackEl.clientWidth + 40;
    }
  }

  function scrollPageToRow(rowEl) {
    var rowTop = rowEl.offsetTop;
    var rowBottom = rowTop + rowEl.offsetHeight;
    var viewTop = window.pageYOffset || document.documentElement.scrollTop;
    var viewBottom = viewTop + window.innerHeight;
    if (rowTop < viewTop) {
      window.scrollTo(0, rowTop - 20);
    } else if (rowBottom > viewBottom) {
      window.scrollTo(0, rowBottom - window.innerHeight + 20);
    }
  }

  function homeHandlers() {
    return {
      onLeft: function () {
        if (headerFocused) { return; }
        var row = rows[focus.rowIndex];
        if (!row) { return; }
        if (focus.colIndex > 0) {
          focus.colIndex--;
          rowColMemory[focus.rowIndex] = focus.colIndex;
          applyHomeFocus();
        }
      },
      onRight: function () {
        if (headerFocused) { return; }
        var row = rows[focus.rowIndex];
        if (!row) { return; }
        if (focus.colIndex < row.cardEls.length - 1) {
          focus.colIndex++;
          rowColMemory[focus.rowIndex] = focus.colIndex;
          applyHomeFocus();
        }
      },
      onUp: function () {
        if (headerFocused) { return; }
        if (focus.rowIndex > 0) {
          rowColMemory[focus.rowIndex] = focus.colIndex;
          focus.rowIndex--;
          focus.colIndex = clampCol(focus.rowIndex, rowColMemory[focus.rowIndex] || 0);
          applyHomeFocus();
        } else {
          headerFocused = true;
          applyHomeFocus();
        }
      },
      onDown: function () {
        if (headerFocused) {
          headerFocused = false;
          applyHomeFocus();
          return;
        }
        if (focus.rowIndex < rows.length - 1) {
          rowColMemory[focus.rowIndex] = focus.colIndex;
          focus.rowIndex++;
          focus.colIndex = clampCol(focus.rowIndex, rowColMemory[focus.rowIndex] || 0);
          applyHomeFocus();
        }
      },
      onEnter: function () {
        if (headerFocused) {
          loadCache();
          return;
        }
        selectVideo(focus.rowIndex, focus.colIndex);
      },
      onBack: handleRootBack
    };
  }

  // Back at the root screen: require a second press within 2.5s to exit, so
  // a stray Back from the kid doesn't dump them out of the app.
  var lastRootBackAt = 0;

  function handleRootBack() {
    var now = Date.now();
    if (now - lastRootBackAt < 2500) {
      window.close();
      return;
    }
    lastRootBackAt = now;
    el.exitHint.classList.add('visible');
    setTimeout(function () {
      el.exitHint.classList.remove('visible');
    }, 2500);
  }

  function clampCol(rowIndex, col) {
    var row = rows[rowIndex];
    if (!row) { return 0; }
    return Math.max(0, Math.min(col, row.cardEls.length - 1));
  }

  function selectVideo(rowIndex, colIndex) {
    var row = rows[rowIndex];
    if (!row) { return; }
    lastFocusedCard = { rowIndex: rowIndex, colIndex: colIndex };
    showScreen('player');
    Player.play(row.videos, colIndex);
  }

  /* ---------------- Player screen ---------------- */

  function handleVideoChange(video) {
    el.nowPlayingTitle.textContent = video.title;
    el.playerContainer.style.display = '';
    hideToast();
    hideBufferIndicator();
    showTitleBar();
  }

  function handlePlayerPlaying() {
    el.playerContainer.style.display = '';
    hideBufferIndicator();
  }

  function handlePlayerBuffering() {
    // Only relevant while we're actually trying to show a video.
    if (!el.player.classList.contains('visible')) {
      return;
    }
    el.bufferIndicator.classList.add('visible');
  }

  function hideBufferIndicator() {
    el.bufferIndicator.classList.remove('visible');
  }

  function showTitleBar() {
    el.nowPlayingBar.classList.remove('faded');
    if (titleBarTimer) {
      clearTimeout(titleBarTimer);
    }
    titleBarTimer = setTimeout(function () {
      el.nowPlayingBar.classList.add('faded');
    }, 3000);
  }

  function handlePlayerStuck(message) {
    // Only relevant while we're trying to show a video.
    if (!el.player.classList.contains('visible')) {
      return;
    }
    hideBufferIndicator();
    el.pauseTitle.textContent = message;
    pauseFocusIndex = 0;
    showScreen('pause');
    applyPauseFocus();
  }

  function handlePlayerError() {
    hideBufferIndicator();
    el.playerContainer.style.display = 'none';
    el.toast.textContent = 'Video unavailable, skipping';
    el.toast.style.display = 'block';
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(hideToast, 1500);
  }

  function hideToast() {
    el.toast.style.display = 'none';
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function playerHandlers() {
    return {
      onEnter: function () {
        Player.pause();
      },
      onPlayPause: function () {
        Player.pause();
      },
      onStop: function () {
        Player.stop();
        goHome();
      },
      onSeekBack: function () {
        Player.seekBy(-10);
      },
      onSeekForward: function () {
        Player.seekBy(10);
      },
      onLeft: function () {
        Player.seekBy(-10);
      },
      onRight: function () {
        Player.seekBy(10);
      },
      onBack: function () {
        Player.stop();
        goHome();
      }
    };
  }

  /* ---------------- Pause screen ---------------- */

  function handlePlayerPaused() {
    hideBufferIndicator();
    el.pauseTitle.textContent = '';
    pauseFocusIndex = 0;
    showScreen('pause');
    applyPauseFocus();
  }

  function applyPauseFocus() {
    el.btnResume.classList.toggle('focused', pauseFocusIndex === 0);
    el.btnBack.classList.toggle('focused', pauseFocusIndex === 1);
  }

  function resumeFromPause() {
    showScreen('player');
    Player.resume();
  }

  function backToMenuFromPause() {
    Player.stop();
    goHome();
  }

  function pauseHandlers() {
    return {
      onLeft: function () {
        pauseFocusIndex = 0;
        applyPauseFocus();
      },
      onRight: function () {
        pauseFocusIndex = 1;
        applyPauseFocus();
      },
      onUp: function () {},
      onDown: function () {},
      onEnter: function () {
        if (pauseFocusIndex === 0) {
          resumeFromPause();
        } else {
          backToMenuFromPause();
        }
      },
      onPlayPause: function () {
        resumeFromPause();
      },
      onBack: function () {
        backToMenuFromPause();
      }
    };
  }

  /* ---------------- Error screen ---------------- */

  function errorHandlers() {
    return {
      onEnter: loadCache,
      onBack: function () {}
    };
  }

  /* ---------------- Screen state machine ---------------- */

  function goHome() {
    hideToast();
    hideBufferIndicator();
    showScreen('home');
    headerFocused = false;
    if (lastFocusedCard) {
      focus.rowIndex = lastFocusedCard.rowIndex;
      focus.colIndex = lastFocusedCard.colIndex;
    }
    applyHomeFocus();
  }

  function showScreen(name) {
    el.loading.classList.remove('visible');
    el.error.classList.remove('visible');
    el.home.classList.remove('visible');
    el.player.classList.remove('visible');
    el.pause.classList.remove('visible');

    if (name === 'loading') {
      el.loading.classList.add('visible');
      Remote.setHandlers({});
    } else if (name === 'error') {
      el.error.classList.add('visible');
      Remote.setHandlers(errorHandlers());
    } else if (name === 'home') {
      el.home.classList.add('visible');
      Remote.setHandlers(homeHandlers());
      applyHomeFocus();
    } else if (name === 'player') {
      el.player.classList.add('visible');
      el.playerContainer.style.display = '';
      Remote.setHandlers(playerHandlers());
    } else if (name === 'pause') {
      // Keep the player screen visible underneath so the paused frame still
      // shows through the (semi-transparent) pause overlay.
      el.player.classList.add('visible');
      el.pause.classList.add('visible');
      Remote.setHandlers(pauseHandlers());
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

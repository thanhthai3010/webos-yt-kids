/* remote.js - D-pad / pointer navigation for webOS Magic Remote + desktop keyboard */

(function () {
  var handlers = {};

  function onKeyDown(e) {
    var code = e.keyCode || e.which;
    switch (code) {
      case 37: // left
        if (handlers.onLeft) { handlers.onLeft(); e.preventDefault(); }
        break;
      case 38: // up
        if (handlers.onUp) { handlers.onUp(); e.preventDefault(); }
        break;
      case 39: // right
        if (handlers.onRight) { handlers.onRight(); e.preventDefault(); }
        break;
      case 40: // down
        if (handlers.onDown) { handlers.onDown(); e.preventDefault(); }
        break;
      case 13: // OK / Enter
        if (handlers.onEnter) { handlers.onEnter(); e.preventDefault(); }
        break;
      case 461: // webOS Back
      case 27:  // Escape (desktop testing)
      case 8:   // Backspace (desktop testing)
        if (handlers.onBack) { handlers.onBack(); e.preventDefault(); }
        break;
      case 415: // remote Play
      case 19:  // remote Pause
        if (handlers.onPlayPause) { handlers.onPlayPause(); e.preventDefault(); }
        break;
      case 413: // remote Stop
        if (handlers.onStop) { handlers.onStop(); e.preventDefault(); }
        break;
      case 412: // remote Rewind
        if (handlers.onSeekBack) { handlers.onSeekBack(); e.preventDefault(); }
        break;
      case 417: // remote Fast-forward
        if (handlers.onSeekForward) { handlers.onSeekForward(); e.preventDefault(); }
        break;
      default:
        break;
    }
  }

  function init(defaultHandlers) {
    handlers = defaultHandlers || {};
    document.addEventListener('keydown', onKeyDown);
  }

  function setHandlers(newHandlers) {
    handlers = newHandlers || {};
  }

  // Magic Remote pointer acts like a mouse: hovering moves focus, click selects.
  function bindPointer(el, opts) {
    opts = opts || {};
    if (opts.onFocus) {
      el.addEventListener('mouseenter', function () {
        opts.onFocus();
      });
    }
    if (opts.onSelect) {
      el.addEventListener('click', function () {
        opts.onSelect();
      });
    }
  }

  window.Remote = {
    init: init,
    setHandlers: setHandlers,
    bindPointer: bindPointer
  };
})();

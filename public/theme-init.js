// Theme initialization - runs before React hydration to prevent flash
(function () {
  try {
    var t = localStorage.getItem('theme') || 'system';
    var isDark =
      t === 'dark' ||
      (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  } catch (e) {}
})();

// === iPad diagnostic ===
(function () {
  var log = [];
  var el = null;

  function show() {
    if (!document.body) return;
    if (!el) {
      el = document.createElement('div');
      el.id = '__diag';
      el.style.cssText =
        'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#991b1b;color:#fef2f2;' +
        'font:11px/1.5 monospace;padding:10px;max-height:40vh;overflow:auto;white-space:pre-wrap';
      document.body.appendChild(el);
    }
    el.textContent = log.join('\n');
  }

  // Catch script load failures (must use capture phase)
  window.addEventListener('error', function (e) {
    if (e.target && e.target.tagName === 'SCRIPT') {
      log.push('[SCRIPT_FAIL] ' + (e.target.src || 'inline').split('/').pop());
      show();
    } else if (e.message) {
      log.push('[JS_ERR] ' + e.message);
      show();
    }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var msg = e.reason ? (e.reason.message || String(e.reason)) : 'unknown';
    log.push('[PROMISE_ERR] ' + msg);
    show();
  });

  // After 8 seconds: if page is still not interactive, dump diagnostic
  setTimeout(function () {
    var stillLoading = document.body && document.body.innerHTML.indexOf('JS Loading') > -1;
    if (!stillLoading && log.length === 0) return; // all good, stay silent

    var scripts = document.querySelectorAll('script[src]');
    var nextScripts = 0;
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].src.indexOf('_next') > -1) nextScripts++;
    }

    log.unshift('--- CC Terminal diag (8s) ---');
    log.push('React hydrated: ' + (stillLoading ? 'NO' : 'YES'));
    log.push('Next.js scripts in DOM: ' + nextScripts);
    log.push('Page URL: ' + location.href);
    log.push('UA: ' + navigator.userAgent.slice(0, 100));
    show();
  }, 8000);
})();

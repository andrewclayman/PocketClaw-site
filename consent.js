// Cookie consent gate for the Meta Pixel. The fbq() queue is created up front so the
// page's tracking calls are always safe to make, but Meta's script (and its _fbp cookie)
// only loads after the visitor taps Accept. Vercel Web Analytics is cookieless and runs
// regardless. Any element with data-cookie-settings reopens the choice.
(function () {
  var PIXEL_ID = '1118270554468959', KEY = 'xan_consent';
  var w = window, d = document, loaded = false;

  if (!w.fbq) {
    var n = w.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!w._fbq) w._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
  }
  fbq('init', PIXEL_ID);
  fbq('track', 'PageView');

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function load() {
    if (loaded) { fbq('consent', 'grant'); return; }
    loaded = true;
    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    d.head.appendChild(s);
  }
  function clearCookies() {
    var root = location.hostname.replace(/^www\./, '');
    ['_fbp', '_fbc'].forEach(function (c) {
      d.cookie = c + '=; Max-Age=0; path=/';
      d.cookie = c + '=; Max-Age=0; path=/; domain=.' + root;
    });
  }

  function close() {
    var el = d.getElementById('xan-cc');
    if (el) el.remove();
    d.body.style.paddingBottom = '';
  }
  function choose(v) {
    store(v);
    if (v === 'granted') load();
    else { if (loaded) fbq('consent', 'revoke'); clearCookies(); }
    close();
  }

  function show() {
    if (d.getElementById('xan-cc')) return;
    if (!d.getElementById('xan-cc-css')) {
      var css = d.createElement('style');
      css.id = 'xan-cc-css';
      css.textContent =
        '#xan-cc{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:560px;margin:0 auto;' +
        'background:#171B19;color:#F0F2F0;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:16px 18px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.55);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}' +
        '#xan-cc p{margin:0 0 12px;color:#C9CFCB}#xan-cc strong{color:#F0F2F0}#xan-cc a{color:#55D3A4}' +
        '#xan-cc .row{display:flex;gap:10px}' +
        '#xan-cc button{flex:1;font:inherit;font-weight:600;padding:11px 14px;border-radius:999px;cursor:pointer;' +
        'background:transparent;color:#F0F2F0;border:1.5px solid rgba(255,255,255,.35)}' +
        '#xan-cc button[data-v=granted]{color:#55D3A4;border-color:#55D3A4}' +
        '#xan-cc button:focus-visible{outline:2px solid #9BEFCB;outline-offset:2px}';
      d.head.appendChild(css);
    }
    var el = d.createElement('div');
    el.id = 'xan-cc';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookie choice');
    el.innerHTML =
      '<p><strong>Allow advertising cookies?</strong> They let Meta tell us which Facebook and Instagram ads ' +
      'bring people here. Nothing from Meta loads unless you accept. <a href="/privacy.html#cookies">Privacy policy</a></p>' +
      '<div class="row"><button type="button" data-v="denied">Decline</button>' +
      '<button type="button" data-v="granted">Accept</button></div>';
    el.addEventListener('click', function (e) {
      var v = e.target.getAttribute && e.target.getAttribute('data-v');
      if (v) choose(v);
    });
    d.body.appendChild(el);
    d.body.style.paddingBottom = (el.offsetHeight + 24) + 'px';
  }

  d.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-cookie-settings]');
    if (t) { e.preventDefault(); show(); }
  });

  var choice = stored();
  if (choice === 'granted') load();
  else if (choice !== 'denied') {
    if (d.body) show(); else d.addEventListener('DOMContentLoaded', show);
  }
})();

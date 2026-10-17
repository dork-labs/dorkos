// Runs in <head>, before first paint: picks the theme and the motion setting
// so the page never flashes the wrong one.
//   theme:  ?theme= (the in-page toggle writes it too) > <meta name="vc-theme"> > server default
//   motion: ?motion=reduce|full > the OS setting
(function () {
  var D = window.__VC__ || {};
  var q = new URLSearchParams(location.search);
  var root = document.documentElement;
  var t = q.get('theme');
  if (t !== 'light' && t !== 'dark') t = D.theme === 'dark' ? 'dark' : 'light';
  root.classList.remove('light', 'dark');
  root.classList.add(t);
  root.style.colorScheme = t;
  if (q.has('shot')) root.classList.add('vc-shot');

  // Reduced motion can be forced either way from the frame. matchMedia is
  // wrapped so script-driven motion (Motion's useReducedMotion, a fragment's
  // own check) sees the forced value too; CSS media rules are rewritten by
  // helper.js once the stylesheets exist.
  var m = q.get('motion');
  window.__vcMotion = m === 'reduce' || m === 'full' ? m : null;
  var real = window.matchMedia.bind(window);
  var osReduce = real('(prefers-reduced-motion: reduce)');
  window.__vcReduced = function () {
    return window.__vcMotion ? window.__vcMotion === 'reduce' : osReduce.matches;
  };
  if (window.__vcReduced()) root.classList.add('vc-reduce');
  window.matchMedia = function (query) {
    var mql = real(query);
    if (!window.__vcMotion || !/prefers-reduced-motion/.test(query)) return mql;
    var wantsReduce = /reduce/.test(query);
    var matches = wantsReduce === (window.__vcMotion === 'reduce');
    return {
      matches: matches,
      media: query,
      onchange: null,
      addListener: function () {},
      removeListener: function () {},
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () {
        return false;
      },
    };
  };
})();

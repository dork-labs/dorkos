/* Director kit: the contract a prototype implements, and the bar that drives it.
 *
 *   Director.create({
 *     name: 'Settings',
 *     scenarios: [ // where you are: a pin made in one scenario hides in another
 *       { key: 'scale', label: 'Scale', options: [{ value: 'd1', label: 'Day one' }, '1', '3', '144'], default: '1' },
 *       { key: 'data', label: 'Data', options: Director.DATA, default: 'many' },
 *     ],
 *     lenses: [ // how it looks: pins stay put when a lens changes
 *       { key: 'theme', label: 'Theme', options: ['light', 'dark'], default: 'light' },
 *       { key: 'motion', label: 'Reduce motion', type: 'toggle' },
 *     ],
 *     states: [{ key: 'inbox', label: 'Inbox tray' }], // the states menu: one place each
 *     play: { label: 'Play the day', steps: [{ label: 'Morning', state: { scale: '1' } }, …] },
 *     apply(values, { changed }) { … render the page for these values … },
 *   });
 *
 * It renders the bar from that declaration (hidden to a handle until hover or
 * focus), keeps every non-default value in the URL, and exposes the contract the
 * review layer reads:
 *   window.director = { name, knobs, lenses, values, state(), go(state), describe(state), set(key, value) }
 * state() is plain data ({ scale: '3', theme: 'dark', state: 'inbox', step: 2 }),
 * so a note made today can be replayed headless tomorrow.
 *
 * Lenses `theme` and `motion` also set html[data-theme] and html[data-motion="reduce"],
 * so a prototype's CSS can follow them with no code.
 *
 * Opened with ?vc=<companion> (vc review open does that), it loads the review
 * layer from the companion, so pins and Send work with nothing else to wire.
 */
(() => {
  if (window.Director) return;
  const DATA = [
    { value: 'empty', label: 'Empty' },
    { value: 'one', label: 'One' },
    { value: 'many', label: 'Many' },
    { value: 'error', label: 'Error' },
    { value: 'offline', label: 'Offline' },
  ];
  const opt = (o) =>
    typeof o === 'object'
      ? { value: String(o.value), label: o.label || String(o.value) }
      : { value: String(o), label: String(o) };
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  const CSS = `
  :host { all: initial; }
  .d { --pop: hsl(40 20% 99.5%); --fg: hsl(0 0% 9%); --mut: hsl(0 0% 32%); --tint: hsl(30 8% 50% / .1); --tint2: hsl(30 8% 50% / .16);
    --ink: #B54403; --on-ink: #FFFAF5; --ring: hsl(24 90% 44%);
    --shadow: 0 1px 2px hsl(30 10% 10% / .08), 0 10px 28px hsl(30 10% 10% / .14); --out: cubic-bezier(0, 0, .2, 1);
    position: fixed; top: 10px; left: 12px; right: 12px; display: flex; justify-content: center; pointer-events: none; z-index: 2147482500;
    font: 500 12.5px/1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--fg); -webkit-font-smoothing: antialiased; }
  .d.dark { --pop: hsl(0 0% 11%); --fg: hsl(0 0% 90%); --mut: hsl(0 0% 66%); --tint: hsl(0 0% 100% / .07); --tint2: hsl(0 0% 100% / .12);
    --ink: #F5873D; --on-ink: hsl(0 0% 9%); --ring: hsl(24 88% 55%);
    --shadow: 0 0 0 1px hsl(0 0% 100% / .07), 0 1px 2px hsl(0 0% 0% / .4), 0 12px 32px hsl(0 0% 0% / .5); }
  .d.bottom { top: auto; bottom: 16px; justify-content: flex-start; }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; border-radius: 8px; min-height: 28px; padding: 0 10px; white-space: nowrap; }
  button:hover { background: var(--tint); }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 4px; border-radius: 12px; background: var(--pop); box-shadow: var(--shadow); pointer-events: auto; max-width: 100%; }
  .full { display: none; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .handle { display: inline-flex; align-items: center; gap: 8px; }
  .handle .now { color: var(--mut); font-weight: 400; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; }
  .handle svg { width: 14px; height: 14px; color: var(--mut); }
  .d:hover .full, .d:has(:focus-visible) .full, .d.open .full, .d.held .full { display: flex; animation: in 150ms var(--out); }
  /* A focused handle stays put (hiding it would drop focus); it hides once focus is inside. */
  .d:hover .handle, .d:has(.full :focus-visible) .handle, .d.open .handle, .d.held .handle { display: none; }
  @keyframes in { from { opacity: 0; transform: translateY(-3px); } }
  .name { font-weight: 650; padding: 0 6px 0 8px; }
  .play { background: var(--ink); color: var(--on-ink); font-weight: 600; }
  .play:hover { background: var(--ink); filter: brightness(1.08); }
  .steps { display: inline-flex; align-items: center; gap: 2px; }
  .steps .lbl { padding: 0 6px; font-variant-numeric: tabular-nums; }
  .steps button { min-width: 28px; padding: 0 6px; }
  .steps button:disabled { color: var(--mut); cursor: default; background: none; opacity: .7; }
  .group { display: inline-flex; align-items: center; gap: 6px; }
  .group > span { color: var(--mut); font-weight: 400; }
  .seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 9px; background: var(--tint); }
  .seg button { min-height: 24px; padding: 0 8px; border-radius: 7px; color: var(--mut); }
  .seg button:hover { color: var(--fg); background: none; }
  .seg button[aria-pressed="true"] { background: var(--pop); color: var(--fg); box-shadow: 0 1px 2px hsl(0 0% 0% / .14); }
  .tg { background: var(--tint); color: var(--mut); min-height: 28px; }
  .tg:hover { color: var(--fg); background: var(--tint2); }
  .tg[aria-pressed="true"] { background: var(--fg); color: var(--pop); }
  .menuwrap { position: relative; }
  .menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 200px; padding: 4px; border-radius: 12px; background: var(--pop); box-shadow: var(--shadow);
    display: grid; animation: in 150ms var(--out); }
  .menu[hidden] { display: none; }
  .menu button { text-align: left; min-height: 30px; }
  .menu button[aria-checked="true"] { font-weight: 650; }
  .menu button[aria-checked="true"]::before { content: '✓'; margin-right: 6px; }
  .menu .back { color: var(--mut); }
  .d.rm .full, .d.rm .menu { animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .full, .menu { animation: none !important; } }
  `;
  const CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function create(spec) {
    const scenarios = (spec.scenarios || []).map((k) => ({
      ...k,
      options: (k.options || []).map(opt),
      type: k.type || 'choice',
    }));
    const lenses = (spec.lenses || []).map((k) => ({
      ...k,
      options: (k.options || []).map(opt),
      type: k.type || (k.options ? 'choice' : 'toggle'),
    }));
    for (const k of [...scenarios, ...lenses])
      if (k.default === undefined)
        k.default = k.type === 'toggle' ? false : k.options[0] && k.options[0].value;
    const states = spec.states || [];
    const steps = (spec.play && spec.play.steps) || [];
    const all = [...scenarios, ...lenses];
    const byKey = Object.fromEntries(all.map((k) => [k.key, k]));

    // ---------- values, from the URL (non-defaults only live there)
    const values = {};
    const url = new URLSearchParams(location.search);
    for (const k of all) {
      const raw = url.get(k.key);
      if (k.type === 'toggle')
        values[k.key] = raw === null ? !!k.default : raw === '1' || raw === 'true';
      else
        values[k.key] =
          raw !== null && k.options.some((o) => o.value === raw) ? raw : String(k.default);
    }
    values.state = states.some((s) => s.key === url.get('state')) ? url.get('state') : null;
    values.step =
      steps.length && url.get('step') !== null && !isNaN(+url.get('step'))
        ? Math.min(steps.length - 1, Math.max(0, +url.get('step')))
        : null;

    function writeUrl() {
      const u = new URL(location.href);
      for (const k of all) {
        const v = values[k.key];
        if (k.type === 'toggle' ? !!v === !!k.default : String(v) === String(k.default))
          u.searchParams.delete(k.key);
        else u.searchParams.set(k.key, k.type === 'toggle' ? (v ? '1' : '0') : v);
      }
      if (values.state) u.searchParams.set('state', values.state);
      else u.searchParams.delete('state');
      if (values.step !== null) u.searchParams.set('step', values.step);
      else u.searchParams.delete('step');
      if (u.href !== location.href) history.replaceState(history.state, '', u);
    }

    function lensAttrs() {
      const de = document.documentElement;
      if (byKey.theme) de.dataset.theme = values.theme;
      if (byKey.motion) {
        if (values.motion) de.dataset.motion = 'reduce';
        else delete de.dataset.motion;
      }
    }

    // ---------- the contract
    const state = () => {
      const s = {};
      for (const k of all) s[k.key] = values[k.key];
      if (values.state) s.state = values.state;
      if (values.step !== null) s.step = values.step;
      return s;
    };
    const labelOf = (k, v) =>
      k.type === 'toggle'
        ? v
          ? k.label
          : null
        : (k.options.find((o) => o.value === String(v)) || { label: v }).label;
    function describe(s) {
      const out = [];
      for (const k of all) {
        if (!(k.key in s)) continue;
        const l = labelOf(k, s[k.key]);
        if (l) out.push(k.type === 'toggle' ? l : `${k.label} ${l}`);
      }
      if (s.state) out.push((states.find((x) => x.key === s.state) || { label: s.state }).label);
      if (s.step !== undefined && s.step !== null && steps[s.step])
        out.push(`step ${+s.step + 1} of ${steps.length}: ${steps[s.step].label}`);
      return out.join(' · ');
    }
    async function apply(changed) {
      writeUrl();
      lensAttrs();
      render();
      try {
        await (spec.apply && spec.apply({ ...values }, { changed, director: api }));
      } catch (e) {
        console.error('[director] apply failed', e);
      }
      window.dispatchEvent(
        new CustomEvent('director:change', { detail: { values: { ...values }, changed } })
      );
    }
    function set(key, v) {
      const changed = {};
      if (key === 'state') {
        values.state = v || null;
        values.step = null;
      } else if (key === 'step') {
        values.step =
          v === null || v === undefined ? null : Math.min(steps.length - 1, Math.max(0, +v));
        const st = values.step !== null && steps[values.step].state;
        if (st)
          for (const [k2, v2] of Object.entries(st))
            if (byKey[k2] || k2 === 'state') values[k2] = byKey[k2]?.type === 'toggle' ? !!v2 : v2;
      } else if (byKey[key]) {
        values[key] = byKey[key].type === 'toggle' ? !!v : String(v);
        // A new scenario is a new place: leave any open state and stop playing.
        if (scenarios.includes(byKey[key])) {
          values.state = null;
          values.step = null;
        }
      } else return Promise.resolve();
      changed[key] = v;
      return apply(changed);
    }
    // Put the page back exactly: unknown keys are ignored, missing ones reset.
    function go(s) {
      s = s || {};
      for (const k of all) {
        if (k.key in s) values[k.key] = k.type === 'toggle' ? !!s[k.key] : String(s[k.key]);
        else if (scenarios.includes(k)) values[k.key] = String(k.default);
      }
      values.state = s.state && states.some((x) => x.key === s.state) ? s.state : null;
      values.step = s.step !== undefined && s.step !== null && steps[s.step] ? +s.step : null;
      return apply({ go: true });
    }

    // ---------- the bar
    let host = null;
    let R = null;
    let menuOpen = false;
    function mount() {
      if (window.__studioShot) return; // screenshots and crops show the page, not the bar
      host = document.createElement('director-bar');
      host.style.cssText = 'position: fixed; z-index: 2147482500; display: block;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="d${spec.position === 'bottom' ? ' bottom' : ''}" role="region" aria-label="Prototype controls" data-director></div>`;
      R = root.querySelector('.d');
      document.body.appendChild(host);
      new MutationObserver(() => {
        if (!host.isConnected) document.body.appendChild(host);
      }).observe(document.body, { childList: true });
      R.addEventListener('click', onClick);
      R.addEventListener('focusout', (e) => {
        if (!R.contains(e.relatedTarget)) R.classList.remove('held');
      });
      R.addEventListener('pointerleave', () => {
        if (!R.querySelector(':focus-visible')) R.classList.remove('held');
      });
      R.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menuOpen) {
          e.stopPropagation();
          menu(false);
          R.querySelector('.statesbtn')?.focus();
        }
      });
      document.addEventListener('pointerdown', (e) => {
        if (menuOpen && !e.composedPath().includes(host)) menu(false);
      });
    }
    function seg(k) {
      if (k.type === 'toggle')
        return `<button type="button" class="tg" data-k="${esc(k.key)}" aria-pressed="${!!values[k.key]}">${esc(k.label)}</button>`;
      const b = k.options
        .map(
          (o) =>
            `<button type="button" data-k="${esc(k.key)}" data-v="${esc(o.value)}" aria-pressed="${String(values[k.key]) === o.value}">${esc(o.label)}</button>`
        )
        .join('');
      // Theme reads clearly without its label; everything else says what it is.
      return `<span class="group"${k.key === 'theme' ? '' : `><span>${esc(k.label)}</span`}><span class="seg" role="group" aria-label="${esc(k.label)}">${b}</span></span>`;
    }
    function nonDefault() {
      const out = [];
      for (const k of all) {
        const v = values[k.key];
        if (k.type === 'toggle' ? !!v !== !!k.default : String(v) !== String(k.default))
          out.push(labelOf(k, v) || k.label);
      }
      if (values.state) out.push((states.find((x) => x.key === values.state) || {}).label);
      return out.filter(Boolean);
    }
    function render() {
      if (!R) return;
      const keep = R.contains(R.getRootNode().activeElement) && R.getRootNode().activeElement;
      const keepSel =
        keep &&
        (keep.dataset.k
          ? `[data-k="${keep.dataset.k}"]${keep.dataset.v ? `[data-v="${keep.dataset.v}"]` : ''}`
          : keep.className
            ? '.' + keep.className.split(' ')[0]
            : null);
      const dark = byKey.theme
        ? values.theme === 'dark'
        : /\bdark\b/.test(document.documentElement.className);
      R.classList.toggle('dark', dark);
      R.classList.toggle(
        'rm',
        !!values.motion || matchMedia('(prefers-reduced-motion: reduce)').matches
      );
      R.classList.toggle('open', menuOpen);
      const playing = values.step !== null;
      const nd = nonDefault();
      const stepTxt = playing
        ? `${values.step + 1}/${steps.length} · ${steps[values.step].label}`
        : '';
      R.innerHTML =
        `<div class="bar">` +
        `<button type="button" class="handle" aria-label="Prototype controls: ${esc(spec.name || 'Prototype')}${nd.length ? ', ' + esc(nd.join(', ')) : ''}">` +
        `<span class="name">${esc(spec.name || 'Prototype')}</span>${playing ? `<span class="now">▶ ${esc(stepTxt)}</span>` : nd.length ? `<span class="now">${esc(nd.join(' · '))}</span>` : ''}${CHEVRON}</button>` +
        `<div class="full"><span class="name">${esc(spec.name || 'Prototype')}</span>` +
        (steps.length
          ? playing
            ? `<span class="steps" role="group" aria-label="Play"><button type="button" class="prev" aria-label="Previous step" ${values.step ? '' : 'disabled'}>‹</button><span class="lbl" aria-live="polite">${esc(stepTxt)}</span><button type="button" class="next" aria-label="Next step" ${values.step < steps.length - 1 ? '' : 'disabled'}>›</button><button type="button" class="stop" aria-label="Stop playing">✕</button></span>`
            : `<button type="button" class="play">▶ ${esc((spec.play && spec.play.label) || 'Play')}</button>`
          : '') +
        (states.length
          ? `<span class="menuwrap"><button type="button" class="statesbtn" aria-haspopup="menu" aria-expanded="${menuOpen}">${esc(values.state ? (states.find((x) => x.key === values.state) || {}).label : spec.statesLabel || 'States')} ▾</button>` +
            `<div class="menu" role="menu" aria-label="States"${menuOpen ? '' : ' hidden'}>${states.map((s) => `<button type="button" role="menuitemradio" aria-checked="${values.state === s.key}" data-state="${esc(s.key)}">${esc(s.label)}</button>`).join('')}` +
            `<button type="button" role="menuitem" class="back" data-state="">Back to the page</button></div></span>`
          : '') +
        scenarios.map(seg).join('') +
        lenses.map(seg).join('') +
        `</div></div>`;
      // Keep the keyboard where it was; if that control is gone (Play became the steps), stay in the bar.
      if (keep)
        (R.querySelector(keepSel) || R.querySelector('.full button:not([disabled])'))?.focus();
    }
    function menu(on) {
      menuOpen = on;
      render();
      if (on) R.querySelector('.menu button')?.focus();
    }
    function onClick(e) {
      const b = e.target.closest('button');
      if (!b) return;
      // The handle opens the bar and moves the keyboard into it; it stays open while focus is inside.
      if (b.classList.contains('handle')) {
        R.classList.add('held');
        return void R.querySelector('.full button:not([disabled])')?.focus();
      }
      if (b.classList.contains('play')) return void play(0);
      if (b.classList.contains('prev')) return void set('step', values.step - 1);
      if (b.classList.contains('next')) return void set('step', values.step + 1);
      if (b.classList.contains('stop')) return void set('step', null);
      if (b.classList.contains('statesbtn')) return void menu(!menuOpen);
      if (b.dataset.state !== undefined) {
        menuOpen = false;
        return void set('state', b.dataset.state || null);
      }
      if (b.dataset.k) {
        const k = byKey[b.dataset.k];
        return void set(k.key, k.type === 'toggle' ? !values[k.key] : b.dataset.v);
      }
    }
    function play(i) {
      return set('step', i);
    }

    const api = {
      name: spec.name || 'Prototype',
      knobs: { scenarios, lenses, states, play: spec.play || null },
      lenses: lenses.map((k) => k.key),
      get values() {
        return { ...values };
      },
      state,
      go,
      set,
      describe,
      play,
      stop: () => set('step', null),
    };
    window.director = api;
    const start = () => {
      mount();
      apply({ start: true });
      loadReview(spec);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    return api;
  }

  // With a companion to talk to, bring in the review layer from it.
  function loadReview(spec) {
    if (window.__review || window.__studioShot || spec.review === false) return;
    const q = new URLSearchParams(location.search);
    const vc = typeof spec.review === 'string' ? spec.review : q.get('vc');
    if (!vc) return;
    window.REVIEW_CONFIG = Object.assign(
      {
        name: spec.name,
        screen: q.get('review') || spec.screen || undefined,
        vc,
        sources: spec.sources || [],
      },
      window.REVIEW_CONFIG || {}
    );
    if (!window.REVIEW_CONFIG.screen) delete window.REVIEW_CONFIG.screen;
    const s = document.createElement('script');
    s.src = new URL('vc/review.js', vc.replace(/\/?$/, '/')).href;
    document.head.appendChild(s);
  }

  window.Director = { create, DATA };
})();

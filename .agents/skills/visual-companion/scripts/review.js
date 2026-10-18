/* Review layer: pick, pin and Send on any page, without touching its source.
 *
 * One implementation for every surface we show designs on:
 *   - companion fragments: the frame (helper.js) mounts it in the page itself and
 *     posts through its own event queue, so pins wake the chat like before
 *   - full prototypes: injected by a host page, loaded by the director kit, or
 *     pulled from the companion (<script src="…/vc/review.js">); it then lives in a
 *     shadow root, so the page's CSS can't reach it and it can't reach the page's
 *
 * What reaches the agent for each note:
 *   - the element: a unique selector, its role and accessible name, size and spot
 *   - where it lives in the source: data-src="file:line" stamps when the build
 *     made them (exact), else a grep of the configured sources (close)
 *   - the few computed styles that matter for a design note
 *   - the state the page was in (window.director, else a generic read), so the
 *     agent can put the page back the way the person saw it
 *   - intent (fix / refine / explore), and whether it's a request or just a note:
 *     only requests go on Send
 *   - a one-line text reference (`ref`) with the JSON beside it
 *
 * Config (window.REVIEW_CONFIG before it runs, or ?review=<screen>&vc=<url> on the
 * page or its same-origin host):
 *   name     what's being reviewed ("Settings")
 *   screen   stable key for the notes (localStorage, the companion's store)
 *   sources  [paths or {url, label}] searched when an element has no data-src
 *   vc       the companion's base URL; Send records there and can wake the agent
 *   agent    who Send reaches (?agent=, else the companion's route label)
 *   vt       the review's token (?vt= from `vc review open`): another origin
 *            can only post to the companion with it
 *   mount    'shadow' (default) or 'light' (the companion frame styles it)
 *   chrome   false hides the layer's own toolbar (the frame has its own)
 *   post     fn(event) → Promise; overrides how events reach the companion
 *   ignore   selector for host chrome that picking must leave alone
 *
 * Transport is one seam (see `transport()`): window.dorkos.channel when DorkOS's
 * Doc Channel is ready, else the companion, else the clipboard. A host can swap
 * the first in without touching the rest.
 */
(() => {
  if (window.__review || window.__studioShot) return;
  const qs = (() => {
    const out = new URLSearchParams(location.search);
    try {
      if (window.parent !== window)
        for (const [k, v] of new URLSearchParams(window.parent.location.search))
          if (!out.has(k)) out.set(k, v);
    } catch {
      // Best effort: nothing to do if this fails.
    }
    return out;
  })();
  const CFG = Object.assign(
    {
      name: document.title,
      screen: qs.get('review') || 'review:' + location.pathname,
      sources: [],
      vc: qs.get('vc') || null,
      agent: qs.get('agent') || null,
      vt: qs.get('vt') || null,
      mount: 'shadow',
      chrome: true,
      post: null,
      ignore: null,
    },
    window.REVIEW_CONFIG || {}
  );
  // Loaded from the companion itself: that's where Send goes.
  if (
    !CFG.vc &&
    document.currentScript &&
    /\/vc\/review\.js(\?|$)/.test(document.currentScript.src)
  )
    CFG.vc = document.currentScript.src.replace(/vc\/review\.js.*$/, '');
  const LIGHT = CFG.mount === 'light';
  const FRAME = !!CFG.post; // inside the companion frame: the server is the store
  const KEY = 'review:' + CFG.screen;
  const RM = () =>
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.motion === 'reduce' ||
    /\bvc-reduce\b/.test(document.documentElement.className);

  /* ------------------------------------------------------------ what the agent gets */

  const q1 = (s) => {
    try {
      return document.querySelectorAll(s).length === 1;
    } catch {
      return false;
    }
  };
  const attrv = (v) => v.replace(/["\\]/g, '\\$&');
  const KEYATTRS = [
    'data-testid',
    'data-proto',
    'data-choice',
    'data-go-place',
    'data-space',
    'data-crumb',
    'data-scn',
    'data-knob',
    'data-theme',
    'name',
    'aria-label',
  ];
  const NOISE = /^(is-|has-|vc-)|^(on|open|active|hidden|show|in|out|selected)$/;

  function own(n) {
    let s = n.localName;
    const cls = [...n.classList].filter((c) => !NOISE.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
    const p = n.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.localName === n.localName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
    }
    return s;
  }
  function selector(el, depth = 0) {
    if (el.id && q1('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const a of KEYATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 60) {
        const s = `${el.localName}[${a}="${attrv(v)}"]`;
        if (q1(s)) return s;
      }
    }
    const p = el.parentElement;
    if (!p || p === document.body || p === document.documentElement || depth > 8) return own(el);
    return selector(p, depth + 1) + ' > ' + own(el);
  }

  const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  function nameOf(el) {
    const l = el.getAttribute('aria-label');
    if (l) return clip(l, 80);
    const by = el.getAttribute('aria-labelledby');
    if (by)
      return clip(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
          .trim(),
        80
      );
    if (el.labels && el.labels[0]) return clip(el.labels[0].textContent.trim(), 80);
    if (el.placeholder) return clip(el.placeholder, 80);
    return clip(el.textContent.replace(/\s+/g, ' ').trim(), 80);
  }
  const ROLES = {
    button: 'button',
    a: 'link',
    input: 'textbox',
    textarea: 'textbox',
    select: 'combobox',
    nav: 'navigation',
    aside: 'complementary',
    main: 'main',
    header: 'banner',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    img: 'img',
    svg: 'img',
    ul: 'list',
    li: 'listitem',
    section: 'region',
    form: 'form',
    dialog: 'dialog',
  };
  const roleOf = (el) => el.getAttribute('role') || ROLES[el.localName] || null;

  const STYLE_KEYS = [
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'background-color',
    'padding',
    'border-radius',
    'gap',
    'opacity',
    'box-shadow',
  ];
  const DEFAULTS = /^(normal|none|0px|auto|rgba\(0, 0, 0, 0\)|1)$/;
  function stylesOf(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k);
      if (v && !DEFAULTS.test(v)) out[k] = clip(v, 80);
    }
    return out;
  }

  // Where an element lives in the source. A build stamp (data-src="file:line") is
  // exact and wins. Otherwise: its id, else the nearest class a source file
  // mentions; markup from html/js, style from css.
  let SRC = null;
  const srcList = () => CFG.sources.map((s) => (typeof s === 'string' ? { url: s, label: s } : s));
  const loadSources = () =>
    SRC ||
    (SRC = Promise.all(
      srcList().map((s) =>
        fetch(new URL(s.url, location.href))
          .then((r) => (r.ok ? r.text() : ''))
          .then((t) => ({ p: s.label, lines: t.split('\n') }))
          .catch(() => ({ p: s.label, lines: [] }))
      )
    ));
  function findIn(files, re, css) {
    for (const f of files) {
      if (/\.css$/.test(f.p) !== css) continue;
      const i = f.lines.findIndex((l) => re.test(l));
      if (i >= 0) return `${f.p}:${i + 1}`;
    }
    return null;
  }
  async function sourceOf(el) {
    const tagged = el.closest('[data-src], [data-source]');
    const out = {};
    if (tagged) {
      out.markup = tagged.getAttribute('data-src') || tagged.getAttribute('data-source');
      out.via = 'data-src' + (tagged !== el ? ' (' + hopsUp(el, tagged) + ' up)' : '');
      out.exact = true;
    }
    if (!CFG.sources.length) return out.markup ? out : null;
    const files = await loadSources();
    for (let n = el, hops = 0; n && n !== document.body && hops < 6; n = n.parentElement, hops++) {
      const tokens = [];
      const id = n.id && CSS.escape(n.id);
      if (id)
        tokens.push([
          '#' + n.id,
          new RegExp(`id="${id}"|['"]#${id}['"]`),
          new RegExp(`#${id}(?![\\w-])`),
        ]);
      for (const c of n.classList) {
        if (NOISE.test(c)) continue;
        const e = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        tokens.push([
          '.' + c,
          new RegExp(`class="[^"]*\\b${e}\\b|['"\` ]${e}['"\` ]`),
          new RegExp(`\\.${e}(?![\\w-])`),
        ]);
      }
      for (const [by, mre, sre] of tokens) {
        if (!out.markup) {
          const m = findIn(files, mre, false);
          if (m) {
            out.markup = m;
            out.via = by + (hops ? ` (${hops} up)` : '');
          }
        }
        if (!out.style) {
          const s = findIn(files, sre, true);
          if (s) out.style = s;
        }
      }
      if (out.markup && out.style) break;
    }
    return out.markup || out.style ? out : null;
  }
  function hopsUp(el, anc) {
    let n = 0;
    for (let x = el; x && x !== anc; x = x.parentElement) n++;
    return n;
  }

  function visible(el) {
    if (!el || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth
    );
  }
  function genericState() {
    const out = {};
    const reg = document.querySelector('[data-director], [role="region"][aria-label*="rototype"]');
    if (reg) {
      for (const b of reg.querySelectorAll('[aria-pressed="true"]')) {
        const g = b.closest('[role="group"]');
        if (g) out[g.getAttribute('aria-label') || 'group'] = b.textContent.trim();
        else out[b.textContent.trim()] = true;
      }
    }
    const cur = [...document.querySelectorAll('[aria-current="page"], [aria-current="true"]')]
      .filter(visible)
      .map((e) => nameOf(e))
      .filter(Boolean);
    if (cur.length) out.where = cur.join(' › ');
    const open = [
      ...document.querySelectorAll('[role="dialog"], [role="menu"], [role="complementary"]'),
    ]
      .filter((d) => !d.hidden && visible(d) && !reg?.contains(d) && !ours(d))
      .map((d) => d.getAttribute('aria-label'))
      .filter(Boolean);
    if (open.length) out.open = open;
    if (location.hash) out.hash = location.hash;
    return out;
  }
  function state() {
    try {
      if (window.director?.state) return window.director.state();
    } catch {
      // Best effort: nothing to do if this fails.
    }
    return genericState();
  }
  // Lenses change how the page looks, not where you are, so a pin stays put across them.
  const LENS = /theme|motion|speak|sound|transparen/i;
  const isLens = (k) =>
    window.director?.lenses ? window.director.lenses.includes(k) : LENS.test(k);
  // A pin belongs here if everything it remembers still holds; the page may have more open on top.
  const holds = (was, now) =>
    Object.keys(was || {}).every(
      (k) => isLens(k) || JSON.stringify(was[k]) === JSON.stringify(now[k])
    );
  const stateLine = (s) => {
    try {
      if (window.director?.describe) return window.director.describe(s || {});
    } catch {
      // Best effort: nothing to do if this fails.
    }
    return Object.entries(s || {})
      .map(([k, v]) => (v === true ? k : `${k}: ${Array.isArray(v) ? v.join(', ') : v}`))
      .join(' · ');
  };
  const placeOf = (s) => Object.fromEntries(Object.entries(s || {}).filter(([k]) => !isLens(k)));
  // The page's address, without the review token: it goes in notes and copied text.
  const topUrl = () => {
    let href;
    try {
      href = window.top.location.href;
    } catch {
      href = location.href;
    }
    const u = new URL(href);
    u.searchParams.delete('vt');
    return u.href;
  };

  // The one-line reference, for pasting into any agent (React Grab's idea).
  function refOf(p) {
    const what = p.role
      ? `${p.role}${p.name ? ` “${clip(p.name, 48)}”` : ''}`
      : p.name
        ? `“${clip(p.name, 48)}”`
        : null;
    const src = p.source && (p.source.markup || p.source.style);
    const st = stateLine(p.state);
    return [p.selector, what, src, st ? 'in ' + st : null].filter(Boolean).join(' · ');
  }

  async function describe(el, x, y) {
    const r = el.getBoundingClientRect();
    const d = {
      selector: selector(el),
      role: roleOf(el),
      name: nameOf(el),
      target: nameOf(el),
      tag: el.localName,
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      rel: {
        x: +((x - r.left) / (r.width || 1)).toFixed(4),
        y: +((y - r.top) / (r.height || 1)).toFixed(4),
      },
      x: Math.round(x + scrollX),
      y: Math.round(y + scrollY),
      styles: stylesOf(el),
      source: await sourceOf(el),
      state: state(),
      theme: themeName(),
      viewport: { w: innerWidth, h: innerHeight },
      page: topUrl(),
    };
    if (window.top !== window) d.frame = location.href;
    return d;
  }

  /* ------------------------------------------------------------ the layer's look */

  // DorkOS tokens as literals, so the layer looks the same on a page that has none.
  // Inks are the style guide's AA oranges.
  const CSS_TEXT = `
  .vc-r { --vr-pop: hsl(40 20% 99.5%); --vr-fg: hsl(0 0% 9%); --vr-mut: hsl(0 0% 32%); --vr-tint: hsl(30 8% 50% / .1); --vr-tint2: hsl(30 8% 50% / .16);
    --vr-ink: #B54403; --vr-on-ink: #FFFAF5; --vr-ok: hsl(152 69% 24%); --vr-bad: hsl(0 72% 42%); --vr-ring: hsl(24 90% 44%);
    --vr-shadow: 0 1px 2px hsl(30 10% 10% / .08), 0 10px 28px hsl(30 10% 10% / .14);
    --vr-out: cubic-bezier(0, 0, .2, 1); --vr-in: cubic-bezier(.4, 0, 1, 1);
    position: fixed; inset: 0; pointer-events: none; z-index: 2147482000; display: block;
    font: 400 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--vr-fg);
    -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal; text-transform: none; }
  .vc-r.vc-dark { --vr-pop: hsl(0 0% 11%); --vr-fg: hsl(0 0% 90%); --vr-mut: hsl(0 0% 66%); --vr-tint: hsl(0 0% 100% / .07); --vr-tint2: hsl(0 0% 100% / .12);
    --vr-ink: #F5873D; --vr-on-ink: hsl(0 0% 9%); --vr-ok: hsl(152 60% 55%); --vr-bad: hsl(0 85% 70%); --vr-ring: hsl(24 88% 55%);
    --vr-shadow: 0 0 0 1px hsl(0 0% 100% / .07), 0 1px 2px hsl(0 0% 0% / .4), 0 12px 32px hsl(0 0% 0% / .5); }
  .vc-r *, .vc-r *::before, .vc-r *::after { box-sizing: border-box; }
  .vc-r button, .vc-r textarea { font: inherit; color: inherit; margin: 0; letter-spacing: inherit; }
  .vc-r button { border: 0; background: none; cursor: pointer; border-radius: 8px; min-height: 28px; padding: 0 10px; }
  .vc-r button:focus-visible, .vc-r textarea:focus-visible { outline: 2px solid var(--vr-ring); outline-offset: 1px; }
  .vc-r kbd { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--vr-mut); margin-left: 6px; }
  .vc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* picking */
  .vc-rbox { position: fixed; pointer-events: none; border-radius: 4px; display: none;
    box-shadow: 0 0 0 1.5px var(--vr-ink), 0 0 0 4px color-mix(in srgb, var(--vr-ink) 18%, transparent); background: color-mix(in srgb, var(--vr-ink) 6%, transparent); }
  .vc-rchip { position: absolute; left: -2px; bottom: calc(100% + 6px); white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis;
    background: var(--vr-ink); color: var(--vr-on-ink); font: 11.5px/1.2 ui-monospace, 'SF Mono', Menlo, monospace; padding: 4px 6px; border-radius: 6px; }
  .vc-rchip.vc-below { bottom: auto; top: calc(100% + 6px); }
  .vc-rchip.vc-end { left: auto; right: -2px; }

  /* pins: a request is ink, a private note is neutral, a done one recedes */
  .vc-pins { position: absolute; inset: 0; pointer-events: none; }
  .vc-r .vc-pin { position: fixed; display: grid; place-items: center; width: 24px; height: 24px; min-height: 0; margin: -12px 0 0 -12px; padding: 0;
    border-radius: 999px 999px 999px 4px; background: var(--vr-ink); color: var(--vr-on-ink); font: 650 11px/1 system-ui, -apple-system, sans-serif;
    font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px var(--vr-pop), var(--vr-shadow); pointer-events: auto; cursor: pointer;
    transform-origin: 0 100%; animation: vc-pin-in 200ms var(--vr-out); }
  .vc-r .vc-pin[hidden] { display: none; }
  .vc-r .vc-pin[data-kind="note"] { background: var(--vr-fg); color: var(--vr-pop); }
  .vc-r .vc-pin[data-status="resolved"], .vc-r .vc-pin[data-status="dismissed"] { background: var(--vr-pop); color: var(--vr-mut); box-shadow: 0 0 0 1.5px var(--vr-tint2), var(--vr-shadow); }
  .vc-r .vc-pin[data-status="resolved"] { color: var(--vr-ok); }
  .vc-r .vc-pin svg { width: 13px; height: 13px; }
  .vc-r .vc-pin[data-draft] { animation: vc-pin-in 200ms var(--vr-out); }
  @keyframes vc-pin-in { from { opacity: 0; transform: scale(.6); } }
  /* the agent's one-line reply rides beside a resolved pin when you point at it */
  .vc-reply { position: fixed; max-width: 280px; padding: 6px 10px; border-radius: 10px; background: var(--vr-pop); color: var(--vr-fg);
    box-shadow: var(--vr-shadow); font-size: 12.5px; pointer-events: none; animation: vc-rise 150ms var(--vr-out); }
  .vc-reply b { color: var(--vr-ok); font-weight: 600; }

  /* the note */
  .vc-note { position: fixed; width: 344px; padding: 10px; border-radius: 12px; background: var(--vr-pop); color: var(--vr-fg); box-shadow: var(--vr-shadow);
    pointer-events: auto; cursor: auto; animation: vc-rise 150ms var(--vr-out); }
  .vc-note * { cursor: auto; }
  .vc-note button { cursor: pointer; }
  .vc-note-tgt { display: flex; gap: 8px; font: 11px/1.35 ui-monospace, 'SF Mono', Menlo, monospace; color: var(--vr-mut); margin: 0 2px 8px; }
  .vc-note-tgt span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vc-note-tgt span + span { flex: none; margin-left: auto; }
  .vc-note textarea { display: block; width: 100%; min-height: 64px; padding: 8px 10px; border: 0; border-radius: 8px; background: var(--vr-tint); resize: vertical; }
  .vc-note textarea::placeholder { color: var(--vr-mut); opacity: 1; }
  .vc-note-text { padding: 2px 2px 8px; white-space: pre-wrap; word-break: break-word; }
  .vc-note-meta { padding: 0 2px 6px; color: var(--vr-mut); font-size: 11.5px; }
  .vc-note-reply { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: var(--vr-tint); font-size: 12.5px; }
  .vc-note-reply b { color: var(--vr-ok); font-weight: 600; }
  .vc-note-opts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; margin-top: 8px; }
  .vc-seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 9px; background: var(--vr-tint); }
  .vc-seg button { min-height: 24px; padding: 0 8px; border-radius: 7px; font-size: 12px; color: var(--vr-mut); }
  .vc-seg button:hover { color: var(--vr-fg); }
  .vc-seg button[aria-pressed="true"] { background: var(--vr-pop); color: var(--vr-fg); box-shadow: 0 1px 2px hsl(0 0% 0% / .12); }
  .vc-note-actions { display: flex; justify-content: flex-end; align-items: center; gap: 6px; margin-top: 8px; }
  .vc-note-actions .vc-hintk { margin-right: auto; color: var(--vr-mut); font-size: 11.5px; }
  .vc-note button:not(.vc-seg button), .vc-rpanel .vc-act { color: var(--vr-mut); font-size: 12px; font-weight: 500; }
  .vc-note button:not(.vc-seg button):hover { background: var(--vr-tint); color: var(--vr-fg); }
  .vc-r .vc-primary, .vc-r .vc-note button.vc-primary { background: var(--vr-fg); color: var(--vr-pop); font-weight: 600; }
  .vc-r .vc-primary.vc-ask, .vc-r .vc-note button.vc-primary.vc-ask { background: var(--vr-ink); color: var(--vr-on-ink); }
  .vc-r .vc-note button.vc-primary:hover { background: var(--vr-fg); color: var(--vr-pop); filter: brightness(1.15); }
  .vc-r .vc-note button.vc-primary.vc-ask:hover { background: var(--vr-ink); color: var(--vr-on-ink); }
  @keyframes vc-rise { from { opacity: 0; transform: translateY(4px); } }

  /* the hint while picking (sits above the companion's reply dock) */
  .vc-hint { position: fixed; left: 50%; bottom: 16px; max-width: min(560px, calc(100vw - 32px)); padding: 8px 14px; border-radius: 10px;
    background: var(--vr-pop); color: var(--vr-fg); box-shadow: var(--vr-shadow); font: 500 13px/20px system-ui, -apple-system, sans-serif;
    opacity: 0; transform: translate(-50%, 4px); pointer-events: none; transition: opacity 150ms var(--vr-in), transform 150ms var(--vr-in); }
  .vc-hint.vc-show { opacity: 1; transform: translate(-50%, 0); transition: opacity 200ms var(--vr-out), transform 200ms var(--vr-out); }
  .vc-hint span { color: var(--vr-mut); }
  .vc-r.vc-has-bar .vc-hint { bottom: 64px; }
  html.vc-has-send .vc-hint { bottom: 120px; }

  /* the toolbar: a handle at rest ("Review · 3"), the full set on hover or focus */
  .vc-rbar { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 12px;
    background: var(--vr-pop); box-shadow: var(--vr-shadow); pointer-events: auto; }
  .vc-rbar button:hover { background: var(--vr-tint); }
  .vc-rbar .vc-rfull { display: none; align-items: center; gap: 2px; }
  .vc-rbar:hover .vc-rfull, .vc-rbar:has(:focus-visible) .vc-rfull, .vc-r.vc-picking .vc-rfull, .vc-r.vc-paneled .vc-rfull { display: flex; }
  .vc-rbar:hover .vc-rhandle, .vc-rbar:has(.vc-rfull :focus-visible) .vc-rhandle, .vc-r.vc-picking .vc-rhandle, .vc-r.vc-paneled .vc-rhandle { display: none; }
  .vc-rhandle { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
  .vc-rhandle svg, .vc-rbar svg { width: 15px; height: 15px; }
  .vc-rcount { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--vr-ink); color: var(--vr-on-ink); font-size: 11px; font-weight: 650; }
  .vc-rcount[data-n="0"], .vc-rcount.vc-quiet { background: var(--vr-tint2); color: var(--vr-fg); }
  .vc-rbar button[aria-pressed="true"] { background: var(--vr-fg); color: var(--vr-pop); }
  .vc-rbar button[aria-pressed="true"] kbd { color: inherit; opacity: .8; }
  .vc-rbar .vc-rsend { background: var(--vr-ink); color: var(--vr-on-ink); font-weight: 600; }
  .vc-rbar .vc-rsend:hover { background: var(--vr-ink); filter: brightness(1.08); }
  .vc-rbar .vc-rsend:disabled { background: var(--vr-tint2); color: var(--vr-mut); cursor: default; filter: none; }

  /* the notes panel */
  .vc-rpanel { position: fixed; right: 16px; bottom: 64px; width: 400px; max-width: calc(100vw - 32px); max-height: min(72vh, 600px); overflow: auto;
    padding: 10px; border-radius: 14px; background: var(--vr-pop); box-shadow: var(--vr-shadow); pointer-events: auto; animation: vc-rise 200ms var(--vr-out); }
  .vc-rpanel h2 { margin: 2px 4px 8px; font-size: 13px; font-weight: 650; }
  .vc-rpanel ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .vc-rpanel li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; padding: 8px 6px; border-radius: 10px; }
  .vc-rpanel li:hover { background: var(--vr-tint); }
  .vc-rpanel .vc-n { width: 22px; height: 22px; border-radius: 999px 999px 999px 4px; background: var(--vr-ink); color: var(--vr-on-ink); font-size: 11px; font-weight: 650; display: grid; place-items: center; }
  .vc-rpanel li[data-kind="note"] .vc-n { background: var(--vr-fg); color: var(--vr-pop); }
  .vc-rpanel li.vc-away .vc-n { background: var(--vr-tint2); color: var(--vr-fg); }
  .vc-rpanel li[data-status="resolved"] .vc-n, .vc-rpanel li[data-status="dismissed"] .vc-n { background: var(--vr-tint); color: var(--vr-ok); }
  .vc-rpanel li[data-status="dismissed"] .vc-n { color: var(--vr-mut); }
  .vc-rpanel li[data-status="dismissed"] p { text-decoration: line-through; color: var(--vr-mut); }
  .vc-rpanel p { margin: 0; }
  .vc-rpanel small { display: block; color: var(--vr-mut); font: 11px/1.4 ui-monospace, 'SF Mono', Menlo, monospace; margin-top: 2px; overflow-wrap: anywhere; }
  .vc-rpanel .vc-tag { display: inline-block; margin-right: 6px; font: 600 10.5px/1 system-ui, sans-serif; letter-spacing: .02em; color: var(--vr-mut); }
  .vc-rpanel .vc-said { margin-top: 4px; font-size: 12.5px; }
  .vc-rpanel .vc-said b { color: var(--vr-ok); font-weight: 600; }
  .vc-rpanel .vc-acts { display: flex; flex-direction: column; gap: 2px; }
  .vc-rpanel .vc-act { min-height: 24px; padding: 0 8px; }
  .vc-rpanel .vc-act:hover { color: var(--vr-fg); background: var(--vr-tint); }
  .vc-rpanel .vc-empty { color: var(--vr-mut); margin: 4px 4px 10px; }
  .vc-rpanel textarea { display: block; width: 100%; min-height: 52px; margin-top: 8px; padding: 8px 10px; border: 0; border-radius: 8px; background: var(--vr-tint); resize: vertical; }
  .vc-rpanel textarea::placeholder { color: var(--vr-mut); opacity: 1; }
  .vc-rpanel .vc-row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 8px; }
  .vc-rpanel .vc-row .vc-act { min-height: 28px; }
  .vc-rtoast { position: fixed; right: 16px; bottom: 16px; max-width: 360px; background: var(--vr-fg); color: var(--vr-pop); padding: 8px 12px; border-radius: 10px;
    pointer-events: none; animation: vc-rise 200ms var(--vr-out); }

  /* where the notes are: one dot vocabulary for the toolbar and the panel */
  .vc-rdot { display: inline-block; width: 8px; height: 8px; border-radius: 99px; flex: none; background: var(--vr-mut); }
  .vc-rdot[hidden] { display: none; }
  [data-k="sending"] > .vc-rdot, .vc-rdot[data-k="sending"], [data-k="queued"] > .vc-rdot, .vc-rdot[data-k="queued"],
  [data-k="sending"] h3 .vc-rdot, [data-k="queued"] h3 .vc-rdot { background: none; box-shadow: inset 0 0 0 1.5px var(--vr-mut); }
  [data-k="with"] > .vc-rdot, .vc-rdot[data-k="with"], [data-k="with"] h3 .vc-rdot,
  [data-k="waiting"] > .vc-rdot, .vc-rdot[data-k="waiting"], [data-k="waiting"] h3 .vc-rdot { background: var(--vr-fg); }
  [data-k="onit"] > .vc-rdot, .vc-rdot[data-k="onit"], [data-k="onit"] h3 .vc-rdot { background: var(--vr-ink); animation: vc-breathe 1.6s ease-in-out infinite; }
  [data-k="blocked"] > .vc-rdot, .vc-rdot[data-k="blocked"], [data-k="blocked"] h3 .vc-rdot { background: var(--vr-ink); box-shadow: 0 0 0 3px var(--vr-tint2); }
  [data-k="done"] > .vc-rdot, [data-k="done"] h3 .vc-rdot { background: var(--vr-ok); }
  [data-k="failed"] > .vc-rdot, .vc-rdot[data-k="failed"], [data-k="failed"] h3 .vc-rdot { background: var(--vr-bad); }
  @keyframes vc-breathe { 50% { opacity: .35; } }
  .vc-rhandle .vc-rdot { margin-left: -2px; }
  .vc-rbar .vc-rstat { display: inline-flex; align-items: center; gap: 7px; font-weight: 550; white-space: nowrap; }
  .vc-rbar .vc-rstat[hidden], .vc-rbar .vc-rsend[hidden], .vc-rcount[hidden] { display: none; }
  .vc-rbar .vc-rstat[data-k="failed"] { color: var(--vr-bad); }
  .vc-rbar .vc-rstat[data-k="done"] { color: var(--vr-ok); }
  .vc-rpanel .vc-grp { margin-top: 10px; padding-top: 10px; box-shadow: 0 -1px 0 var(--vr-tint); }
  .vc-rpanel .vc-grp:first-of-type { margin-top: 0; padding-top: 0; box-shadow: none; }
  .vc-rpanel .vc-compose + .vc-grp { margin-top: 14px; }
  .vc-rpanel .vc-grp + .vc-compose { margin-top: 12px; padding-top: 10px; box-shadow: 0 -1px 0 var(--vr-tint); }
  .vc-rpanel .vc-grp + .vc-compose textarea { min-height: 40px; margin-top: 0; }
  .vc-rpanel .vc-grp header { display: flex; align-items: center; gap: 8px; margin: 0 4px 4px; min-height: 28px; border-radius: 6px; }
  .vc-rpanel .vc-grp header:focus-visible { outline: 2px solid var(--vr-ring); outline-offset: 2px; }
  .vc-rpanel .vc-grp h3 { display: flex; align-items: center; gap: 8px; margin: 0; margin-right: auto; font-size: 12px; font-weight: 650; color: var(--vr-fg); }
  .vc-rpanel .vc-grp-line { margin: 0 4px 6px; color: var(--vr-mut); font-size: 12.5px; }
  .vc-rpanel .vc-grp[data-k="failed"] .vc-grp-line, .vc-rpanel .vc-why { color: var(--vr-bad); }
  .vc-rpanel .vc-why { margin-top: 4px; font-size: 12px; }
  .vc-rpanel li[data-state="sending"] .vc-n, .vc-rpanel li[data-state="queued"] .vc-n, .vc-rpanel li[data-state="with"] .vc-n,
  .vc-rpanel li[data-state="onit"] .vc-n, .vc-rpanel li[data-state="blocked"] .vc-n, .vc-rpanel li[data-state="waiting"] .vc-n { background: var(--vr-tint2); color: var(--vr-fg); }
  .vc-rpanel li[data-state="failed"] .vc-n { background: none; color: var(--vr-bad); box-shadow: inset 0 0 0 1.5px var(--vr-bad); }
  .vc-rpanel .vc-foot { margin-right: auto; color: var(--vr-mut); font-size: 12.5px; }
  .vc-rpanel .vc-row [hidden] { display: none; }

  /* reduced motion: movement becomes an instant change */
  .vc-r.vc-rm *, .vc-r.vc-rm *::before { animation: none !important; transition: opacity 100ms linear !important; transform: none !important; }
  .vc-r.vc-rm .vc-hint { transform: translate(-50%, 0) !important; }
  @media (prefers-reduced-motion: reduce) { .vc-r *, .vc-r *::before { animation: none !important; } }
  `;

  const ICON = {
    pin: '<path d="M19.914 11.105A7.298 7.298 0 0 0 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32 32 0 0 0 .824-.738"/><circle cx="12" cy="10" r="3"/><path d="M16 18h6"/><path d="M19 15v6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  const icon = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /* ------------------------------------------------------------ mounting */

  let host, root;
  if (LIGHT) {
    // The companion frame: in the page, under its chrome layer, so its tests and
    // axe see it like any other chrome.
    if (!document.getElementById('vc-review-css')) {
      const st = document.createElement('style');
      st.id = 'vc-review-css';
      st.textContent = '@layer vc-chrome {' + CSS_TEXT + '}';
      document.head.appendChild(st);
    }
    host = document.createElement('div');
    host.className = 'vc-review';
    root = host;
  } else {
    host = document.createElement('review-layer');
    host.style.cssText =
      'position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; display: block;';
    root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = ':host { all: initial; }' + CSS_TEXT;
    root.appendChild(st);
  }
  const R = document.createElement('div');
  R.className = 'vc-r';
  R.innerHTML = `<div class="vc-rbox"><span class="vc-rchip"></span></div><div class="vc-pins" role="group" aria-label="Pinned notes"></div>`;
  root.appendChild(R);
  // In <body>, so audits (axe) and the page's own stacking see it; put back if a page rewrites its body.
  document.body.appendChild(host);
  new MutationObserver(() => {
    if (!host.isConnected) document.body.appendChild(host);
  }).observe(document.body, { childList: true });
  const $ = (s) => R.querySelector(s);
  const box = $('.vc-rbox');
  const chip = $('.vc-rchip');
  const pinLayer = $('.vc-pins');
  const ours = (x) => {
    const path = x.composedPath ? x.composedPath() : [];
    if (x.composedPath)
      return (
        path.includes(host) ||
        (CFG.ignore && path.some((n) => n instanceof Element && n.matches(CFG.ignore)))
      );
    return host.contains(x) || (CFG.ignore && x.closest && !!x.closest(CFG.ignore));
  };

  function themeName() {
    if (window.director?.values?.theme)
      return window.director.values.theme === 'dark' ? 'dark' : 'light';
    const de = document.documentElement;
    if (
      /(^|[-\s])dark\b/.test(de.className + ' ' + (document.body?.className || '')) ||
      de.dataset.theme === 'dark'
    )
      return 'dark';
    if (de.dataset.theme === 'light' || /(^|\s)light\b/.test(de.className)) return 'light';
    const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (let n = mid; n; n = n.parentElement) {
      if (n === host) break;
      const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      if (m && m.length >= 3 && (m[3] === undefined || +m[3] > 0.5))
        return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] < 128 ? 'dark' : 'light';
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function theme() {
    R.classList.toggle('vc-dark', themeName() === 'dark');
    R.classList.toggle('vc-rm', RM());
  }

  /* ------------------------------------------------------------ the notes */

  // A note: { n, id, note, kind: 'request'|'note', intent: 'fix'|'refine'|'explore',
  //   status: 'open'|'resolved'|'dismissed', reply, …describe() }
  let pins = [];
  const nextN = () => pins.reduce((m, p) => Math.max(m, p.n), 0) + 1;
  const requests = () =>
    pins.filter((p) => !p.draft && p.kind !== 'note' && (p.status || 'open') === 'open');
  const saveLocal = () => {
    if (FRAME) return;
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify(
          pins
            .filter((p) => !p.draft)
            .map((p) => {
              const kept = { ...p };
              delete kept._sending;
              return kept;
            })
        )
      );
    } catch {
      // Best effort: nothing to do if this fails.
    }
  };
  const loadLocal = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  };

  /* ------------------------------------------------------------ transport: the one seam */

  // DorkOS's Doc Channel (when it's ready), the companion (today), or the clipboard.
  function channel() {
    for (const w of [window, window.parent]) {
      try {
        const c = w.dorkos?.channel;
        if (c && c.status === 'ready' && c.emit) return c;
      } catch {
        // Best effort: nothing to do if this fails.
      }
    }
    return null;
  }
  const vcBase = () => (CFG.vc ? CFG.vc.replace(/\/?$/, '/') : null);
  function post(ev) {
    if (CFG.post) return Promise.resolve(CFG.post(ev));
    // text/plain is a simple request: no preflight, so a page on another port can post.
    // From another origin the companion takes it only with this review's token (vt).
    return fetch(new URL('vc/event', vcBase()), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(
        Object.assign(
          { screen: CFG.screen, theme: themeName(), timestamp: Date.now() },
          CFG.vt ? { vt: CFG.vt } : {},
          ev
        )
      ),
    }).then(async (r) => {
      if (r.ok) return r.json().catch(() => ({}));
      const body = await r.json().catch(() => ({}));
      const err = new Error('HTTP ' + r.status);
      err.reason = r.status === 403 && body.error === 'stale-link' ? 'stale-link' : 'refused-vc';
      throw err;
    });
  }
  const pinsUrl = () =>
    (FRAME ? 'vc/pins?screen=' : new URL('vc/pins', vcBase()) + '?screen=') +
    encodeURIComponent(CFG.screen) +
    '&poll=1';
  // The wire form of a note: everything describe() found, plus what the person said.
  const wire = (p) => {
    const w = { ...p };
    for (const k of ['draft', 'away', 'marker', 'posted']) delete w[k];
    w.ref = refOf(p);
    return w;
  };
  const transport = {
    kind: () => (channel() ? 'channel' : FRAME || CFG.vc ? 'companion' : 'local'),
    // A saved note. In the frame it's recorded at once (and a request on a wake
    // screen wakes the chat, as pins always have); elsewhere notes wait for Send.
    async saved(p) {
      if (FRAME) return post(Object.assign({ type: 'pin' }, wire(p)));
    },
    async removed(p) {
      const ch = channel();
      if (ch) return ch.emit('review.delete', { screen: CFG.screen, n: p.n }).catch(() => {});
      if (FRAME || (CFG.vc && p.posted))
        return post({ type: 'pin-delete', n: p.n }).catch(() => {});
    },
    async send(pl, fresh) {
      const ch = channel();
      if (ch) {
        await ch.emit('review.send', pl, { id: 'review-' + CFG.screen + '-' + Date.now() });
        return 'channel';
      }
      if (FRAME || CFG.vc) {
        for (const p of fresh) await post(Object.assign({ type: 'pin', quiet: true }, wire(p)));
        await post({ type: 'send', selection: [], message: pl.message || undefined, review: pl });
        return 'companion';
      }
      await navigator.clipboard.writeText(markdown(pl));
      return 'clipboard';
    },
    // What the store knows: status and the agent's reply, per note.
    async load() {
      if (!FRAME && !CFG.vc) return null;
      const r = await fetch(pinsUrl(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
  };

  /* ------------------------------------------------------------ picking */

  let picking = false;
  let hover = null;
  let stack = [];
  let hintEl = null;
  function hint(text) {
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'vc-hint';
      hintEl.setAttribute('role', 'status');
      hintEl.setAttribute('aria-live', 'polite');
      R.appendChild(hintEl);
    }
    if (text) {
      hintEl.innerHTML = text;
      void hintEl.offsetWidth;
      hintEl.classList.add('vc-show');
    } else hintEl.classList.remove('vc-show');
  }
  function setPicking(on) {
    if (!on && pop) closePop(true);
    picking = on;
    hover = null;
    stack = [];
    R.classList.toggle('vc-picking', on);
    if (LIGHT) document.documentElement.classList.toggle('vc-pinning', on);
    else document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (bar) bar.querySelector('.vc-rpick').setAttribute('aria-pressed', String(on));
    if (!on) box.style.display = 'none';
    hint(
      on ? 'Click anything to pin a note <span>· ↑ ↓ widen or narrow · Esc to finish</span>' : null
    );
    emit('review:picking', on);
  }
  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
  function frame(el) {
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });
    const nm = nameOf(el);
    chip.textContent = `${selector(el).split(' > ').pop()}${nm ? ` · “${clip(nm, 32)}”` : ''} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    chip.classList.toggle('vc-below', r.top < 30);
    chip.classList.toggle('vc-end', r.left + Math.min(chip.offsetWidth, 420) > innerWidth - 8);
  }
  const under = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host && !host.contains(el) && !(CFG.ignore && el.closest(CFG.ignore))
      ? el
      : null;
  };
  addEventListener(
    'pointermove',
    (e) => {
      if (!picking || pop || ours(e)) return;
      const el = under(e.clientX, e.clientY);
      if (el && el !== hover && !stack.length) {
        hover = el;
        frame(el);
      }
    },
    true
  );
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
    addEventListener(
      t,
      (e) => {
        if (picking && !ours(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  addEventListener(
    'click',
    (e) => {
      if (!picking || ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = (stack.length && hover) || under(e.clientX, e.clientY) || hover;
      if (el) openDraft(el, e.clientX, e.clientY);
    },
    true
  );

  /* ------------------------------------------------------------ the note popover */

  let pop = null;
  let draft = null;
  let lastIntent = 'fix'; // intent carries over to the next note; "just a note" never does
  function place(el, x, y) {
    const w = 344;
    let left = x + 18;
    if (left + w > innerWidth - 12) left = x - w - 18;
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.min(Math.max(8, y - 12), innerHeight - el.offsetHeight - 8) + 'px';
  }
  function closePop(dropDraft) {
    if (pop) pop.remove();
    pop = null;
    if (dropDraft && draft) {
      pins = pins.filter((p) => p !== draft);
      draft = null;
      render();
    }
  }
  async function openDraft(el, x, y) {
    closePop(true);
    box.style.display = 'none';
    const d = await describe(el, x, y);
    const n = nextN();
    draft = Object.assign(
      {
        n,
        id: Math.random().toString(36).slice(2, 10),
        note: '',
        kind: 'request',
        intent: lastIntent,
        status: 'open',
      },
      d,
      { at: Date.now(), draft: true }
    );
    pins.push(draft);
    render();
    pop = document.createElement('div');
    pop.className = 'vc-note';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Note ' + n);
    const what = d.role
      ? d.role + (d.name ? ` “${clip(d.name, 36)}”` : '')
      : d.name
        ? `“${clip(d.name, 40)}”`
        : d.selector.split(' > ').pop();
    const where = d.source && (d.source.markup || d.source.style);
    pop.innerHTML =
      `<div class="vc-note-tgt"><span>${esc(what)}</span>${where ? `<span>${esc(where)}</span>` : ''}</div>` +
      `<label class="vc-sr" for="vc-note-input">Note ${n}</label>` +
      `<textarea id="vc-note-input" rows="3" placeholder="What should change here?"></textarea>` +
      `<div class="vc-note-opts">` +
      `<div class="vc-seg vc-kind" role="group" aria-label="Who it's for"><button type="button" data-kind="request">Ask ${esc(CFG.agent)}</button><button type="button" data-kind="note">Just a note</button></div>` +
      `<div class="vc-seg vc-intent" role="group" aria-label="Intent"><button type="button" data-intent="fix">Fix</button><button type="button" data-intent="refine">Refine</button><button type="button" data-intent="explore">Explore</button></div>` +
      `</div>` +
      `<div class="vc-note-actions"><span class="vc-hintk" aria-hidden="true">↵ save</span><button type="button" data-act="cancel">Cancel</button><button type="button" class="vc-primary" data-act="save">Pin note</button></div>`;
    R.appendChild(pop);
    const sync = () => {
      pop
        .querySelectorAll('[data-kind]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === draft.kind)));
      pop
        .querySelectorAll('[data-intent]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.intent === draft.intent)));
      pop.querySelector('.vc-intent').hidden = draft.kind === 'note';
      pop.querySelector('[data-act="save"]').classList.toggle('vc-ask', draft.kind !== 'note');
      render();
    };
    sync();
    place(pop, x, y);
    const ta = pop.querySelector('textarea');
    ta.focus();
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        commit();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closePop(true);
      }
    });
    pop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const k = ev.target.closest('[data-kind]');
      const i = ev.target.closest('[data-intent]');
      const act = ev.target.closest('[data-act]');
      if (k) {
        draft.kind = k.dataset.kind;
        sync();
      } else if (i) {
        draft.intent = lastIntent = i.dataset.intent;
        sync();
      } else if (act) {
        if (act.dataset.act === 'save') commit();
        else closePop(true);
      }
    });
  }
  function commit() {
    if (!draft || !pop) return;
    const ta = pop.querySelector('textarea');
    const v = ta.value.trim();
    if (!v) return ta.focus();
    const p = draft;
    p.note = v;
    if (p.kind === 'note') delete p.intent;
    delete p.draft;
    draft = null;
    closePop(false);
    setPicking(false);
    saveLocal();
    render();
    updateCount();
    Promise.resolve(transport.saved(p)).catch(() => {});
    emit('review:saved', wire(p));
  }
  function openPin(p, anchor) {
    closePop(true);
    pop = document.createElement('div');
    pop.className = 'vc-note';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Note ' + p.n);
    const st = stateOf(p);
    const out = ['sending', 'queued', 'with', 'onit', 'blocked', 'waiting'].includes(st);
    const word = {
      sending: 'sending',
      queued: 'queued',
      with: 'with ' + AG(),
      onit: AG() + ' is on it',
      blocked: AG() + ' needs you',
      waiting: 'still open',
      failed: 'not sent',
      ready: 'not sent yet',
    }[st];
    const meta = [
      'Note ' + p.n,
      p.kind === 'note' ? 'just a note' : p.intent,
      p.status !== 'open' ? p.status : word,
    ]
      .filter(Boolean)
      .join(' · ');
    pop.innerHTML =
      `<div class="vc-note-meta">${esc(meta)}</div><div class="vc-note-text">${esc(p.note)}</div>` +
      (p.reply
        ? `<div class="vc-note-reply"><b>${p.status === 'dismissed' ? 'Dismissed' : '✓ Done'}</b> · ${esc(p.reply)}</div>`
        : '') +
      (out
        ? `<div class="vc-note-meta">${esc(AG())} already has this one, so it can’t be removed. Add a new note to change it.</div>`
        : '') +
      `<div class="vc-note-actions">${out ? '' : '<button type="button" data-act="delete">Remove</button>'}<button type="button" class="vc-primary" data-act="close">Done</button></div>`;
    R.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    place(pop, r.left + 12, r.top + 12);
    pop.querySelector('[data-act="close"]').focus();
    pop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closePop(false);
        anchor.focus();
      }
    });
    pop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const act = ev.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'delete') remove(p);
      closePop(false);
      if (anchor.isConnected) anchor.focus();
    });
  }
  // `local` only takes it off this page (clearing answered notes); the store keeps
  // the history for the agent.
  function remove(p, { local } = {}) {
    pins = pins.filter((x) => x !== p);
    saveLocal();
    render();
    updateCount();
    if (!local) transport.removed(p);
  }

  /* ------------------------------------------------------------ pins on the page */

  // Pins follow their element while the page is in the state the note was made in.
  let replyEl = null;
  function placePins() {
    const cur = state();
    let moved = false;
    for (const p of pins) {
      const dot = pinLayer.querySelector(`[data-n="${p.n}"]`);
      if (!dot) continue;
      let el = null;
      try {
        el = p.selector ? document.querySelector(p.selector) : null;
      } catch {
        // Best effort: nothing to do if this fails.
      }
      let at = null;
      if (el && visible(el) && holds(p.state, cur)) {
        const r = el.getBoundingClientRect();
        at = {
          x: r.left + (p.rel ? p.rel.x : 0.5) * r.width,
          y: r.top + (p.rel ? p.rel.y : 0.5) * r.height,
        };
      } else if (!el && !p.state && p.x !== undefined) at = { x: p.x - scrollX, y: p.y - scrollY }; // an old frame pin with no element
      const away = !at;
      if (p.away !== away) moved = true;
      p.away = away;
      dot.hidden = away;
      if (at) {
        dot.style.left = at.x + 'px';
        dot.style.top = at.y + 'px';
      }
    }
    // Keep the list honest about which notes are here and which are elsewhere.
    if (moved && panel && !panel.contains(LIGHT ? document.activeElement : root.activeElement))
      fillPanel();
  }
  function render() {
    pinLayer.innerHTML = '';
    for (const p of pins) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vc-pin';
      b.dataset.n = p.n;
      b.dataset.kind = p.kind || 'request';
      b.dataset.status = p.status || 'open';
      if (p.draft) {
        b.setAttribute('data-draft', '');
        b.tabIndex = -1;
        b.setAttribute('aria-hidden', 'true');
        b.textContent = p.n;
      } else {
        const done = p.status === 'resolved' || p.status === 'dismissed';
        b.innerHTML = done ? icon(p.status === 'resolved' ? 'check' : 'x') : String(p.n);
        b.setAttribute('aria-label', `Note ${p.n}${done ? ', ' + p.status : ''}: ${p.note || ''}`);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          openPin(p, b);
        });
        if (p.reply) {
          const show = () => {
            hideReply();
            replyEl = document.createElement('div');
            replyEl.className = 'vc-reply';
            replyEl.setAttribute('role', 'tooltip');
            replyEl.innerHTML = `<b>${p.status === 'resolved' ? '✓' : '✕'} ${esc(CFG.agent)}</b> · ${esc(p.reply)}`;
            R.appendChild(replyEl);
            const r = b.getBoundingClientRect();
            replyEl.style.left = Math.min(r.right + 6, innerWidth - 290) + 'px';
            replyEl.style.top = r.top - 2 + 'px';
          };
          b.addEventListener('pointerenter', show);
          b.addEventListener('focus', show);
          b.addEventListener('pointerleave', hideReply);
          b.addEventListener('blur', hideReply);
        }
      }
      pinLayer.appendChild(b);
    }
    placePins();
  }
  function hideReply() {
    if (replyEl) replyEl.remove();
    replyEl = null;
  }
  let raf = 0;
  const kick = () => {
    if (!raf && pins.length)
      raf = requestAnimationFrame(() => {
        raf = 0;
        placePins();
      });
  };
  addEventListener('scroll', kick, true);
  addEventListener('resize', kick);
  addEventListener('transitionend', kick, true);
  addEventListener('animationend', kick, true);
  new MutationObserver((recs) => {
    if (recs.some((r) => !host.contains(r.target))) kick();
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-pressed', 'style', 'open'],
  });

  /* ------------------------------------------------------------ the toolbar and notes panel (prototypes) */

  let bar = null;
  let panel = null;
  if (CFG.chrome) {
    bar = document.createElement('div');
    bar.className = 'vc-rbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Review');
    bar.innerHTML =
      `<button type="button" class="vc-rhandle" aria-label="Review notes">${icon('pin')}<span>Review</span><span class="vc-rdot" hidden></span><span class="vc-rcount" data-n="0" hidden>0</span></button>` +
      `<span class="vc-rfull"><button type="button" class="vc-rpick" aria-pressed="false" title="Pick an element to comment on (C)">Pick<kbd>C</kbd></button>` +
      `<button type="button" class="vc-rlist" aria-expanded="false">Notes <span class="vc-rcount" data-n="0" hidden>0</span></button>` +
      `<button type="button" class="vc-rsend" title="Send new notes to ${esc(CFG.agent)} (⌘↵)">Send</button>` +
      `<button type="button" class="vc-rstat" hidden><span class="vc-rdot"></span><span class="vc-rstat-t"></span></button></span>` +
      `<span class="vc-sr" role="status" aria-live="polite"></span>`;
    R.appendChild(bar);
    R.classList.add('vc-has-bar');
    bar.querySelector('.vc-rhandle').onclick = () => openPanel(true);
    bar.querySelector('.vc-rpick').onclick = () => setPicking(!picking);
    bar.querySelector('.vc-rlist').onclick = () => openPanel();
    bar.querySelector('.vc-rsend').onclick = () => send();
    bar.querySelector('.vc-rstat').onclick = () =>
      phase().key === 'failed' ? send() : openPanel(true);
  }

  /* ------------------------------------------------------------ where each note is
     One truth per note, so the toolbar, the panel and the pins never disagree.
       ready     written, not sent (or changed since it was sent)
       sending   in flight, for a moment
       queued    the companion holds it; the agent is mid-task, or DorkOS is retrying
       with      DorkOS took it, which starts the agent's turn
       onit      delivered, and the agent's chat is streaming
       blocked   delivered, and the agent's chat is waiting on the person ("needs you")
       waiting   delivered, the agent's turn ended (idle, error or interrupted), still open
       failed    couldn't reach the agent (with why); Retry sends it again
       resolved / dismissed   the agent answered */
  let status = null; // vc/review-status: { routed, agent, lifecycle, working, chat, last }
  // DorkOS's session lifecycle (idle | streaming | blocked | error | interrupted),
  // matched exactly. Anything else, or none, means "delivered" and no more.
  const LIFE = {
    streaming: 'onit',
    blocked: 'blocked',
    idle: 'waiting',
    error: 'waiting',
    interrupted: 'waiting',
  };
  let sending = false;
  let doneFlash = 0;
  const AG = () => CFG.agent || (status && status.agent) || 'the agent';
  const isSent = (p) => !!p.posted && p.posted === sig(p);
  function stateOf(p) {
    if (p.draft) return 'draft';
    if (p.status === 'resolved' || p.status === 'dismissed') return p.status;
    if (p.kind === 'note') return 'private';
    if (!isSent(p)) return sending && p._sending ? 'sending' : 'ready';
    const d = p.delivery && p.delivery.state;
    if (d === 'failed' || d === 'unrouted') return 'failed';
    if (d === 'delivering') return 'sending';
    if (d === 'queued') return p.delivery.reason === 'sending' ? 'sending' : 'queued';
    if (d === 'delivered') {
      const life = status && status.lifecycle;
      return Object.prototype.hasOwnProperty.call(LIFE, life) ? LIFE[life] : 'with';
    }
    return transport.kind() === 'companion' ? 'sending' : 'with';
  }
  const REASON = {
    sending: () => `Sending to ${AG()}…`,
    busy: () => `${AG()} is in the middle of something and gets these the moment it’s free.`,
    rate: () => 'Sending again in a minute (the hourly limit is reached).',
    unreachable: () => 'DorkOS isn’t answering yet, so it keeps trying.',
    'no-chat': () => `${AG()}’s chat isn’t reachable, so nothing was delivered.`,
    'no-wake': () => 'Saved here, but this page isn’t set to send to a chat.',
    'login-on': () => `DorkOS has login on, so ${AG()} can’t be woken from here.`,
    'stale-link': () => `This link is out of date. Ask ${AG()} for a new one.`,
    'refused-vc': () => 'The companion turned it down.',
    timeout: () => `Couldn’t reach ${AG()} for 30 minutes, so it stopped trying.`,
    offline: () => 'The companion isn’t running, so nothing left this page.',
    lost: () => 'The companion restarted and lost this one. Send it again.',
    unsure: () => `Not sure it was sent: the companion restarted mid-send.`,
  };
  const why = (p) => {
    const r = p && p.delivery && p.delivery.reason;
    if (!r) return null;
    if (/^refused-/.test(r)) return `DorkOS turned it down (HTTP ${r.slice(8)}).`;
    return REASON[r] ? REASON[r]() : null;
  };
  // The page's one-line answer to "where are my notes?", most urgent first.
  function phase() {
    const live = pins.filter((p) => !p.draft && p.kind !== 'note');
    const by = (k) => live.filter((p) => stateOf(p) === k);
    const ready = by('ready'),
      failed = by('failed'),
      sendingN = by('sending'),
      queued = by('queued');
    const onit = by('onit'),
      blocked = by('blocked'),
      waiting = by('waiting'),
      withN = by('with');
    const out = live.filter((p) =>
      ['sending', 'queued', 'with', 'onit', 'blocked', 'waiting'].includes(stateOf(p))
    );
    const done = live.filter((p) => p.status === 'resolved' || p.status === 'dismissed');
    const base = { ready, failed, out, done };
    if (sending) return { ...base, key: 'sending', text: 'Sending…' };
    if (failed.length)
      return {
        ...base,
        key: 'failed',
        text: 'Couldn’t send · Retry',
        line: why(failed[0]) || `Couldn’t reach ${AG()}.`,
      };
    if (blocked.length)
      return {
        ...base,
        key: 'blocked',
        text: `${AG()} needs you`,
        line: `${AG()} has ${out.length === 1 ? 'this note' : 'these ' + out.length + ' notes'} and is waiting on you in the chat.`,
      };
    if (sendingN.length)
      return { ...base, key: 'sending', text: 'Sending…', line: REASON.sending() };
    if (queued.length)
      return {
        ...base,
        key: 'queued',
        text: `Queued · ${queued.length}`,
        line: why(queued[0]) || REASON.busy(),
      };
    if (onit.length)
      return {
        ...base,
        key: 'onit',
        text: `${AG()} is on it`,
        line: `${AG()} has ${out.length === 1 ? 'this note' : 'these ' + out.length + ' notes'} and is working on ${out.length === 1 ? 'it' : 'them'} now.`,
      };
    if (withN.length)
      return {
        ...base,
        key: 'with',
        text: `With ${AG()} · ${out.length}`,
        line: `Delivered. ${AG()} has ${out.length === 1 ? 'it' : 'them'}.`,
      };
    if (waiting.length)
      return {
        ...base,
        key: 'waiting',
        text: `${out.length} still open`,
        line: `${AG()} finished its turn without closing ${out.length === 1 ? 'this one' : 'these'}. It may have answered in the chat.`,
      };
    if (done.length && Date.now() < doneFlash)
      return { ...base, key: 'done', text: `✓ ${done.length} done` };
    return { ...base, key: 'rest' };
  }

  function updateCount() {
    const ph = phase();
    const readyN = ph.ready.length + ph.failed.length;
    const openN = requests().length;
    if (bar) {
      const handleCount = bar.querySelector('.vc-rhandle .vc-rcount');
      const listCount = bar.querySelector('.vc-rlist .vc-rcount');
      for (const [c, n] of [
        [handleCount, readyN],
        [listCount, openN],
      ]) {
        c.textContent = n;
        c.dataset.n = n;
        c.hidden = !n;
      }
      // Accent means "waiting on you"; notes already with the agent count quietly.
      listCount.classList.toggle('vc-quiet', !readyN);
      bar
        .querySelector('.vc-rlist')
        .setAttribute(
          'aria-label',
          `Notes: ${readyN} to send, ${ph.out.length} with ${AG()}, ${ph.done.length} done`
        );
      const sendBtn = bar.querySelector('.vc-rsend');
      const msg = panel?.querySelector('textarea')?.value.trim();
      const showSend =
        sending ||
        ph.ready.length > 0 ||
        !!msg ||
        !['failed', 'queued', 'sending', 'onit', 'blocked', 'with', 'waiting', 'done'].includes(
          ph.key
        );
      sendBtn.hidden = !showSend;
      sendBtn.disabled = sending || (!ph.ready.length && !msg);
      sendBtn.textContent = sending
        ? 'Sending…'
        : ph.ready.length
          ? `Send ${ph.ready.length}`
          : 'Send';
      const stat = bar.querySelector('.vc-rstat');
      const showStat =
        ['failed', 'queued', 'sending', 'onit', 'blocked', 'with', 'waiting', 'done'].includes(
          ph.key
        ) && !sending;
      stat.hidden = !showStat;
      stat.dataset.k = ph.key;
      stat.querySelector('.vc-rstat-t').textContent = ph.text || '';
      stat.title = ph.line || '';
      stat.setAttribute(
        'aria-label',
        ph.key === 'failed'
          ? `Couldn’t send. ${ph.line || ''} Retry`
          : `${ph.text}. ${ph.line || ''} Open notes`
      );
      const hd = bar.querySelector('.vc-rhandle .vc-rdot');
      hd.hidden = !showStat || ph.key === 'done';
      hd.dataset.k = ph.key;
      // Say a change of phase once, politely.
      const live = bar.querySelector('[role="status"]');
      const say = ph.key === 'rest' ? '' : ph.line || ph.text || '';
      if (live.dataset.k !== ph.key) {
        live.dataset.k = ph.key;
        live.textContent = say;
      }
    }
    if (panel) fillPanel();
    emit('review:count', openN);
  }
  function openPanel(on = !panel) {
    if (!bar) return;
    if (!on) {
      panel?.remove();
      panel = null;
      R.classList.remove('vc-paneled');
      bar.querySelector('.vc-rlist').setAttribute('aria-expanded', 'false');
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'vc-rpanel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Notes');
      R.appendChild(panel);
    }
    R.classList.add('vc-paneled');
    R.querySelector('.vc-rtoast')?.remove(); // the panel says it in place
    bar.querySelector('.vc-rlist').setAttribute('aria-expanded', 'true');
    fillPanel();
  }
  function noteRow(p, { removable }) {
    const st = stateOf(p);
    const li = document.createElement('li');
    if (p.away) li.className = 'vc-away';
    li.dataset.kind = p.kind || 'request';
    li.dataset.status = p.status || 'open';
    li.dataset.state = st;
    li.innerHTML = `<span class="vc-n" aria-hidden="true"></span><div><p></p><small></small></div><div class="vc-acts"></div>`;
    const done = st === 'resolved' || st === 'dismissed';
    li.querySelector('.vc-n').innerHTML = done
      ? icon(st === 'resolved' ? 'check' : 'x')
      : String(p.n);
    const tag = p.kind === 'note' ? 'NOTE' : (p.intent || 'fix').toUpperCase();
    const changed = p.posted && !isSent(p) && !done;
    li.querySelector('p').innerHTML =
      `<span class="vc-tag">${p.n} · ${tag}${changed ? ' · CHANGED' : ''}</span>` + esc(p.note);
    li.querySelector('small').textContent = [
      p.name ? `“${clip(p.name, 40)}”` : (p.selector || '').split(' > ').pop(),
      p.source?.markup,
      p.away ? 'made in: ' + stateLine(placeOf(p.state)) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (st === 'failed' && why(p)) {
      const w = document.createElement('div');
      w.className = 'vc-why';
      w.textContent = why(p);
      li.children[1].appendChild(w);
    }
    if (p.reply) {
      const said = document.createElement('div');
      said.className = 'vc-said';
      said.innerHTML = `<b>${st === 'resolved' ? '✓' : '✕'} ${esc(AG())}</b> · ${esc(p.reply)}`;
      li.children[1].appendChild(said);
    }
    const acts = li.querySelector('.vc-acts');
    if (p.away && window.director?.go) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'vc-act';
      go.textContent = 'Go there';
      go.onclick = () => goThere(p);
      acts.appendChild(go);
    }
    if (removable) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'vc-act';
      rm.textContent = 'Remove';
      rm.setAttribute('aria-label', 'Remove note ' + p.n);
      rm.onclick = () => remove(p);
      acts.appendChild(rm);
    }
    return li;
  }
  function group(title, items, { id, line, k, action } = {}) {
    const sec = document.createElement('section');
    sec.className = 'vc-grp';
    if (k) sec.dataset.k = k;
    sec.innerHTML = `<header${id ? ` id="${id}" tabindex="-1"` : ''}><h3>${k ? '<span class="vc-rdot"></span>' : ''}${esc(title)}</h3></header>${line ? `<p class="vc-grp-line"></p>` : ''}<ol></ol>`;
    if (line) sec.querySelector('.vc-grp-line').textContent = line;
    if (action) sec.querySelector('header').appendChild(action);
    for (const li of items) sec.querySelector('ol').appendChild(li);
    return sec;
  }
  function fillPanel() {
    const ph = phase();
    const all = pins.filter((p) => !p.draft);
    const toSend = all.filter((p) => ['ready', 'failed', 'private'].includes(stateOf(p)));
    const out = all.filter((p) =>
      ['sending', 'queued', 'with', 'onit', 'blocked', 'waiting'].includes(stateOf(p))
    );
    const done = all.filter((p) => p.status === 'resolved' || p.status === 'dismissed');
    const keepFocus = panel.contains(panel.getRootNode().activeElement)
      ? panel.getRootNode().activeElement
      : null;
    const focusId =
      keepFocus && (keepFocus.id || (keepFocus.classList.contains('vc-send2') && 'send2'));
    const msg = panel.querySelector('textarea')?.value || '';
    const readyReq = toSend.filter((p) => stateOf(p) !== 'private');
    const failedN = toSend.filter((p) => stateOf(p) === 'failed').length;
    panel.innerHTML = `<h2>${all.length ? esc(CFG.name) : 'No notes yet'}</h2>`;
    if (!all.length)
      panel.insertAdjacentHTML(
        'beforeend',
        '<p class="vc-empty">Press <b>C</b>, then click anything to say what should change. Your notes stay here until you send them.</p>'
      );

    // 1. What's waiting on you to send.
    if (toSend.length)
      panel.appendChild(
        group(
          failedN && failedN === readyReq.length ? 'Not sent' : 'To send',
          toSend.map((p) => noteRow(p, { removable: true })),
          {
            k: failedN ? 'failed' : null,
            line: failedN ? why(toSend.find((p) => stateOf(p) === 'failed')) : null,
          }
        )
      );
    const compose = document.createElement('div');
    compose.className = 'vc-compose';
    compose.innerHTML =
      `<label class="vc-sr" for="vc-rmsg">Anything else</label><textarea id="vc-rmsg" placeholder="${toSend.length || !all.length ? 'Anything else?' : 'Add a message…'}"></textarea>` +
      `<div class="vc-row"><span class="vc-foot"></span><button type="button" class="vc-act vc-copy" title="Copy the notes as text, for any agent">Copy</button>` +
      (readyReq.length > 1 ? `<button type="button" class="vc-act vc-clear">Clear</button>` : '') +
      `<button type="button" class="vc-primary vc-ask vc-send2"></button></div>`;
    panel.appendChild(compose);
    const ta = compose.querySelector('textarea');
    ta.value = msg;
    const sendBtn = compose.querySelector('.vc-send2');
    const foot = compose.querySelector('.vc-foot');
    const paint = () => {
      const m = ta.value.trim();
      const n = readyReq.length;
      sendBtn.hidden = !n && !m;
      sendBtn.disabled = sending;
      sendBtn.textContent = sending
        ? 'Sending…'
        : failedN && failedN === n
          ? 'Try again'
          : n
            ? `Send ${n} to ${AG()}`
            : `Send message to ${AG()}`;
      foot.textContent = n || m ? '' : out.length ? 'New notes go in your next Send.' : '';
      compose.querySelector('.vc-copy').hidden = !n && !out.length;
      if (bar) updateBarSendOnly();
    };
    paint();
    ta.addEventListener('input', paint);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
      if (e.key === 'Escape') openPanel(false);
    });
    compose.querySelector('.vc-copy').onclick = copy;
    const clr = compose.querySelector('.vc-clear');
    if (clr)
      clr.onclick = () => {
        for (const p of readyReq.slice()) remove(p);
      };
    sendBtn.onclick = () => send();

    // 2. What the agent has, with where it is.
    if (out.length) {
      let action = null;
      if (status && status.chat && ['waiting', 'blocked', 'onit', 'with'].includes(ph.key)) {
        action = document.createElement('button');
        action.type = 'button';
        action.className = 'vc-act';
        action.textContent = 'Open chat';
        action.onclick = () => openChat();
      }
      const lead = ['sending', 'queued', 'onit', 'blocked', 'with', 'waiting'].includes(ph.key)
        ? ph
        : { key: 'with', line: '' };
      const title =
        {
          sending: `Sending to ${AG()}`,
          queued: `Queued for ${AG()}`,
          onit: `${AG()} is on it`,
          blocked: `${AG()} needs you`,
          with: `With ${AG()}`,
          waiting: `Still open with ${AG()}`,
        }[lead.key] || `With ${AG()}`;
      panel.appendChild(
        group(
          title,
          out.map((p) => noteRow(p, { removable: false })),
          { id: 'vc-out', k: lead.key, line: lead.line, action }
        )
      );
    }
    // 3. What's finished.
    if (done.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'vc-act';
      clear.textContent = 'Clear done';
      clear.onclick = () => {
        for (const p of done.slice()) remove(p, { local: true });
      };
      panel.appendChild(
        group(
          `Done · ${done.length}`,
          done.map((p) => noteRow(p, { removable: false })),
          { k: 'done', action: clear }
        )
      );
    }
    if (!toSend.length && all.length) panel.appendChild(compose);
    if (focusId === 'vc-rmsg') {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } else if (focusId === 'send2') {
      if (sendBtn.isConnected && !sendBtn.hidden) sendBtn.focus();
      else panel.querySelector('#vc-out')?.focus();
    } else if (focusId === 'vc-out') panel.querySelector('#vc-out')?.focus();
  }
  function updateBarSendOnly() {
    const sendBtn = bar.querySelector('.vc-rsend');
    const m = panel?.querySelector('textarea')?.value.trim();
    if (m && sendBtn.hidden) {
      sendBtn.hidden = false;
      sendBtn.disabled = sending;
      sendBtn.textContent = 'Send';
    }
  }
  // Inside DorkOS the host switches the main window to the chat and answers
  // `dorkos:open-session:ok`. With no answer in 250ms, open it in a new tab (still
  // inside the click's activation, so no popup blocker).
  function openChat() {
    if (!status || !status.chat) return;
    let done = false;
    const onMsg = (e) => {
      if (e.data && e.data.type === 'dorkos:open-session:ok' && e.data.session === status.session)
        done = true;
    };
    addEventListener('message', onMsg);
    try {
      window.top.postMessage({ type: 'dorkos:open-session', session: status.session }, '*');
    } catch {
      // Best effort: nothing to do if this fails.
    }
    setTimeout(() => {
      removeEventListener('message', onMsg);
      if (!done) window.open(status.chat, '_blank', 'noopener');
    }, 250);
  }
  // Go back to where the note was made, seen through today's lenses.
  async function goThere(p) {
    const to = {};
    for (const [k, v] of Object.entries(p.state || {})) if (!isLens(k)) to[k] = v;
    for (const [k, v] of Object.entries(state())) if (isLens(k)) to[k] = v;
    try {
      await window.director.go(to);
    } catch (e) {
      console.warn('[review] go failed', e);
    }
    kick();
  }

  /* ------------------------------------------------------------ Send */

  // Only what hasn't gone yet: new notes, notes changed since they went, and ones that failed.
  const unsent = () => requests().filter((p) => !isSent(p) || ['failed'].includes(stateOf(p)));
  function payload() {
    const notes = unsent().map(wire);
    return {
      type: 'review',
      name: CFG.name,
      screen: CFG.screen,
      url: topUrl(),
      now: state(),
      message: panel?.querySelector('textarea')?.value.trim() || '',
      notes,
    };
  }
  // The same requests as text, for pasting into any agent.
  function markdown(pl = payload()) {
    if (!pl.notes.length && !pl.message)
      pl = Object.assign({}, pl, { notes: requests().map(wire) });
    const L = [
      `Review of ${pl.name}: ${pl.notes.length} ${pl.notes.length === 1 ? 'request' : 'requests'}`,
      `URL: ${pl.url}`,
    ];
    if (pl.message) L.push('', pl.message);
    for (const p of pl.notes) {
      L.push('', `${p.n}. [${p.intent || 'fix'}] ${p.note}`, `   ref: ${p.ref}`);
      if (p.rect) L.push(`   box: ${p.rect.w}×${p.rect.h} at ${p.rect.x},${p.rect.y}`);
      if (p.source)
        L.push(
          `   source: ${[p.source.markup && 'markup ' + p.source.markup, p.source.style && 'style ' + p.source.style].filter(Boolean).join(' · ')}${p.source.via ? ` (via ${p.source.via})` : ''}`
        );
      const s = Object.entries(p.styles || {})
        .map(([k, v]) => `${k} ${v}`)
        .join('; ');
      if (s) L.push(`   styles: ${s}`);
    }
    return L.join('\n');
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown());
      toast('Copied. Paste it to any agent.');
    } catch {
      toast('Copy failed');
    }
  }
  async function send() {
    if (sending) return;
    const pl = payload();
    if (!pl.notes.length && !pl.message) return;
    const fresh = unsent();
    sending = true;
    for (const p of fresh) p._sending = true;
    updateCount();
    let via;
    try {
      via = await transport.send(pl, fresh);
    } catch (e) {
      console.warn('[review] send failed', e);
      sending = false;
      for (const p of fresh) {
        delete p._sending;
        p.posted = sig(p);
        p.delivery = { state: 'failed', reason: e.reason || 'offline', at: Date.now() };
      }
      saveLocal();
      updateCount();
      render();
      return;
    }
    sending = false;
    for (const p of fresh) {
      delete p._sending;
      p.posted = sig(p);
      // Until the companion says otherwise, it's on its way.
      p.delivery =
        via === 'companion'
          ? { state: 'queued', reason: 'sending', at: Date.now() }
          : { state: 'delivered', at: Date.now() };
    }
    saveLocal();
    if (panel) panel.querySelector('textarea').value = '';
    render();
    updateCount();
    window.__review.last = { via, payload: pl };
    if (via === 'clipboard') toast('Copied. Paste it to the agent.');
    // Focus lands where the notes went, so a keyboard user hears what happens next.
    panel?.querySelector('#vc-out')?.focus();
    emit('review:sent', { via, count: pl.notes.length });
    if (via === 'companion') poll(true);
  }
  const sig = (p) => p.note + '|' + (p.intent || '') + '|' + (p.kind || '');
  let toastTimer = 0;
  function toast(t) {
    R.querySelector('.vc-rtoast')?.remove();
    const d = document.createElement('div');
    d.className = 'vc-rtoast';
    d.setAttribute('role', 'status');
    d.textContent = t;
    // Above the toolbar, never on the panel.
    if (bar) d.style.bottom = 16 + bar.offsetHeight + 8 + 'px';
    if (panel) d.style.bottom = 16 + bar.offsetHeight + 8 + panel.offsetHeight + 8 + 'px';
    R.appendChild(d);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => d.remove(), 4200);
  }

  /* ------------------------------------------------------------ the agent's answers */

  // Merge what the store knows (status, reply, delivery, crop) into the notes on the
  // page. In the frame the store is the truth; elsewhere local notes win and only
  // pick up the agent's answers and where each sent note is.
  let polling = 0;
  const statusUrl = () =>
    (FRAME ? 'vc/review-status?screen=' : new URL('vc/review-status', vcBase()) + '?screen=') +
    encodeURIComponent(CFG.screen);
  async function loadStatus() {
    if (!CFG.chrome || (!FRAME && !CFG.vc)) return;
    try {
      const r = await fetch(statusUrl(), { cache: 'no-store' });
      if (r.ok) status = await r.json();
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
  async function refresh() {
    let list;
    try {
      list = await transport.load();
    } catch {
      return;
    }
    if (!list) return;
    const fresh = [];
    if (FRAME) {
      const was = new Map(pins.map((p) => [p.n, p]));
      const keep = pins.filter((p) => p.draft);
      pins = list.map((p) =>
        Object.assign({ kind: 'request', status: 'open' }, p, {
          posted: p.delivery ? sig(p) : was.get(p.n)?.posted,
        })
      );
      for (const p of pins)
        if (p.status !== 'open' && was.get(p.n) && (was.get(p.n).status || 'open') === 'open')
          fresh.push(p);
      pins.push(...keep);
    } else {
      const byN = new Map(list.map((p) => [p.n, p]));
      for (const p of pins) {
        const s = byN.get(p.n);
        // Sent, but the companion has no record of it (it restarted on a fresh session):
        // say so and let it go again, rather than "sending" forever.
        if (
          !s &&
          isSent(p) &&
          (p.status || 'open') === 'open' &&
          Date.now() - (p.delivery?.at || 0) > 15000
        )
          p.delivery = { state: 'failed', reason: 'lost', at: Date.now() };
        if (!s || s.note !== p.note) continue;
        if ((p.status || 'open') === 'open' && s.status && s.status !== 'open') fresh.push(p);
        Object.assign(p, {
          status: s.status || p.status,
          reply: s.reply || p.reply,
          crop: s.crop || p.crop,
        });
        // The server's word on delivery wins over our optimistic "sending", once it has one.
        if (
          s.delivery &&
          isSent(p) &&
          (!p.delivery || s.delivery.at >= (p.delivery.at || 0) - 5000)
        )
          p.delivery = s.delivery;
      }
      // Notes sent from another tab or browser (or before this one's storage was
      // cleared) still belong on the page, as sent: the store is the record.
      const mine = new Set(pins.map((p) => p.n));
      for (const s of list) {
        if (mine.has(s.n) || s.kind === 'note' || (!s.delivery && (s.status || 'open') === 'open'))
          continue;
        pins.push(Object.assign({ kind: 'request', status: 'open' }, s, { posted: sig(s) }));
      }
      saveLocal();
    }
    await loadStatus();
    if (
      fresh.length &&
      !pins.some(
        (p) =>
          !p.draft &&
          p.kind !== 'note' &&
          ['sending', 'queued', 'with', 'onit', 'blocked', 'waiting'].includes(stateOf(p))
      )
    )
      doneFlash = Date.now() + 6000;
    render();
    updateCount();
    if (fresh.length) {
      const p = fresh[fresh.length - 1];
      const verbs = new Set(
        fresh.map((x) => (x.status === 'dismissed' ? 'dismissed' : 'resolved'))
      );
      const verb = verbs.size > 1 ? 'answered' : [...verbs][0];
      // The open panel already shows it in place; a toast would only cover it.
      if (!panel)
        toast(
          fresh.length > 1
            ? `${AG()} ${verb} ${fresh.length} notes`
            : `${AG()} ${verb} note ${p.n}${p.reply ? ': ' + clip(p.reply, 90) : ''}`
        );
      emit('review:answered', fresh.map(wire));
      if (doneFlash) setTimeout(updateCount, 6100);
    }
  }
  // Prototypes on another origin can't hear the companion's socket, so they ask
  // every few seconds while anything is on its way or still open with the agent.
  const inFlight = () =>
    pins.some((p) => !p.draft && p.kind !== 'note' && isSent(p) && (p.status || 'open') === 'open');
  function poll(now) {
    if (!FRAME && !CFG.vc) return;
    if (now) refresh();
    if (polling) return;
    polling = setInterval(() => {
      if (document.hidden) return;
      if (!inFlight()) {
        clearInterval(polling);
        polling = 0;
        return;
      }
      refresh();
    }, 2500);
  }

  /* ------------------------------------------------------------ keys */

  const typing = (e) =>
    e
      .composedPath()
      .some(
        (n) =>
          n instanceof Element &&
          n.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
      );
  addEventListener(
    'keydown',
    (e) => {
      if (picking && !pop && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return setPicking(false);
      }
      if (picking && !pop && hover && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // ↑ widens the pick to the parent, ↓ narrows back.
        e.preventDefault();
        e.stopPropagation();
        if (
          e.key === 'ArrowUp' &&
          hover.parentElement &&
          hover.parentElement !== document.documentElement &&
          hover.parentElement !== document.body
        ) {
          stack.push(hover);
          hover = hover.parentElement;
        } else if (e.key === 'ArrowDown' && stack.length) hover = stack.pop();
        return frame(hover);
      }
      if (picking && !pop && hover && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const r = hover.getBoundingClientRect();
        return openDraft(hover, r.left + r.width / 2, r.top + r.height / 2);
      }
      if (typing(e)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        e.stopPropagation();
        setPicking(!picking);
      }
      if (bar && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
      if (e.key === 'Escape' && panel) {
        e.stopPropagation();
        openPanel(false);
      }
    },
    true
  );

  /* ------------------------------------------------------------ start */

  theme();
  new MutationObserver(theme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  });
  addEventListener('director:change', () => {
    theme();
    kick();
  });
  if (!FRAME) pins = loadLocal().map((p) => Object.assign({ kind: 'request', status: 'open' }, p));
  render();
  updateCount();
  if (FRAME) refresh();
  else if (CFG.vc && (CFG.chrome || pins.some((p) => p.posted))) poll(true);
  if (FRAME && CFG.chrome) poll(false);

  window.__review = {
    config: CFG,
    state,
    genericState,
    describe,
    payload,
    markdown,
    send,
    refresh,
    setPicking,
    openPanel,
    requests: () => requests().map(wire),
    ref: refOf,
    transport,
    get picking() {
      return picking;
    },
    get busy() {
      return !!pop;
    },
    get pins() {
      return pins;
    },
  };
  emit('review:ready', CFG.screen);
})();

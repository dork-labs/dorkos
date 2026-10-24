/**
 * The in-page half of the measure script: runs inside the browser via `page.evaluate`.
 *
 * It must stay self-contained (no imports, no closures over module scope), because Playwright
 * serializes the function's source into the page. It reads computed styles and boxes only; it
 * never changes the page.
 *
 * @module auditing-ui/measure/in-page
 */

/* global window, document, getComputedStyle, NodeFilter -- this code runs in the page, not in Node */

/**
 * Measure one rendered page against the floors and return the flags plus a census.
 *
 * @param {{ floors: object, isPhone: boolean, ignore: string | null }} opts - The floors file, whether this viewport is a phone, and a selector to skip.
 * @returns {{ flags: object[], stats: object, ramp: object, iconSizes: object }} The flags and what was measured.
 */
export function measureInPage({ floors, isPhone, ignore }) {
  const dev = isPhone ? 'phone' : 'desktop';
  const flags = [];
  const stats = { text: 0, icons: 0, targets: 0, inputs: 0 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const sel = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let n = el;
    for (let d = 0; n && n.nodeType === 1 && d < 4; d++) {
      let p = n.tagName.toLowerCase();
      const tid =
        n.getAttribute('data-testid') ||
        n.getAttribute('data-slot') ||
        n.getAttribute('data-sidebar');
      if (n.id && !/^radix-|^:r|^_r_|^«r/.test(n.id)) {
        parts.unshift(`${p}#${n.id}`);
        break;
      }
      if (tid)
        p += `[data-${n.hasAttribute('data-testid') ? 'testid' : n.hasAttribute('data-slot') ? 'slot' : 'sidebar'}="${tid}"]`;
      else if (typeof n.className === 'string' && n.className.trim()) {
        const c = n.className
          .trim()
          .split(/\s+/)
          .filter((x) => !x.includes(':') && !x.includes('['))
          .slice(0, 2);
        if (c.length) p += '.' + c.join('.');
      }
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.slice(0, 60);
  };
  const visible = (el, r) => {
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0)
        return false;
      if (n.getAttribute('aria-hidden') === 'true' && n !== el && n.tagName === 'DIALOG')
        return false;
    }
    // Is it actually on top somewhere? (Covered by a modal scrim = not in this capture.)
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const topEl = document.elementFromPoint(cx, cy);
    return !!topEl && (el.contains(topEl) || topEl.contains(el) || el === topEl);
  };
  const ignored = (el) => !!(ignore && el.closest && el.closest(ignore));
  const flag = (f) => flags.push({ device: dev, ...f });

  // --- colour
  const parseColor = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const ctx = document.createElement('canvas').getContext('2d');
  const toRgb = (s) => {
    // Normalize any CSS colour (oklch, color-mix, hsl) through canvas.
    if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const direct = parseColor(s);
    if (direct && /^rgba?\(/.test(s)) return direct;
    ctx.fillStyle = '#000';
    ctx.fillStyle = s;
    const v = ctx.fillStyle;
    if (v.startsWith('#')) {
      const h = v.slice(1);
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    return parseColor(v) || { r: 0, g: 0, b: 0, a: 0 };
  };
  const blend = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  // Background behind an element: walk up, compositing translucent layers. Images and
  // gradients make it unknowable, which is reported as such rather than guessed.
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = toRgb(cs.backgroundColor);
      if (c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const rootBg = toRgb(getComputedStyle(document.documentElement).backgroundColor);
    if (rootBg.a > 0) acc = blend(rootBg, acc);
    for (let i = layers.length - 1; i >= 0; i--) acc = blend(layers[i], acc);
    return acc;
  };

  // --- text
  const textEls = new Set();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) =>
      t.nodeValue && t.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  while (tw.nextNode()) {
    const p = tw.currentNode.parentElement;
    if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'].includes(p.tagName) || p.closest('svg'))
      continue;
    textEls.add(p);
  }
  const typeSamples = [];
  for (const el of textEls) {
    const r = el.getBoundingClientRect();
    if (ignored(el) || !visible(el, r)) continue;
    if (el.closest('.sr-only,[class*="sr-only"]')) continue;
    stats.text++;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const lhRaw = cs.lineHeight;
    const lh = lhRaw === 'normal' ? fs * 1.2 : parseFloat(lhRaw);
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
    const lsEm = fs ? ls / fs : 0;
    const weight = Number(cs.fontWeight) || 400;
    const lines = Math.max(1, Math.round(r.height / (lh || fs * 1.2)));
    const s = {
      sel: sel(el),
      text: label(el),
      fs: +fs.toFixed(2),
      lh: +lh.toFixed(2),
      ratio: +(lh / fs).toFixed(3),
      lsEm: +lsEm.toFixed(4),
      weight,
      lines,
    };
    typeSamples.push(s);
    const T = floors.text;
    // Incidental metadata (counts, badges, timestamps, shortcuts) may sit at the font floor;
    // only reading text owes the reading floor. Initials inside an avatar are a mark, not text.
    const isMeta =
      el.closest('time,small,kbd,[data-slot*="badge"],[data-slot*="count"],[class*="badge"]') !==
      null;
    const isMark = el.closest('[data-slot*="avatar"],[class*="avatar"]') !== null;
    if (fs < T.minFontPx[dev])
      flag({
        rule: T.rule,
        kind: 'font-size',
        severity: isMark ? 'Polish' : 'Blocker',
        sel: s.sel,
        text: s.text,
        value: fs,
        floor: T.minFontPx[dev],
      });
    else if (!isMeta && fs < T.minReadPx[dev])
      flag({
        rule: T.rule,
        kind: 'font-size',
        severity: 'Should',
        sel: s.sel,
        text: s.text,
        value: fs,
        floor: T.minReadPx[dev],
      });
    const lhFloor = lines > 1 ? T.minLineHeightRatio.multiLine : T.minLineHeightRatio.singleLine;
    if (lh / fs < lhFloor - 0.005)
      flag({
        rule: '2.3',
        kind: 'line-height',
        severity: lines > 1 ? 'Should' : 'Polish',
        sel: s.sel,
        text: s.text,
        value: +(lh / fs).toFixed(3),
        floor: lhFloor,
        detail: `${fs}px / ${lh}px, ${lines} line(s)`,
      });
    if (fs < T.smallTextPx && lsEm < T.minTrackingEmBelowSmall)
      flag({
        rule: '2.3',
        kind: 'letter-spacing',
        severity: 'Should',
        sel: s.sel,
        text: s.text,
        value: +lsEm.toFixed(4),
        floor: T.minTrackingEmBelowSmall,
        detail: `${fs}px text tracked tighter than 0`,
      });

    const fg = toRgb(cs.color);
    const bg = bgOf(el);
    if (bg && fg.a > 0) {
      const fgc = fg.a < 1 ? blend(fg, bg) : fg;
      const cr = ratio(fgc, bg);
      const C = floors.contrast;
      const large = fs >= C.largePx || (fs >= C.largeBoldPx && weight >= 700);
      const need = large ? C.largeText : C.text;
      const disabled = el.closest('[disabled],[aria-disabled="true"]') !== null;
      if (cr < need - 0.01 && !disabled)
        flag({
          rule: C.rule,
          kind: 'contrast',
          severity: 'Blocker',
          sel: s.sel,
          text: s.text,
          value: +cr.toFixed(2),
          floor: need,
          detail: `fg rgb(${fgc.r | 0},${fgc.g | 0},${fgc.b | 0}) on bg rgb(${bg.r | 0},${bg.g | 0},${bg.b | 0})`,
        });
    }
  }

  // --- icons
  const INTERACTIVE =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="switch"],[role="radio"],[role="combobox"],[role="treeitem"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const CHROME =
    'header,nav,[role="banner"],[role="navigation"],[role="toolbar"],[role="tablist"],[data-slot="sidebar-header"],[data-sidebar="header"]';
  const icons = [...document.querySelectorAll('svg, img')].filter(
    (n) => !(n.tagName === 'svg' && n.parentElement && n.parentElement.closest('svg'))
  );
  const iconSizes = {};
  for (const ic of icons) {
    const r = ic.getBoundingClientRect();
    if (ignored(ic) || !visible(ic, r)) continue;
    const size = Math.max(r.width, r.height);
    if (size > floors.icon.ignoreAbovePx) continue;
    if (ic.tagName === 'IMG' && size > 40) continue; // avatars and pictures, not glyphs
    stats.icons++;
    // An icon is a control's icon when it is what the control shows: the control is button-sized.
    // An icon inside a whole clickable row or card (a status glyph, an avatar badge) reads as inline.
    let ctrl = ic.closest(INTERACTIVE);
    if (ctrl) {
      const cr = ctrl.getBoundingClientRect();
      if (cr.width > 160 || cr.height > 64) ctrl = null;
    }
    const role = ctrl && ic.closest(CHROME) ? 'chrome' : ctrl ? 'control' : 'inline';
    const k = `${role}:${Math.round(size)}`;
    iconSizes[k] = (iconSizes[k] || 0) + 1;
    const floor = floors.icon.minPx[role][dev];
    if (size < floor - 0.5) {
      const host = ctrl || ic;
      flag({
        rule: floors.icon.rule,
        kind: `icon-${role}`,
        severity: role === 'inline' ? 'Should' : isPhone ? 'Blocker' : 'Should',
        sel: sel(ic),
        text: label(host),
        value: +size.toFixed(1),
        floor,
      });
    }
  }

  // --- hit targets
  const targets = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (el.parentElement && el.parentElement.closest(INTERACTIVE) && el.tagName !== 'INPUT')
      continue; // nested: the outer one is the target
    let r = el.getBoundingClientRect();
    if (ignored(el) || !visible(el, r)) continue;
    const cs = getComputedStyle(el);
    // Inline text links are exempt from the size floor (WCAG 2.5.8 "inline" exception).
    const inline =
      cs.display === 'inline' &&
      el.tagName === 'A' &&
      [...(el.parentElement?.childNodes || [])].some((c) => c.nodeType === 3 && c.nodeValue.trim());
    // A grown hit area on ::after / ::before (`after:absolute after:-inset-3`) counts.
    let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    for (const pseudo of ['::after', '::before']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.position !== 'absolute' || ps.pointerEvents === 'none')
        continue;
      const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : 0);
      const L = r.left - Math.max(0, -px(ps.left)),
        T = r.top - Math.max(0, -px(ps.top));
      const R = r.right + Math.max(0, -px(ps.right)),
        B = r.bottom + Math.max(0, -px(ps.bottom));
      box = {
        l: Math.min(box.l, L),
        t: Math.min(box.t, T),
        r: Math.max(box.r, R),
        b: Math.max(box.b, B),
      };
    }
    const w = box.r - box.l,
      h = box.b - box.t;
    stats.targets++;
    targets.push({ el, box, w, h, inline });
    if (inline) continue;
    const need = floors.target.minPx[dev];
    if (Math.min(w, h) < need - 0.5) {
      const sev = isPhone
        ? Math.min(w, h) < 32
          ? 'Blocker'
          : 'Should'
        : Math.min(w, h) < 24
          ? 'Blocker'
          : 'Should';
      flag({
        rule: floors.target.rule,
        kind: 'target',
        severity: sev,
        sel: sel(el),
        text: label(el),
        value: `${w.toFixed(0)}x${h.toFixed(0)}`,
        floor: need,
      });
    }
  }
  // Spacing between small targets on the phone: boxes that overlap, or sit closer than the gap floor.
  if (isPhone) {
    const small = targets.filter((t) => !t.inline);
    for (let i = 0; i < small.length; i++)
      for (let j = i + 1; j < small.length; j++) {
        const a = small[i].box,
          b = small[j].box;
        if (small[i].el.contains(small[j].el) || small[j].el.contains(small[i].el)) continue;
        const dx = Math.max(0, Math.max(a.l, b.l) - Math.min(a.r, b.r));
        const dy = Math.max(0, Math.max(a.t, b.t) - Math.min(a.b, b.b));
        const overlap = dx === 0 && dy === 0;
        const gap = Math.max(dx, dy);
        const bothBig =
          Math.min(small[i].w, small[i].h) >= 44 && Math.min(small[j].w, small[j].h) >= 44;
        // Rows in a list touch on purpose (a 44px row is its own spacing); only small neighbours need a gap.
        // One box wholly inside the other is a control placed in a field (a reveal button in a
        // password input): the inner one wins the tap, so it is not a collision.
        const inside = (p, q) => p.l >= q.l && p.r <= q.r && p.t >= q.t && p.b <= q.b;
        if (overlap && (inside(a, b) || inside(b, a))) continue;
        if (overlap)
          flag({
            rule: '7.3',
            kind: 'target-overlap',
            severity: 'Should',
            sel: sel(small[i].el),
            text: `${label(small[i].el)} ↔ ${label(small[j].el)}`,
            value: 'overlap',
            floor: 0,
          });
        else if (
          !bothBig &&
          gap < floors.target.minGapPx.phone &&
          (dx === 0 || dy === 0) &&
          gap > 0
        )
          flag({
            rule: '7.3',
            kind: 'target-gap',
            severity: 'Polish',
            sel: sel(small[i].el),
            text: `${label(small[i].el)} ↔ ${label(small[j].el)}`,
            value: +gap.toFixed(1),
            floor: floors.target.minGapPx.phone,
          });
      }
  }

  // --- text fields
  for (const el of document.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]),textarea,select,[contenteditable="true"]'
  )) {
    const r = el.getBoundingClientRect();
    if (ignored(el) || !visible(el, r)) continue;
    stats.inputs++;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (isPhone && fs < floors.input.minFontPx.phone - 0.01)
      flag({
        rule: floors.input.rule,
        kind: 'input-zoom',
        severity: 'Blocker',
        sel: sel(el),
        text: label(el) || el.getAttribute('placeholder') || '',
        value: fs,
        floor: floors.input.minFontPx.phone,
        detail: 'iOS Safari zooms the page on focus below 16px',
      });
    if (
      el.tagName !== 'TEXTAREA' &&
      !el.isContentEditable &&
      r.height < floors.input.minHeightPx[dev] - 0.5
    )
      flag({
        rule: floors.input.rule,
        kind: 'input-height',
        severity: 'Should',
        sel: sel(el),
        text: label(el),
        value: +r.height.toFixed(1),
        floor: floors.input.minHeightPx[dev],
      });
  }

  // --- page overflow
  const se = document.scrollingElement || document.documentElement;
  if (se.scrollWidth > vw + 1)
    flag({
      rule: '8.4',
      kind: 'page-overflow',
      severity: 'Blocker',
      sel: 'html',
      text: '',
      value: se.scrollWidth,
      floor: vw,
      detail: 'page scrolls sideways',
    });
  const escapees = [];
  for (const el of textEls) {
    const r = el.getBoundingClientRect();
    if (ignored(el) || r.width < 1 || r.right <= vw + 1 || r.left > vw) continue;
    if (
      el.closest(
        '[style*="overflow"],[class*="overflow-x-auto"],[class*="overflow-x-scroll"],[class*="overflow-auto"],[class*="scroll"]'
      )
    )
      continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    escapees.push(el);
  }
  for (const el of escapees.slice(0, 10))
    flag({
      rule: '1.4',
      kind: 'text-escapes-viewport',
      severity: 'Blocker',
      sel: sel(el),
      text: label(el),
      value: +el.getBoundingClientRect().right.toFixed(0),
      floor: vw,
    });

  // A compact type census, so a reader sees the ramp actually in use.
  const ramp = {};
  for (const s of typeSamples) {
    const k = `${s.fs}/${s.lh}/${s.lsEm}`;
    ramp[k] = (ramp[k] || 0) + 1;
  }
  return { flags, stats, ramp, iconSizes };
}

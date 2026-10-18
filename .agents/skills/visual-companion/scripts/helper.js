// Visual companion page runtime, v2. Injected at the end of every screen.
//
// - reload: WebSocket, falling back to polling vc/state when the socket can't
//   open (the DorkOS preview proxy, a flaky network) or dies
// - events: POSTed to vc/event (JSONL in state/events), each tagged with the screen
// - chrome: history (⌘← ⌘→), pin notes (C), reduced motion (M), theme (T),
//   hidden until the pointer nears it or it takes focus
// - components: .vc-compare, .vc-themes, .vc-phone, .vc-motion
(function () {
  if (window.__vcLoaded) return;
  window.__vcLoaded = true;

  var D = window.__VC__ || {};
  var root = document.documentElement;
  var q = new URLSearchParams(location.search);
  var SHOT = q.has('shot');
  if (SHOT) window.__studioShot = true; // no review layer or director chrome in screenshots
  var PINNED = q.has('screen'); // viewing a specific screen rather than following the newest
  // Relative to the page, so it works under a proxy prefix too.
  var BASE = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.replace(/[^/]*$/, '');
  if (!/\/$/.test(BASE)) BASE += '/';
  function api(p) {
    return BASE + p;
  }
  var reduced =
    window.__vcReduced ||
    function () {
      return false;
    };

  // ---------- icons (lucide) ----------
  var ICONS = {
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    pin: '<path d="M19.914 11.105A7.298 7.298 0 0 0 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32 32 0 0 0 .824-.738"/><circle cx="12" cy="10" r="3"/><path d="M16 18h6"/><path d="M19 15v6"/>',
    snail:
      '<path d="M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0"/><circle cx="10" cy="13" r="8"/><path d="M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6"/><path d="M18 3 19.1 5.2"/><path d="M22 3 20.9 5.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    grip: '<path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/>',
    list: '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };
  function icon(name) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[name] +
      '</svg>'
    );
  }
  function h(tag, attrs, html) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (html) el.innerHTML = html;
    return el;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }

  // ---------- events ----------
  var outbox = [];
  function post(ev) {
    return fetch(api('vc/event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
      keepalive: true,
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function flush() {
    var pending = outbox.splice(0);
    pending.forEach(function (ev) {
      post(ev).catch(function () {
        outbox.push(ev);
      });
    });
  }
  function sendEvent(event) {
    var ev = Object.assign({}, event);
    ev.screen = ev.screen || D.screen;
    ev.theme = ev.theme || currentTheme();
    ev.timestamp = Date.now();
    if (viaChannel(ev)) ev.channel = true;
    return post(ev).catch(function () {
      outbox.push(ev);
      return { ok: false, queued: true };
    });
  }

  // Page → agent, the DorkOS-native way: the preview proxy injects
  // window.dorkos.channel, and a document opened with a `channel` route can
  // emit straight to its owner. On DorkOS main the canvas host never finishes
  // that handshake (status ends 'offline'), so today the server forwards
  // instead (vc route). When the channel is ready we use it and tell the
  // server not to forward, so nothing arrives twice.
  function viaChannel(ev) {
    var ch = window.dorkos && window.dorkos.channel;
    if (!ch || ch.status !== 'ready') return false;
    try {
      ch.emit('companion.' + ev.type, ev).catch(function () {});
      return true;
    } catch {
      return false;
    }
  }

  // ---------- theme ----------
  function currentTheme() {
    return root.classList.contains('dark') ? 'dark' : 'light';
  }
  function setParam(k, v) {
    var u = new URL(location.href);
    if (v === null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
    history.replaceState(null, '', u);
  }
  function setTheme(t) {
    root.classList.remove('light', 'dark');
    root.classList.add(t);
    root.style.colorScheme = t;
    setParam('theme', t);
    syncBar();
    window.dispatchEvent(new CustomEvent('vc:theme', { detail: t }));
  }

  // ---------- reduced motion ----------
  // Rewrite every prefers-reduced-motion media rule to match the forced state,
  // so a fragment's own CSS responds to the toggle exactly as it would to the OS.
  var mediaOriginals = new WeakMap();
  function eachMediaRule(rules, fn) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      // A rule rewritten earlier no longer says prefers-reduced-motion; remember it by identity.
      if (
        r.media &&
        r.conditionText !== undefined &&
        (mediaOriginals.has(r) || /prefers-reduced-motion/.test(r.media.mediaText))
      )
        fn(r);
      if (r.cssRules) eachMediaRule(r.cssRules, fn);
    }
  }
  function applyMotionRules() {
    var force = window.__vcMotion;
    for (var s = 0; s < document.styleSheets.length; s++) {
      var rules;
      try {
        rules = document.styleSheets[s].cssRules;
      } catch {
        continue;
      }
      eachMediaRule(rules, function (rule) {
        if (!mediaOriginals.has(rule)) mediaOriginals.set(rule, rule.media.mediaText);
        var orig = mediaOriginals.get(rule);
        var text = orig;
        if (force) {
          var on = force === 'reduce';
          text = orig
            .replace(
              /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/g,
              on ? '(min-width: 0px)' : '(max-width: -1px)'
            )
            .replace(
              /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/g,
              on ? '(max-width: -1px)' : '(min-width: 0px)'
            )
            .replace(
              /\(\s*prefers-reduced-motion\s*\)/g,
              on ? '(min-width: 0px)' : '(max-width: -1px)'
            );
        }
        if (rule.media.mediaText !== text) rule.media.mediaText = text;
      });
    }
  }
  function setMotion(mode) {
    window.__vcMotion = mode;
    root.classList.toggle('vc-reduce', reduced());
    setParam('motion', mode);
    applyMotionRules();
    syncBar();
    window.dispatchEvent(new CustomEvent('vc:motion', { detail: reduced() ? 'reduce' : 'full' }));
  }

  // ---------- toast, hint, chip ----------
  var toastEl, chipEl, toastTimer;
  function toast(html, ms) {
    if (SHOT) return;
    if (!toastEl) {
      toastEl = h('div', { class: 'vc-toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = html;
    void toastEl.offsetWidth;
    toastEl.classList.add('vc-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('vc-show');
    }, ms || 3200);
  }
  function newScreenChip(name) {
    if (SHOT) return;
    if (!chipEl) {
      chipEl = h('button', { class: 'vc-chip', type: 'button' });
      chipEl.addEventListener('click', function () {
        go(null);
      });
      document.body.appendChild(chipEl);
    }
    chipEl.innerHTML = 'New screen: ' + esc(name) + ' ' + icon('right');
    chipEl.hidden = false;
  }
  // Waking is opt-in per screen (<meta name="vc-wake" content="on">) and needs
  // a chat to wake (the one that ran `vc show`). Elsewhere, events are noted.
  var R = D.route || {};
  var WAKE = !!R.wake && (R.mode === 'ui-action' || R.mode === 'message');
  var WHO = R.label ? '@' + R.label : 'the agent'; // shown as a mention: "Send to @Tester"
  function feedbackLine() {
    return '<span> · noted, reply in chat</span>';
  }

  // ---------- reply dock (wake screens) ----------
  // Always there on a wake screen: what you've picked, a box for a written
  // reply, and Send. Once a screen has been sent it says so, with what was
  // sent and when, until you change something.
  var sendEl,
    sendText,
    sendBtn,
    sendInput,
    sentSig = null,
    sentInfo = null;
  var DRAFT_KEY = 'vc-draft:' + D.session + ':' + D.screen;
  function currentSelection() {
    var seen = {};
    var list = [];
    document.querySelectorAll('[data-choice].selected').forEach(function (el) {
      var c = el.dataset.choice;
      if (seen[c]) return;
      seen[c] = 1;
      list.push({ choice: c, label: choiceLabel(el) });
    });
    return list;
  }
  function replyDraft() {
    return sendInput ? sendInput.value.trim() : '';
  }
  function autosize() {
    sendInput.style.height = 'auto';
    sendInput.style.height = Math.min(sendInput.scrollHeight, 120) + 'px';
  }
  function buildSendBar() {
    sendEl = h('div', { class: 'vc-send', role: 'region', 'aria-label': 'Reply to ' + WHO });
    sendText = h('div', { class: 'vc-send-text', 'aria-live': 'polite' });
    var row = h('div', { class: 'vc-send-row' });
    sendInput = h('textarea', {
      class: 'vc-send-input',
      rows: '1',
      placeholder: 'Write a reply (optional)',
      'aria-label': 'Write a reply to ' + WHO,
    });
    sendBtn = h(
      'button',
      { type: 'button', class: 'vc-send-btn', 'aria-keyshortcuts': 'Meta+Enter Control+Enter' },
      'Send to ' + esc(WHO)
    );
    sendBtn.addEventListener('click', sendNow);
    try {
      sendInput.value = sessionStorage.getItem(DRAFT_KEY) || '';
    } catch {
      // Best effort: nothing to do if this fails.
    }
    sendInput.addEventListener('input', function () {
      autosize();
      try {
        sessionStorage.setItem(DRAFT_KEY, sendInput.value);
      } catch {
        // Best effort: nothing to do if this fails.
      }
      syncSendBar();
    });
    sendInput.addEventListener('keydown', function (e) {
      // Enter sends; Shift+Enter is a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!sendBtn.disabled) sendNow();
      }
    });
    row.appendChild(sendInput);
    row.appendChild(sendBtn);
    sendEl.appendChild(sendText);
    sendEl.appendChild(row);
    document.body.appendChild(sendEl);
    root.classList.add('vc-has-send');
    autosize();
    requestAnimationFrame(function () {
      sendEl.classList.add('vc-show');
    });
  }
  function timeOf(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }
  function syncSendBar() {
    if (!WAKE || SHOT) return;
    if (!sendEl) buildSendBar();
    var sel = currentSelection();
    var sig = JSON.stringify(sel);
    var text = replyDraft();
    var unchanged = sentInfo && sig === sentSig && !text;
    document.querySelectorAll('[data-choice].vc-was-sent').forEach(function (el) {
      el.classList.remove('vc-was-sent');
    });
    if (unchanged) {
      // Sent, and nothing has changed since.
      sendEl.classList.add('vc-sent');
      sel.forEach(function (c) {
        document.querySelectorAll('[data-choice]').forEach(function (el) {
          if (el.dataset.choice === c.choice) el.classList.add('vc-was-sent');
        });
      });
      var what =
        sentInfo.labels && sentInfo.labels.length
          ? ' · <b>' + esc(sentInfo.labels.join(', ')) + '</b>'
          : '';
      var m = sentInfo.message ? sentInfo.message.replace(/\s+/g, ' ') : '';
      var said = m ? ' · “' + esc(m.length > 140 ? m.slice(0, 139) + '…' : m) + '”' : '';
      sendText.innerHTML =
        icon('check') +
        '<span>Sent to ' +
        esc(WHO) +
        (sentInfo.at ? ' at ' + timeOf(sentInfo.at) : '') +
        what +
        said +
        '</span>';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sent';
      return;
    }
    sendEl.classList.remove('vc-sent');
    sendBtn.disabled = !sel.length && !text;
    sendBtn.textContent = (sentInfo ? 'Send update to ' : 'Send to ') + WHO;
    if (sel.length === 1)
      sendText.innerHTML =
        '<span><b>' +
        esc(sel[0].label) +
        '</b> selected' +
        (text ? ' · with a note' : '') +
        '</span>';
    else if (sel.length > 1)
      sendText.innerHTML =
        '<span><b>' + sel.length + ' selected</b>' + (text ? ' · with a note' : '') + '</span>';
    else if (text) sendText.innerHTML = '<span>Your reply</span>';
    else
      sendText.innerHTML =
        '<span>' +
        (document.querySelector('.vc-choices')
          ? 'Pick an option, or write a reply'
          : 'Write a reply') +
        '</span>';
  }
  // The next screen after this one that hasn't been sent yet. Only later
  // screens: earlier ones are usually drafts the person has moved past.
  function nextUnsent() {
    var list = D.screens || [];
    var i = list.findIndex(function (x) {
      return x.name === D.screen;
    });
    for (var j = i + 1; j < list.length; j++) if (!list[j].sent) return list[j].name;
    return null;
  }
  function sendNow() {
    if (!WAKE) return;
    var sel = currentSelection();
    var text = replyDraft();
    if (!sel.length && !text) return;
    sentSig = JSON.stringify(sel);
    sentInfo = {
      at: Date.now(),
      labels: sel.map(function (c) {
        return c.label;
      }),
      message: text || null,
    };
    var saved = sendEvent({
      type: 'send',
      selection: sel,
      pins: requestCount(),
      message: text || undefined,
    });
    (D.screens || []).forEach(function (x) {
      if (x.name === D.screen) x.sent = true;
    });
    if (sendInput) {
      sendInput.value = '';
      autosize();
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        // Best effort: nothing to do if this fails.
      }
    }
    syncSendBar();
    var to = nextUnsent();
    if (to) {
      sendText.innerHTML = icon('check') + '<span>Sent to ' + esc(WHO) + ' · next screen…</span>';
      // Advance once the event is saved, never before: a reload mid-request
      // could lose the Send.
      var wait = new Promise(function (r) {
        setTimeout(r, 650);
      });
      Promise.all([saved, wait]).then(function () {
        go(to);
      });
    } else if (D.screens && D.screens.length > 1) {
      sendText.innerHTML =
        icon('check') + '<span>Sent to ' + esc(WHO) + ' · that was the last screen</span>';
      setTimeout(syncSendBar, 2400);
    }
  }

  // ---------- selection (v1 API, kept) ----------
  window.selectedChoice = null;
  window.toggleSelect = function (el) {
    var container = el.closest('.options') || el.closest('.cards');
    var multi = container && container.dataset.multiselect !== undefined;
    if (container && !multi) {
      container.querySelectorAll('.option, .card').forEach(function (o) {
        o.classList.remove('selected');
        if (o.hasAttribute('aria-pressed')) o.setAttribute('aria-pressed', 'false');
      });
    }
    if (multi) el.classList.toggle('selected');
    else el.classList.add('selected');
    if (el.hasAttribute('aria-pressed'))
      el.setAttribute('aria-pressed', el.classList.contains('selected') ? 'true' : 'false');
    window.selectedChoice = el.dataset.choice;
  };

  function choiceLabel(el) {
    var t = el.querySelector('h3, .content h3, .card-body h3');
    var letter = el.querySelector('.letter');
    var text = (t ? t.textContent : el.textContent).replace(/\s+/g, ' ').trim();
    return (letter ? letter.textContent.trim() + ' · ' : '') + text.slice(0, 80);
  }

  // Clicks on [data-choice] are recorded. Deferred a tick so an inline
  // onclick="toggleSelect(this)" has already marked the selection.
  document.addEventListener('click', function (e) {
    if (pinning) return;
    var target = e.target.closest && e.target.closest('[data-choice]');
    if (!target) return;
    var pane = target.closest('.vc-theme-pane');
    sendEvent({
      type: 'click',
      choice: target.dataset.choice,
      label: choiceLabel(target),
      text: (target.innerText || target.textContent).replace(/\s+/g, ' ').trim().slice(0, 200),
      id: target.id || null,
      pane: pane ? (pane.classList.contains('dark') ? 'dark' : 'light') : undefined,
    });
    setTimeout(function () {
      // Remember this screen's picks, so leaving and coming back keeps them.
      if (target.closest('.options, .cards')) {
        sendEvent({
          type: 'select',
          choices: currentSelection().map(function (c) {
            return c.choice;
          }),
        });
      }
      if (WAKE) return syncSendBar();
      var container = target.closest('.options') || target.closest('.cards');
      var selected = container ? container.querySelectorAll('.selected') : [];
      if (selected.length > 1) toast('<b>' + selected.length + ' selected</b>' + feedbackLine());
      else if (selected.length === 1)
        toast('<b>' + esc(choiceLabel(selected[0])) + '</b> selected' + feedbackLine());
      else if (!container) toast('<b>' + esc(choiceLabel(target)) + '</b>' + feedbackLine());
      else toast('Selection cleared' + feedbackLine());
    }, 0);
  });

  // Make every choice reachable and operable from the keyboard.
  // Choices must read as choices: each gets a radio (or check) slot and the
  // group a "Choose one" label. A screen opts out with
  // <meta name="vc-choices" content="plain">, a group with data-vc-plain.
  var PLAIN = !!document.querySelector('meta[name="vc-choices"][content="plain"]');
  function decorateChoice(el) {
    var group = el.closest('.options, .cards');
    if (PLAIN || !group || group.hasAttribute('data-vc-plain')) return;
    var multi = group.dataset.multiselect !== undefined;
    el.classList.add('vc-choice');
    if (multi) el.classList.add('vc-multi');
    if (!el.querySelector(':scope > .vc-radio')) {
      el.appendChild(h('span', { class: 'vc-radio', 'aria-hidden': 'true' }, icon('check')));
    }
    if (!group.classList.contains('vc-choices')) {
      group.classList.add('vc-choices');
      if (!group.hasAttribute('role')) group.setAttribute('role', 'group');
      var prev = group.previousElementSibling;
      if (!(prev && prev.classList.contains('vc-choose'))) {
        var lbl = h(
          'div',
          { class: 'vc-choose', id: 'vc-choose-' + Math.random().toString(36).slice(2, 8) },
          multi ? 'Choose any' : 'Choose one'
        );
        group.parentNode.insertBefore(lbl, group);
        group.setAttribute('aria-labelledby', lbl.id);
      }
      // Not one of these? Clear the pick and write a reply instead.
      if (WAKE && !group.querySelector(':scope + .vc-own')) {
        var own = h(
          'button',
          { type: 'button', class: 'vc-own' },
          'None of these, I’ll write my own'
        );
        own.addEventListener('click', function () {
          group.querySelectorAll('[data-choice].selected').forEach(function (o) {
            o.classList.remove('selected');
            if (o.hasAttribute('aria-pressed')) o.setAttribute('aria-pressed', 'false');
          });
          sendEvent({
            type: 'select',
            choices: currentSelection().map(function (c) {
              return c.choice;
            }),
          });
          syncSendBar();
          if (sendInput) sendInput.focus();
        });
        group.parentNode.insertBefore(own, group.nextSibling);
      }
    }
  }
  function enhanceChoices(scope) {
    scope.querySelectorAll('[data-choice]').forEach(function (el) {
      if (el.dataset.vcChoice) return;
      el.dataset.vcChoice = '1';
      decorateChoice(el);
      var native = /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
      if (!native) {
        if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
        if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
        // "A · Quiet header", not "AQuiet headerTitle only…" run together.
        if (!el.hasAttribute('aria-label') && el.querySelector('.letter, h3')) {
          el.setAttribute('aria-label', choiceLabel(el));
          var desc = el.querySelector('p');
          if (desc)
            el.setAttribute('aria-description', desc.textContent.replace(/\s+/g, ' ').trim());
        }
        if (el.closest('.options, .cards'))
          el.setAttribute('aria-pressed', el.classList.contains('selected') ? 'true' : 'false');
        el.addEventListener('keydown', function (e) {
          if (e.target !== el) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            el.click();
          }
        });
      }
    });
  }

  // ---------- history ----------
  function go(name) {
    try {
      if (bar && (bar.classList.contains('vc-show') || bar.matches(':hover')))
        sessionStorage.setItem('vc-bar-open', String(Date.now()));
    } catch {
      // Best effort: nothing to do if this fails.
    }
    var u = new URL(location.href);
    u.searchParams.delete('shot');
    if (!name || name === D.latest) u.searchParams.delete('screen');
    else u.searchParams.set('screen', name);
    location.href = u.toString();
  }

  // ---------- chrome bar ----------
  var bar,
    btn = {};
  function buildBar() {
    bar = h('div', { class: 'vc-bar', role: 'toolbar', 'aria-label': 'Visual companion' });
    // Always visible: where you are, and a hint that there's more. Hover or
    // focus expands it to the full bar.
    btn.handle = h('button', {
      class: 'vc-handle',
      type: 'button',
      'aria-label': 'Show screen controls',
    });
    btn.prev = h(
      'button',
      {
        class: 'vc-iconbtn',
        type: 'button',
        'aria-label': 'Previous screen',
        title: 'Previous screen (⌘←)',
      },
      icon('left')
    );
    var where = h('span', {
      class: 'vc-where',
      title: D.title || '',
      text: D.title || 'Visual companion',
    });
    btn.count = h('button', { class: 'vc-count', type: 'button', title: 'All screens (G)' });
    btn.next = h(
      'button',
      {
        class: 'vc-iconbtn',
        type: 'button',
        'aria-label': 'Next screen',
        title: 'Next screen (⌘→)',
      },
      icon('right')
    );
    btn.list = h(
      'button',
      {
        class: 'vc-iconbtn',
        type: 'button',
        'aria-label': 'All screens',
        'aria-expanded': 'false',
        title: 'All screens (G)',
      },
      icon('list')
    );
    btn.pin = h(
      'button',
      {
        class: 'vc-iconbtn',
        type: 'button',
        'aria-pressed': 'false',
        'aria-label': 'Pin a note',
        title: 'Pin a note (C)',
      },
      icon('pin')
    );
    btn.motion = h(
      'button',
      {
        class: 'vc-iconbtn',
        type: 'button',
        'aria-pressed': 'false',
        'aria-label': 'Reduced motion',
        title: 'Reduced motion (M)',
      },
      icon('snail')
    );
    btn.theme = h('button', { class: 'vc-iconbtn', type: 'button' });
    btn.dot = h('span', {
      class: 'vc-dot',
      role: 'img',
      'data-state': 'connecting',
      'aria-label': 'Connecting',
      title: 'Connecting',
    });
    var full = h('div', { class: 'vc-bar-full' });
    var nav = h('div', { class: 'vc-bar-group' });
    [btn.prev, where, btn.count, btn.next].forEach(function (n) {
      nav.appendChild(n);
    });
    var tools = h('div', { class: 'vc-bar-group' });
    [btn.list, btn.pin, btn.motion, btn.theme, btn.dot].forEach(function (n) {
      tools.appendChild(n);
    });
    full.appendChild(nav);
    full.appendChild(h('span', { class: 'vc-bar-gap' }));
    full.appendChild(tools);
    bar.appendChild(btn.handle);
    bar.appendChild(full);
    btn.handle.addEventListener('click', function () {
      bar.classList.add('vc-show');
      btn.list.focus();
    });
    btn.prev.addEventListener('click', function () {
      if (D.prev) go(D.prev);
    });
    btn.next.addEventListener('click', function () {
      if (D.next) go(D.next);
    });
    btn.count.addEventListener('click', toggleJump);
    btn.list.addEventListener('click', toggleJump);
    btn.pin.addEventListener('click', function () {
      setPinning(!pinning);
    });
    btn.motion.addEventListener('click', function () {
      setMotion(reduced() ? 'full' : 'reduce');
    });
    btn.theme.addEventListener('click', function () {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
    document.body.insertBefore(bar, document.body.firstChild);
    syncBar();

    // Coming from the previous screen with the bar open: keep it open, with
    // no entrance, so stepping through screens never flashes the controls.
    try {
      var open = Number(sessionStorage.getItem('vc-bar-open') || 0);
      sessionStorage.removeItem('vc-bar-open');
      if (open && Date.now() - open < 10000) {
        bar.classList.add('vc-show', 'vc-noanim');
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            bar.classList.remove('vc-noanim');
          });
        });
      }
    } catch {
      // Best effort: nothing to do if this fails.
    }

    // Expanded while the pointer is near the top or the bar has focus.
    var hideTimer;
    document.addEventListener('mousemove', function (e) {
      var near = e.clientY < 72 || bar.contains(e.target) || (jumpEl && jumpEl.contains(e.target));
      if (near) {
        clearTimeout(hideTimer);
        bar.classList.add('vc-show');
      } else if (bar.classList.contains('vc-show') && !pinning && !jumpEl) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
          bar.classList.remove('vc-show');
        }, 400);
      }
    });
    document.addEventListener('mouseleave', function () {
      if (!pinning && !jumpEl) bar.classList.remove('vc-show');
    });
  }

  // ---------- jump list ----------
  var jumpEl = null,
    jumpActive = 0,
    jumpItems = [];
  function toggleJump() {
    if (jumpEl) closeJump();
    else openJump();
  }
  function closeJump(restore) {
    if (!jumpEl) return;
    jumpEl.remove();
    jumpEl = null;
    if (btn.list) btn.list.setAttribute('aria-expanded', 'false');
    if (restore !== false && btn.list) btn.list.focus();
  }
  function openJump() {
    var list = D.screens || [];
    if (!list.length) return;
    bar.classList.add('vc-show');
    btn.list.setAttribute('aria-expanded', 'true');
    jumpEl = h('div', { class: 'vc-jump', role: 'dialog', 'aria-label': 'All screens' });
    var filter = null;
    if (list.length > 8) {
      filter = h('input', {
        class: 'vc-jump-filter',
        type: 'text',
        placeholder: 'Filter ' + list.length + ' screens',
        'aria-label': 'Filter screens',
      });
      jumpEl.appendChild(filter);
    }
    var ul = h('div', { class: 'vc-jump-list', role: 'listbox', 'aria-label': 'Screens' });
    jumpEl.appendChild(ul);
    var theme = currentTheme();
    function render(term) {
      ul.innerHTML = '';
      jumpItems = [];
      var t = (term || '').toLowerCase();
      list.forEach(function (x, i) {
        if (t && (x.title + ' ' + x.name).toLowerCase().indexOf(t) < 0) return;
        var cur = x.name === D.screen;
        var item = h('div', {
          class: 'vc-jump-item' + (cur ? ' vc-current' : ''),
          role: 'option',
          id: 'vc-jump-' + i,
          'aria-selected': 'false',
          'data-name': x.name,
        });
        var thumb = h('span', { class: 'vc-jump-thumb' });
        if (x.shot)
          thumb.appendChild(
            h('img', {
              src: api('vc/shot/' + encodeURIComponent(x.name) + '.' + theme + '.png'),
              alt: '',
              loading: 'lazy',
            })
          );
        var text = h('span', { class: 'vc-jump-text' });
        text.appendChild(h('span', { class: 'vc-jump-title', text: x.title }));
        text.appendChild(
          h('span', {
            class: 'vc-jump-sub',
            text: i + 1 + ' · ' + x.name + (cur ? ' · you are here' : ''),
          })
        );
        item.appendChild(thumb);
        item.appendChild(text);
        if (x.sent)
          item.appendChild(
            h('span', { class: 'vc-jump-sent', title: 'Sent' }, icon('check') + '<span>Sent</span>')
          );
        item.addEventListener('click', function () {
          closeJump(false);
          if (!cur) go(x.name);
        });
        item.addEventListener('mousemove', function () {
          setActive(jumpItems.indexOf(item));
        });
        ul.appendChild(item);
        jumpItems.push(item);
      });
      if (!jumpItems.length)
        ul.appendChild(h('div', { class: 'vc-jump-empty', text: 'No screens match' }));
      var here = jumpItems.findIndex(function (n) {
        return n.classList.contains('vc-current');
      });
      setActive(t ? 0 : Math.max(0, here));
    }
    function setActive(i) {
      if (!jumpItems.length) return;
      jumpActive = clamp(i, 0, jumpItems.length - 1);
      jumpItems.forEach(function (n, k) {
        n.setAttribute('aria-selected', k === jumpActive ? 'true' : 'false');
      });
      jumpItems[jumpActive].scrollIntoView({ block: 'nearest' });
      ul.setAttribute('aria-activedescendant', jumpItems[jumpActive].id);
    }
    jumpEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(jumpActive + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (jumpItems[jumpActive]) jumpItems[jumpActive].click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeJump();
      }
    });
    if (filter)
      filter.addEventListener('input', function () {
        render(filter.value);
      });
    render('');
    document.body.appendChild(jumpEl);
    if (filter) filter.focus();
    else {
      ul.tabIndex = 0;
      ul.focus();
    }
    setTimeout(function () {
      document.addEventListener('mousedown', function outside(e) {
        if (!jumpEl) return document.removeEventListener('mousedown', outside);
        if (!jumpEl.contains(e.target) && !bar.contains(e.target)) {
          document.removeEventListener('mousedown', outside);
          closeJump(false);
        }
      });
    }, 0);
  }
  function peekBar() {
    if (!bar) return;
    bar.classList.add('vc-show');
    clearTimeout(peekBar.t);
    peekBar.t = setTimeout(function () {
      if (!pinning && !bar.matches(':hover')) bar.classList.remove('vc-show');
    }, 1600);
  }
  function syncBar() {
    if (!bar) return;
    btn.prev.disabled = !D.prev;
    btn.next.disabled = !D.next;
    btn.count.textContent = D.total ? D.index + 1 + ' / ' + D.total : '';
    btn.count.setAttribute(
      'aria-label',
      D.total ? 'Screen ' + (D.index + 1) + ' of ' + D.total + ', show all screens' : 'All screens'
    );
    btn.handle.innerHTML =
      '<span>' + (D.total ? D.index + 1 + ' / ' + D.total : '') + '</span>' + icon('more');
    var dark = currentTheme() === 'dark';
    btn.theme.innerHTML = icon(dark ? 'sun' : 'moon');
    btn.theme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.theme.title = (dark ? 'Light theme' : 'Dark theme') + ' (T)';
    btn.motion.setAttribute('aria-pressed', reduced() ? 'true' : 'false');
    btn.pin.setAttribute('aria-pressed', pinning ? 'true' : 'false');
  }
  function setDot(state) {
    if (!btn.dot || btn.dot.dataset.state === state) return;
    var label = {
      live: 'Live',
      polling: 'Live (polling)',
      offline: 'Server offline',
      connecting: 'Connecting',
    }[state];
    btn.dot.dataset.state = state;
    btn.dot.setAttribute('aria-label', label);
    btn.dot.title = label;
  }

  // ---------- keyboard ----------
  function typing(e) {
    var t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }
  document.addEventListener('keydown', function (e) {
    if (SHOT) return;
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      if (typing(e)) return;
      e.preventDefault();
      peekBar();
      var to = e.key === 'ArrowLeft' ? D.prev : D.next;
      if (to) go(to);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && WAKE && !(review() && review().busy)) {
      e.preventDefault();
      sendNow();
      return;
    }
    if (e.key === 'Escape') {
      if (jumpEl) return closeJump();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    var k = e.key.toLowerCase();
    if (k === 'c') {
      peekBar(); // review.js toggles picking
    } else if (k === 't') {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      peekBar();
    } else if (k === 'm') {
      setMotion(reduced() ? 'full' : 'reduce');
      peekBar();
    } else if (k === 'g' && bar) {
      e.preventDefault();
      toggleJump();
    }
  });

  // ---------- pins ----------
  // review.js draws pins, the note and the pick hint: one implementation for
  // fragments and full prototypes. The frame mounts it in the page (light DOM,
  // so the chrome layer styles it) and hands it this page's event queue, so a
  // pin is recorded and wakes the chat exactly as before.
  var pinning = false;
  function review() {
    return window.__review || null;
  }
  function setPinning(on) {
    var r = review();
    if (r) r.setPicking(on);
  }
  window.addEventListener('review:picking', function (e) {
    pinning = !!e.detail;
    if (bar) bar.classList.toggle('vc-show', pinning);
    syncBar();
  });
  window.addEventListener('review:saved', function (e) {
    var p = e.detail || {};
    toast(
      '<b>Note ' +
        p.n +
        '</b> ' +
        (p.kind === 'note'
          ? 'kept as a note'
          : WAKE
            ? 'sent to ' + esc(WHO)
            : 'pinned' + feedbackLine())
    );
  });
  function requestCount() {
    var r = review();
    return r ? r.requests().length : 0;
  }
  window.REVIEW_CONFIG = {
    name: D.title || D.screen,
    screen: D.screen,
    agent: R.label || 'the agent',
    mount: 'light',
    chrome: false,
    ignore: '.vc-bar, .vc-chip, .vc-toast, .vc-send, .vc-jump',
    // Fragments are stamped with data-src by the server; the raw file is the fallback.
    sources: D.screen
      ? [
          {
            url: api('files/' + encodeURIComponent(D.screen) + '.html'),
            label: 'content/' + D.screen + '.html',
          },
        ]
      : [],
    post: function (ev) {
      return sendEvent(Object.assign({ selection: currentSelection() }, ev));
    },
  };

  // ---------- live reload: WebSocket, then polling ----------
  var ws = null;
  var wsLive = false;
  var pollTimer = null;
  var wsRetry = 1000;
  var known = { version: D.version, latest: D.latest, session: D.session };
  var currentMtime = D.mtime === undefined ? null : D.mtime;

  function rememberLatest(name) {
    try {
      sessionStorage.setItem('vc-latest:' + D.session, name || '');
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
  function onChange(info) {
    // info: { latest, screen?, reason? } from either channel
    if (info.latest && info.latest !== known.latest) {
      known.latest = info.latest;
      rememberLatest(info.latest);
      if (PINNED) return newScreenChip(info.latestTitle || info.latest);
      return reloadKeepingScroll(false);
    }
    if (info.reason === 'screen-updated' && info.screen === D.screen)
      return reloadKeepingScroll(true);
    if (info.reason === 'screens') syncHistory();
  }
  function reloadKeepingScroll(keep) {
    try {
      if (keep) sessionStorage.setItem('vc-scroll:' + D.screen, String(scrollY));
    } catch {
      // Best effort: nothing to do if this fails.
    }
    location.reload();
  }
  function syncHistory() {
    fetch(api('vc/state'), { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(applyState)
      .catch(function () {});
  }
  function applyState(s) {
    if (s.session && known.session && s.session !== known.session) return location.reload();
    var names = s.screens.map(function (x) {
      return x.name;
    });
    var me = s.screens.filter(function (x) {
      return x.name === D.screen;
    })[0];
    if (me && currentMtime !== null && me.mtime !== currentMtime) return reloadKeepingScroll(true);
    if (me) currentMtime = me.mtime;
    if (s.latest !== known.latest) return onChange({ latest: s.latest });
    var i = names.indexOf(D.screen);
    D.index = i;
    D.total = names.length;
    D.prev = i > 0 ? names[i - 1] : null;
    D.next = i >= 0 && i < names.length - 1 ? names[i + 1] : null;
    known.version = s.version;
    syncBar();
  }
  function poll() {
    fetch(api('vc/state'), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (s) {
        if (!wsLive) setDot('polling');
        if (outbox.length) flush();
        applyState(s);
      })
      .catch(function () {
        setDot('offline');
      });
  }
  function startPolling() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, 1500);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + BASE;
    try {
      ws = new WebSocket(url);
    } catch {
      startPolling();
      return;
    }
    // A proxy that accepts the upgrade but never relays a frame looks open
    // and is dead, so "live" means the server's hello arrived.
    var guard = setTimeout(function () {
      if (!wsLive) startPolling();
    }, 2500);
    ws.onmessage = function (msg) {
      var data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (data.type === 'hello') {
        wsLive = true;
        wsRetry = 1000;
        clearTimeout(guard);
        stopPolling();
        setDot('live');
        if (outbox.length) flush();
        if (data.version !== known.version) syncHistory();
        return;
      }
      if (data.type === 'reload') {
        // Anything that touched the screen on view reloads it, whatever the
        // reason: an edit inside the debounce of its own "added" arrives as "added".
        if (data.screen === D.screen) {
          if (data.mtime !== D.mtime) reloadKeepingScroll(true);
          return syncHistory();
        }
        // Ask the server what is newest: an "added" can arrive late, for a
        // screen that is already older than the one on view.
        syncHistory();
      } else if (data.type === 'screens') syncHistory();
      else if (data.type === 'review' && data.screen === D.screen && review()) review().refresh();
    };
    ws.onclose = function () {
      clearTimeout(guard);
      wsLive = false;
      startPolling();
      setTimeout(connect, wsRetry);
      wsRetry = Math.min(wsRetry * 2, 30000);
    };
  }

  // ---------- components ----------
  function initCompare(el) {
    var before = el.querySelector(':scope > .vc-before');
    var after = el.querySelector(':scope > .vc-after');
    if (!before || !after) return;
    var mode = el.dataset.mode === 'split' ? 'split' : 'slider';
    el.dataset.mode = mode;
    var labels = { before: el.dataset.before || 'Before', after: el.dataset.after || 'After' };
    var head = h('div', { class: 'vc-compare-head' });
    var title = h('div', { class: 'label', text: el.dataset.title || '' });
    title.style.marginBottom = '0';
    var seg = h('div', { class: 'vc-seg', role: 'group', 'aria-label': 'Compare view' });
    var bSlider = h('button', {
      type: 'button',
      'aria-pressed': String(mode === 'slider'),
      text: 'Slider',
    });
    var bSplit = h('button', {
      type: 'button',
      'aria-pressed': String(mode === 'split'),
      text: 'Side by side',
    });
    seg.appendChild(bSlider);
    seg.appendChild(bSplit);
    head.appendChild(title);
    head.appendChild(seg);

    var stage = h('div', { class: 'vc-compare-stage' });
    function pane(side, node) {
      var p = h('div', { class: 'vc-compare-pane', 'data-side': side });
      p.appendChild(node);
      p.appendChild(h('span', { class: 'vc-compare-label', text: labels[side] }));
      return p;
    }
    stage.appendChild(pane('before', before));
    stage.appendChild(pane('after', after));
    var handle = h('div', {
      class: 'vc-compare-handle',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Divider between ' + labels.before + ' and ' + labels.after,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    });
    handle.innerHTML = '<span class="vc-compare-knob">' + icon('grip') + '</span>';
    stage.appendChild(handle);
    el.innerHTML = '';
    el.appendChild(head);
    el.appendChild(stage);

    var pos = clamp(Number(el.dataset.position || 50), 0, 100);
    function setPos(p) {
      pos = clamp(Math.round(p * 10) / 10, 0, 100);
      stage.style.setProperty('--vc-pos', pos + '%');
      handle.setAttribute('aria-valuenow', String(Math.round(pos)));
      handle.setAttribute('aria-valuetext', Math.round(pos) + '% ' + labels.before);
    }
    setPos(pos);
    function fromEvent(e) {
      var r = stage.getBoundingClientRect();
      setPos(((e.clientX - r.left) / r.width) * 100);
    }
    var dragging = false;
    stage.addEventListener('pointerdown', function (e) {
      if (el.dataset.mode !== 'slider' || e.button !== 0) return;
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      fromEvent(e);
    });
    stage.addEventListener('pointermove', function (e) {
      if (dragging) fromEvent(e);
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      stage.addEventListener(t, function () {
        dragging = false;
      });
    });
    handle.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 10 : 2;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setPos(pos - step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setPos(pos + step);
      else if (e.key === 'Home') setPos(0);
      else if (e.key === 'End') setPos(100);
      else return;
      e.preventDefault();
    });
    function setMode(m) {
      el.dataset.mode = m;
      bSlider.setAttribute('aria-pressed', String(m === 'slider'));
      bSplit.setAttribute('aria-pressed', String(m === 'split'));
    }
    bSlider.addEventListener('click', function () {
      setMode('slider');
    });
    bSplit.addEventListener('click', function () {
      setMode('split');
    });
  }

  function initThemes(el) {
    var grid = h('div', { class: 'vc-themes-grid' });
    var light = h('div', { class: 'vc-theme-pane light' });
    var dark = h('div', { class: 'vc-theme-pane dark' });
    light.appendChild(h('span', { class: 'vc-theme-tag', text: 'Light' }));
    dark.appendChild(h('span', { class: 'vc-theme-tag', text: 'Dark' }));
    var body = h('div', { class: 'vc-theme-body' });
    while (el.firstChild) body.appendChild(el.firstChild);
    var copy = body.cloneNode(true);
    copy.querySelectorAll('[id]').forEach(function (n) {
      n.id = n.id + '--dark';
    });
    light.appendChild(body);
    dark.appendChild(copy);
    grid.appendChild(light);
    grid.appendChild(dark);
    el.appendChild(grid);
  }

  function initPhone(el) {
    var device = h('div', { class: 'vc-phone-device' });
    var screen = h('div', { class: 'vc-phone-screen' });
    if (el.dataset.theme === 'dark' || el.dataset.theme === 'light')
      screen.classList.add(el.dataset.theme);
    var body = h('div', { class: 'vc-phone-body' });
    while (el.firstChild) body.appendChild(el.firstChild);
    screen.appendChild(h('div', { class: 'vc-phone-island', 'aria-hidden': 'true' }));
    if (el.dataset.statusBar !== 'false') {
      screen.appendChild(
        h(
          'div',
          { class: 'vc-phone-status', 'aria-hidden': 'true' },
          '<span>9:41</span><svg width="70" height="13" viewBox="0 0 70 13" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/><path d="M30 3.5a9 9 0 0 1 12 0l-1.4 1.5a7 7 0 0 0-9.2 0zM32.6 6.3a5 5 0 0 1 6.8 0L38 7.8a3 3 0 0 0-4 0zM36 9.2l1.4 1.5L36 12l-1.4-1.3z"/><rect x="48" y="1" width="20" height="11" rx="3" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="50" y="3" width="14" height="7" rx="1.5"/></svg>'
        )
      );
    }
    screen.appendChild(body);
    screen.appendChild(h('div', { class: 'vc-phone-home', 'aria-hidden': 'true' }));
    device.appendChild(screen);
    var fit = h('div', { class: 'vc-phone-fit' });
    fit.appendChild(device);
    el.appendChild(fit);
    el.appendChild(h('div', { class: 'vc-phone-caption', text: el.dataset.label || '390 × 844' }));
    function scale() {
      var fixed = Number(el.dataset.scale);
      var avail = (el.parentElement && el.parentElement.clientWidth) || 414;
      var s = fixed > 0 ? fixed : Math.min(1, avail / 414);
      device.style.transform = s === 1 ? '' : 'scale(' + s + ')';
      fit.style.width = 414 * s + 'px';
      fit.style.height = 868 * s + 'px';
      el.style.width = 414 * s + 'px';
    }
    scale();
    if (window.ResizeObserver && el.parentElement)
      new ResizeObserver(scale).observe(el.parentElement);
  }

  // ----- motion playground -----
  var EASES = {
    'ease-out': [0, 0, 0.2, 1],
    'ease-in': [0.4, 0, 1, 1],
    'ease-in-out': [0.4, 0, 0.2, 1],
    'ease-out-quart': [0.25, 1, 0.5, 1],
    'ease-out-expo': [0.16, 1, 0.3, 1],
    linear: [0, 0, 1, 1],
  };
  function bezier(p) {
    var x1 = p[0],
      y1 = p[1],
      x2 = p[2],
      y2 = p[3];
    function a(a1, a2) {
      return 1 - 3 * a2 + 3 * a1;
    }
    function b(a1, a2) {
      return 3 * a2 - 6 * a1;
    }
    function c(a1) {
      return 3 * a1;
    }
    function calc(t, a1, a2) {
      return ((a(a1, a2) * t + b(a1, a2)) * t + c(a1)) * t;
    }
    function slope(t, a1, a2) {
      return 3 * a(a1, a2) * t * t + 2 * b(a1, a2) * t + c(a1);
    }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 8; i++) {
        var s = slope(t, x1, x2);
        if (Math.abs(s) < 1e-6) break;
        t -= (calc(t, x1, x2) - x) / s;
      }
      if (t < 0 || t > 1 || Math.abs(calc(t, x1, x2) - x) > 1e-4) {
        var lo = 0,
          hi = 1;
        t = x;
        for (var j = 0; j < 30; j++) {
          var v = calc(t, x1, x2);
          if (Math.abs(v - x) < 1e-6) break;
          if (v < x) lo = t;
          else hi = t;
          t = (lo + hi) / 2;
        }
      }
      return calc(t, y1, y2);
    };
  }
  // Integrate a unit spring (0 → 1, at rest) at 1ms steps until it settles.
  function simulate(k, c, m) {
    var x = 0,
      v = 0,
      dt = 0.001,
      pts = [0],
      max = 0,
      settle = 0;
    for (var i = 1; i <= 5000; i++) {
      var acc = (-k * (x - 1) - c * v) / m;
      v += acc * dt;
      x += v * dt;
      pts.push(x);
      if (x > max) max = x;
      if (Math.abs(x - 1) > 0.005) settle = i;
      if (i - settle > 120 && Math.abs(v) < 0.01) break;
    }
    return {
      pts: pts,
      settle: settle,
      overshoot: Math.max(0, max - 1),
      ratio: c / (2 * Math.sqrt(k * m)),
    };
  }
  function linearEasing(pts, settle) {
    var n = 32,
      out = [];
    for (var i = 0; i <= n; i++)
      out.push(+pts[Math.min(pts.length - 1, Math.round((i / n) * settle))].toFixed(3));
    out[out.length - 1] = 1;
    return 'linear(' + out.join(', ') + ')';
  }

  function initMotion(el) {
    var d = el.dataset;
    var S = {
      type: d.type === 'tween' ? 'tween' : 'spring',
      stiffness: Number(d.stiffness || 400),
      damping: Number(d.damping || 30),
      mass: Number(d.mass || 1),
      duration: Number(d.duration || 200),
      ease: EASES[d.ease] ? d.ease : 'ease-out',
      property: /^(x|scale|opacity)$/.test(d.property || '') ? d.property : 'x',
    };
    var custom = el.querySelector(':scope > .vc-motion-subject');
    el.innerHTML = '';
    var view = h('div', { class: 'vc-motion-view' });
    var stage = h('div', {
      class: 'vc-motion-stage',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Play the motion',
    });
    var subject = custom || h('div', { class: 'vc-motion-subject' });
    subject.classList.add('vc-motion-subject');
    stage.appendChild(subject);
    var plot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    plot.setAttribute('class', 'vc-motion-plot');
    plot.setAttribute('viewBox', '0 0 300 120');
    function plotW() {
      return Math.max(120, Math.round(plot.getBoundingClientRect().width) || 300);
    }
    plot.setAttribute('role', 'img');
    var stats = h('div', { class: 'vc-motion-stats', 'aria-live': 'polite' });
    view.appendChild(stage);
    view.appendChild(plot);
    view.appendChild(stats);

    var controls = h('div', { class: 'vc-motion-controls' });
    var seg = h('div', { class: 'vc-seg', role: 'group', 'aria-label': 'Motion type' });
    var bSpring = h('button', { type: 'button', text: 'Spring' });
    var bTween = h('button', { type: 'button', text: 'Duration' });
    seg.appendChild(bSpring);
    seg.appendChild(bTween);
    var segP = h('div', { class: 'vc-seg', role: 'group', 'aria-label': 'Property' });
    var props = {};
    [
      ['x', 'Move'],
      ['scale', 'Scale'],
      ['opacity', 'Fade'],
    ].forEach(function (p) {
      props[p[0]] = h('button', { type: 'button', text: p[1] });
      props[p[0]].addEventListener('click', function () {
        S.property = p[0];
        render();
        play(true);
      });
      segP.appendChild(props[p[0]]);
    });
    var top = h('div', {});
    top.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    top.appendChild(seg);
    top.appendChild(segP);
    controls.appendChild(top);

    var uid = 'vcm' + Math.random().toString(36).slice(2, 7);
    function range(key, label, min, max, step, unit) {
      var row = h('div', { class: 'vc-motion-row' });
      var id = uid + key;
      row.innerHTML =
        '<label for="' + id + '">' + label + '</label><output for="' + id + '"></output>';
      var input = h('input', { type: 'range', id: id, min: min, max: max, step: step });
      input.value = S[key];
      row.appendChild(input);
      var out = row.querySelector('output');
      function show() {
        out.textContent = S[key] + (unit || '');
      }
      show();
      input.addEventListener('input', function () {
        S[key] = Number(input.value);
        show();
        render();
      });
      input.addEventListener('change', function () {
        play(true);
      });
      return row;
    }
    var springRows = h('div', {});
    springRows.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    springRows.appendChild(range('stiffness', 'Stiffness', 50, 1000, 10));
    springRows.appendChild(range('damping', 'Damping', 1, 100, 1));
    springRows.appendChild(range('mass', 'Mass', 0.1, 5, 0.1));
    var tweenRows = h('div', {});
    tweenRows.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    tweenRows.appendChild(range('duration', 'Duration', 50, 1000, 10, 'ms'));
    var easeRow = h('div', { class: 'vc-motion-row' });
    easeRow.innerHTML = '<label for="' + uid + 'ease">Easing</label><span></span>';
    var sel = h('select', { id: uid + 'ease' });
    Object.keys(EASES).forEach(function (k) {
      var o = h('option', {
        value: k,
        text: k + (k === 'ease-out' || k === 'ease-in' ? ' (DorkOS)' : ''),
      });
      sel.appendChild(o);
    });
    sel.value = S.ease;
    sel.addEventListener('change', function () {
      S.ease = sel.value;
      render();
      play(true);
    });
    easeRow.appendChild(sel);
    tweenRows.appendChild(easeRow);
    controls.appendChild(springRows);
    controls.appendChild(tweenRows);
    var code = h('pre', { class: 'vc-motion-code', 'aria-label': 'Values' });
    controls.appendChild(code);
    var actions = h('div', { class: 'vc-motion-actions' });
    var bPlay = h(
      'button',
      { type: 'button', class: 'vc-btn vc-btn-primary' },
      icon('play') + 'Play'
    );
    var bCopyM = h('button', { type: 'button', class: 'vc-btn' }, icon('copy') + 'Copy Motion');
    var bCopyC = h('button', { type: 'button', class: 'vc-btn' }, icon('copy') + 'Copy CSS');
    actions.appendChild(bPlay);
    actions.appendChild(bCopyM);
    actions.appendChild(bCopyC);
    controls.appendChild(actions);
    el.appendChild(view);
    el.appendChild(controls);

    bSpring.addEventListener('click', function () {
      S.type = 'spring';
      render();
      play(true);
    });
    bTween.addEventListener('click', function () {
      S.type = 'tween';
      render();
      play(true);
    });

    var sim, curve;
    function motionText() {
      if (S.type === 'spring')
        return (
          'transition={{ type: "spring", stiffness: ' +
          S.stiffness +
          ', damping: ' +
          S.damping +
          (S.mass !== 1 ? ', mass: ' + S.mass : '') +
          ' }}'
        );
      return (
        'transition={{ duration: ' +
        S.duration / 1000 +
        ', ease: [' +
        EASES[S.ease].join(', ') +
        '] }}'
      );
    }
    function cssText() {
      var prop = S.property === 'opacity' ? 'opacity' : 'transform';
      if (S.type === 'spring')
        return (
          'transition: ' + prop + ' ' + sim.settle + 'ms ' + linearEasing(sim.pts, sim.settle) + ';'
        );
      var e = EASES[S.ease];
      return (
        'transition: ' +
        prop +
        ' ' +
        S.duration +
        'ms ' +
        (S.ease === 'linear' ? 'linear' : 'cubic-bezier(' + e.join(', ') + ')') +
        ';'
      );
    }
    function distance() {
      return Math.max(40, stage.clientWidth - 56 - 48);
    }
    function render() {
      bSpring.setAttribute('aria-pressed', String(S.type === 'spring'));
      bTween.setAttribute('aria-pressed', String(S.type === 'tween'));
      for (var k in props) props[k].setAttribute('aria-pressed', String(S.property === k));
      springRows.style.display = S.type === 'spring' ? 'flex' : 'none';
      tweenRows.style.display = S.type === 'tween' ? 'flex' : 'none';
      var ease = bezier(EASES[S.ease]);
      if (S.type === 'spring') {
        sim = simulate(S.stiffness, S.damping, S.mass);
        curve = sim.pts;
      } else {
        curve = [];
        for (var i = 0; i <= S.duration; i++) curve.push(ease(i / S.duration));
        sim = { pts: curve, settle: S.duration, overshoot: 0, ratio: null };
      }
      // plot
      var W = plotW();
      plot.setAttribute('viewBox', '0 0 ' + W + ' 120');
      var T = Math.max(curve.length - 1, 1) * 1.08;
      var lo = Math.min(0, Math.min.apply(null, curve)),
        hi = Math.max(1.08, Math.max.apply(null, curve) + 0.04);
      function X(t) {
        return (t / T) * (W - 4) + 2;
      }
      function Y(v) {
        return 116 - ((v - lo) / (hi - lo)) * 108;
      }
      var path = '';
      var stepN = Math.max(1, Math.floor(curve.length / 150));
      for (var j = 0; j < curve.length; j += stepN)
        path += (j ? 'L' : 'M') + X(j).toFixed(1) + ' ' + Y(curve[j]).toFixed(1);
      path += 'L' + X(curve.length - 1).toFixed(1) + ' ' + Y(curve[curve.length - 1]).toFixed(1);
      plot.innerHTML =
        '<path class="vc-axis" d="M2 ' +
        Y(0) +
        'H' +
        (W - 2) +
        'M2 ' +
        Y(1) +
        'H' +
        (W - 2) +
        '"/>' +
        '<line class="vc-settle" x1="' +
        X(sim.settle) +
        '" x2="' +
        X(sim.settle) +
        '" y1="4" y2="116"/>' +
        '<path class="vc-curve" d="' +
        path +
        '"/>' +
        '<circle class="vc-dot" r="0" cx="0" cy="0"/>';
      plot.setAttribute('aria-label', 'Progress over ' + sim.settle + ' milliseconds');
      var px = Math.round(sim.overshoot * distance());
      var over =
        sim.overshoot < 0.005 ? 'none' : (sim.overshoot * 100).toFixed(1) + '% (' + px + 'px here)';
      stats.innerHTML =
        '<span>' +
        (S.type === 'spring' ? 'Settles in' : 'Lasts') +
        ' <b>' +
        sim.settle +
        'ms</b></span>' +
        '<span>Overshoot <b>' +
        over +
        '</b></span>' +
        (sim.ratio !== null
          ? '<span>Damping ratio <b>' +
            sim.ratio.toFixed(2) +
            '</b> ' +
            (sim.ratio >= 1 ? '(no bounce)' : sim.ratio > 0.85 ? '(barely bounces)' : '(bounces)') +
            '</span>'
          : '') +
        (reduced() ? '<span><b>Reduced motion:</b> jumps</span>' : '');
      code.textContent = motionText() + '\n' + cssText();
      paint();
    }

    // Live element: interruptible. A spring keeps its velocity when you replay
    // mid-flight; a tween restarts from wherever the element is.
    var st = { x: 0, v: 0, target: 0, from: 0, t0: 0, raf: 0, last: 0 };
    function paint() {
      var x = st.x;
      if (S.property === 'x') {
        subject.style.transform = 'translateX(' + (x * distance()).toFixed(2) + 'px)';
        subject.style.opacity = '';
      } else if (S.property === 'scale') {
        subject.style.transform =
          'translateX(' +
          (distance() / 2).toFixed(0) +
          'px) scale(' +
          (0.4 + 0.6 * x).toFixed(4) +
          ')';
        subject.style.opacity = '';
      } else {
        subject.style.transform = 'translateX(' + (distance() / 2).toFixed(0) + 'px)';
        subject.style.opacity = String(clamp(0.08 + 0.92 * x, 0, 1));
      }
    }
    function dot(t, x) {
      var c = plot.querySelector('.vc-dot');
      if (!c) return;
      var T = Math.max(curve.length - 1, 1) * 1.08;
      var lo = Math.min(0, Math.min.apply(null, curve)),
        hi = Math.max(1.08, Math.max.apply(null, curve) + 0.04);
      var p = st.target === 1 ? x : 1 - x;
      c.setAttribute('cx', ((t / T) * (plotW() - 4) + 2).toFixed(1));
      c.setAttribute('cy', (116 - ((p - lo) / (hi - lo)) * 108).toFixed(1));
      c.setAttribute('r', t > 0 && t < curve.length ? '3.5' : '0');
    }
    function frame(now) {
      var dt = Math.min(0.032, (now - st.last) / 1000);
      st.last = now;
      var done;
      if (S.type === 'spring') {
        var steps = Math.max(1, Math.round(dt / 0.001));
        for (var i = 0; i < steps; i++) {
          var acc = (-S.stiffness * (st.x - st.target) - S.damping * st.v) / S.mass;
          st.v += acc * 0.001;
          st.x += st.v * 0.001;
        }
        done = Math.abs(st.x - st.target) < 0.0005 && Math.abs(st.v) < 0.01;
      } else {
        var p = clamp((now - st.t0) / S.duration, 0, 1);
        st.x = st.from + (st.target - st.from) * bezier(EASES[S.ease])(p);
        done = p >= 1;
      }
      dot(now - st.t0, st.x);
      if (done) {
        st.x = st.target;
        st.v = 0;
        dot(-1, 0);
      }
      paint();
      st.raf = done ? 0 : requestAnimationFrame(frame);
    }
    function play(fromStart) {
      if (fromStart) {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
        st.x = 0;
        st.v = 0;
        st.target = 0;
      }
      st.target = st.target === 1 ? 0 : 1;
      if (reduced() || SHOT) {
        st.x = st.target;
        st.v = 0;
        paint();
        return;
      }
      st.from = st.x;
      st.t0 = performance.now();
      st.last = st.t0;
      if (!st.raf) st.raf = requestAnimationFrame(frame);
    }
    stage.addEventListener('click', function () {
      play(false);
    });
    stage.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        play(false);
      }
    });
    bPlay.addEventListener('click', function () {
      play(false);
    });
    function copy(kind) {
      var text = kind === 'motion' ? motionText() : cssText();
      var done = function () {
        sendEvent({
          type: 'motion',
          action: 'copy',
          format: kind,
          values: Object.assign({}, S, {
            settleMs: sim.settle,
            overshoot: +sim.overshoot.toFixed(4),
          }),
          text: text,
        });
        toast('<b>Copied</b> ' + (kind === 'motion' ? 'Motion values' : 'CSS') + feedbackLine());
      };
      var fallback = function () {
        var ta = h('textarea', {});
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
        } catch {
          // Best effort: nothing to do if this fails.
        }
        ta.remove();
        done();
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    }
    bCopyM.addEventListener('click', function () {
      copy('motion');
    });
    bCopyC.addEventListener('click', function () {
      copy('css');
    });
    window.addEventListener('vc:motion', render);
    if (window.ResizeObserver)
      new ResizeObserver(function () {
        render();
      }).observe(stage);
    render();
    if (SHOT) {
      st.x = 1;
      paint();
    }
  }

  function init(scope) {
    scope = scope || document;
    // Themes first: its clone carries un-initialised components into the dark pane.
    scope.querySelectorAll('.vc-themes:not([data-vc-ready])').forEach(function (el) {
      el.setAttribute('data-vc-ready', '');
      initThemes(el);
    });
    [
      ['.vc-compare', initCompare],
      ['.vc-phone', initPhone],
      ['.vc-motion', initMotion],
    ].forEach(function (pair) {
      scope.querySelectorAll(pair[0] + ':not([data-vc-ready])').forEach(function (el) {
        el.setAttribute('data-vc-ready', '');
        try {
          pair[1](el);
        } catch (e) {
          console.error('[visual-companion] ' + pair[0] + ' failed:', e);
        }
      });
    });
    enhanceChoices(scope);
  }

  // ---------- public API ----------
  var api_ = {
    send: sendEvent,
    choice: function (value, metadata) {
      return sendEvent(
        Object.assign({ type: 'choice', choice: value, value: value }, metadata || {})
      );
    },
    theme: function (t) {
      if (t) setTheme(t);
      return currentTheme();
    },
    reducedMotion: function (on) {
      if (on !== undefined) setMotion(on === null ? null : on ? 'reduce' : 'full');
      return reduced();
    },
    pin: function (on) {
      setPinning(on === undefined ? !pinning : !!on);
    },
    go: go,
    init: init,
    sendNow: sendNow,
    screen: D,
  };
  window.vc = api_;
  window.brainstorm = api_; // v1 name

  // Put back this screen's picks as the person left them. If that same
  // selection was already sent, don't offer to send it again.
  function restoreSaved() {
    var sv = D.saved || {};
    var picks = sv.choices && sv.choices.length ? sv.choices : sv.sent || [];
    picks.forEach(function (c) {
      document.querySelectorAll('[data-choice]').forEach(function (el) {
        if (el.dataset.choice !== c) return;
        el.classList.add('selected');
        if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'true');
        window.selectedChoice = c;
      });
    });
    if (sv.sentAt) {
      var sentIds = (sv.sent || []).slice().sort().join('|');
      sentInfo = { at: sv.sentAt, labels: sv.sentLabels || [], message: sv.sentMessage || null };
      // The pick on screen is the one that was sent: show it as sent.
      if (sentIds === picks.slice().sort().join('|')) sentSig = JSON.stringify(currentSelection());
      else sentSig = '__changed__';
    }
    syncSendBar();
  }

  // ---------- start ----------
  init(document);
  if (!SHOT) restoreSaved();
  if (window.__vcMotion) applyMotionRules();
  if (!SHOT) {
    buildBar();
    try {
      var y = sessionStorage.getItem('vc-scroll:' + D.screen);
      if (y) {
        sessionStorage.removeItem('vc-scroll:' + D.screen);
        scrollTo(0, Number(y));
      }
      if (!sessionStorage.getItem('vc-seen-bar')) {
        sessionStorage.setItem('vc-seen-bar', '1');
        peekBar();
      }
    } catch {
      // Best effort: nothing to do if this fails.
    }
    // A newer screen that landed while this tab was reloading still gets its chip.
    try {
      var seen = sessionStorage.getItem('vc-latest:' + D.session);
      if (PINNED && seen && D.latest && seen !== D.latest && D.screen !== D.latest)
        newScreenChip(D.latest);
    } catch {
      // Best effort: nothing to do if this fails.
    }
    rememberLatest(D.latest);
    connect();
  }
  var ready = function () {
    window.__vcReady = true;
    root.setAttribute('data-vc-ready', '');
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(ready, ready);
  else ready();
})();

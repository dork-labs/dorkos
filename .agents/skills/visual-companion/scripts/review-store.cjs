// The review notes, read back from the events log. Shared by the server (the page
// asks for a screen's notes) and `vc review` (the agent lists and answers them).
//
// A note is a `pin` event. Later events change it:
//   pin          (same n, same text) keeps its status; new text reopens it
//   pin-resolve  { n, status: 'resolved' | 'dismissed', reply } — the agent's answer
//   pin-delete   removes it
//   delivery     { notes:[n], state: 'queued'|'delivering'|'delivered'|'failed', reason } — where a Send is
// Crops (shots/notes/<screen>-<n>.png) are found on disk, never stored in events.
const fs = require('fs');
const path = require('path');

function slug(s) {
  return (
    String(s)
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'screen'
  );
}

function cropPath(shotsDir, screen, n) {
  return path.join(shotsDir, 'notes', slug(screen) + '-' + n + '.png');
}

// Every note still standing on a screen (or every screen, with screen = null).
function notes(events, screen, shotsDir) {
  const byScreen = new Map();
  for (const e of events) {
    if (screen !== null && screen !== undefined && e.screen !== screen) continue;
    if (!byScreen.has(e.screen)) byScreen.set(e.screen, new Map());
    const m = byScreen.get(e.screen);
    if (e.type === 'pin') {
      const was = m.get(e.n);
      const same = was && was.note === e.note;
      const next = { ...e, kind: e.kind || 'request', status: same ? was.status : 'open' };
      if (same && was.reply) Object.assign(next, { reply: was.reply, answered: was.answered });
      if (same && was.delivery) next.delivery = was.delivery;
      if (!same) delete next.reply;
      delete next.quiet;
      m.set(e.n, next);
    } else if (e.type === 'pin-delete') m.delete(e.n);
    else if (e.type === 'delivery') {
      // Where a sent note is: queued, delivered or failed (with why). New text resets it.
      for (const n of e.notes || [])
        if (m.has(n))
          m.set(n, {
            ...m.get(n),
            delivery: { state: e.state, reason: e.reason || null, at: e.timestamp },
          });
    } else if (e.type === 'pin-resolve' && m.has(e.n)) {
      const p = m.get(e.n);
      m.set(e.n, {
        ...p,
        status: e.status === 'dismissed' ? 'dismissed' : 'resolved',
        reply: e.reply || '',
        answered: e.timestamp,
      });
    }
  }
  const out = [];
  for (const [scr, m] of byScreen) {
    for (const p of m.values()) {
      if (shotsDir) {
        const c = cropPath(shotsDir, scr, p.n);
        if (fs.existsSync(c)) p.crop = c;
      }
      out.push(p);
    }
  }
  return out;
}

// A compact line for the agent: "settings#2 · fix · open · The hint competes…  →  #searchBtn · …".
function line(p) {
  const tag = p.kind === 'note' ? 'note' : p.intent || 'fix';
  return `${p.screen}#${p.n} · ${tag} · ${p.status}${p.reply ? ' (' + p.reply + ')' : ''} · ${p.note}${p.ref ? '  →  ' + p.ref : ''}`;
}

module.exports = { notes, cropPath, slug, line };

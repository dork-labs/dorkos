---
name: visual-companion
description: Browser-based visual companion for showing mockups, diagrams, comparisons, and interactive options. Use when the user would understand something better by seeing it than reading it.
license: Complete terms in LICENSE.txt
---

# Visual companion

A small local server that shows HTML screens in the DorkOS frame (DorkOS
tokens, both themes, history, pin notes) on the DorkOS canvas. You write a
screen; it appears; what the person does there comes back to you.

**Use it when the answer is visual**: layouts, mockups, motion, side-by-side
directions, diagrams. **Stay in chat when the answer is words**: scope,
trade-offs, concepts. For a quick pick between a few labelled choices, a
dorkos-ui widget in chat is lighter (its buttons give you a turn directly). Use
the companion when the choice needs to be seen.

All commands below are `scripts/vc` in this skill. Each prints one JSON object.

## The loop

1. **Show a screen.** Write a fragment to a temp file, then:
   ```bash
   scripts/vc show /tmp/layout.html            # add --wake to let a Send reach you
   ```
   This starts the server if needed (on the port this session had last, else a free one;
   it never touches another process), writes the screen, and returns `url`, `screen`,
   `screen_url` and `shots` (light and dark PNGs you can Read to check your
   own work). Run it from your project root, or pass `--project-dir`.
2. **Open it on the canvas.** The first time, or whenever the canvas lost it:
   `control_ui` → `browser_navigate` with `url`. Never ask the person to open a
   URL. In a room, pass `target: { roomId }` so it lands on the room's canvas.
   Once it's open, later screens arrive by themselves (WebSocket, falling back
   to polling through the preview proxy). There's no need to navigate again.
3. **Say one line in chat** about what's on screen and what you want from it.
4. **Read what happened.** Feedback arrives in chat. Structured detail is in
   `scripts/vc events` (only what's new since your last read).
5. **Iterate** with a new screen (`layout-v2.html`). Names are never reused; `vc
show` adds `-2`, `-3` if needed. When the conversation moves on, show a
   short "Back in chat" screen so a settled choice doesn't linger.

**Check it's alive on every turn** before relying on it: `scripts/vc status`
(`running: false` → the next `vc show` restarts it with the same screens,
history and port; re-open the canvas if a screen doesn't appear). It stops
itself after 4 hours idle (`vc start --idle 30m` to change; polls from an open
tab don't count).

## Waking you (Send)

By default, clicks are only recorded. To be woken, show the screen with
`--wake` (or `<meta name="vc-wake" content="on">`). It then gets a reply dock
("Send to @<your agent's name>", from `.dork/agent.json` or `--label`). **Send** (or ⌘↵), or a **submitted request pin**, wakes the
chat that ran `vc show` with a `<ui_action>` turn carrying the screen's full
selection, any written reply (as `message`), and every open request pinned on it. Exploration (toggling options, sliders, theme,
history) never wakes anyone.

A long reply arrives whole. Only when a `<ui_action>` would pass DorkOS's 8 KB payload cap
is anything trimmed: first pin details you can read back with `vc review list` (state,
source, selector), then older pins, then the reply. A shortened reply says
`message_truncated: true`, and `message_full_at` points at the whole text in `events_file`.

- While you're mid-turn, DorkOS answers 409 and the companion retries until
  you're free (up to 30 minutes; at most 20 wakes an hour).
- **Where a Send goes.** Each screen remembers the chat that showed it
  (`$DORKOS_SESSION_ID`, else `$CLAUDE_CODE_SESSION_ID`). A Send on that
  screen wakes that chat, even if other chats have shown screens on the same
  server since. So show a screen from the chat that should hear back. In
  practice: the chat talking to the person shows it. A spin-off showing work for
  review should pass `--session <the main chat's id>` so the answer reaches the
  chat the person is in, not the builder.
- Override the target with `--session <id>`. `vc route off` silences waking;
  `vc route on --via message` queues as a chat message instead; `vc route
status` shows recent deliveries.
- **Login.** The server wakes you by calling DorkOS's local API with no
  credential, which only works while DorkOS login is off (the default on this
  computer). With login on, DorkOS refuses it (`vc route on` says so, and
  `vc route status` logs it). Nothing is lost: every click and Send is still in
  `scripts/vc events`, so read it each turn.
- How this works, and the cleaner DorkOS-native path still to come:
  `references/wake-path.md`.

## Theme

Screens follow the app's theme, not the OS. In order: `?theme=` on the URL
(the in-page toggle writes it), then `<meta name="vc-theme" content="dark">`
on the screen, then the session default (`vc theme dark`, or `vc show --theme
dark`). Default is light. `get_ui_state` doesn't report the app theme yet, so
set it when you know it.

## Writing screens

Write **fragments** (no `<html>`); the frame adds tokens, chrome and scripts. A
full document (`<!doctype` / `<html>`) is served as-is, plus the chrome.

Meta tags, anywhere in the fragment (or the `vc show` flag):

| Meta                   | Flag        | Does                                                                                        |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `vc-title`             | `--title`   | Name in the bar and in wake payloads (default: first h2)                                    |
| `vc-theme` light\|dark |             | Theme for this screen                                                                       |
| `vc-css` app           | `--app-css` | Load the real DorkOS CSS: `bg-card`, `shadow-elevated`, `text-muted-foreground`, `text-sm`… |
| `vc-wake` on           | `--wake`    | Reply dock; Send and pin notes wake you                                                     |

Colours are the app's tokens as HSL channels: `hsl(var(--muted-foreground))`,
`hsl(var(--brand))`, `var(--elevation-soft)`. Frame helpers: `var(--vc-raised)`
(card surface, correct in both themes), `var(--vc-tint)`, `var(--vc-page)`. Use
real content; scale fidelity to the question; 2–4 options per screen.

### Classes

- `h2` title, `.subtitle`, `.section`, `.label` (small caps)
- **Choices**: `.options` > `.option[data-choice]` with `.letter` + `.content`
  (`h3`, `p`), or `.cards` > `.card[data-choice]` with `.card-image` + `.card-body`.
  Add `onclick="toggleSelect(this)"`; `data-multiselect` on the container for
  several. Keyboard and screen-reader support is added for you.
- **Choices look like choices.** The frame gives every `.option`/`.card[data-choice]`
  a radio (a check box in `data-multiselect` groups) and the group a "Choose one"
  (or "Choose any") label, in full documents too. Opt out per screen with
  `<meta name="vc-choices" content="plain">`, or per group with `data-vc-plain`.
- **Picks persist.** Each pick saves the screen's selection (a `select` event),
  so leaving a screen and coming back restores it.
- `.mockup` > `.mockup-header` + `.mockup-body`; `.split` (two columns);
  `.pros-cons` > `.pros`/`.cons`; wireframe bits `.placeholder`, `.mock-nav`,
  `.mock-sidebar`, `.mock-content`, `.mock-button`, `.mock-input`.

### Design components

```html
<!-- Before / after: drag slider (keyboard: arrows, Home/End) + side-by-side toggle -->
<div
  class="vc-compare"
  data-title="Session row"
  data-before="Today"
  data-after="Proposed"
  data-mode="slider"
>
  <div class="vc-before">…or <img /></div>
  <div class="vc-after">…</div>
</div>

<!-- Both themes: the same fragment rendered light and dark (data-stack for vertical) -->
<div class="vc-themes">…any fragment…</div>

<!-- Phone frame 390×844; scales to fit; data-theme="dark", data-status-bar="false", data-scale="0.75" -->
<div class="vc-phones">
  <div class="vc-phone" data-label="Today · 390 × 844">…</div>
</div>

<!-- Motion playground: spring or duration/easing, live element + curve, copyable values -->
<div
  class="vc-motion"
  data-type="spring"
  data-stiffness="400"
  data-damping="30"
  data-mass="1"
  data-duration="200"
  data-ease="ease-out"
  data-property="x|scale|opacity"
></div>
```

The motion playground reports settle time, overshoot (as % and px) and damping
ratio, and copies Motion (`transition={{ type: "spring", … }}`) or CSS
(`linear()` for springs). A copy is recorded as a `motion` event.

## The frame

A floating bar (top right), always visible as a small handle ("3 / 15 ⋯"). It
expands to the full controls on hover, on focus, or when the pointer nears the
top, and stays open from one screen to the next:

- **‹ title n/N ›** is the history of every screen in the session (⌘← ⌘→).
  Viewing an older screen holds it there; a new screen shows a "New screen" chip.
- **All screens** (G, the list button, or the count) opens a jump list: every
  screen with a thumbnail, its position and a Sent mark. Arrow keys and Enter;
  Esc closes it. Past 8 screens it filters as you type.
- **Pin** (C): point at anything (↑/↓ widen or narrow the pick) and click to drop
  a numbered note. Pins are the review layer, the same one prototypes get (see
  "Reviewing designs"). Each note records the element, its exact source line, the
  page state, an intent, and whether it's for you or just a note. Notes survive
  reloads and can be removed. Esc steps back.
- **Reduced motion** (M) forces `prefers-reduced-motion` on and off for the
  page. Media rules and `matchMedia` both follow it.
- **Theme** (T). The dot shows the connection: green live, amber polling, red offline.

On a wake screen, a **reply dock** sits at the bottom:

- A status line, a reply box and Send. Send stays off until there's a pick or
  some text. A written reply can go on its own or with a pick (Enter sends,
  Shift+Enter is a new line; the draft survives a reload). Pins stay for notes
  about one spot.
- Under each choice group, "None of these, I'll write my own" clears the pick
  and puts the cursor in the reply box.
- **Sent screens say so.** After a Send the dock reads "Sent to @<agent> at
  2:14 PM · what was picked · "the reply"", and the sent option is tagged
  "Sent". Changing the pick or typing turns the button into "Send update".
- **Send moves on** to the next later screen that hasn't been sent; on the last
  one it says so. So show a set of questions in order.

## Events

`scripts/vc events` prints new events as JSONL (`--all` for everything,
`--peek` to leave the cursor). Every event has `type`, `screen`, `theme` and `timestamp`.

```jsonl
{"type":"click","choice":"b","label":"B · Busy","text":"B Busy More.","screen":"layout"}
{"type":"pin","n":1,"note":"Make this calmer","kind":"request","intent":"refine","selector":"div[data-choice=\"a\"] > div.content > h3","source":{"markup":"content/layout.html:3","exact":true},"ref":"div[data-choice=\"a\"] > div.content > h3 · heading “Quiet” · content/layout.html:3","x":412,"y":233,"rel":{"x":0.2,"y":0.5}}
{"type":"pin-resolve","n":1,"status":"resolved","reply":"Dropped the weight to 500","by":"agent"}
{"type":"select","choices":["b"]}
{"type":"send","selection":[{"choice":"b","label":"B · Busy"}],"pins":1,"message":"Smaller title"}
{"type":"motion","action":"copy","format":"motion","values":{"type":"spring","stiffness":400,"damping":30,"settleMs":356,"overshoot":0.027}}
```

Clicks show the path to a choice, and `select` holds the screen's current picks; the last one, or the Send, is the answer.
From a page script: `vc.send({type, …})`, `vc.choice(value)`, `vc.theme()`,
`vc.reducedMotion()`, `vc.pin()`, `vc.go(name)`.

## Reviewing designs

The pins on a screen are one **review layer** (`scripts/review.js`). The same
script rides on full prototypes, so feedback works the same way everywhere:
fragments here, and prototypes on any port.

**What a note tells you.** Each note carries:

- the element: selector, role and name, size, and the spot clicked
- `source`: exact `file:line` from `data-src` stamps (`exact: true`), else a grep guess
- `state`: what the page was showing (the director's values), so you can put it back
- `intent`: fix / refine / explore
- `kind`: `request` (for you), or `note` (the person's own; never sent, never wakes you)
- `ref`: one line to quote, with the JSON beside it
- `crop`: a PNG of the element, replayed in its state at Send (`shots/notes/<screen>-<n>.png`)

**Answer every note.** People see your answer on the pin:

```bash
scripts/vc review list                     # open requests (--all for everything, --screen S)
scripts/vc review resolve 2 "Dropped the kbd until hover"   # a check and your line on the page
scripts/vc review dismiss settings#3 "Kept it: the test showed it reads faster"
scripts/vc review crop 2                   # retake a crop
```

Use `<screen>#<n>` when the same number exists on two screens.

**Reviewing a full prototype.**

```bash
scripts/vc review open http://localhost:<port>/<path>/index.html --name settings --title "Settings" --wake
```

This prints a `url` (with `?review=&vc=&vt=`). Open it on the canvas. A prototype built
with the director kit loads the review layer by itself. For any other page, add one
line: `<script src="<vc>/vc/review.js"></script>`. A same-origin host page can also
inject it. Either way, load the layer from the companion server (`<vc>/vc/review.js`),
never from a local copy or symlink, so moving folders can't break it.
Send posts the notes and wakes you once. Its crops land first.

**The link is the key.** `vt` is a random token minted for that review. The page
runs on another origin, so the companion takes its notes and Sends only with that
token; any other local page that posts gets a 403 and wakes nobody. Running
`vc review open` again mints a new token, so share the newest link.

**Where sent notes are (the Send lifecycle).** Every note in a reviewed prototype always
says where it is: ready → sending → queued (you're mid-turn) → with you → you're on it →
still open (your turn ended without closing it) → done or dismissed; or not sent (with why,
and Try again). While your chat waits on the person (DorkOS lifecycle `blocked`), the page
says you need them, with Open chat. Send only ever carries notes that haven't gone, so it can't repeat, and
pinning stays safe while you work. The companion writes `delivery` events (queued,
delivered, failed, unrouted) and replays queued Sends after a restart. `GET vc/review-status`
adds your chat's DorkOS `status.lifecycle` (`idle`, `streaming`, `blocked`, `error` or
`interrupted`). A Send DorkOS already took is never sent again. So **answer every note**
with `vc review resolve|dismiss`: a note you act on but never close shows as "still open"
to the person.

**Serve prototypes no-store** (`Cache-Control: no-store`, never `python3 -m http.server`),
so a reload always shows the latest build. A host page that injects the layer should
put the director state back after it reloads (`director.go(state)`), and never reload
while a note is open.

**Never share a review link you haven't seen working.** `vc review open` checks the
page and returns `pins: false` plus a `warning` when the page doesn't load the layer.
Act on it. Before you tell the person "pin anything", check in a headless browser that
the page has a `<review-layer>` host (the Review pill) and no page errors. A link with
no pill sends them looking for a button that isn't there.

**Building prototypes: the director kit** (`scripts/director.js`). A prototype
declares its knobs, and the kit draws the bar:

- **scenarios** (where you are): scale, and the named data states `Director.DATA`
  (empty / one / many / error / offline)
- **lenses** (how it looks): theme, reduced motion, sound. A pin stays put across them.
- **states** (a menu of one-off places) and **play** (steps)

The kit keeps non-default values in the URL and exposes
`window.director = { state(), go(state), knobs, … }`. Start from
`examples/prototype/`. `node scripts/build-proto.cjs <dir>` inlines `src/` and the
kit into one `index.html`, with every tag stamped `data-src="src/<file>:<line>"`.
React prototypes use `scripts/babel-plugin-data-src.cjs` in dev.

Stamps are for review only. The server stamps fragments in memory as it serves
them, so `content/` stays as written. A built `index.html` is a generated file
(gitignored for the example here). Never wire the plugin or `stamp-src.cjs` into
an app's production build.

**How to act on notes.**

- **Trust the code over the screenshot.** Change only what the notes point at, and
  leave everything else exactly as it is.
- **Tweaks before turns.** If a note asks for a value (a size, a colour, a delay),
  expose it as a knob the person can move. Don't spend a round trip guessing it.
- **Show variants as `1a`, `1b`, `1c`**, each on a different axis (for example
  density, hierarchy, motion), not three shades of one idea. Notes can then name them.

**Transport** is one seam in `review.js` (`transport`). Today Send goes to this
server, which wakes you. When DorkOS's Doc Channel (`window.dorkos.channel`) is
ready, the layer emits `review.send` there instead. Keep page code off the
transport, so a host can swap it without touching the page.

## Screenshots

Every new or edited screen is shot headless in light and dark into
`<session>/shots/<name>.{light,dark}.png`, full page and without chrome.
`vc show` waits for them (about 1.5s) and returns the paths. `--no-wait` skips the wait.
This needs playwright-core and a Chromium. playwright-core comes from
`VC_PLAYWRIGHT`, then the DorkOS repo's install. The browser is `VC_CHROME`,
then the one Playwright installed, then a system Chrome. If none is found,
`vc show` returns `shots_error` saying what to set; the screen still shows.

## Decisions

When a screen settles a design question, record it where the project keeps
decisions (in this repo: an ADR, or a note in the spec's folder): context,
options, the call and why. Link the screen and its shots, e.g.
`.dork/visual-companion/<session>/content/<screen>.html`. Skip it for quick
one-off questions.

## Setup and options

Nothing to set up inside this repo. The first `vc show` builds
`scripts/assets/tokens.css` (the frame's colours) from the repo, and a screen
that asks for `--app-css` builds `app.css` too. Both are generated and
gitignored; `scripts/vc build` rebuilds them after the app's styles change.

| Setting                        | Default                                   | Use it to                                       |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------- |
| `--port N`, `VC_PORT`          | the session's last port, else a free one  | pin a port (walks up if it's taken)             |
| `--dorkos P`, `VC_DORKOS_REPO` | the git checkout this skill lives in      | build assets when the skill is copied elsewhere |
| `VC_CHROME`                    | Playwright's Chromium, then system Chrome | pick the browser for screenshots                |
| `VC_PLAYWRIGHT`                | the repo's playwright-core                | point at another playwright-core                |
| `--idle 30m`                   | 4h                                        | stop sooner when nobody's looking               |

`BRAINSTORM_PORT` still works as `VC_PORT`, for v1 callers.

## Reference

- `scripts/vc` (`vc.cjs`): the CLI (show, start, status, stop, build, events, route, theme, review)
- `scripts/server.cjs`: zero-dependency server; `GET vc/state`, `vc/health`, `vc/pins`, `vc/review`, `vc/review-status`, `vc/review.js`, `vc/director.js`, `vc/shot/<file>`; `POST vc/event` (another localhost origin needs the review's token)
- `scripts/review.js`: the review layer (pins, notes, Send), for fragments and prototypes
- `scripts/review-store.cjs`: notes and answers read back from events
- `scripts/director.js`: the director kit; `scripts/build-proto.cjs`: inline + stamp a template prototype
- `scripts/stamp-src.cjs`, `scripts/babel-plugin-data-src.cjs`: `data-src` stamps
- `scripts/crop.cjs`: note crops, replayed in state
- `examples/prototype/`: a starter prototype on the kit
- `scripts/frame-template.html`, `frame.css`, `boot.js`, `helper.js`: the frame
- `scripts/shoot.cjs`: screenshots; `scripts/locate.cjs` finds the repo, playwright-core and Chromium
- `scripts/build-assets.mjs` (`vc build`): builds `scripts/assets/tokens.css` and `app.css` from the DorkOS repo
- `tests/run.sh`: 43 headless checks (playwright-core + Chromium, about 90s)
- `examples/components.html`: every component on one screen
- `scripts/start-server.sh`, `stop-server.sh`: the v1 entry points, still working

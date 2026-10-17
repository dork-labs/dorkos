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
("Send to @<your agent's name>", from `.dork/agent.json` or `--label`). **Send** (or ⌘↵), or a **submitted pin note**, wakes the
chat that ran `vc show` with a `<ui_action>` turn carrying the screen's full
selection, any written reply (as `message`), and every pin on it. Exploration (toggling options, sliders, theme,
history) never wakes anyone.

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
- **Pin** (C): click anywhere to drop a numbered note. It's recorded with x/y,
  selector and text, survives reloads, and can be removed. Esc finishes.
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
{"type":"pin","n":1,"note":"Make this calmer","x":412,"y":233,"selector":"div.option:nth-of-type(1) > div.content > h3","rel":{"x":0.2,"y":0.5},"target":"Quiet"}
{"type":"select","choices":["b"]}
{"type":"send","selection":[{"choice":"b","label":"B · Busy"}],"pins":1,"message":"Smaller title"}
{"type":"motion","action":"copy","format":"motion","values":{"type":"spring","stiffness":400,"damping":30,"settleMs":356,"overshoot":0.027}}
```

Clicks show the path to a choice, and `select` holds the screen's current picks; the last one, or the Send, is the answer.
From a page script: `vc.send({type, …})`, `vc.choice(value)`, `vc.theme()`,
`vc.reducedMotion()`, `vc.pin()`, `vc.go(name)`.

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

- `scripts/vc` (`vc.cjs`): the CLI (show, start, status, stop, events, route, theme)
- `scripts/server.cjs`: zero-dependency server; `GET vc/state`, `vc/health`, `vc/pins`, `vc/shot/<file>`; `POST vc/event`
- `scripts/frame-template.html`, `frame.css`, `boot.js`, `helper.js`: the frame
- `scripts/shoot.cjs`: screenshots; `scripts/locate.cjs` finds the repo, playwright-core and Chromium
- `scripts/build-assets.mjs` (`vc build`): builds `scripts/assets/tokens.css` and `app.css` from the DorkOS repo
- `tests/run.sh`: 42 headless checks (playwright-core + Chromium, about 90s)
- `examples/components.html`: every component on one screen
- `scripts/start-server.sh`, `stop-server.sh`: the v1 entry points, still working

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!--
  Unreleased entries live in changelog/unreleased/ — one file per change.
  Do NOT add entries here; add a fragment instead. See changelog/README.md.
  Only /system:release compiles fragments into a version section below.
-->

## [0.74.0] - 2026-09-07

> DorkOS 0.74.0 puts you in charge of the accounts your agents act through, moves remote access into the Control Center, and cleans up the whole app: one word for connections, grouped Settings tabs, and a calmer, keyboard-friendly interface everywhere.

### Added

- Remote access now lives in the Control Center — flip it on, and a globe appears in the top bar with your link and QR code one click away
- ⌘K knows about it too: search for "remote" to copy the link, show the QR code, or turn remote access on or off
- You can now scroll back through a room's older messages. A room opens on its
  most recent fifty, and an "Older messages" button at the top loads the fifty
  before those — as many times as you like, back to the day the room started.
  The room keeps your place when the older messages land (DOR-1734)
- Review the exact connected account and actions each named agent can use in Connections.
- Use approved Composio actions from Claude Code, Codex, OpenCode, or the `dorkos connections` command.
- Let programs request a connection change and follow its status without gaining owner access.
- Show an explicit unknown outcome when an approved change may have finished but its confirmation could not be saved.
- You can now tell DorkOS that an account on another platform is you, and it stops notifying you about your own messages. Text your agent from your own phone and DorkOS used to buzz you about what you had just written — and again if you typed your own `@handle`. Open Team, find yourself on the platform you write from, and press "This is me"; press "Not me" to take it back. It only changes whose words DorkOS thinks those are — that account still gets nothing else on your machine, and only you can set it (DOR-1778)
- Connect several accounts for the same service, choose the exact actions each agent may use, and see the same access from the account or agent profile.
- Keep sign-in progress after a restart, review agent requests, and pause or disconnect accounts from Connections. See account usage without exposing action inputs.
- Use DorkOS-managed accounts or your own Composio account. Keep Slack and Telegram messaging separate from the actions agents may take through connected accounts.

### Changed

- Buttons give a little squeeze when you press them, everywhere in the app — the same small answer a sidebar row already gave (DOR-1751)
- Tapping a tab on your phone answers right away, instead of waiting for the next screen to load (DOR-1751)
- Sections that fold open — in Settings, Connections, agent setup and onboarding — slide instead of jumping (DOR-1751)
- Rows in a table are easier to see under the mouse, especially in dark mode (DOR-1751)
- Checkboxes pop in when you tick them, like the switches beside them (DOR-1751)
- The globe only appears while remote access is actually running, and holds still once it is — one quiet ripple when your phone can reach this machine, and nothing after that
- If your tunnel drops, every part of DorkOS finds out at once instead of waiting for the next page refresh
- Settings is easier to find your way around. The tabs are grouped now — You, Agents & sessions, Access & privacy, System — and each one is named after what is inside it. "Advanced" is gone: the message box and the switch that watches for agents you started somewhere else moved to Preferences, the logging settings moved to Server, and what was left — reset and restart — is now a tab called "Danger zone". "Show dev tools" moved to Experiments, alongside the app's other developer switches. Security and DorkOS account are one "Access" tab with a section each, and Remote Access is a proper tab instead of a window that opened on top of the settings window. Old links you saved still land in the right place (DOR-1758)
- The Server tab leads with the two things people open it for — the version and the address to paste into other apps. The folder paths and Node version now sit in a "Diagnostics" section you can open when something is wrong, with one button that copies all of them at once (DOR-1758)
- The switch that watches for agents you started somewhere else is no longer in the session panel under the message box. It changed that setting for every window on your machine, not just the session you were looking at, so it now lives only in Settings → Preferences (DOR-1758)
- One word for the outside world. Anything that links your agents to the outside world is a **connection** everywhere now — on the Connections page, in the app's own menus and dialogs, in the warning you get before letting an agent act without asking, in the message Slack and Telegram send back when someone who is not an approver taps a button, in what `dorkos doctor` reports, and on the website. The same thing used to go by four different names. Nothing you have set up changes; only the words do (DOR-1754, DOR-1814)
- Scheduled tasks are called tasks everywhere on the page now, and the run history says who started each run: a schedule, you, or an agent.
- The task form is clearer: "When it runs" instead of "Cron Expression", "Stop after" instead of "Max Runtime", and "Remember the last run" instead of "Sticky".
- Cross-project access says "project" throughout, instead of switching between project, namespace and directory.
- Settings → Runtimes now opens with a line saying what a runtime is, and the model and effort pickers say "Automatic" where they used to say "Runtime's choice".
- Settings now sounds like one product. Rows that read like a manual ("Poll for updates to sessions running outside DorkOS", "Size in KB before a log file is rotated") now say what you get in plain words, and rows whose control already spoke for itself lost their filler description (DOR-1755)
- Every heading, button and menu item is sentence case now. "Reset All Data" is "Reset all data", "Open in New Tab" is "Open in a new tab", "Add to Chat" is "Add to chat", and the headings on Home stopped SHOUTING IN CAPS (DOR-1755)
- The messages that never reached an agent are no longer called "dead letters". That screen, and the Activity tab's, now say what happened in plain words instead of a raw wire code like `hop_limit`, whose messages they were, and what clearing them does, with the raw example folded away (DOR-1755)
- The Team page's grouping chip says "Group by owner" instead of "Group: manager", which is the word the rest of the page already used (DOR-1755)
- Settings describes each group of agent tools by what the agent gets to do ("Let agents send messages and check the inbox."), not a bare command fragment (DOR-1755)
- The "Agent Discovery" tool group is now "Agent discovery", matching the other three groups.
- Mentioning you inside a private chat you have muted no longer gets through. In a 1:1 every message already reaches you, so an `@` there is not a second way in — muting that conversation now means muting all of it
- Messages you send yourself, from your own phone into a chat DorkOS is bridging, now come back to you as a notification — unless you tell DorkOS that the Telegram or Slack account is you, which you can now do on the Team page
- Message search now says what it covers in one line instead of four bullets. The full
  list is one click away, and it opens itself when a search comes back empty — which is
  when "search matches whole words" is the answer you needed (DOR-1757)
- Settings → Notifications is scannable by its bold labels. Every row's sentence is
  short, the wall of framing above them is gone, and the how-to for getting DorkOS onto
  your phone is tucked into "Get these on your phone" (DOR-1757)
- The install screen leads with one line — "Adds 12 files. Declares no commands." — and
  opens only the parts you have to read: the commands a package runs, the jobs it
  schedules, and anything that clashes. The rest is one click away, with its count on
  the label, so nothing is hidden (DOR-1757)
- The Workspaces page says what a worktree is once instead of twice, and the folder it
  scans no longer runs off the edge of a phone screen (DOR-1757)
- The small labels dotted around the app (counts, states, categories) are drawn from
  one recipe now, so the same kind of label is the same size everywhere (DOR-1760)
- The connection-lost banner now announces itself to screen readers, so whenever it
  does reach the screen it says so out loud instead of silently changing colour
  (DOR-1760)
- Side panels open in a fifth of a second instead of half a second, and the dark backdrop
  now arrives with the panel instead of ahead of it (DOR-1764)
- The sidebar and the right panel open without that little pause before they start moving
  (DOR-1764)
- The send button and the two icons in the top bar no longer grow under your mouse. They
  light up instead, the way the rest of the buttons do (DOR-1764)
- Picking one of a few side-by-side choices — like how much freedom you give an agent —
  now slides the highlight across instead of blinking it to the new spot (DOR-1764)
- Pages fade in when you switch between Home, Team and the rest, so the page keeps up with
  the menu beside it (DOR-1764)
- Copying something now shows the checkmark with a small fade, so you can see it worked
  (DOR-1764)
- Empty panels and "couldn't load that" panels now look the same everywhere in the app, instead of a little different on each screen (DOR-1763)
- Panels that list facts — a session's id, a server's settings, your usage — line those facts up the same way on every screen (DOR-1763)
- Sections that slide open and shut now all move at the same speed. Before, opening a tool card and opening a task row were the same gesture at two different speeds (DOR-1763)
- Most controls in the app now measure size the same way — extra small, small, medium, large — so two controls side by side usually line up (DOR-1761)
- `.env.example` now lists every setting the server reads — the telemetry off switches, rate limits, tracing, and the self-hosted connector gateway among them — and no longer describes a scheduler switch that nothing reads any more (DOR-1646)
- Keep each connected account under its own DorkOS identity, preserve existing agent and session access during the upgrade, and show a clear recovery error if that upgrade cannot finish. Removing one connection from an agent now stops its live tools and revokes that connection's grants, session access, and event delivery before the action completes. (DOR-1793)
- The sign-in system got a library upgrade. Your auth database updates itself the first time the new version starts — no action needed, and existing logins keep working.
- Template addresses are now limited to the ones DorkOS can actually download from: `https://`, `git@host:path`, a `github:`, `gitlab:` or `bitbucket:` shorthand (add `#branch` to pin a version), or an `owner/repo` name. Other spellings — `ssh://`, `git://`, plain `http://`, the `gh:` and `sourcehut:` shortcuts, and one-word template names — are now refused with a message naming what to use instead, because none of them ever finished a download (DOR-1825)
- Loading spinners now look the same everywhere in the app. They were drawn by hand in three dozen places, at six different sizes for the same job, so two panels loading side by side could disagree about how big "loading" is.
- The spinner on a running task now uses the app's own blue, which means it stays readable in dark mode instead of staying stuck at the light-mode shade.
- Spinners that sit next to words like "Loading files" no longer get read out a second time by a screen reader, and the ones that sit alone now say what they are waiting for.
- On a phone, the icon that replaces a spinner when something finishes is now the same size as the spinner was. Buttons and rows used to shift by a few pixels at the moment they finished loading.
- The note DorkOS adds when it shortens something now reads `… [truncated, 2400019 characters total]`, giving the full size. It used to say how much was left off instead (`… [truncated, 2395923 more characters]`), so any saved search that looks for the old wording in `~/.dork/logs/` will stop matching (DOR-1728)
- The line DorkOS writes when it crashes (`Uncaught exception`) now records the failure under `error`, the name every other error line in `~/.dork/logs/` already uses; it used to be `message` on that line only, so a saved search for it will need updating. The `Unhandled promise rejection` line keeps its wording and gains the fields it was dropping — the error's name, and codes like `ENOENT` (DOR-1827)

### Fixed

- The sort-direction button next to filter dropdowns (on Team, Tasks, and Activity) now works with the keyboard, not just a mouse click.
- Schedule preset cards now tell a screen reader their name and what they do, not the entire prompt read out in full.
- The "open this link?" dialog now works properly with a keyboard: Escape closes it, Tab stays inside it, and focus lands on it the moment it opens instead of staying stuck behind it.
- Tabbing through the right panel's tabs and the composer's status line (runtime, model, plan, and permission chips) now shows the app's keyboard focus ring instead of the browser's default one.
- Dialogs, side panels, and dropdown selectors no longer flash a focus ring when you click them with a mouse — it now only shows up for keyboard navigation, where it belongs.
- On a phone, the top of the Schedules "No schedules yet" screen was cut off behind the header. It now starts at the top and scrolls (DOR-1748)
- Marketplace cards now measure the space they actually have instead of the width of your window, so opening a side panel no longer squeezes them into unreadable slivers (DOR-1748)
- On a tablet-sized window the side panel now slides over the page instead of squashing it, and the Home tabs never shrink away to nothing (DOR-1748)
- Pop-up windows now keep a margin from the screen edges, keep their rounded corners on a phone, and scroll when they are taller than the screen (DOR-1748)
- Removed the React warnings that appeared in the browser console every time the app loaded (DOR-1748)
- Long folder paths stay inside the card that shows them. On a phone, the Workspaces page used to push yours off the side of the screen (DOR-1747)
- Marketplace cards show who made a package and where it came from, in full, on a card of any width — including the narrow columns a docked panel or a half-width window can create (DOR-1747)
- An agent's name stays readable in search results. The folder path beside it gives way first (DOR-1747)
- The marketplace search box fits on a phone, down to the smallest ones — the "/" shortcut hint it was making room for only shows where there is a keyboard to press it (DOR-1747)
- Text no longer paints outside its box in the font picker, the blocked-paths list, the discovered-agent list, a connector tile's name, chat error details, or the full-power window (DOR-1747)
- A discovered agent's suggested name and a denied agent's reason now show their full value on hover when truncated, matching every other truncated field (DOR-1747)
- Closing the "open this link?" dialog now returns your keyboard focus to the link you opened it from, instead of dropping it to the top of the page.
- The sort control in list filter bars (Tasks, Team, Activity) is bigger and easier to tap.
- Tool and thinking cards in a chat answer the mouse now, and their headers show a focus ring for people using a keyboard (DOR-1751)
- Activity rows that lead nowhere no longer look clickable or take a keyboard stop (DOR-1751)
- Cards that lift under the mouse do the same for a keyboard, so nobody learns less by not using a mouse (DOR-1751)
- Menu and list rows fade between highlights instead of flashing (DOR-1751)
- A keyboard focus ring inside a section that folds open no longer gets cut off at the edge (DOR-1751)
- Rows in the Obsidian sidebar panel keep their press feedback and hover colour again (DOR-1751)
- If turning remote access off doesn't work, DorkOS now tells you why instead of quietly leaving the switch on
- Fixed several buttons on the phone that were too small to tap reliably — the queued-message actions in the composer, the terminal and canvas tab close buttons, the schedule builder's day-of-week picker, the activity page's filter chips, the Tasks/Team/Activity filter toolbar (Status, Filter, and the active-filters badge), and the background-task bar's expand arrow all now have a proper-sized tap area, even though the button you see stays the same size. (DOR-1753)
- Fixed the search box on Tasks, Team and other pages, which was quietly disabled from growing on a phone, and a few controls that had ended up smaller on a phone than on a full-size screen. (DOR-1753)
- What a background agent last did is now shown from a normal-sized screen up. On a phone, the task list keeps the agent's full description visible instead of shortening it to make room. (DOR-1753)
- The side panel on a phone no longer stretches to fill the whole screen when it has almost nothing to show — Pulse and the Files list now size to their own content instead of leaving most of the screen empty. (DOR-1753)
- Coloured borders show up again. One line of styling had been quietly turning every coloured
  border grey, on 69 screens. Panels that were meant to look different at a glance — a
  connection that is fine, one that needs a look, one that broke — all wore the same grey
  outline. They do not any more (DOR-1750)
- Small text on a phone now grows with everything else. Timestamps, badges, keyboard hints and
  little labels were pinned to a fixed size, so they stayed tiny while the rest of the app got
  bigger. Roughly 300 of them now follow the same scale (DOR-1750)
- Icons in buttons grow on a phone too, so a small icon no longer sits in a big tap target. Two
  dialogs had icons stuck at the wrong size entirely; both are fixed (DOR-1750)
- Status colours mean one thing everywhere. Green, amber and red were spelled seven different
  ways across the app, so the same state could look green in one place and a slightly different
  green in another. There is one set now, and it is tuned for dark mode as well as light
  (DOR-1750)
- The built-in terminal uses the font you picked in Settings. It used to ignore your choice and
  draw in its own (DOR-1750)
- Running background tasks are colour-coded from the app's own palette, so their colours suit
  dark mode instead of staying the same in both themes (DOR-1750)
- An agent that never picked a colour gets its own again in Settings → Runtimes, instead of a
  flat grey (DOR-1750)
- An agent changing one of its own settings no longer quietly turns the ones beside it back on. Switching off its SOUL.md used to switch its saved notes back on, and nudging one personality dial reset the other five (DOR-1719)
- When one agent messages another directly, the agent that answers now runs on the AI tool it is set up to use. A Codex agent used to reply through Claude Code — under its own name — because a direct agent-to-agent message never said which tool to use. Messages arriving from Telegram and Slack already worked this way (DOR-1627)
- If an agent is set to use an AI tool this copy of DorkOS did not start, another one answers for it, as before — but the server log now says so, naming the agent, the tool it asked for, and the one that replied instead. It used to happen silently (DOR-1627)
- Renaming a room, changing its topic, or putting it away is now yours alone. An agent in the room could do any of those over the API before — including archiving a channel, which takes it off everyone's sidebar. Agents can still rename a channel they belong to and write its topic through the `update_room` tool, which has never been able to archive anything, and an agent asking for its own direct message again still brings that conversation back (DOR-608)
- Fixed a bug where a Claude Code session started in a brand-new project — often one begun while DorkOS was still starting up — could be missing from your session list until you restarted the app. The list now re-checks your projects on disk every few seconds, so a session the file watcher failed to notice still turns up on its own (DOR-577)
- The to-do list an agent writes above the message box now opens while the agent is working and folds back to its one-line progress count when the turn is done, and a long list scrolls inside its own box instead of pushing the conversation off a phone screen (DOR-1759)
- The space just above the message box now shows one thing at a time. Suggested replies and the question about turning on notifications used to stack up together; whichever matters more speaks, and the other waits its turn (DOR-1759)
- The Pulse panel no longer repeats what the page beside it already shows: its activity peek is gone on the Activity page, and its "Needs attention" list is gone on Home (DOR-1759)
- Sections you can fold open and shut — "Advanced settings", "Schedule", an install's permission groups — now look and behave the same everywhere, and each one says how much it is hiding (DOR-1759)
- The strongest permission setting used to say it "still asks when it matters", which sounded just like the safer setting next to it. It now says plainly that it will not stop to ask you, even for risky steps.
- Errors tell you what to do next. "Failed to X" is now "Couldn't X", and the sentence written for you is the headline, with whatever the server said underneath it. You should no longer meet a bare "ENOENT: no such file or directory" with nothing else to read (DOR-1755)
- The setup screen no longer shows internal field names when it cannot save your progress. It says so in a sentence and keeps going (DOR-1755)
- A feature that is off now tells you where to type the command that turns it on, and offers to copy it (DOR-1755)
- On a phone, the empty Channels screen points at the All tab at the bottom instead of a sidebar that phones do not have (DOR-1755)
- A few error messages claimed something the app couldn't actually promise, like "Nothing was deleted" after a reset that failed partway through, or "Nothing you did was lost" on the screen for a crash so bad the app can't tell what happened. They now say what's actually true: it isn't sure (DOR-1755)
- Remote access said "Failed to start tunnel" and "Failed to stop tunnel" when it couldn't tell you why. Those now match the rest of the app's voice (DOR-1755)
- Fixed links inside a package's README on the DorkOS marketplace website. They looked like links but were not: hovering showed no address, ⌘-click or middle-click did not open a new tab, "Copy link address" had nothing to copy, and search engines could not follow them. They are ordinary links now (DOR-1296)
- Opening a document in the canvas editor no longer repaints every border in the app.
  The editor brings its own stylesheet, and that stylesheet was resetting the app's
  border colour to the text colour — so cards, buttons, inputs and filter pills all
  picked up a hard near-black outline (a washed-out light one in dark mode) and kept
  it until the next reload. Measured across thirteen screens in both themes (DOR-1024)
- Coloured borders now work inside the Obsidian panel too, the same way they do in the
  app (DOR-1024)
- Installing an agent from the Marketplace into one project used to leave it stranded.
  The files landed correctly, but the installed list looked right past them and the
  uninstall button said the package was not installed — so the only way to remove one
  was to delete the folder by hand. Project installs are now looked for in the same
  places they are written to, whatever kind of package they are (DOR-994)
- A package installed globally and again inside a project now shows as two separate
  installations you can manage one at a time, and removing the project copy leaves the
  global one alone (DOR-994)
- Updating a marketplace package no longer destroys another install of that same package that arrives while the update is running. An update takes the old copy away and puts the new one down, and for a moment in between the folder was unguarded: anything installed in that moment was deleted without a word, even though whoever installed it had already been told it worked. The update now holds the folder from start to finish (DOR-1722)
- A conversation whose agent runs on Claude, Codex or OpenCode now says so by name when
  that program is no longer running on your machine — and tells you the two ways back:
  turn it on again to pick up where you left off, or take the agent out of the
  conversation and add it back to start fresh. Before, every message got the same
  "ran into a problem" apology and pointed you at a session that was always empty, so
  the only way to fix it was to already know how (DOR-1720)
- That line is written once while the situation lasts, instead of once for every message
  you send (DOR-1720)
- A session you open from the sessions list says the same thing in the same words when
  the program it runs on isn't running (DOR-1720)
- The "Add a connection" dialog used "Connection" for both the thing you're picking and the thing you're creating. Picking a source now says "Source".
- Removing a connection now tells you plainly that nothing routes through it anymore, instead of reusing the same wording as removing a single routing rule.
- A message from a real person in a private Telegram or Slack chat now notifies you, the same way a message from one of your agents does. It used to be the one kind of message DorkOS stayed silent about — and the mute switch, the five-minute grouping and the read-when-you-open-it rule all apply to it just as they do to an agent's
- A channel you are not a member of no longer claims you left it. The app only knows whether you are in a room right now, not whether you ever were — so a channel one of your agents opened without you was labelled "You left this channel", which was never true. The sidebar row now says "Read only", the channel itself says "You're not in this channel. You can read it, but not add to it.", and the way back in is called "Join" (DOR-1620)
- Long chats with Codex and OpenCode agents got slower and more expensive than they needed to be. Every turn re-sent the agent's whole introduction — who it is, its SOUL.md and NOPE.md, what DorkOS is, where it is running — and each copy stayed in the conversation, so a twenty-message chat was carrying twenty copies of the same few pages. OpenCode now sends it on a channel its own engine keeps out of the conversation, and Codex sends it once per chat and again only when you actually edit the agent. Measured on a real agent, that removes about 60% of the text a twenty-turn Codex chat was carrying and about 90% for OpenCode — counted as characters of text sent, which is what we can measure directly rather than what a model provider ends up charging for. Nothing an agent needs to know went away: its saved notes and the tools it currently has are still refreshed on every turn (DOR-477)
- The little coloured tags in the Marketplace that say what kind of package you're
  looking at — agent, plugin, skill pack — now pick colours made for dark mode
  instead of reusing the light-mode ones (DOR-1760)
- Small icon buttons — copy, close, fullscreen, Browse — are big enough to tap on a
  phone and show a focus outline when you reach them with the keyboard. Several were
  about half the size a thumb needs (DOR-1760)
- The settings sidebar reads correctly to a screen reader again. It described itself
  as two overlapping widgets at once, and the arrow keys now work from wherever your
  focus already is (DOR-1760)
- A greyed-out folder field greys out its Browse button too, instead of offering to
  change something you can't (DOR-1760)
- A long dialog heading no longer runs underneath the expand button in the corner
  (DOR-1760)
- A busy Inbox shows up right away. It used to trickle in one row at a time, which looked
  like it was loading slowly (DOR-1764)
- The recent-chats panel above the message box, and a project card you just added during
  setup, fade away instead of vanishing mid-blink (DOR-1764)
- Menus now open outward from the button you clicked, and one near the edge of the screen
  slides in from the right direction (DOR-1764)
- If you have asked your system for less on-screen movement, a busy conversation's glowing
  border now stays still (DOR-1764)
- When a plugin's `hooks/hooks.json` is damaged, DorkOS keeps the parts it can still read and skips the rest. It used to skip them silently, so a hook could stop running with nothing anywhere to say so. `dorkos harness sync` now names the file and each affected event, and says whether the rest of that event still runs (DOR-1724)
- A project-room conversation you carry on somewhere other than the room now continues in the same working copy the agent has been using in that room, so the work it has not saved into the room's files yet is right there. Before, it started up in the agent's own folder instead, and that work was invisible. If you name a folder yourself, yours still wins (DOR-1624)
- Right-clicking in the desktop app did nothing at all — no copy or paste on a text box, no "Copy Link Address" on a link, no spelling suggestions. It now opens the menu you would expect, and the app's own right-click menus (like the one on a room in the sidebar) still take priority where they have one (DOR-1297)
- The health check now spots a room that can no longer find its conversation after its agent's folder moved. It used to look for the saved conversation anywhere on disk and call the room healthy, while the agent itself looked only where it lives now and started over from nothing every time (DOR-805)
- Screen readers no longer read out loading spinners as unlabelled pictures (DOR-1763)
- The subagent lines in a session's status panel now match the size of every row around them, instead of standing out as the one larger line (DOR-1763)
- A server's detail rows in agent settings show the label dimmer than the value again, so the two read at a glance (DOR-1763)
- Buttons no longer submit a form by accident when all they were asked to do is run a click (DOR-1761)
- Checkboxes and radio dots now grow on a phone, like the text boxes beside them already did (DOR-1761)
- A switch given a size now still grows on a phone; asking for both used to quietly do nothing (DOR-1761)
- The live activity chip that shows what your agent is doing now keeps its gentle pulse when "reduce motion" is turned on, instead of going still (DOR-1761)
- In the desktop app, Settings → Danger zone → **Restart Server** and **Reset All Data** work again. Both used to ask the server to end itself and start over, which the app can't do — so the app refused, and the two buttons could only fail. Now the app restarts its own server: it stops it, deletes your data if you asked for that, starts it again, and puts your window back on it. If another copy of DorkOS is using the same folder, nothing is deleted and you are told which one to quit (DOR-542)
- Refusals from these two buttons read like sentences again. A message from the server used to arrive as the whole raw response — braces, error code and all — with the explanation buried inside it (DOR-542)
- Changing an agent's personality saves once, when you let go of the slider. Dragging one dial used to send a save on every step it crossed, and the handle lagged behind your finger while it caught up (DOR-1646)
- Search on the docs site now puts the page that explains a topic first. Searching "relay" used to return a long reference page that merely mentions relay, with the Relay page itself down at eleventh (DOR-701)
- Docs search now understands word endings and small typos: "scheduling" finds what "schedule" finds, and "releay" still finds Relay (DOR-701)
- Asking docs search a full question no longer costs a giant download. A five-word question used to return around 300 KB — worse than reading the whole documentation index — and now costs about the same as a one-word search (DOR-701)
- The diagnostic view of a room's agents no longer contradicts the health check about the same agent. It used to look for a saved conversation anywhere on disk and report "found it", while the health check warned that the agent could not actually reach it — so anyone chasing a room that had forgotten everything was told to look somewhere else. Both now read the same answer, the "anywhere on disk" one is still shown beside it under a name that says what it is, and when the two differ the response says why (DOR-1780)
- The diagnostic view of a single session now says whether the runtime it names is the one that session actually runs on, or just the one it would get. A room's first session had no recorded runtime, so the view printed a guess as if it were a fact (DOR-1780)
- One room member DorkOS cannot look up no longer costs you the whole report. A busy or damaged database used to take down the diagnostic view and cut short the startup check that repairs rooms — the two places you go when something is already wrong. Now it costs that one member's answer, which is marked as unreadable rather than passed off as healthy (DOR-1780)
- A message that ran out of time before an agent saw it is now turned away everywhere, and whoever sent it is told in plain words — "The message expired before the agent could start" — instead of "TTL budget expired". One path already refused these; another quietly handed the message a fresh full clock and answered as if it had just arrived, so an hour-old message could still start a turn nobody was waiting for (DOR-1770)
- Starting DorkOS with `--tunnel` now prints the address your phone can reach it on, and a QR code for getting there without typing it. Turning Remote Access on later from the app prints it too. Both were silent before: the terminal was watching a copy of the tunnel that never actually ran, and the QR code was failing in a way nothing reported (DOR-1745)
- Installing an adapter for one project now tells you when it lands machine-wide instead of silently ignoring the project choice (DOR-1776)
- The install conflict check now looks at every kind of installed package — agents and Shapes as well as plugins — when warning you about a clashing skill name or a screen slot two packages both want (DOR-1776)
- Reinstalling a package no longer warns that it clashes with itself, and two different packages that happen to share a name are no longer mistaken for one, which used to hide a real clash between them (DOR-1776)
- Editing an agent's setup while another agent is talking to it no longer switches which AI tool answers — the conversation stays with the tool that has its history. DorkOS used to re-read the agent's setup on every message, so a change made mid-chat handed the rest of the conversation to a tool that had never seen any of it and answered from nothing. Your change still applies everywhere else you use that agent — in rooms, in chat, and in new sessions you start; the one running agent-to-agent thread keeps the tool that has been answering it (DOR-1774)
- An agent-to-agent message that could not run at all — the AI tool not signed in, for example — no longer locks that conversation to the tool it happened to try. Fix the setup and send again, and the next message goes where you said (DOR-1774)
- You can now pick up and reorder sidebar items with just the keyboard. Tab into a section, arrow down to the row you want, press Space to lift it, arrow to where it should go, and press Space again to drop it. Escape puts it back. Before this, the sidebar told screen readers a row could be dragged with the keyboard, but there was no key that could actually start the drag (DOR-1746).
- Enter still opens whatever a sidebar row points at — Space is the key that picks it up.
- The same works on a section you made yourself: Space picks the whole section up so you can move it, and Enter folds it. Sections that come with DorkOS — Channels, Direct messages, Agents — can't be moved, so Space still folds those.
- Lifting something and putting it straight back where it was no longer saves anything. It used to write your whole sidebar layout back to disk for a move that never happened.
- Editing a schedule that came from an installed agent or Shape no longer writes into that package's own files, where the change would have been shared with everyone who installed it and wiped out by the next update. DorkOS now says the schedule belongs to a package, the same as it already did for plugins — and schedules belonging to agents you made yourself stay yours to edit (DOR-1789)
- Adding a new schedule to an agent that came from the marketplace is now refused up front, instead of being accepted and then wiped out by that package's next update. DorkOS suggests making your own copy of the agent and putting the schedule there (DOR-1789)
- DorkOS now re-reads a message mailbox the moment it starts watching it, instead of only reacting to what arrives afterwards. Anything already waiting — mail that landed while DorkOS was not running, or in the instant the watcher was still starting up — is picked up straight away rather than sitting there until something else happens to arrive (DOR-1787)
- A scheduled run that hits its time limit now says so the same way everywhere, in plain words. Depending on how the run was started, its record used to read either "Run stopped after passing its 5m time limit" or "Run timed out (TTL budget expired)" — the same thing, said twice, once in jargon (DOR-1786)
- Switching which account an agent runs on now saves on machines with more than one account. The Account setting in an agent's "Runs on" panel was sending its change down a path that only agents use, and that path refuses account changes on purpose — only you get to decide whose subscription pays. So the setting quietly failed every time, on the only machines that show it. It now goes the way the rest of your settings go, the picker keeps whatever you chose, and every screen that names the account — the panel itself and the account label at the bottom of the window — updates straight away, even if you close the panel the moment you click (DOR-1736)
- A thread's "3 replies" line no longer says a smaller number than the replies
  it is sitting above. It could fall behind when a reply arrived while you were
  reading a long thread (DOR-1734)
- DorkOS now reaches a remote tool server and reads its tool list before it shows connected. Failed checks add no account and explain what to fix. Closing before a check starts keeps it closed. Simultaneous connections stay with the right provider. Repeated disconnects cannot bring back a removed server. (DOR-738)
- Adding a marketplace now checks the address before it saves it. A marketplace is either an `https://` link to a git repository or a `file://` folder on your own machine; anything else — including SSH-style `git@host:org/repo` addresses, which look right but can never load a listing — is turned down on the spot, with a note saying what to use instead. Previously any text at all was accepted and quietly failed later. Sources you already have are left exactly as they are (DOR-1710)
- DorkOS used to spell an ellipsis two ways ("Saving…" beside "Saving...") and an apostrophe two ways, sometimes on the same screen. The app now spells both one way, and a check keeps new copy from drifting back (DOR-1756)
- When something goes wrong, DorkOS now says the same thing every time. The crash screen, the page-error screen and the "page not found" screen used to invent their own words for the same two buttons. They now all say "Try again", "Reload DorkOS" and "Back to home" (DOR-1756)
- A page that fails to load now tells you what happened in a sentence written for you, with the technical error tucked underneath, instead of showing you the raw error and nothing else (DOR-1756)
- Errors that used to start "Could not…" now start "Couldn't…", and say what to try next (DOR-1756)
- When an agent asks you for something, the card now says "`{name}` needs something from you" and its button says "Done". Screen readers hear the same plain countdown the card shows: "Two minutes left to answer." (DOR-1756)
- Smaller labels that read like code now read like English: "Repository link" instead of "Git URL", "What this can do" instead of "Permissions & Effects", "Not protected" instead of "No auth", and "Reloaded 3 extensions" instead of "Reloaded 3 extension(s)" (DOR-1756)
- The banner about agents running unattended now says "connection", matching the rest of the app, and its Connections button actually opens Connections. It had quietly stopped working (DOR-1756)
- On a phone, the "New Schedule" button ran off the side of the Schedules header and painted over the icons next to it, leaving the page tabs clipped at both ends. It is a `+` there now — the same shortening the Team page already uses — and screen readers still hear its full name (DOR-1747)
- Installing a package straight from an address now checks the address the same way marketplace sources are checked. An install address is a git repository over `https://`, `ssh://` or `git@host:path`, or a `file://` folder on your own machine; anything else is turned down before DorkOS runs anything, with a note saying what to use instead (DOR-1799)
- A huge error no longer floods your terminal. When something fails with a message megabytes long — a crashed program dumping everything it had — DorkOS now prints the start of it, the lines that say where it happened, and a note saying how big the whole thing was. Log files were already shortened this way; the terminal was not (DOR-1728)
- DorkOS accounts now keep the sign-in source they came from, so email, GitHub, and Google sign-ins continue to recognize the right account after an upgrade.
- Skills from other tools that keep extra settings under `metadata` (for example ClawHub skills) used to be dropped silently. They now load like any other skill.
- The built-in "writing for humans" skill had a typo in its header that made DorkOS skip it. It is back.
- Huge errors are now shortened in more places. DorkOS already shortened an error it was reporting on its own, but not one tucked into a wider line of detail — and those lines used to carry the whole thing, filling a log file with a single 1.2 MB line. Crash reports and the other failures DorkOS reports now get the same short version, with the same note saying how big the original was (DOR-1827)
- Activity now names the agent that changed an extension's settings or secrets, registered or removed an agent, added a chat connection, changed a chat route, or created, paused, deleted or cancelled a scheduled task. Those entries always said "You" before, so work one of your agents did looked like something you did yourself. What you do in the app still says "You", and a caller DorkOS cannot identify is shown as an unidentified caller rather than as you (DOR-1801, DOR-1829)
- DorkOS sometimes said "DorkOS couldn't finish starting" on a machine that was
  simply busy. One small hiccup while the app was still loading — a picture that
  didn't arrive, a request that gave up — was enough to make it announce a
  failure, even though the app came up seconds later. It now waits until loading
  has actually stopped before saying anything went wrong, so a slow start looks
  like a slow start.
- Loading a profile photo at the moment it was replaced or removed could take the whole server down, rather than just failing that one request. Photos are now read from disk once instead of twice, which removes the crash and also fixes a subtler problem: the version tag your browser caches could name different bytes than the ones it was actually sent.
- Opening a file or a picture from a room or a transcript at the exact moment it was deleted could take the whole app down, instead of just failing that one request. Now only that one request fails, and everything else you have open keeps running.
- When Claude's safety filter declines a message, the chat now says that plainly and tells you what to do: rephrase it, or pick a different model. Before, it only said "The request was rejected as invalid" and hid the reason under Details.
- Reloading the app used to print one red "query error" line per background check in the browser console. Those were the browser cancelling requests, not real failures, and they are no longer logged.
- OpenCode sessions no longer disappear from the session list when a project is opened through a different spelling of the same folder — through a symlink, with a trailing slash, or by way of a parent folder. They come back in the session list, in the sidebar's Recent list, and in the Activity counts. The surfaces reading the client-side selector still miss them when the folder is reached through a symlink: that matching happens in the browser, where it cannot check what a folder really is on disk. That half is coming separately. (DOR-695)
- Activity now records removing an extension's secret and putting one of its settings back to the default. Setting them was already recorded; taking them away was not (DOR-1829)
- The agent card an outside tool reads before talking to your agents now says that a key is needed. It only said so when you had turned login on or set a server key, so on a normal setup the card promised the call would go through and the call came back refused. Calls have always needed a key; now the card admits it. Reading the card still needs nothing while login is off, and the card never says where your key is kept (DOR-1824)
- DorkOS now refuses to read or install from folders outside your allowed workspace, however the address is spelled. A package install aimed at a `file://` address used to skip that check — it could list the contents of a folder you never opened up, and copy that folder in (DOR-1825)
- Creating an agent from a template now checks the address up front and says plainly when it isn't one DorkOS can download from, instead of failing partway through with a server error (DOR-1825)
- Your GitHub key is only ever sent to GitHub. Installing a marketplace package, or creating an agent from a template, used to attach your key to whatever address it was pointed at — so an address on someone else's site was handed a working key to your GitHub account. Private repositories on GitHub still work exactly as before (DOR-1833)
- Reopening a menu or a dropdown list straight after closing it no longer eats your next click. The press did nothing and you had to press again — the list that had just closed was still on screen finishing its fade, and it was closing the one your press had opened. The same press now works the first time, anywhere in the app a menu is reopened straight after it closed (DOR-1834, DOR-1835)
- Clicking the little arrow at the right of a collapsible settings section now opens and closes it, the way clicking its title always did. The arrow had quietly stopped being part of the button.
- Opening the session page without a link no longer flashes errors on its way in. DorkOS picks the conversation you were last having and sends you there, but it was not saying which project that conversation belongs to — so the page asked for a transcript it could not place, got two errors back, and settled on an empty screen before recovering. It now names the project, and the conversation opens straight away (DOR-1836)
- Stopping an agent's very first reply in a room now always stops it. The very first time an agent answers in a room, DorkOS works out which program is running that answer by reading the agent's settings — and if those settings changed while the answer was being written, Stop went to the wrong program and quietly did nothing: the reply carried on to the end, and you paid for it. DorkOS now remembers which program picked the answer up, so Stop goes there (DOR-1721)
- Reconnecting to a chat no longer skips replies. When two turns started on the same chat at once, the server could swap out the counter it uses to number that chat's events — and a window reconnecting afterwards asked to carry on from a position that no longer meant what it used to, so some replies simply never arrived and nothing looked wrong. Those windows now reload the conversation instead.
- Links from packages, connectors and agents clear the same safety check as every other link. A package's homepage, a sign-in link from a connector or an MCP server, an add-on's setup button and a "Learn more" link all used to be handed straight to your browser. Now they go through the same check DorkOS runs on every other link, and one it won't open says so instead of doing nothing (DOR-924)

### Security

- Resetting DorkOS — the button that deletes everything it has stored — now takes a deliberate two-step confirmation, so nothing else on your machine can trigger it with one hidden request. Before this, any program that could reach the DorkOS API could delete your whole `~/.dork` folder with a single message, because the only thing the reset asked for was a word that is written in DorkOS's own source code. Now DorkOS hands out a one-time code the moment you press the button, and the reset only happens if that exact code comes back within two minutes. Nothing changes about how you reset: type "reset", press the button, done (DOR-1707)
- Turning an extension on or off is now yours alone. DorkOS already refused an agent that request when it came through settings, but the Extensions screen had its own way in that asked nobody — so an agent, or a web page you happened to be visiting, could switch your extensions on and off behind your back. Both are refused now, in both directions, and DorkOS says what it did not do and who can do it. Nothing an extension does actually ran without your say-so either way: an extension still needs your one-time approval before its code runs anywhere (DOR-1507)
- An agent can no longer create a second extension under a name you already use. DorkOS keeps extensions in two places — one for you, one inside a project — and it used to check only the place it was writing to. So an agent could put its own `notes` in your project while your own `notes` sat in the other place, and that copy could quietly take over the name later, after you had switched the original off. Now a name you are already using is refused in both places, and the message says where the existing one lives (DOR-1507)
- Rate limits now count by connection instead of by a header anyone can write. DorkOS was reading the client's address from `X-Forwarded-For`, which is fine behind a proxy and free to fake without one — so someone guessing your password could put a new value in that header on every try and never run out of attempts. All six limits count honestly now: sign-in, the MCP endpoint, the agent-to-agent endpoints, extension data proxies, the connection test for agent messaging, and the admin restart and reset buttons — that last one guards the button that erases everything DorkOS has stored, so it is the one you would least want a stranger to be able to keep retrying. If a proxy you control really is the only way in and you want it counted per person behind it, set `DORKOS_TRUST_PROXY=true` (DOR-1711)
- The MCP endpoints now check where a browser request came from the same way the rest of DorkOS does. They had their own shorter list, which quietly refused addresses everything else accepted — the IPv6 spelling of localhost, a container published on a different port, and any address you listed in `DORKOS_CORS_ORIGIN`. Those work now, and the protection against a malicious page pointing your own address at itself is unchanged (DOR-1711, DOR-553)
- The addresses you list in `DORKOS_CORS_ORIGIN` are now added to the ones DorkOS already trusts, rather than standing in for them. Before, listing your public address could stop the app's own live connection from opening and stop you signing in, because those two checks read the list as the complete answer while the rest of the app did not (DOR-1711)
- Check the active turn, agent, session override, connection, action version, and approval again before every provider attempt.
- Stop the next discovery or action after access is revoked, a turn ends, or provider configuration changes.

## [0.73.0] - 2026-09-03

### Added

- You can now cap what an agent is ever allowed to do. Pick its limit in the agent's Tools settings, or run `dorkos agent update --path <dir> --ceiling <observe|act|destructive>`: `observe` reads only, `act` changes things but never deletes them, and `destructive` is no extra limit. Anything past the line is refused, and no approval unlocks it — so this is how you get an agent that reads your repos and can never uninstall anything. Every agent starts with no extra limit, so nothing you already run changes until you set one. An agent can tighten its own limit; only you can loosen it. This covers what an agent asks DorkOS to do — one that can run terminal commands can still act outside DorkOS, and turning on Require login (Settings, under Security) closes that door too (DOR-486)
- Find out when an agent's sign-in stops working, even when the work was running on its own. Before, a scheduled task, a room reply, or a message from a connected chat would just fail quietly. Now DorkOS notices and tells you which sign-in it was — Claude, Codex or OpenCode — and, if you run more than one Claude account, which account. You get one note about a sign-in, not one for every job that failed because of it, and opening it takes you straight to the place to sign in again (DOR-1654, DOR-1682)
- Agents you reach through a connected chat, like Telegram or Slack, tell you the same way. Before, those agents were the one case that stayed quiet and left you guessing why they had stopped answering (DOR-1654)
- DorkOS now tells you when your Claude sign-in is about to run out, three days before it does, on the Claude card in Settings. It keeps saying so through the last few hours, when signing in again is most urgent. Doing it when you choose takes a moment; being caught out used to cost you a failed turn (DOR-1653)
- If you work through an API key instead, DorkOS stays quiet. It only mentions a sign-in that is actually doing your work, so a stored login you no longer use never nags you (DOR-1653)
- A sign-in that stops working can now reach your phone. If a scheduled task or an agent reply fails because Claude, Codex or OpenCode needs you to sign in again, DorkOS puts a note in your inbox right away, and if nobody has dealt with it after a couple of minutes it pushes to any device you have subscribed and to your connected chat apps. Tapping it opens the page where you sign in. Change that wait, or turn it off, under Settings › Notifications (DOR-1657)
- When a runtime's sign-in stops working, the app now shows a banner across the top naming the runtime, with a button that takes you straight to signing in again. Before this, a browser tab told you nothing — a dead sign-in reached you only through the bell, a phone notification, or the desktop app, while your scheduled tasks and agent replies quietly failed. The banner clears itself on the next task, message or reply that gets through on that runtime, since trying is the only way DorkOS can tell that a sign-in works again (DOR-1680)
- See the pictures your agents make. When an agent generates an image, or a tool hands one back — a screenshot, an image from an MCP server — it now appears in the conversation where it happened, and it is still there when you come back to it days later (DOR-1663)
- Images from tools now work on all three runtimes. Ask Claude Code to read a PNG and the picture appears right under the step that read it, and Codex shows images that come back from a connected app. Before, this produced nothing at all on the runtime most people use: no picture, no error, no hint that anything had happened. If the only thing an agent produced was an image, the whole turn used to vanish (DOR-1663, DOR-1664)
- When a picture cannot be kept — it is too big, or a kind DorkOS does not store — the conversation says so instead of showing you nothing, and that notice is still there after you reload (DOR-1663, DOR-1671)
- Two gaps worth knowing: images an OpenCode model draws itself are dropped by OpenCode before DorkOS ever sees them ([anomalyco/opencode#46600](https://github.com/anomalyco/opencode/issues/46600)), and Codex has no way to send an image its own model drew. DorkOS is ready for both the day they are fixed (DOR-1663, DOR-1664)
- New agents now show a face. Each one gets its own color and emoji the moment you make it, so your team reads as a row of characters instead of a row of letters (DOR-949)
- An agent you install from the marketplace now arrives wearing the face its author gave it (DOR-949)
- When DorkBot picks the name DorkOS calls you — usually because you told it "call me Dorian" in a chat — your team page, your account menu and Settings › Profile now say "Suggested by DorkBot" under that name. Save a name yourself in Settings › Profile and the note goes away for good, even if you save the same name it picked. Names already on your machine keep working exactly as they do today and get no note, because DorkOS only started recording who picks a name in this release (DOR-1022)
- Ready-made agents from the Marketplace now tell you up front if they come with work on a timer. Before you create one, DorkOS names the job, when it runs, and how much it can do on its own — the same plain-language wording every other kind of package already shows. Ready-made agents were the one kind that skipped the install screen, so this was the one place that fact went unsaid (DOR-644)

### Changed

- When an agent's sign-in stops working mid-chat, you can now sign back in right there in the conversation. The card shows the sign-in running and tells you when it lands, so you no longer have to open Settings, find the right agent, and press Reconnect. If you would rather use an API key, that link is still there, one quiet tap away. On a computer with more than one Claude account, it signs you back into the account that chat is actually using, so you never fix the wrong one (DOR-1651)
- Sign in once from the card and your message goes again on its own. No retyping, and no Retry button to hunt for (DOR-1650)
- It stays out of the way when you have moved on. Started typing something else while signing in, or already have a message running or waiting in line? Then nothing is sent behind your back — the card just says you are signed in and leaves the Retry button there. Whatever you typed is left exactly where you typed it, and if you tried again while signing in, it is the newer message that goes (DOR-1650)
- When you open DorkOS on your phone and an agent's sign-in has stopped working, the card now tells you plainly that signing in needs the computer DorkOS runs on. Before, it showed a Sign in button that always failed. Settings says the same thing on the same screen where you would otherwise press Connect, so the app no longer tells you two different stories two clicks apart. The card keeps its Retry button, so once you have signed in over there you can send your message again from your phone with one tap (DOR-1655)
- DorkOS now stops telling you about a broken sign-in once it is working again. It watches for the next piece of work that gets through on that sign-in, then files a second note saying it came back. If the same sign-in breaks again later, you hear about it again straight away. Notes are written in the past tense now ("Your Claude sign-in stopped working"), because a note you read the next morning should still say something true (DOR-1657)
- Pressing Stop now tells you what actually happened. Before, every ending looked the same: the agent hearing you and winding down, DorkOS killing the process because it never answered, the reply having already finished, and the agent refusing to stop all came back as the same yes or no. Now each one is its own answer, and the app only says an agent "stopped" when it really saw it stop. If the agent did not confirm, you get "Stop requested" and the Stop button stays there so you can press it again — instead of being told it worked while the agent keeps going (DOR-1015)
- Stopping a background task answers with what happened rather than a plain yes or no, and no longer reports "already stopped" for a task it could not confirm, because that task is probably still running (DOR-1015)
- "Always Allow" on a permission card now says how far the permission reaches — this session, this project, or all your Claude sessions — right on the button. Some of these grants get written to a settings file, so they outlive the chat you gave them in; now you can see that before you tap, not after (DOR-1462)
- The Workspaces page now shows the copies of your code that actually exist. It reads your workspaces folder directly, so the worktrees your agents really work in finally show up, grouped by project, with the branch, how many files hold unsaved edits, how far ahead of or behind the remote each one is, and when it last got a commit. Before this, the page could only list copies DorkOS had made itself, and it had never made one, so it sat empty while dozens of real worktrees sat in the very same folder. Worktrees you reach through a shortcut (symlink) are included, and a broken shortcut is called out rather than skipped (DOR-1056)
- The page only reads. It never creates, changes, or deletes a copy, so a stray click can't take a folder out from under a running agent (DOR-1056)
- It also refuses to guess. A copy whose branch was merged and deleted says so, rather than claiming it's in sync with a branch that no longer exists. A folder DorkOS can't read gets a row marked "Can't read" instead of quietly disappearing, and if a whole folder or the scan itself fails, you're told the list is incomplete instead of being shown an empty page that means "you have none" (DOR-1056)
- Picking a color or an emoji for an agent yourself still wins. DorkOS only fills in the half you left blank, and it never changes a face you already set. Clearing a color or emoji puts back the face the agent started with, instead of a different one (DOR-949)
- Approval prompts, sign-in receipts, and the notices a room posts on its own now read as plain sentences, without a stray dash in the middle (DOR-1261, DOR-611)
- Install screens no longer say a package's scheduled job "starts switched on" — in the app or in the terminal. Nothing a package brings ever starts on its own: DorkOS parks every new schedule until you approve it, so all three screens now say that instead of promising the opposite (DOR-644)
- Asking the dead-letter list for an empty endpoint name is now an error rather than a way to get the whole list. Leave the filter off entirely to see everything

### Removed

- The "Scheduled run notifications" setting is gone. It promised a toast when a scheduled task finished, and nothing ever showed one (DOR-1522)

### Fixed

- Reopen a chat that stopped because your sign-in ran out, and you now get the same "Sign in again" card you saw at the time, with the button that fixes it. Before, reloading turned that failure into a line that looked like your agent had said it. Other stop notices from Claude, such as hitting a usage limit, come back the same way: as a notice you can read, not as words your agent said (DOR-1649)
- Search stops filing those notices as things your agent said. This applies to conversations indexed from now on; notices already in your search index stay there until you delete it, which rebuilds from scratch (DOR-1649)
- When a Codex or OpenCode sign-in dies in the middle of a turn, you now get the "Fix sign-in" button instead of a generic crash message with no way forward. Codex trouble is caught on the path it actually takes — before, a live Codex run that lost its sign-in showed the raw text the tool printed and offered nothing to click — and whatever the agent's own tool said is kept under "Details" instead of being dropped (DOR-1656)
- A Claude sign-in that had already run out no longer shows as "Ready". DorkOS was only checking that a sign-in was stored, not that it still worked, so a run-out sign-in looked fine until a turn failed. It now offers you the sign-in button instead (DOR-1653)
- On a machine with more than one Claude account, "Fix sign-in" now signs back into the account DorkOS runs new sessions on, instead of whichever one the server happened to be pointed at (DOR-1652)
- When an OpenCode turn failed, reopening the chat used to show your question and nothing after it. The failure is now there where it happened, in plain words with the fix to try, and the provider's own wording tucked behind Details — the same thing you were told while the turn was running, instead of raw error text on reload (DOR-1666, DOR-1678)
- A chat turn that fails now says so. Some failures used to look like a clean finish: the session went quiet, the text explaining what went wrong disappeared, and you got a "finished" note instead of a warning. This happened whenever Claude Code named its own reason for stopping, like a model error, a problem reaching the service, or a prompt that ran too long. Now the session is marked with the error and keeps the explanation on screen, and if you are away from your machine DorkOS starts trying to reach you about it (DOR-1676)
- Stopping a turn and a turn crashing no longer look the same. When a turn was cut short, DorkOS said you stopped it, whether or not you had touched Stop — so an agent that hit a refusal from the service and gave up on its own was filed as a session you ended on purpose, and the message explaining what went wrong was wiped off the screen. A turn nobody stopped that ended with a real error is now marked as an error and keeps its explanation. A turn you stopped still shows as stopped, with no red mark and no scary text. Scheduled runs get the same fix, where it mattered most (DOR-1681)
- Pressing Stop no longer looks like the agent crashed. When an agent does not answer a stop quickly enough, DorkOS ends it — and that ending was reported as a failure, with a red error on the reply you had just stopped. It now shows as what it was, including when you stop a message the moment you send it (DOR-1302)
- Stopping two replies in a row no longer makes the third message refuse to send with "This chat's agent keeps stopping". That count is meant to catch an agent that cannot stay running, and a stop you pressed yourself no longer counts against it (DOR-1302)
- A scheduled run that hit an error now says so. Run history used to mark those runs finished, with a green tick and no explanation, so a task that died overnight on an expired sign-in looked like it had worked. Now the run is marked failed and shows what went wrong, an expired sign-in leads with what to do about it, and the failure reaches your notifications and your daily report like any other (DOR-1658)
- Scroll back to something that went wrong earlier in a chat and its Retry button is gone. That button always re-sent your newest message, not the one that failed, so pressing it on an old error sent the wrong thing without saying so. The error itself still shows, and you can always type again (DOR-1677)
- An old card about a sign-in that ran out keeps its sign-in button. Your login really is broken, whenever it broke, so fixing it there still works (DOR-1677)
- The model menu now says which models can't do the job, instead of letting you find out after you send a message. Models that can't use tools are grouped under their own heading, and a model that answers with pictures says so (DOR-1660)
- Models that no longer exist are gone from the OpenCode menu. The list is checked against what OpenRouter actually serves, so a model quietly retired upstream is no longer offered. If that check can't be reached — on a plane, or behind a firewall — you get the full menu instead of a wait (DOR-1660)
- Choosing a model your runtime can't run is refused right away with a clear message, rather than saved and failed on your next message. A shortened, unconfirmed list never turns your choice down, though: with no OpenCode provider connected, a model you can really run may sit outside that list, so only a confirmed list refuses anything (DOR-1660, DOR-1688)
- The model menu refreshes when you connect a provider, sign in, or install a local model. It used to keep showing the old list for up to half an hour (DOR-1660)
- When OpenCode can't find any of your credentials, the menu no longer dumps thousands of unchecked models into the picker. It shows a short list and says plainly that nobody has confirmed you can run any of them — and the lists in Settings › Runtimes and on an agent's settings now say the same thing, instead of looking complete when they aren't (DOR-1660, DOR-1674)
- You can read the whole model name in the picker. The panel is wider, so a long name like "Qwen: Qwen3 Coder 480B A35B Instruct" and its note both fit, and when an id is too long the picker trims the front and keeps the end — because two models can share everything but their last few characters (DOR-1673)
- Picking a model on a brand-new session works again. If you started a session, switched it from Claude Code to OpenCode, and then chose a model, DorkOS refused with "The claude-code runtime cannot run model …" — naming a runtime you had not picked. It now checks against the runtime you actually chose, and saves your choice when nobody has decided yet
- `/compact` now works on OpenCode sessions. It had been failing every time with a "bad request", because DorkOS never said which model should write the summary (DOR-1668)
- A conversation that had a permission mode saved under a name one agent tool uses but another does not no longer breaks the next reply. It starts in the careful "ask me first" mode instead, and your saved choice is left exactly as you set it (DOR-885)
- Come back to an OpenCode session after a restart, change just one setting — the model, say — and it now keeps everything else you had chosen. Before, the settings you did not touch quietly reverted: a session you had trusted to work on its own dropped back to asking before every action. The settings panel kept showing your real choices the whole time, so there was nothing to see until you noticed the agent behaving differently (DOR-1152)
- Changing a setting on a chat no longer answers as if DorkOS already knew which agent tool would run it. A chat records its tool when you send it your first message, and until then the answer says outright that it is a guess (DOR-1693)
- A session running a runtime's own default model no longer shows a meaningless "· default" after the runtime name, including in the moment right after startup (DOR-1279)
- OpenCode agents no longer start every reply by reciting the setup notes DorkOS gives them, followed by a copy of your own message. The reply now begins with what the agent actually says, in chat and in rooms — where those notes had included what other people in the room had said. Summaries of scheduled runs show the agent's answer rather than its setup notes (DOR-1659)
- When an agent is created it is asked to introduce itself. That request came from DorkOS, not from you, and search now leaves it out on every runtime — so searching your history no longer turns up DorkOS's own instructions as though they were your words. Turns already indexed stay until the index is rebuilt (DOR-1669)
- Links in error messages are now clickable. When a provider's message points you somewhere — "add credits at …" — that address is a real link you can open, not text to retype. The same goes for tunnel, marketplace, connector and page errors (DOR-1661)
- Errors no longer hide what actually went wrong. A failed turn could show "An error occurred during execution." in place of the real explanation, and a sign-in failure could throw the provider's message away entirely. Now the real explanation is what you see, with the provider's exact words under Details (DOR-1661)
- The server log is quieter. Every time your agent reached for a DorkOS tool, the log gained a bogus "Invalid API key" error — around four per turn, burying the real problems. Genuine key failures still show up (DOR-1661)
- Links in chat now follow the same safety rules as everywhere else in DorkOS, and DorkOS tells you when it refuses one. Before, a link an agent wrote was checked against a looser list than a link on any other screen. When a link can't be opened, the confirmation box explains why and offers to copy the address instead of showing an "Open link" button that would do nothing — and it says which rule stopped it, so a link that works in your browser but not in the desktop app reads that way (DOR-547)
- Message search no longer confuses a literal `<mark>` someone typed into a message with its own highlight markers (DOR-1552)
- Claude Code sessions you started in a subfolder now show up under the project they belong to. If you ran `claude` in something like `my-app/packages/api`, that conversation was missing from `my-app`. Each session still shows the folder it is actually running in, and an agent whose open conversation runs in a subfolder now lights up in the sidebar instead of looking closed (DOR-1550)
- An agent can now see what happens in a preview it opened in the browser app: console messages, network requests and screenshots reach the conversation, so asking about a page's errors no longer comes back empty. It only worked inside Obsidian before. Switching conversations while a preview was busy no longer files its last console messages under the wrong chat (DOR-1305)
- A session's task list no longer loses tasks that were just created when the task history finishes loading late (DOR-1632)
- Answering a request again after the server refused your first answer — because another window already answered it — no longer makes its confirmation card disappear too soon (DOR-1633)
- Answering the last permission request no longer makes the "Allowed" or "Not allowed" confirmation flash and vanish; it stays long enough to read, in the Inbox, on the home screen, and on your phone. A request you have answered no longer offers you the buttons again a moment later (DOR-1411)
- Denying a tool on an OpenCode session no longer offers a reason field that went nowhere. The field appears only when the agent can actually receive it — in the conversation itself as well as in the Inbox (DOR-825)
- The Permissions status item judges a mode by what it actually does, not by whether its name happens to be "default". Switching a session to its safest mode no longer shows a false warning, and the item appears only when the agent really is acting with less oversight (DOR-820)
- A session running at full power says so the same way everywhere. The details panel used to call it "Bypass All" while the mark on the row called it "full power" (DOR-1499)
- When an agent sends a helper off to work in the background and that helper needs your permission, the request has to be turned down for it — and that used to happen in silence, leaving a conversation where the agent quietly stopped making progress. The conversation now says so, names the helper and the tool it lost, and the note is still there when you come back later (DOR-795)
- The "working on it" line shows its timer the moment the number is due, instead of occasionally waiting a whole extra second (DOR-1729)
- Agents no longer go silent in direct messages when you let them decide for themselves when to speak. An agent would work out a good answer, write it somewhere nobody could read, and send nothing — then reply to a plain "thanks" with a pleasantry. Now the answer it works out is the one you get, and a thanks can just sit there (DOR-1643)
- Changing which program an agent runs on no longer moves its running room conversations onto the new one mid-chat, where it kept answering from a blank slate. Stop had the same problem and quietly stopped nothing. A change now applies to the agent's next conversation; to move a room the agent is already in, remove it from that room and add it back (DOR-764)
- A busy thread no longer comes apart. A room loads its most recent 50 messages, so once the message a thread started from was older than that, every answer showed up as its own separate line. The room now brings that first message along, and the "60 replies" line counts every answer in the room, not just the ones on screen (DOR-690)
- You can no longer end up with two direct messages holding exactly the same people — two rows in the sidebar for one conversation, with half the history in each. Asking for a conversation you already have always brings back the one you already have, and a change to who is in a group message that would create a copy says so instead (DOR-1616)
- Renaming an agent, or changing your own name, photo, or handle, now updates right away in any room you already have open (DOR-1114)
- Agents working on a room's files can now use their own DorkOS skills there, including the one about how to work on a room's files. A copy an agent has been working in for months picks up newer skills the next time the app restarts (DOR-1640)
- Turning an agent's tool groups off now sticks. An agent could quietly turn its own back on, undoing the change you made on its Tools page. The same goes for a handful of other settings that are yours to decide: its short name, the namespace that decides which agents it can reach, whether it speaks in a room without being asked, and which account pays for its work. Agents still edit everything that was always theirs (DOR-1506)
- Changing an agent's safety boundaries — its NOPE.md, the list of things you told it never to do — now asks you first. An agent could rewrite that file through its own update tool with nothing shown to anyone, and could switch the whole list off without touching a word of it. Both are now one action that waits for your approval, and the card shows the full new text rather than the first line (DOR-1698)
- Adding an agent by folder no longer writes a brand new agent file over one the folder already had. Point it at a project you keep in git and DorkOS quietly rewrote a file your repository owns — and removing the agent afterwards deleted it. DorkOS now takes on the agent the folder already describes, and never deletes a tracked file: removing that agent leaves the file alone and blocks the folder from scans instead, and says so. Adding the folder again brings the agent back (DOR-1019)
- An agent's own thinking or progress updates can no longer be mistakenly re-delivered to it as a new message — closed for every kind of update this can happen to, not just the ones already seen (DOR-804)
- Two unrelated projects with the same folder name no longer share one internal messaging identity, and a session's origin still shows its project name (DOR-514)
- Deleting or unregistering an agent now actually turns off its identity, instead of leaving its access tokens valid until they expire on their own (DOR-490)
- An agent or person avatar with no real color on record no longer risks an invisible letter; it shows a soft tint instead (DOR-998)
- Profile photos load faster and update reliably when changed (DOR-1008)
- The Team page no longer flashes "Nobody to show yet." for a moment on startup before your team appears (DOR-1419)
- The team table's column headers no longer overlap into garbled text, like "Manaigedy by", when the table is narrowed (DOR-1287)
- Closing a profile returns keyboard focus to whatever you opened it from — a mention, a name, a face — instead of dropping it (DOR-1274)
- On a phone, swiping the room sheet closed no longer accidentally opens a member's loudness scale or asks to remove them (DOR-1275)
- The New Agent dialog opens your agents folder even when DorkOS is limited to a single project folder, for example in Docker with `DORKOS_BOUNDARY` set (DOR-437)
- When an agent changes one of your scheduled tasks — its prompt, its schedule, its name, or which runtime and model it uses — the change now sticks. It used to disappear within five minutes, even though the agent was told it worked, because DorkOS wrote it to its own records and never to the task's file (DOR-1625)
- Because those edits now really land, one thing follows: when an agent changes what an approved task does, the task pauses and waits for you to approve it again, since you never saw this version. Your agent is told and asked to tell you. Changing anything else, including switching a task on or off, leaves your approval alone (DOR-1625)
- Editing a scheduled task no longer lets you pick a different agent. The pick was always thrown away when you saved, and while it showed on screen the permission setting below it described the wrong agent — so you could move the dial a step and never be asked about it, then save a task that runs without stopping to ask. The edit screen now shows the agent it runs as and says the agent is set when a task is created. At creation, picking an agent that would stop the run pausing for permission asks you first (DOR-1694, DOR-1637)
- While your list of agents is still loading, the edit screen no longer claims the task's agent is gone. If the list can't be read at all, it says that instead of blaming the task (DOR-1694)
- Manually running a scheduled task now updates its "last run" and "next run" times right away, instead of leaving them stale (DOR-1492)
- Copy one of a Shape's scheduled tasks to use as a starting point and it is yours to keep. DorkOS now remembers exactly which files it wrote when you applied a Shape, so removing that Shape removes only those, and re-applying it never writes over your copy (DOR-1524)
- When an empty folder sits where one of a Shape's scheduled tasks would go, DorkOS says so on the apply screen and names the folder, instead of quietly skipping the task on every attempt (DOR-1524)
- A Shape-installed schedule can no longer start with every approval prompt turned off instead of the normal, safer defaults (DOR-823)
- Scheduled runs no longer fail with "No receiver for the scheduled run" when the agent-messaging connection they were handed to was switched off or failed to start. DorkOS now checks that something is really listening, and simply runs it itself when nothing is (DOR-1636)
- Closed a hole where an agent running on Codex could switch your Shape on its own. Switching a Shape writes files into your skills folder, changes which Shape is active, adds, moves and removes scheduled tasks, and turns extensions on and off. Agents on Claude Code have had to ask you since 0.57.0; Codex agents were never asked, because a Codex session has no way to put a question in front of you. They now refuse and tell the agent to leave it to you (DOR-639)
- Installing a marketplace package from a folder on your own computer now works when the folder name has a space in it (DOR-412)
- Installed connector packages show the same cyan CONNECTOR badge Browse already shows for them, instead of the generic ADAPTER badge (DOR-710)
- Installing or removing the same package in two places at once is safe. Before, a package could silently go back to an older version — one install failed, undid itself, and put the old files back on top of the other one that had just succeeded (DOR-711)
- One package with a broken hooks file no longer stops every other package from reaching your coding tools. Syncing used to fail outright on it, so nothing got set up. DorkOS now skips only the parts it cannot read and sets up everything else — which also means the install screen and the sync agree about what a package will run (DOR-646)
- When you approve an agent's request to install a marketplace package, that approval now covers the commands and scheduled jobs the card showed you, not just the package name. If the package changes between the moment you say yes and the moment it installs, DorkOS stops, tells you what it declares now, and asks again (DOR-647)
- The dead-letter list can no longer be asked for an endpoint name that points outside the relay's own mailbox folder, where it would read and return files from elsewhere on your machine. And a Shape from the marketplace can no longer name an extension in a way that reaches outside your DorkOS data folder; extension names now have to look like extension names everywhere DorkOS turns one into a file
- Alt+F4 no longer quits the whole app on Windows
- Labels, headers, and sidebar rows on Windows no longer act like drag-selectable web page text. Text in messages, code, and diffs can still be selected and copied
- Full-screen mode no longer leaves an empty strip at the top of the window
- The window's header and tabs dim slightly when it loses focus, like other native Mac apps; scrolling to the end of the chat or a sidebar list no longer bounces past it on a trackpad; and toast and error messages can be selected and copied
- A `dorkos://` link opened during a slow first boot now still opens once the app is ready, instead of silently doing nothing
- The desktop app never told its window what it was allowed to ask your computer for, and a window that says nothing is treated as saying yes — camera, microphone, location and reading your clipboard could all be handed over without a prompt you would ever see. Everything is now refused except the two things the app really does: show you a notification, and copy text you asked it to copy. Even those are refused to anything that is not DorkOS itself, like a website you have open in a canvas (DOR-560)
- The page the app runs on now carries a rule about where its code may come from: your own machine, and nowhere else. Nothing an agent writes into a message, a widget or a marketplace card can pull a script off the internet and run it there. Everything you already use works exactly as before, including 3D and PDF previews, embedded web pages and copy buttons (DOR-560)
- Creating your owner login now works from any address you have allowed the server to answer. Before, the server would load the whole app and then turn the sign-up away, which blocked Remote Access setup (DOR-1744)
- Sign-in and sign-up errors say what went wrong in plain words. A refused address used to show only "Invalid origin"; you now get a sentence, the address to allow, and the original wording underneath (DOR-1744)
- Remote Access now works in the Mac app. Turning it on always failed — the switch flicked straight back off, no matter which ngrok token you used — because the part of ngrok that does the real work was missing from the app we shipped. It now ships with the app, and the Windows build is wired the same way (#1458)
- Remote Access comes back when you restart the desktop app. Turning it on saved the setting, but only the command line ever read that setting back, so the desktop app started with the tunnel closed and nothing said why (DOR-1738)
- DorkOS now notices when a tunnel drops. It was asking ngrok to tell it using a name ngrok does not answer to, so a dead tunnel was still shown as connected until you turned it off by hand. A tunnel that is briefly re-establishing itself now reads as on and says "Reconnecting" — with your address still there — instead of showing as switched off, and turning Remote Access off yourself is silent rather than raising a red warning (DOR-1738, DOR-1739)
- A username and password you set for the tunnel in your environment is now actually used when you turn Remote Access on from the app. Before, the app started an open tunnel and then told you it was password-protected — the one direction that mistake must never point (DOR-1738)
- Your saved tunnel address no longer reads as empty after a restart (DOR-1738)
- When a tunnel fails to start or stop, the reason is written to the log. Someone who turned logging all the way up to find out why still saw nothing at all (#1458, DOR-1738)
- Stopping a remote-access tunnel now always works, even if login is turned off on this instance (DOR-574)
- Turning on Remote Access no longer looks like it did nothing. When the tunnel failed to start, the reason flashed on screen for an instant and vanished, taking the "Try again" button with it, and the switch snapped back off. The failure now stays on screen until you dismiss it, and "Try again" actually tries again (DOR-1739)
- Saving your ngrok token no longer always says "Could not save token. Try again." no matter what happened; DorkOS tells you the real reason and what to do about it. A custom domain that fails to save now says so instead of sitting in the box as though it had been saved, and clicking into that box and back out again no longer erases a domain you had already saved (DOR-1739)
- A tunnel that takes more than 15 seconds to start is no longer reported as timed out and then connected a few seconds later. A failure no longer sticks around for the rest of the session — closing Remote Access and reopening it, or saving a new token, clears it — and opening DorkOS while remote access is already on no longer announces "Remote access is on" as though it had just been turned on (DOR-1739)
- The connected tunnel's speed check no longer keeps firing at an unreachable address with nothing to stop it, piling up requests for as long as the window stays open (DOR-1739)
- The Remote Access setup note said to create your owner login first; it is the token first, and the login when you switch remote access on. The note now matches (DOR-1739)
- Long file paths in Settings read the right way round again. The Server and Advanced screens shorten a path from the front, so you keep the folder name at the end — and they no longer move the leading slash to the far right, drawing `/Users/kai/.dork` as `Users/kai/.dork/` (DOR-1686)
- "Reset to defaults" on the Appearance tab now puts back the theme and text and nothing else. It used to quietly flip every switch on the Preferences tab and forget your sidebar, canvas, and panel layouts too. The clean slate lives in Settings → Advanced → Danger Zone as "Reset All Settings", and it asks first (DOR-923)
- If you'd limited which kinds of files can be uploaded, resetting your settings no longer quietly allows every kind again (DOR-1505)
- Saving a Slack per-channel override with a mistyped setting name now shows an error naming the problem, instead of silently saving an empty rule (DOR-655)
- An API key no longer stops working after ten uses in a day. With **Require login** turned on, the `dorkos` command sends your key on every request, so the eleventh command of the day came back "unauthorized", as if the key had been revoked. Keys you already created start working again with no action from you (DOR-489)
- The Name field lines up with its Add button when adding a Claude account on a narrow screen
- On narrow screens, small buttons like "Try again" and "Create agent" are easier to tap — 44px tall, the minimum size Apple and Google both recommend (DOR-771)
- Sidebar rows, channels and sections read correctly to a screen reader again. Making them draggable had wrapped each one in a second, invisible button, and a button inside a button is something screen readers skip or garble (DOR-1418)
- Server log files now record what actually went wrong. When something failed, the saved line kept only the headline ("Failed to load workspaces") and threw away the reason, so the log often could not explain the failure it was written for. Every line now carries the error's message, its stack, and the chain of underlying causes (DOR-802)
- Server logs also record it when an OpenCode agent's unanswered permission request times out, matching what already happens for Claude Code (DOR-803)
- Fixed a rare first-start problem where two DorkOS processes opening the same brand-new data folder at once each made their own secret key and one was thrown away — leaving whatever it had locked up (saved connection credentials, signed-in sessions, browsers signed up for notifications) impossible to open. The first process to finish writing the key now wins. If a secret file in your data folder is empty, which only happens when a much older version was interrupted on its very first start, DorkOS stops with a message naming the file instead of quietly replacing it; move the file aside or delete it to have a new one made (DOR-712)
- Awkward text can no longer stall the server. A handful of text patterns got dramatically slower as the text got longer, and a few were reachable from outside: a scheduled task's time limit, a crash report's stack trace, and a chat message carrying a wall of half-finished tags could each tie the server up long enough to stop answering anyone
- Fixed a leak where the access token for a connected tool server showed up on the command line of the Codex program DorkOS starts, which meant any other program on your computer could read it. The token now travels out of sight, and your agents reach those servers exactly as before (DOR-993)
- Release blog posts no longer show the install instructions twice near the bottom of the page (DOR-649)
- A marketplace package page no longer shows the package's name as a heading twice — once as the page title, once again at the top of its README (DOR-725)
- Text on the dark sections of the story page was nearly invisible: a dark gray meant for cream backgrounds, painted on near-black. It now uses the same light color the rest of those sections use (DOR-1512)
- The "API Reference" link in the docs, from the rooms page and the integrations guide, no longer leads to a page-not-found error (DOR-611)
- Session, scheduled-task, and subtask rows now light up when you hover or tab to them, so it's clear what you're about to click (DOR-1752)
- The Activity feed now tells you when it can't reach the server, with a way to retry, instead of quietly showing "no activity" (DOR-1752)
- The Team page now shows a placeholder shaped like your roster while it loads, instead of a bare spinner that pops into a full grid (DOR-1752)
- The Team page's filters and search no longer jump down after your roster finishes loading — they now stay put while the roster fills in underneath them (DOR-1752)
- On Connections, the built-in Claude Code card no longer has a dashed border, which used to make it look unavailable even while it was live and working (DOR-1752)
- A conversation's scrollbar now lights up as soon as you move toward it, instead of only while you're actively scrolling (DOR-1752)

### Security

- Extensions that forward requests to an outside service (a "data proxy", like one that talks to GitHub for you) were also handing that service your DorkOS login — the cookie or key that proves the request came from you. It never needed to go: the extension already carries its own credential for the service it talks to. Your login now stops at DorkOS
- Those proxies got three more limits. They can only reach the address the extension declared, so a crafted request can no longer walk up to a neighbouring part of that service with the extension's key attached. If the service answers with a redirect, DorkOS hands it back to whoever asked instead of following it with the key. And there is now a ceiling of 120 requests a minute, so nothing can quietly burn through your quota
- `DORKOS_CORS_ORIGIN="*"` no longer opens the whole API to every website. Logging in is off by default, so a wildcard meant any page you happened to visit could read your sessions and files and start turns of its own. DorkOS now ignores the `*`, says so at startup, and tells you to list the exact addresses you want to allow. Listing real addresses works exactly as before
- Every response now says it must not be second-guessed about what kind of file it is, instead of only the handful of routes that said it themselves
- Sending data through an extension's proxy could also fail for a reason nobody could see: DorkOS passed along the size of the original request while sending a slightly different one, so the outside service either rejected it or waited forever for bytes that never came. DorkOS now states the size of what it actually sends
- Closed a hole where an uninstall could reach outside the marketplace's own folders. A package name is checked before DorkOS turns it into a folder on your disk, so a name dressed up as a path — `../../something-else` — is refused instead of pointing the uninstall's delete at a folder that was never a package. The same check guards the install cache
- Installing a package from a folder on your own disk now has to stay inside the folder DorkOS is allowed to reach, the same limit every other file feature respects. Previewing a package is held to the same limit, so a preview can no longer be used to ask what is in a folder elsewhere on the machine
- The `marketplace_install` and `marketplace_uninstall` tools an agent can call now check the project folder you point them at, which the web app has always done and the tools did not
- Your agents can no longer publish your machine to the internet. Opening a tunnel is one of the settings reserved for a person, but the button's own endpoint asked nobody, so anything on your machine that could reach DorkOS could open one. Closing a tunnel is still open to everything, on purpose — shutting off access should never be the thing that gets refused (DOR-1738)
- If you have Require login turned on, turning Remote Access on now takes a person signed in to DorkOS. A script holding one of your API keys is refused, because a key proves the account and not the person. This is a deliberate narrowing: a script of your own that used to turn the tunnel on will be turned down, and you turn it on from the app instead (DOR-1738)
- Saving any setting sent your stored secrets back over the wire: the reply carried your ngrok token, your tunnel sign-in, your MCP key and your cloud token in plain text, even when the setting you changed had nothing to do with them. Replies like that get written to logs and browser caches, and they travel the public internet when you use DorkOS from your phone. Saving now replies with a summary that says whether a key is set without saying what it is (DOR-1740)

## [0.66.0] - 2026-08-29

### Added

- Sending a message to a room now tells you who it went to. The reply from the server names the agents the room asked to reply, and names the ones that will not be answering along with the reason — the back-and-forth hit its reply limit, that agent has already taken its turns in this exchange, or the agent is no longer set up on this machine. It is the room's first answer, not its last: if the room later changes its mind about one of those agents, it says so in the conversation the way it always has. A chat window can now explain why nothing is happening instead of just sitting there (DOR-786)
- There is now a ceiling on how many turns your agents can start by messaging each other. Every route into an agent — another agent, an outside system, a webhook answering back, a scheduled task running — is counted in the same place, so two agents told to keep each other posted stop after a while instead of talking all night. It ships at 1,000 turns an hour for any one agent and 5,000 across DorkOS, the same allowance rooms have. When it stops something, it says which limit it was and the message stays in the agent's inbox to be read later. A turn DorkOS accepted but couldn't run, because every slot was busy, doesn't count against you. Change either number with `dorkos config set relay.maxAgentTurnsPerAgentPerHour` / `relay.maxAgentTurnsTotalPerHour`, or set them to `null` for no limit at all — but note that `0` stops your scheduled tasks too, since they start turns the same way (DOR-791)
- Search results from your Claude Code and OpenCode chats now open on the exact message you searched for, the way channel results already do. The message sits in the middle of the screen, so you can read what was said around it. When DorkOS can't find the message, from an old link or a chat that has changed since, it opens the chat as before (DOR-1579)
- Rooms that have files of their own now show them, in the room panel. The list is read-only for now, and every entry says who last changed it and when. Rooms without files of their own look exactly as they did.
- Files can be opened straight from a room's list: text and markdown show in place, and anything that can't be shown — a picture, something too big, a link — says so plainly.
- A room's file list hides the machinery by default — dotfiles, `node_modules`, and the folders your tools keep for themselves — with an eye button to show it again. The session Files panel already hid its own; now both do, and one button means the same thing in both.
- Your agents can now find a room by its name, so "post that in #backend" or "put it in my DM with Ana" works without you looking up an id for them. They can also ask which of their rooms a particular person is in — which is how an agent checks whether a direct message with someone already exists instead of opening a second one (DOR-1610)
- An agent can now see a room in full before it speaks: what the room is about, and everyone in it, with each person's @handle and whether they are a person or another agent. It only works for rooms the agent is actually in — a room you never added it to stays invisible, exactly as it was before (DOR-1610)
- A scheduled task can now say which agent runtime it runs on — Claude Code, Codex or OpenCode — which model, and how hard that model thinks. Pick them under **Advanced settings** when you create or edit a task, or set them in the task's file, over the API, from the `dorkos task create` command, or by asking an agent to make you a task with them (DOR-1615, DOR-1347)
- The task form tells you when a choice no longer works: a runtime you have not turned on, or a model that runtime does not offer — which is what you see if you pick a model for one runtime and then move the task to another. It never drops the choice for you (DOR-1615, DOR-1347)
- A task that runs somewhere other than its agent says so on its row, and nowhere else — the tasks that simply follow their agent stay quiet (DOR-1615, DOR-1347)
- Leave all three unset and nothing changes: the task runs on whatever its agent runs on, which is what every scheduled task did before. Setting one is an override, and clearing it goes back to following the agent (DOR-1615)
- Run history now records what each run ran on, not what the task says today. Move a task to a different runtime next week and its old runs still report the truth about themselves (DOR-1615, DOR-1347)
- An agent can merge its work into a room's files (DOR-1598)
- Your Codex and OpenCode agents can now use the same DorkOS tools your Claude Code agents already have — posting in rooms, reacting with an emoji, reading back what was said, and remembering things between sessions. It is off to start with: turn on **DorkOS tools in every runtime** in Settings under Experiments, and it takes effect on those agents' next turn. Expect their turns to cost a little more, since they now carry a longer list of tools (DOR-1613)
- When DorkOS cannot get its screen working, it now shows you a page that says so instead of leaving you with a black rectangle. It offers you three things: start over, reset the window and restart, or save a report you can send us. Your projects, your sessions and your agents are not touched by any of them — they live on your computer, not in that window (DOR-1453)
- Agents can manage rooms when you switch it on — open a channel or a direct message, bring people and agents in, take them out, rename a channel, and leave a channel they are finished with. It is **off for every agent until you turn it on**, in that agent's own Tools settings. (DOR-1611)
- This switch is a lock, not a hint. Unlike the four tool groups beside it, turning it off blocks the calls: the agent is refused and told to ask you. Only you can change it — an agent cannot turn it on for itself. (DOR-1611)
- Whatever you switch on, an agent can never remove you from a room, and any room holding two agents holds you too. It cannot rename your home channel, and it cannot leave a direct message — those stay until you archive them. (DOR-1611)
- An agent can name you and your other agents the way the app does — by @handle, or by the id it sees on a room's member list. You do not need a handle of your own for it to put you in a room. (DOR-1611)
- An agent cannot rename a direct message, whichever way it asks: a direct message is named after who is in it. It can still write the topic. (DOR-1611)
- If you launch DorkOS from the window that opens when you double-click the download, it now offers to move itself into your Applications folder, so updates keep working. An app run from that window can't update itself, which is the difference between getting new versions and quietly never getting one again. DorkOS asks once, takes no for an answer, and doesn't ask again unless you move it somewhere else. Mac only. (DOR-1495)
- Your agents can decide when to speak. Right now, whatever an agent writes during its turn in a room gets posted, so it answers every single time it is triggered. With **Agents decide when to speak** on, it chooses instead: it can answer, it can just react with an emoji, or it can decide nothing needs saying and stay quiet — and its thinking stays in its own session rather than landing in the room. It works the same way in direct messages, where an agent could not choose before at all. It is off to start with: turn it on in Settings under Experiments, and for Codex and OpenCode agents turn on **DorkOS tools in every runtime** first (DOR-1613)
- When you ask an agent something and it decides not to reply, the room says so — one line, "Ana read this and did not reply", so you are never left wondering whether it saw you. When nobody asked and an agent simply had nothing to add, the room stays exactly as it was and the "working" pill fades out saying it finished with nothing to add (DOR-1613)
- A new setting caps how many messages one agent may post into a room during a single turn, so a single answer cannot arrive as nine bubbles. Three by default, in Settings (DOR-1613)
- The Files section of a room now tells you when somebody has work the room hasn't got yet. Each agent in a room with files works in its own copy of them, and that copy can sit there for days: the badge names who is holding something, and hovering it says whether that is commits nobody merged or changes nobody committed. It shows up only when there is something to see (DOR-1599)
- Agents working in a room's files are now told where they are and what to do there. Every turn in one of those rooms says which copy of the files the agent is working in, where the room's own copy is and that it must not write there, how far the room has moved on since it last looked, how to catch up before editing, and how to hand finished work back to the room (DOR-1599)
- A room that has files of its own now shows them in the room panel, and you can open one to read it. Each file says who last changed it and when, and the room's ROOM.md sits at the top where you can find it (DOR-1600, DOR-1601)
- You can now edit a room's markdown files in DorkOS and save them. Each save is one entry in the room's history, with your name on it, so the room can always say who wrote what. Other kinds of file are still read-only for now (DOR-1601)
- If somebody else changes the same file while you have it open, DorkOS will not quietly write over their work or throw yours away. It tells you who got there first and what they said they were doing, and you choose: open their version, or save yours over it (DOR-1600, DOR-1601)
- If somebody changes a room's files outside DorkOS — in a terminal, say — saving in that room stops until it is sorted out, and the room now says so instead of just refusing. It lists what changed and gives you two ways out: keep it all as one saved change, or throw away exactly the files you tick (DOR-1600, DOR-1601)
- Saving a file that is too large now says so plainly, instead of answering with a server error that told you nothing you could act on (DOR-1600)

- A room can now have files of its own: a folder everyone in the room works on together. It holds real files rather than attachments: scripts, notes, a whole small project. The room keeps one shared copy of them, and every agent in the room gets its own copy to work in, so two agents can be busy at the same time without writing over each other. Finished work goes back to the shared copy by merging, which is the only way anything lands there (DOR-1592, DOR-1596)
- **There is no button for giving a room files yet.** Today it is a request to the DorkOS API, described in [Rooms](/docs/concepts/rooms#giving-a-room-files-of-its-own). Only you can make it, never an agent. Everything else here works normally once a room has files (DOR-1592)
- An agent's copy of a room's files sticks around between conversations, so work in progress is still there tomorrow. DorkOS clears one away only when it has been untouched for a while **and** holds nothing the room has not already got. Anything unsaved or not yet handed in is left alone, and the room shows you who is holding it (DOR-1596)
- New settings for all of this under **Room files**: whether rooms may have files at all, how long an untouched copy is kept, and how big a file, a room, and a `ROOM.md` may get. See [Configuration](/docs/getting-started/configuration#room-files) (DOR-1591)
- A room that has files of its own now has a `ROOM.md`. It is the room's front page, written by the people and agents in it. Whatever it says reaches every agent in that room, on every turn, so "how we work here" is written down once instead of repeated in every message (DOR-1593)
- Agents are told plainly where those rules came from: they are additions to the agent's own instructions, from the room's members, and never a replacement. If a room's rule clashes with an agent's own, the agent follows its own and says so (DOR-1593)
- Editing `ROOM.md` takes effect on the next thing an agent does, never in the middle of something it is already working on. And if the file grows past the size a turn can carry, agents are told it is too long to send rather than being handed part of it. Half a rule reads like a whole one (DOR-1593)

### Changed

- Agents in a channel no longer stop and think about every message they overhear. After you talk to an agent it keeps following the conversation for a while — that part is unchanged — but it now skips a message that plainly was not for it: one that named a different agent, or a reply in an exchange it is not part of. Before, each of those cost a full turn that ended in the agent saying nothing. In a channel with four agents, asking one of them a question used to wake all four.
- Nothing goes missing. A skipped message still reaches the agent as background the next time it does reply, so it knows what was said while it stayed out of it.
- A message that names an agent, and anything you say in a direct message, is never skipped. If you asked, you get an answer.
- You can turn this off with `dorkos config set rooms.responseGate off` if you would rather every agent weigh every message.
- dorkos.ai has a new home page. It opens with the short film about Dave, who gets three agents and stops doing everything himself, and then shows you the same thing working for real: scroll, and one conversation plays out in front of you, apps land in it as they are used, and the whole thing settles into a laptop at the end. The old page told you what DorkOS was. This one shows you (DOR-1562)
- Underneath the film there is a shelf for short walkthroughs. The only thing on it today is the film itself, cut to fit a phone. The rest are empty frames, and the page says so on each one rather than pretending otherwise. You can leave your email on any tile and hear when the walkthroughs are made (DOR-1562)
- The story page's footer now links to npm as well as GitHub, so it ends the way every other page on the site does (DOR-1562)
- The list of features and the answers to common questions are still there, in the same words, further down the page where someone who has decided to check goes looking for them (DOR-1562)
- The menu at the bottom of the home page now moves you around the page instead of pointing at other pages, and folds the rest of the site behind one button. Every other page keeps the menu it had (DOR-1562)
- The newsletter signup boxes on dorkos.ai now turn away a flood of sign-ups coming from one place. Signing up works exactly as before. Someone sending attempt after attempt is asked to wait a few minutes (DOR-1581)
- The rest of the public endpoints on dorkos.ai now turn away a flood coming from one place: sending feedback, checking on feedback you sent, the two links in our newsletter emails, and the three places DorkOS reports anonymous usage to. Everything works exactly as before. Someone hammering one of them is asked to wait a few minutes, and each endpoint is counted on its own, so a flood at one never blocks another. Unsubscribing and reporting usage get generous room on purpose, so a real person is never turned away (DOR-1586)
- One thing changed in what we do with your IP address when DorkOS reports anonymous usage: we now count how many requests come from it in the last few minutes, so nobody can flood those endpoints. That count lives in memory for a few minutes and then it is gone. Your address is still never saved, never written to a log, and never passed to anyone else (DOR-1586)
- `ROOM.md` and `README.md` now sit at the top of the file list, where you'd look for them. This applies to the session Files panel too.
- The Files panel on a session and the new file list in a room are the same thing underneath now, so anything either of them learns, both of them get.
- The permissions dial on a task now describes what will actually happen on the program the task runs on, instead of always describing Claude Code. And if you move a task to a program where its setting means "never stop to ask", the app asks you first rather than making the change quietly (DOR-1615)
- Scheduled runs used to happen on Claude Code no matter what the task or its agent said, on whatever model came out of the box. They now walk the same ladder every other kind of turn walks: the task's own setting, then the skill file's, then the agent's, then your default for that runtime (DOR-1615, DOR-1347)
- A task set to a runtime you have not turned on now fails its run and says so, naming the runtime and what to do about it. It never quietly runs somewhere else — a run on a different runtime is a different run, billed to a different account, and you would have had nothing on screen to tell you (DOR-1615)
- A task that remembers its last run, and that you then move to a different runtime, starts a fresh conversation instead of trying to pick up one that lives in another program's history. Its earlier runs are all still there to read (DOR-1615)
- One rough edge worth knowing: if a task remembers its last run and you change its model, the next run may carry on with the old model until that conversation is put down. Tasks that start fresh each time — the default — always use the model you picked (DOR-1347)
- The Mac install steps now tell you to open DorkOS from your Applications folder rather than from the window the download opened, and say why it matters. (DOR-1495)

### Removed

- The bar across the top of the home page is gone. The floating menu at the bottom does that job now, and it moves you around the page. Every other page keeps its top bar (DOR-1562)
- The old home page is gone, and so is what only it carried: the scrolling activity feed at the top, the cards about what goes wrong when you run agents by hand, the history of how DorkOS was built, and the closing note with the contact address in it. The address is still in the footer of every page (DOR-1562)

### Fixed

- Open the same chat in a second window and you now see the reply that is already being written, plus the Stop button, right away. Before, that window could sit blank and say "Live updates lost".
- A chat link that leaves out the folder now shows the conversation and stays live. DorkOS looks up the folder the chat is running in instead of falling back to a default one. The name in the title bar can still be wrong on those links — that part is not fixed yet.
- Opening a room while an agent is working in it now shows that straight away, instead of after up to ten seconds of looking idle. The room's details panel had a worse version of the same problem: opened over a different room, it could never see who was working and quietly drew nothing, which looks exactly like a room where nobody is working. It now knows the difference, and says "No one is working right now" only when that is actually true (DOR-786)
- If an agent is taken out of a room while a message is still waiting for it, the room now says so. Before, the message was quietly dropped and nothing was written anywhere, so from inside the conversation it looked like the agent had simply ignored you (DOR-786)
- When a scheduled task completes or fails, it now shows up in your activity feed right away, instead of only after the next refresh. This already worked on some setups; now it works on every setup (DOR-1573)
- An agent you set up to run on Codex or OpenCode is now handed its Telegram and Slack messages on that program, the same one it already used in rooms and in the app. Before, every chat message went to Claude Code no matter what the agent was set to — the wrong program replying under the right agent's name, with nothing anywhere saying so. Which program owns a chat conversation is now decided the moment the conversation starts, from the agent's own settings, and written down, so every later message in that conversation goes to the same place (DOR-1614)
- Chat replies now use the model and effort you chose for that agent on the program it actually runs on. A model name only means something inside the program that offers it, so a Codex agent no longer gets handed a Claude model name it cannot use (DOR-1614)
- A chat message meant for a program this copy of DorkOS did not start is now turned down with a message saying which program is missing, instead of being quietly handed to a different one (DOR-1614)
- Approving or denying a tool from a chat now reaches whichever program is waiting on the answer, not only Claude Code (DOR-1614)
- The sidebar no longer flashes its phone layout for an instant when you widen the window (DOR-1558)
- Screen readers now hear the "1 minute left" warning on a permission request even when the tab was in the background and the clock skipped a second (DOR-1558)
- Fixed the address DorkOS gives Codex for the panel it uses to open things on your screen. It was fixed to one form of "this machine", which is not always the one DorkOS is listening on — so on some Macs, and inside Docker on Windows, Codex could not reach it at all (DOR-723)
- The desktop app now tells you when an update fails to install, instead of quietly offering you a restart that cannot work. It writes down which version it was about to install, and the next time you open DorkOS it checks whether that version is the one actually running. If it isn't, the sidebar says so and offers a fresh copy to download — the one thing that always works. Your settings and your agents stay exactly where they are. Before this, an update could fail every time for weeks with nothing on screen but "Update ready — Restart" (DOR-1454)
- Update errors are no longer hidden. A problem that showed up after an update finished downloading used to be swallowed by the "Update ready" card, which kept sitting there as if everything were fine. Now the card shows what actually happened (DOR-1454)
- If the DorkOS app's screen ever fails to come up, the app now notices and fixes itself. It waits ten seconds for the window to draw; if nothing appears, it reloads. If that doesn't work it clears what the window has saved and reloads again, and after that it offers to restart DorkOS with graphics acceleration turned off — and asks first if your agents are still working, so nothing is interrupted without you. It counts across restarts, so a window that breaks every single launch still gets each of those tried once. Before this, a window that came up black simply stayed black: nothing retried it, nothing recovered it, and nothing wrote down what went wrong (DOR-1453)
- The "DorkOS couldn't start" message used to tell you to check a folder that only exists on a Mac. It now names the folder on the computer you are actually using
- Clicking "Restart to install" now actually installs the update. DorkOS used to step in front of the installer's own restart — shutting itself down its own way and quitting — which left the installer with nothing to install, so the app came back on the old version every time. It now gets out of the way: it asks about any agents still working, stops its background server, and then hands the restart to the installer (DOR-1455)
- DorkOS clears out its own downloaded update once it has caught up with it. A copy left over from an earlier attempt used to be handed to the installer on every quit, for ever — and if you had installed a newer version yourself, that leftover could quietly put you back on the old one (DOR-1455)
- If an update cannot install itself, DorkOS now recovers instead of sitting there. Handing the restart to the installer means shutting down first, and on the rare occasions the installer gives up without saying so, DorkOS starts itself back up within a few seconds and tells you the update did not go in (DOR-1455)
- DorkOS notices when you install a new version while it is still running. It keeps running in the menu bar after you close its window, so dragging a new copy into your Applications folder used to change nothing: opening it just brought the old one back. Now it tells you the new version is there and offers to restart into it — and it makes sure a half-finished download from before cannot land on top of the copy you just installed (DOR-1455)
- A missing or broken app file now shows up as a clear error in your browser's network tab instead of a silently blank window (DOR-1474)
- Taking an agent out of a room no longer leaves the room pointing at it as the one that answers messages addressed to nobody in particular. Those messages used to reach nobody at all, silently. (DOR-1611)
- If DorkOS can't reach its server when it opens, it now says so and keeps trying. Before, you got an empty window — or, if you had used DorkOS before, a full screen rebuilt from what your browser remembered last time, where none of the rooms, agents or buttons in it actually worked. The new screen tells you the server may still be starting, has a Try again button, and clears itself the moment the server answers (DOR-1475)
- A server that has stopped answering without ever refusing the connection now gets the same screen, after fifteen seconds of silence, instead of leaving you in a window where everything you press hangs (DOR-1475)
- Opening DorkOS while its server was down could also drop you into the first-run setup screens, as if this were a brand new install — and anything you answered there had nowhere to be saved. It doesn't do that any more (DOR-1475)
- The little "working on it · 12s" counter beside a busy agent now keeps true time. It used to slip a fraction of a second further behind with every second it counted, so on a long turn it read short (DOR-1642).

### Security

- Leaving the folder out of a request no longer reads a chat that naming the same folder would be refused for. Every session request is now checked against your allowed folders, whether you named one or DorkOS worked it out.
- With Require login on, deleting a scheduled task or cancelling a run now needs a person signed in to DorkOS. A program holding one of your API keys is refused, the same as when it tries to change how a task runs. The approvals guide now says plainly that if you leave agents running on their own and they can use a shell, you should turn on Require login — without it, one of those agents can approve its own scheduled task. (DOR-1574)
- Connection errors from chat integrations can no longer write access tokens into log files.

## [0.65.0] - 2026-08-26

### Added

- Three new pages at dorkos.ai/compare cover the coding agents DorkOS runs for you: Claude Code, Codex and OpenCode. These are not head to head pages. Each one says what the agent already does well on its own, then what having DorkOS around it adds, so you can see where the line sits before you install anything (DOR-1465)
- Each page scores the agent honestly on its own merits, with a link to the maker's own documentation behind every claim and the date someone last checked it. Where an agent already does something DorkOS does, the page says so instead of quietly leaving it out (DOR-1465)
- When the desktop app misbehaves, Help → Save Diagnostic Report now gathers everything we need to help you into a single file on your Desktop: the app's logs, your version numbers, where the app is installed, and what its last update did. Your saved keys and passwords are replaced with [redacted]. The logs go in as-is, so glance through them if you're unsure about anything in there. The same item is in the DorkOS menu on your menu bar, which still works when the window itself won't open. The logs now also record the moment DorkOS first reaches its own server, so "it opened but nothing loaded" is a question the file can actually answer (DOR-1456)
- A skill file can now carry a `schedule:` block that says when it should run: a time, a timezone, a time limit, how much the run may do on its own, and what to send when it fires. DorkOS understands the block today. Actually running a skill from its own `schedule:` block arrives in a later change (DOR-1484)
- A task that could not run because DorkOS was already at its limit now says so in that task's history, at the time it was meant to run, instead of disappearing without a word. It shows as "Skipped", with the reason, and it does not count against the task's success record (DOR-1482)
- Five new pages at dorkos.ai/compare put DorkOS head to head with the tools people ask about most: GitHub's Agent HQ, Devin, Conductor, Emdash and Claude Squad. Each one says what the other tool is genuinely good at before it says anything about ours, and every claim links to the maker's own page with the date someone last checked it (DOR-1466)
- The Conductor page settles which Conductor it means in its first sentence, and again further down. Three different products share the name, and only one of them is the Mac app for running coding agents (DOR-1466)
- Where a rival does something better, the pages say so plainly. Emdash drives more agent tools than DorkOS does and can also run jobs on a schedule; Agent HQ reaches more screens and hands one job to three companies' agents at once; Devin can split a job across copies of itself. Those are all in the tables, in their column, marked done (DOR-1466)
- Five more pages at dorkos.ai/compare, covering Omnara, Amp, Cline, Factory's Droid and DeepSeek Harness. Each one leads with what the other tool is genuinely good at, and every claim links to the maker's own page with the date someone last checked it (DOR-1467)
- The DeepSeek Harness page is the one to read if you want to know who else is building what we are building. It runs Claude Code and Codex inside itself, which is our own headline trick, so its column is marked done exactly where ours is. We quote its makers calling it a developer preview instead of softening it, because that is how we would want our own early parts described (DOR-1467)
- Where a rival is ahead, the tables say so plainly. Cline runs jobs on a cron line and already has agent teams with a shared task board and a mailbox, which is further than our rooms have got. Droid schedules work and plans big jobs into milestones that get checked. Omnara ships an iPhone app with an Apple Watch app beside it, and we ship neither (DOR-1467)
- Two things worth knowing if you read about these tools elsewhere: Amp is no longer Sourcegraph's agent, having spun out into its own company at the end of 2025, and Omnara has moved on from being a phone command centre to being a platform for running agents. Both pages say so in their first few lines (DOR-1467)
- Five more pages at dorkos.ai/compare. Three are for tools that are not really our rivals but keep coming up next to us: OpenClaw, Hermes Agent and Block's Buzz. Each one opens by saying plainly that it is a different kind of product, and then compares only the ground the two actually share (DOR-1468)
- Two are for tools that no longer exist: Terragon, which closed in February 2026, and Roo Code, which closed in May. These pages are for people trying to work out where to go next, so they lead with what happened rather than with us, and both say out loud where DorkOS is the wrong answer. The Roo Code page says it plainly: if what you miss is the agent inside your editor, the tools its own team named will serve you better than we will (DOR-1468)
- The Roo Code page corrects something most write-ups get wrong. Roo Code's own shutdown notice names two alternatives, Cline and ZooCode, and Kilo Code is not one of them, however often you see it called the official replacement. The page says who named whom, so you can choose on the facts (DOR-1468)
- The Buzz page is the one to read if you want to know where someone else is ahead of us. Buzz can hand an agent a new instruction while it is still working, and our rooms make you wait for the turn to end. It says so in the table, twice (DOR-1468)
- Where a fact could not be checked, the pages say so instead of guessing. Terragon's shutdown notice went offline with its website, so that page explains where the notice went, links an archived copy, and quotes no prices we could not confirm (DOR-1468)
- Compare is now in the menu at the bottom of dorkos.ai, right after Features. The comparison pages have been there for a while, but you had to already know they existed, or find the link in the footer (DOR-1504)
- The menu now shows you where you are. Reading a comparison, Compare is the word that stands out; reading a feature page, it is Features (DOR-1504)
- The Compare page opens with a picture of DorkOS instead of only words, so you can see the thing being compared before you read about it (DOR-1504)
- A new page at dorkos.ai/compare for Grok Bot, xAI's cloud coworker. It is not the same kind of tool as DorkOS, so the page says that first and then compares only the ground the two share: work that carries on while you are away, and checking in from your phone (DOR-1514)
- The page answers the question the pricing pages make hard work. Grok Bot does not come with every Grok or Cursor plan: xAI lists SuperGrok Plus and SuperGrok Heavy, and on the Cursor side Pro+, Ultra and Teams. Plain SuperGrok at $30 and Cursor Pro at $20 are not on that list, and the page says so with the current numbers (DOR-1514)
- It is honest about the row where Grok Bot is ahead of us. Several of its bots run at once, message each other and hand a job along, and that works today, while our rooms are still marked early (DOR-1514)
- It is also clear about what Grok Bot is not for. The eight jobs xAI uses to describe it are office work: outreach, recruiting, expenses, a weekly report. Working through the code in your own repository is not one of them (DOR-1514)
- Marketplace packages can ship scheduled tasks. Until now only a Shape could set one up; a plugin, agent template, or skill pack can now do it too, so a package that does recurring work brings its own schedule instead of leaving you to write one by hand after installing. (DOR-1487)
- A package sets up a schedule in one of two ways: it points at a skill it already ships, which puts the timing right in that skill's own file, or it describes the work itself, which creates a new skill for it. Either way you end up with a normal skill file you can read, edit, or delete. (DOR-1487)
- Before you install, the confirmation screen now lists the scheduled tasks any package will set up — not just a Shape's. It shows how often each one runs and what it is allowed to do while nobody is watching. (DOR-1487)
- Removing a package removes the scheduled tasks it created. Nothing it set up keeps running once it is gone, and skills you wrote yourself are never touched. (DOR-1487)
- Any skill can now be a scheduled task. Add a `schedule:` block to a skill's settings and DorkOS picks it up — no moving the file, no special folder. Take the block out and it goes back to being an ordinary skill. DorkOS watches your agents' `.agents/skills/` folders and a new `~/.dork/skills/` folder for schedules that do not belong to any one project (DOR-1485)
- Nothing DorkOS finds in a file ever starts running on its own. A schedule found on disk waits on the Schedules page until you approve it, whether or not the file says it is switched on. Once you approve it, it stays approved as long as the file does not change; edit what it does or when it runs and it comes back for another look. That means a schedule cannot arrive on your computer through a `git pull` or an installed package and quietly start running (DOR-1485)
- A schedule that DorkOS cannot read now says so instead of going quiet. If the schedule settings have a typo, or the timing is written in a way DorkOS cannot make sense of, the schedule shows up waiting for you with the problem written out — naming the setting and what is wrong with it. The skill itself keeps working everywhere else; only the schedule half is held back (DOR-1485)
- Agents you add while DorkOS is running have their schedules found straight away. Before, DorkOS only looked at each agent's folders when it started up, so a schedule that came with a newly added agent stayed invisible until the next restart (DOR-1485)
- Approving a schedule no longer rewrites its file. Approving is a decision about the schedule, not a change to what it does, so DorkOS leaves the file exactly as you wrote it — including the comments, spacing and settings it does not recognise. If you do change what a schedule does, DorkOS writes that change into the schedule settings themselves rather than alongside them (DOR-1485)
- Schedules that come from an installed package are left alone. You can switch one on or off, but DorkOS will not edit the package's own copy — that change would be shared by every agent using the package and would disappear at the next update (DOR-1485)
- Saving a schedule's file no longer makes you approve it again. Many editors save by replacing the file rather than changing it, and installing a package update does the same; DorkOS now recognises that the schedule came back unchanged. Genuinely changing what a schedule does, or when it runs, still brings it back to you for a look (DOR-1485)
- Removing the schedule settings from a skill now switches its schedule off, even if DorkOS was not watching at the moment you did it. It stays in your list, switched off, with its history intact (DOR-1485)
- Schedules that came with an installed package are found. They arrive as a shortcut into the package's own folder, and DorkOS was quietly skipping every one of them, so a package could ship a schedule that never appeared anywhere (DOR-1485)
- DorkOS now records your approval of a schedule directly, rather than working it out from whether the schedule is switched on. Switching a schedule off, or removing the agent it belongs to, no longer has any bearing on whether it counts as approved — so a schedule you never approved cannot end up running because something else switched it around. Schedules you had already approved stay approved when you upgrade (DOR-1485)
- When a schedule is waiting because its file changed, DorkOS says so in its own voice instead of appearing to quote an agent that never said it (DOR-1485)
- Editing a schedule that is already running keeps it running. Changing what it does, or when it runs, no longer sends your own schedule back to you for approval a few minutes later. If an agent makes the change instead of you, it still comes back for a look (DOR-1485)
- The features list on dorkos.ai now includes seven things that shipped without ever getting written down: your Inbox, alerts that follow you to your phone, schedule approvals, reply limits, the activity feed, billing an agent to a different Claude account, and Shapes (DOR-1516)
- The comparison pages ask six new questions, and they are the ones people actually run into. Does it use the plan you already pay for? Can an agent book itself a repeating job, and do you get a say? Can you stop your agents talking to each other all night? Can you read the code and skip making an account? Can you say yes from your phone? Is there one list of everything waiting on you? (DOR-1516)
- DorkOS now keeps a searchable copy of what was said in your Claude Code chats — including the ones you ran from the plain `claude` command line, outside DorkOS. It reads the chat files Claude Code already writes and never changes them. Nothing in the app searches this yet; the search box itself comes next (DOR-681)
- It only keeps what was **said**: your messages and the agent's replies, in plain words. Command output, file contents, and the agent's private notes are left out on purpose, so the copy stays small and a search does not fill up with machine noise (DOR-681)
- A few kinds of chat are left out for the same reason. Conversations a helper agent had with itself are not yours, so they are skipped. So are the throwaway chats our own test runs produce (DOR-681)
- The copy stays up to date without re-reading everything. DorkOS remembers how far into each chat file it got and picks up from there, and it notices a chat that was half-written when it looked — so a message that was still being saved is read whole the next time round, never cut in half (DOR-681)
- Your agents remember what they learn. Every agent now keeps a short notes
  file of its own, beside its instructions and its boundaries. It reads those
  notes at the start of every conversation it joins, and writes down what is
  worth keeping. Tell an agent something in a private chat, and it still knows
  in a team channel next week (DOR-632)
- Every note the agent saves records where it learned it, like "(noted in
  #product, 2026-08-24)". The agent does not choose that part, so a note always
  says where it came from, and a note that turns out to be wrong tells you
  which conversation taught it (DOR-632)
- The notes file is plain markdown you can open in any editor, or from the
  agent's profile. Fix a line to correct it. Delete a line to forget it. It
  holds about 8,000 characters, which is small on purpose: the notes travel
  with every turn, so when the file fills up the agent is asked to tidy it
  rather than grow it (DOR-632)
- Anything in the notes file can come up in any conversation the agent joins,
  including channels with other people in them, so never put a secret in it.
  The file explains this rule at the top, and it is the only thing that crosses
  between conversations. The conversations themselves never do (DOR-632)
- Agents are now told the plain truth about how they run: each conversation is
  one session of the agent, sessions share the notes file but not the
  conversation, and an agent asked about work it cannot see should say so
  rather than guess. That last one is the difference between an agent that
  forgot and an agent that was never there (DOR-632)
- You can now ask DorkOS where something was said, and get an answer back in one request: `GET /api/search?q=…` looks through your rooms and your Claude Code chats at once and returns the best matches, each with the sentence it was in and the words you searched for marked. The search box you will click is still on its way (DOR-684)
- Results come back ranked together rather than sorted by where they came from, because "where did we talk about the scheduler" does not know whether you said it in a channel or to an agent (DOR-684)
- Searching matches whole words, including their other forms: look for `dogs` and you will find "dog", "dogs" and "DOGGED". A piece of a word, like `ogs`, finds nothing (DOR-684)
- Each result carries what it needs to be opened later — which chat or room it was in, where in it, who said it, and when (DOR-684)
- The searchable copy of your Claude Code chats now covers **every** Claude Code account on your computer, not just the one DorkOS happens to be pointed at. It used to read a single account and say nothing about the rest — about half the chats on the computer where this was found, and less on a computer with more accounts. Nothing in the app searches this yet; the search box itself comes next (DOR-682)
- Which accounts get read is the same list DorkOS already uses everywhere else: the one you picked, the one your terminal points at, `~/.claude`, and any account you added in settings. Nothing is guessed — DorkOS does not go hunting for folders that merely look like accounts (DOR-682)
- If one account's folder cannot be read, DorkOS names that folder in its own log and keeps what it already knows about the account rather than throwing it away. There is nothing to see in the app; the note is for whoever goes looking in the server log (DOR-682)
- **Search your messages.** Press `⌘⇧F` (`Ctrl+Shift+F` on Windows and Linux) and type what you remember somebody saying. DorkOS looks through your channels and direct messages, and your Claude Code, Codex and OpenCode conversations, shows you the sentence it found with your words picked out, and takes you to the conversation it was said in. (DOR-685)
- The box tells you what it can and cannot see. Before you type anything it says which conversations it searches and which it does not, that tool output and file contents are never searched, and that it matches whole words — so `ogs` will not find `dogs`, but `dog*` will. Nothing about the edges of search is left for you to discover by getting no results. (DOR-685)
- `⌘K` now offers **"Search messages for …"** as its last row, carrying whatever you already typed. `⌘K` still finds things by their name — an agent, a channel, a conversation — and the new box finds them by what was said inside them. They stay two separate boxes on purpose. (DOR-685)
- A conversation whose project folder has been deleted still turns up, and still opens: you can read what was said, and DorkOS tells you the folder is gone rather than failing. (DOR-685)
- The searchable copy of your chats now covers your **Codex** conversations too — live ones and ones you archived. DorkOS reads the files Codex already writes, so chats you had in DorkOS and chats you had in the plain `codex` terminal are both in there. You can search these from the search box (⌘⇧F) (DOR-683)
- Only what was actually said gets saved: your words and the agent's replies. The setup text Codex and DorkOS slip into a message before sending it — the project notes, the environment block, the widget instructions — is left out, so searching does not turn up things nobody said (DOR-683)
- Codex records every message twice in its own files, once for the model and once for the on-screen log. DorkOS reads one of the two, so a chat you had once shows up once (DOR-683)
- If Codex has never run on your computer, this quietly finds nothing and says nothing (DOR-683)
- The searchable copy of your chats now covers your **OpenCode** conversations too. With this, every runtime DorkOS can run is in there — your rooms, Claude Code, Codex and OpenCode. You can search these from the search box (⌘⇧F) (DOR-688)
- DorkOS reads them without ever opening OpenCode's own file. Each pass takes a copy, reads the copy, and deletes it. OpenCode keeps its sign-in details in the same file as its messages, so DorkOS reads only the three tables that hold conversations and cannot reach the rest — no account or password can end up in the search index, and DorkOS never starts OpenCode in the background to read them (DOR-688)
- Anything you actually typed is kept as you typed it, including a key you happened to paste into a chat. That is your own conversation, and DorkOS treats it the way it treats every other word in it (DOR-688)
- Conversations a helper agent had with itself are left out, and so is a conversation OpenCode has deleted. If you have never used OpenCode, nothing happens and nothing is reported (DOR-688)
- A conversation you are in the middle of gets picked up properly. OpenCode writes an answer a piece at a time over as much as a minute, so DorkOS keeps re-reading anything touched in the last quarter of an hour until it settles — otherwise you could search for a sentence your agent said and never find it (DOR-688)
- If DorkOS cannot read OpenCode's file at all, searches now say so instead of quietly returning less, and the other chat sources keep working rather than going quiet alongside it (DOR-688)
- If OpenCode's file is briefly unreadable while DorkOS is copying it, DorkOS waits rather than deleting conversations that are still there (DOR-688)
- Your agents can now look things up in any room they are in, not just the one
  they are answering in. Ask in one channel about something that was decided in
  another, and the agent finds it and tells you which channel it came from. It
  can also list the rooms and direct messages it belongs to, so it can say where
  it has been and read a conversation back (DOR-1532)
- An agent only ever finds what it was there for. It sees the rooms it is a
  member of and nothing else, and in each one it starts from the day it joined —
  so adding an agent to a long-running channel does not hand it the years of
  conversation that happened before it arrived. A room it is not in returns
  exactly what a room that does not exist returns: nothing at all (DOR-1532)
- Agents are told when to use this. The same short note that tells an agent it
  is one session of itself now adds the next step: if you are asked about
  something said in another room you belong to, go and look, and if you cannot
  find it, say so rather than guess (DOR-1532)
- Your agents keep working even if the thing storing their memory stops working. Memory now lives behind a swap point, so it can come from somewhere other than the notes file DorkOS ships with. If whatever you choose starts failing, DorkOS goes straight back to the notes file, mentions it once in the log, and your conversations carry on as normal — a memory problem can never end a chat. Worth knowing: while DorkOS is falling back, an agent reads the notes file rather than the backend that stopped answering, so notes kept only in that backend are out of view until you fix it and restart (DOR-1533)
- A new setting, `memory.provider`, says where your agents keep what they remember. It starts as `builtin`: one small notes file beside each agent, on your machine, which you can open in any editor. Only you can change it, and a change takes effect the next time DorkOS starts (DOR-1533)
- The plugin build now packages SQLite alongside the plugin, picking the build that matches whichever Obsidian you run it on. Every one of them is checked against a recorded fingerprint each time it is used — not just the first time it is downloaded — so bytes that are not what they claim to be stop the build instead of shipping (DOR-1563)
- The plugin now carries the rest of what searching your history needs: a strictly read-only path to the copy the DorkOS app keeps. Read-only is the guarantee, not a detail — it will not create a database, change one, or add to one, so it can never disagree with the DorkOS app about your own data. Where there is nothing to read, it stays out of the way rather than quietly finding nothing (DOR-1563)
- Anything read that way respects exactly the same limits as the DorkOS app. If your DorkOS asks people to sign in, the plugin works out who owns it from the database rather than assuming it is you (DOR-1563)
- The desktop app now shows a notification when an agent proposes a scheduled task, or asks to do something it cannot undo — like deleting a schedule. Both used to show nothing at all on the desktop: the only sign was a quiet count on the bell, so you had to be looking at the right window to notice. Click the notification to open the thing you need to decide. (DOR-1570)
- When an agent asks to do something it cannot undo and nobody answers, DorkOS now reaches your phone after the same delay a proposed schedule uses — the "escalate to my phone after" setting under Notifications. Before this, that kind of request could sit for its full two hours with no signal outside the app. (DOR-1570)
- You can now search what was said from inside Obsidian. ⌘⇧F opens the same box as the DorkOS app, over the same history, showing you the same things — and ⌘K offers the way in, the same as it does in a browser (DOR-1563)
- It appears only where there is something to search. On a machine where DorkOS has never run, or in an Obsidian this build of the plugin has no database engine for, the box and the ⌘K row are simply not there — rather than being there and finding nothing (DOR-1563)
- The box tells you the one way it differs there: in Obsidian it shows what the DorkOS app has already indexed, so anything said while only Obsidian was open turns up once you have opened the app. Your channels and direct messages are current either way (DOR-1563)
- Scheduled tasks can now pick up where they left off. Flip on the new **Sticky** toggle when you create or edit a task, and every run resumes the same conversation instead of starting cold — so your agent can say things like "since I last ran, here's what changed." It keeps working across restarts, not just back-to-back runs. Leave it off (the default) and each run stays its own fresh, isolated session, exactly as before. Every run still shows up in the task's history, and opening one takes you to that conversation with everything from the runs before it. If a run is still going when the next one is due, that next run is skipped rather than talking over itself. (DOR-1571)
- If you build or run a custom memory backend behind DorkOS's memory provider seam, DorkOS now tells you when it stops using yours — instead of quietly falling back to its own local notes and only saying so once in the server log. A banner in the app names the backend and says why, and `GET /api/system/memory` reports the same thing for anyone scripting against it. This only matters if you've registered a backend of your own; a stock DorkOS install always uses its built-in memory (DOR-1560)
- When that fallback already has notes on it and DorkOS injects them into a turn, the affected agent is now told those notes come from a different local store, not its usual memory, so it does not assume anything missing was never saved. This does not cover every fallback yet — the more common case, an agent's very first turn on the fallback, stays silent for now (DOR-1560)
- Click a search result from a channel or direct message and you land on that message, not just somewhere in the conversation. It scrolls to it and marks it for a moment, so you can see straight away which line answered you — and the address in your bar points at it too, so a refresh or a link you paste to somebody lands in the same place (DOR-687)
- Search again without leaving, and the conversation moves to the new message. Picking a second result in the room you are already reading takes you there, the same as the first one did (DOR-687)
- Pick a result that was said inside a thread and the thread opens with that reply on screen, rather than leaving you on the collapsed "3 replies" line (DOR-687)
- If the message is not among the ones the conversation currently has open, DorkOS says so in one quiet line instead of dropping you at the bottom and letting you wonder. Everything said there is still there (DOR-687)
- Results from your Claude Code, Codex and OpenCode chats still open the conversation rather than the exact line. The numbering search keeps for those chats counts only what was **said**, so it does not line up with everything the chat shows — and landing on the wrong line would be worse than landing in the right chat. That one is still to come (DOR-687)

### Changed

- Skill files now take one set of options, everywhere. The settings that used to work only at the top of a command file work at the top of any skill: a hint for its arguments, a model, an effort level, and running it in a forked helper. DorkOS also reads the rest of Claude Code's options now, including which tools to keep away from a skill, which files it applies to, and which shell runs its inline commands. A skill you wrote for Claude Code needs no changes to be read correctly here (DOR-1484)
- Task run history is now trimmed every hour rather than only when DorkOS restarts, and the history is indexed for the way it is read. A task that runs every minute was adding about 43,000 rows a month to a server that stays up, and every one of them was scanned each time you opened the runs list (DOR-1482)
- A package can never switch its own scheduled task on. Whatever the package asks for, the task waits for you to approve it before it runs for the first time, and a package cannot give itself permission to work unsupervised. (DOR-1487)
- A package will not overwrite a skill of yours. When one tries to create a scheduled task where you already keep something — a skill, a draft, notes, anything at all — DorkOS keeps what is yours and tells you, rather than replacing it. (DOR-1487)
- If you change when a packaged scheduled task runs, or what it is allowed to do, updating that package puts its own settings back — and now says so, naming the task, instead of letting your change disappear quietly. (DOR-1487)
- Rooms, Connections and the Slack adapter are no longer labelled earlier than they are. Rooms in particular is the screen DorkOS opens on, so calling it experimental had stopped being true (DOR-1516)
- Every comparison page got shorter and plainer. The verdicts are a few sentences instead of a paragraph, the questions and answers are trimmed to the ones people ask, and the pages stop explaining themselves with metaphors (DOR-1516)
- Comparison pages used to open by telling you that searching the other way round lands on the same page, which is a fact about search engines rather than anything you wanted to know. They now open with a sentence about the two tools (DOR-1516)
- Two ownership changes we had wrong: Cursor is owned by SpaceX, which bought Anysphere in August 2026, and Grok Bot is made by SpaceXAI. That also means the two share an owner, so Grok Bot coming with some Cursor plans is one company bundling its own product. Both pages now say so (DOR-1516)
- The pages are clearer that these agents are not only for code. They write the code, and they also send the email, plan the week and book the call (DOR-1516)
- We stopped calling DorkOS "mission control" or a "cockpit". It is simpler than that: one place for every agent you run. The website, the docs, the app and the install instructions all say it the same way now (DOR-1517)
- The feature page for running Claude Code, Codex and OpenCode together moved from `/features/multi-runtime-cockpit` to `/features/every-agent-one-place`. The old address still works and sends you to the new one, so any link you saved or shared is safe (DOR-1517)
- The scheduler now calls its work **scheduled tasks**, and **Schedules** where a label has no room. The word "task" was doing two jobs: the thing you put on a timer, and the to-do list an agent keeps while it works on your message. Now only one of them is called a task, and the tab, the page, the dialogs, the command palette and the activity feed all say the same word (DOR-1490)
- The guide is rewritten around what actually changed underneath: any skill becomes a scheduled task when you add a few lines of timing to it, and DorkOS finds it wherever your skills live. It covers where DorkOS looks, why nothing runs until you approve it, what happens to schedules you already had, and the one gotcha worth knowing before you flag a skill as "do not pick this up on your own" (DOR-1490)
- The `/flow` guides now show the new format and the one step that turns it on: approve `flow-drain` on the Schedules page. Approving is what arms and enables it together — no file edit required first (DOR-1490)
- Your scheduled tasks live with your skills now. The first time you start this version, DorkOS moves every one of them out of its old folder and into `~/.dork/skills/` (or your project's `.agents/skills/`), and rewrites the settings at the top of each file into a `schedule:` block. Nothing to do, nothing to click — and the ones you had already approved stay approved and keep running (DOR-1486)
- New scheduled tasks land in the same place, in the same shape, whether you make one in the app, an agent proposes one, or a Shape sets one up for you. There is one kind of file now: a skill, which may or may not have a schedule on it (DOR-1486)
- A schedule that a Shape sets up now waits for you before it runs, the same as one DorkOS finds in a file. Applying a Shape means you want the arrangement; saying yes to a job that runs on its own is a separate answer (DOR-1486)
- Text somebody pastes into a room is neutralised a little more thoroughly
  before an agent reads it. DorkOS already wraps other people's messages in a
  marked-off block so an agent treats them as words rather than instructions,
  and a handful of DorkOS's own internal markers could previously survive inside
  that block. They no longer can. Nothing you type looks different and the same
  words reach the agent — they just cannot pretend to be part of DorkOS's own
  instructions any more (DOR-632)
- A note that quotes somebody else stays a quote. Every note records the
  conversation it was written in, and that stamp is written by DorkOS rather
  than by the agent — so a note saved in a busy channel cannot come back later
  claiming to be something you asked for. Only what you say in a direct chat
  sets your agent's standing preferences (DOR-632)
- Anything said in a room can be found straight away, instead of after the next few-minute catch-up. Claude Code chats still take up to five minutes to show up, because DorkOS has to notice the file changed rather than being told (DOR-684)
- The Slack connection now runs on the latest Slack toolkit (Bolt 5 and Web API 8). Setting up and using Slack is unchanged (DOR-1528)
- DorkOS now runs one version of the library it uses to check that data has the right shape, instead of two. Three parts of the app — marketplace packages, skills, and the harness that projects them into your agents — were a major version behind, so every place those parts met the rest of the app needed a hand-written translation kept in step by hand. One less way for a package or a skill to be read differently depending on which door it came in through. (DOR-1527)
- The app loads a little less code. The marketplace screens and the rest of the app each pulled in their own copy of that library, so both were shipped to your browser; now there is one. (DOR-1527)
- A few messages about a broken `schedule:` block in a skill file are worded differently, because the wording comes from that library. A cron that should be text but is a number now reads "Invalid input: expected string, received number" where it used to say "Expected string, received number". Same problem, same field named — just the tail of the sentence. (DOR-1527)
- "Preview what your agent will see", on the profile, now shows the agent's
  saved notes as well — in the same place, and inside the same wrapper, a real
  turn puts them in. The preview is the whole prompt again rather than a tidied
  version of it (DOR-632)
- The terminal built into DorkOS moved up to a new major version of the library that draws it. Scrolling back through what a command printed now uses the same scrollbar Visual Studio Code uses, and the terminal itself loads faster — the library shrank by about a third. Everything you do with it is unchanged: open a shell, type, scroll, keep several tabs side by side (DOR-1529)
- We updated two of the libraries the app is built on to their latest major versions: the calendar component and the pinch-to-zoom, wheel-zoom, and drag-to-pan controls on canvas images. Nothing changes for you — both still look and work the same (DOR-1531)
- The A2A gateway now speaks version 1.0 of the Agent-to-Agent protocol, and still accepts the version 0.3 calls it accepted before. Outside agents written against either version can reach your agents, and each request is answered in the version it was asked in. Agent Cards say so directly: they list your endpoint under both versions. Your stored A2A tasks carry over as they are — there is nothing to convert. (DOR-1530)
- Agent Cards are laid out the way version 1.0 describes: the single `url` and `preferredTransport` fields became a `supportedInterfaces` list, and `security` became `securityRequirements`. If you read cards from DorkOS with your own code rather than an A2A client library, this is the one change to look at. (DOR-1530)
- A version 0.3 caller that sends a message without saying `blocking: true` now gets the task back right away instead of waiting for the answer. That is what version 0.3 always said should happen, and DorkOS now follows it. If a call that used to wait no longer does, add `"configuration": { "blocking": true }` and it waits again. (DOR-1530)
- Slack works through a corporate proxy. Set `HTTP_PROXY` or `HTTPS_PROXY` the way you always have, and DorkOS picks it up (DOR-1542)
- Listing tasks over A2A stays fast as tasks pile up. DorkOS used to read every task it had
  ever stored to hand back a single page of fifty; it now reads only the page you asked for.
  (DOR-1548)
- We updated the library behind the app's menus, dialogs, dropdowns, switches, tabs and slide-up panels. It had been held back because we thought the update would make the bottom sheet snap shut instead of sliding away — it doesn't. Nothing changes for you (DOR-1539)
- The comparison pages at dorkos.ai/compare stopped hedging about DorkOS. They used to describe DeepSeek Harness as the closest thing to what DorkOS "is trying to be", which reads like a product that has not decided what it is yet. DorkOS is something. The pages now say so, and every other soft phrase about our own product went with it (DOR-1557)
- Every verdict, answer and explanation on those pages got shorter again. Nothing was dropped: the facts, the credit we give other tools, and the places we say they beat us are all still there, in fewer words (DOR-1557)
- "Which one is for you" now opens with the reasons to pick DorkOS, instead of reaching them after a panel about the other tool. It reads that way on a phone and on a desktop, and the DorkOS ticks are green so the two lists are easy to tell apart at a glance (DOR-1557)
- An agent that proposes a schedule, or asks to delete one, is now told to say so in its reply instead of quietly stopping. It used to report the task as created and end the turn, leaving you to discover the approval on your own. In a DorkOS session it can also offer to open the Schedules panel for you. (DOR-1570)

### Removed

- The "Timezone" setting under Tasks is gone. Every schedule already carries its own timezone, so this one never had any effect — changing it did nothing at all. Set the timezone on the schedule itself, as you always have (DOR-1482)

### Fixed

- Clearing a scheduled task's time limit, display name, timezone, or cron no longer breaks the task's file. DorkOS used to write the cleared field as the word `null`, which it could not read back — after that the task stopped syncing, and every later edit to it quietly failed to save. (DOR-1481)
- Editing a task that runs only on demand now works. Saving one from the task form cleared its cron, which the database refused, so the edit failed — after the file on disk had already been rewritten, letting the half-finished edit apply itself seconds later. (DOR-1481)
- When DorkOS cannot save a task's file — the disk is full, or the file is read-only — editing the task now fails with a message naming the file it could not write. It used to report success, then put the old values back a few minutes later with nothing to explain why. (DOR-1481)
- A task whose file DorkOS cannot read or make sense of now says so when you edit it, and names the file to open. Editing one used to quietly succeed while the file stayed broken, so a damaged task had no visible symptom at all. (DOR-1481)
- A time limit DorkOS cannot read, like `10 minutes`, is now refused when you edit a task, exactly as it already was when you create one — through the task form, the API, and the `tasks_update` tool an agent uses. It used to be accepted and then removed the task's time limit altogether. Write it as `10m`. (DOR-1481)
- Canceling a task from another AI tool now actually stops the agent. Before, DorkOS
  replied "canceled" and the agent kept working — and kept costing you money — until it
  finished on its own. The cancel is now passed to whoever is running the turn, and you
  are only told it stopped when something confirms it did. If nothing can be stopped,
  you get an error saying so instead of a comfortable lie (DOR-791).
- When an outside tool waits two minutes for an answer and gives up, DorkOS now asks the
  agent to stop too, and writes to the server log whether that worked (DOR-791).
- The comparison tables now work on a phone. Each point becomes its own block, with both answers stacked underneath and labelled, so every word fits on screen and there is nothing to scroll sideways. Before, most of the second column sat off the edge of the screen with nothing to hint at it. On a tablet or a computer it stays a table, with the row label pinned as you scroll across and the edge fading to show there is more to see (DOR-1465)
- Small grey text on the comparison pages is darker, so table headings, links and labels are easier to read and meet accessibility contrast standards (DOR-1465)
- Links like "More on this" and "Back to the table" now land where they should. They used to jump to a spot hidden behind the top bar (DOR-1465)
- The Cursor comparison now says that Cursor has a phone app, a web dashboard and a Slack integration, which it gained since the page was written. You can also reach the comparison pages from the site footer (DOR-1465)
- Long web addresses in the "how we checked" list now wrap onto the next line. On a narrow phone one of them used to stretch the whole page sideways (DOR-1465)
- The Codex page no longer says its source code is simply open. Only the command-line tool is: the cloud service, the apps and the models are not, and the page says so (DOR-1465)
- A skill that lists its pre-approved tools the way Claude Code allows, as a YAML list instead of one line, no longer goes missing. Before, that one detail stopped the whole skill from loading (DOR-1484)
- One option DorkOS does not recognize can no longer hide a skill. A line like `shell: zsh` is skipped over now, and the skill keeps working everywhere else (DOR-1484)
- Starting a second copy of DorkOS no longer marks the tasks another copy is running as failed. Booting the app while a dev server or the desktop app was mid-task used to end those runs in the record, throw away what they actually did, and send you a "task failed" notification for work that was going perfectly fine. Now only the copy in charge of the schedule ends a run, and only when it can show nobody is still working on it (DOR-1482)
- The limit on how many tasks run at once now counts every task, however it was started. With the message bus on, that limit counted nothing, so a slow task on a short schedule could pile up as many runs at once as the schedule allowed — and the "running now" count read zero the whole time (DOR-1482)
- An agent changing a task's schedule now changes when it actually runs. Editing a schedule through an agent used to update what the screen showed while the old schedule kept firing, and deleting one left it running against a task that no longer existed — in both cases until you restarted DorkOS (DOR-1493)
- A task that came round while DorkOS was starting up can no longer lose its turn without a trace: the record of a run and the note that its turn was taken are now written together, so a crash mid-way leaves the turn free for next time (DOR-1482)
- A comparison page for a shut-down product no longer invites you to "see it for yourself", which led to a stub page or a read-only repository. Those pages now offer to show you what is left of it instead (DOR-1468)
- The banner on a shut-down product's page used to promise that the details came from the company's own announcement, linked at the bottom. That is not always true: a company's website tends to go down with the company. The banner now says what the page covers, and the sources list says where we actually looked (DOR-1468)
- The light gray text on dorkos.ai is darker now, so it is easier to read. It is the color used for the small print all over the site: breadcrumbs, table column headers, card labels, captions, and the source lists under the comparison tables. Against the site's cream background it was too faint to meet the accessibility standard for readable text, and most of it is only nine to twelve pixels tall, which is exactly the text you can least afford to squint at (DOR-1503)
- The credit lines on the story page were the opposite problem. That page is dark, and the same gray was being used on it, which made it fainter still. Those lines now use the warm cream the footer already uses on dark backgrounds, so they are comfortably readable too (DOR-1503)
- The floating menu no longer sits on top of what you are reading. As you scroll down a long page it steps out of the way, and it comes back the moment you scroll up, reach the top, or arrive at the end. Before this, it could cover a link and swallow the click (DOR-1504)
- The menu fits on a phone screen again now that it holds six words. On the narrowest screens it drops "home", which the logo at the top already does (DOR-1504)
- If you are moving through the menu with the keyboard, it now waits for you. It used to slide away mid-tab and drop you back at the start of the page (DOR-1504)
- Installing a package with a broken schedule now fails immediately, naming the package's schedule and what is wrong with it. It used to install fine and then turn up later as a task that could never run, with nothing to explain why. (DOR-1487)
- We were quietly claiming that scheduled work happens "while you are asleep or away". DorkOS runs on your own computer, so it needs that computer awake. The pages now say a job starts at a set time without you pressing anything, which is the true version (DOR-1516)
- A plugin you install into a project can now offer you its scheduled tasks, whichever coding agents that project uses. Before this, a plugin that shipped a scheduled task was only set up for Claude Code on a normal project, and DorkOS does not look for schedules there — so the job sat on your machine and was never offered to you. Now a project plugin's scheduled tasks are put where DorkOS looks, and it asks whether you want each one to run. Plugins installed for your whole machine, rather than into one project, still cannot offer schedules this way (DOR-1518)
- `dorkos harness sync` now explains the set-up steps that need explaining. A line used to say only what was linked and where, which reads as arbitrary when the folder belongs to a coding agent you do not use. Each such line now says why it is there (DOR-1518)
- If two things wanted the same name — a task called `digest` and a skill called `digest` — the skill keeps its name and the task moves in beside it as `digest-migrated`, and shows up waiting for you so you can see what happened. Nothing is overwritten (DOR-1486)
- A task file DorkOS cannot read is left exactly where it is, and appears on your Schedules page with the file's path and what is wrong with it, instead of being quietly left behind in a folder nothing looks at any more (DOR-1486)
- A Shape can no longer write its schedule over a skill you wrote yourself that happens to have the same name. Your file stays exactly as it is, and applying the Shape tells you which schedule it skipped and why, instead of reporting one it never made (DOR-1486)
- Your task templates keep their timing when they move. Before, a template that had moved offered no schedule at all when you picked it (DOR-1486)
- An agent you add while DorkOS is running brings its scheduled tasks with it straight away, instead of waiting for the next restart (DOR-1486)
- If one place DorkOS reads from cannot be read, search still answers with everything else and tells you one of its sources is behind — rather than failing the whole request or quietly returning a short list (DOR-684)
- Sending a message can never fail because the search copy could not be updated. The room keeps your message either way, and the next catch-up adds it to search (DOR-684)
- Searching one room is fast again. Looking inside a single room was taking seconds where searching everything took milliseconds — the database was reading the room the long way round. Agents reading their own room history were on that same slow path (DOR-684)
- A very short search is turned down properly now. Typing a single letter with a comma after it looked long enough to run, and it was the slowest kind of search there is (DOR-684)
- Posting into a room the search copy has never seen no longer waits while the whole room is copied. That catch-up happens in the background instead (DOR-684)
- When your Slack token stops working — you removed the app, the token was revoked, or it never had the right permissions — the Slack connection now stops and tells you which problem it hit. It used to miss that the failure was permanent and keep retrying forever against a token that was never going to work again, so the connection sat there looking busy while every message quietly went nowhere. It also now shuts down cleanly, instead of leaving background timers running against the dead connection (DOR-1528)
- Asking the A2A gateway to wait for an answer now really waits. It used to reply the moment it handed your message to the agent, so a caller that asked for the finished result could get a task still marked `working` and never see the answer arrive. (DOR-1530)
- Agent Cards now go out in the format the protocol specifies. A few fields were being sent in DorkOS's own internal shape instead — the bearer-token security scheme in particular — which a strict A2A client could refuse to read. (DOR-1530)
- OpenCode sessions you started in a subfolder now show up under the project they belong to. If you ran `opencode` in something like `my-app/packages/api`, that conversation was missing from `my-app` — and from every other project too, so there was nowhere to find it. It now appears everywhere a project's sessions are listed: the sidebar switcher, the agent's Sessions page, the command palette, the embedded sidebar, and the Recent list. Each session still shows the folder it is actually running in. Claude Code sessions in subfolders have the same blind spot in their own listing; that fix is tracked separately. (DOR-674)
- An OpenCode agent that was working in a subfolder no longer looks idle. Its last-active time and its daily run counts skipped those sessions. (DOR-674)
- Canceling a task from another app no longer loses the agent's reply. If the agent finished
  answering while the cancel was still on its way, DorkOS threw the answer away, told you the
  task could not be canceled, and left it stuck part-way — with no way to ask for the answer
  again. It now keeps the reply and finishes the task. (DOR-1547)
- Asking one agent for its tasks now gets you that agent's tasks. A request to
  `/a2a/agents/{agent}` listed every agent's tasks instead, complete with their message
  history — and looking one up by its id from that endpoint worked too, whoever it belonged
  to. Both now answer for the agent in the address, and anything else reads as not found. Ask
  the fleet endpoint `/a2a` when you want the whole list. (DOR-1546)
- A handful of small timing bugs on the website: the account-activation page no longer flashes an empty form for a split second while it checks your code, and pages that adapt to phone screens now get it right on the very first frame instead of correcting themselves after (DOR-1541)
- The DorkOS plugin for Obsidian builds a bundle that can actually start. Two things in it were broken before the plugin got as far as loading: a patch the build applies missed some of the code it was meant to cover once the bundle was minified, and the database library worked out a file path the moment it was loaded rather than when it was needed. Both are fixed, and the build now stops with a message naming what it missed instead of quietly producing a plugin that throws on startup (DOR-1563)
- Scheduled tasks no longer bury you in "could not be delivered" notifications. Every scheduled run was talking to itself: each thing the agent said got sent back to DorkOS as if it were a brand new job, failed to make sense, and turned into a failure notice. One run produced 279 of them. Runs now send that stream nowhere, because nothing was ever reading it. (DOR-1567)
- A scheduled task is now told it is a scheduled task. When the message bus was on — which it is by default — the agent started with none of the usual briefing: what job this is, what schedule woke it, and that nobody is around to answer questions. So it would stop and ask. Both ways of starting a run now hand over the same briefing. (DOR-1567)
- A scheduled run that stops to ask permission now gives up after ten minutes instead of waiting four hours. It already worked that way on one of the two paths a run can take; now it works on both, so a single unanswered prompt can no longer hold a run open for the rest of the day. (DOR-1567)
- A scheduled run that fails is now clickable in the run history, so you can open the transcript and read what went wrong. Finished and cancelled runs already linked to theirs; the failed ones — the runs you actually want to read — did not. (DOR-1567)
- A task an agent schedules for you is now a real task. It used to make a task with no file behind it and no owner, so nothing kept it in step with your project and its runs happened in the wrong folder. The agent is now asked where the task belongs — under itself, or in your DorkOS folder — and the task is written there like any other. (DOR-1568)
- An agent that asks to schedule a task for an agent DorkOS has never heard of is now told so, instead of quietly making a task nobody owns. (DOR-1568)
- A time limit an agent sets when it schedules a task is now kept. The tool accepted the setting and then threw it away, so the task ran with no limit at all. (DOR-1568)
- Deleting a task through an agent now deletes it. Only the entry was removed, so the task came back on its own a few minutes later, after the agent had already said it was gone. (DOR-1568)
- Editing a task now refuses a field it cannot change, and says which one. Anything DorkOS did not recognise was thrown away and the edit reported as a success — which is how an agent came to believe it had filed a task under itself when nothing had happened. Where a task lives is decided when it is created; to move one, delete it and create it again. (DOR-1568)
- When you tell your agent a standing rule in a one-to-one chat — "we deploy on Tuesdays, never Fridays" — it now writes that down before the turn ends, so a later conversation in a channel knows it. Some models used to answer "got it" and save nothing, and the next conversation had no idea. (DOR-1564)
- Search keeps filling even when one of the places it reads breaks. If DorkOS could no longer read a folder or a program's history — the files moved, or it lost permission to open them — everything from that one place quietly stopped being added to search, and nothing told you. Now your search results say that part of your history could not be read, nothing already found is thrown away, and every other place carries on being added. (DOR-709)
- The app stays responsive while search catches up. Adding to the index used to hold up everything else until it finished, which is most noticeable the first time you run DorkOS, when there is a whole history to get through. It now works in small pieces and gives the app a turn between each one, so it fills in the background instead of in your way. (DOR-702)

### Security

- Only a person can run a scheduled task on demand. An agent could ask DorkOS to run a task right now — including one that was parked, waiting for you to approve it — which walked straight around the approval. You can still run a proposed task once from its approval card to see what it does. (DOR-1481)
- Searching your own machine reaches **every** room on it, including rooms your agents opened between themselves and never invited you to. That is deliberate — it is your install, and search is how you find something you half-remember — but it is worth knowing, because it is more than the room list shows you (DOR-684)
- Your own chats with agents stay yours. An agent searching gets only the rooms it is actually in, and only from the point it joined — never what was said in a room before it arrived, and never anything from your Claude Code sessions (DOR-684)
- Asking about something you are not allowed to see gets exactly the same answer as asking about something nobody ever said, so a search can never be used to find out that a private room exists (DOR-684)
- We updated the libraries DorkOS is built on and closed almost every open security warning: 109 of them before, 6 after. Nothing you do changes — this is the plumbing underneath. Among the ones now fixed: a flaw that let a web page read files the dev server was told to keep private, a flaw in the desktop installer's archive handling, and a bug that could leak the credentials used to publish a release (DOR-1526)
- The six that remain are in Electron, which the desktop app is built on, and in one archive-unpacking helper that has no fix published yet. Both are held for a separate update so they can be tested on their own (DOR-1526)
- With Require login turned on, only a person signed in to DorkOS can approve a scheduled task, turn off its safety prompts, or start one running. Before, anything holding one of your personal API keys counted as you for these — so a program on your machine could set up a task that runs on its own, at full power, without you ever seeing it. Approving a task now needs a real sign-in, the same bar DorkOS already uses for its other sensitive actions. Setting up tasks from the `dorkos` command line still works; a task it creates now waits for you to approve it in the app. (DOR-1569)

## [0.64.0] - 2026-08-24

### Added

- An agent can now be told which Claude account to bill. Open its profile, click **Runs on**, and pick an account — the same way you pick its model. The row shows where the setting came from: green when the agent simply follows your default, amber when you chose something else here, and one tap on that chip puts it back. The row only appears where the choice is real: on Claude Code, and only once this machine knows of more than one account.
- Settings → Runtimes now lists agents that bill somewhere other than your default, alongside the ones that run on a different runtime or model. If an agent points at an account that isn't registered on this machine, it is listed in amber with a warning — it quietly bills to your default until you fix it — and clicking the row opens that agent so you can.
- An agent pointing at an account that isn't registered also turns up under **Needs attention** in the sidebar, the same as one pointing at a runtime you haven't connected. You find out where you happen to be looking, rather than only when you open Settings.
- If DorkOS can't read your account list at all, it now says so instead of quietly acting as though you have no accounts — so a temporary hiccup no longer paints every agent amber.
- You can now bill one chat to a different Claude account without changing anything else. Before you send the first message, open the runtime chip in the status bar and pick an account — it applies to that chat and nothing after it. The menu says so: "This session only. Locked once the first message sends." Picking an account here only affects this chat — the account every new chat starts on lives separately, in Settings → Runtimes → Claude Code as **Default account**.
- The menu also names what "Default" would actually charge, so leaving it alone is still a choice you can see. If the agent working in that folder is set to bill a particular account, that is the one it names — not whatever your machine falls back to otherwise.
- Scheduled tasks now start at **your** power level. Create a task without picking one and it runs at whatever you chose for new chats, worked out for the agent that will run it. If you never chose a level, nothing changes — a task starts where scheduled runs have always started, able to edit files and stopping for anything riskier. Picking a level on the task itself still wins, an agent still cannot choose one for you, and a task file on disk still cannot hand itself the never-ask level.
- `dorkos task create` now says so when the task it just made will run without ever stopping to ask, so a schedule armed from your default power level is never a surprise.
- Set different reply limits for one room, or take its limits off entirely. Each room can now carry its own version of the four automatic-reply settings — how many replies in a row agents may trade, how many of those any one agent may send, how many replies the room may run in an hour, and whether it is limited at all. A room you have not touched follows Settings, and clearing a room's setting puts it straight back to that. One thing a room cannot switch off is the hourly limit across all of DorkOS: a room can opt out of its own limits, not out of your bill. These are yours alone to change — nobody else in a room can lift a limit and leave you with the bill (DOR-1429)
- Choose how much agents may say to each other, in Settings → Rooms. Four numbers decide how far a conversation between agents can run before the room steps in: how many replies they may trade in a row, how many of those any one agent may send, how many replies a single room may run in an hour, and how many all your rooms may run in an hour together. Each field says what it is by default, and your own message always starts the counts over. Until now the only way to change any of this was editing a file by hand (DOR-1430)
- Turn the limits off, when you want to watch two agents work something out. One switch at the top of the panel does it, and it says plainly what happens: agents can reply to each other without limit, and the Stop button is the only brake. Your numbers are kept while it is off, so turning it back on restores exactly what you had (DOR-1430)
- Set limits for one room, from the panel beside it. A room can follow your settings, keep its limits when you have turned yours off, or run without limits of its own. Each number shows the default it would use, so an untouched room still tells you what bounds it, and clearing a number puts the room straight back to following Settings. Only the person who owns this DorkOS can change a room's limits, and anyone else is told so plainly (DOR-1430)
- A **Control Center** to see and change your agents' power at a glance. Tap the ⚡ in the top bar (or press ⌘⇧L, or search "Control Center") and one panel opens: how much new sessions may do before they ask, whether your agents can talk across projects, whether "stop asking about this" sticks, whether agents stay warm between messages, and how many scheduled tasks run at once. Setting where new sessions start applies to new sessions — conversations already running keep what they have.
- The Control Center's **Exceptions** list shows anything that runs at a different power than your dial: a runtime with its own default, a live session, a task, or an integration. Each line takes you straight to where you can change it. A tidy setup shows a calm "everything follows your dial" instead.
- The first time you open DorkOS after this update, it asks one plain question: run at full power, or keep being asked first? Choose full power in one click, or keep being asked — your call, and it sticks. Unlocking turns it all on at once — agents act without stopping to ask, they message each other across every project, and scheduled runs get the same freedom. Prefer to stay hands-on? "Keep asking me first" changes nothing, and the question never comes back. There's also a "Customize…" link if you'd rather set the pieces yourself in the Control Center. If opening up your agents to talk doesn't finish, DorkOS tells you plainly and leaves everything else on — nothing is turned on behind your back, and nothing you chose is quietly undone.
- **Limit automatic replies** is now a switch in the Control Center (DOR-1446). Tap the ⚡ in the top bar and it sits with the other power switches, so letting your agents talk freely — or reining them back in — is one click instead of a trip through Settings. Turned off, it tells you plainly what that means: agents can reply to each other without limit, and the Stop button is the only brake. The numbers behind it still live in Settings → Rooms.
- Setting up DorkOS for the first time now includes a step to choose your power level. Right after the readiness check, and before you meet DorkBot, you get the same plain question everyone else does: run at full power in one click, or keep being asked first. Pick either and setup moves on; not ready to decide? Choose "Decide later" and DorkOS asks again once you're settled in. Nobody is opted into anything without answering, and the choice is a normal part of getting started rather than a surprise later.
- Installing the Mac app now shows you the two steps that let it update itself later: drag it into Applications, then open it from there (DOR-1458)

### Changed

- Agents in a room can now hold a real conversation. Each agent may answer up to ten times in one back-and-forth instead of once, chains may run thirty replies deep instead of three, and the hourly ceilings on automatic replies are much higher — 1,000 per room and 5,000 across DorkOS. Your own message still starts every count over, and the room still says so when it stops an exchange. Existing installs get the new numbers too, unless you had already changed them: a number you set yourself is left exactly where you put it (DOR-1428)
- New setting `rooms.turnLimitsEnabled`. Turn it off and agents may answer each other with no limit at all — no reply ceiling, no hourly cap. The Stop button becomes the only thing that ends a conversation, and every turn of it costs money, so it is meant for watching two agents work something out rather than for leaving on. It ships on, and turning it off and back on restores the numbers you had (DOR-1428)
- Setting an agent to full autonomy now reads green everywhere it shows up — the dial, the word in the status line, the mark beside a chat in an agent's Sessions list, the Settings note, the confirmation dialogs. It used to read red, which told you off for choosing the thing DorkOS is for. That green meets WCAG AA contrast in light mode; dark mode is unchanged.
- Red is now saved for real problems. Nothing about a permission setting you chose on purpose is painted in the colour that means "something is wrong", so when you do see red, it means something.
- **Ask first** now shows a small padlock instead of a shield, because it is the setting that holds the agent back. It stays plain and uncoloured — nothing shames the careful choice.
- The banner about integrations and scheduled tasks running unattended is now a plain note rather than a warning. It reads "Running unattended at full power:" and names them, and it still cannot be dismissed while it is true, with the same links to Integrations and Tasks.
- The Settings note under **Where new conversations stop for you** now says "New sessions run at full power" instead of "New sessions run without asking", and still offers **change** to put it back.
- Open an agent and go to **Sessions**: a chat running at full power is marked with a green lightning bolt instead of a red crossed-out shield, and hovering the bolt reads "This chat runs any command without asking". Expanding that chat's details shows a green **Permissions** line to match, so the mark and the words never disagree. The DorkOS sidebar in Obsidian gets the same green bolt.
- The telemetry question is now a one-time pop-up you answer and are done with, instead of a bar that sat across the top of the app until you got round to it. Nothing about the question or your answer changed — DorkOS still sends nothing unless you say yes, and "See what's sent" still shows the exact payload (DOR-1431). If DorkOS can't save your answer, it tells you and leaves the choice on screen so you can try again, instead of quietly losing it.
- DorkOS asks you at most one of these one-time questions per launch, and never while first-time setup is still on screen. Anything else it wants to ask waits for a later launch (DOR-1431)
- It won't ask again about something you already settled somewhere else — in another window, with `dorkos telemetry`, or by editing your config by hand (DOR-1431)
- **New setups keep their agents warm between messages.** A Claude Code chat holds its agent open instead of starting a new one for every message, so replies from your second message on come back about four times faster. Existing setups follow automatically in an upcoming update. This used to be an experiment you had to find and switch on; it is now simply how DorkOS works. The cost is memory — up to about a gigabyte per waiting agent, twelve at most, and an agent you have not used in five minutes shuts itself down. Nothing about what your agents may DO changes: the same program runs with the same permissions, and every action is checked exactly as before. **Two things worth knowing.** If you had deliberately turned this off, the update turns it back on — DorkOS cannot tell an off you chose from the off it shipped with, because the two look identical on disk. And while the setting waits for its switch in the app, the way to change it is `runtimes.claudeCode.persistentSession` in `~/.dork/config.json` (`dorkos config set` works too); a switch for it is coming.
- **Four scheduled runs at once, on new setups, instead of one.** A slow overnight task no longer holds up every schedule queued behind it. Existing setups follow automatically in an upcoming update, and the same caveat applies: if you had set it to one on purpose, the update raises it to four, because a one you chose and the one that shipped are the same number on disk. Anything from one to ten still works — it is `scheduler.maxConcurrentRuns`, in Settings under Tools.
- New scheduled tasks and new integrations now start at **your own power level** instead of always "accept edits." If you set your default to full power, you no longer re-pick it every time; if you kept "ask first," nothing is quietly turned up. You still confirm once when you point one at full power, since no one is watching it run.
- When an agent is set to **ask first**, its permission popover now shows a quiet "Limited — unlock" pointing at the Control Center, so opening things up is one step away. It is a gentle nudge, never a warning — asking first is a fine choice.
- An agent's progress notes no longer eat its reply allowance (DOR-1434). "How many replies from one agent" now counts **turns**: if an agent says "looking at the migration" and "found it" before it answers, that is one reply, not three. Agents that tell you what they're doing used to run out of room three times faster than agents that said nothing until the end, which was backwards. Messages posted before this change still count one each, so nothing about your existing rooms is re-scored.
- Clearer wording for full autonomy. It turns off the approval prompts — the cards that halt each action until you tap Allow — but your agents still ask when something genuinely needs your call, and still follow anything you have told them to check with you about. The old copy ("runs without asking") made it sound like full autonomy would ignore your instructions and never ask you anything, which was never true (DOR-1431)
- Saving a task now checks the schedule before anything else, so a schedule DorkOS cannot read is refused on the spot with a message naming what is wrong — instead of being accepted and then quietly never running. That covers times it cannot read and timezones it does not know. A schedule that simply never comes round is still allowed — that is how you write a task you only ever run by hand.
- Installing on a Mac now greets you with a proper DorkOS install window instead of a generic gray one. Open the download and you get a clean, near-white window with the DorkOS mark, the app icon on the left, your Applications folder on the right, and an arrow between them showing you exactly what to drag where (DOR-1457)

### Fixed

- With **Keep agents warm between messages** turned on (Settings → Experiments), the very first chat after starting DorkOS now gets its fast second reply too — it no longer quietly restarts its agent once.
- An agent that was still starting up when you pressed Stop can no longer talk over it. Its answer used to arrive anyway — once, a 7,000-character reply landed 23 seconds after the room said everything had been stopped. That message is now turned away instead of posted, and the next thing you say is answered normally (DOR-1313).
- If you turn on the experimental setting that keeps an agent warm between messages (`runtimes.claudeCode.persistentSession`, off by default), the answer to a note you add mid-turn now stays in the chat. Before, when you sent something while your agent was still working, the agent often answered it in a separate turn. That answer did not reach the chat until you reloaded the page. It now arrives in the turn you are watching (DOR-1314)
- Changing a chat's permission mode while its agent is finishing up no longer hangs. DorkOS now gives every behind-the-scenes request a deadline and tells you when one couldn't be delivered (DOR-1301)
- Sending a message to a chat whose settings changed no longer gets stuck waiting on the agent to confirm. The settings that went through are applied, the ones that didn't are left for the next message, and your message starts either way (DOR-1301)
- Reloading plugins after installing something from the Marketplace now finishes instead of waiting forever on an agent that has already stopped listening. If the agent doesn't confirm, you're told the reload may still have worked — instead of being told to send a message you already sent (DOR-1301)
- Asking DorkOS for a chat's messages now works without knowing the chat's folder — and when a chat truly can't be found, it says so instead of answering with an empty list.
- Pressing Stop now responds the moment you click — the button says it's stopping, and clicking again doesn't send the request twice. Before, a Stop that took a few seconds to take effect left the button looking untouched, so a second (or third) click fired off extra requests with nothing on screen to explain the wait.
- Context you add for an agent now survives a DorkOS restart. The note that says it was added is never left pointing at words that vanished — they are saved the moment you add them, and the agent gets them with your next message (DOR-1324).
- Cleaned up a false alarm in the server log: when an agent's background process was tidied up at the exact moment you added context, DorkOS logged it as a fault. It was normal, your words were kept, and it is no longer reported as a problem (DOR-1325).
- If DorkOS is force-quit while it is keeping agents warm, the next start now cleans up the agents the old one left running. They no longer sit in the background using memory. Closing DorkOS the normal way already shut those agents down. It was the abrupt endings that did not, like force-quitting the app, a crash, or a hard restart. That mattered, because a dozen warm agents can hold on to several gigabytes between them. DorkOS only ends a process when it can prove it started that exact process itself, so nothing else on your machine is touched (DOR-1310).
- Pressing Stop while OpenCode is stuck no longer strands the messages you had queued up. Before this fix, if OpenCode didn't answer a Stop request, your typed-but-unsent messages could stay stuck until OpenCode finished on its own, sometimes indefinitely. Now DorkOS waits about 3 seconds for OpenCode to respond, then gives up and returns your messages to the message box so you can send them again (DOR-1299).
- Pressing Stop while you were editing a queued message no longer pastes that message's text into the box twice.
- Pressing Stop right after rewriting a queued message now always keeps your rewrite, even if the save to the server hadn't finished yet.
- A question your agent asks now shows its real time-to-answer right away, instead of showing zero until the page refreshes.
- When `dorkos room export` loses its connection part-way, it no longer leaves a stray `.dorkos-export-…` folder next to the file you were saving. The export still stops and tells you it is not complete, and the copy you already had is still untouched — now the scratch folder goes away too
- Coming back from a thread after scrolling up now lands you exactly where you were. The list quietly measures older messages a moment after you stop scrolling, and it used to remember your place from just before that — so returning could leave you a message off. It now waits for the view to settle before it remembers.
- Clicking "Always Allow" on a file change now sticks. It used to stop the asking only until the chat restarted. After that the agent asked again, while the status line still read "Accept edits". Your chat now remembers the change you made, so the status line and the agent finally agree (DOR-1316)
- One click on one file can never turn the asking off for good. Moving a chat to full power still takes the confirmation step it always did (DOR-1316)
- Steer a task from a second window while it is running, and the chip no longer claims the task had already finished. It says what is actually true: something else is running this task, so your message is waiting in line (DOR-1315).
- Fixed the to-do list sometimes getting stuck showing old status or counts, even after refreshing. A task's progress update could miss the task it was meant for and quietly do nothing — or, rarer, land on the wrong task instead.
- When DorkOS restarts while an agent is waiting on you, the question it asked is now saved as unanswered instead of disappearing. Reopen the conversation and you can see it was asked, and that nobody got to answer. That agent's work stopped with the restart, so ask again to pick it back up (DOR-1439)
- Messages you queued and context you added for a chat that was deleted while DorkOS was closed are now cleared out the next time it starts, instead of sitting in your database forever. DorkOS only clears a chat it can confirm is gone — anything it cannot check is left exactly where it is (DOR-1436)
- When Stop cannot reach an agent, the log now says so instead of reporting a turn it never stopped. (DOR-1425)
- Stop now reaches an agent that is still starting up. Pressing Stop in the first moments of a turn used to stop nothing: the agent finished the whole answer anyway, and you paid for it. (DOR-1424)
- An agent you stopped no longer adds reactions to the conversation. It can react again the next time you give it a turn there. (DOR-1426)
- A question or form an agent is waiting on now keeps one deadline wherever you look at it. The time limit rides along with the prompt, so the countdown keeps ticking down instead of starting over whenever the card is redrawn (DOR-1442)
- Pressing Stop while you were editing a queued message no longer loses the message you had parked in the box, even if the message you were editing had already been sent by then (DOR-1442)
- Mac releases now include the delta data auto-updates need, so future updates download only what changed instead of the whole app (DOR-1449)
- Tell you when a stricter permission setting has not reached the reply that is already running. Turning approvals back on while an agent is mid-reply used to look like it took effect immediately, even when the running reply kept the looser setting it started with. The setting is still saved, and now the cockpit says plainly that it starts on your next message. Claude Code and Codex both report it (DOR-1435)
- The Mac app opens again. Version 0.63.0 could start to a black window that never loaded anything — the app was packaged with one piece of missing information, and it stopped before it could draw its first screen. Updating gets you a working app, and the build now refuses to package one with that fault in it (DOR-1448).
- If DorkOS can't save the panel it remembers between visits — some browsers block that, and so does the app in a few situations — it now starts fresh with a loading screen instead of showing you nothing at all.
- When DorkOS can't start its background server, the message it shows now points at the folder your logs are actually in.
- The "Stop, and put your queued messages back?" question now closes itself once those messages have all been sent, instead of sitting there asking about zero messages and blocking the message box (DOR-1443)
- That question also stays in the chat you asked it in. Switch to another chat while it is open and it no longer follows you there, where saying yes would have stopped the wrong agent (DOR-1443)
- Switching to a model that has no thinking-effort setting now clears the effort from the status line, so it stops showing a level you can no longer see or change (DOR-1445)
- Stopping an agent no longer leaves a red error behind. The agent shut down cleanly and your next message worked fine, but the chat still recorded the stop as something going wrong (DOR-1320)
- After an update, DorkOS now always loads the new interface. Before, your browser or the desktop app could hold on to a saved copy of the old one, which could leave you looking at a blank window until you cleared it by hand.
- Stopping an agent gives you the composer back sooner. A stopped turn used to spend up to eight more seconds asking the agent for its context and usage numbers after the work had already halted, so the screen looked live while nothing was happening. Those numbers now refresh on your next turn instead (DOR-1319)
- If DorkOS can't finish starting, you now see what went wrong instead of a black window. The page says it couldn't start, gives you a **Try again** button, and keeps the technical error under **Technical details** with a **Copy details** button — so you can send us the exact error rather than a screenshot of nothing. This works everywhere DorkOS opens: the desktop app, the cockpit you start from the command line, and a plain browser tab.
- Our docs and website said scheduled agents keep working after you close your laptop. That was not true. DorkOS runs on your own machine, so closing the laptop stops it. The copy now says what really happens: your agents run on a schedule without you at the keyboard, for as long as DorkOS is running. Want them running around the clock? Put DorkOS on a machine that stays on, like a desktop, a home server, or a cheap cloud box (DOR-1478)
- The checkmark on a completed step in a generated timeline is now visible. It used to disappear — a green icon on the same green background.
- The two lines you can put at the top of a skill to say who may run it now work everywhere, not just in Claude Code. `user-invocable: false` keeps a skill out of the slash menu, so background-knowledge skills stop crowding the list you pick from in Codex sessions. `disable-model-invocation: true` keeps a skill out of the listing your agents read, so an agent won't reach for a job you meant to start yourself — you can still hand it that skill by name. Both lines read the plain-English booleans people actually write — `no`, `off`, `yes` — and a value DorkOS cannot make sense of leaves the skill visible instead of hiding it (DOR-1489)
- Saving, deleting, or switching off a schedule no longer wipes the to-do list in an open chat. Any schedule change anywhere used to reset a working agent's checklist mid-answer.
- Run history stays accurate after you press "Load more". A run that finished while you were reading it used to keep spinning forever on the earlier pages, and a run that started while you were reading could show up twice.
- Run history now says so when it can't be loaded, instead of showing "No runs yet" for a schedule with a long history.
- The on/off switch on a schedule goes back to what the server actually has when the change doesn't save, instead of claiming a schedule is off while it keeps running on its timer. It also stops accepting a second flip until the first one lands.
- Deleting a schedule clears its runs from the health dot in the top bar right away, rather than leaving a red count for runs that no longer exist.
- A schedule whose cron expression DorkOS can't read can no longer be saved. The form already marked it in red; now Save waits until you fix it.
- Opening a setup link now lands on the right step instead of bouncing to the start. A link that points straight at a later setup step also no longer breaks the app if it names a step that no longer exists — it just opens setup at the beginning.
- Editing a scheduled task's file on disk now takes effect right away. Changing when a task runs used to update what the screen showed while the old schedule kept running, until you restarted DorkOS — and a task file you dropped in by hand got a card in the cockpit but never actually ran.
- A task whose file disappears now stops running, and starts again when the file comes back.
- A typo in a task's schedule can no longer stop DorkOS from starting. That one task sits out until you fix it, and everything else runs as normal.

### Security

- When you give a scheduled task permission to run without asking, an agent can no longer quietly change what that task does and keep the free pass. If an agent rewrites the task's instructions, its schedule, or its name, DorkOS puts the normal approval prompts back — so it can't turn a task you trusted into one you didn't. A task's name also can't hide extra instructions any more. Editing the task yourself still keeps the setting you chose.
- An agent can no longer briefly run a scheduled task at full power by editing it through the tool API. When a task is allowed to run without asking and an agent changes what it does — its instructions, its schedule, or its name — DorkOS now puts the normal approval prompts back the instant the edit lands, instead of leaving a short gap where the next run could fire at full power. Editing a task that only toggles it on or off, or renames nothing, is untouched. This closes the same escape on the tool API that was already closed for edits made in the app.
- Settings you turn **down** to give your machine room can no longer be turned back up by an agent. Nine of them were missing that protection: whether your Claude Code chats keep an agent awake between messages (which can cost about a gigabyte each), how many scheduled runs may go at once, how large an upload may be and how many files it may carry, whether DorkOS updates the agent files inside your projects on its own, and which four sets of DorkOS tools your agents are told about. An agent asking to change any of those now gets a plain refusal and nothing is written.
- DorkOS already refused to undo choices like these when it had to rebuild your settings file after a problem — it just did not refuse an agent that asked on purpose. Now the two rules match, and a check in the build keeps them matching.
- You still change every one of them yourself, in the same place as before. Warm agents and how many scheduled runs go at once are in the Control Center (`⌘⇧L`, or `Ctrl+Shift+L`); the four tool switches are in Settings → Tools. The upload limits and the project-file updates have no switch yet, so `dorkos config set` is the way there — and now the choice you make there sticks.

## [0.63.0] - 2026-08-22

### Added

- If you talk to an agent from Telegram or Slack, you now hear when it stops. Before, only two things reached you: a reply that crashed, and somebody pressing Stop. If the agent paused to ask you to approve something, or was already busy with other work and never picked your message up, nothing was sent. From the chat it just looked like the agent had gone quiet, sometimes for a long time. Both of those now arrive as a short message, in the same plain words the agent's own conversation in DorkOS uses. You still answer an approval in DorkOS itself. The chat message only tells you there is something waiting, and never includes what the agent wanted to run. Group chats stay quiet by default, as before. And if the agent is busy elsewhere, the chat is told once rather than once per message you send, so a burst of messages will not fill your phone with the same notification. (DOR-1359)
- Stop one agent without stopping the rest. Open the live view in a channel and every agent that is working now has its own Stop button. The others keep going, and the channel says who stopped what. An agent that is only waiting to start here can be stopped too, and that just means this channel stops waiting for it (DOR-1352).
- A room now tells you what an agent is doing, not just that it is doing something. While one agent works, the line just above the box you type in reads "Kai is reading standup.md" instead of "Kai is working on it", and it keeps up as the agent moves from one thing to the next (DOR-1351)
- Click that line and each agent gets its own row saying what it is on right now, so with two or three of them working you can see which one to check first (DOR-1351)
- A screen reader hears "Kai is working on it" once and is not read a new tool name every couple of seconds, so the new detail costs nothing in noise (DOR-1351)
- The file names and commands an agent is working with stay on your own screen. They are not sent to a chat app a room is connected to, or to another community a room is shared with (DOR-1351)
- If you have named approvers on a Telegram or Slack connection, one of them can now answer an agent from a one-to-one chat with the bot. They get the same Approve and Deny buttons you get in DorkOS, showing the same thing the agent wants to run. Press one and the agent carries on (DOR-1356)
- An agent that stops and waits now says so in the chat it stopped in, instead of going quiet. One short sentence, with no file name, no command and no countdown, saying that the answer happens in DorkOS (DOR-1356)
- When an agent proposes a scheduled task, it now shows up under **Needs Attention** with **Approve** and **Reject** buttons, on the Home screen and in the top-right indicator. Before this, the only way to find one was to wander into the Tasks page (DOR-1381)
- DorkOS now keeps a notification history with read state, and one pipeline decides what reaches you where. Finished runs, notes from your agents, messages that could not be delivered, agents that stopped answering, and version updates all land in one place you can come back to (DOR-1383)
- Questions your agents asked now leave a record of how they ended. An agent's question that nobody answered in four hours used to just disappear; now it is written down as "expired", so you can find out what you missed (DOR-1383)
- On a Mac, the desktop app now shows real system notifications with buttons on them. When an agent needs a yes or no, the banner has Allow and Deny buttons right on it, so you can answer without opening DorkOS (DOR-1386)
- On a Mac, a simple question from an agent can be answered right from the notification too: type your reply and it goes straight back to the agent (DOR-1386)
- Wherever you run DorkOS on desktop, clicking a notification brings the app to the front and opens the session it is about (DOR-1386)
- There is now one Inbox in the top right, and it replaces the amber "waiting on you" pill. Anything that is genuinely stopped and waiting on a person, like a permission an agent wants, a question it asked, or a scheduled run it proposed, is still pinned at the top and still turns the marker amber, and you still answer it right there without leaving the page. Below that, in a quieter grey, is everything that happened while you were away: turns that finished, runs that failed, agents that stopped answering, notes an agent left you. Each one carries a dot until you have seen it, clicking one opens the thing it is about, and "Mark all read" clears them in one go. Read marks are kept on your machine rather than in the browser tab, so clearing the marker on your laptop clears it on your phone too. The marker stays out of the way entirely when nothing is waiting and nothing is unread. ⌘⇧Y still jumps straight to whatever needs you.
- Every agent's page now shows the same list for just that agent, under a new "Notifications" row, so you can ask "what has this one been up to?" without reading past everything else. A conversation's "..." menu has a "View notifications" item that opens the Inbox showing only that conversation.
- When an agent sends you a direct message, or someone @-mentions you by your handle, it now shows up in your Inbox the same way a finished turn or a failed run does. Mentions only work once you have set a handle for yourself in your profile; until then nobody can address you by name. Plain channel chatter that does not mention you stays quiet, just like before. Read the room and the Inbox row clears itself, so you are never told twice about something you already saw. Muting a room stops it messaging you about new direct messages, but a mention still gets through, because someone naming you directly is not the ambient chatter mute is for.
- A soft knock now plays the moment an agent stops and needs you, and a gentle chime plays when the last thing waiting on you is answered. Both are on to start with.
- If the DorkOS tab is hidden behind something else, your browser can show a notification when an agent needs you, or when a turn finishes while you are away. Clicking it brings DorkOS back and opens the thing it is about. DorkOS asks for permission the first time that would actually be useful, never when you open it, and it only asks once.
- Settings has a new Notifications tab. Every sound, the browser notification setting, and how long something may wait before DorkOS tries to reach you another way now live together in one place.
- Each morning, Home greets you with a short report of what your agents did while you were away: what finished, what failed, and what waited on you. It shows up once a day, only when there is something to say, and sits just above the Recent Activity list. Dismiss it and it is gone until tomorrow's report has something new to tell you.
- If an agent waits on you for more than a couple of minutes, DorkOS can now ping your phone's browser and your connected chat apps. Answer anywhere and everything else goes quiet. Set the delay, or turn it off, in Settings under Notifications.
- Settings under Notifications now lists the devices DorkOS can reach, with a button to add the one you are reading this on and a way to remove any of them. Adding your phone's browser is the point of it.
- Three things can reach you this way, and only three: an agent waiting for your answer, a scheduled task waiting for your approval, and a session that stopped on an error. News, like a turn finishing, never follows you around.
- On your phone, you can now add DorkOS to your home screen, and it opens like an app: full screen, with its own icon (works when opened over your tunnel's https address) (DOR-1390)
- A schedule an agent wants to run on a timer now shows in the sidebar's Heads up, beside the other things waiting on you. Nothing runs until you say yes (DOR-1391)
- Sidebar groups are now called **sections**, and they sit at the top of the list instead of hidden under Agents. A section can hold anything you see there — a channel, a conversation, an agent — and everybody gets to make one, however few agents they have (DOR-1371)
- The Agents list shows the agents you have used lately and the ones you pinned, then a single **All 31 agents →** row that opens your team page. An agent you have not touched in a month no longer costs a row forever, and "lately" counts the last time you looked at it, not only the last time it ran. If you have eight agents or fewer, you still see all of them (DOR-1371)
- Channels and Direct messages each remember how you want them sorted — by name, or by what happened most recently (DOR-906)
- An agent that wants to run something on a timer now has to say why, in its own words. DorkOS keeps that reason with the proposal, along with which agent asked and the session it asked from, so there is something to read before you decide (DOR-1394)
- Activity rows now show who did it. When a notification is about one of your agents — a finished turn, a message that never arrived, a session that stopped on an error, or a question nobody answered — its row shows that agent's own color and icon instead of a plain bell or checkmark, so you can tell at a glance whose work you're looking at. A session-error or unanswered-question row still keeps its red icon to flag something urgent, even with the agent's face attached. When one of these needs to reach your phone, it now goes out through that agent's own chat instead of whichever chat was used most recently.
- When the same agent does the same thing three or more times in a row, like finishing four runs back to back, those rows now fold into one line ("Alpha Bot finished 4 runs") that you can open to see each one. A single event, or just a pair, still shows on its own (DOR-1396).
- When an agent suggests a scheduled job, you now get a real card instead of a one-line row. It shows which agent asked, why they asked in their own words, what the job would do, and the next few times it would actually run. The exact instructions sit behind a "Show exact instructions" link, next to how much power the job would have. Nothing on the card is guessed: if the server could not work out when it would run, the card says nothing rather than making a time up (DOR-1398)
- **Run it once.** Before you agree to something that will run on its own every night, you can run it a single time and watch what happens. The card tells you when it finishes and links straight to what it did. Nothing gets scheduled, and Approve is still sitting there afterwards, now with proof behind it (DOR-1398)
- Turning down a suggested job now gives you a few seconds to change your mind. The card says "Rejected" with an Undo button, and the job is only really deleted once that moment passes. Undo cancels something that was never sent, so there is nothing to put back. Closing the panel does not lose your decision (DOR-1398)
- You can answer a suggested job from the keyboard, the same way you answer everything else that needs you: A to approve, D to turn down, and only while the card has your focus, so a stray keypress while you are typing cannot decide anything (DOR-1398)
- The card names the conversation the job was suggested in, and clicking it opens that conversation (DOR-1398)

### Changed

- Answer an agent's question in one window and the other windows now say who answered it: "Already answered by Ada at 2:01". DorkOS uses the name on your account, or the name you told it to call you. When it knows neither, the card still says when the question was answered. (DOR-1355)
- Rooms never ask you to send a message again. Your agent works in one folder at a time, so when you write to it in one conversation while it's busy in another, DorkOS keeps your message instead of turning it away. The line above the message box tells you what's happening: "Kai will pick this up when it finishes in #deploys". When that work ends, your message becomes the agent's next turn and the answer lands where you asked. Click the line to open the conversation that's in the way, or to ask for yours to be answered first. If your agent leaves the room, or you put the room away, DorkOS stops waiting and stops saying an answer is coming.
- A message you send from Telegram or Slack is no longer dropped when your agent is already running as much as it can. It waits its turn, and it runs when your agent has room for it. If the wait goes past ten seconds, the chat tells you once that your message is waiting. Nothing asks you to send it again. (DOR-1362)
- Your agent now waits for you instead of guessing for you. When an agent asks to run something and nobody answers, the ten-minute countdown still runs exactly as it did. What changes is what happens next: the card says "waiting for you", the agent holds the question, and answering it hours later picks up right where you left off. Go to lunch, sit through a meeting, do the school run. Four hours on, the agent does give up, and it tells you how long it waited (DOR-1350)
- A scheduled task is the one exception. Nobody is watching a scheduled run, so its questions are still refused after ten minutes and the run carries on (DOR-1350)
- Three buttons now say what they actually do. On the Team page, an agent's row action shows an arrow that points where it takes you, and a screen reader hears "Open session with Ana" instead of "Chat with Ana". On a profile, the button reads "Open session" instead of "Message". In the command palette (⌘K), a direct message reads "Open conversation with Ana" instead of "Message Ana", and pressing it opens the conversation you already have. All three already opened what they open; only the words were wrong (DOR-1367)
- The "2 live" chip on an agent's row in the sidebar now counts the same sessions as the "N working" line at the top of the panel. The two could show different numbers for the same agent before this. A turn that has paused to ask you something no longer adds to the chip, because the dot on the agent's face and the Heads up list already tell you it is waiting. That does mean the chip and the "Live now" list inside the session switcher can differ by one while a conversation is paused waiting on you: the chip counts what is running, the list counts what is still open (DOR-1366)
- The bottom of the sidebar shows one card at a time, and it stays put. Up to four things used to compete for that corner, and the "Use DorkOS on the go" card sat inside the scrolling list — so once you had more than a screenful of agents and channels, it slid out of sight for good. Now there is one spot, pinned just above the row of buttons at the bottom, and whatever matters most gets it: finishing setup, then an update that is ready, then the question about your work, then a tip (DOR-1369).
- Every one of those cards has an × now, and hiding one sticks. The tip cards had no way to say no at all. Your answer is saved to your account rather than to the browser you happened to be using, so a card you hide on your laptop stays hidden on your phone.
- "Use DorkOS on the go" only shows up when it means something — you are in a browser and you have not set up remote access yet. It used to show for everyone, forever.
- On a phone, the card appears at the bottom of Home. Phones never showed it at all before.
- The "Feedback & requests" entry in the help menu, and its page, are now called "Product feedback" (DOR-1380).
- The desktop tray now says when an agent is waiting on you, not just how many are working. It reads "2 working" or "1 waiting", or both together. On a Mac, the app icon in the Dock also carries a badge with the waiting count. On your phone, an agent's question now shows as a full card on the Now screen, the same one you already use to answer an approval, so you can answer it right there instead of hunting for the conversation (DOR-1382)
- The sidebar is simpler to read. It used to have three levels — a big grey word like "Library", a section heading under it, and then your rows — each starting at a different spot on the left. Now there are two. Every heading looks the same: Heads up, Today, Pins, Channels, Direct messages, Agents, and any section you make yourself. Every row starts on the same line, so a channel, a conversation and an agent all line up (DOR-1368)
- Every heading now folds. Click one to hide what is under it, or hold Option (Alt on Windows) and click to fold the whole panel at once. A folded heading tells you what it is hiding, like "12 · 3 unread". Heads up shows how many things still need you, so folding it can never quietly bury something you have to answer
- The word "Library" is gone from the screen. It named a heading rather than anything you would go looking for. Screen readers still hear it. On your phone, that bottom tab now reads "All"
- A group conversation's stack of faces stops at two and stays inside its own column, instead of sliding under the conversation's name
- Muting a conversation no longer greys out its name. Muted means fewer signals, not harder to read: the name stays crisp, and the bold, the unread count and the working dot go away
- The "+" beside a section is now reachable from the keyboard. Arrow down from a heading to reach New channel, New agent, or New section
- Home's **Needs Attention** now shows only what is actually stopped and waiting on you: a proposed schedule, or a session that hit an error. What merely went wrong lately (a failed run, undeliverable messages, an agent nobody can reach) moved to its own quieter **Recent Activity** group. An agent waiting on your answer is now drawn once, as a card, instead of twice (DOR-1381)
- "Session idle for 47 minutes" rows are gone from the Home screen. A session going quiet was never something you had to answer, and saying so every minute for a day taught people to skip the whole group (DOR-1381)
- Telegram and Slack messages about finished runs now ride the same system as everything else. What reaches your phone has not changed: a failed run always tells you, a successful one only if you switched that on for the integration. What is new is that the run is recorded either way, so a machine with no chat integration connected is no longer told nothing at all (DOR-1383)
- A note an agent sends you with "notify user" now also lands in your history, so a message you glanced at on your phone is still there tomorrow. The tool works the same way it always did: same answers, same limit on how many notes an agent can send you in an hour (DOR-1383)
- That hourly limit now actually holds. It counts every note an agent tries to send you, not only the ones that reached a chat app — before, on a machine with no Telegram or Slack connected, nothing ever counted and an agent stuck in a loop could talk to you forever. A note that hits the limit, or that you have switched off with "Agent can start conversations", now leaves nothing behind anywhere, instead of quietly filling your history (DOR-1383)
- These notifications stay quiet on their own (no sound) and only show up for the things worth interrupting you for, or for finished work while you are away from DorkOS. Everything else still waits for you in the app (DOR-1386)
- The "Recent activity" group on your home screen now reads from the Inbox instead of working things out for itself. It shows the same three things it always did: runs that failed, messages that could not be delivered, and agents that went quiet, all from the last day. They are now the same rows the Inbox holds, so something you have already read on one screen looks read on the other. Links people have shared before still open the same detail panels. A message that could not be delivered now opens the Connections page, which lists them all, instead of a panel that could only find some of them.
- The chime that used to play every time an agent finished replying is off to start with. With a few agents running it was a lot of sound, and it never told you which one needed you. You can turn it back on in Settings under Notifications.
- Sound settings follow you between devices now instead of being remembered by one browser. If you had the finishing chime turned on, it stays on.
- The sound switch inside a conversation's status panel is gone. It looked like it was about that one conversation and was not, and all three sounds are now set together in Settings.
- The setting that says how long something may wait before DorkOS tries another way of reaching you now does what it says. It used to be saved and ignored.
- A notification sent to your phone carries a short line and a link to the thing it is about, and nothing else. It never carries what an agent wrote or what it wanted to run, because your phone may show it on a locked screen.
- "Went quiet" rows are gone from Heads up. A session going quiet is not something you have to answer, so the daily digest says how many sessions are sitting idle instead (DOR-1391)
- On a phone, a question you can answer right there no longer also shows as a second line underneath the card (DOR-1391)
- One way in to each agent. Clicking an agent in the sidebar opens your chat with it, and that is now the only place that chat lives. The sidebar used to list the same agent twice, once under Agents and once under Direct messages, and the two opened different things. Pick one agent in the "+ New" picker and you land in that same chat. Pick two or more and you start a group message (DOR-1370).
- Your old one-on-one messages are all still there. Nothing was deleted or moved. Whenever one of them has something new for you it shows up under Today — including a line an agent started by itself — and the agent's own row gets a dot beside it. You can find any of them any time with ⌘K or from the agent's profile. Chats connected from Telegram or Slack keep their own row, since there is a real person on the other end (DOR-1370).
- A group message keeps up with who is in it. Add an agent to a group and its name grows to include them, unless you named the conversation yourself, in which case your name stays (DOR-772).
- Removed the extra sentence under "Scheduled Runs" in the Inbox popover. The summary above it already promises nothing runs until you decide, and the schedule card underneath already says what it's about to run (DOR-1395)
- The "All clear" checkmark now fades and rises into place instead of appearing all at once (DOR-1395)
- The alert about a schedule waiting on you now names the agent that proposed it, instead of saying "An agent" (DOR-1394)
- A schedule waiting for your approval now says when it would actually run: the next time, and the two after it. Until now it said nothing, because DorkOS only worked that out for schedules that were already switched on, which is never true of one that is still waiting on you (DOR-1394)
- Every page's header now ends with the same three controls, in the same order: search, the inbox, and the right-panel toggle. Nothing else can sit between them, so the corner you reach for is the same corner on every page (DOR-1400)
- A long room name in the header now shortens with an ellipsis instead of pushing those controls off the edge — hover to see the full name (DOR-1400)
- The Inbox bell and the knock sound and desktop banners that alert you now always agree about what's waiting on you. They read from the same list, so one can no longer say something needs you while the other stays quiet (DOR-1397)
- Home, Activity, Scheduled and Workspaces now switch from tabs inside the header itself, so each of those pages starts one row higher and shows more of what you came for (DOR-1401)
- Home lost the extra row that named your #team room. The Home tab says which page you are on, the box at the bottom says which room you are writing to, and the header now shows how many people and agents are in it — press that head count to open members (DOR-1401)
- Activity's category filters moved out of the header and onto the page, above the feed they filter (DOR-1401)
- The little system-health dot sits at the same spot on all four of those pages now, so it never moves as you switch between them (DOR-1401)
- Workspaces no longer prints its own title under the header that already says it (DOR-1401)
- A channel no longer names itself twice. The room name, what it is about, and everything happening in it now live in the single header row at the top, so the conversation starts a row higher (DOR-1402)
- The header of a room now shows when agents are working in it and gives you a Stop button to halt them all. Both hold their place while the room is quiet, so nothing shifts under your cursor when an agent starts (DOR-1402)
- On a phone that pair is replaced by a small green dot on the head count, and the room's name gets the space back — you stop agents from the line above the message box, which is on screen whenever something is running (DOR-1402)
- When the header runs out of room, the topic shortens and disappears before the room's name gives up any space. The name only shortens when nothing else is left, and hovering either one shows the full text (DOR-1402)
- Home shows that same working count and Stop button again, next to the head count for your #team room (DOR-1402)
- Press the head count in a room's header to see who is in it and add more (DOR-1402)
- Your #team room now opens in one place. Pressing #team in the sidebar takes you Home, and old links to it land there too, with any open thread still open. The #team row stays highlighted while you are there (DOR-1402)
- The Team page's view switcher is now the same kind of tab strip the rest of the app uses, with a thin rule separating the three ways of seeing your agents from the two about access (DOR-1405)
- On a phone, the Team views are no longer hidden behind a dropdown. All five are in one strip you swipe sideways, and the Table view — which the dropdown used to leave out — is finally among them (DOR-1405)
- On a phone, "New Agent" is now a `+` button, which gives the view names the width they need (DOR-1405)
- The bar above a session now shows who you're talking to and which conversation you're in: your agent's face and name, then the session's own title — the same title the sidebar list shows. It used to read "Team › DorkBot › Session", which was true of every session you've ever opened and never told you which one you were looking at. A brand-new session reads "New session" until your agent names it after the first reply, and then the header updates on its own. If the session isn't tied to an agent, the header shows the folder's name instead. Sessions started by something other than you — a scheduled task, a message from Telegram — still say so, and on a narrow window that note shrinks to its icon so the conversation's name keeps the room. If you delete an agent while you're reading one of its conversations, the header keeps its name rather than going blank — it's still the agent that wrote everything on screen.
- The sidebar no longer builds itself in front of you when the app opens. It waits until it knows what to draw, showing a quiet outline of the panel in the meantime, and then appears once. Your channels, direct messages and agents all arrive together instead of popping in one group at a time (DOR-1372)
- Everything about a room now opens in the side panel instead of a pop-up over it. Who is in the room, what it is about, how loud each agent is, and the way to add or remove one all sit beside the conversation, so you can read the room while you change it (DOR-1403)
- The panel has its own tab, next to Pulse. Opening a channel or Home puts you on it, and Pulse is still one press away (DOR-1403)
- The three ways in still go where they always did. The head count in the header opens the list of members, an empty room's "Add agents" opens the picker ready to type, and the sidebar menu's Members, Add agents and Edit topic each open the part they name (DOR-1403)
- Picking one of those from the sidebar now opens that room as well, so the panel is always about the room you are looking at (DOR-1403)
- On a phone the panel slides over the room, the way the pop-up used to (DOR-1403)
- Reloading the cockpit no longer opens with a second of empty panel. DorkOS remembers what your sidebar looked like last time — your channels, your agents, today's conversations, your pins — and paints the finished panel in the first frame, then quietly checks with the server behind it and updates anything that moved (DOR-1373)
- The sidebar redraws less. Muting a channel, filing one into a section, or the panel's own once-a-minute tick used to make every conversation row in the list redraw itself; now only the rows that actually changed do. Each row also waits until you reach for its menu before setting up what that menu can do, so a long list costs less just by being on screen (DOR-1375)
- Pages stop saying their own name twice. The bar along the top already tells you where you are, so Marketplace, Marketplace Sources, Connections and Product feedback no longer repeat it as a big title underneath — each one opens with the line that actually explains it. Screen readers still announce the page name, so nothing is lost if you navigate by heading
- The sidebar now moves when something changes that you did not change. Folding a section springs it shut and leaves a quiet count on the header ("12 · 3 unread"); a conversation that turns up in Heads up or Today slides in and flashes once instead of appearing out of nowhere; a list that reorders slides so your eye can follow the row you were reading; and dragging a row lifts it slightly, marks where it would land with a thin ring, and lets it settle into place. Nothing loops, nothing lasts longer than a blink, and if you have asked your computer for less motion, all of it is simply off.
- The Claude account you pick in Settings is now called your **default account** — new chats bill it unless something more specific says otherwise. Your current choice carries over, and each account you have registered gets a short name of its own so other settings can point at it later (DOR-1407)

### Fixed

- After you rejoin a channel, the sidebar stops saying you left it. The row could keep its dimmed "Left" tag, sometimes for as long as the channel stayed quiet, if you happened to read something else at the same moment, on this device or another one (DOR-1358).
- In the Obsidian panel, typing before you have picked a conversation no longer swallows what you wrote. The message box now says "Pick a conversation, or start a new one." and keeps your words, instead of looking ready, clearing itself, and showing "Could not send message" (DOR-1354)
- If a message waits so long that it never runs, the chat now says so plainly and tells you that you can send it again. Before, a busy agent asked you to resend before it had even tried. (DOR-1362)
- When an agent proposes a scheduled task, the Scheduled list now updates immediately. You no longer have to reload to see it waiting for your approval. It also shows up in Activity, so there's a record that it happened (DOR-1380).
- One error now shows one message. Creating an agent, making a channel or DM, connecting or testing a messaging integration, turning a connection on or off, renaming a session, and a few onboarding steps could each pop two overlapping error messages when something went wrong: one naming the action, one generic. Now there's exactly one, and it says what actually broke (DOR-1378).
- Copy buttons now show a small check right on the button, and say so if the copy failed instead of staying quiet. A few success messages that popped up for things you could already see are gone. One message that wrongly looked like an error after a successful delete now looks normal. And a channel name that's already taken shows right under the name field instead of a separate error message.
- A few more success messages that popped up for things you could already see are gone: saving an extension setting, saving or clearing a secret, and turning an extension on or off all show the change right on the control now, with no extra message on top. Stopping a scheduled task run that fails to stop now shows one clear message instead of a chance of two.
- Copying two things back to back no longer cuts the first one's checkmark short. Also fixed a rare case in dev builds where making a channel with a name that's already taken could show both an inline message and a separate pop-up saying the same thing.
- If starting a direct message fails, DorkOS now always says so, even if you closed the panel while it was still trying (DOR-1391)
- Copying the update command, or your debug info, now tells you when your browser refused the clipboard instead of saying it worked. The "Copied" note also clears a little sooner, matching every other copy button in the app (DOR-1391)
- On a phone, an agent waiting on you can no longer be hidden behind the getting-started card (DOR-1391)
- Schedules already waiting for you no longer knock or send a notification as if they had just arrived, when DorkOS is slow to read its settings at startup (DOR-1391)
- A section's **Show** setting now actually filters the list. It was there, it remembered your choice, and it did nothing (DOR-1371)
- A section sorted by **Recent activity** now puts channels and conversations in the right place. They used to all fall to the bottom, whatever had just happened in them (DOR-1371)
- **Mute** is gone from a section built from rules. Choosing it flipped the label and changed nothing, because a rule-built list is rebuilt every time you look at it (DOR-1371)
- **New section…** from any row now puts the name box in one place — the top of the list — instead of somewhere below your agents where a narrow sidebar could not show it (DOR-1371)
- The **N inactive** row at the bottom of Agents took a click and did nothing. It is now the "All N agents" row, which goes somewhere (DOR-1105)
- Right-clicking a channel, conversation or agent and choosing **New section…** or **Rename…** now opens the name box. It had been opening and closing again too fast to see, so the menu item looked like it did nothing — using the row's **⋮** button worked, which is why it went unnoticed (DOR-1371)
- A notification with nowhere to go, like a DorkOS update record, no longer draws as a button that looks clickable but does nothing. It now reads as plain text; the dot still clears when you use "Mark all read" (DOR-1396).
- The home screen used to announce everything waiting on you as "approvals", even when none of it was. It now says what each thing actually is: questions, requests, and schedules. Screen readers hear the same honest wording the Inbox already used (DOR-1398)
- A suggested job now waits in "Waiting On You" alongside the other decisions, instead of sitting under "Needs Attention" with the things that broke (DOR-1398)
- Opening a link to a conversation now shows the room loading instead of a blank page while DorkOS works out which room it is (DOR-1402)
- Your agents keep their faces and names from the first moment you see them. They used to appear with a placeholder emoji and colour that changed a second later — every agent at once (DOR-1143)
- The panel asks the server for the same thing once instead of twice, so the app has less to do while it starts. DorkOS now watches your 24 most recent conversations for work that needs you, up from 10 — so a session that has been waiting a while is less likely to be missed (DOR-1372)
- Opening the app on a channel no longer scrolls the panel on its own. The open conversation is simply already in view (DOR-1372)
- A one-to-one shows the agent's own picture again, in the header and beside their name in the panel. For a while it showed nowhere (DOR-1403)
- Opening a link to a room that has been deleted now says so in the panel, instead of showing a name that never arrives (DOR-1403)
- Pressing the head count moves the keyboard into the list of members, so you can get there without a mouse (DOR-1403)
- On a phone, the Archive button no longer sits under the home indicator (DOR-1403)
- The Getting started suggestions appear with the rest of the panel instead of arriving a moment later and pushing everything below them down (DOR-1373)
- Something you just changed, like a card you dismissed, a section you made, or a room you muted, is what the next load starts from, even if you reload the moment after (DOR-1373)
- The setup wizard no longer appears over an install that finished setting up long ago. For a moment while DorkOS read your saved settings, it could decide you were brand new and put the welcome screen up. It now waits for your real settings first (DOR-1373)
- A damaged saved copy of your sidebar no longer stops the app opening. DorkOS throws it away and loads fresh instead (DOR-1373)

### Security

- A program calling DorkOS with an agent token DorkOS cannot verify no longer acts as you in a channel. Until now it could attach files, rename people, stop running work, post messages and read a channel's history, and all of it went into the record as something you did. Every way into a channel now turns that token away and says so: the web addresses, and the tools an agent uses (DOR-1361)
- The same token can no longer get itself written down as you when an MCP server is added to one of your agents. That entry records who added it, and a person reads that line when deciding whether to trust a server that runs a command on their machine, so DorkOS now refuses instead of putting your name on it (DOR-1361)
- When any of this happens to a command you ran, the `dorkos` command line now shows you what the server actually said. It used to tell you your API key was the problem, which sent you to fix the wrong thing (DOR-1361)
- What an agent is waiting for now reaches only the people who could answer it. In a group chat nobody sees it, because DorkOS cannot know who else is reading. And another agent on your machine no longer sees any of it: not in the fleet-wide list, not on the live feed, and not on a session's own stream. It could never answer one of these, and now it cannot read one either. Your own scripts, holding your API key, can still see them and still cannot answer them (DOR-1356)
- Requests for permission to run something are no longer broadcast to every connection. An agent connecting to DorkOS with its own token no longer sees what other agents are asking you for permission to do, which brings these in line with the questions agents ask you (DOR-1383)
- What the cockpit remembers is tied to the address it was talking to, so two DorkOS installs open in one browser never show each other's channels. It is forgotten when you sign out, when you update DorkOS, and after a day. Your conversations are never kept in the browser — and neither is anything waiting on your answer, so you are never shown a stale "three things need you" (DOR-1373)

## [0.62.0] - 2026-08-18

### Added

- Settings has a new **Experiments** section: things we are still proving out, not yet ready to be the default. Each one says what it gives you and what it costs, and they are all off until you turn them on. Two are waiting there now. **Keep agents warm between messages** leaves your agent running between messages, so replies from the second message on start about 4× faster — it holds up to about 1 GB of memory per warm agent, and applies to chats you start after turning it on. **Let outside agents reach yours** opens the A2A gateway, which lets agents built by other people send work to yours; it is still early alpha, and turning it on opens a door, so only do it when you know what is on the other side. Every experiment ends the same two ways — it becomes the normal behaviour, or it goes away — so an empty list means nothing is waiting on you (DOR-1304).
- See a dev server you're running in the canvas from your phone, your tablet, or another laptop — not just the machine it runs on. Live reload keeps working, and pages with deep links open where you asked for them. When a preview can't be shown, the canvas says why in a sentence you can act on instead of going blank.
- Click the line above the message box in a channel to see each agent that is working, how long it has been going, and what it is answering (DOR-1329)
- From there, jump to the message an agent is replying to, open the session its work runs in, or stop the room (DOR-1329)
- When an agent stops to ask you something, you can now answer it from wherever you are in DorkOS. The question shows up in the header on every page, in the sidebar, on the home screen, and on the line above the message box in the channel it came from (DOR-1330)
- The question says what the agent actually wants, in its own words: "Meeting Notes wants to edit standup.md", not "waiting on you" (DOR-1330)
- Press `Cmd+Shift+Y` to jump to the next thing waiting on you. With the card in front of you, `A` allows it and `D` refuses it (DOR-1330)
- Several requests from one agent for the same tool arrive as one card, so five files to read is one decision and one Allow (DOR-1330)
- **Let all my agents talk to each other** — a single switch in Team → Access. Until now, two agents you made a minute apart could not message each other: each one lands in its own project, and agents only talk inside a project unless you add a rule for the pair, one dropdown pair at a time. Five agents meant twenty rules, and nothing told you until an agent hit the wall in the middle of a job. Flip the switch and every agent on this machine can reach every other one. Flip it back and you're where you were, with any pairs you'd already allowed still there. It's off when you install DorkOS — your agents stay in their own project until you say otherwise. (DOR-1338)
- The switch also shows up while you're making an agent, once you have another one it wouldn't be able to reach — so you find out before the agent does, not after. (DOR-1338)
- Packages that need npm libraries now get them installed for you. When you install something from the Marketplace, DorkOS lists the libraries it will download before you approve — in the cockpit dialog and in the terminal — then fetches them as part of the install. No more running `npm install` by hand to make a plugin work (DOR-1341).
- If a package's libraries cannot be fetched — no npm on your machine, or the download fails — the package still installs and DorkOS tells you exactly what to run to finish the job. The note stays on the package in "Manage Installed", so you can still find it long after the pop-up is gone (DOR-1341).
- The API reference now documents the two mesh topology endpoints — reading who can talk to whom, and changing it — including the "Let all my agents talk to each other" switch and what happens if you use `*` on only one side of a rule (DOR-1343)
- New guide, [Answer your agents from anywhere](https://dorkos.ai/docs/concepts/answering-agents), explaining how to answer a question or approval from the header, the sidebar, the home screen, or right above the message box where it came up

### Changed

- The A2A gateway can now be turned on from Settings instead of only from an environment variable. If your machine sets `DORKOS_A2A_ENABLED`, that still wins either way, and the switch shows you what is really running rather than offering a choice the server would ignore (DOR-1304).
- Turn on message timestamps in Settings and they now show in channels too, not only in sessions (DOR-1328)
- Rest the pointer on a message's time in a session and you get the whole date, the way a channel already did (DOR-1328)
- Move through a run of messages with the keyboard and each one now shows its time as you land on it (DOR-1328)
- The line that says who is working moved above the message box, and it is always the same height, so an agent picking something up no longer pushes what you were reading (DOR-1329)
- A session's own line lives in the same place now, and still carries how long the turn has taken, what it has spent, and a warning when its permission stops are off (DOR-1329)
- The line waits ten seconds before it puts a timer up, because a number that starts at zero is nothing to read (DOR-1329)
- Answer a question once and it is answered everywhere. Every copy of it turns into a line saying what happened: what you chose, or who answered it first and when, or that it is no longer needed (DOR-1330)
- The question still has ten minutes. If nobody answers in that time it is refused for you and the agent carries on without it, exactly as before. Showing it everywhere is how you get to it in time (DOR-1330)
- A question that arrives while you are typing never takes the cursor, and `A` is still just the letter A in your message (DOR-1330)
- When an agent is blocked from messaging another agent, it now names the switch and where to find it, so it can tell you exactly what to turn on. (DOR-1338)
- Agents that are set up to talk to each other now start every turn with the tools for it already in hand, instead of spending part of their time looking them up (DOR-1337)
- See exactly which files an install will touch. The install dialog used to say only "134 files will be created, modified, or deleted". It now names the folder they land in, counts how many are new, changed, and removed, and lets you open the full list of paths. Removed files are listed first, because those are the ones an uninstall cannot give back. If a package writes anywhere outside that folder, the dialog says so and names those files. (DOR-1339)
- Find DorkOS packages in the Marketplace without searching. The catalog carries nearly 300 packages, most of them mirrored from other registries. The browse page now opens with DorkOS's own packages first, and a new Source filter in the sidebar lets you narrow to any single marketplace. Each card names where the package came from. (DOR-1339)
- Long channels scroll smoothly. A channel now draws only the messages you can see, the way a session's chat already did, so a room with months of history stays as quick to scroll as a room with ten messages (DOR-1331)
- When a message arrives while you are reading back through a channel, you get a "New messages" button instead of being taken to the bottom. Press it when you are ready (DOR-1331)
- Open a thread on your phone and come back, and the channel is on the same message you were reading (DOR-1331)
- Hover a message longer than the window and its buttons stay where you can reach them, at any point in the message (DOR-1331)

### Fixed

- Dev servers you run on your own machine — Vite, Next, anything on a `localhost` address — now show up in the canvas, live reload included. They used to render as a blank white page. Using DorkOS from another device? "localhost" means that device, so the page won't render there yet; the browser toolbar's "Open in system browser" button still gets you to it (DOR-1259).
- The canvas now tells you when a preview goes wrong instead of showing you nothing: when there's no dev server on that address, when a page is taking too long, and when a page failed to load some of its own files (DOR-1259).
- Stop now works while an agent is finishing up. Right at the end of a reply, an agent can wake itself back up — a background job it started reports in, or one of its own scripts runs — and DorkOS shows the reply as running again, with a Stop button on it. Pressing that button did nothing: DorkOS asked the agent to stop and then waited for an answer that could never arrive, so the reply kept going until the agent ended it on its own. Stop now gives up on asking politely after three seconds and ends the agent's work itself, and when DorkOS already knows the agent can't hear it, it ends the work straight away. The reply is then marked as one you stopped — not as finished, and not as an error, whether or not the agent had said anything yet. That marking sticks: reopen the chat later and it still shows as stopped. (One rough edge left: the agent's own written record of the chat won't say it was stopped, because it never got the message.) (DOR-1244)
- Stopping a single background task is bounded the same way: if the agent doesn't answer within three seconds, DorkOS tells you it couldn't stop that task instead of leaving the request hanging — and it never ends the rest of the reply to do it (DOR-1244).
- Adding context to a chat no longer quietly starts a second agent. "Add context" was starting one even with the "Keep agents warm between messages" experiment turned off, and every message after that in the chat stayed on it. Now the chat says "Added context for the next reply" and your words go to the agent when you next write to it. They are kept in memory until then, so restarting DorkOS in between loses them (DOR-1307)
- Extensions no longer restart every time you open DorkOS or open a new tab. Each browser tab used to ask the server to start the extensions again, which shut down the running ones and started them over — seconds after launch, and again on every tab. DorkOS now leaves an extension alone when nothing about it has changed, and only restarts it when its code actually changed or you ask for a reload. (DOR-1336)
- Running DorkOS from your home folder no longer fills the log with warnings about its own bundled extensions. When your working folder is the one that holds DorkOS's own settings, DorkOS was reading its extensions folder twice and mistaking its own extensions for project copies of themselves. It now reads that folder once. (DOR-1336)
- An API key you save for an extension now works straight away. Extensions read their saved keys fresh every time, so pasting a key in Settings no longer needs a DorkOS restart before the extension can use it. (DOR-1336)
- When the background half of an extension stops building, its card in Settings now says so — "Server side failed to rebuild… the previous version is still running" — instead of looking perfectly healthy while DorkOS quietly runs the last version that worked. The rest of the extension, including the part you see on screen, keeps working while you fix it. (DOR-1336)
- Your agents can reach each other by following their own instructions. The address one agent needs to message another was written one way in the instructions and matched another way by the access rules, so an agent that did exactly what it was told got "access denied" — even with the permission switched on. Agents now read the real address straight from the agent list, and a shortened address still gets delivered instead of refused (DOR-1337)
- An agent whose turn crashes no longer looks like an agent with nothing to say. The agent that asked now gets a clear failure, plus whatever partial work came through, instead of an empty answer it had no way to question (DOR-1337)
- The Mac app no longer says "Claude Code CLI: missing" when it ships with Claude Code. It was looking for the copy inside its own app bundle in a place it could never run it, and it never looked at the one the app hands it. Both checks now walk the same list of places as the agent itself, so what the setup screen says and what your sessions actually run are the same thing (DOR-1334)
- Codex now shows up with an honest status even when the Codex tool is not installed. It used to vanish from the setup screen entirely, leaving a card with nothing to say. If you start a Codex chat without it, you get a plain sentence telling you what to install (DOR-1334)
- "Install Claude" now installs Claude, and the next chat you start uses it — no restart. The button was there but had nothing behind it, so clicking it looked like nothing happening. If a one-click install is not available for something, you get a sentence saying so and the command to run yourself (DOR-1334)
- `dorkos` and `dorkos doctor` no longer warn that Claude Code is missing when it is right there. They were looking in fewer places than DorkOS itself does (DOR-1334)
- When a check reports something missing, the server log now says why — which tool, where it looked, and what went wrong — instead of staying silent (DOR-1334)
- The Mac app now finds the tools you already have installed. Opening DorkOS from the Dock or Spotlight used to hide everything outside a handful of system folders, so agents installed in places like `~/.local/bin` or Homebrew looked missing — even though the same DorkOS found them instantly from a terminal. The app now reads your shell's own setup at startup. (DOR-1335)
- The Mac app now opens in your home folder instead of somewhere inside the app itself. That wrong starting point was why it could show an empty list of chats and a folder path that nothing would open. (DOR-1335)
- Codex is now included in the Mac app. It was left out of the download by mistake, so the app acted as if Codex did not exist. (DOR-1335)
- Add-ons from the Marketplace now load in the Mac app. A missing piece of the build stopped them starting every time you opened it. (DOR-1335)
- With **Keep agents warm between messages** turned on (Settings → Experiments), a chat now reaches the agent the first message warmed up from the second message on, instead of starting a second one beside it. Replies start faster, and DorkOS stops holding a spare agent open for every chat. (DOR-1309)
- A new agent no longer changes namespace five minutes after you create it. The namespace is the group an agent's permissions hang off, shown in Team → Access. DorkOS put every agent it created into one shared namespace and then moved it into its own on the next background check, so two agents made in the app could talk for a few minutes and then quietly could not. They now land in the namespace they keep (DOR-1342)
- When an agent does change namespace, it no longer leaves its old one behind it. An agent created by an older version still moves once, on the first background check after you upgrade, and that move now clears the permissions of the namespace it left, instead of leaving them there for good (DOR-1342)
- Agents you message through Relay now answer with the model you set for them, whether the message comes from another agent or from a chat app like Telegram or Slack. An agent pinned to a fast, cheap model was quietly answering on whatever the runtime picked instead — the same agent already used your setting in channels and in chat. A conversation you have already changed the model on keeps your choice. (DOR-1344)

### Security

- An agent can never answer a question, including its own. Anything calling DorkOS as an agent is refused. With Require login turned on, so is anything holding one of your API keys, which is the kind of password a program uses instead of signing in. Only a person signed in on this machine can answer (DOR-1330)
- A channel still shows only a short note when an agent is waiting, with no file name, no command and no countdown. The question itself, with all of its detail, goes to this copy of DorkOS, where you are the person who can answer it (DOR-1330)
- A program calling DorkOS with an agent token DorkOS cannot verify can no longer see which session each agent in a channel is working in. Only a person can (DOR-1357)

## [0.61.0] - 2026-08-17

### Added

- **See exactly what your agent reads.** The Instructions and Boundaries pages of an agent's profile now end with a line you can open: **Preview what your agent will see**. Inside is the real thing — the short name and description your agent is given, its personality written out in full, your instructions and your boundaries, assembled the way the agent gets them. It follows what you have typed, so you can read it before you save (DOR-1255)
- `dorkos debug phantoms` shows how often an agent's own work was cut short by the coding tool rather than by you. This has been a real bug — one session lost eight pieces of work to it in a single sitting — and until now the only way to notice was to sit and watch. Now it is a number you can check, and a warning in the log when it happens (DOR-1087)

### Changed

- Everywhere you could open an agent now says the same thing: **View profile**. The sidebar's "Agent hub", the Team table's "Manage", the status line's right-click menu, the command palette and the topology map all used a different word for the same act, and they all landed somewhere slightly different. One word now, and one place — the profile, which docks beside your session or slides in from the side depending on where you are (DOR-1255)
- Links you saved to the old Agent Hub still work. They open the profile (DOR-1255)
- On the Team page, **View profile** in the table now opens the same profile card the cards open, instead of a different panel off to the side (DOR-1255)
- An agent can send you up to ten notes an hour. Past that it is told to say it in the conversation you are already having, so an agent stuck in a loop cannot fill up your phone. Notes still only go where you already allowed them: your direct message with that agent, or a chat on a connection you set up and gave it permission to start conversations on (DOR-1265)

### Fixed

- **DorkBot's voice is yours to change.** Setup asks you to pick how DorkBot should sound, but its profile then refused to let you change your mind. Now the **Personality** row on DorkBot's profile opens the same picker every other agent has. Its name, its face and its description still belong to DorkOS (DOR-1255)
- An agent your fleet can no longer name — one you retired while the app was open — no longer goes silent in the sidebar. Its face and its menu still open the side panel, which tells you the agent is gone and names the folder it was in, instead of doing nothing at all (DOR-1255)
- Settings pointed you at a tab that no longer exists. Under **Connect other apps to DorkOS**, the note about giving one of your own agents tools from another MCP server now sends you to the agent's profile and its **Tools & MCP** page (DOR-1255)
- A new chat gets its permanent name a moment after you send the first message. Anything still using the name from that first moment — a button inside a reply, a window opened from an old bookmark, or a script talking to the API — used to quietly start a second, empty copy of the chat and cut the live one off mid-answer. Both names now lead to the same chat, so the reply keeps streaming and the click lands where you expect (DOR-1262)
- The receipt that confirms a message was staged now reaches your screen for a chat that has been renamed, instead of going nowhere (DOR-1262)
- The "start every new session here?" prompt that appears after you switch to Full autonomy no longer hides its own buttons. Make default and Dismiss now stay fully on screen and clickable, at any window size (DOR-1270)
- Every room turn now tells the agent the room's id and the id of each message it can act on. Reacting to a message, reading a channel back, and posting to one all ask for those ids, and an agent had never been given them — so one asked to "just acknowledge this" had nothing to point at, and one asked to check a channel's history guessed the channel's name and got an error (DOR-1263)
- A file someone shares in a room now comes with a full path, so the agent opens it on the first try instead of looking in the wrong folder (DOR-1266)
- Your agents keep the names you gave them in channels. An agent that posted, reacted, or read back a channel used to rename itself to its short address partway through a conversation, so "Docs Writer" became "docs-writer" in every message and in the member list. Names now stay put (DOR-1264)
- Ask an agent in a channel to send you a note and it now arrives. It used to stop and wait for a permission card that only ever appeared inside the agent's own chat — somewhere nobody was looking — so the note was never sent (DOR-1265)
- A question or an approval the agent is waiting on now survives a page refresh. Reloading the tab used to hide the card behind a "Question answered" line, for a question nobody had answered. That left no way to answer it, and the agent sat stuck until it gave up. The card comes back now, ready to answer, and it is the only thing on screen for that question (DOR-1269)
- "Steer" now appears only when your chat can really hand a message to the agent mid-task. Before, it was offered on every Claude Code chat, but only chats that keep the agent running between messages can be interrupted that way — so the message quietly waited its turn instead of cutting in (DOR-1268)
- If a message can't cut in after all, the chat says so — "Couldn't cut in. It's waiting in line." — instead of staying silent (DOR-1268)
- Links in an agent's reply act like normal links again: hover to see where they go, and cmd/ctrl-click opens one in a new tab. In your browser, right-click also copies the link address (DOR-1272)
- Agents are now told the real name of every DorkOS tool. Claude Code gives your agent these tools under longer names than the ones DorkOS registers them with, and the instructions the agent reads were using the short ones. An agent that followed those instructions exactly got "no such tool" and gave up. Bigger models guessed their way around it. Smaller, faster ones did not. Ask an agent to just acknowledge a message and it now leaves the ✅ on the first try, instead of failing three times and typing a reply nobody wanted (DOR-1292)
- Room tools are ready the moment a turn starts. Agents used to have to look a tool up before they could use it, which cost a step on every reply in a channel. Posting, reacting, and reading a channel's history now work straight away, so an agent answers instead of hunting (DOR-1292)
- Every other DorkOS tool is easier to find. Each one now carries a short phrase saying what it does, so an agent can look for "install a package" instead of guessing the exact name (DOR-1292)
- Agents are also told that a thumbs-up can be the entire reply. Anything an agent writes during a room turn gets posted to the room, so an agent that reacted and then added "Done, acknowledged" left two messages where you asked for none. It now knows it can react and stop (DOR-1292)
- Reopening a chat used to put a green "Question answered" over a question nobody had answered. If you missed the question and the agent gave up waiting, the record of it said the opposite of what happened. Now the transcript says what actually became of it — nobody answered in time, you dismissed it, it failed, or no answer was ever recorded — and shows the agent's own words when there are any. An answer that lands right as the turn ends still counts as an answer (DOR-1293)
- A tool you turned down, or left waiting until it timed out, no longer comes back looking like it ran. Reopening the chat shows that it was refused, and shows the reason the agent was given — including refusals that never went through DorkOS, like a tool you turned down in the `claude` command line or one your permission rules blocked (DOR-1293)
- A tool that simply failed now reads as failed in an old chat, instead of getting a checkmark (DOR-1293)
- The text under one of these rows keeps its line breaks, so a blocked command reads the way it was written instead of running together on one line. A very long one is cut short with a button to show the rest (DOR-1293)
- If you turn on the experimental setting that keeps an agent warm between messages (`runtimes.claudeCode.persistentSession`, off by default), sending a message into a reply that was already being written could leave that chat stuck — every message afterwards went nowhere, and only restarting DorkOS brought it back. It no longer can: a late answer is matched to the message it belongs to, and a reply that never finishes is closed out so the next message still runs. When that happens the unfinished reply is marked as an error rather than left spinning, and your next message goes through normally (DOR-1294)
- With that same experimental setting on, a reply that never finished used to spoil the next one: DorkOS closed out the unfinished reply while your new message was already under way, so the new reply was marked failed and stopped mid-sentence even though the agent was still writing, and the chat's saved history mixed the two together. The unfinished reply is now closed out first, before the new one starts, so it is marked as an error on its own and your next message runs clean. The same goes for `/compact` after a reply that never finished (DOR-1295)

## [0.60.0] - 2026-08-16

### Added

- Try "Engaged" as a response mode for new direct messages with an agent (DOR-773)
- Ask an agent to open a room with another agent — you're always included, replies go one-for-one, and agents hand off with @name (DOR-1208)
- Get a DorkOS direct message when an agent finishes and you have no Slack or Telegram connected (DOR-1209)
- Set how long a channel waits before answering, and how many messages one answer covers (DOR-1201)
- Agents react with an emoji instead of writing "seen" — and now default to reacting instead of typing "Ack" (DOR-1202, DOR-1234)
- Agents can read or search a room's history without pausing on a permission prompt they own (DOR-1202, DOR-1229)
- An agent can post an update straight into a channel or thread mid-task — that post is its answer (DOR-1202)
- Claude Code agents get react, look-back, and post automatically; Codex and OpenCode need your own MCP setup (DOR-1202)
- Your conversations are backed up automatically — daily, and before any storage change (DOR-1224)
- Export any channel or DM to a file: `dorkos room export #backend` (DOR-1225)
- Steer a working agent, add context, or queue your message — pick from the composer, and a steer shows up right inside the agent's reply as it works (DOR-1198, DOR-1195)
- See only the send choices your agent's runtime actually supports (DOR-1198)
- Leave a channel or group from its menu; rejoin anytime, or undo right after leaving (DOR-1233)
- DorkOS logs which setting changed and where from — never the value — across the app, CLI, and agents (DOR-1237, DOR-1247)
- Confirm Full Autonomy from the terminal too: `dorkos config acknowledge-autonomy` (DOR-1247)
- Open a profile from a message's face, a member list, or the "working now" strip (DOR-1251)
- Jump to "View profile" from a message's hover, right-click, or long-press menu (DOR-1251)
- An agent's profile opens onto its conversations, tasks, rooms, skills, tools, and connections (DOR-1253)
- Each profile row shows what's behind it — and loads its real count instead of showing zero first (DOR-1253)
- Change an agent's runtime, model, thinking effort, or personality right from its profile (DOR-1253)
- Pick an agent's colour, emoji, and personality together on its Appearance page (DOR-1253)
- Manage an agent — default, block, unregister, or delete — from its profile's ⋮ menu (DOR-1253)

### Changed

- An agent you call into a thread reads that thread, plus a short glance at recent channel messages (DOR-1207)
- Several people talking at once now get one considered reply, not several rushed ones (DOR-1201)
- A message sent while an agent works is folded into its next answer instead of getting missed (DOR-1201)
- Stop in a room really is the end of it — the reply is cancelled, not just hidden (DOR-1201, DOR-1232)
- Your agents' hourly reply limits now survive a restart (DOR-1205)
- If your database won't open, DorkOS stops and tells you — it never rebuilds over your data (DOR-1224)
- A profile is now a picture up top and rows you tap to open full pages (DOR-1252)
- An agent's profile shows who manages it; a person's profile lists the agents they run (DOR-1252)
- Edit your name, handle, and photo from your own profile too (DOR-1252)
- A profile explains what's happening in plain words — "Working in #team," "Last active 3h ago" (DOR-1252)
- Message only appears as an option when there's somewhere for it to go (DOR-1252)
- A profile lists every room that person or agent is in; tap one to go there (DOR-1252)
- The right panel's "Agent Profile" tab is now simply Profile — the same profile as the Team page, docked beside your session; ⌘⇧A still opens it, and old Agent Hub links land there (DOR-1254)
- A profile opened from inside another one links back to where you came from, and profile links open even from a different agent's session (DOR-1254)
- `dorkos config set` tells you the value it actually saved, or exactly why it couldn't (DOR-1247)
- Pressing Stop with messages waiting puts them back in your composer, after asking first (DOR-1199)
- The queued-messages header now matches the rest of chat's style (DOR-1246)

### Fixed

- DorkOS tells you when an agent can't be readied to reply in a room, instead of staying silent (DOR-1206)
- Rooms keep track of an agent's real conversation across a restart, even mid-reply (DOR-1205)
- Rooms that lost track of their agent's conversation are repaired automatically at startup (DOR-1205)
- A long conversation shortening now shows a marker in the chat, live and in history (DOR-1215)
- A settings file from a newer DorkOS build no longer looks "damaged" to an older one (DOR-1221)
- Rescued settings backups now keep every version, with a timestamp, not just the last one (DOR-1221)
- A failed settings upgrade stops and tells you — it no longer wipes your settings (DOR-1221)
- A helper finishing mid-task no longer cancels your agent's file writes (DOR-1238)
- A successful "shorten this conversation" no longer shows as a crash (DOR-1235)
- A failed conversation-shortening now gives one clear reason, not two confusing messages (DOR-1235)
- A turn that never starts now ends after two minutes with a clear reason (DOR-1229)
- A setting a newer build wrote no longer wipes your whole config — DorkOS skips just that one (DOR-1227)
- DorkOS names any skipped settings at startup, in `dorkos doctor`, and in `config validate` (DOR-1227)
- The "make this my default" offer now leaves the screen when you switch conversations (DOR-1237)
- While an agent plans, the status bar shows one Plan control, not two confusing ones (DOR-1236)
- Clicking a button in a reply works right after the agent finishes, no "locked" error (DOR-1239)
- A message meant for one agent no longer lingers as a draft in another agent's composer (DOR-1242)
- Restarting DorkOS no longer fires off an old channel message days after the fact (DOR-1242)
- When a channel truly can't get an answer, it says so right away, not an hour later (DOR-1242)
- Changing a setting from the CLI now asks for consent, the same as the app does (DOR-1247)
- `dorkos config set` checks your value before saving and tells you if it's invalid (DOR-1247)
- Reading settings works even when DorkOS can't write to its own folder (DOR-1247)
- Saving a setting to a folder DorkOS can't write to now gives one plain-language error (DOR-1247)
- Writing an agent's instructions or boundaries now actually saves them (DOR-1253)
- Changing one thing about an agent — like its model — no longer erases its description (DOR-1253)
- Renaming an agent updates its name everywhere at once (DOR-1253)
- "Saved" now only shows once your change is stored; a refused save keeps your edits in place (DOR-1253)
- The instructions editor counts your whole file, so you see the limit before you hit it (DOR-1253)
- Leaving an unsaved instructions or boundaries edit now asks before discarding it (DOR-1253)
- Changing an agent's personality from its profile now reaches the agent, not just the setting (DOR-1253)
- Clearing an agent's name now restores its old name instead of leaving it blank (DOR-1253)

## [0.59.0] - 2026-08-12

### Added

- You can now sign in to MCP servers that need OAuth, like Granola. Ask an agent to sign you
  in, open the link it gives you, and approve access in your browser. DorkOS keeps the sign-in
  token encrypted on your computer and sends it to the server for you, so the server's tools
  start working on the agent's next reply. DorkOS refreshes the token quietly before it runs
  out, and it remembers your sign-in if you restart. If a server needs you to sign in again,
  checking it now says "needs sign-in" in plain words instead of a raw error. One thing to
  know for now: if a server signs you out while you are working, DorkOS may not notice until
  the next time you check that server, so sign in again to fix it (DOR-942).
- When an agent needs your OK for something it cannot undo, like adding a tool server, it now
  waits for your answer and picks up the moment you approve. The request shows up as a card right
  in the chat, and saying yes there lets the agent keep going without you having to tell it to try
  again. The agent waits about ten minutes; if you take longer it stops waiting and the chat says
  what it asked and that it moved on without an answer. That goes for anything an agent waits on
  you for — a question it asked you, or a sign-in prompt from a connected server, as well as a
  tool approval. An approval is still there in your Approvals list — answer it, then tell the
  agent to try again, exactly as before this existed (DOR-939, DOR-1158)
- You can now sign in to an MCP server that needs OAuth right from the agent's server list,
  without asking an agent to do it for you. When a server needs a sign-in, its row shows
  "Needs sign-in" and a Sign in button. Click it, read what DorkOS will do with your sign-in,
  then open the link and approve access in your browser. DorkOS keeps the sign-in for you, and
  the server's tools work on the agent's next reply.
- You can now tap and hold a person's or agent's name (like an `@mention` in a room) to see
  their identity card on a phone or tablet — the same card you already got by hovering with a
  mouse. A quick tap still does nothing, so it won't be mistaken for a button, and holding a
  mention no longer also opens the message's actions menu underneath it, or leaves some other
  open menu stuck on screen (DOR-953)
- One list of everyone on your install — you and your agents together — behind the new `GET /api/team`. It reads the records DorkOS already keeps instead of making new ones, shows your real name rather than "You", and says which agents are yours. If something can't be read, you still get the rest of the list with a note about what was missing: a roster that can't say your name will still list your agents. The Team page that shows this is coming next (DOR-971).
- Hovering an agent's `@mention` in a room now tells you how that agent runs — the runtime it
  is on, and the model it starts on when it names one. Agents that just take their runtime's
  default model show the runtime alone, and an agent DorkOS has no details for shows nothing
  extra rather than a made-up answer (DOR-954).
- Every agent in a room now has an `@handle`: one short name that reaches exactly them. DorkOS makes it from the name you gave the agent. Agents whose name has a space in it, like "Art Blocks Analytics", could not be reached by `@` at all before. Now they answer to `@art-blocks-analytics`. (DOR-676)
- Two agents with the same name get different handles, so a message can only ever reach one of them. The second becomes `@api-server-2`.
- People writing in from Telegram get a handle that carries the platform they came from, like `@miguel.telegram`. Nobody on another service can take a name your agents answer to.
- Your own handle is not set yet, and DorkOS will not guess one for you. Rooms say you have no handle instead of inventing an address that reaches nobody. The screen for picking it is coming with the profile work.
- Add a server that needs a sign-in and DorkOS says so immediately. It checks the address as
  it saves it, so the "Sign in" button is there the first time you look — you no longer have
  to press Test to find out (DOR-1003).
- When you finish signing in, DorkOS tells you how many tools you just unlocked — "Connected —
  12 tools." — instead of only saying it worked (DOR-1003).
- The page you land on after signing in now names the server you signed in to, says what
  happens next in plain words, and gives you a link back to DorkOS (DOR-1003).
- Ask your agent to connect something, like your meeting notes or your issue tracker, and the
  sign-in link now shows up as a card right there in the chat. Above the link is a plain note
  about what DorkOS does with your sign-in. You do not have to go hunting through settings,
  and your agent no longer repeats a long link you can already see. Click it, sign in, and
  come back. Your agent picks the job back up on its own and carries on with what you asked
  for. It will not announce that it connected, and it will not ask you to tell it when you
  are done (DOR-1004).
- You can sign in however you like and it still works. Close the tab, reload the page, or
  finish on your phone. The agent still gets going again on its own (DOR-1004).
- Once the sign-in lands, the card turns into a short note saying what you connected and how
  many tools it added, so you can see it worked. The note sticks around while your agent gets
  back to work, then the chat moves on. The moment your agent picked the job back up stays in
  your chat and names the server, so you can still find it later (DOR-1004).
- The card stays put while you are away signing in. If you open a new tab in the meantime, it
  shows the card too (DOR-1004).
- Adding a server that needs a sign-in now takes you straight into it. Before, you were
  dropped back at the list and had to find the new row and press a button (DOR-1004).
- People and agents can now carry a photo, alongside the name, emoji and colour they already had. Wherever the app draws a face — a room roster, a message, the card that opens over a mention — the photo is what shows, with the emoji as the backup if it will not load. Nothing sets a photo yet; the page for choosing one comes next. (DOR-975)
- A profile photo can now be stored, and it stays on your own machine — under your DorkOS data folder, not in anyone's cloud. PNG, JPEG and WebP up to 2 MB; DorkOS checks what a file really is rather than trusting its name, and turns away anything else. Once stored, the photo shows up under the same name everywhere on the roster and in your account, so the two can't disagree. **There is still no page for choosing one** — this is the storage underneath, reachable only through the API for now; the Settings screen that asks for a photo is next. (DOR-976)
- Some services will not let DorkOS sign itself up automatically — they want you to register an
  app with them first and hand over the ID it gives you. That used to be a dead end. Now, if a
  sign-in fails for that reason, the server's card offers "Use your own app credentials": paste
  the ID (and the secret, if you got one) and sign in normally. What you paste is kept encrypted
  on this computer, the agent never sees it, and the card's Details afterwards says the server is
  using your own app credentials (DOR-982).
- A profile panel for everyone on your install. It shows who a person or an agent is, what an agent runs on, and who it belongs to. Your own row also shows your email. The panel keeps its own web address, so a reload or a saved link brings the same profile back. It opens beside the page on a computer and fills the screen on a phone.
- **A Team page.** The sidebar's Agents entry is now **Team**, and it opens one roster of everyone on your install: you, and every agent you run. You are always on it, even before you register a single agent.
  - **You can tell a person from an agent at a glance.** A person is a circle. An agent is a filled square with a small robot mark. Someone reaching you from another app, like Telegram, gets that app's mark. The shapes are the same everywhere else in DorkOS.
  - **Every agent says who it belongs to.** A line under the name reads "by @you". Click it and the roster narrows to that person and their agents. DorkBot has no owner line, because it belongs to the install rather than to a person.
  - **Filter, group, and search.** Narrow to just people or just agents, cluster each person's agents under them, or type a name. Every control writes to the address bar, so a filtered roster is a link you can bookmark or send. The filters follow you between views: narrow the cards, switch to the table, and you are looking at the same people.
  - **Five views, one page.** Cards is the roster. Table is your agents in columns, now with a "Managed by" column. Topology, Denied, and Access are unchanged, and all three moved here from the old Agents page. On a phone the table is not offered: six columns at that width is a scroll bar pretending to be a table.
  - **An old link still gets you there.** A saved address that names a view DorkOS no longer has now opens the roster instead of an error page.
- Your face now sits in the bottom-left corner of DorkOS. Click it for your name, your @handle, a link to your profile, Settings, and — if you have a login on this machine — a way to sign out. On a phone it opens as a drawer you can swipe away.
- **Settings › Profile**, now the first tab. Upload a photo, set the name DorkOS calls you, and claim the @handle people and agents use to reach you. Your photo shows up everywhere you appear: your team page, every room, and beside everything you write.
- If a handle you want is already someone else's, or is spoken for, or isn't spellable as a handle, the form says which of those three things happened — and what to do instead — rather than just refusing.
- Click a face to see who it is. Names and avatars now open a profile: an @mention in a room, a card on the Team page, an agent's picture in the sidebar, the agent chip above the chat box, and an agent in the network view. The profile keeps its own web address, so you can reload the page or send someone the link and get the same profile back. On a phone, tap the name instead of holding it.
- Right-click a file or folder in the Files panel to show it in Finder (or File Explorer), copy its full or relative path, or add it to the chat as an `@` reference (DOR-1032)
- Agents now know what was said in a room while they were not answering. When an agent takes
  a turn, it is shown the messages it has not seen yet — not only the one that woke it up —
  so an agent pulled into a busy channel arrives knowing what the conversation is about
  instead of reading one line out of fifty. Listening still costs nothing: a message that
  addresses nobody starts no turn (DOR-665)
- Copy and paste files in the Files panel — from the right-click menu or with Cmd/Ctrl+C and Cmd/Ctrl+V. A copy that would land on an existing name is renamed the way your file manager does it (`notes copy.md`), and Duplicate makes one beside the original in a single step (DOR-1032)
- Hold Alt while dropping a file in the tree to copy it instead of moving it, and drop one in the empty space below the tree to move it to the top level (DOR-1032)
- Drag a file or folder from the Files panel into the chat box to add it to your message as an `@` reference. Files dragged in from your desktop still upload as before (DOR-1032)
- Paste tells you when a folder cannot go where you asked, and the menu greys it out where it would not work, instead of looking like nothing happened (DOR-1032)
- **Send files in a room.** Click the paperclip, drag a file onto the message box, or paste one in,
  then send it with your message. Pictures show up right in the conversation; everything else shows
  up as a chip you can click to download. Only the people and agents in that room can open them.
  The agents in the room get your files along with the message, with nothing to approve.
- Extensions can now pass `visibleWhen` when they add a section, so a section can hide itself on the days it has nothing to say instead of showing an empty card.
- Click into the empty box on Home and the last few things you were in float up above it: chats with your agents, channels, and direct messages, newest first. Press the arrow keys to move through them and Enter to open one, or just click. Escape puts the list away, and so does typing — once you start writing, it stays out of your way until you come back to the box.
- The list is the same one in the sidebar, so the two can never tell you different stories about where you left off. Rooms you have muted stay out of both, and a direct message shows the same agent's face in both.
- DorkOS now keeps one record of where you have read up to, for every kind of conversation you
  have — rooms, chats with your agents, and your inbox. It is yours alone, and it tells your
  other open screens the moment it moves, so nothing waits on a refresh. Your agents keep their
  own separate place in a room, and nothing they do there moves yours
- Every install now gets a **#team** channel: you and DorkBot are in it from the start, and each
  new agent you make joins it automatically, ready to answer when the room is talking to it
- Nobody but you can rename or archive #team. Agents in the room can change its topic and talk
  in it, but they cannot take your home room away. You can still mute it
- **What needs you stays at the top of Home.** Approvals an agent is waiting on, and anything that broke — a stalled session, a failed run, an agent you cannot reach — now sit pinned above the Home feed instead of scrolling away with it. When there is nothing waiting and nothing wrong, there is no header at all: no "all clear" box, no empty strip.
  - **Answer where you are.** Allow or refuse a request and the card ticks and clears on the spot. Nothing jumps, nothing reloads, and the page underneath does not move. If an answer cannot go through, the buttons come back rather than leaving a tick over a request that is still waiting.
  - **It gets out of the way when you type.** Tap the message box on a phone and the header shrinks to one line — "2 waiting · 1 needs attention" — so the keyboard does not push what you are writing off the screen. Tap that line to open it back up.
  - **Keyboard and phone.** Answering a card moves you to the next one instead of dropping you nowhere. On a phone the small buttons are easier to hit without getting bigger, and a screen reader hears what arrived.
  - **A failure still speaks up.** If DorkOS cannot read the approval list, it says so and offers to try again — an approval you never see is an agent stuck waiting on you.
- Type in **#team** without naming anybody and your default agent answers. No `@` needed, and
  the rest of your team stays quiet instead of all piling on
- Name somebody with `@` and only they answer — and they stay the only one, including when
  they write back. Your default agent steps back rather than doubling up on a question you
  already handed to someone else, unless you named it too or you were already talking to it
- Setting an agent to "Everything" from a room's member list still means everything. Only the
  default agent's seat steps back, and changing your default agent never touches a choice you
  made yourself
- Pick a different default agent in Settings and the next thing you type in #team goes to the
  new one — no restart. The old one goes back to only answering when you address it
- If the agent named in Settings isn't on this machine any more, DorkBot picks up what you type
  instead of it going nowhere
- **See who is working, and look over their shoulder.** One line at the bottom of the Home header shows the agents working right now — "tangerines · replying in #release-train", "DorkBot · working in a session" — and clicking one takes you there to watch. Watching is all it does: it never takes over the conversation, never interrupts the turn, and never stops the agent mid-thought.
  - **It stays one line, however busy things get.** Past five agents it shows the first few and counts the rest, so a busy morning never pushes your feed down the screen.
  - **It would rather say less than say something untrue.** An agent DorkOS cannot put a name to does not appear at all, and work it can name but cannot place shows the name with nothing invented after it.
  - **When nobody is working there is no line.** No "all quiet" strip, no empty space held open — the header simply is not there.
- Your first morning in #team starts with something to say. Four openers sit above the message box, and pressing one writes it into the box for you to edit or send. They go away as soon as there is a real conversation to read.
- A morning where nothing happened now says so: "All quiet." If a scheduled run is coming, it names the run and the time. If there is nothing real ahead, it stops after those two words instead of making something up.
- The first time you open Home each day, the room fades in rather than snapping on. Every other visit that day is instant, and so is every visit if you have asked your system for less motion.
- The chat message box now formats as you type. `**bold**` turns bold as you close the second
  pair of asterisks, `- ` starts a bullet list, `# ` makes a heading, and `` `code` `` becomes
  code. Enter still sends your message — except inside a list, where it starts the next bullet,
  and an empty bullet ends the list. Anything the box does not preview, like quotes, code blocks,
  links and tables, stays as you typed it and still renders when the message is sent. If you would
  rather see the plain markdown characters, there is a switch in Settings → Advanced →
  **Format text as you type**. This applies to chat for now (DOR-948)
- Settings → Tools has a new **Background systems** section with one switch for scheduled runs
  and one for agent messaging. Turning a switch off stops DorkOS from starting that system, and
  its tools go quiet with it. Until now the only way to do that was to hand-edit your config
  file. DorkOS starts these systems once, when it starts, so the row says plainly that your
  change takes effect the next time DorkOS starts rather than pretending it already has. If a
  `DORKOS_TASKS_ENABLED` or `DORKOS_RELAY_ENABLED` variable is set in the server's environment,
  the switch says so and stays locked, because that variable is what decides.
- **Your team room marks the moments that matter.** #team now says when something
  real happens: an agent joining ("tangerines joined your team"), your first
  schedule, your first connection, the first run that finished overnight, a week
  or a month with an agent, and a week where something ran every single day. Each
  one shows up as its own kind of post in the feed, with the face of whoever it is
  about.
- Every moment is read from your own records, so the numbers in one are counted
  rather than guessed, and each lands once and never again — restarting DorkOS
  does not repeat it. The room marks at most one an hour, so an afternoon of
  setting things up does not fill your feed with milestones.
- On a quiet morning, DorkBot may add one gentle suggestion under "All quiet." — something you don't use yet, like setting up a schedule. One line, quieter than the line above it, and only when it fits what you actually have set up: you won't be offered scheduling if you already schedule. Dismissing it is a single press, and it's remembered — the same suggestion doesn't come back, on home or in the sidebar (team-room-home 4.5).
- **Come back to a summary instead of a scroll.** After a few hours away, each
  agent that actually did something while you were gone leaves one line in #team
  saying what it worked on and when it last changed. Agents that did nothing new
  stay quiet, and at most three lines land however many agents qualify.
- The lines are read from your own sessions, so they say what happened and
  nothing more. No agent is woken up to write one, so coming back costs you
  nothing, and work an agent already posted in the room is left out because you
  have read it.
- You decide whether this happens at all. The switch is in Settings →
  Preferences, and turning it off means no notes and no looking, not fewer notes.
  It is stored on your server, so it follows you to every device you open DorkOS
  on. Four hours is what counts as being away, and three is the most notes one
  return can produce; both are settings in your config file if you want different
  numbers: `dorkos config set welcomeBack.absenceThresholdMinutes 720`.
- Every session's current tool now rides the fleet-wide status stream, so
  anything watching your agents — not just the chat you have open — can say what
  each one is working on (DOR-1053)
- **A link can bring the question with it.** Add `?prompt=` to a session address
  and DorkOS opens a new chat with those words already in the box — yours to
  read, change, or send. Add `&send=1` and it sends them for you, so the agent is
  already working by the time you look at the screen.
- It sends once. Refreshing the page or pressing Back will not send it a second
  time, because the address drops both settings the moment they are used. And it
  only ever starts a conversation: pointed at a chat that already has messages,
  or at a box you have started typing in, the link does nothing at all.
- **⌘K now finds your conversations.** Type a few words from a chat's title and it comes
  up, whichever agent it belongs to and whenever you last touched it. Press Enter to go
  back to it, or ⌘Enter to start a fresh chat with the same agent. Both shortcuts are
  written on the row you have highlighted, so you never have to be told about them.
- Each conversation reads the way it does in the sidebar: the agent's face, the agent's
  name, then the title — plus a small mark when the chat started somewhere other than
  with you (a scheduled run, a message from Telegram, a room), and when it last moved.
- ⌘K searches what things are **called** — chats, agents, channels, actions — and never
  what was said inside them. Searching your messages stays a separate thing.
- Sidebar rows can now say what an agent is actually doing — "Editing RoomRow.tsx…",
  "Running pnpm test…", "waiting on you" — and say nothing at all when a session is idle.
  The rule is deliberately honest: if we do not know which tool is running, the row says
  "Working…", and if the turn is over it says nothing rather than leaving an old phrase up.
  A verb that outlives its turn is just a lie in a small font.
- **The session switcher.** When an agent has more than one conversation going at once,
  its sidebar row shows a small "2 live" chip. Click it — or find the agent in ⌘K and
  pick "Browse sessions…" — and you get every conversation that agent has, in three
  groups: the ones running right now, each saying what it is doing ("Editing
  RoomRow.tsx…"); the ones you finished, each with the last thing that happened in it;
  and everything that started without you — scheduled runs, messages from Telegram —
  tucked away until you ask for them. The one you have open is marked. Press Enter to
  jump into a conversation, ⌘Enter to start a fresh one, or Shift+Enter to branch off
  a copy and leave the original alone. It opens as a panel on a computer and slides up
  from the bottom on a phone (DOR-1071)
- The top of the sidebar is now a **Heads up** zone: the things that are actually waiting on you.
  Only four things are allowed in — an agent asking permission, an agent asking a question, a
  session that stopped with an error, and one gentle nudge about a session that went quiet.
  Mentions, unread channels, direct messages and background work never appear there, so a Heads
  up zone with something in it always means something (DOR-1067)
- Heads up shows at most three things plus a "+ N more" row that takes you to the home page, where
  the full list already lives. It never scrolls, and agents that are busy working are summed
  into a single "N working" line instead of a row each. That line counts the conversations you
  started — a scheduled run working away in the background is not something that needs you, so
  it stays where it belongs and is never counted here. If one of your scheduled runs does get
  stuck or asks you something, it still comes to Heads up like anything else
- When the last thing needing you is done, Heads up says "All clear" for a moment and then folds
  away. If you have asked your system for less motion, it simply disappears
- A new **Getting started** zone takes the place of Heads up on a fresh install. It suggests what you have
  not done yet — add your first agent, ask DorkBot something — and each suggestion retires for
  good once you have done it, even if the thing it was about goes away again later
- **Ask DorkBot** opens a fresh conversation with DorkBot that already knows the situation:
  which page you were on, how many agents you run, which version you are on and which
  conversations just failed. None of it is typed for you — the box you land in is empty and
  waiting, and DorkBot simply starts out knowing where you came from. If something cannot be
  worked out, it is left unsaid rather than guessed (DOR-1070)
- Come back after a few hours away and your agents already leave a short note about what moved. Now
  a note can also end with **one thing the agent wants you to decide** — "want me to open the PR?".
  There is no way to know an agent has a next step without asking it, and asking runs that agent
  for a turn, so it has its own switch that says so: Settings → Preferences →
  **Next-step offers**. Only the agents that already left you a note are asked, and each of them
  only once. An agent with nothing to offer says nothing; an agent that is busy or runs into
  trouble stays quiet too, and you still get the notes either way (DOR-1046)
- When an OpenCode agent hands work to one of its subagents, you can now see it happening. The
  subagent shows up in the activity feed with its own card, the "working" line counts it while it
  runs, and the card keeps a running tally of the tools the subagent has used. Before this, a turn
  that delegated looked exactly like one that did not. Stop the turn partway, or stop the parent
  OpenCode agent while the subagent is still working, and the subagent is marked stopped, not
  failed — instead of ending with a shrug, marked as something DorkOS lost track of (DOR-1109)
- **Next-step offers start on.** When your agents leave you a welcome-back note, the note can end
  with one thing the agent wants you to decide, and you do not have to go and find a switch first.
  It is the one part of coming back that costs anything — the only way to know an agent has a next
  step is to ask it, and asking runs that agent for a turn — so the switch says that in plain words
  right next to it: Settings → Preferences → **Next-step offers**. Turn it off and it stays off.
  Nothing puts it back: not an update, not starting your settings over (DOR-1121)
- **Today** is the middle of the sidebar now: the conversations, channels, direct messages and
  threads you have actually been in. It is ordered by when **you** last touched each one — so
  your recent conversations stay put while your agents work. An agent starting a turn, finishing
  one, or posting a message moves nothing.
- The conversation you have open is always Today's first row, and it shows what that agent is
  doing right there. When you switch conversations it scrolls into view; it will not scroll for
  anything else, and it never opens a section you folded away.
- Rows also refuse to **reorder** while your pointer is inside Today or a row has your keyboard
  focus. If the order legitimately changed while you were reading, it applies the moment you
  move away — so the row under your cursor is still the row you meant to click.
- Scheduled runs, room turns and other work you did not start sit behind one **+ N automated**
  row. Press it to see them, press it again to put them away. If one of them needs you, it
  still appears in **Heads up** like anything else.
- Threads sit in Today as conversations of their own, showing the message they hang off, and
  clicking one opens that thread beside its channel rather than just the channel.
- After you have been away, Today can open with a single **While you were away…** row that
  takes you to what your agents got done. It appears at most once a day, only when something
  actually finished, and only if you have welcome-back notes switched on. Opening any
  conversation dismisses it.
- Anything you have not touched since 4am quietly leaves Today the next morning — except the
  conversation you have open and anything addressed to you by name. Nothing is deleted: it is
  all still one ⌘K away (DOR-1068)
- Send a message to an agent that is already working and it is taken right away,
  with no error bouncing it back at you. It waits in a queue and goes the moment
  the current turn finishes. The queue lives on the server, so it survives a page
  refresh and a server restart, and every window you have open sees the same one:
  open the session in a second tab or on another device and your queued messages
  are there. Any window can reword one, move it earlier, send it next, or take it
  off the line, and a message queued from somewhere else is marked as coming from
  another window. Nothing you type is lost on the way — your words stay in the
  message box until they are safely in the queue (DOR-1131, DOR-1132, DOR-1133)
- ⌘K can now search **inside** one agent or one channel. Type `@` or `#`, land on the one you
  want, and press Tab — it becomes a chip in the search box, and what you type next only looks at
  that agent's or that channel's conversations. Backspace with the cursor at the start puts the
  chip down again and keeps what you typed. There is no search syntax to memorise: the chip is on
  screen the whole time, so you can always see what you are looking inside (DOR-1075).
- ⌘K now says when something it found is no longer current. A conversation where nothing has
  happened since early this morning, and a channel somebody has closed, both carry a small
  **Archived** label. You can still find them by name and still open them — the label is only
  there so a row cannot look like part of today's work when it is not (DOR-1076).
- **Press and hold any row on your phone** to get the same list of things you can
  do that a right-click gives you on a computer — mute a channel, move an agent
  into a group, rename, archive. It rises from the bottom of the screen with
  everything in one list, so nothing is hidden behind a second menu. A press that
  turns into a scroll never opens it, and it never opens the conversation you
  were only trying to scroll past.
- **"Catch up" at the top of Today** clears every unread conversation in one tap.
  It only shows up on a phone, and only when there is something to clear.
- **Approvals now appear in Home on your phone**, with Allow and Don't allow
  right on the card. You can unblock an agent from the queue for coffee without
  opening anything. If DorkOS cannot check whether something is waiting, it says
  so and offers to try again rather than showing you an empty screen.
- **A page that explains your sidebar.** "Your sidebar", in the docs under Concepts, says what
  Heads up, Today and Library are each for, why the first two are worked out for you and the
  third is yours to arrange, and where the things that used to be in the sidebar went. It ends
  with the four tabs on your phone and the three things that work differently under a thumb.
  We chose to write this instead of a pop-up tour, because a page is there the second time you
  wonder (DOR-1079)
- Claude Code chats can now keep their agent running between messages. Normally every message
  you send starts the agent up again and shuts it down when the reply is done; with this on, the
  agent stays running in between, so your next message reaches one that is already awake.
  Turn it on with `runtimes.claudeCode.persistentSession`. It ships off, and it applies to the
  next message you send in each chat — nothing you have open changes underneath you. An agent
  that has been sitting idle is shut down for you after a few quiet minutes, and you will not
  notice: your next message picks the conversation up exactly where it left off (DOR-1175)

### Changed

- `list_capabilities` now returns a short, filterable list instead of the whole catalog at once. A plain call gives you one compact line per capability (id, title, tier, and a summary), so discovering what a DorkOS can do no longer floods an agent's context. Narrow it with `domain` (e.g. `mcp`) or a `query`, ask for `detail: "full"` to see the input and output schemas, and page with `limit` and `cursor`. A search only expands to full detail once it narrows to a handful of results, a page that leaves something out says how many and how to see the rest, and a search that finds nothing says so plainly (DOR-940).
- Each MCP server now shows its status in plain words (Connected, Needs sign-in, Failed, or
  Disabled), not a color dot with no label. Testing a server that needs a sign-in now says so
  and points you to the Sign in button, instead of showing a raw error (DOR-943).
- Sending messages between agents stays fast as message history grows — the rate limiter now looks up a sender's recent messages through an index instead of scanning the whole list every time.
- Agents now look like agents everywhere in the cockpit. Tell an avatar what an identity is — an agent, a person, the room's own voice — and it draws the right shape, fill and corner mark on its own, instead of each screen deciding for itself. Agents are filled squares with a small bot mark; people stay round, with a platform mark when they are writing in from somewhere like Telegram. (DOR-967)
- An agent that is busy now pulses the same green dot everywhere, in your theme's own colour, and the dot stays put (without the pulse) if you have asked your system to reduce motion. (DOR-967)
- The chat message list and the hover card that opens over a name now share one rule for drawing agents and people, so an agent always looks like an agent everywhere you see it. (DOR-969)
- The agent picker in a room's add-agent dialog now draws every row as a filled square, the same shape agents get everywhere else, instead of a round dot. (DOR-969)
- The avatar next to an approval request now looks like an agent, too, whenever DorkOS can confirm one made the request. (DOR-969)
- A server DorkOS holds a sign-in for, but has not talked to yet, now reads "Signed in" rather
  than "Connected". "Connected" means the server actually answered.
- Display names no longer work as addresses. Typing `@Ana Reyes` used to reach whoever the room happened to list first. Now only a handle reaches somebody, and each handle belongs to one agent or person. Messages you sent before this change are untouched.
- Changing a handle is safe. Every message already sent still reaches the right agent, and the handle you leave behind stays yours to take back. Nobody else can claim it.
- Every MCP server on an agent is now a card instead of a cramped row. The card says the
  server's name, where it came from, how it is doing, and one plain sentence about what to do
  next — with the single button for that one thing right underneath. Everything else lives
  behind a "⋯" menu. Long names no longer get chopped to "plugin:cont…" (DOR-1005).
- Each card says where its server came from: added to this agent, from this project, from a
  plugin, or from your computer-wide setup. Hover the badge and it explains itself. A server
  a plugin brought with it shows its clean name, with the raw one kept in Details. When
  DorkOS cannot tell where a server came from, it says nothing rather than guessing
  (DOR-1005).
- The cards are sorted when you open the panel — anything that needs you goes to the top —
  and then they hold still. A card you are in the middle of signing in to will never slide
  out from under you. The next time you open the panel, it sorts again. The sort waits for
  everything DorkOS knows about your servers to arrive first, so a server that cannot be
  reached always makes it to the top instead of getting stranded at the bottom (DOR-1005).
- Plain words replace the system's own: "Needs sign-in", "Can't reach", "Setup problem",
  "Uses your key", "Off". A server nothing has checked yet now says "Not checked yet" instead
  of spinning on "Connecting…" forever. The exact error a broken server gave has moved into
  Details, where you can read it when you want it (DOR-1005).
- Signing in shows a short, calm note first: your sign-in stays on this computer, the key is
  kept here, and the agent never sees it. It is said once, in one box, whether you are signing
  in from settings or from a card your agent put in the chat. There is now a Cancel button if
  you change your mind (DOR-1005).
- Cards have a Details section. It says how the server signs in, where it lives — the web
  address for a remote one, the command for one on your computer — and, for a broken one, the
  exact error. It only shows what it actually knows, and a card with nothing to show does not
  offer Details at all (DOR-1005).
- The on/off switch is on every card now, not just some. A server you have turned off is
  dimmed with its switch off, and flipping it back on is all there is to it (DOR-1005).
- Adding a server the project already had now says what you get — "Manage it here to enable,
  disable, or sign in from DorkOS" — instead of talking about bringing it under management
  (DOR-1005).
- When a sign-in cannot get started, you now get a sentence you can act on instead of an OAuth
  error. "This server doesn't let DorkOS register itself." "This server doesn't offer sign-in the
  way DorkOS expects." "Couldn't reach the server." The exact technical error is still there,
  tucked behind Details for when you want it (DOR-982).
- **`/agents` now takes you to `/team`.** Old bookmarks, docs links, and saved desktop tabs keep working, and they land on whichever view you had open.
- The message box in a room now sits in the same rounded card as the one in chat, instead of a strip ruled off with a line. Rooms and the home screen used to draw their own version of the box; there is one box now, in one place, so it looks the same everywhere you type. Typing, sending, drafts and shortcuts all work exactly as they did. (DOR-946)
- The Codex runtime is running a newer version under the hood. Its connections to outside
  tools (MCP servers) now recover on their own instead of stalling a turn. No visible
  change in what you do; just fewer rough edges when Codex is running. (DOR-1012)
- The engine behind your Claude Code sessions moved up to a newer version. It carries about two months of fixes from Anthropic, listed below. (DOR-1014)
- Pinning a session to one exact model now gets you that model's real abilities. Before, DorkOS only knew the abilities of the short names like "sonnet", so a session pinned to a full model id fell back to generic defaults. Thinking and effort settings now match the model you actually picked. (DOR-1014)
- The menu item that opens an agent's panel on the right is now called "Agent hub" instead of "Agent profile". It still opens the same panel. Two things one click apart were both called "profile", and only one of them is.
- Faces, names, and cards now answer when you point at them. A card on the Team page lifts a little and picks up a hint of that agent's own color. An avatar you can click rings itself in its color. A mention in a room gains a touch more color. Before this, most of these just sat there, and you found out something was clickable by clicking it.
- Clickable faces no longer fade when you hover them. Fading is how the whole app says "you can't use this", so your own avatar and every agent lockup were quietly reading as switched off. They use color now instead.
- You can reach all of it with a keyboard. Anything that responds to the mouse now responds to Tab the same way — a Team card lights up the whole tile when you Tab to it, not just the name — including the agent chip above the chat box, which had no keyboard highlight at all.
- On a Team card, pointing at "by @name" calms the card down, so it is clear you are about to filter the roster rather than open a profile.
- A profile panel carries a thin line in that person or agent's own color when there is something under the header, so you can tell whose panel you have open at a glance.
- "View profile" on a hover card no longer looks like a button on the surfaces where it does not work yet. It only wears the accent color where pressing it actually opens something.
- If you have asked your system for less motion, none of this moves. You get the finished state right away.
- Cards on the Team page now slide to their new spots instead of jumping. Flip "Group: manager" and every card travels to its owner's cluster, so you can see where each one went. Narrow to People or Agents and the cards leaving fade out without shoving the ones that stay. On a very large team — more than 120 cards — they go back to appearing in place, because a hundred things moving at once is not something you can follow.
- Pointing at "by @name" on a Team card now tells you how many agents that person has, right beside their name. It answers the question the card was making you count for yourself. Tab to it and you get the same thing.
- The profile panel opens faster. It used to take half a second to slide in, which you noticed every single time — especially when you only opened it to read a project path. Now it is there in a third of a second.
- Point at an agent's card and its little robot mark leans in. Only where the face belongs to something you can actually press, so the long list of agents in the sidebar stays still.
- All of the above still respects "reduce motion": cards stop travelling, the robot mark stays upright, and the agent count appears without a fade. Nothing you need is hidden behind movement.
- An agent is never shown messages from before it joined the room, and one turn catches up on
  at most the last 30 messages, so the first turn in a long-running channel no longer replays
  the whole history. When older messages are left out, the agent is told so
- A turn no longer sees the same message twice. The agent's place in the conversation moves
  the moment its turn starts, so a turn that runs and then breaks does not repeat itself on
  the next one. If the turn never started — the agent was already busy, or nothing could
  reach it — the messages stay unread and are waiting on its next turn instead
- Read a room on your laptop and your phone catches up straight away. The unread dot on the
  other screen used to hang around for up to half a minute, so a room you had just finished
  reading still looked like it wanted you. The room now says so the moment your place in it
  moves, and every screen you have open agrees — including the count in the browser tab.
  Only your own reading counts: an agent working through a room never clears your dot.
- Home, Activity, Scheduled and Workspaces are one screen now, switched with a tab bar across the top instead of four separate stops in the sidebar. Every link you already have still works: the addresses have not changed, and a saved link with filters on it lands on the right tab with those filters still applied. The tab that opens your scheduled runs is called Scheduled, and the title above it now says the same word. The page that used to be called Dashboard is called Home.
- The sidebar's "Recent" list is now "Jump back in", and it covers everything you were last in — your channels and direct messages as well as your agent chats, newest first. Each row says what last happened there: how many messages are waiting, who is working, or the last thing said. A room shows up once, as the room; the turns your agents took answering in it no longer sit beside it as separate rows. Rooms you have muted stay out of the list, and the row you are already looking at is marked as the one you are on.
- Home is quieter. The promo card grid, the "Your agents" grid, and the System Status row are gone. Nothing they told you is lost: your team lives on the Team page and in the sidebar, schedules on the Scheduled tab, messaging health under Connections, and how busy the week has been now sits at the top of the Activity tab with its sparkline.
- Sections added by extensions now appear under "From your extensions" at the top of the Activity tab. Extension authors do not need to change anything — it is the same slot, in the same order, and the heading only shows up when you actually have an extension contributing a section.
- The sidebar is down to four places: Home, Team, Connections, and Marketplace, plus Search. Activity, scheduled work, and workspaces have not gone anywhere. They are tabs on Home now, and Home stays lit while you are on any of them.
- The main page is called Home everywhere it is named: "Go home" in the command palette (searching "dashboard" still finds it), "Back to Home" on the error and page-not-found screens, and on the way back from the Marketplace.
- DorkBot's tours point at the page instead of the sidebar, so they work the same on a phone as on a desktop. "Show me around" is now the composer and the tabs above it, and the tour you get on your second agent opens your Team page and shows you the roster.
- Your place in a room is now kept in the same place as your place in everything else you read.
  Nothing looks different: the unread dot in the sidebar, the count in the browser tab and the
  "New messages" line all sit exactly where they did, and reading a room on your laptop still
  clears it on your phone straight away. What changed is underneath — a room no longer keeps its
  own separate copy of where you are, so there is one answer to "have I read this" instead of one
  per surface. Rooms you had already read stay read when you upgrade
- An agent working through a room can never move your unread mark, and you can never move its
  own. An agent keeps its own record of what it has been shown, which is what lets it catch up on
  a busy channel without repeating itself — that is a different thing from what you have looked
  at, and the two are now kept apart on purpose
- Your unread marks in a chat now follow you between devices. The "New messages" line used to be
  remembered by the browser you were sitting at, so reading a conversation on your laptop left it
  looking unread on your phone. It is now kept with your account, alongside the same mark rooms
  use: read to the end in one place and the line is gone in the other, straight away, without a
  refresh. Opening a conversation still holds the line where you left off until you leave, so it
  does not vanish before you have read what is under it.
- In Obsidian there is no DorkOS server behind the plugin to hold that mark, so your unread line
  still works there and stays local to the vault you are reading in.
- The old per-browser mark is cleared out the next time you open a chat, so nothing stale is left
  behind to disagree with what your account says.
- There is now exactly one way to mark anything read. Rooms used to have a mark-read address of
  their own, kept working while the app moved onto the shared one; everything uses the shared one
  now, so the old room-only address is gone. Nothing changes for you — the same badges clear at
  the same moment — but if you wrote a script against `PUT /api/rooms/{id}/read-cursor`, point it
  at `PUT /api/read-cursors/room/{id}` instead.
- Agents were never able to mark a room read by asking, and now they cannot ask at all. What an
  agent has been shown is tracked as entries are actually handed to it, which is the only honest
  record of it.
- Home is a conversation now. Open DorkOS and you land in **#team** — the room you and every
  agent you run share — instead of a dashboard of cards. Type in the box and your agents can
  answer, right there: nothing navigates away, and no throwaway session is created.
- What actually needs you sits above the conversation and stays there while it scrolls:
  approvals waiting on a decision, and anything that broke. Answer an approval where it stands
  and it clears without moving the room under you. Nothing waiting and nothing wrong shows
  nothing at all.
- Under those, a line of whoever is working somewhere else, so you can follow along without
  taking over. Work happening in #team is announced by the room itself, once.
- Put the caret in the empty box and the last few threads you were in float up, the same list
  the sidebar shows.
- **Pages now share one width system.** Before, every screen picked its own
  width: chats with an agent were narrower than channel rooms, the Activity page
  had no side padding, and Tasks stretched edge to edge while Workspaces sat in
  a narrow column. Now there are three named sizes — full, wide, and reading —
  and every page uses one of them, so moving between screens no longer makes
  the content jump around.
- Chatting with an agent now looks the same as chatting in a channel: the
  message list uses the whole pane, long messages stay at a comfortable reading
  width, and the composer spans the pane.
- Sessions that never got an auto-generated title now derive a cleaner one
  from your first message — on every runtime (Claude Code, Codex, OpenCode).
  Filler openers like "please can you" are dropped, the
  title caps at six words, and it gets a capital letter — so "please can you
  review the help and feedback submission options" shows up as "Review the
  help and feedback submission…" in the sidebar. Titles the assistant already
  generated are untouched.
- While an agent is working, the status strip now tells you what it is doing —
  "Running pnpm verify…", "Editing router.tsx…", "Using Slack…" — instead of a
  random catchphrase. When DorkOS does not know, it says so: "Working…", and
  nothing more. The reading is cleared the moment the turn ends, so a label you
  see is always about something still running (DOR-1053)
- The skull that used to appear at random while permissions were bypassed now
  shows for as long as the session is in that mode, because it is a warning
  rather than a joke (DOR-1053)
- Every live dot in the app now says the same thing in the same colour: green and
  pulsing for working, amber for waiting on you, red for a failed turn, blue for
  output you have not read. They were four different greens and three different
  ambers, spread across the sidebar, the tab strip, the group headers and the
  agent panel.
- Only the working dot moves. A tab waiting for your approval used to pulse too,
  which read as a turn still running when it was actually stopped, waiting for
  you.
- Health moved to where it is actually useful: "Online" or "Offline" in the agent
  panel, and a labelled dot on the mesh map, which also gained a colour for
  agents it cannot reach at all and a legend entry explaining it.
- In the agent panel, the pencil that appears when you hover no longer covers the
  little robot mark on the avatar. It moved next to the name it renames, it now
  shows up for keyboard users too, and the avatar answers your pointer with a
  ring in the agent's own colour instead.
- Activity, Workspaces, Connections, and Feedback Requests now use the same
  wide layout as the Marketplace. On a large monitor they used to sit in a
  narrow column while every other page filled the screen; now all the main
  pages feel the same width.
- The sidebar is being rebuilt, and the settings behind it moved house. Everything you had set
  comes with you: the sections you had folded shut stay folded, the way you had your agents
  sorted and filtered stays put, your pins, groups and muted conversations are untouched, and a
  tip you dismissed stays dismissed. There is nothing to do — it happens the first time DorkOS
  starts on the new version.
- Agents that read or change your settings can no longer see which sidebar sections are folded.
  Nothing sensitive was there; it is simply a shape the settings snapshot has no way to describe
  yet, and DorkOS leaves out anything it cannot describe precisely.
- The sidebar is tighter and quieter. It is now 272 pixels wide instead of 320, every row
  starts 16 pixels from the edge instead of 30, and section names read as words
  ("Direct messages") rather than as SHOUTING. Rows are 13px on a 28px line, so more of
  your work fits on screen without anything feeling cramped.
- Sections and rows no longer have hairlines between them. Where there used to be a line
  under the header and above the footer, there is now a faint tint and a soft shadow that
  appears only when there is more to scroll to — so the panel reads as one surface instead
  of three stacked boxes. The tint works the same way in light and dark mode.
- Nothing is drawn until you reach for it. A section's own icon turns into a collapse arrow
  when you hover it or tab to it, and the "more" menu on a row is a small vertical `⋮` that
  appears on hover **and** on keyboard focus — so everything the menu offers is reachable
  without a mouse, and on a device with no right-click.
- Every row in the sidebar is now built from the same template: a mark, who it belongs to,
  what it is called, and its badges. A session says which agent it belongs to
  ("Scout › fix the flaky test"); a channel or a conversation does not, because it is the
  place itself. Long agent names can no longer squeeze out the title, and the full name is
  always in the tooltip. A row only grows a second line when there is something real to put
  on it.
- **Opening ⌘K without typing now shows a command center instead of a menu.** First
  **Continue** — the chats your agents are working in right now, each saying what it is
  doing ("Editing strip-state.ts…", "waiting on you"). Then **Recent** — the last things
  you were in, whether they were chats, channels or agents, with anything unread on top.
  Then **New**, for starting a chat or making an agent. Continue is simply absent when
  nothing is running, rather than an empty heading.
- Settings, Tasks, Toggle Theme and the rest are no longer listed before you type. They
  are one keystroke away: start typing and they come back.
- The chat status strip and the sidebar now get their words from the same place. They could
  drift apart before, and briefly did: the strip used to make up a joke verb while the
  sidebar said nothing, so two parts of the same screen described one agent two ways.
- The coloured dot on an agent's face now says what it means out loud, so a screen reader
  announces "needs you" rather than nothing at all. Colour on its own was never enough, and
  a dot is nothing but colour.
- `/compact` waits for the current reply to finish instead of interrupting it.
  Before, running it mid-reply quietly took the conversation out from under the
  agent that was still typing.
- **Your sidebar has three parts now: Heads up, Today and Library.** _Heads up_ is what needs you.
  _Today_ is what you were working on, in the order you last touched it. _Library_ is the
  structure you built yourself — and **nothing in it moved**. Your pins, your channels,
  your direct messages, your agents and your groups are all exactly where you put them, in
  the order you put them, with the same names. The only new thing above them is a short
  list of what has changed since you looked away.
- Sections open and close by clicking anywhere on their name — you no longer have to hit a
  small arrow. Hold `Alt` (or `Option` on a Mac) while you click and every section opens or
  closes at once.
- A closed section keeps telling you what is inside it. Fold away your conversations and
  the unread count and the "someone is working" dot move up onto the section name, so you
  never lose a signal by tidying up.
- Sections appear when you have something to put in them. There is no "Direct messages"
  heading until you have a conversation, and no "Pins" until you pin something. Grouping
  shows up once you are running eight agents or two different kinds. There is no settings
  toggle for any of it, and there never will be.
- Because the "Direct messages" heading now waits until you have a conversation, starting
  your **first** one moved: it is "New message…" under the `+` beside Agents. Once you have
  one, the `+` beside Direct messages works as it always did.
- Dragging still works everywhere it used to — reordering pins, moving an agent or a
  channel into a group, reordering inside a group. Dragging a row into Heads up or Today is the
  one thing that does not, because those two lists are worked out for you rather than
  arranged by hand. If you try, DorkOS says so and tells you what to do instead: pin it to
  Library and it stays put.
- Everything in the sidebar is reachable from the keyboard. `Tab` moves between sections,
  the arrow keys move within one, and the `⋮` menu on every row appears on focus as well as
  on hover — so every action is available without a mouse, and on a device with no
  right-click.
- Clicking an agent in the sidebar now opens the conversation you were having with it,
  the way clicking a person in a chat app opens your messages with them. It used to
  unfold a little panel underneath showing three of that agent's sessions, which meant
  two clicks to get anywhere and no way to see the other eleven. That panel is gone
  (DOR-1071)
- **There is one place to make things now.** Starting a session, a channel, a direct message,
  an agent or a group used to mean finding the right `+` in the right part of the sidebar —
  three menus, four buttons, and no way to guess which one. They are all one **New** button at
  the top of the sidebar. Press ⌘N in the desktop app and it starts a session straight away,
  with the agent you were last talking to. The `+` on a section still works: it opens the same
  New menu with the matching item already picked out.
- **The top of the sidebar says whose cockpit this is** — "Dorian's team", from the name in
  your profile. Press it for workspace settings, your account, and which version you are
  running, with a "Check for updates" beside it that asks the server and tells you what it
  found. It is one menu, and it is the menu that will hold your other teams when shared
  spaces arrive.
- **A "Jump to anything…" pill sits under it**, opening the same ⌘K search you already had —
  now visible instead of remembered.
- **Settings and your profile each have one door.** The footer's `⋯` menu used to offer both as
  well; it keeps what only it has — who you are signed in as, sign out, the theme, and help —
  and leaves the rest to the menu at the top.
- Zone headings in the sidebar are a little darker, so they meet the readable-contrast bar in
  the light theme as well as the dark one
- The bottom of the sidebar is one slim strip now. It used to spend three rows on a logo, a
  row of icons and a version number; it spends one on the four places DorkOS goes — Home,
  Team, Marketplace, Connections — and a new **✦ Ask DorkBot** button. Your account, Settings,
  the theme switch, help and feedback, and the developer tools all moved one press away, into
  the **…** menu beside them.
- The version number left the chrome. When a new version is genuinely waiting, a small
  "Update ready" pill appears above the strip and disappears once you have it — and it never
  shows up in the Heads up zone, which is for agents that need you (DOR-1070)
- ⌘K now puts the best match first. Typing gives you one list, ordered by how well each thing
  matches what you typed, how much you use it, and how fresh it is — so a channel called
  `#shipping` comes before an agent that only nearly matches, instead of always sitting below it.
  When one row is clearly the one you meant, it gets its own "Best match" line on top (DOR-1074).
- ⌘K now remembers how often you open a conversation or a channel, not just an agent. It used to
  keep a separate note of the agents you use, so a channel you live in could never rank as highly
  as an agent you open every day. There is one memory for all three of them now, and the sidebar
  and ⌘K both write to it — so it no longer matters which door you came through. Your existing
  agent history moves across, so the agents you already reach for stay where they are (DOR-1075).
- The sidebar's Today list puts a conversation where your own attention left it: writing in one
  counts, not just opening it. So a conversation you typed in this morning stays near the top even
  if you opened something else since. When we cannot tell when you last wrote — some agent
  runtimes do not report it — the order falls back to when you last opened it, rather than
  guessing (DOR-1081).
- A quiet conversation now sits below a busy one when they match what you typed equally well. It
  is not pushed to the bottom of the list, though: something you go back to constantly still
  comes up first, whatever day it last moved. A closed channel is the one thing that always ranks
  below everything still going (DOR-1076).
- On your phone, DorkOS now has four tabs along the bottom instead of a slide-out
  menu. **Home** shows what needs you and what you were working on today, with a
  count on the tab when your agents are waiting. **Library** is your channels,
  direct messages, agents and pins, and it never shows a count — it is the quiet
  one. **DorkBot** opens a conversation with the assistant that knows how DorkOS
  works. **You** holds your account and the rest of the app. The hamburger button
  is gone: nothing has to be swiped away before you can use what is underneath,
  and switching tabs keeps your place in each one.
- **Everything you tap on a phone is now big enough to tap.** Rows, section
  headings, the menu buttons, "New", the search bar and the four places DorkOS
  goes are all at least 44 pixels tall. Two small controls that could not grow
  without covering the row's own words — the face that opens an agent's profile
  and the "N live" chip — moved into the press-and-hold menu instead, along with
  a new way to switch between an agent's conversations.
- **The You tab now says what each thing is.** The four destinations were
  unlabelled icons whose only names appeared when you hovered over them, which
  never happens on a touch screen. They are named rows now, and your account sits
  among them instead of behind a "…".
- The tab you are on is easier to see: it was marked with a shade of grey almost
  identical to the others.
- **The DorkOS panel in Obsidian now looks like the app.** Its list of conversations is drawn
  with the same rows the cockpit sidebar uses: sentence-case group names instead of shouty
  capitals, a coloured dot when a chat is working, waiting on you or has gone wrong, and one "⋮"
  menu per row holding Rename, Fork and Details, so everything you could reach by hovering is now
  also reachable from the keyboard. Arrow keys walk the list; Tab steps past it in one press
  instead of one per conversation. The dividing lines are gone, replaced by the same soft shading
  the app uses. Colours follow your Obsidian theme, so the rows highlight the way the file
  explorer beside them does. The Obsidian plugin is still an early, lightly tested surface, and
  none of this has been confirmed in a real vault yet (DOR-1080)

### Removed

- The dashboard. Its composer became the room's, its two useful sections moved above the feed,
  and the recent-activity preview is the Activity tab, which was always the fuller version of
  it.
- The old dashboard's promo grid is gone for good, along with the wide card layout only it used. Feature suggestions now live in the sidebar and in that one quiet line.
- **Agent faces no longer draw a second, competing ring.** A coloured health ring
  sat two pixels outside the dot, both fed by the same hour-old signal — one fact
  drawn twice, on every list row in the app.

### Fixed

- An agent's profile Sessions tab and the command-palette preview now show that agent's
  conversations even when the current window is pointed at a different project. Before, they
  read only the window's own directory, so every agent except the one this window had open
  looked like it had no conversations — an agent could appear to be working while claiming
  none (DOR-929)
- When the app updates while a tab is open, the error screen now offers a one-click reload instead of a dead Retry (DOR-936)
- **`dorkos call` stops claiming a real capability does not exist.** When the catalog was too big
  for the command to read in one go, it quietly stopped early and then reported perfectly valid
  ids as unknown. It now says plainly that the app and the command are out of step (DOR-988)
- One agent, one silhouette. The member list in a room's details and the row of faces at the top of the room used to draw the same agent two different ways — a bot mark on one and none on the other, both of them round, and two different colours for anyone the app could not look up. They agree now: same shape, same corner mark, and the same colour for anyone the app cannot look up. (DOR-968)
- Direct messages wear the agent they are with. In the sidebar, the room header and the ⌘K palette, a one-to-one now shows that agent's own square mark instead of a round one that made it look like a person. (DOR-968)
- The green "working now" dot on the identity card was being drawn twice for one fact. There is one dot now, on the avatar, where it is everywhere else. (DOR-968)
- Updating a marketplace package that you installed into a single project now works. Before,
  the updater only looked at packages installed for your whole machine, so it answered
  "Package not installed" for anything that lived in one project — even though it would have
  installed the new version right there. When the same package is installed both ways, the
  project's copy is the one that gets updated.
- OpenCode sessions now show messages in the order they actually happened, including
  after a revert, a fork, or a long conversation that got summarized. MCP tool
  connections also reconnect more reliably when a session runs for a while (DOR-1013).
- The tool servers you connect to an agent, called MCP servers, are now ready before your first message runs. Before, an agent could start too early and type a tool call out as plain text instead of running it. (DOR-1014)
- Two projects with very long folder paths no longer share each other's chat history. This mostly hit people who work in many git worktrees at once. (DOR-1014)
- A very long session no longer repeats tool results after about a thousand tool calls. (DOR-1014)
- If you stop a turn in the moment a tool is being checked before it runs, that one tool no longer slips through and runs anyway. (DOR-1014)
- DorkOS now updates its managed OpenCode helper when a new version ships, instead of
  quietly keeping the old one (DOR-1034)
- The Workspaces page now scrolls. Before, anything past the first screenful was cut
  off and there was no way to reach it (DOR-1036)
- After you add a file to the chat from the Files panel, the cursor is in the message box, ready to type (DOR-1038)
- Restore focus when a focus-moving action moves none
- The Workspaces page and docs no longer say DorkOS creates workspaces automatically. Today a
  workspace is created only when a tool or script asks the server for one. The empty state, the
  guide, and the glossary now say so plainly.
- Workspace retention cleanup now honors your `retentionCap` setting: it keeps your most recently
  used checkouts and skips any workspace a session is still using, instead of trying to remove
  every unpinned workspace. DorkOS does not yet run this cleanup on its own.
- The Marketplace no longer shrinks when you switch to the Installed tab. The
  page kept its width only when it had enough cards to fill it; now it holds
  its width no matter how little is on it. Same fix for the Sources page.
- The Connections page and the Marketplace Sources page now scroll when their
  content is taller than the window. Before, anything below the fold was
  simply cut off.
- **Rows in the Cmd+K palette that did nothing now do something.** Four kinds of
  row let you highlight them, press Enter, and watch the palette close with
  nothing else happening: slash commands, the "Continue: …" suggestion, the
  recent conversations under an agent, and any row an extension added.
- Picking a slash command takes you to the conversation it would run in and
  types it into the message box for you. It does not send it — you press Enter
  when you are ready. Commands like `/clear` are not ones to fire off from
  across the app with one keystroke. Anything you had already typed is kept, as
  the command's instructions: a half-written "focus on the API changes" plus
  `/compact` becomes `/compact focus on the API changes`. If you had already
  typed a different command, the new one takes its place.
- "Continue: …" and an agent's recent conversations now open the conversation
  they name, in the right project.
- **The palette lists the commands your agent actually has.** It used to ask
  without saying which conversation you were in, so it always got the default
  runtime's list — you could be talking to Codex and be offered Claude Code's
  commands.
- **A channel you archived can be found again.** Archived channels were gone
  from the whole app. They now turn up in the palette when you search for one,
  marked "Archived", and only there — your sidebar and everything else stay
  free of them.
- **A green dot now means one thing: an agent is working right this second.** It
  used to light up whenever DorkOS had heard from an agent in the last hour, so
  faces all over the cockpit pulsed as if mid-turn when nothing was running.
  Agents that are simply alive show nothing at all, which is what makes the ones
  that do light up worth looking at.
- The amber "needs you" dot got darker in the light theme, so it stands out
  against a pale background instead of washing into it.
- A row that is showing a live verb keeps its second line even when the reading behind it
  goes quiet for a moment. It used to collapse and grow back under your pointer.
- Rows no longer lose their one-line preview. A quiet session and a busy channel both keep
  the last thing that happened there, instead of showing an empty line where it should be.
- Agents no longer wrongly believe you stopped them. When a background agent finished at
  the exact moment the main agent asked permission to use a tool, the runtime cancelled
  that tool call with a message that read as if you had refused. The agent would halt,
  apologize, and sometimes throw away finished work. DorkOS now catches that false
  signal, tells the agent it was a system hiccup and not you, and flashes a short note
  in the status line so you know what happened (DOR-1087)
- **A chat now runs one turn at a time.** A message you had queued up could be
  sent while the agent was still working on the previous one, which started a
  second copy of the agent on the same conversation. The two wrote over each
  other, and the box you type in went quiet and unresponsive while replies were
  still coming in. A queued message now simply waits its turn and goes the moment
  the agent finishes.
- Stopping an agent works again in the cases where that second copy had taken
  over. When one of the two finished, it took the controls with it, so Stop had
  nothing left to talk to and the other kept running.
- The same protection now holds for a brand-new chat. A chat gets its permanent
  name a moment after it starts, and messages sent under the new name used to
  slip past the check entirely — which is exactly when it mattered, because that
  is your first reply in a new conversation.
- A chat whose agent crashed without a word no longer strands your next message.
  The wait has a ceiling: past it, your message gets the same answer anyone else
  would get, rather than queueing forever behind something that is never coming
  back.
- The chat no longer goes quiet while your agent is still working. When a background
  task finished, the agent would wake up and carry on — writing, running tools — but
  DorkOS had already decided the turn was over. The screen said idle, the reply
  streamed nowhere, and none of that work was saved to the conversation. DorkOS now
  notices the agent has started talking again, picks the conversation back up, and
  keeps the words and the tool calls where you can see them. Your finished reply stays
  on screen while it happens, and you only get one "finished" chime per message you
  send, not one per wake-up (DOR-1100)
- The status line now tells you when background tasks are still running after your
  agent has stopped talking, so a session that looks finished but isn't says so
  instead of just going quiet. The count clears itself when those tasks end — or when
  the agent stops for any reason and they end with it — so it can never sit there
  claiming work that is no longer happening (DOR-1100)
- Clicking an agent no longer drops you into a job it ran on its own. If you
  `@`-mentioned an agent in a channel, that run became the newest thing in its
  history — so clicking the agent opened _that_ instead of the conversation you
  were having with it, and because automatic runs are deliberately kept out of
  your recent list, there was no row to get you back. DorkOS now opens the last
  conversation the two of you actually had, and starts a fresh one if you have
  never spoken (DOR-1071)
- A long chat with a sign-in card still waiting for you no longer grows without limit.
  DorkOS caps how much of an in-progress reply it holds in the browser. That cap
  stopped working whenever a sign-in card sat at the top of the reply, so a tab left
  open while an agent woke itself up over and over kept piling on and slowly got
  heavier. The cap now holds in that case too, and the sign-in link you walked away
  to use still stays on screen (DOR-1107)
- **When `/compact` says it failed, it really did not run.** If you typed `/compact`
  while your agent was still working, it waited its turn behind the reply in
  progress. After 30 seconds DorkOS gave up on the request and showed you an error —
  but the compaction was still sitting in line, and it went ahead minutes later
  anyway. You would come back to a conversation that had been shortened without your
  say-so, after being told nothing had happened. Now DorkOS stops waiting first and
  tells you the chat is busy, and the compaction is dropped for good. Run `/compact`
  again once the reply is done (DOR-1101)
- When an agent asks to change a setting only you may change, the refusal now says what
  that setting really is. It used to tell every agent the same thing — that the setting
  decides who can reach your instance, where your keys go, and what leaves your machine
  — which is true of your login switch and untrue of a room's reply limit or the
  welcome-back greeting cap. Those bounds are about how often your agents speak on their
  own and what that spends, so that is what the refusal says now, and a request touching
  several kinds of setting gets one honest line for each (DOR-1044)
- Rename an agent, or watch someone leave a room, and every `@mention` of them already on
  screen now updates to match. They used to keep whatever name the roster had the moment
  the message was first drawn, so a room left open could go on calling somebody by a name
  they no longer had (DOR-989)
- The line above your Activity feed now counts sessions your agents started across
  your whole machine, which is the same ground the feed below it covers. It used to
  count only the project you happened to have open, so the two quietly described
  different things. It also says plainly what it counts now — "Your agents started 12
  sessions this week" — and if a runtime can't be reached, it says "at least" instead
  of passing a smaller number off as the whole story (DOR-1039)
- A background task that never reported back could leave your session saying "still
  working in the background" forever. Nothing in DorkOS could clear it, so the count
  sat there for the life of the session. Now a task that has gone quiet for fifteen
  minutes, on a session that has finished talking, stops counting. Tasks that keep
  checking in keep their place however long they run (DOR-1104)
- DorkOS no longer says a background task stopped when all it knows is that it can no
  longer see it. When your agent finishes, anything it started inside itself is gone
  with it — but something it launched to keep running on its own, like a dev server,
  carries on, and DorkOS cannot tell the two apart. It now says it lost track of the
  task and that it may still be running, instead of reporting a stop that may never
  have happened. These tasks are not marked as finished or failed, because DorkOS did
  not see either one happen (DOR-1108)
- Settings that live inside a list — your saved MCP servers, your Claude accounts — now get the same only-you-can-change-them protection as every other protected setting. An agent asking to rewrite one of those lists is turned down and told which settings are yours to pick. Changing them yourself in Settings works exactly as before.
- The little running figure on the background task bar now shows how its task ended.
  It used to burst into confetti and then just keep running, so the tick for a task
  that finished, the cross for one that failed, and the dash for one DorkOS lost
  sight of never appeared — the figure ran until the task faded from the bar. The
  figure now settles into its mark after the burst, and a task that is already
  finished when it shows up on the bar opens on its mark instead of pretending to
  run (DOR-1119)
- Reloading the page or following a link straight into a conversation used to leave that
  conversation missing from the sidebar entirely. It is now always there, at the top, even
  before the rest of the list has loaded.
- On day one, an agent could be working and the sidebar would never say so — the Getting
  started suggestions took the space the "N working" line needed. Now working wins that space,
  and Getting started comes back when the work finishes.
- Conversation rows in the sidebar reserved a line for a live status and then left it blank.
  They now say what the agent is doing, matching the status shown in the conversation itself
  (DOR-1068)
- Running `/compact` no longer leaves the session stuck looking busy. Before,
  a finished compact never said it was done, so every later message waited on
  a turn that had already ended (DOR-1130)
- OpenCode sessions now show the approval card when the agent wants to run a
  command, edit a file, or fetch a page. Before, the question never reached you:
  the turn simply stopped and sat there with nothing on screen, sometimes for
  many minutes. Approve or deny and the turn carries on, and a decision you make
  in OpenCode's own app clears the card here too.
- When an OpenCode agent hands work to a subagent and that subagent needs
  permission to run a command or change a file, the ask now reaches you. It
  appears in the session with the subagent's name on it, and answering it lets
  the subagent carry on. Before, the question was raised somewhere nothing could
  show it: the turn went quiet and waited, sometimes for many minutes, with
  nothing on screen to answer. Stop the turn while a subagent is waiting on you
  and the ask is taken down instead of sitting there unanswerable.
- An OpenCode subagent you stopped while it was waiting for permission now says
  it was stopped. It used to say it failed, right when there was nothing else on
  screen to tell you otherwise.
- Resume a session after a restart and change only its model, effort, or
  title, and it now keeps the trust level you gave it. Doing this used to
  quietly drop the session back to the default "ask before every action"
  mode — the sidebar and session settings kept showing your real choice, but
  the agent was actually running with less trust than you'd granted it,
  until you re-toggled the dial.
- When a background task finished at an awkward moment, the agent was told its
  own work had been cancelled — in wording that reads like you refusing it. DorkOS
  spotted that and sent a correction, but the correction never landed in the one
  kind of turn where this happens: turns running background tasks. So the agent
  kept believing you had said no, and sometimes told you so. The correction now
  reaches it, and it carries on with the work instead of stopping.
- When the runtime cut off a helper the agent had running, the helper often
  reported back that you had declined something or blocked it from saving. The
  agent believed the helper and gave up on that work. DorkOS now tells the agent
  what actually happened — the runtime stopped it, you did not — and to redo the
  work instead of taking the helper's word for it.
- **A sidebar section's menu is reachable on a phone again.** Rename, sort, mute
  and delete-group sat behind a button that only appeared when you hovered — so
  on a touch screen there was no way to reach them at all.
- Answering an OpenCode approval card somewhere else — its own terminal window, another
  DorkOS window — now shows up in the transcript as Approved or Denied, the same as answering
  it here. Before, it just cleared with no record of which way it went.

### Security

- Live-update connections now require the same scheme (`http` or `https`) as the page that
  opened them when no reverse proxy declares one. This closes a gap where an unusual proxy
  setup could let a plain `http` page open a secure cockpit's stream. If you run a custom
  TLS-terminating proxy, set the `X-Forwarded-Proto` header on it — a proxy that omits it
  will now have its upgrade requests rejected instead of silently accepted (DOR-932)

---

Older releases (v0.1.0 – v0.58.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.58.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.58.0.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.74.0...HEAD
[0.74.0]: https://github.com/dork-labs/dorkos/compare/v0.73.0...v0.74.0
[0.73.0]: https://github.com/dork-labs/dorkos/compare/v0.66.0...v0.73.0
[0.66.0]: https://github.com/dork-labs/dorkos/compare/v0.65.0...v0.66.0
[0.65.0]: https://github.com/dork-labs/dorkos/compare/v0.64.0...v0.65.0
[0.64.0]: https://github.com/dork-labs/dorkos/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/dork-labs/dorkos/compare/v0.62.0...v0.63.0
[0.62.0]: https://github.com/dork-labs/dorkos/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/dork-labs/dorkos/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/dork-labs/dorkos/compare/v0.59.0...v0.60.0

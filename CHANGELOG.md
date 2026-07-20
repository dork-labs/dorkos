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

## [0.53.0] - 2026-07-20

### Added

- **The right-side panel now opens to Pulse — a quick read on what needs you.** On the dashboard, agents, tasks, and every page away from a chat, the inspector panel used to sit empty; now it shows Pulse: a short list of anything that needs attention (a stalled chat, a failed run, an undelivered message, an agent that dropped offline) and a peek at recent activity, each linking through to the full view. When there's nothing to report, it says so calmly instead of going blank. In a chat, your last-used tab still opens first, exactly as before — Pulse just waits as the first tab in the strip. Open a panel where an agent you were inspecting has since been deleted and its profile tab now quietly steps aside rather than lingering on a "not found" message.

### Changed

- **The sidebar in the web cockpit is now just your list of agents — the old per-chat "session" view and its row of sidebar tabs have been retired.** Opening a chat keeps your agent list in place; everything about that chat lives in the inspector panel on the right, so the sidebar never swaps out from under you. Agents that drive the interface get an honest answer now, too: the web cockpit has no sidebar tabs, so asking to switch one does nothing there — and the agent is told that, instead of it quietly pretending to work. (The tab strip still lives in the Obsidian plugin, where those requests keep working.)

### Fixed

- **The inspector panel on the right no longer disappears, and no longer shows an agent you never picked.** Its toggle now stays in the top bar on every page — including the Marketplace, where it used to vanish. Open it anywhere and there's always something worth seeing — the new Pulse tab keeps it from ever being a blank gap. Away from a chat, the Agent Profile tab only appears once you actually open an agent, so the panel never fills itself with the ambient project it happened to start in. And a panel tab added by an extension that ships no icon now falls back to a default icon instead of breaking the whole panel.
- Stopped a confusing sign-in advisory from printing on every server start.
- Directory-boundary messages now tell the truth about folders outside your home directory, instead of mislabeling them.
- Docker packaging is more reliable: the release tarball is guarded against missing files, `docker:run` works out of the box, and `smoke:npm` can be pinned to a specific version.
- Fixed a blank cockpit when the host port is remapped (Docker `-p`, an SSH tunnel, or a reverse proxy).

## [0.52.0] - 2026-07-20

> Shapes install a whole working setup in one step, creating an agent is a real moment that ends with the agent saying hello, and DorkOS docs now speak the markdown that AI tools read.

### Added

- **Shapes: install a whole setup, not just a tool.** Shapes are a new kind of marketplace package (DOR-355). A plugin adds one capability; a Shape describes a complete working setup: which extensions to turn on, how the dashboard and sidebar are arranged, a suggested agent, and the schedules that keep it running.
  - Install a Shape from the marketplace like any other package, with the same safety net as plugins: a failed install cleans up after itself completely. (DOR-355)
  - Apply an installed Shape through the API (`POST /api/shapes/:name/apply`). Applying is idempotent, and anything missing (an extension, an agent, an API key) never blocks the rest — it shows up as an honest warning instead. (DOR-355)
  - Fork a Shape to make your own version, with a "forked from" lineage trail, using the new `dorkos shape fork` command. (DOR-355)
  - Shape-aware conflict detection, validator coverage for Shape manifests, and a scaffold command that generates a valid starter skeleton to build your own Shape from. (DOR-355)
- **Switch Shapes from inside the cockpit.** Open the command palette and pick "Switch Shape" to see every Shape you've installed and apply one in a click (DOR-355). Applying a Shape rearranges your workspace, turns on its extensions live with no reload, and offers its suggested agent for you to bring in or skip. If a piece is missing, you get an honest note about it instead of a silent gap.
- **A brand-new agent says hello first.** The moment you bring an agent to life, its first session opens with a quiet birth line — its name, the day it was born, where it lives, and the runtime it runs on — and then the agent speaks, without you typing a thing. A ready-made agent introduces itself in its own voice and offers a first action (it waits for your go-ahead). A blank "Design your own" agent says a warm hello and asks what you'd like it to take care of. The greeting is genuinely the agent's — the prompt that sparks it never shows up as if you had typed it. (DOR-355)
- **Browse the marketplace by category.** The Marketplace page now shows a row of category chips — click one (like Security or Code Review) to narrow the grid, and share the filtered view as a link. New category pages on dorkos.ai, one per category, list the packages in each and link back to the full marketplace. (DOR-356)
- **See what a package does before you install it** — the marketplace detail panel now shows each package's README right below its permissions.
- **Extensions can now add their own tabs to the sidebar.** An extension that contributes a `sidebar.tabs` view shows up as a real tab alongside the built-in Overview, Sessions, Schedules, and Connections — so the Linear Ops shape's Linear tab actually appears once you enable it. A contributed tab opens its own panel, keeps its place across reloads, and quietly steps aside back to Overview if you later remove the extension.
- Extensions can now tell which agent they're running beside: the app resolves the agent registered in the current project folder and hands its id to the extension, updating live when you switch folders. (DOR-362)
- Extension panels can now show or hide based on the agent and project folder you're working in — a right-panel tab can be scoped to appear only for a specific agent, or only in a certain folder. (DOR-364)
- AI tools can now ask any docs page for a markdown version: send `Accept: text/markdown` to a normal docs URL, or add `.md` to the end (like `/docs/getting-started/quickstart.md`), and you get clean markdown instead of the full web page. (DOR-345)
- A markdown sitemap at `/sitemap.md` gives agents one plain-text list of every docs, feature, blog, and marketplace page. (DOR-345)
- New "Open in Perplexity" and "Open in Claude Desktop" shortcuts on docs pages, alongside the existing Claude, ChatGPT, Cursor, and Scira links. (DOR-345)
- A `context7.json` file so DorkOS docs get indexed by Context7, a common docs source for coding agents. (DOR-345)
- Every docs page now has its own link-preview image and describes itself to search engines and AI answer tools, so a shared docs link shows a real card and the page is easier to surface as a source. (DOR-346)
- Search engines and AI tools now see DorkOS as one connected entity: the site tells them who makes DorkOS (with a logo), that it is open source, and where the code lives, all linked to the app itself. (DOR-347)
- The DorkOS blog feed is now advertised on every page across the site, so a feed reader can find it from anywhere. (DOR-347)
- Added a web app manifest and app icons, so saving DorkOS to a phone home screen shows the DorkOS mark and name instead of a generic thumbnail. (DOR-347)
- The install page now has its own share image with platform badges (macOS, npm/CLI, and the Windows alpha), so links to it preview the ways to get DorkOS. (DOR-347)
- Added a script to notify Bing and Yandex when pages change, so their search and AI answers pick up updates faster. (DOR-347)

### Changed

- **Creating an agent is a real moment now.** "New agent" opens a fullscreen gallery that asks one thing — what will your agent do? Start from a ready-made agent, shown like a job listing with a face, what it does, and how it connects, or choose **Design your own** and describe the job in your own words. The naming screen shows a live preview of your agent taking shape: type a name (or pick a suggestion and reroll for more), give it a face, and tuck the details behind a single "Details" toggle. When it's ready, **Bring it to life**. (DOR-355)
- **A "Design your own" agent now writes its own personality, live in your first chat.** Instead of a plain hello, the new agent runs a short interview: it asks what you'd like it to take care of, asks at most a couple of sharp follow-ups, then writes its own personality file right in front of you. When it's done, it sums up what it understood and offers one first thing it could do. It waits for your go-ahead and never starts the real work on its own. Give a one-word answer, or say "just figure it out," and it won't grill you. (DOR-355)
- **One entry to create agents.** Every path now leads to the same welcome: when your first-run scan finds no projects, DorkOS offers "Create your first agent" and opens the real agent gallery — no more bare fill-in-the-blanks form. Installing a ready-made agent from the Marketplace introduces it first — meet it, name it, give it a face — and brings it to life through the standard creation flow, so it always lands in its own place and can never overwrite an agent you already have. (DOR-355)
- **Import becomes its own flow, with a real finish.** Bring in existing projects from the gallery, the sidebar's add menu, or the command palette: scan your machine, add the projects you want, and see a clear "N projects joined" summary with a Done button instead of a dead end. (DOR-355)
- **"Set up" a Shape's suggested agent, and it arrives ready — not blank.** When a Shape offers an agent you don't have yet, the switcher's "Set up" opens a single confirm card: meet the agent, read what it does in its own words, and see plainly what turns on, where it will live, and which skills it uses. One click creates it, already carrying its personality and its runtime. "Customize first" still lets you rename it before it's born. (DOR-355)
- **Marketplace filters moved into the sidebar.** Opening the Marketplace now hands the sidebar over to a filter panel: pick a package type or check off one or more categories — each row shows how many packages match — and the grid updates as you go. Category filters combine, so you can browse Security and Code Review at once. Your filters still live in the URL, so a filtered view is shareable and survives a refresh. (DOR-379)
- Switching agents now live-remounts the extension slots for the new folder instead of reloading the whole page — your open session, scroll position, and unsent message survive the switch. (DOR-363)
- Social preview images now use the real DorkOS brand font and share one set of building blocks, so previews look consistent across the blog, marketplace, and feature pages. (DOR-344)
- Blog post previews now show a reading-time estimate and when the post was last updated, not just when it was first published. (DOR-344)
- The security, privacy, terms, cookies, and telemetry pages now carry the same link-preview and canonical-URL details as the rest of the site. (DOR-344)
- Named every welcome AI crawler in `robots.txt` (OpenAI, Anthropic including Claude Code, Perplexity, and Meta) with a clear, explicit invitation instead of relying on the catch-all rule. (DOR-345)

### Fixed

- Shapes you install now show up in the marketplace's Installed view, where you can uninstall or update them just like plugins and agents.
- Updating the Shape you're currently in keeps you in it: the new version is re-applied automatically, instead of the update silently dropping your cockpit back to no Shape.
- Uninstalling the Shape you're currently in now clears it cleanly, instead of leaving your cockpit pointed at a Shape that's no longer there.
- The install preview for a Shape now shows the real folder its files will land in (`shapes/`), not a `plugins/` path.
- Installing a Shape no longer offers the agent scope choice that was silently ignored — Shapes set up your whole cockpit, so they install once for you.
- A schedule that comes with a Shape — like a tick that checks your Linear inbox every 15 minutes — now switches on by itself the moment its agent exists. Before, a schedule set up ahead of its agent was left switched off for good. Schedules you made yourself are never touched, and one you turned off yourself stays off.
- Agents can now switch which agent you're viewing: when an agent runs the "switch agent" command, the cockpit jumps to that agent's folder and chat, instead of quietly doing nothing. (DOR-354)
- A Marketplace package whose README has a fenced code-block no longer risks crashing the whole page. If the code-block viewer fails to load, the README is replaced by a short note and the package stays open — and a chat message with code survives a broken chunk instead of taking down the transcript.
- The README preview reads package files safely — a symlinked or oversized README can't leak your local files or eat memory (the read is capped at 200 KB and symlinks are rejected).
- The dorkos.ai marketplace page adds back its missing "Shape" filter tab, so you can browse Shapes the way you can Agents, Plugins, Skill Packs, and Adapters.
- The Featured rail on the marketplace page was always empty because it read the featured flag from the wrong place. It now shows featured packages of every type and steps out of the way the moment you search or pick a filter.
- The 16 marketplace category pages are now listed in the sitemap so search engines can find them.
- Marketplace browse now labels its two filter rows — "Type" and "Category" — so they no longer read as two identical rows, and the category filter drops its redundant "All" chip for a small ✕ you click to clear it.
- The Marketplace browse sort menu drops "Popular" and "Recent" — both quietly did nothing — leaving an honest choice between Featured and A–Z.
- The right panel (terminal, files, agent profile) now opens at a comfortable width instead of a squished sliver, and always keeps a readable minimum width. (DOR-388)
- The sidebar no longer spills past its edge while you switch views. The panel that slides in or out now stays neatly clipped inside the sidebar, and slide-out panels, dialogs, and menus animate open and closed instead of popping into place — including the marketplace package details sheet.
- Docs pages now point search engines at a single canonical address and set their own preview title and description instead of falling back to the sitewide default. (DOR-346)
- Link previews on X now match the rest of the page: every page sets its own title and description instead of a generic fallback, and the sitemap reports honest "last updated" dates. (DOR-344)
- Link previews and structured data now show a page's edit date only when it actually has one, instead of inventing a change date. (DOR-344)
- Docs pages now advertise their plain-markdown version, so tools know they can fetch the `.md` alternate. (DOR-345)

## [0.51.0] - 2026-07-17

> Watch messages reach your agents in real time on the topology map, and find every way to install DorkOS on one page at dorkos.ai/install.

### Added

- Watch inbound messages arrive at your agents on the topology map — each message delivered from a connected app sends a quiet pulse along its wire. (DOR-167)
- New install page at dorkos.ai/install with every way to get DorkOS in one place: the Mac app, the one-line terminal install, npm, the Windows early alpha, and Docker, plus how to update. The same address still works with `curl | bash`, and dorkos.ai/download now sends you there. The site's "Get started" button and homepage link to it.

### Changed

- The left sidebar now starts open on desktop for new installs, so your agents are visible from the first launch. Your own toggle still wins: close it once and it stays closed. On phones it still starts closed to save space.

### Fixed

- The dorkos.ai marketing pages and blog no longer break when your computer is set to dark mode. Before, the install commands on the homepage showed as dark text on a dark pill, and the blog's email signup box had a muddy gray fill. These pages are light by design; the docs keep their dark mode.
- Code examples in blog posts have their padding back, so commands no longer touch the edge of the box (a leftover from the docs engine upgrade).
- Release posts now get their Install / Update section from one shared template instead of hand-written copies in all 55 posts, so install guidance stays current everywhere.
- Blog dates no longer show one day early for readers west of UTC.
- Same-day releases now list in the right order on the blog (0.45.1 above 0.45.0).
- Opening a Markdown document in the canvas no longer hides the left sidebar or breaks the app layout.

## [0.50.0] - 2026-07-17

> Organize your agents into sidebar groups that follow you across devices, see at a glance which sessions are running low on context room, and rest easier: the DorkOS tools that can change your machine are now token-protected.

### Added

- Universal command intents (foundation): DorkOS now has one shared registry for the three everyday slash actions — compact the conversation, start a fresh session, and show context usage and cost — plus each agent's words for them (`/compress`, `/summarize`, `/new`, `/usage`, `/status`, and more). This groundwork lets the same command work on whichever runtime your session uses.
- Organize your agents into named groups in the sidebar (DOR-329). Make a group for a project, a client, or however you think about your work. Create, rename, delete, and drag agents in and out. Every drag has a menu and keyboard path too, so you are never stuck. Each group can sort by hand, by name, or by most recent activity.
- See your latest work at a glance with a new "Recent" section (DOR-329). It shows your most recent sessions across all your agents. One click takes you back to what you were just doing.
- Pin an agent and it now stays in its group as well (DOR-329). A pinned agent shows up in both places, so pinning no longer pulls it out of the group you put it in.
- Your sidebar setup now saves to your DorkOS server instead of one browser (DOR-329). Your groups, pins, and sort choices follow you across every browser and the desktop app.
- When a session's context is nearly full, a quiet chip now offers one-click compaction before things slow down (DOR-112)
- Relay metrics now include real delivery-latency percentiles (p50/p95/p99) instead of a placeholder (DOR-166)
- New desktop app guide: install DorkOS as a native Mac app (Windows early alpha included) (DOR-284)
- See at a glance how full each agent's context is, right in the session list. Every session row now shows a small gauge, and the sessions view sums up how many are near full or just auto-compacted — so you can jump into the right agent before it runs out of room. Claude Code sessions show a reading even when they're closed; other runtimes show it once you open the session. (DOR-113)
- Read any doc as clean markdown, or pull the whole docs set into your agent in one fetch. Every docs page is now fetchable as markdown (add `.mdx` to any docs URL), a new `/llms-full.txt` gives your agent the whole hand-written corpus in one request, and a quiet action row above each page lets you copy the markdown or open the page in Claude. "Open in Claude" opens claude.ai in your browser — it's not a Claude Code link. (DOR-165)
- Marketplace installs now remember where each package came from — the source repo, the version you asked for, and the exact commit that was installed. This lays the groundwork for safe reinstalls and contributing changes back. (DOR-147)

### Changed

- External MCP and A2A clients now need your local token when login is off. Health checks and listing tools still work without one, and there is no grace period: paste the token into any client you already set up to keep using the tools that change things. Click "Reveal token" in Settings → Tools → External MCP Server to copy it, or read it from the `mcp-local-token` file in your DorkOS data folder. (DOR-278)
- We no longer auto-pin your default agent (DOR-329). A small set of agents shows as one clean list, and pinning stays something you choose.
- The Windows desktop app now has a standard Windows-style menu (File, Edit, View, Window, Help) instead of a Mac-shaped one (DOR-310)
- Upgraded the docs site's engine (Fumadocs 16.10 and its OpenAPI renderer v11), keeping the docs and API reference on current, supported tooling. (DOR-165)
- Removed a leftover "rate limited" status banner from the chat UI that could never actually appear. (DOR-201)
- Simplified the server's error handling to use Express 5's built-in support for async errors. No behavior change — the same errors are caught the same way, with less wrapper code. (DOR-161)

### Removed

- Removed the per-agent message and hourly-call limits from agent settings — they were shown as editable controls but never actually limited anything. Runaway protection still comes from the per-message budget, which is enforced. (DOR-265)

### Fixed

- Fixed crashed package installs leaving behind backup folders that could show up as duplicate agents. (DOR-175)
- Chat no longer loses its scroll position when you switch away from its tab and back, and it stays pinned to the newest message more reliably while a reply streams in (DOR-163)
- Fixed new development worktrees starting with stale package builds, which caused false type errors until you rebuilt by hand. (DOR-117)
- Pushes that only delete branches no longer run the full pre-push test gate. (DOR-116)

### Security

- The DorkOS tools that change things on your machine — creating agents, sending messages, installing packages — and agent-to-agent calls now need a token when login is off. Before, any program on your computer could call them with no token at all. This closes that open door, the same way Jupyter protects its local server. One honest limit: while login is off, a program running on your computer can still ask DorkOS for the token, the same way the app does. Turning on login is what closes that last door. (DOR-278)
- The activation page now shows the device code on the confirm screen, so you can check it matches what your DorkOS instance is displaying before you approve — even when the code arrives pre-filled from a link. (DOR-200)

## [0.49.0] - 2026-07-14

> DorkOS is easier to run on a server and safer in Docker. You can try it in one command with `npx dorkos@latest`, and start a server from a ready-made Compose file. The published Docker image now runs as a regular user instead of root, checks its own health, and shuts down cleanly.

### Added

- Try DorkOS without installing anything: `npx dorkos@latest` downloads it, starts it, and opens the cockpit in your browser. The first run takes a minute or two; a regular install skips that wait next time.
- Starting DorkOS on a server got simpler: download a ready-made Docker Compose file from [dorkos.ai/compose.yml](https://dorkos.ai/compose.yml) and run `docker compose up -d`. The deployment guide now also explains when to pick Docker and when a direct install fits better.

### Changed

- **BREAKING**: The published Docker image now runs as a regular, unprivileged user instead of root, so a compromised agent or a bug can't touch the rest of the container as easily. Its data directory moved from `/root/.dork` to `/home/node/.dork`.
  - Migration: before starting the new image, fix ownership of your existing data with `docker run --rm -v dorkos-data:/data alpine chown -R 1000:1000 /data` (swap `dorkos-data` for your own volume or host path), then change every `-v ...:/root/.dork` to `-v ...:/home/node/.dork`. See the [Docker guide](https://dorkos.ai/docs/self-hosting/docker#upgrading-from-an-older-image) for the full walkthrough.
- Shrink the published Docker image by dropping the build toolchain it no longer needs at runtime.
- Add tini to the image so DorkOS starts, shuts down, and cleans up child processes properly, no `--init` flag needed.

### Fixed

- The desktop app no longer fails to launch with "Server exited with code 1" when a connected messaging service is slow to respond. Before, if a service like Telegram took too long to answer during startup, the whole app gave up and showed an error. Now the app starts right away and connects your messaging services in the background. The app also waits longer for slow first-time startups instead of giving up after 10 seconds.
- Checking for updates in the desktop app right after a new release no longer shows an error. During the few minutes it takes a release's installer to finish building and upload, "Check for updates…" now tells you the new version is still being prepared instead of showing a confusing error message.
- Fix the Docker image's health check, which never actually worked: the setup guides told you to add a `curl`-based check, but the image has no `curl`, so it silently failed forever. The image now runs its own built-in check every 30 seconds, so `docker ps` correctly reports the container as healthy or unhealthy.

## [0.48.0] - 2026-07-13

> You can now download DorkOS for Windows as an early alpha, alongside the Mac app. This release also moves every bit of analytics onto DorkOS's own site, so no third-party tracker is ever bundled into the app, and it hands you real controls: a Privacy & Data settings tab, command-line switches, and two kill switches that force everything off. A small anonymous heartbeat and usage count are now on by default, but DorkOS shows you the exact data on first run and sends nothing until you have seen it. You can also send your own traces to any observability tool, get crash reports through DorkOS instead of a third party, and send feedback right from the app.

### Added

**Desktop app**

- Download the macOS desktop app straight from dorkos.ai, no terminal required. On a Mac, the install section now shows a "Download for Mac" button (Apple Silicon); the recommended one-line terminal install is still right there for everyone, and Intel Macs use it too.
- Windows desktop app (early alpha). DorkOS can now be built as a Windows installer for 64-bit PCs, with the bundled Claude Code, the built-in terminal, and `dorkos://` links all wired up the same way they are on Mac. It hasn't been confirmed on a real Windows machine yet, so treat it as experimental until we've tested it end to end. (#268)
- Download DorkOS for Windows from dorkos.ai. On a Windows PC, the install section now leads with a "Download for Windows" button and the top navigation offers the download too; the one-line terminal install stays a click away, and other machines see a link to the Windows installer under "Other ways to install." This is an early alpha: the installer is unsigned, so Windows may show a "Windows protected your PC" warning on first launch, and we haven't yet confirmed it end to end on a real Windows machine. (#267)

**See and control your data**

- See and control what anonymous data DorkOS sends. A **Privacy & Data** tab in settings lets you flip each channel on or off, and the first-run onboarding shows you the exact data before anything is sent (DOR-312).
- `dorkos telemetry status`, `dorkos telemetry enable`, and `dorkos telemetry disable` let you check and change telemetry from the command line. Use `--channel install|heartbeat|usage|errors` to change just one.
- Two environment kill switches, `DO_NOT_TRACK` and `DORKOS_TELEMETRY_DISABLED`, force every channel off no matter what your config says. Set either to `1` and DorkOS sends nothing.
- A debug mode: set `DORKOS_TELEMETRY_DEBUG=1` and DorkOS prints the exact JSON it would send to your terminal instead of sending it, so you can read every field for yourself.
- DorkOS now shares a short list of anonymous feature-usage events so we can see which parts of the app get used and make the right things better. Like the heartbeat and install counts, the channel is on by default and sends nothing until the first-run notice has been shown; if you answered a telemetry prompt on an older version, it stays off for you. Only two events ship today: one when the server starts and one when you begin a new agent session. They carry counts and coarse facts (your platform, how many runtimes you have on, which runtime a session uses) and never your prompts, code, file paths, or anything from your sessions. Everything flows through dorkos.ai, so no tracking library is ever bundled into the app. You can see the full list on the [telemetry page](https://dorkos.ai/telemetry), preview the exact events with `DORKOS_TELEMETRY_DEBUG=1`, and turn the channel off in the Privacy & Data settings, with `dorkos telemetry disable --channel usage`, or with `DO_NOT_TRACK=1` (DOR-315).
- Signed-in, opted-in analytics for DorkOS accounts (DOR-316). When you are signed in to your DorkOS account and have analytics turned on, we now tie your website activity to a random account ID (never your name or email) so we can see how signed-in people use DorkOS. If analytics is off, declined, or you are signed out, nothing is tied to you. Deleting your account also erases the analytics record tied to it.
- When you link this install to a DorkOS account, you can now also connect its anonymous usage counts to your account, so you can see them when you are signed in on dorkos.ai. It is off by default: a checkbox in the account-link flow (Settings, DorkOS account) turns it on right before you link. No new data is collected, and the `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` kill switches turn it off too. It only takes effect at link time, so if you turn it on after linking, the connection happens the next time you link (DOR-320).

**Bring your own observability**

- Send DorkOS traces to your own observability stack (DOR-313). Set the standard `OTEL_EXPORTER_OTLP_ENDPOINT` and DorkOS ships its session, runtime, relay, and task spans to your own Jaeger, Grafana Tempo, Honeycomb, or any OTLP-compatible tool. The spans stay sanitized (durations and counts, never prompts, code, or file paths), and nothing goes to DorkOS: it is your data going to your tools. `OTEL_SDK_DISABLED=1` turns all tracing off. See the new [observability guide](https://dorkos.ai/docs/self-hosting/observability).
- See AI run details in your own traces (DOR-319). When tracing is on, every agent turn's span now carries standard OpenTelemetry `gen_ai.*` metadata: which model ran, the token counts, and the cost. Any tool that reads LLM traces picks it up automatically, and it stays your data going to your own tools.
- New opt-in setting to share AI run metadata with DorkOS (DOR-319). Turn on **Share AI run metadata** in the Privacy & Data tab (off by default) and DorkOS sends a small summary of each agent turn: the model, the runtime, token counts, timing, and cost. Never your prompts, your code, or your conversations.

**Feedback**

- Send feedback from the app. A new **Send feedback** button in the help menu opens a small form to tell the DorkOS team what works, what does not, or what you wish it did: general feedback, a bug, or an idea. It goes straight to us and is sent only when you press Send. The **Report a bug on GitHub** and **Request a feature on GitHub** options are still there for when you want a public thread (DOR-317).
- A matching feedback form on the website at [dorkos.ai/feedback](https://dorkos.ai/feedback), linked from the footer.
- Feedback is not telemetry: it is a message you choose to send, so it ignores the `DO_NOT_TRACK` and telemetry switches. Those turn off tracking, not the Send button.

### Changed

- On a Mac, the dorkos.ai install section and the top navigation now lead with the desktop app download. The terminal one-liner stays one step away, still front and center and one click to copy, and a new "Other ways to install" section holds npm and the Windows and Linux notes. On other machines, nothing changes: the terminal install still leads, with the Mac download a subtle link away.
- DorkOS now shares a little anonymous data by default so we can see roughly how many people run it: a small heartbeat (now once a day instead of once a week) and anonymous marketplace install counts. It is anonymous, not personal. It only ever sends a random install id, the version, your OS and chip type, which runtimes you have on, whether the tunnel and cloud link are enabled, and rough counts, never your prompts, code, file paths, or session content. The first time you start DorkOS it prints a plain notice explaining this and sends nothing on that first run; if you do nothing, sharing begins on the next launch. Turn it off any time with `dorkos telemetry disable`, by setting `DO_NOT_TRACK=1`, or in the new Privacy & Data settings tab. If you had already made a telemetry choice, we keep it exactly as it was. Crash reporting is unchanged: it stays off until you turn it on. See exactly what's collected at [dorkos.ai/telemetry](https://dorkos.ai/telemetry) (DOR-314).
- The dorkos.ai analytics now respect where you are and count everyone privately by default (DOR-311). In the EU, EEA, UK, and Switzerland you still get a banner and nothing is counted with cookies until you accept. Everywhere else, basic visit counting is on by default, and you can turn it off in one click on the Privacy page. Either way, if you decline or turn it off, we still count your visit anonymously: no cookies, no stored ID, and no way to link today's visit to tomorrow's. Do Not Track and Global Privacy Control browser signals are honored automatically, and the cookie banner no longer hides behind the bottom navigation.
- Crash reports, if you turn them on, now go to dorkos.ai instead of a third-party service. They are scrubbed the same way as before (no error messages, no file paths, no code, no session content) and stay off until you switch them on. There is no longer anything to set up: the old `SENTRY_DSN` step is gone, so the single `telemetry.errorReporting` switch is all it takes. Crashes in the cockpit itself are now reported too, and you can preview a report any time with `DORKOS_TELEMETRY_DEBUG=1` (DOR-318).

### Fixed

- Playing a game inside a widget now works the way you'd expect. Tapping one square marks only that square, instead of filling the whole board at once. A board stays playable even after the agent sends a follow-up message: only a newer board takes its place. And when the agent sends a fresh board (in the chat, the canvas, or the floating panel) it accepts your next move again rather than freezing. Widget buttons and game boards in your existing chats also keep working after the app's server restarts, instead of failing with "Couldn't send the move" until you type something. When you ask for a game or widget in the floating picture-in-picture view, the agent can now pop it out there directly instead of putting it in the side panel (DOR-302).

## [0.46.0] - 2026-07-12

> The Mac desktop app finally works end to end and ships with its own downloadable installer. A new floating panel lets you pop a live widget or an MCP app out of the chat and keep it in view while you work elsewhere. You can review an agent's edits change by change, and your agent can now see its own preview (console errors, network requests, and a screenshot) to fix its own mistakes. Telemetry, crash reporting, and debug tracing are all new, and all opt-in. A security-hardening pass closes several real gaps, and the docs got a full plain-language rewrite.

### Added

**Desktop app**

- There's now a stable download link for the DorkOS desktop app on Mac.
- You can drag the desktop app window from the top of the sidebar and the header. The sidebar no longer hides behind the Mac window buttons, whether it's expanded or collapsed. Links you click in the app now open in your regular browser instead of popping up a broken, chrome-less extra window (DOR-253)

**Pop things out into a floating window**

- Pop an interactive app or a live widget, like a tic-tac-toe board, out of the chat into a small floating window that stays on top while you move around DorkOS. It keeps working there, even after you switch sessions, until you close it. Use the pop-out button, or let the app open itself that way (DOR-296, DOR-297, DOR-298)
- On phones, popped-out widgets and apps dock to a bottom sheet instead: it opens at half height so you can glance at it, drags up for more room, and drags down to a small bar you can tap to bring it back or close (DOR-299)

**Review your agent's edits**

- Review your agent's edits change by change. When an agent edits a file, the workbench now opens a diff showing exactly what changed, and you can accept or reject each block on its own. Reject undoes just that block on disk and leaves the rest; accept keeps it. There's a reject-all, a mark-reviewed, a side-by-side view on wide screens, and a toggle to compare against your last commit instead. If the file changes while you're reviewing, you get a calm refresh notice, never a silent overwrite. Text diffs work in the web app and the Obsidian plugin; turn off the automatic open with `workbench.autoOpenDiff` (DOR-212)
- Changed images get the same treatment, GitHub-style: see before and after side by side, drag a divider across them, or blend between them with a slider. Restore the previous image with one click, or mark the new one reviewed. A brand-new image says so honestly instead of pretending there's something to compare (DOR-212)

**Your agent can see its own preview**

- Your agent can now check its own work in the workbench browser. After it opens a page, it can read the console errors and failed network requests and take a screenshot of the rendered page, so it can catch a broken layout, a stray error, or a blank screen and fix it, all without you describing what went wrong (DOR-213)

**Get notified**

- Get a message when a scheduled task finishes, so you don't have to sit and watch it. Connect a channel like Telegram to the agent, then turn on "Message me when tasks finish." Failures always reach you; turn the switch off to skip the runs that succeed. One-time setup: message your bot once so it's allowed to text you back, and turn on "Agent can start conversations."

**Opt-in telemetry, crash reports, and diagnostics**

- DorkOS can now send an anonymous weekly heartbeat so the project can roughly count how many people are actively running it. It's off by default and asks once, on first run, showing you the exact data before you choose. It only ever sends a random install id, the version, your OS and chip type, which runtimes you have on, whether the tunnel and cloud link are enabled, and rough counts, never your prompts, code, file paths, or session content. See exactly what's collected at dorkos.ai/telemetry (DOR-293)
- DorkOS can send a crash report to your own Sentry or self-hosted GlitchTip project when something breaks, so a bug can get fixed without anyone asking for your log files. It's off by default and is its own separate choice, never turned on by the telemetry banner. It sends only the error type and a cleaned-up stack trace (which function, file, and line), never the error message, your file paths, tokens, or anything from your sessions. Turn it on by setting `SENTRY_DSN` and flipping `telemetry.errorReporting` (DOR-293)
- A new `dorkos --debug-trace` mode writes a local timing file you can send when reporting a bug. It records how long session turns, agent calls, relay messages, and task runs take, durations and counts only, never your prompts, file paths, or anything you typed. It's off unless you ask for it, and the file stays on your machine (DOR-294)

**Setup and support**

- New: `dorkos doctor` checks your setup and tells you what's wrong in plain words. It checks your Node version, whether your data folder is writable, whether the port is free, whether the Claude Code CLI is installed, whether extensions can compile, and whether your login and tunnel settings make sense. It reads your config and changes nothing.
- Report a bug or ask for a feature without hunting down your setup details. Open the command palette (Cmd/Ctrl+K) and pick "Report an issue," use the new help menu at the bottom of the sidebar, or run `dorkos feedback` in your terminal. DorkOS opens a prefilled GitHub issue with your version, operating system, runtimes, and on/off settings already filled in. You see and edit everything before you submit; only safe on/off values are included, never tokens, file paths, or anything from your sessions (DOR-292)

**Docs and pricing**

- New docs pages: a plain-language "What is DorkOS?" intro for people who don't code, a troubleshooting and FAQ page, a glossary, a guide to the workbench (files, terminal, and browser next to your chat), and a guide to publishing your own marketplace packages. The Generative UI guide also picked up a real recording of tic-tac-toe in action.
- New: a [Pricing](https://dorkos.ai/pricing) page that spells out our money plan before anything actually costs money. Everything DorkOS ships as free stays free, forever; money will only ever come from a future cloud service, and we'll always announce a real price here before you see a bill.

**Small stuff**

- Navigate tab strips with the keyboard: arrow keys move between tabs, Home/End jump to the ends, Delete closes the focused tab.
- Celebrations now come in six styles instead of one: a bigger multi-stage burst, aerial fireworks, side cannons, a calm confetti drizzle, a golden star pop, or an emoji shower with any glyph you like. Agents can trigger any of them, and the Dev Playground has a new Celebrations showcase to try each one.
- The workbench browser now keeps each document's back-and-forward history separate, so switching between browser tabs doesn't scramble your navigation history (DOR-252)

### Changed

- In the desktop app, most of the interface now reads like an app instead of a document: text in the sidebar and navigation is no longer selectable. Chat messages, code blocks, and other content you'd actually want to copy still are (DOR-253)
- The little faces agents use to show how things are going got a real glow-up. Every face now has eyebrows and its own body language: a happy face bobs gently and breaks into a closed-eye smile every so often, a sad one sits heavy with a slow tear, a determined one furrows its brow while tiny steam wisps rise, a sheepish one blushes as a sweat bead slides down, a surprised one startles with its brows shooting up as its mouth pops open, a thinking face glances around while its dots ripple, heart-eyes pulse each to their own beat, and the celebrating face bounces with a happy squash on every landing. Blinks are more human too, with the occasional double-blink. Everything still matches your theme in light and dark; if you prefer reduced motion, the faces hold still but stay just as expressive.
- X and O now have their own colors in board games like tic-tac-toe, X in blue and O in amber, so you can read the board at a glance. The colors stay distinct for colorblind players in both light and dark themes. If the agent styles a square itself, that styling still wins.
- Friendlier wording on old game boards and buttons: an out-of-date board now says "This board is from an earlier turn, play on the newest one," and an old button says "This one's from an earlier message," instead of the jargon-y "Superseded" label.
- The docs got a full makeover. Every page was rewritten in plain language, checked against the code, and organized around what you're trying to do. The sidebar now groups guides by activity (daily driving, making it yours, going autonomous, scaling to a fleet), and the landing page routes you by who you are instead of listing every page. Stale docs are gone: pages no longer describe commands, methods, or behaviors that don't exist anymore (#207)
- The dorkos.ai privacy and cookie pages now spell out exactly what analytics would collect if we ever turn them on: page visits and a few clicks, no session recording, nothing until you accept the cookie banner. Analytics stays off, and with no key configured the site makes zero requests to PostHog (DOR-268)
- The remote-access screens and the tunnel guide now tell you up front what setup takes: about 2 minutes, one time, to create your owner login and paste a free ngrok token. After that, approving from your phone really is one tap (DOR-244)
- Your Telegram and Slack bot tokens are no longer saved as plain text. DorkOS now moves each token into your computer's encrypted store and keeps only a pointer to it in the settings file, so a leaked or shared config file no longer exposes your bots. Bots you already connected keep working; their tokens are moved for you the first time DorkOS starts, with nothing to reconfigure (DOR-280)
- Telemetry consent is now one clear choice covering both the new heartbeat and the existing marketplace install stats, instead of a marketplace-only banner. Everything stays off until you say yes, and you can change your mind anytime in settings (DOR-293)
- When an agent compacts its context to free up room, the status strip now shows a clean progress bar that starts when compaction begins and clears when it finishes, and it works the same way across every coding agent, not just one. If a compaction fails, you see the reason inline instead of a stuck indicator (DOR-110)

### Fixed

**Desktop app**

- The desktop app now starts correctly when installed from the DMG. Before, its built-in server was missing from the package, so the app sat in the Dock with no window and no error; if the server ever fails to start now, the app tells you what went wrong instead of silently doing nothing. App updates now install correctly, and the embedded terminal works in the installed app.
- The Mac desktop app now includes everything it needs to run Claude Code out of the box: the Claude Code program ships inside the app and starts up right away, so your agents can run without a separate install.
- Extensions, including the built-in Linear dashboard and sidebar, now load in the desktop app. Before, every extension request went to the desktop window itself instead of the DorkOS server, so the extension system silently gave up on startup (DOR-243, DOR-255)
- The update card no longer tells you to run `npm update -g dorkos`, a terminal command that updates the CLI, not the app you're using. When the desktop app has downloaded a new version, the sidebar now shows a simple "Update ready, restart to install" card, and the button restarts the app to finish the update.

**Game boards (tic-tac-toe and friends)**

- A very fast double-click, or any burst of clicks, on a game board can no longer send more than one move. The first click wins instantly; the rest are ignored. Before, clicks landing in the same instant could all slip through and corrupt the game.
- Boards no longer treat a blank space as a real mark. Some agents write a space character for an empty square, which used to draw a phantom dot in every empty cell, garble the square's screen-reader name, and, on a completely empty board, declare victory with a stroke through a row of nothing. Blank squares are now truly blank.
- The victory stroke is now what it was meant to be: a thin, softly translucent line through the winning squares, colored to match the win. It used to render as a thick black bar that buried the marks beneath it.
- The board now always matches the agent's actual moves: it works out the new game state first, then draws from that state, so the two can't drift apart. If the agent's game record and what's drawn on screen ever disagree, even over a bit of padding or a stray blank line in how the agent wrote it down, the board trusts the record, draws any mark that's missing, and locks that square, without ever erasing or changing a mark you can already see.
- Widgets no longer flash a "couldn't be rendered" error while they're still arriving. When the agent streams a widget, like a game board, the reply sometimes paused at just the wrong spot, showing an error card for a split second before the widget popped in. Now a widget that's mid-arrival keeps its calm loading shimmer until it's truly done; the error card only appears if the finished widget is genuinely broken.
- Clicking a game-board square now keeps your mark on the board while the agent replies. Before, the mark vanished the instant you clicked and the whole widget flickered through its entrance animation again.

**Claude Code, Codex, and OpenCode sessions**

- Stop the stray "No response requested." reply that could appear before your message in a Claude Code session. Your messages now always run as the next turn, with nothing slipped in first.
- DorkOS now finds your Claude Code sessions even when you use a custom Claude config folder (`CLAUDE_CONFIG_DIR`); sessions used to run and bill normally but never show up in your session list (DOR-250)
- Installing a Claude Code plugin now actually puts its commands and skills where your agents can use them. Before, a project install would report success but quietly project zero files, so neither DorkOS sessions nor the `claude` CLI could see the plugin. The pre-configured official Anthropic marketplace works now too, and real published plugins like `hookify` are no longer rejected over a harmless naming quirk that Claude Code itself accepts.
- Codex and OpenCode conversations now keep their history when the DorkOS server restarts. Every completed reply is saved to disk the moment its turn finishes, so the full conversation is right where you left it.
- OpenCode sessions keep the same id after you restart the DorkOS server. Before, a restart quietly re-keyed every OpenCode conversation under a new id, so bookmarks and open tabs hit a dead "session not found" page while the same conversation reappeared in the list as a stranger (DOR-251)
- Codex sessions no longer slowly fill your disk with logs; the Codex engine no longer writes endless debug records to its log database (DOR-188)
- Sessions that don't belong to any project no longer get announced to every open cockpit. Before, a Codex or OpenCode session with no working directory could show up as a nameless ghost row under agents it had nothing to do with (DOR-202)
- Enabling a coding agent whose command-line tool isn't installed no longer stops DorkOS from starting; that agent is skipped with a warning and everything else works.

**Scheduled tasks and usage**

- Scheduled task history now shows the truth: finished runs stay finished, even after a restart. Runs used to get stuck showing "running" forever even though they'd actually succeeded, and a server restart could rewrite that entire successful history to "failed" (DOR-248, DOR-249)
- Creating a scheduled task now shows its next run time right away, instead of only after refreshing the task list.
- The usage item in the status bar now actually shows your Claude subscription usage, including a less common weekly usage window some accounts have. It updates at the end of every reply with how much of your rate-limit window you've used and when it resets. Before, it stayed empty unless you were about to hit a limit (DOR-99)
- The Marketplace card in Settings > Extensions now says "Required" instead of showing an on/off switch that did nothing. If you flipped that dead switch in the past, Marketplace turns itself back on (DOR-122)
- A brand-new install no longer prints a scary "initial scan failed" warning at startup. Having no Claude Code sessions yet is normal, and the log now treats it that way (DOR-247)

**Sign-in, working directories, and setup**

- Signing in after `dorkos auth enable` now works on a fresh install. Before, turning on login and then signing in failed with a server error unless you happened to set a secret environment variable by hand, and nothing told you it was needed. DorkOS now creates and remembers that secret for you the first time you enable login, so sign-in just works. This also unblocks exposing your instance over a tunnel, which requires login first (DOR-242)
- DorkOS installed from npm or the one-liner now correctly sets up its built-in extensions (Marketplace, Linear, Hello World) on first run, and the Marketplace tab itself now loads instead of failing; the published package was silently missing the files it needed (DOR-245, DOR-256)
- Fixed the default working directory sometimes pointing outside the allowed folder, which could block opening a terminal or starting a new session. The git status panel now falls back to your workspace's real default folder when none is picked, instead of wherever the server process happened to start (DOR-266)
- Building DorkOS from a fresh checkout now works on the first try; a naming collision between the root project and the CLI package used to make the build trip over its own files (DOR-190)
- The docs, the install script, and the website now all correctly say DorkOS requires Node.js 22 or later, instead of the outdated "18 or later" that printed a wall of warnings on install (DOR-246)
- Opening the same terminal in a second window no longer silently kills it in the first; the first window now shows a note that the session moved. Reconnecting after being away also tells you when some output was dropped (DOR-257)
- The status bar no longer shows a stray thin scrollbar under its fade edge, and the chat message list hides its scrollbar the standard way (DOR-164)

**Agent messaging safety**

- Agent-to-agent call budgets now actually stop the spending, not just the mailbox copy. Before, a message that had run out of budget was correctly refused delivery, but the target agent still ran a full, paid turn anyway. The budget check now happens once, up front: an out-of-budget message is dead-lettered, no agent turn starts, and a caller waiting on a reply is told immediately instead of timing out (DOR-260)
- The "agent can start conversations" switch on a channel now controls every way an agent could message you, not just the built-in "notify me" action. Before, an agent could still reach you on Telegram or Slack by addressing the raw channel directly even with the switch off. Replying to something you sent first, and your task-done notifications, keep working exactly as before (DOR-239, DOR-277)
- Installing a marketplace package can no longer plant a shortcut that reaches outside where it's installed. A package could previously ship a symlink that, once copied and synced, let it read or write files outside its own folder. Every symlink is now dropped while the package is being staged, and each one is noted in the install log. Real packages are unaffected; they're plain files and folders, never shortcuts (DOR-279)

**Docs media pipeline**

- Product videos and screenshots in the docs now fill their frame edge to edge; before, they showed a gap at the top and were cut off at the sides.
- Video previews in the docs and release notes now show the finished widget instead of a loading skeleton, and a botched capture can no longer publish a set with missing files. The capture pipeline itself now starts and stops cleanly between runs instead of occasionally hanging or recording against the wrong server.

### Security

- Hardening pass on the parts of DorkOS that decide what a package can do and who can reach it: marketplace installs can no longer be tricked into running a command through a booby-trapped source link, your login secret and any chat-bot tokens are now kept private on disk and readable only by you, and the key that protects the tool endpoint is checked in a way that gives nothing away. Full write-up in `research/20260711_security-hardening-audit.md`.
- Sign-in and sign-up now slow down after too many tries from the same place, so no one can sit there guessing your password. A few mistyped tries still work fine (DOR-281)
- Cleared the last critical security warning in our test tooling; `npm audit` on the DorkOS source no longer reports any critical findings (DOR-168)

## [0.45.1] - 2026-07-09

> A same-day fix for widget interactions: clicks and form submits with bigger payloads no longer lose their data.

### Fixed

- Fixed widget clicks and form submits losing their data when the payload spanned multiple lines, both live and when a session reloads. A protocol change in 0.45.0 left the payload parser behind. (#185)

## [0.45.0] - 2026-07-09

> The right panel grows into a real workbench (terminal, file explorer, embedded browser), agents can answer with interactive widgets you can click, Codex and OpenCode join Claude Code in one cockpit, and DorkOS accounts replace tunnel passcodes with real login.

### Added

**Run Claude Code, Codex, and OpenCode side by side**

- Run Codex and OpenCode agents next to Claude Code, all in one cockpit. Every session shows which runtime it belongs to, and the session list keeps working even when one runtime is down.
- Switch runtimes right from the chat composer: pick Claude Code, Codex, or OpenCode for a new session, and DorkOS remembers the choice per session.
- Connect a runtime account without leaving DorkOS: guided connect flows check what's installed, walk you through login, and store credentials as secure references (never plaintext).
- DorkOS detects which runtimes are installed on your machine and offers the ones that are ready, so getting a second runtime running takes one click instead of a config file.
- See what a session is costing you while it runs: token usage and cost now show in the status strip for every runtime that reports them.
- Give each agent its own isolated workspace: DorkOS can create and manage git worktrees (or clones) with their own ports, so parallel agents never trample each other's checkout. Browse and manage them on the new Workspaces page.

**Generative UI: widgets in chat and canvas**

- Agents can render real, interactive widgets in chat instead of walls of text: stat cards, tables, lists, charts, progress bars, images, and forms. A malformed widget degrades to a small error card instead of breaking the chat.
- Click a widget's button, pick from a list, or submit a form, and the agent picks up exactly where you left off: it sees what you did and answers in its next turn.
- Four more widgets: a timeline for sequenced events, a checklist that reports back what you checked, a compare table that highlights the best option, and a star rating.
- Three playful widgets: a mood face that blinks and emotes, a board for turn-based games like tic-tac-toe you can play right in chat, and a reveal that flips a coin, rolls a die, or shakes a magic 8-ball. Agents can also fire confetti on their own.
- Widgets feel alive: they rise into place, numbers count up, progress bars fill, and charts draw themselves in. Turn on reduced motion and every widget appears instantly instead.
- Skills can ship reusable widget templates with fill-in-the-blank placeholders, so agents don't hand-build the same widget JSON every time.
- MCP servers can ship full interactive apps that render right in chat or pop out to the canvas (the MCP Apps standard, SEP-1865). The first app from a server always asks permission before it renders, and apps can never reach your files, cookies, or credentials.
- View images and PDFs right in the agent canvas, with click-to-zoom on images.

**The workbench (right panel)**

- Run a real shell in the cockpit: open a Terminal tab in your session's working directory without leaving DorkOS (web only).
- Open more than one terminal at once, with tabs to switch between them; your open terminals survive a page refresh.
- Browse, open, and edit your project's files without leaving DorkOS: a file explorer with create, rename, delete, and drag-to-move, a code editor, a 3D model viewer, a CSV viewer, and image zoom, all in one multi-document canvas.
- Open an embedded browser in the canvas with back, forward, reload, and an address bar, for any URL, local HTML file, or dev server.
- Agents can drive the workbench for you: open a file, reveal the terminal, or navigate the embedded browser, on both Claude Code and Codex.
- The right panel remembers which tab was open, per agent, so it's where you left it next time.

**Your DorkOS account and cloud**

- Create a DorkOS account at dorkos.ai with email and password, GitHub, or Google. It's your identity, separate from any one DorkOS install.
- Link a self-hosted DorkOS to your account from Settings > DorkOS account (or `dorkos cloud login`): approve a short code at dorkos.ai/activate, then see and revoke linked instances anytime.
- Turn on owner login for a self-hosted instance from Settings > Security. It's off by default; once on, DorkOS requires an owner account before anyone can reach it, with no email server needed.
- Give MCP clients, scripts, and agents their own scoped API keys instead of one shared key (Settings > Security). Existing global keys migrate automatically.
- Recover a lost password or create the owner account from the command line with `dorkos auth enable` and `dorkos auth reset-password`, no running server or email required.
- Manage cloud accounts from a new admin console: view accounts, and let people self-serve delete or export their data, with every admin action logged.
- Sign up for the DorkOS newsletter right from the site, with double opt-in confirmation.

**Desktop app**

- Open the desktop app straight to a page with `dorkos://` links.
- A real Mac menu: Cmd+comma opens Settings, and there's a proper About window and Help links.
- The desktop app checks for updates on its own, or you can check anytime; you choose when to restart.

**Extensibility and platform**

- Extensions can subscribe to live session, turn, tool, and relay events instead of polling, declared right in their manifest. Events never carry your conversation content.
- The external MCP server (`/mcp`) now lists browsable resources for sessions, agents, and skills, and every tool says whether it's read-only, destructive, or reaches the network, so MCP clients can be careful without asking you first.
- See and manage everything installed from the Marketplace, across global and per-agent installs, in one Manage Installed view; get a warning before an extension-bearing package affects every agent; and share a Marketplace search or filter as a URL.
- Installed plugins now project their commands, skills, and hooks to Cursor and GitHub Copilot too (Gemini support isn't there yet), and re-sync automatically whenever you install or uninstall one.
- Scheduled tasks now have real safety rails: they only fire in production, one leader owns dispatch, and a task can't fire twice for the same run.

**Docs and legal**

- Documentation guides now show the same real product screenshots and video clips as the marketing site.
- Plain-English privacy, terms, and cookie pages.

### Changed

- Rewrote the npm README, root README, Mesh concepts guide, Generative UI guide, and MCP feature page in plain language, so you can tell what DorkOS does before you dig into the reference details.
- Rewrote the dorkos.ai feature catalog and FAQ in plain language, and reframed the homepage around "You, multiplied": one thesis section, plainer problem cards, and a real origin story in the closing section.
- Renamed the in-app marketplace from "Dork Hub" to "Marketplace."
- The right panel's tab strip can no longer disappear out from under a panel.
- Product-media recordings can now run in parallel (`capture:record --shards N`) instead of one long serial pass.
- You can edit one canvas document while agents keep updating the others.
- Relay (the message bus between agents) now cleans up after itself: expired messages, stuck deliveries, and abandoned mailboxes are swept on a schedule instead of piling up forever.

### Removed

- **Breaking:** Tunnel passcode protection is gone. Better Auth login is now the only way to protect DorkOS. If you expose DorkOS (start a tunnel or bind to a non-loopback address), you must turn on login and create an owner account first. Old passcode settings are dropped automatically on upgrade, not migrated.
- `/flow` no longer ships inside the DorkOS repo. Install it from the Marketplace instead; it works the same way.

### Fixed

- Agent-to-agent messages and A2A tasks now report a real failure instead of a fake success when an agent's turn crashes or times out.
- Fixed several ways relay messages could go missing: adapter start-up races, silent delivery failures, and Slack/Telegram formatting and reconnect issues.
- Recover agents that go unreachable, and clean up properly when one is unregistered.
- Ghost Codex sessions no longer show up under every agent; sessions without a working directory now belong to no project, and untitled sessions show "Untitled session" instead of a blank row.
- `get_ui_state` and `control_ui` now tell agents the truth: current state instead of stale data, and a clear error instead of a fake success when no client is attached.
- Generative UI widgets now tolerate the natural, slightly-off-spec values agents actually write (pixel numbers, percentages over 100, alternate wording) instead of failing outright.
- Fixed widgets flickering between their loading skeleton and final content while a reply streams in, fixed gaps in chart lines on certain slopes, and fixed images not refreshing when their source changes.
- Clicking a widget (like a tic-tac-toe square) now always gets a response from the agent, the board can't drift out of sync, and a widget locks the moment you play so a stray double-tap or a stale reload can't corrupt it.
- Fixed the Terminal tab sometimes failing to reopen, and hardened the terminal's WebSocket connection with an origin allowlist.
- Closing a terminal tab the instant it was created no longer leaks a hidden shell process: a terminal that finishes starting after its tab is gone is cleaned up (or kept for re-attach when grace applies).
- Renaming or moving a file in the workbench no longer conflicts when two names collide, and file/folder deletes can no longer escape the project through a symlink.
- The canvas file viewer now shows your latest edits right away, and a refresh button reloads the newest version from disk.
- Every embedded webpage in the canvas now has real browser controls (back, forward, reload, address bar); before, agent-opened pages had none.
- Fixed the desktop app opening a second window when launched twice, and fixed it forgetting its window position after a monitor change.
- Fixed the desktop app showing a black window in development: its pages were blocked from talking to its own server.
- Fixed CORS so the browser correctly sends credentials to allowed origins.
- Marketplace pages (browse, package detail, install privacy) now show the site header and footer instead of dead-ending.
- Fixed several marketplace install bugs: replaced an unsafe git-branch rollback with a safer file-scoped transaction, made package downloads concurrency-safe, and added toast feedback when an install or update fails.
- Site fixes: no more stale claims or dead links, PostHog analytics only run after you consent, the feature-card layout no longer has gaps or cropped screenshots, and pages render correctly on first paint.
- Connecting a runtime now selects and launches it right away, and Codex sessions now match Claude Code for models, MCP tools, and slash commands.
- Linking a self-hosted instance to your DorkOS account no longer fails on device-link.

### Security

- Agent-to-agent messages now carry a verified sender identity, and DorkOS enforces that agents in different namespaces can't message each other unless you allow it.
- The external MCP server's mesh tools now enforce the same directory boundaries as the HTTP API, so a caller can't register agents outside the allowed folders.

## [0.44.0] - 2026-06-16

### Added

- Agent context (git status, UI state, queued-message notes) now travels alongside your message instead of inside it — your message reaches the agent exactly as written, and that context never shows up as if you had typed it (#258)
- Agents no longer receive git status twice per turn, trimming redundant prompt context (DOR-132)
- Surface session hook progress ("Running hook X…") in the chat status strip, clearing when the model resumes (DOR-125)
- Tiered command/file palette ranking + alias provenance (DOR-119, DOR-120)
- Render local slash-command output in chat (DOR-126)
- Introduce Core Extensions tier (rename builtin → core)
- Match slash commands by their aliases in the palette, and refresh the command
  list when the agent changes it mid-session (DOR-108)
- Persist a context-compaction row in chat ("Context compacted · N tokens ·
  manual/auto") sourced from the durable transcript, plus a live "Compacting
  context…" strip that resolves and an inline failed-compaction notice (DOR-118)

### Changed

### Fixed

- Chat status strip was starved of live `system_status` events (the projected turn dropped them), so "Compacting context…" and hook progress only appeared after the durable history reload — now retained live (DOR-125, completes DOR-118)
- Open the canvas when an agent pushes content (DOR-97, DOR-104)
- Apply enable/disable live instead of requiring a page reload

---

Older releases (v0.1.0 – v0.43.1) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.43.1.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.43.1.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.53.0...HEAD

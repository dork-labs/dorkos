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

## [0.135.7] - 2026-11-12

> DorkOS 0.135.7 makes Unblock agent work over Remote Access again, makes the agent's own Chrome window easy to spot, and makes handing the browser to you simpler.

### Note for people upgrading

- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- Removing a global MCP server stops new chats from using it. Chats that are already running keep it until they end or you restart them. If you remove a server because you no longer trust it, restart DorkOS so no chat can still reach it. The Connections guide says so (DOR-3872).
- Agents below Full can no longer change saved browser sign-ins with their file tools, or from a shell on Claude Code, including `dorkos browser login` and `dorkos browser forget`. To let an agent save a sign-in, set it to Full. This works on Claude Code and Doe only; on Codex and OpenCode, no agent can. (DOR-4136)
- If you added a Playwright browser to an agent with options that save browser state, write files or run a file at start, DorkOS now leaves it out of that agent's chats. Remove those options to use it again. (DOR-4136)
- In **New browser window** mode, DorkOS now uses your installed Google Chrome when it finds it. When an agent hands you the browser there, its window closes and the page opens for you in a plain browser window (your installed Chrome, if DorkOS found it). Anything typed into a form on that page doesn't carry over. An agent can only hand you a site whose address starts with `https` (or `localhost`). (DOR-4178)
- For scripts: `DELETE /api/mesh/denied/{encodedPath}` is now `DELETE /api/mesh/denied?path=<folder>`. The marketplace source routes also take the name as `?name=`: `DELETE /api/marketplace/sources?name=` and `POST /api/marketplace/sources/refresh?name=`. The old source routes still work. A browser tab left open from before the upgrade needs a reload before **Unblock agent** works. (DOR-4212)

### Security

- Agents below Full can't change the browser sign-ins DorkOS keeps: the sign-ins saved by `dorkos browser login`, the Agent browser's profiles and saved sign-ins, and the desktop app's data folder. Their file tools refuse on every runtime, and so does a shell command on Claude Code. An agent you set to Full can now save a sign-in on Claude Code and Doe, the way you can. That includes the Agent browser's profiles, which 0.135.6 kept from every agent. (DOR-4136)
- DorkOS now leaves a Playwright browser out of an agent's chats when its options save browser state, write files or run a file at start. This holds at every level, Full included. Options that bring their own config were already left out; now every spelling of them is. (DOR-4136)
- Signing in on a browser profile that no longer exists is refused, instead of quietly making it again. (DOR-4180)

### Added

- **Pictures in a room's Files list now open as pictures.** Before, they said only text files could be shown. SVG files still open as text. (DOR-4179)

### Fixed

- **Unblock agent works over Remote Access again.** In 0.135.6 it failed from another device, over both DorkOS's remote access and your own ngrok tunnel. That known issue is fixed. (DOR-4212)
- Over Remote Access, a picture you attached in a chat now shows when DorkOS runs on Windows, and you can refresh or remove a marketplace source saved by an older DorkOS whose name holds a `/`. (DOR-4212)
- **When a site needs you, the handoff is simpler.** In **New browser window** mode, the page opens for you in a plain window: sign in or finish the check, close the window, then press **Continue**. In the Mac app's panel, you finish right in the panel, then press **Continue**. The agent can't use the browser until you hand it back. A long site name now wraps in the card's title, so no button runs off the edge on a phone. (DOR-3112, DOR-4178)
- After you hand the Agent browser back, DorkOS wakes the agent itself, whether you pressed **Continue** or resumed the browser yourself. Before, it woke only if the card's own message got through. The card, in the chat and in the Inbox, then becomes one quiet line saying how it ended, for example "Atlas is carrying on.", "Stopped. Atlas won’t carry on with this." or "The window closed. Atlas stopped here." (DOR-3112)
- While you finish one agent's handoff, no other agent can use the Agent browser. (DOR-4178)
- **The agent's Chrome window is easy to tell apart.** When DorkOS uses your installed Chrome, each agent window gets an orange colour and the agent's name. In the Mac app's panel, websites now see an ordinary Chrome-style browser at its real engine version, without the app's name in it. (DOR-4178)
- Putting a room file back on the canvas shows its tab again, even after you closed that tab. In a file preview, the line under the name now shows its folder ("Top folder" at the top), not the full path. (DOR-4179)
- After you close the Agent browser's window, **Forget…** works on its saved sign-ins right away. It no longer asks you to close a browser that's already closed. (DOR-4181)
- The Agent browser can read a page built in an unusual way, with two main page sections. Before, the read failed, and the agent was stuck on that tab. (DOR-4192)
- An agent can always open another page, even after it couldn't read the one it's on. It still can't while you have the browser or it's paused, or go anywhere it's not allowed to go. (DOR-4192)
- When an agent asks to read and change things in an app, it no longer hears "You can now read" as if that were everything. Its answer now says it can't change anything there, and why. Maybe you picked Read. Maybe the app has nothing to change. Or maybe the app's change actions are allowed one at a time, as with Linear today. (DOR-4193)
- When an agent that has only Read asks again to change things, you now see a card. Before, for an app like Linear, it could be told it already had access without you seeing anything. (DOR-4193)
- When an agent asks to change things in an app that can only give Read, the access card now says so before you answer. If the app has actions that change things, it tells you to choose exact actions on the Connections page. (DOR-4193)

### Going back

0.135.7 doesn't change the database or your settings. To go back, install 0.135.6. On 0.135.6, **Unblock agent** over Remote Access fails again, and scripts must use the old route that puts the folder in the address. Browser profiles that 0.135.7 opened in your installed Chrome may keep an agent's orange colour and name, even in the sign-in window.

## [0.135.6] - 2026-11-11

> DorkOS 0.135.6 makes a file you closed open again when you click it, refuses tricky addresses over Remote Access, and smooths several rough edges in the Agent browser.

### Note for people upgrading

- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- Removing a global MCP server stops new chats from using it. Chats that are already running keep it until they end or you restart them. If you remove a server because you no longer trust it, restart DorkOS so no chat can still reach it. The Connections guide says so (DOR-3872).
- Over Remote Access, **Unblock agent** on an agent's profile doesn't work for now. Unblock it on the computer running DorkOS.
- Over your own ngrok tunnel, the agent-to-agent address (`/a2a`) and its agent cards now answer "Not found" from another device, the same as over DorkOS's remote access. On this computer nothing changes.
- The Agent browser no longer has named profiles. Profiles made before stay on disk until you choose **Forget…**, which now clears them along with the shared sign-ins. Scripts that call `POST /api/local-browser/profiles` now get a 403 `profiles_closed` error. (DOR-4105)

### Security

- **Addresses with tricks like `..` in them are now refused from another device,** over both your own ngrok tunnel and DorkOS's remote access. The agent-to-agent pages were never open to another device without a key, so this is defence in depth, not an open door.

### Fixed

- **Clicking a file in the Files tab opens it again after you closed its tab.** Before, the click seemed to do nothing. (DOR-4179)
- A room's Files list no longer asks for folders from the agent you browsed before. (DOR-4179)
- In **New browser window** mode, the window your agent drives now shows which agent is using it, for example "Atlas is using this window". When a site asks for a check only a person can do, the card in the chat also says "Your turn: Atlas can’t see or use this window." While you have the browser, your agent can't read the page, take a picture of it, or act on it, whichever AI app it runs on. (DOR-3111)
- While you have the Agent browser after your agent hands it to you, its panel lists each tab by its site only, such as `https://accounts.example.com`, without the rest of the address or the page title. A sign-in page's address or title can carry a one-time code, and both stay out of view until the handoff ends. (DOR-4163)
- The Agent browser panel now shows one **Saved sign-ins** row: "Kept apart from your own browser. Every agent here shares them." **Forget…** asks before it signs every agent out of every site, including sign-ins kept for any older named profile. It replaces the old list of profiles. (DOR-4105)
- If the folder holding the Agent browser's saved sign-ins was changed outside DorkOS, **Forget…** now answers "Sign-ins weren’t forgotten" and "Their folder was changed outside DorkOS, so DorkOS left it alone." with a single **Close** button. It used to tell you to close the browser's windows and try again, which could never work. What was found is also recorded in the audit log. (DOR-4172)
- When the Agent browser isn't open, its panel now says "Not open yet" instead of "Disconnected", which made it look broken. It says "Disconnected" when a browser it was showing as open disconnects. (DOR-4104)
- An agent browser set up with a custom browser path or a shared profile no longer looks like it should work. Its card in the agent's MCP servers list now says **Not used** and reads "DorkOS uses its own browser for agents. Custom browser paths aren't allowed." (DOR-3207)

### Going back

0.135.6 doesn't change the database or your settings. To go back, install 0.135.5. On 0.135.5, any older named browser profiles show in the Agent browser panel again, signed out if you used **Forget…**.

## [0.135.5] - 2026-11-11

> DorkOS 0.135.5 is a security release. The agent browser no longer offers a tool that runs code outside the page, and agents now ask before they add work to a queue. This release changes the database, so read Going back before downgrading.

### Note for people upgrading

- This release changes the database. Read Going back below before downgrading.
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- **An agent now asks you before it adds work to any queue, its own included, even at Full autonomy.** These cards have no Always allow. When nobody is there to answer, the agent is refused instead.
- Work an agent queued before this update that hasn't started yet will run read-only. If it needs to change files, remove it and add it again yourself from the agent's Work queue page. You'll need to type its first message again.
- Removing a global MCP server stops new chats from using it. Chats that are already running keep it until they end or you restart them. If you remove a server because you no longer trust it, restart DorkOS so no chat can still reach it. The Connections guide now says so (DOR-3872).

### Security

- The agent browser no longer offers a tool that runs code outside the page (DOR-4156).
- Agents' file tools can't read the desktop app's own data folder, where it keeps your DorkOS sign-in and its built-in browser's sign-ins, on every runtime. On Codex the shell is covered too, and on Claude Code below Full autonomy a shell command that names it asks you first. Other shells aren't checked for it yet (DOR-3613).
- When Page previews opens DorkOS's own address, it now loads in a locked-down frame, so the page can't act as the app. Most DorkOS pages also tell older browsers they can't be shown inside another page (DOR-3370).
- DorkOS's database now refuses a mini app approval that would let it change anything in a connected app. It also refuses approval records with hidden characters in their name or folder, or with blank checksums (DOR-3547).

### Added

- **Agents can ask to change work queues and to queue work for another agent.** Anything that adds work asks you first: adding or re-queueing work, turning on "Start the next item on its own", and raising Chats at once or Starts per day. Reading another agent's queue asks too. Work one agent passes to another runs at the lower of their two levels, even when it's queued again. Agents can turn a queue off, lower its limits, remove waiting work and reorder it without asking. An agent can't raise Starts per day past the number you last set. A scheduled, heartbeat or agent-started chat, or one that read outside messages, can't change another agent's queue.
- **A mini app can read an app you connected, once you allow it.** This works only for a mini app that runs in its own sandbox and lists the apps it reads. It can only read, and it never sees your password or sign-in. DorkOS keeps a record of each read. When a mini app asks, a "wants to read" row shows under Needs you on the Connections page. It opens a DorkOS page outside the app, where you choose Allow or Not now. You can't allow it from a device signed in over Wi-Fi. To take access back, open the account and click Revoke under "Mini apps that can read this". Apps you connected through your DorkOS account can't be read by mini apps yet. (DOR-3547)
- For MCP clients: new tools `work_queue_read_agent`, `work_queue_configure`, `work_queue_reorder` and `work_queue_requeue`. `work_queue_add` and `work_queue_remove` can now name another agent.

### Fixed

- When your agent clicks a link or presses Enter in the browser and the page it opens won't load, the agent is now told the page didn't load, and usually which site, instead of being told it worked. Opening an address that won't load says so too (DOR-3897).

### Going back

0.135.5 adds a table and a column for work queues, and rebuilds the table of mini app approvals with stricter checks. 0.135.4 starts on it as it is: in a test it started, its pages loaded, schedules ran and no rows were lost. To go back, install 0.135.4.

DorkOS still saves a backup before it changes the database, in `~/.dork/backups/`. If you came from 0.135.4, it's named `dork-<date>-<time>-pre-20261110044508_work_queue_permissions.db` (the time is UTC). To restore it, quit DorkOS, delete `dork.db-wal` and `dork.db-shm` from `~/.dork/`, copy the backup over `~/.dork/dork.db`, then install 0.135.4. You lose anything written since the upgrade, so if you removed access, revoked a connection or revoked a mini app's access since then, do it again.

## [0.135.4] - 2026-11-10

> DorkOS 0.135.4 keeps DorkOS's own private files out of the canvas, room attachments and new chats an agent starts, and keeps scheduled runs out of your home folder.

### Note for people upgrading

- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- A schedule with no agent that would have run in your home folder now runs in a new, private folder of its own each time. Give a schedule an agent if it needs a project's files. (DOR-4060)

### Security

- **The canvas, room attachments and new chats can't reach DorkOS's own private files.** These include its sign-in key, its settings and its saved secrets. The canvas, room attachments and new chats an agent starts now refuse them at every level, with nothing to approve. (DOR-4060)
- **A scheduled run never runs in your home folder or DorkOS's data folder.** An agent's run that would have landed there runs in that agent's own folder instead. A run with no agent gets a new, private folder of its own. (DOR-4060)

### Fixed

- **An agent that forks a chat without naming a folder now works in its own folder.** A launch refused for its folder says to name one. (DOR-4060)
- **An approval card for reading a canvas document names the file it reads.** (DOR-4060)

### Going back

0.135.4 doesn't change the database. To go back, install 0.135.3.

## [0.135.3] - 2026-11-10

> DorkOS 0.135.3 lets you see what every agent is told, lets scheduled tasks use their agent's connected apps, and tells you when a schedule misses runs or keeps failing. This release changes the database, so read Going back before downgrading.

### Note for people upgrading

- This release changes the database. Read Going back below before downgrading.
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).

### Security

- DorkOS's own database backups never keep the text of what your agents were told. A backup keeps each record's details and a fingerprint of each text, never the words. And when a Claude Code chat was deleted while DorkOS was closed, its record is now removed the next time DorkOS starts. (DOR-4001, DOR-4002)
- The Permissions, Securing your instance and Threat model guides now explain where DorkOS keeps the key that protects your saved secrets, and which programs on your computer can read it. (DOR-3053)

### Added

- **See what every agent is told.** Settings › Agent instructions lists each part of the instructions DorkOS gives agents, in the order the model reads it. Each part says where it comes from, when it is included, roughly how long it is, and whether it is locked. Spots that differ per agent, like its name, show as small chips.
- **Switch runtime, place and level.** Pick Claude Code, Codex, OpenCode or Doe, and a direct chat, a room or a scheduled task. Notes say what each runtime adds that DorkOS can't show, like Claude Code's own built-in instructions.
- **Preview as an agent.** "Preview as…" fills the chips in for one agent.
- **The profile of each agent you manage has What this agent is told.** It shows that agent's own result, for its own runtime and level. The Instructions, Boundaries and Memory pages link to it.
- **Agents can read the template too.** A new tool shows an agent the same list, with chips and no one's details, or only the parts its own next turn gets.
- DorkOS now keeps a private record of exactly what each agent was told on every turn: the instructions it started with and the notes added to that turn. The saved copy stays in your local database, and DorkOS never sends it anywhere. For Claude Code chats the text is deleted with the chat (at the latest the next time DorkOS starts) or after 30 days, whichever comes first. For Codex, OpenCode and Doe chats it is deleted after 30 days. The details around it, like when and which runtime, are kept. Common password and key formats, and your DorkOS secrets, are replaced before saving. This is best effort.
- Live chat updates now include when models reply on every runtime, and when tools start where the runtime reports it.

### Changed

- **The small preview under the Instructions and Boundaries editors is gone.** It rebuilt part of the instructions in the app and could fall out of step. The new page is written by the same code a real chat uses.
- **A long agent name no longer runs into the close button on a phone.** The name shortens with "…", and its status gets its own line.

### Fixed

- **Scheduled tasks can use the connected apps their agent has access to.** (DOR-4027)
- **A schedule that misses runs or keeps failing tells you.** When runs were missed because this computer was likely asleep, a line says so in the room the schedule came from, or in its agent's direct chat. When it fails twice in a row, a line says so there too, and the schedule shows in Needs you until a run succeeds. (DOR-4078, DOR-4073)
- Settings now says plainly that scheduled tasks can't run while the computer sleeps, even with keep-awake on. Agents say the same if they're asked to wake it. (DOR-4064)
- When a spin-off chat hasn't started within five minutes, the chat that started it is told why, and its status reads "never-started". (DOR-3351)

### Going back

0.135.3 adds three tables to the database, and 0.135.2 starts on it as it is. To go back, install 0.135.2.

On 0.135.2, the saved record of what agents were told is no longer deleted after 30 days or when a chat is deleted, and backups made on 0.135.2 include its text. To remove it, restore the backup below. Lines about missed or failed scheduled runs show there as a plain notice, with no link to the run.

DorkOS still saves a backup before it changes the database, in `~/.dork/backups/`. If you came from 0.135.2, it's named `dork-<date>-<time>-pre-20261109151737_turn_context.db` (the time is UTC). To restore it, quit DorkOS, delete `dork.db-wal` and `dork.db-shm` from `~/.dork/`, copy the backup over `~/.dork/dork.db`, then install 0.135.2. You lose anything written since the upgrade, so if you removed access or revoked a connection since then, do it again.

## [0.135.2] - 2026-11-09

> DorkOS 0.135.2 holds a chat to the same limits as an agent that read outside words and then messaged it. It also shows Starting… or isn't working on an app's own page, and keeps Needs you loading when it finds a notice from a newer version.

### Note for people upgrading

- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).

### Security

- **An agent that read words from outside your team passes that on when it messages another chat or starts one.** The chat it wakes is held the same way: it can add notes but not change them, and it can't ask you to take over your shared browser. The same goes for a room post from a Telegram or Slack chat, and for a spin-off's report back to the room it came from. (DOR-4029)

DorkOS now counts a mini app's post in a room as words it can't vouch for. It doesn't yet count an email or web page read through a connected app, so these limits don't cover those cases.

### Fixed

- **An app's own page tells you what's happening.** While the app loads, the page says Starting…. If it never finishes, the page says the app isn't working, with Try again. Before, it could say the app didn't have that page. (DOR-4071)
- Connecting Outlook through Composio will stop failing before its sign-in page opens once DorkOS Cloud updates. (DOR-4063)
- Needs you still loads when it finds a notice from a newer version of DorkOS, for example after you go back to this version. (DOR-4021)

### Going back

0.135.2 doesn't change the database. To go back, install 0.135.1.

If you go back to 0.135.0 after an agent approved another agent's request for Read, asking DorkOS for its list of access changes (`GET /api/connectors/access-changes`) returns an error there. No page in the app uses that list, so Needs you and the Connections page still load.

## [0.135.1] - 2026-11-09

> DorkOS 0.135.1 lets an agent give another agent the Read access it asked for, lets you remove an extension, and asks about all of a plugin's extensions on one card. A mini app's post in a room now counts as words DorkOS can't vouch for. This release changes the database, so read Going back before downgrading.

### Note for people upgrading

- This release changes the database. Read Going back below before downgrading.
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).

### Security

- **A mini app's post now counts as words from outside your team.** That includes a thread reply a mini app posts and a comment it passes on to an agent. Before, an agent that read one could still take another agent's access away. Now it can't, just as with a message from Telegram or Slack. Notes the agent saves in that turn are marked as having read outside words, and it can't use your shared browser. An agent that read outside words passes that on when it posts in a room, so the agent it wakes is held the same way. (DOR-4023)
- **At Full autonomy, a refused attempt to take another agent's access shows in Activity** when the turn had read outside words. Full never asks, so that line is your record of it. Other refusals are kept in the audit log.

DorkOS now counts a mini app's post in a room as words it can't vouch for. It doesn't yet count an email or web page read through a connected app, so these limits don't cover those cases. And when such a room turn starts or messages another chat, that chat's memory notes and agent-browser actions aren't yet limited the same way; access changes there are still refused.

### Added

- **An agent can approve another agent's request for Read on an app.** It can give only Read, and only on an app it holds itself, never more than it holds. It can't approve its own request, approve write access, or approve from a turn another agent started or one DorkOS marks as having read words it can't vouch for. You see each approval in Activity and can undo it.
- **An agent can undo an access change, under the same rules.** Putting access back counts as approving it. Taking it away counts as narrowing it, so it needs a one-line reason and you hear about it in Needs you. When you Undo a change, that's final: no agent can reverse it. Only you can let an agent back into an app it was left out of.
- **Remove an extension** from Settings → Extensions. Open its row and choose Remove. It asks first, with Cancel ready, and Esc backs out. Its folder and everything it was allowed are deleted, so nothing put back there later can reuse your old yes. Extensions that came with a plugin are removed by uninstalling the plugin. (DOR-3541)
- **A plugin's extensions show as one row** in Settings → Extensions, with one switch for the ones you already allowed. Open it to see each one and turn them on or off on their own. (DOR-3583)
- **One card asks about all of a plugin's waiting extensions:** what they can do together, then each one. **Allow all** still allows each one on its own, with its own check of its files. If one can't be allowed, the card says which. An extension added to the plugin later, or one whose files changed since you allowed it, still asks on its own card. ⌘K offers "Review … extensions" to open it. (DOR-3583)

### Changed

- **A request another agent approved says so.** The card still shows who asked and for which app. Under that it reads "Approved by DorkOS PM · Read only", with that agent's picture and the time. It stays in Needs you for a day, then you'll find it in Activity.
- It shows the agent as it was when it approved. If the agent changes its name later, the card doesn't change. If you undo the approval, it leaves Needs you, and the request in the chat says "Undone by you".
- A request for write access says "Write access needs you." above the buttons. Agents can only approve Read, so only you can answer it.
- When an agent asks to approve another agent's request, you see names, not codes. The card shows which agent asked, with its picture, and which app. The request's code is behind the ⓘ button.
- In the Inbox, an extension that wants to run now says so plainly: "Flow wants to run on this computer." It lists what it can reach on three short lines, Access, Runs as and Network, and you answer with an Allow or Not now button right on the card.
- An extension whose files changed after you allowed it now says its screens are paused until you look. It shows what changed and when, and you answer with Allow the new version or Keep paused.

### Fixed

- **Your apps show up again.** On 0.135.0, one app that never finished loading left the Apps page empty and hid app settings. Now each app loads on its own, and one that's stuck says "Not working" with Try again.
- An extension whose folder is gone no longer keeps its approval out of sight. It shows under "Needs you" as "Folder missing", with Forget it to clear what it was allowed. (DOR-3372)
- Typing "settings" in the command palette and pressing Enter opens Settings again. It had been opening Settings → Extensions with the first app's row already open.

### Going back

0.135.1 changes one table in the database, and 0.135.0 starts on it as it is. To go back, install 0.135.0.

Read access one agent approved for another stays on 0.135.0. To take it away there, change that agent's access on the Connections page.

If an agent was waiting for your OK to approve another agent's request, that card still shows on 0.135.0, without a label, but answering it does nothing. Answer the other agent's request yourself instead.

If an agent undid a change and took another agent's access away while you were on 0.135.1, Undo in Needs you says "Nothing to undo there." on 0.135.0. Change that agent's access on the Connections page instead.

DorkOS still saves a backup before it changes the database, in `~/.dork/backups/`. If you came from 0.135.0, it's named `dork-<date>-<time>-pre-20261109000421_connection_grant_approvals.db` (the time is UTC). To restore it, quit DorkOS, delete `dork.db-wal` and `dork.db-shm` from `~/.dork/`, copy the backup over `~/.dork/dork.db`, then install 0.135.0. You lose anything written since the upgrade, so if you removed access or revoked a connection since then, do it again.

## [0.135.0] - 2026-11-08

> DorkOS 0.135.0 gives your apps a home in the sidebar, lets an agent give up app access or take it from another agent, and shows each extension on one line in Settings. When one agent takes another's access away, you can Undo it in Needs you. This release changes the database, so read Going back before downgrading.

### Note for people upgrading

- This release changes the database. Read Going back below before downgrading.
- The Add-ons section at the bottom of the sidebar is gone. Its apps are now under the new **Apps** door, and up to 5 of them, A to Z, start out pinned.
- Below Full, Claude Code agents now ask before they read files outside their own folders. In runs nobody is watching, like scheduled tasks, heartbeats, to-dos and queued work, those reads are refused instead. (DOR-3300)
- Claude Code now refuses a shell command too big or tangled to check, at every level, even Full. Split it into smaller commands. (DOR-3300)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).

### Security

The first six checks are for Claude Code agents. They read a command's text, so they stop a slip, not an agent set on getting past them. (DOR-3300)

- Below Full, Claude Code asks before it reads a file outside its own folders, in every kind of turn. A link that points to an outside file asks too. At Never ask, and in runs nobody is watching, these reads are refused instead.
- Below Full, a shell command that reaches a secret file asks first, also when it's chained after another command. At Never ask, and in runs nobody is watching, it's refused.
- At every level, a shell command that plainly writes an agent's setup files is refused, and the attempt is recorded in the audit log. That includes paths written with wildcards.
- A shell command too big or tangled to check is refused at every level, even Full.
- If DorkOS can't start this check, shell commands stop at Full. Below Full, commands that name setup files are refused and others ask first. If phone notices are on, you get one there too.
- If a restart doesn't bring the check back, you can choose, at the computer DorkOS runs on, to go on without it at Full. That choice ends when you restart, and it's recorded in the audit log.
- On Claude Code, agents' file tools can't open the file that stores the MCP servers you added for every agent. This stops a slip, not a program set on reading it. (DOR-3826)
- An MCP server you add for every agent must now have an address that starts with `https://` or `http://`. A secret written as `--token:value`, `"--token value"` or JSON in its arguments is now hidden wherever it's shown. (DOR-3826)

### Added

- **Your apps have a home.** The sidebar now has an **Apps** door, between Threads and Directory. It opens an Apps page with every app you have, a search box, and your pinned apps first. (DOR-3970)
- Pin up to 5 apps to keep them right under the Apps door. A pinned app waiting for your OK keeps its place and shows a dot; on the Apps page it says "Needs your OK". Clicking it opens its card in the Inbox. An app that stopped working shows an alert, or "Not working" on the Apps page, and clicking it tries again. (DOR-3970)
- Cmd+K finds every app, and offers "Open Apps" and each app's settings. (DOR-3970)
- **An agent can give up access to an app it no longer needs.** It can lower its own access to Read, remove some actions, remove all of it, or leave itself out of an app shared with every agent. Only a person can give access back.
- **An agent can take another agent's access to an app away, and you hear about it right away.** It has to say why in one line. It can do this at most 3 times an hour, and only in a turn a person started. It can't in a heartbeat, a scheduled run, a turn another agent started, or a turn DorkOS marks as having read words it can't vouch for. DorkOS doesn't yet count a mini app's post in a room, or an email or web page read through a connected app, so these limits don't cover those cases. An agent left out of an app can't use it directly, but it could still ask another agent to.
- **Undo an agent's access change from Needs you.** When one agent takes another agent's access away, Needs you shows the reason in the words of the agent that made the change, beside its avatar, with **Undo** and **Keep the change**. Undo gives the access back and says so right there. If the access has changed since, it tells you it can't.
- **Leave one agent out when you share an app with every agent.** That agent keeps only the access you gave it by name. If you share that app with every agent again later, it still doesn't reach that agent, and you can let it back in at any time. Only a person can do this, not an agent. For now it's done through the DorkOS API (`PUT` and `DELETE` on `/api/connectors/connections/{id}/exclusions/{agentId}`); the Connections page doesn't show it yet.

### Changed

- **Settings → Extensions shows each extension on one line**, with its name, what it's for, and its switch. Ones that need you sit on top with a short label, like "Needs your OK" or "Not working". The rest are A to Z and stay put when you switch one off. A search box helps in a long list, and an Off filter shows when something is off.
- Click an extension's row to open it in place. An app with a page shows Open first. The one decision comes first, with the version, author, access and tools under Details.
- An extension waiting for your OK shows **Review** instead of a switch, so turning it on always goes through the question first. An extension whose screens were paused after its files changed now says so, and shows what changed.
- Extension authors can set a one-line `summary`, up to 80 characters, in `extension.json`. Without it, Settings shows the first sentence of the description.
- When you add an MCP server for every agent, DorkOS warns you if its arguments look like they hold a secret, so you can use a hidden field instead. The warning never stops you adding it. A server can have at most 100 arguments, each up to 4,096 characters and 16,384 in all. (DOR-3826)
- "Confirm it's you" for an MCP server now opens with what will happen, shows warnings in warning colour, and names each setting and header once. When an agent calls itself something other than its real name, you see both. (DOR-3826)
- Forgetting a browser profile's sign-ins, or deleting a profile, now says plainly that it can't be undone before you confirm. (DOR-3966)
- Groundwork: DorkOS Cloud can now carry a mini app's read-only access to an account you connected through your DorkOS account, and record each read under the mini app's name. Nothing changes yet; the app starts using it once DorkOS Cloud supports it. (DOR-3980)

### Fixed

- You can stop a task right after **Run now**, before its agent starts working.
- When your extensions can't be loaded, Settings → Extensions says so and offers **Try again**, instead of saying none are installed.
- Agents are now told that tools for all your agents live in the MCP servers tab on the Connections page, where only you can add, share or switch one off. (DOR-3213)
- Buttons in drawers and dialogs that open over the top of the Mac window now take clicks.

### Going back

0.135.0 adds two tables to the database, and 0.134.1 starts on it as it is. To go back, install 0.134.1.

If you go back to 0.134 or earlier, every agent exclusion on a connection is lifted, whether you set it or an agent narrowed its own or another agent's access. Each agent left out of a shared app can use it again.

Access an agent lowered in other ways, to Read, to fewer actions or to none, stays lowered on 0.134.1, and there's no Undo for it there. To give it back, change that agent's access on the Connections page. The sidebar shows the Add-ons section again, and your pinned apps may not be kept.

On 0.134.1, Needs you may not load if, while you were on 0.135.0, an agent took another agent's access away or DorkOS couldn't start its shell check. If that happens, restore the backup below.

DorkOS still saves a backup before it changes the database, in `~/.dork/backups/`. If you came from 0.134.1, it's named `dork-<date>-<time>-pre-20261108172402_connection_grant_exclusions.db` (the time is UTC). To restore it, quit DorkOS, delete `dork.db-wal` and `dork.db-shm` from `~/.dork/`, copy the backup over `~/.dork/dork.db`, then install 0.134.1. You lose anything written since the upgrade, so if you removed access or revoked a connection since then, do it again.

## [0.134.1] - 2026-11-08

> DorkOS 0.134.1 gets Codex chats starting again for people signed in to Codex with ChatGPT, and shows your mini apps as soon as you sign in.

### Note for people upgrading

- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).

### Fixed

- Codex chats start again for people signed in to Codex with ChatGPT. They broke in 0.133.0: each message failed, usually with an error about "failed to load workspace requirements".
- Your apps and extension Settings show after you sign in, without reloading. With login on, your mini apps appear in the sidebar's Add-ons section, and their tabs appear in Settings, as soon as you sign in. Before, they stayed missing until you reloaded the window.
- When your mini apps can't be loaded, the sidebar and Settings → Extensions now say "Couldn’t load apps." with a **Try again** button. Before, it looked as if you had none installed.

### Going back

This release doesn't change the database. To go back, install 0.134.0.

## [0.134.0] - 2026-11-08

> DorkOS 0.134.0 gets Codex chats starting again on Linux computers that also use Claude Code, and keeps the signed-in browser DorkOS gives an agent signed out of DorkOS itself. Blocked and Ask on agents' to-dos now apply, and Connections gets an MCP servers tab.

### Note for people upgrading

- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- Agents' to-do tools now follow a new **To-dos** permission. It starts as Allowed, so nothing changes until you set it. If a Blocked or Ask was already saved for them, for example in a settings file, it now applies. Before, it did nothing. Set it in **Settings → Permissions**, or for one agent in its profile under **Setup → Permissions**. (DOR-3936)
- This release changes the database. Read Going back below before downgrading.

### Added

- Connections now has an **MCP servers** tab. Add a server once and every agent can use it. You can keep it from some agents, turn it on or off, or remove it. Values you hide are typed by you and don't show on the page again. Agents that get the server can use them. Changes reach new chats, and open ones may keep a server until they stop. A server reached over SSE doesn't reach Codex or OpenCode agents, and its row says so. Agents can't list or change these servers. (DOR-3213)
- In a chat or room, the **Agent browser** panel now has a **Profiles** list. **Forget sign-ins** clears every site's saved data in a profile, and **Delete profile** removes a named profile and its agents' access to it. Only you can do either, not an agent, and neither can be undone. Forgetting the Default profile's sign-ins also clears the ones saved with `dorkos browser login`. (DOR-3887)
- Groundwork for mini apps that read a connected app themselves: the database and the public DorkOS Cloud contract can now name one extension as the holder of a read-only grant. Nothing uses it yet. (DOR-3547)

### Changed

- The app's browser panel, its help and the guides now call the live shared page the Agent browser. The older hidden page is the signed-in browser. Existing commands and saved sign-ins are kept. (DOR-3218)

### Fixed

- Codex chats start again at Ask first and Workspace write on Linux computers that also use Claude Code. Claude Code's saved sign-in copies stay hidden from Codex. (DOR-3949)
- In one more case where Codex's sandbox can't start on Linux, DorkOS now says so and links to OpenAI's setup page. It no longer tells you to send your message again. (DOR-3950)
- The signed-in browser DorkOS gives an agent now starts signed out of DorkOS, even with login on. This holds on every runtime. Sign-ins saved with `dorkos browser login` no longer include your DorkOS or DorkOS Cloud sign-in, however their address is written, and older saved files are cleaned when DorkOS starts. Other sites on this computer's own addresses, like `localhost`, are left out too. (DOR-3957)
- DorkOS now warns in its log when an agent's Claude Code loads a Playwright browser server outside DorkOS's protections: one that uses your real Chrome, keeps its own browser profile, or can open any site. (DOR-3957)
- Blocking an agent's to-dos now works. Set **To-dos** to Blocked and the agent's to-do tools refuse. It still sees its own open to-dos on its heartbeat, and the team's list stays readable to everyone in the space. Set it to Ask and the agent asks you before it adds or changes a to-do. Reading the list still runs. (DOR-3936)
- An agent that says who it is can no longer change a to-do through the app's web API, where no permission was checked. Agents use their to-do tools, which follow your setting. (DOR-3936)
- In Permissions, every action that only reads now says Ask lets it through, so you know only Blocked stops it. (DOR-3936)
- Codex can edit in an agent's own folder on Linux again. DorkOS now adds the empty files and folders Codex needs to agent folders it made under `~/.dork/agents`: for new agents, and for existing ones the next time DorkOS starts. A folder that is a git repo, or lives elsewhere, is left alone. The files stay protected from agents' file tools. When Codex can't edit because a protected file is missing, it names that file. (DOR-3914)
- When you've let an agent read an app and it later asks to change things there too, you now get a new card for that. Before, the agent was told it had access while it could still only read. (DOR-3930)
- Agents are told to hand you the browser for a sign-in and wait until you finish. They're also told to ignore sign-in links from untrusted messages, and to send requests for a shared page to you rather than to an outside sender. (DOR-3218)

### Security

- Isolated extensions can no longer use Node's built-in SQLite, which got around their file limits. Extensions that run inside DorkOS itself are unchanged. (DOR-3547)

### Going back

This release only adds to the database, and 0.133.0 runs on it as it is. To go back, install 0.133.0. On 0.133.0, a Blocked or Ask on agents' to-dos stops applying again.

DorkOS still saves a backup before it changes the database, in `~/.dork/backups/`. If you came from 0.133.0, it's named `dork-<date>-<time>-pre-20261108035027_dor3547_extension_grant_subject.db` (the time is UTC). To restore it instead, quit DorkOS, delete `dork.db-wal` and `dork.db-shm` from `~/.dork/`, copy the backup over `~/.dork/dork.db`, then install 0.133.0. You lose anything written since the upgrade, so if you removed access or revoked a connection since then, do it again.

Older releases (v0.1.0 – v0.133.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.133.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.133.0.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.135.7...HEAD
[0.135.7]: https://github.com/dork-labs/dorkos/compare/v0.135.6...v0.135.7
[0.135.6]: https://github.com/dork-labs/dorkos/compare/v0.135.5...v0.135.6
[0.135.5]: https://github.com/dork-labs/dorkos/compare/v0.135.4...v0.135.5
[0.135.4]: https://github.com/dork-labs/dorkos/compare/v0.135.3...v0.135.4
[0.135.3]: https://github.com/dork-labs/dorkos/compare/v0.135.2...v0.135.3
[0.135.2]: https://github.com/dork-labs/dorkos/compare/v0.135.1...v0.135.2
[0.135.1]: https://github.com/dork-labs/dorkos/compare/v0.135.0...v0.135.1
[0.135.0]: https://github.com/dork-labs/dorkos/compare/v0.134.1...v0.135.0
[0.134.1]: https://github.com/dork-labs/dorkos/compare/v0.134.0...v0.134.1
[0.134.0]: https://github.com/dork-labs/dorkos/compare/v0.133.0...v0.134.0

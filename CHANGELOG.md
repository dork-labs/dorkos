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

## [0.129.0] - 2026-11-01

> DorkOS 0.129.0 keeps a task off when you approve it, gets spin-off reports back to the agent in a room, wakes every agent you @ in a channel, and gives the app a calmer look.

### Added

- Agents introduce themselves when you create a channel with them in it, or add one to a channel later. The channel says "Ana joined this room.", and Ana is asked to post a sentence or two about who it is and what it can help with. Each agent does this once per channel, never again after a restart or if it leaves and comes back, and no agent replies to another's introduction. It uses the channel's normal hourly allowance of automatic replies, so a busy agent or a channel that has used its allowance just gets the "joined" line. An introduction runs no higher than the default level of the program the agent runs on, whatever the agent's own level, and an agent introduces itself at most five times an hour. Direct messages, #team, chats bridged from another app and rooms copied in from a Community are left alone. (DOR-2106, FB-33)
- Attach a room to a feedback report. In a channel, a direct message or Home, a "This room" chip sends up to that room's last 30 messages, threads left out. It stays off until you turn it on, because a room holds other people's words. Preview shows exactly what goes, with home paths and secrets removed and file names left out. A message that arrives after you open the preview is not sent. (DOR-2108, FB-35, FB-62)

### Changed

- In a channel, every @name in a message now wakes that agent, wherever it sits. To keep an agent posted without asking it to act, write `cc` before its name: "cc @ana @bo" wakes neither, for the rest of that line. Before, only the names at the start of a message woke anyone, so a message that answered a person and then gave agents work woke none of them. Direct messages work as before.
- Your own channel messages now say who they reached, like "Woke @ana. Cc: @bo." Agents get the same line back when they post, so a name that only got a copy is caught straight away. Once your draft has a cc, the line under the box reads "Wakes @ana · cc @bo".
- On Claude Code, an agent you set to Full autonomy on its own Files & commands row (not through a preset) can now change its own setup in turns that run at Full: its hooks, skills, rules and settings, and its list of MCP servers. Before, it had to ask you to copy the files in by hand. Each change it makes there shows in Activity, however it made it. Its file tools still stay out of its own agent file, other agents' folders, DorkOS's settings, your Claude account files, and any file its folder links to from somewhere else. A turn started by a teammate, or one that read a message from outside your team, keeps the old limits. If you move the agent below Full, what it changed waits for your OK once before it runs. (DOR-3483)
- A channel you open now starts with its own shared files and a `ROOM.md`, so you no longer need to press **Set up files…** first. Rooms you already have are left as they are and keep the button. Direct messages, and channels opened by an agent or anyone other than this computer's owner, start without files, and nothing changes while room files are switched off in Settings. (FB-39)
- Agents in a room are now told to hand long work to a helper or a spin-off chat, say who has it, end their turn, and post the result when it comes back, so the room isn't kept waiting. (FB-65)
- When a repo's hooks or skills need your OK before a Claude Code agent uses them, the card now asks a plain question, like "Allow a changed skill in "my-app"?" or "Trust this repo's hooks and skills?". Its red label says what a yes does: "Runs code on this Mac" for hooks and settings, or "Widens what agents can run" for skills, subagents and commands.
- In the Mac app, pick your company's certificate file with **Choose…** in Settings → Server → Network, instead of typing its path. The row shows how many certificates DorkOS trusts and which file they come from. After you pick a new file or stop using one, it says what's still in use and offers **Restart** to switch. (DOR-3361)
- Orange now means one thing in DorkOS: "you". It marks a count aimed at you, keyboard focus, and things that need you.
- The count on a mention or a direct message is now orange, so it stands out from a row that is only busy.
- In light mode, menus and popovers cast a softer shadow and lose their outline. The dimmed background behind a dialog is lighter.
- Clicking into the message box no longer lights it up orange. The orange ring now shows only when you reach it with the Tab key.
- Motion across the app is calmer and more consistent. Panels, badges and new messages settle without a bounce, and streaming text now fades in word by word with no blur. If your computer is set to reduce motion, these animations finish at once.
- Most badges are one quiet grey pill now. A warning, an error or a success shows its own icon in colour, and the words stay easy to read on every background.
- Counts say who they are for: orange for a mention or a direct message, amber for something waiting on you, red for a failure, grey for everything else.
- In the command palette, a channel shows a number only when you were mentioned. In a community's channel list, a channel with new messages shows its name in bold instead of a number.
- A direct message counts up to 99+ instead of stopping at 9+. Mentions still stop at 9+, because that is as far as they are counted.
- A cc in a message now says "cc" before the name, so you can tell it from a mention without relying on its colour. If you already typed "cc" before the name, it isn't said twice.
- Outlined buttons lose their border and shadow and become a soft grey tint, so they read clearly on every background, sidebar included.
- On a phone, every button gives your thumb at least 44 pixels to tap, the small ones too.
- Keyboard focus looks the same on every button: an orange outline with a small gap around it. It also shows in high-contrast modes, where the old ring disappeared.
- Delete buttons are one red everywhere, in light and dark.
- Cards no longer draw a border. Their soft shadow sets them off the page, and in dark mode they sit a step lighter.
- Settings groups are a soft tint instead of an outlined card, with no lines between rows, and in dark mode they no longer look like a hole in the dialog.
- The danger zone in Settings loses its red outline. The heading and the red button say it.
- In the sidebar and in pick-one lists, keyboard focus on a row is an outline inside the row, so it is no longer cut off at the edge of the list, and hovered and selected choices share one set of tints.
- Interactive cards lift with their shadow only, without the one-pixel jump.
- Form fields have a firmer edge, so an empty box is easier to see. Off switches are easier to see too.
- Every field, checkbox, radio, switch and select now shows the same focus ring when you move with the keyboard. High-contrast modes keep it.
- Error messages replace the help text under a field, with an icon and a red edge. In the task form and other updated forms, they wait until you leave the field or press Save.
- Disabled text fields stay readable. Checkboxes, radios and switches are easier to tap on a phone.
- The "Also send" chips in the feedback form show a check when they are on, and their preview button is easier to tap on a phone.

### Fixed

- Approving a task or changing its file no longer turns a scheduled task back on. Approving a task you had switched off now keeps it off: "Approve" leaves it off, and "Approve and turn on" beside it turns it on too. And when a task's file starts saying it is on again (a git pull that restores `enabled: true`, or a file with no `enabled` line), the task stays off and its row says "Its file says on. It stays off until you switch it on." Use the row's switch to turn it on. A file can still switch a task off. (DOR-3309)
- Declining or deleting a schedule that came with an installed package now leaves the package's files alone. The schedule stays switched off and asks again only if the package changes it. An agent can't delete one of these schedules. (DOR-2097)
- When an agent in a room starts a separate chat for a long job, that chat's updates now reach the agent when the work finishes, fails or needs you. The agent sees the update on its own and decides whether the room needs to hear it. Before, those updates were dropped, and the agent never knew the work was done. (DOR-3488)
- Run a scheduled task at its agent's own level. A task whose file asks to run without prompts now runs at its agent's level: an agent at Full autonomy runs it at Full autonomy, and an agent at Ask first runs it at Ask first. Before, every such task ran at "accept edits". A task file outside an agent's folder still runs at "accept edits". If a file changes to ask for fewer prompts than you approved, the task waits for you again; for an agent at Full autonomy, that wait is a quiet row under Needs you, with no alert. (DOR-3425)
- When an agent's turn fails while it is waiting for your approval, the approval card now closes with it. Before, the card stayed open with a working Approve button that did nothing, and the room kept showing the agent as waiting on you. (DOR-3210)
- When Codex, Claude Code or OpenCode refuses a turn, the chat names which one, quotes what it said, and offers the next step. A chat started from another chat now passes that reason back instead of only saying the turn failed. (DOR-3167)
- When the computer is already running its limit of agent chats, a message from one agent to an existing chat now waits and starts when a slot frees. Before, it was dropped and the sender had to try again. The limit still stops brand-new chats from starting. (DOR-3375)
- When two agents were each asked to post in a room while their chat there was still busy, they could keep waking each other up, about ten times a second. The "working on it" line flickered nonstop and the app used a lot of CPU. Now an agent tries again as soon as its own turn ends. Until then it waits longer between tries: 1 second, then 2, then 4, up to 30. (DOR-3516)
- After DorkOS restarts, a Claude Code chat runs one agent process again. On a busy machine, an old agent process could keep running beside the new one for the same chat. DorkOS now tries again when it fails to record a process it started, and a restart waits up to 10 seconds for the previous server to exit before ending what it left running. (DOR-3049)
- Starting DorkOS from a copy of your data folder no longer wakes the chats of the install you copied it from. Before, a copy could restart those chats and run their tools a second time. A normal restart or upgrade still picks up the Claude Code background work a restart cut short. This works for chats this version started. (DOR-3071)
- A scheduled task's time limit now counts only the time your computer was awake. Before, a run that was a few minutes in when your Mac went to sleep was stopped the moment it woke and marked as having gone past its time limit.
- A task that comes due while your Mac is asleep no longer starts during one of the brief moments it wakes on its own, only to be cut off seconds later. It now waits until the computer has been awake for two minutes, and a run that ends up too late to be useful is marked as skipped because the computer was asleep. (DOR-3286)
- A scheduled task on Claude Code can check on DorkOS itself (whether it's up, its version, its extensions and their errors) at any permission level. Before, a task set to Ask first, Accept edits or Never ask was refused those reads. (DOR-3373)
- A scheduled run on Claude Code can now see which connected accounts it was given, and what each one lets it do, without a person there to approve. Using those accounts still needs approval as before, and a turn started by someone outside your team still asks first. (DOR-3205)
- An agent on a local model with a small context window, such as 32k, run through Doe or OpenCode, no longer stops on its first message. When the window is small, DorkOS leaves out its own extras until they fit: first the widget guide, the list of DorkOS areas and the room guide outside rooms, then, if needed, its tool descriptions, orientation, persona and saved memory. The agent is told what was left out. Safety boundaries, working rules and the rules for using DorkOS's tools safely always stay. On Doe, tool descriptions load when needed, and if the agent still can't fit, the chat says so and suggests a model with a larger window or a shorter AGENTS.md. (DOR-2839)
- When an agent asks you to connect an app, it's now told not to promise that connecting will be quick. Connecting waits on you, and you may need to sign in to the app first, so it says that it asked and where you can answer. (DOR-2850)
- A plugin whose mini app uses files from elsewhere in the same plugin now installs. A mini app still can't use anything outside its plugin's folder.
- When a mini app can't be built during an install, the error now gives the reason and where it happened. If it reached for a file outside its folder, the error names that file and the folder it had to stay in. Before, it only said the build failed. (DOR-3537)
- The card that asks before a package runs commands now shows each file's "fingerprint" instead of "sha256". A file that isn't there yet, a folder, a file it can't read, or a very large file is now said in plain words. A very large file is also tracked more closely, so changing it while keeping its timestamp still asks you again. (DOR-3340)
- A request from a web page on an address DorkOS doesn't trust is now refused with a clear "not allowed" answer that names the address and how to allow it. Before, it came back as a server error and wrote an error to the log, so a harmless refusal looked like DorkOS had crashed. (DOR-3247)
- When DorkOS isn't answering and a message to a room or thread can't go out, your words go back into the message box if it's empty, and the message says "Not sent." The error now has a Retry button, which works even if you've left the room. (DOR-3481)
- A busy room or chat uses less CPU. Each new message used to redraw every message on screen many times while the view scrolled down to it. Now only the messages that changed are redrawn. (DOR-3312)
- When an agent was waiting on you, the Team tab showed an amber "needs you" dot but still read "Team · 3 working", so amber looked like it meant "working". Now the label says the same thing as the dot: "Team · 1 needs you" (or "2 need you"). The working count moves to the hover text: "1 agent is waiting on you · 3 working". In a narrow hover card, "3 working" stays on one line. When nobody is waiting, it still reads "Team · 3 working" with the green dot. (DOR-3533)
- On a phone, the bar at the top of each page no longer crowds its title, and its buttons are big enough to tap. On a tablet, the bar's buttons stay inside it. (DOR-3186, DOR-3187, DOR-3190, DOR-3191, DOR-3192)
- In the desktop app, a scrollbar no longer appears under your tabs when there are more than fit. Your mouse wheel scrolls the tabs sideways instead, and the tab you're on still scrolls into view. (DOR-3490)
- When you have more tabs than fit across the top of the window, the strip now fades out at the edge where more tabs are hidden, so you can tell there are more. The tab you are on also scrolls into view on its own, clear of that fade, when you switch with a shortcut, close the tab next to it, or make the window narrower. (DOR-3507)
- Keep keyboard focus on screen after you hide the sidebar with ⌘B. Tab no longer lands on controls you can't see, and focus goes back where it was when the sidebar reopens.
- Slide the sidebar with a spring, so pressing ⌘B mid-way turns it around smoothly.
- Name each agent's menu after the agent, and read out when a channel has new messages, for people using a screen reader.
- Message times, and red and amber status text in dark mode, are now easier to read.
- Removing a filter chip now moves keyboard focus to the next chip instead of losing it, and its × is big enough to tap on a phone.
- A "Set here" chip on a setting now shows the keyboard focus ring.
- Faint and red text on a selected row inside a dark dialog is easier to read.
- A card's title no longer clips its descenders on a phone.
- Screen readers now read a field's error or help text when you reach the field.
- A checkbox's help and error text sit under its label, not beside it.
- Deleting a task no longer resizes the button while it works, and keyboard focus stays on it.

### Security

- On a Telegram or Slack chat linked straight to an agent, `@` and a file path now stay plain words, so a message can't pull a file into the agent's turn. It works as before only in a direct message from someone on that connection's Approvers list, so add yourself there if you use `@` from your own chat. The agent's level does not change. (DOR-2980)
- An agent running on Claude Code can no longer open a file like `.env` or a private key in its own folder, or in the folder it is working in, by name, with its Read tool or a shell command, at any permission level. A search of the whole folder, or a program that opens the file itself, can still read what's inside, so move secrets out of agent folders. (DOR-3292)

### Known issues

- Going back to 0.128.0 is safe. This version only adds three columns to the task table, and 0.128.0 ignores them. On 0.128.0, approving a task can turn it back on again, so check your schedules after you switch.

## [0.128.0] - 2026-10-31

> DorkOS 0.128.0 lets pages in the canvas send events to their agent, lets agents see every running chat, and stores your password more safely.

### Security

- Your DorkOS password is now stored with a much stronger hash, so it's far harder to guess from a copy of the file. An older password switches over the next time you set a new one, or enter it when DorkOS asks you to confirm it's you on this computer (DOR-3234)
- This version stores your DorkOS password in a new way that DorkOS 0.127.1 can't read. If you go back to 0.127.1 after the switch, you can't sign in with your password. To fix it, run `dorkos auth reset-password` in a terminal and choose a new password. This signs everyone out, and you sign in again with the new one.

### Added

- Local pages and dev-server previews in the canvas browser can now send events to your agent. When your agent sets this up for a page, a click in that page can start its next turn. A preview reconnects by itself after it reloads. A local page that reloads, or follows a link to another site, stays offline until you press Reload, so another site can't send events in its place. The offline notice has its own Reload button. (DOR-2665)
- Agents can now see every chat running right now, for each agent, spin-offs included, each with its title and a link. A person's own chat shows only as a number.

### Changed

- Your own messages now show your name with a muted "(you)" after it, in rooms, chats and DMs, so you read as the same person everyone else sees. A long name is cut short, but "(you)" always shows. If you haven't set a name, your messages still say "You" (DOR-2111, DOR-2839)

### Fixed

- On the Full setting, a package installed from a marketplace source still asked before it could run commands automatically. Full means nothing new asks, so now those commands run, and Activity notes it. A package that is in a project but that DorkOS did not install, or whose files changed after install, waits under Needs you instead, and only you can allow it. Nothing stops while it waits, it doesn't ping your phone, and it stays put until you answer instead of coming back every couple of hours. A yes still counts if DorkOS restarted since the row appeared. If that package's commands don't run a file DorkOS can check, a yes can't vouch for them, so they stay held back and Activity tells you how to run them: install the package through DorkOS, or link its folder as a dev link. On every other setting you're still asked, and a package you turned down stays turned down.
- An MCP server you add for every agent can't run a program or script from inside your agents' folders, and can't use settings that inject code into the program. A saved server that breaks these rules isn't started.
- Choosing "Always allow" on one of these servers' tools now applies to that agent only.
- Suspending or archiving a space could fail with "The space is unavailable" on a small number of servers, every time, once someone had joined by invite. It now works on all of them.
- When you write to an agent inside a room thread, its answer now lands in that thread. Before, some answers showed up in the main channel instead. An agent asked in the main channel still answers there. (FB-63)
- A new agent you create on Codex or OpenCode now runs on that runtime from its first chat. Before, it quietly ran on Claude Code instead, and could bill the wrong account. When an agent's chat falls back to Claude Code, the chat now says why: the runtime is waiting for your OK, or it isn't set up on this computer.
- When an agent sends a message to a chat whose account is out of usage, or that can't reach the API, the sender now sees that the message wasn't answered. Before, it said "delivered" even though the other agent hadn't read it, sometimes for days.
- An OpenCode agent on a local model (such as Ollama) no longer gets cut off when its model takes more than 2 minutes to start answering. DorkOS used to read that wait as a turn that never started and end it with "the agent didn't start within 2 minutes". It now waits until the model answers or OpenCode's own time limit ends the request. A tool that hangs is still stopped after 10 minutes. (FB-68)
- Agents in rooms now read times in your time zone. Every time in a room turn used to be UTC with nothing saying so, so an agent could call your afternoon "this evening" and had no idea what day it was for you. Now each time is in the zone set in your profile, and each turn tells the agent which zone that is and the date and time there now (DOR-3253, DOR-3125)
- An agent listing scheduled tasks now sees when each one runs next. It used to see "no next run" for every task, even ones on a schedule (DOR-3125)
- Bug reports you send from DorkOS are easier to read. The same event repeated back to back now shows once with a count, the server log excerpt no longer has empty lines, and the report names where it came from as "DorkOS app" instead of an old internal name. (FB-49)
- An agent's Schedules page opens instead of crashing when that agent has schedules or runs to show (DOR-3124)
- A message started by a schedule or a heartbeat now says where it came from, instead of looking like you sent it. It shows once the turn has finished. (DOR-3019)
- The first time an agent opens Documents, Desktop or Downloads, macOS asks; your answer applies to all agents.
- When DorkOS stops and starts again, an open chat now gets its live updates back on its own, like a room does. Before, it kept saying "Live updates lost" until you sent a message or reloaded the page.

### Known issues

- At Full autonomy, a chat an extension starts, like one from a comment on an "Only you can do these" list, can still stop and show you a card.
- At Full autonomy, an agent that tries to loosen a permission is told no only if it has read outside words. Otherwise you get a card and you decide, the same as below Full.

## [0.127.1] - 2026-10-30

> DorkOS 0.127.1 asks you to confirm it's you before things only you can do, gives each agent one voice in each room, and cuts more waits at Full autonomy.

### Changed

- Each agent now has one voice in each room. If another of its chats tries to post there, the draft goes to the agent's own chat in that room. That chat is told to read the room first, then post the draft, reword it, or say why not. Posts through DorkOS's external MCP server aren't affected.
- A message passed on this way says where it came from, like "Shared from #team-product at Dorian's request". The room or chat it came from hears whether it was shared.
- An agent that isn't in a room can't post there, and DorkOS won't add it for you. From a DorkOS chat, it's told to ask the person who runs DorkOS.
- A package installed for all projects can now mark a scheduled task as project-only. It no longer shows up as a global schedule, or asks for approval there. Each project with the file the package names gets its own copy on its Schedules page, switched off. Turn it on where you want it. If a project drops that file, a copy you once switched on stays, and a change to the package's task can still pause it.

### Fixed

- Before DorkOS reads a git repository for you, it checks the repository's own settings. If it finds anything outside a short list of ordinary settings, it skips the read. The same check runs before DorkOS makes or removes a workspace. A chat set to Full autonomy still gets its workspace made, and Activity notes it. These reads don't use the network, your saved git logins or your own git settings.
- At Full autonomy, an agent that tries to open up a setting only you may change, like remote access or which hooks may run, is now told no, and Activity gets a line. Before, it put a card in front of you and waited. Many of these can still be turned off without asking, like switching the tunnel off, which also adds a line to Activity. Below Full, the agent still asks you when you're there to answer.
- A Claude Code agent set to Full autonomy no longer waits on a Needs you ticket because of settings in its folder. They now load, and Activity says so. This doesn't count as your approval: move the agent below Full and DorkOS holds any settings you haven't approved and asks you.

### Security

- Some things only you can do in DorkOS, like approving what an agent asked for, now need you to confirm it's you. In a browser on the computer DorkOS runs on, that means entering your DorkOS password once, and it stays confirmed for about a month after you last use it, unless you sign out. The desktop app confirms you by itself, and on other devices your normal sign-in counts. Most browsing doesn't ask, and nothing changes until you have an owner account.
- The DorkOS app now ignores `NODE_OPTIONS` (a setting that loads extra code into Node) and won't start with debugging switches like `--inspect`. It also won't start if its main app file changed after it was built.

### Known issues

- At Full autonomy, a package that wants to run its own commands can still put a card in front of you, including a package DorkOS didn't install. A later release changes this.
- A chat an extension starts, like one from a comment on an "Only you can do these" list, can still show cards at Full autonomy. That ends in the next release.
- At Full autonomy, an agent that has read outside words and tries to loosen a permission is told no. Without outside words, and below Full, you get a card and you decide. In the next release it's refused at Full in every turn.

## [0.127.0] - 2026-10-30

> DorkOS 0.127.0 makes agents better teammates in a shared room, and keeps more of what agents change waiting for your OK.

### Changed

- In a channel, the first @name in a message, and any names right after it ("@ana @bo" or "@ana and @bo"), ask those agents to answer. A name later in the message is a copy: that agent takes no turn, and it sees the message the next time it reads the room. Copied names show as grey chips, and while you type the composer shows a line like "Asks @ana · cc @bo". Direct messages work as before.
- An agent no longer posts over messages it hasn't read. If another member wrote in the room since the agent last looked, its message waits and the agent sees what's new first. It can then send the message as it was, change it, or say nothing.
- In a channel, an agent waits until the room has been quiet for about 20 seconds before it answers. Several quick messages get one answer, not one per message. It never waits more than a minute from the first message. Direct messages are not delayed.
- Agents in a room are now told four working rules. Speak only when asked or when you have something new, and react instead of repeating. Read the room again before you post. Name who does what, and by when. When you approve something, say exactly which version. These are instructions to the agent, not checks the app enforces.
- Your agents can have at most 8 chats they started on their own running at once. That number is now a setting, `runtimes.maxAgentChats` (1 to 64), so a computer with room to spare can allow more: `dorkos config set runtimes.maxAgentChats 12`. When the limit is full, the message an agent gets names the setting. Only a person can change it, never an agent.
- Your own messages from Wi-Fi now run at the agent's own permission level, not a stricter default. When you're signed in as the owner over Wi-Fi, a message, room post, answer or button press counts as yours, the same as at your computer. Anyone else on Wi-Fi is still held back, as before. From Wi-Fi you still can't raise an agent's permissions or change how DorkOS is reached. While Wi-Fi access is on, an agent below Full asks you first before an action in a connected app that can't be undone, like sending an email, and the card says why. You can't say yes to it from Wi-Fi. A chat set to Full autonomy never asks: its action waits 60 seconds that anyone else can cancel, as it does with Wi-Fi off.
- If your company's network uses its own certificates, choose the certificate file in **Settings → Server → Network**, then restart. The Mac app adds that file's certificates to the ones it already trusts, and shows how many. It no longer reads `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` from your computer, and neither reaches your agents. Agents that run on Node get the file you chose instead.

### Fixed

- An agent set to Full autonomy keeps working after it reads something from outside your team, like a web page or an email. It can make a promise and edit agent files such as SOUL.md and HEARTBEAT.md, and in Claude Code chats it can check account usage. Each of these adds a line to Activity, and so does starting a chat. Changing permissions, rewriting NOPE.md or MEMORY.md, and showing keys DorkOS keeps for you stay blocked.
- When you lower an agent's level, for example from Full autonomy to Ask first, its open chats follow right away.
- At Full autonomy, an agent that has read outside words and then tries to loosen a permission, or change a setting only you may change, is now told no, and Activity records it. Before, you got a card.
- When you let an installed package run commands automatically, your yes now covers the script files those commands name, not just the command. The card lists each file with a short fingerprint. If one of those files changes later, DorkOS asks you again. On the Full setting it doesn't ask, as before.
- In Claude Code chats, changes an agent makes to a project's settings wait for your OK before they take effect. A change to the local settings file that isn't checked in, like new hooks or allowed commands, keeps that file from loading until you approve it. A change to the project's checked-in hooks, the scripts they run, or the hooks a subagent or skill sets keeps all of the project's own settings from loading in that worktree until you approve it. Your own settings and hooks still run. A newly added command that the checked-in settings allow without asking still asks first. If `.mcp.json` changes, only DorkOS's own MCP servers and the ones from the default branch start. When DorkOS can read the change, an approval card shows it to you, and Activity notes what changed. Approve a change once and it runs in every worktree that has it. A project DorkOS hasn't seen before waits for your yes once, and so does a default branch that changes its hooks; projects you already had are trusted as they were. Undo the change and things go back to normal on their own. A chat set to Full autonomy has none of these limits: the project's settings load as they are, no card appears, and Activity notes what would have waited.
- In Claude Code chats, an agent's file tools can't change DorkOS's settings file, where your approvals are kept, at any permission level. Below Full, they also can't change the settings, MCP servers, agent file, skills, commands or subagents of any agent in DorkOS's data folder. A chat set to Full autonomy can change those agent files, and the Activity page notes it. Agents can still edit their own instructions, and skills in a project's own folders.
- When an agent goes quiet for 10 minutes, DorkOS stops its turn. In Claude Code chats, that stop used to look like a person's: the chat showed "[Request interrupted by user]", and a tool that was running read as declined. Now the chat says "DorkOS stopped this turn after 10 minutes with no activity," and the agent's next turn is told that no person stopped it.
- A connection paused until you confirm a setting no longer says "Stopped working" on the Connections page. It says "Paused", then the connection's own name, so two paused webhooks are easy to tell apart, with a Review button. In Needs you, its Confirm button is now full width and easy to tap on a phone.
- On Linux and in Docker, a new file you open in the canvas no longer shows editing turned off just because a different file, saved earlier, used the same file number. This needs a system that records when each file was created, which most do. Edits to the same file, or to another name for it, still wait until that save is resolved.

### Security

- When a Claude account starts using a different sign-in, you get one note in your inbox and one line in Activity. Your agents keep working. Until you keep the new sign-in in Settings → Runtimes, DorkOS won't pick that account for you on its own.
- Add a Never use list in Settings → Runtimes. Put a Claude account folder or an organization on it, and DorkOS won't run Claude there, even at Full. The list starts empty, and only you can change it.

## [0.126.4] - 2026-10-29

> DorkOS 0.126.4 stops agents set to Full from asking you anything, tells agents which DorkOS app they run in, and lets you add a tool server once for every agent.

### Added

- Agents know which DorkOS app they're running in: the Mac app, the Windows app, npm, Docker or a copy of the code. The update steps they give you now match your setup.
- Add an MCP server (a tool add-on for agents) once, and every agent gets it, on Claude Code, Codex and OpenCode. Codex and OpenCode skip servers that only use an older connection type (SSE). You can leave an agent out, and an agent's own server with the same name wins for that agent. Tokens and keys you enter are encrypted and never shown again, to you or to agents. Only you can change the list, and only from this computer.

### Fixed

- An agent set to Full never stops to ask you anything, including on schedules and heartbeats. Careful still asks before destructive connector actions at Full. Activity records each message a Full agent sends, and each setting it changes, after it has read words from outside your team.
- Below Full, a run with nobody there to answer stops and says why, instead of waiting for an answer that never comes.
- Below Full, after reading words from outside your team, an agent asks before it sends email, changes calendar events, edits its own instructions or git settings, installs a package or MCP server, links a chat to an agent, or changes a setting.
- Room updates reach only that room's members.
- A paused connection's row in Needs you says in two lines what was held back and where it was going. The ⓘ button explains the rest.

### Security

- A connection can use only the secrets saved for it. Changing a webhook's address asks for its secrets again, and removing a connection removes only its own secrets.
- After this update, connections that read a secret from an environment variable or the Keychain are paused until you confirm them, on the connection or in Needs you. Nothing is sent while a connection is paused.

## [0.126.3] - 2026-10-29

> DorkOS 0.126.3 stops one outside message from making a whole room of agents ask before almost every command, shows pictures and PDFs an agent puts on a room's canvas to everyone, and gives every agent a short list of what it can do in DorkOS.

### Added

- Spaces can now let an owner's or admin's own DorkOS app manage them, but only after that person types their password. The DorkOS app doesn't ask for this yet, so nothing changes for anyone today (DOR-3005)
- Making someone an admin, removing a member, and changing who may join a space always happen in the browser, never through an app (DOR-3005)
- Groundwork for actions that wait for your approval. The app now understands when DorkOS Cloud holds an action until you approve it, and never treats that action as done. Nothing on screen shows it yet (DOR-3265)

### Changed

- Every agent now starts with a short list of what it can do in DorkOS, one line per area: chats, rooms, the canvas, browsers, connected apps, MCP servers, tasks and more. Each line names the permission that controls it. An agent asked "can you use my browser?" or "can you add an MCP server?" now answers from DorkOS, instead of pointing you to a terminal or another tool. Before saying DorkOS can't do something, it searches what DorkOS offers.
- If your company's network needs its own certificates, and you point `NODE_EXTRA_CA_CERTS` at them, the Mac app keeps trusting them. It now reads that file itself, so its connections keep working on that network.

### Fixed

- An extension can no longer change another extension's saved data, secrets or settings through DorkOS: each write is checked against the extension that made it. With **Require login** on, these writes also need you signed in, or an agent that says who it is, so a program on your computer can't change them with only a key.
- When an agent puts a picture, PDF or other media file from its own folder on a room's canvas, everyone in the room can now see it. Before, the agent was told it worked, but everyone else saw a card instead of the file. DorkOS now copies the file into the room. A file outside the agent's own folders is refused, and the agent is told why.
- Agents in a shared room stop asking you to approve their commands after one of them reads an outside message. Before, one message from outside your team could make every agent in the room ask before almost anything, and it never wore off. Now an agent that picked up outside words keeps working at its usual level. It still asks you before shell commands, permission changes, and actions that delete things. The agent that read the outside message directly is still held, as before. (DOR-3390)

## [0.126.2] - 2026-10-28

> DorkOS 0.126.2 cuts the extra approval prompts. When one of an agent's chats reads a message from outside your team, its other chats no longer fall back to asking you first. And when an agent can't start a chat at a higher level, it now tells you why.

### Fixed

- When an agent can't start a new chat at a higher level, it now says why: it read messages from others, a person set it lower, or DorkOS couldn't find its level. Before, it always said the chat "runs at Default", even when it didn't. (DOR-3386)
- An agent's message to another chat is held back only when the chat it came from read something from outside your team. Before, when DorkOS had lost track of the sending chat's level (after a restart, say), any other chat of that agent reading a room post could hold it back, and the chat it woke then asked you to approve its commands. (DOR-3386)

## [0.126.1] - 2026-10-27

> DorkOS 0.126.1 makes changed extension code and a Claude Code agent's changed settings wait for your yes, tells you about secret files in an agent's folder, lets Never ask chats use DorkOS's safe tools again, and keeps heartbeats going when a Claude account runs out.

### Changed

- Agents on Claude Code can no longer edit their own skills or commands with their file tools. If an agent changes a skill another way, like with a shell command, and the change gives it more power, such as new hooks or tools, the change waits for your yes. To change a skill yourself, edit its file.

### Fixed

- When you turn on an extension, you now approve its files as they are. If they change later, the new code doesn't run until you approve it again. This covers extensions from the marketplace, including ones inside a plugin, and ones you turned on yourself, and an update to one of them asks again too. A folder you linked for development is the exception: edits to it keep running. Agents can still edit an extension's files; DorkOS just won't run the changed code until you approve it. The Activity inbox shows one "changed since you approved it" row per extension and names the files that changed. If the files change again while that row is open, approving it is refused and the row refreshes, so you never approve code you didn't see. On the Trusted setting, one kind keeps running while an agent edits it: one the agent made itself, in its own folder, set to run separately with limited access. If it changes what it's allowed to reach, it waits for you. Even then, only its behind-the-scenes code keeps running: if the agent changes what it shows on screen, that part waits for you, and the inbox row says so. An update from the marketplace says it's an update and names both versions, like "Update Flow from 1.2.0 to 1.3.0?". After you upgrade DorkOS, extensions you already turned on keep running as they are. The next change to their files asks you first.
- A mini app a Claude Code agent makes now lives in that agent's own folder, and you still see it in the side panel and on the Activity page whichever agent or folder you have open. Every agent's mini apps now stay listed when you switch agents. Other Claude Code agents can't change its files with their file-editing tools. If an agent makes one after reading a message from someone outside your team, it waits for you before it first runs, and every change after that waits too.
- A mini app is now built only from files inside its own folder. A plugin's mini app can also use files from its plugin. One that imports a file from outside, such as a shared folder next to it, no longer builds; move that file into the mini app's folder. Packages installed in its own folder still work.
- In Claude Code, an agent can no longer give itself more power by editing the settings in its own folder. Its file tools can't change its `.claude` folder, `.agents` folder, `.mcp.json` or agent file. If it changes its hooks, MCP servers or account another way, like with a shell command, that change is switched off. The agent keeps working without it, and an approval card shows what changed. Allow it, and the change applies from the agent's next turn. Turn it down, and you aren't asked again until the agent changes something else. Changes you make yourself in DorkOS, like picking an agent's account or adding an MCP server on its approval card, apply right away. The first time DorkOS starts after this update, it takes each existing agent's settings as the ones you allowed. In Claude Code, an agent's file tools also can't change the plugins installed in any project, or the ones shared across them.
- While a change to an agent's settings waits for your yes, the changed settings don't run, and neither does a switch to another runtime. New chats with the agent use the default runtime until you allow it. If the agent changed its hooks or other settings that run code, none of its folder's settings that run code take effect, and its own skills and commands don't load.
- On Claude Code, a new agent whose folder already runs something, like hooks, MCP servers or its own account, waits for your yes before any of it runs. A folder that asks for another runtime waits for your yes too. The agent itself still works in the meantime. A new agent whose folder runs nothing starts right away.
- DorkOS now tells you, in your inbox, when an agent's folder holds files that look like secrets, such as a dotenv file, a private key or a cloud credentials file. It checks when DorkOS starts and when an agent is added or changed. It looks at file names only and never opens the files. An agent can read any file in its own folder, whatever its rules say. Moving a secret out keeps it out of searches through the folder, but the agent may still be able to read it. The permission settings and docs now say this plainly, and the Never ask description no longer suggests it keeps the agent out of its own folder.
- The notice about secret files in an agent's folder now names the files it found and says what moving them does. (DOR-3292)
- A Claude Code chat set to **Never ask** can now read and post in its own rooms, and use DorkOS's other safe built-in tools. Before this, Claude Code refused them in Never ask, because no one was there to say yes. Claude Code agents can also check how much of each account is used without asking. In a turn started by a stranger's message, or one that saw a stranger's message in a room, the account tools don't run. A Never ask chat also can't send that turn's words to another chat.
- An agent's heartbeat keeps working when its Claude account runs out or is nearly out. It moves to another of your accounts with usage left. If none has any, it skips its beats until an account resets, instead of failing again and again.

## [0.126.0] - 2026-10-27

> DorkOS 0.126.0 applies an agent folder's own allow list once you approve it, keeps Claude Code agents out of secret files, says plainly when a schedule is failing, makes Stop end the commands a turn started, and lets you answer an agent from inside a mini app.

### Added

- Answer an agent from inside a mini app. The first time a mini app sends your comment to an agent, DorkOS asks you once. The comment then lands in your direct chat with that agent as your own message, and the agent treats it just as if you had typed it there. You can change which agents it reaches in Settings → Extensions. A muted line above the message says which mini app and item it came from, and the agent's answer can show up back in the mini app under the agent's name. A mini app can check with DorkOS whether you really wrote a comment. This works only when you sign in to DorkOS with a password. On the computer DorkOS runs on, also turn on "Ask for a password on this computer too" in Settings. Each comment sent this way is in the audit trail. (DOR-3325)

### Changed

- The desktop app now refuses to start with debugging switches.

### Fixed

- An agent's own allow list (`permissions.allow` in its folder's `.claude/settings.json` or `.claude/settings.local.json`) now applies under DorkOS. Before this, Claude Code ignored it in agent folders, so a chat set to **Never ask** refused even the commands the agent's folder allows, and said nothing about why. DorkOS now asks you with an approval card that lists the agent's rules. After you allow it, the rules apply from the agent's next turn. If the agent adds rules, the list stops applying until you approve the change; the card shows what was added and removed. A list that only loses rules keeps applying without asking. Some rules are never applied: rules naming DorkOS's own tools, rules with a wildcard tool name, rules that allow a whole tool (like a bare `Bash`, which runs any command, or `Edit(./**)`), file rules that reach outside the agent's folder, and a few other rules that match almost anything. While a list applies, the agent's file tools also can't change its own settings, the settings of other agents kept in DorkOS's agents folder, DorkOS's own data, or Claude Code's account files. A list the card can't show in full isn't asked about or applied, so you never approve a rule you couldn't see. The rules apply only when the agent works in its own folder (not a subfolder or a worktree), and never on a teammate's turn. While a list is waiting, a Never ask chat shows a line once saying why it's refusing.
- A Claude Code agent's file-reading tools can no longer open these files, at every permission level, Full autonomy included: DorkOS's own keys, settings and their backups, database, chat bot tokens, stored secrets and browser logins; the Claude Code, Codex and OpenCode sign-ins; and your SSH keys, AWS and Google Cloud keys, GitHub token and npm token. Before this, at Ask first and Act an agent could read them without asking. Tools like `git` and `gh` still read their own files as usual. Commands an agent runs in a shell are not covered yet, and neither are Codex and OpenCode agents. (DOR-3299)
- In a Claude Code chat, Stop now also ends the commands the agent started in that turn, even ones that moved to the background after running a long time. Before, a long command could keep running after you pressed Stop and finish its work anyway. If a command won't stop, a line under the stopped reply names it with its own Stop button, and a pill at the top says how many are still running. The line stays after a reload and says when everything has ended. (DOR-3285)
- Scheduled runs that take longer than two minutes now finish and show their real result. Before, they were marked failed with "the run never started", even though the work went on and often finished.
- When a scheduled run really can't start, it says why, for example: every agent slot was busy, the hourly limit on agent turns was reached, or nothing was there to run it. If nothing was there, it tries once more 30 seconds later.
- A run stopped at its time limit now says how long the limit was.
- A scheduled run that was refused a tool now says "Needs attention", not "Completed". Its history shows how many tools were refused and names them.
- Runs set to Never ask now record the tools they refused.
- The Schedules list shows how many schedules are failing, with a Failing filter, and puts them first unless you pick another sort. Each failing schedule says why.
- When a schedule is set to a level that asks, like Accept edits, its warning now says how to fix it: use Never ask with an allow list.
- A schedule that starts failing sends one notice. It says why and has an Open schedule button that shows your failing schedules. No more arrive until it runs cleanly and fails again.
- A message another agent queues in a busy chat now shows its own words in the queue, instead of the block of instructions DorkOS wraps it in for the agent. The agent still gets the full wrapper, which keeps it from mistaking another agent's words for yours.
- Message search shows those words too, for messages indexed from now on. To clean up older results, delete the search index and let DorkOS rebuild it.
- Another agent's queued message can be moved or removed but not edited, and Stop no longer puts it back in your message box as if you had written it. The Stop question now says which messages come back and which are cancelled, and the arrow keys skip over other agents' messages.
- A queued message from another agent now says who sent it and which chat it came from, with a link to that chat when it can be opened. The queue's count shows how many are yours and how many came from other agents.
- DorkOS no longer runs git in folders an agent can change: every agent's home folder (including a project folder you set up as an agent), workspaces, worktrees and rooms, and projects that have a worktree in one of those. For now, chats in those folders don't show the git branch, the diff view can't compare with the last commit there, the file list there doesn't skip ignored files, the Workspaces page shows those checkouts as unreadable, and heartbeats skip new commits and failing checks. (DOR-3343)
- When Claude Code can't read its sign-in, the app now says so instead of saying you're signed out, and tells you to check your Mac for a password prompt.
- Long schedule names, empty rooms and long pasted paths in room messages now stay within the phone screen (DOR-3188, DOR-3189, DOR-3193).

### Security

- DorkOS's tool server now refuses very large tool inputs (over 10,000 items) and requests over 1 MB before reading them further.

## [0.125.4] - 2026-10-24

> DorkOS 0.125.4 names a signed-out Claude account, and signs in to that account, not your default.

### Fixed

- When a Claude account is signed out, the banner names it, and **Sign in** signs in to that account, not your default.

Older releases (v0.1.0 – v0.125.3) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.125.3.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.125.3.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.129.0...HEAD
[0.129.0]: https://github.com/dork-labs/dorkos/compare/v0.128.0...v0.129.0
[0.128.0]: https://github.com/dork-labs/dorkos/compare/v0.127.1...v0.128.0
[0.127.1]: https://github.com/dork-labs/dorkos/compare/v0.127.0...v0.127.1
[0.127.0]: https://github.com/dork-labs/dorkos/compare/v0.126.4...v0.127.0
[0.126.4]: https://github.com/dork-labs/dorkos/compare/v0.126.3...v0.126.4
[0.126.3]: https://github.com/dork-labs/dorkos/compare/v0.126.2...v0.126.3
[0.126.2]: https://github.com/dork-labs/dorkos/compare/v0.126.1...v0.126.2
[0.126.1]: https://github.com/dork-labs/dorkos/compare/v0.126.0...v0.126.1
[0.126.0]: https://github.com/dork-labs/dorkos/compare/v0.125.4...v0.126.0
[0.125.4]: https://github.com/dork-labs/dorkos/compare/v0.125.3...v0.125.4

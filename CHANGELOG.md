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

## [0.141.0] - 2026-11-23

> DorkOS 0.141.0 makes "Confirm it’s you" safer and clearer: it says why it can't confirm, and a page that's only out of date reloads itself once. Agents also learn to wait their turn when your computer is busy.

### Note for people upgrading

- **If a DorkOS tab stayed open during the update, reload it.** Until you do, confirming something there says "DorkOS changed after this page opened. Reload it, then try again." (DOR-5026, DOR-5086)
- If an agent's replies in a Telegram or Slack chat, or to another agent, switch model or account after you update, set the model and account on the agent itself. (DOR-5057)
- With to-dos turned on: if you set To-dos to Ask or Blocked for an agent, that now covers all of its to-do tools. (DOR-3953)
- Known issue: Flow can't ask you questions in the Inbox until you update it to its next version and allow Inbox cards.
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now, so agents can't use the Agent browser for those turns. Ask from a direct chat instead. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- Codex in Docker doesn't work on Ubuntu or Debian yet, even with the new profile: their AppArmor rules block its sandbox. The chat says "Codex can’t run in this Docker setup yet". Leave AppArmor as it is, and use Claude Code or run DorkOS outside Docker for now. We're fixing it (DOR-4836).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Added

- Agents in DorkOS's own agents folder, and every new agent, now have a skill about the line their builds, test runs and installs wait in while your computer is busy. It knows which commands wait and which run at once, that a wait is a place in line and not a hang, and that a run refused because the computer was too busy should be tried again later, not reported as a failure. (DOR-4209)
- The skill never works around the line. It tells you in one line when a wait is holding up urgent work, so you can let that job through from the Activity page. (DOR-4209)

### Security

- Hardened "Confirm it’s you". Once a mini app stops being a risk, because you turned it off, removed it or approved its change, a confirm counts only from a page DorkOS loaded after that, in the browser and in the Mac app. (DOR-5026)
- The server log now records requests from other devices on your network, with each device's address, whether DorkOS accepted the request or not. It keeps up to 60 lines a minute per device, then a count of the rest. The line never includes a sign-in token, a cookie or a video link's key. (DOR-5042, DOR-4736)
- An agent working under limits can't reword, move or remove a waiting message. It sends a new one instead. Your own edits work as before. (DOR-5039)
- Hardened agent settings: an agent answering a Telegram or Slack chat, or another agent, reads its settings only from its own home. (DOR-5057)
- Hardened approvals: more kinds of invisible characters in text you approve, like a scheduled task's instructions or a package's commands, show as visible codes, now on the scheduled task card too. (DOR-5060)
- With to-dos turned on: to-dos changed from another device on your network follow the same limits as messages. From a device that isn't allowed to run agents, you can still check off, reopen, add a note to and reorder your own to-dos. (DOR-5070)
- With to-dos turned on: blocking To-dos in an agent's permissions covers every to-do tool. (DOR-3953)

### Fixed

- **"Confirm it’s you" now says why it can't confirm.** When a mini app is the reason, it names the app and offers How to fix. (DOR-4906, DOR-5086)
- When the page is only older than a change, it shows "Updating this page…", reloads once, and opens the same request again for your password. If you typed something on the page, or another request is waiting, it offers a Reload button instead, and says when reloading would clear what you typed. The Mac app's window has the same Reload button. (DOR-5086)
- "Sign in again" on the "Confirm it’s you" sheet now reloads the page for you. Then click the button you were confirming again. (DOR-5026)
- Scheduled tasks no longer lose their permissions when their instructions file hasn't changed. Extra spaces at line ends, line-ending style and extra blank lines outside code blocks no longer count as a change. A task that will be limited but has no way to clear it now has a Review file button, so you can approve the file as it is. (DOR-5060)
- The Review file dialog fits its file, says plainly what approving does, and tells you when no approved copy was kept to compare. Hidden characters show as marked chips that typed text can't fake, and an emoji's color mark is no longer flagged as hidden. (DOR-5075)
- With to-dos turned on, adding or reading your team's own to-dos no longer makes an agent ask before it sends through a connected app, and it can add several to-dos in one turn. A to-do holding a stranger's words still makes it ask first. (DOR-4666)
- Chats started in an agent's folder from the command line now count as that agent's chats in more places. They take messages from other agents, keep their agent when they continue on another account after a usage limit, and can use the agent's saved browser profiles and sign-in account. Other chats see the agent's name, messages held for it while it's paused are counted, and the chats it starts count as its open work. (DOR-5038)
- A room hand-off that was waiting its turn when DorkOS restarted now posts once the agent is free, and the chat that asked hears back once. (DOR-5087)
- A Telegram or Slack chat now gets answers from its agent when that agent works in its own copy of a project or in the default folder. (DOR-5055)
- A hand-off's end notice now still arrives after the chat it came from was closed in the background. (DOR-5040)

### Going back

0.141.0 adds no database or settings changes. To go back, install 0.140.1.

- Pages confirm it's you as they did in 0.140.1. If one can't, reload it.
- Agents keep the waiting-their-turn skill, but 0.140.1 doesn't update it.
- With to-dos turned on, blocking To-dos no longer stops adding, changing or reading to-dos.
- A scheduled task whose file only changed spacing may be limited again. Approve its file to clear it.

## [0.140.1] - 2026-11-22

> DorkOS 0.140.1 lets you approve an updated mini app again: a mini app waiting for your OK no longer turns off "Confirm it’s you". Room hand-offs and spin-off reports that are still waiting now survive a restart.

### Note for people upgrading

- **After you update, sign in again and reload the page in each open browser before you confirm it's you there.** (DOR-4906)
- **A mini app from a GitHub plugin, like Flow, that you use in more than one place may pause.** If a copy in another project, or one installed for every project, has different files from the copy you allowed, or you allowed it before version 0.127, it waits for your OK in Activity. (DOR-4895)
- Known issue: Flow can't ask you questions in the Inbox until you update it to its next version and allow Inbox cards.
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now, so agents can't use the Agent browser for those turns. Ask from a direct chat instead. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- Codex in Docker doesn't work on Ubuntu or Debian yet, even with the new profile: their AppArmor rules block its sandbox. The chat says "Codex can’t run in this Docker setup yet". Leave AppArmor as it is, and use Claude Code or run DorkOS outside Docker for now. We're fixing it (DOR-4836).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- If you allowed a mini app from a GitHub plugin, a copy of it in another project, or one installed for every project, now runs on that OK only when its files are the same. A different version waits for your own OK in Activity, and that mini app is paused until then, unless you trust its source. The update card says this for its mini apps. (DOR-4895)
- A Claude Code agent's file editing tools are blocked in a folder you linked for development, in a chat that read words from someone other than you, like a shared room, and in a turn that runs under a limit. (DOR-4896)
- Setting `DO_NOT_TRACK=1` or `DORKOS_TELEMETRY_DISABLED=1` now also turns off the DorkOS server's check for a newer version, and the same check in the `dorkos` command. The desktop app's own updater still checks for new versions. With either set, DorkOS passes `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1` on to Claude Code, Codex and OpenCode. (DOR-4990)
- The `dorkos` command now honours `DORKOS_UPDATE_CHECK_DISABLED=1`, the same switch the DorkOS server already had. (DOR-4990)
- On the Mac app, a `DO_NOT_TRACK` you set in your shell's startup file now reaches DorkOS too. Before, only a terminal start picked it up. (DOR-4990)

### Fixed

- **A mini app waiting for your OK no longer turns off "Confirm it’s you".** Before, approving an updated mini app could fail because of that same update, or because of another app's update. DorkOS never loads a waiting app's new code into the page. A mini app that is running changed code still turns confirming off, and DorkOS names it. (DOR-4906)
- If you close "Confirm it’s you" without confirming, the app now says nothing changed. In the Mac app, the sheet names the "Confirm it’s you" window and says closing it changes nothing. (DOR-4909)
- A hand-off waiting on a busy room seat, or a report waiting to come back from a spin-off chat, now survives a server restart. If one can’t safely pick up where it left off, you get a notice instead of silence. (DOR-3816)
- An agent's chat started with only a folder, for example from the API or the command line, can now hand a post to the agent's place in a room. When DorkOS can't accept a hand-off, the message now says what's missing. (DOR-5035)
- When every agent slot on your computer is busy, a chat one agent starts for another waits in line, and that wait no longer counts against its five-minute start limit. If a chat was reported as never started and then starts, the agent that started it hears "started after all", once. (DOR-4985)
- A message waiting in a chat's queue keeps its limits when you pause the agent or DorkOS restarts. When it runs, it still says it came from outside your team, so a refusal names that instead of showing a plain approval card. (DOR-4350)
- Before you save who can use an app, one line says what will happen, like "Scout keeps Apify. Every other agent loses it." The same line shows after you save. An agent ticked because it has its own access says **Own access**. (DOR-4899)
- You get a new notice if a schedule succeeds and then fails again, even when runs start at the same time. (DOR-4907)
- A new agent's first chat shows "New chat" as its title until you write, not a code tag. Chats that already had the tag show "New chat" too. (DOR-4976)

### Going back

0.140.1 adds two database changes: the limits a queued message carries, and a list of hand-offs and reports waiting to be delivered. To go back, install 0.140.0. It ignores them and starts normally.

- If an agent is paused when you go back, resume it and check its queued messages first. 0.140.0 runs them without the limits they carried.
- A hand-off or spin-off report that is still waiting is dropped, with no notice.
- A different version of a GitHub plugin's mini app runs again without asking, if you allowed another version.
- Approving an updated mini app can turn off "Confirm it’s you" again. If you come back to 0.140.1, sign in again and reload the page in each open browser before you confirm.

## [0.140.0] - 2026-11-21

> DorkOS 0.140.0 lets phones and laptops on your Wi-Fi sign in with a code you approve on your Mac, and adds a second sign-in step for other devices. Agents' heavy jobs now wait in line, and each agent gets its own Agent browser.

### Note for people upgrading

- **On a Mac with Wi-Fi access on, every Wi-Fi device is signed out once.** It signs in again with a code you approve on the Mac, in a browser, with a passkey. Add a passkey first in **Settings → Login & security**. Until you turn on **Run agents from this device** for a device, agents ask before every file or shell action from it, your own messages included. (DOR-4744)
- Wi-Fi access still isn't encrypted. Turn it on only on networks you trust, like your home network, and turn on **Run agents from this device** only there.
- **Agents' heavy jobs now wait in line.** Builds, test suites and installs that agents on Claude Code, Codex and OpenCode start run one chat at a time on this computer, and wait longer while it's busy. Only you can change this, or turn it off, under `runtimes.loadGate` in `~/.dork/config.json`. (DOR-4209)
- **Each agent now has its own Agent browser, starting signed out.** To give an agent the sign-ins in your Chrome window, share it with that agent. A chat with no agent, like some a schedule started, can't open an Agent browser page. (DOR-4741)
- **Some mini apps show in fewer places until they're updated or allowed again.** A place an app's files don't list, such as a ⌘K command, a dialog or a status bar item, stops showing, and Settings names the app. Canvas documents and Inbox cards ask once more. Apps an agent made and approved on its own ask again for every place. (DOR-4282, DOR-4891)
- A mini app named like a DorkOS page, such as Tasks, Team or Settings, or with a name starting with DorkOS, no longer starts. Settings says so. Give it another name in its `extension.json`. (DOR-4282)
- Known issue: Flow can't ask you questions in the Inbox until you update it to its next version and allow Inbox cards.
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now, so agents can't use the Agent browser for those turns. Ask from a direct chat instead. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- Codex in Docker doesn't work on Ubuntu or Debian yet, even with the new profile: their AppArmor rules block its sandbox. The chat says "Codex can’t run in this Docker setup yet". Leave AppArmor as it is, and use Claude Code or run DorkOS outside Docker for now. We're fixing it (DOR-4836).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Added

- **Sign in on Wi-Fi with a code.** On a Mac with Wi-Fi access on, a phone or laptop on your Wi-Fi signs in with a short code you approve on the Mac, instead of your password. Check the code on both screens, approve with a passkey in a browser, then type the one-time code on the device. Wi-Fi sign-ins end after 12 hours unused. (DOR-4744)
- **Choose which Wi-Fi devices run your agents.** Each Wi-Fi device starts at the safer level. Turn on **Run agents from this device** for one device, on the computer DorkOS runs on. It turns off by itself after 12 hours unused. (DOR-4744)
- **A second sign-in step for other devices.** On the computer DorkOS runs on, add an authenticator app in **Settings → Login & security**. Then signing in from another device needs its code too. You add or remove one only on that computer, and it never asks for the code there, so you can always get back in. Adding your first one signs out your other devices. Once you've had one, removing it doesn't bring back signing in with just your password. (DOR-3647)
- **Heavy jobs wait in line.** Heavy jobs that agents on Claude Code, Codex and OpenCode run, like builds, test suites and installs, take turns, first come first served, and wait longer while the computer is busy, so it stays usable. A waiting chat shows its place in line. A job that has waited four hours runs anyway. Quick commands like `ls` never wait. A job that needs your OK gives up its turn while it waits for you. A job an agent sends to the background waits to start, but doesn't keep its turn while it runs. On Codex, a job Codex asks you about waits before you're asked, and a job Codex runs without asking takes a turn while it runs, so others wait behind it. On a busy computer, a Codex chat's next reply can wait too, up to an hour, and the chat says so. (DOR-4209, DOR-4743)
- The Activity page lists the heavy jobs that are waiting: each one's place in line, its agent and chat, what it runs and how long it has waited. You can let one through, mark it urgent, or move it to the front. It shows only on the computer running DorkOS, and agents can't change it. (DOR-4209)
- Each chat gets its own Agent browser page, so one chat's browsing doesn't interrupt another's. (DOR-4273)
- **Settings → Backups** lists your older backups, and you can remove them or move them, such as to an external drive. (DOR-4253)
- On Linear's page in Connections, you can let an agent that only read Linear write back to it without asking. It starts off. Sends, deletes, and a turn that also read words from anywhere else still ask first. Each write that skips the ask leaves a line in Activity. (DOR-4794)
- An agent's profile page is now named for it, like **What Scout knows**. It starts with what that agent can do: one row for each area on its Permissions page, with its level there now. (DOR-4115)
- A preview lets you watch your agent's Chrome page inside DorkOS, on the computer it runs on. It's off unless you start DorkOS with `DORKOS_AGENT_BROWSER_STREAM=true`, and it needs owner sign-in. (DOR-2667)

### Changed

- The New schedule and Edit schedule forms show how much the agent may do on each run, right on the form. Saving a schedule at Full, or at another level that never stops to ask, asks you to confirm once. (DOR-3841)
- A package's install and update review shows each mini app it brings, with its screens, permissions and secret requests. (DOR-4866)
- The DorkOS Cloud terms list the company's new mailing address. (DOR-4833)

### Security

- A mini app shows up only in the places its approval card lists, such as a page, ⌘K commands or dialogs, and the card names every one. A new place stays off until you allow it, in the Inbox or in Settings. (DOR-4282, DOR-4891)
- DorkOS puts an app's name on its dialogs and ⌘K commands, so you can tell they come from the app. Apps can't use names that start with DorkOS or match DorkOS's own pages, like Settings or Inbox. (DOR-4282)
- When an agent asks to change your settings, the card shows each change as old → new, and marks each one only you may change. (DOR-4775)
- When an agent asks to send an email or a calendar invite, the card lists every recipient on its own line. Hidden characters in an address show as a visible code. (DOR-4592)
- The Agent browser has stronger checks before it reads, screenshots or acts on a turn from outside your team. (DOR-4734)
- Only you, at the computer DorkOS runs on, can share your Chrome window's sign-ins with an agent. You pick the agent each time and confirm it's you first. (DOR-4741)

### Fixed

- A busy DorkOS no longer stops a healthy mini app by mistake. If an app stops, a notice names it and DorkOS restarts it. If it stops too often, the notice offers **Restart**. (DOR-4785)
- A mini app you turn on, turn off or approve right after its files change now stays that way. Its approval card shows up soon after its files change, and cards for deleted apps go away. (DOR-4886, DOR-4855)
- When your computer sleeps in the middle of a scheduled run, its history says "Interrupted: the computer slept during this run", and the task runs once more after the computer has been awake for two minutes, if it's still due. (DOR-3286)
- The Mac app shows download progress while an update downloads, and offers **Try again** if the download fails. Update checks and errors go to their own log, `~/.dork/logs/updater.log`. (DOR-4846, DOR-4847)
- DorkOS no longer stalls at startup when Google Fonts is slow or blocked. Its default font comes with the app.
- DorkOS keeps the last 3 daily backups and the last 3 it takes before an update. Older backups you already have aren't touched. (DOR-4253)
- You can drop any promise given to an agent, and on the computer DorkOS runs on, promises you add are saved as yours. Before, Drop said "Try again" however often you tried. (DOR-3832)
- When an account's usage can't be read, agents see it flagged as loudly as a full account. Fully used accounts show as limited. (DOR-4620, DOR-4513)
- Agents are now told correctly that they can move to another account when their usage runs low. (DOR-3833)
- When an agent's chat reaches its usage limit, whoever sent it a message is told. (DOR-4815)
- When DorkOS Cloud can't serve a turn, the error card shows the reason it gives, not a generic "server error". Choosing DorkOS credits no longer leaves account usage stuck on an error. (DOR-4845)
- Codex starts in the Docker image on Docker Desktop for Mac when you run it with the profile DorkOS ships, and the Docker guide shows the line to add. When Docker blocks Codex's sandbox, the chat says so. (DOR-3800)
- Codex shows **Choose another folder** when it can't protect a folder's Git files. (DOR-4534)
- The Agent browser hands the page to you when a site keeps reloading, and successful clicks no longer show as failed. It follows your system's display and accessibility settings, and Chrome's popup blocker is back. (DOR-4816, DOR-4817, DOR-4697)
- A sign-in's return page is kept when another sign-in attempt is refused, and Chrome's sign-in and sync offers are off in DorkOS browsers. (DOR-4703, DOR-4818)
- Approving an app action after the 10-minute wait now finishes it, once. (DOR-4717)
- Removing a saved tool approval keeps the settings file's permissions. (DOR-4781)
- A schedule from a package explains how to make a copy if you want to change its permission.
- A file you open from the Files tab can be edited on the canvas in chats with no agent, like ones a schedule started. (DOR-4844)
- A file you just opened on the canvas no longer shows up as two tabs for a moment.
- A room keeps its current chat if moving to a replacement chat fails.
- When the local model answers a room message with nothing, the reply shows as failed, and it's asked for plain text. (DOR-2843)
- An agent on Claude Code building a mini app in a chat that read words from outside your team, like a room with another person in it, is told why it can't edit the app's folder, and how to publish each version to your personal marketplace for you to approve. A package an agent just made there can be installed right away. (DOR-4851)
- Agents and the docs explain building a mini app the same way everywhere, and agents are told to list every place an app shows. (DOR-4854, DOR-4282)

### Going back

0.140.0 adds three database changes: a record of how each new chat started, your sign-in checks along with when each Wi-Fi sign-in was last used and whether it may run agents, and a write-back switch on each connection. It also adds one setting, `extensions.legacySlotless`. To go back, install 0.139.0. It ignores them and starts normally.

- Phones and laptops on Wi-Fi sign in with your password again, and every device signed in as you runs your agents at their own level, whatever its **Run agents from this device** switch says. Wi-Fi sign-ins no longer end after 12 hours unused.
- Sign-ins from other devices need only your password again. Your authenticator app and passkeys are kept. If you come back to 0.140.0, sign-ins made with just a password while you were on 0.139.0 stay signed in, so sign out other devices in **Settings → Login & security**.
- If you come back, every Wi-Fi device that signed in on 0.139.0 is signed out once.
- Agents' heavy jobs no longer wait, and the waiting list leaves Activity. Your load settings are kept.
- Agents share one Agent browser page again. It's the in-app browser, with every sign-in you made there on 0.140.0. Each agent's own browser and its sign-ins are kept for when you come back.
- Mini apps show in every place their files list, including places you hadn't allowed, and can use names like DorkOS's own pages again. An app you approve again on 0.139.0 shows only as a panel tab and a Settings page when you come back, until you allow its other places.
- Linear writes after a Linear read ask first again. The switch stays on for when you come back.
- Notices about a stopped mini app, or a sign-in check added or removed, don't show in the 0.139.0 Inbox. The bell can still count them until you mark everything read.
- **Settings → Backups** is gone. Backups 0.140.0 made stay in the folder, and 0.139.0 doesn't remove them.
- A scheduled run your computer slept through no longer runs again after it wakes.

## [0.139.0] - 2026-11-20

> DorkOS 0.139.0 lets you finish signing in through the Agent browser with a Done signing in button. Codex chats switch to a model that works instead of stopping, and quitting while DorkOS starts no longer crashes it.

### Note for people upgrading

- If you reach DorkOS from your other devices, use a long password you don't use anywhere else, and turn on Wi-Fi access only on networks you trust, like your home network.
- **Codex chats on your own sign-in now check their model against the models your OpenAI account lists.** A model that isn't listed, even one set in Codex's own settings, is swapped for your account's default, and that chat keeps it. (DOR-3168)
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- An approval stays tied to exactly the action you saw. If DorkOS can't describe an action that exactly, it turns it down instead of asking you. (DOR-3137)
- Shell commands on the DorkOS runtime now say they come from an agent, as they already did on Claude Code, Codex and OpenCode. Tools that check, like the /flow plugin, can tell an agent ran them. (DOR-3717)

### Fixed

- Sign-in no longer reports success to your agent without opening a window. If the sign-in window doesn't open, asking again opens it or says why not. (DOR-4731)
- When your agent hands you the Agent browser to sign in, the card now has a **Done signing in** button from the moment the sign-in window opens. Press it to close the window, save your sign-in and hand the browser back. On a Mac, closing that window left Chrome running, so your agent waited forever. There, Done signing in quits it the way ⌘Q does. If it doesn't quit, the card asks you to click it and press ⌘Q, and your sign-in still saves. If the sign-in can't be saved, the card says so and offers **Sign in again**. **Stop task** leaves the window open for you, and the browser panel offers **Done signing in** for any sign-in window still open. (DOR-4731)
- When the model a Codex chat on your own sign-in asks for isn't available, the chat no longer stops. It switches to your account's default model, keeps using it, and tells you which one. This doesn't apply on DorkOS credits or a custom model server. (DOR-3168)
- After you change the DorkOS runtime's default model, picking an older chat's own model in its model menu works again instead of being refused, including after you restart DorkOS. (DOR-4488)
- Quitting or updating DorkOS while it's still starting no longer crashes it. It closes cleanly. (DOR-4689)

### Going back

0.139.0 adds no database changes. It adds one group of settings, `runtimes.loadGate`, for a feature that isn't turned on yet. 0.138.0 ignores it and leaves it in your settings file. To go back, install 0.138.0. It starts normally.

- If you go back to 0.138.0, a Codex chat that switched models shows "This part of the chat couldn't be shown." where the note naming the new model was. The rest of the chat shows normally. It's cosmetic.
- Codex chats that already switched keep the model they switched to. Others whose model isn't available stop again instead of using your account's default.
- The sign-in card loses its Done signing in button, and on a Mac, closing the sign-in window can leave your agent waiting again.
- Picking an older chat's own model on the DorkOS runtime can be refused again after you change its default model.

## [0.138.0] - 2026-11-19

> DorkOS 0.138.0 lists every setting, riskiest first, when an agent asks to change several at once. A chat that took in outside words now stays held until you write in it, apps can play long videos, and an agent can take back a request it no longer needs.

### Note for people upgrading

- **After a chat takes in words DorkOS can't vouch for, like a stranger's message, an email the agent read or a web page, that chat stays held until you type your own next message in it in the DorkOS app.** Until then, its scheduled runs and heartbeats can't send through a connected app, and other agents' messages there ask you first. This includes chats that were held when you update. Waiting or a restart doesn't clear it, and for now neither does a message you send from Telegram or Slack. (DOR-4515)
- **When a page on a canvas sends events to an agent, that turn now counts as outside words,** so it asks you before it sends anything or does something it can't undo in an outside account, and the chat stays held until you write in it. (DOR-4603)
- **An agent that reads another agent's scheduled runs now needs its chat at Full autonomy.** Below Full it's told the runs aren't its to read. (DOR-4600)
- **A settings card that includes a setting only you may change no longer offers Always allow,** so those cards ask each time. (DOR-4778)
- **Mode-change cards for a scheduled task raised before this update need asking again.** The agent is told to send its request again. (DOR-4335)
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- When an agent asks to change several DorkOS settings at once, the approval card lists every one by name, riskiest first, and never shortens a setting only you may change. A change too large to show whole is turned down, and a card with any setting only you may change doesn't offer Always allow. (DOR-4778)
- A chat that took in words DorkOS can't vouch for now stays held until you type your own next message in it in the DorkOS app. Until then, another agent's message there asks you first before it sends anything through a connected app or does something in an outside account it can't undo, and it can't raise its own power or reveal a secret DorkOS holds. A scheduled run or heartbeat there can't do any of those things. Waiting never clears the hold. This is for chats, not rooms. (DOR-4515)
- When a page on a canvas sends events to an agent, the turn they start now counts the page's text as words from outside your team, like a mini app's message. (DOR-4603)
- In an agent's chat, the run-history tool now answers only for that agent's own schedules and for schedules that belong to no agent. Another agent's runs need a chat at Full autonomy whose turn read no outside words, the same rule as changing that agent's schedule. The app and its people see every schedule's runs, as before. (DOR-4600)
- A video link plays one video from one app and nothing else. It never acts as you. It stops working after 10 minutes unused, after 2 hours at most, and as soon as the app is turned off, reloaded or updated. DorkOS's logs hide the link's secret part. (DOR-4321)

### Added

- Apps with their own server part can now play long MP4 or WebM videos. A video starts quickly, you can skip ahead, and there is no size limit. Apps that show pictures work as before. App makers use the new `api.mediaUrl`. (DOR-4321)
- An agent can now take back a request it asked you to approve, once it no longer needs it. The card goes away everywhere you see it, and the audit log shows that the agent took it back. An agent can take back only its own requests, and only while you haven't answered them. (DOR-4586)

### Fixed

- When an agent asks to change how a scheduled task runs, the approval card now also shows any mode and rules it asked for that this approval won't apply. A yes counts only for that exact request; the rules still wait for your own Approve. The agent is told so. The card names modes the way the mode picker does, like "Never ask". (DOR-4335)
- On a schedule's approval card, "Try it once now" now runs at the mode you picked when it's stricter. The card names a different mode only when the test run can't use yours. (DOR-4336)
- A schedule's next run time is now worded the same way on the Schedules list as in Needs you: "9:00 AM" for today, "tomorrow at 9:00 AM", "Sat at 9:00 AM" this week, and the date after that. (DOR-4483)
- When DorkOS picks a Claude account by itself, it no longer picks one it last saw signed out. That covers moving an agent or a room seat off a full account, starting a new chat, and the work queue. You can still choose a signed-out account yourself, and DorkOS tells you it is signed out. A work queue that waits for that reason now says so. (DOR-4439)
- When DorkOS moves a chat to a new id behind the scenes, the chat now keeps what its latest turn was set to, so an older Full setting never outlives a newer, lower one. (DOR-4606)
- When a file on a chat's canvas can't be edited, the canvas now tells you, as the owner, why. For example, its folder was moved, or the file is outside the chat's agent folder. (DOR-4442)
- The app-building skill every agent has is updated. It tells agents which reads make an app wait for your yes, and when a change to an app's server code waits too. Agents are told to show you everything an app can reach while it waits, put the app's name on its commands and dialogs, and keep an app's stored data, secrets and private details out of shared places and out of its code. (DOR-4756)

### Going back

0.138.0 adds no database or settings changes. To go back, install 0.137.0. It starts normally.

- A chat that took in outside words no longer holds its later scheduled runs, heartbeats or other agents' messages, and the next of those clears the hold.
- An agent's chat can read every schedule's past runs again, and canvas page events no longer count as outside words.
- "Try it once now" on a schedule's card runs at the task's saved mode again, even if you picked a stricter one.
- Settings approval cards go back to their shorter form.
- Mode-change cards for a scheduled task raised on 0.138.0 need asking again.
- DorkOS may again pick an account it last saw signed out.
- Apps can't use the new video links, so long videos in them don't play.
- Agents keep the updated app-building skill. Requests an agent took back stay closed.

## [0.137.0] - 2026-11-19

> DorkOS 0.137.0 asks for your DorkOS password, if you've set one, before many more changes that give agents or people lasting access. A send through a connected app also needs your OK when that turn already read mail, a web page or another app's tool. About 190 more apps count as spending money, and many fixes land across the Agent browser, rooms, schedules and mini apps.

### Note for people upgrading

- **If you've set a DorkOS password, many more changes that give lasting access now ask for it,** at your desk or over Remote Access. If you never set one, these changes at this computer go through as before, and away from it they can't go through until you set one. If your password is short, DorkOS asks you to choose a longer one first. Lowering a setting or a grant stays instant. The full list is under Security. (DOR-4355)
- **From a phone or tablet on your Wi-Fi, you can now only deny approval cards.** To allow one, answer at your computer or over Remote Access. (DOR-4355)
- **Over Remote Access, allowing an approval card for a DorkOS action asks for your password each time.** Tool prompts there are allowed one at a time, and a one-time Allow on one is still one tap. (DOR-4355)
- **Adding people who may approve or message your agents on a chat connection, opening one to anyone, or turning one back on is now yours to do.** An agent asks you on a card. (DOR-4355)
- **Sends now wait after outside reading.** When a turn has read through a connected app, a web page or another app's tool, a send through a connected app in that same turn needs your OK, at every level. A schedule that reads mail and then replies can't send that reply on its own any more: on its timer the send is refused, and started with Run now it asks you. Files an agent reads and commands it runs (such as curl or git) don't count yet. (DOR-3969)
- **About 190 more connected apps now count as spending money,** and more risky actions need to be picked for an agent one by one. A Read or Read and write grant you gave before no longer covers those actions, and neither does sharing the app with every agent. To let an agent use one, pick that action for that agent on the Connections page. (DOR-4597, DOR-4505, DOR-4624)
- **A mini app's paid reads now use your monthly spending limit.** With no limit set, or no price set for that app, a mini app can't run them. (DOR-4575)
- **Mini apps edited by agents on Codex, OpenCode or the DorkOS runtime now wait for your OK** before their new server code starts. (DOR-4528)
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- **Confirm it's you before more lasting access changes.** Once you've set a DorkOS password, DorkOS asks for it before many more changes that give agents or people lasting access, at your desk or over Remote Access. Lowering a setting or a grant stays instant. It covers: (DOR-4355)
  - API keys, Remote Access and Wi-Fi settings, signing out another device, and raising what agents may do or spend.
  - Credits for agents, checks and scheduled tasks; space moves; showing or replacing the local MCP token.
  - Raising or removing a space's limit on teammates' turns, and turning on an extension.
  - Installing, updating or linking code; adding a package source; applying a Shape; running a workspace's setup commands.
  - Widening what agents may do with a connected app, saving an app's key, connecting or resuming an account, undoing a narrowing, and keeping a connected app's access as it stands after a review.
  - Letting a chat connection do more, reach more chats, point at another agent, let anyone message your agents, or turn back on; and adding someone who may approve or message your agents there. Only you can add those people.
  - A schedule that runs with more permission, connecting a space account, letting a space wake your agents more widely, giving an extension a secret, and giving a page a standing event route.
  - Saving a key for a runtime, or the address it sends your agents' prompts to, and signing OpenCode in to OpenRouter.
- Approvals that grant lasting access, like Always allow, ask for your password and show a request code to check. A yes from your phone over Remote Access asks you to confirm too. Creating and renaming API keys over Remote Access works after you confirm. (DOR-4355)
- Letting a mini app read a connected account now ends on its own page with a request code and an **Open DorkOS** button, so you can confirm it's you there and check the code matches. (DOR-4355)
- When an agent asks to let someone approve or message your agents on a chat connection, or to let a chat route do more, you get a card. It names the connection by its type and id, and shows exactly what changes. You confirm it's you, and DorkOS makes that one change. The card lasts ten minutes, and it counts once. A card from an agent that read words from outside your team never appears. (DOR-4355)
- When an agent changes a scheduled task that runs on DorkOS credits so it costs more (its prompt, its schedule, a longer time limit, or what it runs on), you get a card first, and nothing changes until you say yes. Lowering the limit, switching it off or moving it off credits still happens at once. (DOR-4609)
- After an agent reads through a connected app, a web page, a tool from another server, or a room or chat that holds outside words, a send through a connected app in that same turn asks you first, and the card usually says the agent just read words from outside your team. In a run nobody is watching, that send is refused. Files an agent reads and commands it runs (such as curl or git) don't count yet. (DOR-3969)
- A task or agent can be set as one that reads outside text, like mail or web pages. Its posts are then treated as outside words, and an agent can't switch that off. (DOR-3969)
- On Claude Code, a task's list of commands that run without asking (a one-shot task's, or the list a task takes when an agent moves it off Bypass) holds only exact one-line commands, with no wildcards or shell tricks, and no wider than what the agent may already do. DorkOS records each program and checks it before every run, including runs started by hand. If a program changed, or the agent no longer runs commands without asking, the run stops and nothing runs. Adding commands later still takes a person's yes. (DOR-4315)

### Added

- An agent on Claude Code at Full can set up a task that runs once, for a job like a backfill, from its own chat. It can give that one scheduled run up to 20 exact commands to run without asking, with no approval card, as long as that turn hasn't read words from outside your team. A run started with Run now goes without them. The agent is told to take the commands back afterwards, which also needs no card. Every change is recorded. (DOR-4315)
- Mini apps can now ask DorkOS to record something you did while signed in, and check it later. DorkOS keeps that record itself, outside the mini app's data, so a mini app can tell a comment you wrote from one an agent wrote. (DOR-4301)

### Changed

- Agents on Claude Code can make their own tasks safer: an agent at Full can move its own task that is on and runs every command without asking to Never ask, with the exact commands it needs, in one call and with no card, from its own chat, as long as that turn hasn't read words from outside your team. DorkOS checks each of those programs before every run. (DOR-4315)
- Agents are now told to run one command per call, with no `&&` chains and no inline `$VARS`, so Claude Code can check routine commands itself. (DOR-3109)
- When an agent edits a mini app it built, the new server code starts by itself only when DorkOS saw that agent's own Claude Code chat make the change with its file tools, at Full. Any other change waits for you to approve it. (DOR-4528)
- When you allow a different copy of a mini app, or new files for it, it starts with no rooms and no agents to forward to. Pick them again in Settings → Extensions. Allowing the same files again keeps your picks. (DOR-4573)
- When an app update asks for something new, its Inbox card now says so in the title: the app "was updated and wants more", and its screens stay paused until you look. An update that only changed files keeps the old title. (DOR-4531)
- A mini app's reads from an app that charges per use now count against your monthly spending limit, the same limit agents use, and its request and its page say "Spends money". An app counts as one that charges per use whatever capitals, spaces or separators its name uses, like "Perplexity AI" or "perplexity_ai". (DOR-4575)
- On a phone, the browser's top row is easier to use: Reload sits inside the right end of the address, the status button and the ⋯ menu sit side by side and each has its own space to tap, and the address keeps the same text size when you tap it. (DOR-4436)

### Fixed

- Paid actions in about 190 more connected apps now use your monthly limit and show the price card. They include Gemini, Mistral AI, GroqCloud, Cohere, Bright Data and HeyGen, plus apps for AI models, speech, text messages, scraping, search results, people data and email checks. Strale, Digital Humani, Memelord's renders and starting a song in Words Into Music count too. (DOR-4597, DOR-4624)
- More risky app actions now need to be picked for an agent one by one, and Read and write no longer covers them: (DOR-4505, DOR-4506, DOR-4507, DOR-4508, DOR-4509, DOR-4332, DOR-4624)
  - every change in PayPal Zettle, Moneybird, Creem, Longbridge, Skyfire, Strale, Ramp, Metronome, Polar, Gift Up and PostGrid, and in new money apps DorkOS recognizes by name, including new versions of ones it already knows;
  - running payroll or paying back expenses in any app, and a few single actions such as issuing a card, billing a customer, adding Elastic Email credits, changing a Gusto pay schedule, a Memelord Genjutsu job, or awarding Piggy credits;
  - actions that create or change OAuth apps;
  - creating a branch and merging a pull request in Bitbucket, and new merge, branch, tag or release actions in GitHub, GitLab, Gitea and Bitbucket; a GitLab commit that starts from another commit or project; and changing where GitLab reads a project's CI setup from;
  - an X upload that lets other accounts use your media, or an ad-only post that won't show on your timeline.

  Opening or editing a merge request, inline review comments, and ordinary X uploads and posts stay in Read and write.

- After you link your DorkOS account again, apps the recent Read and write update set back to Read stay on Read until you choose Read and write. (DOR-4510, DOR-4735)
- When a site blocks the Agent browser, your agent can now hand the site to you. A turn started by someone outside your team still can't hand the browser over; the agent is told to let you know instead. When the handoff is refused, your agent hears why. (DOR-4693)
- When you sign in from a blocked page with **Open sign-in window**, the agent's own window comes back at the page it was on once you finish. It never closes a window you're still using; it asks you to finish or close the sign-in window first. (DOR-4693)
- Ordinary pages no longer count as a site refusing the Agent browser. Only a real block page counts, such as Google's "Couldn't sign you in", a bot check or an access block. When a site does refuse, your agent now hands it to you right away. (DOR-4662)
- When a site's address is too long for the browser's address bar, the site's own name now always shows in full. The start of the address is shortened first, and on a narrow phone the name gets a little smaller or moves onto a second line, but it is never cut off. (DOR-4655)
- An agent on Claude Code or Codex in a room is now told the Agent browser works only in a direct chat with you, and to say so and ask you to continue there instead of waiting. (DOR-4733)
- Your agents no longer pass the "read words from outside your team" hold to each other when none of them read such words. Before, the hold could spread from agent to agent and refuse things it shouldn't, such as handing you the Agent browser, changing settings, or editing memory. A message from another agent no longer keeps your direct chat held after you reply. A chat that really did read outside words, a Telegram or Slack chat with a stranger in it, or a chat DorkOS can't place still counts as held. (DOR-4698)
- When more Claude Code chats are busy than DorkOS keeps running at once, work an agent started no longer takes the process of a chat that finished its turn less than two minutes ago, so busy chats stop restarting every turn and dropping their tools. That work waits for a free spot instead, and its chat says it is waiting to start. A message you send never waits for this. (DOR-4498)
- A room seat on Claude Code now recovers after a Claude server error, until DorkOS restarts. The new chat keeps the original account, model, folder access and permission limits. When a room chat stops, DorkOS says why and what to do next. (DOR-4328)
- When an agent in a room waits for you to approve an action such as a send through a connected app, the room now says so after a minute: who is waiting, where to answer, and that new messages for that agent wait with it. (DOR-4610)
- When one chat interrupts or stops another, the stopped chat now says which chat did it, and its agent is told no person stopped it. (DOR-4668)
- A chat that fails with "No message found with message.uuid" now works again on your next message, so if you see it, send your message again. (DOR-4590)
- Claude Code chats and schedules set to Ask first or Accept edits can now check which chats are running, read a schedule's past runs, see when each agent last worked, and read an agent's heartbeat without stopping for an approval. At those levels these reads leave out chat titles and run or beat summaries. A turn that read something from outside your team still has to ask first. (DOR-4601)
- A scheduled run that waits for a free agent no longer runs out of time before it starts. Its time limit now counts from when it starts, and while it waits, its run history says it is waiting to start. (DOR-4576)
- The card that asks you to approve a schedule now names the agent once, by its real name, and says the run permissions once. (DOR-4337, DOR-4572)
- Approval cards no longer cut their title short on a narrow screen. It wraps instead. (DOR-4355)
- When an agent's folder rules are too long to show in full on an approval card, your Inbox now says so and names the agent. The rules still never apply until you can read every one. (DOR-4455)
- The "signed out" notice on a Claude account now clears itself when a usage check finds the account working again, or when you sign in again from the command line. One failed sign-in no longer raises an alert right away: DorkOS waits 30 seconds first, and checks the account once more in that time. (DOR-4425, DOR-4424)
- When signing in to Claude Code or Codex from DorkOS doesn't work, it now says why and what to try next. (DOR-4426)
- If you turned on Ask for a password on this computer, the Mac app's tray and notifications were silent. Fixed. (DOR-4691)
- A mini app's status-bar item now draws at the same text size as the rest of the status bar, on a computer and on a phone. (DOR-4330)
- Approval cards for DorkOS actions, and your answers to them, now stay in a chat's history after a reload or restart. (DOR-4657)
- A DorkOS server started in test mode no longer reads your Mac's Keychain. (DOR-4423)
- Agents are told more about why something was refused or changed: a paid action that waits names the cost reason; blank chat titles in a running-chats list say why; an action that needs a one-by-one pick, or writes the update lowered to Read, say so and point to Connections; a refusal caused by a turn's mark says so; schedule rules and their 20-rule cap, which schedules can't run and who approved each; apps waiting for you; a Back or Forward press pausing the Agent browser; a refused browser profile; OpenCode helpers that are off; Codex project settings that didn't load; an OpenCode package check's reason; and the modes a runtime has. (DOR-4447, DOR-4678)

### Going back

0.137.0 adds three database changes: a one-shot task's own commands, the launch rules a room seat's chat needs, and DorkOS's own record of what a person did in a mini app. To go back, install 0.136.0. It ignores them and starts normally. Settings need no change.

- Before you go back, take the commands off any one-shot task, or delete it. 0.136.0 sees it as a task with no schedule and never runs it on its own, but a run you start by hand there takes its commands along unchecked. If you come back to 0.137.0, a one-shot task that never ran on 0.137.0 runs once.
- A task an agent moved to Never ask keeps its schedule and its commands. 0.136.0 doesn't check each program, or the agent's own level, before it runs.
- Reading mail, a web page or another app no longer marks the turn, so a send after it doesn't ask first. A task or agent you set as one that reads outside text loses that setting until you come back.
- The apps and actions this release added to the spending and one-by-one lists go back to how 0.136.0 treats them: Read and write covers them again, and their paid actions skip your monthly limit. Picks you made stay. A mini app's paid reads stop counting against your monthly limit.
- Don't link your DorkOS account again while on 0.136.0. There, it can give agents back changes the Read and write update set back to Read.
- Changes this release added to "Confirm it's you" go through without your password again. Cards waiting on those changes end.
- A mini app edit waiting for your OK stays waiting. But if its agent is at Full, the next change to that mini app's files starts it with no card, whoever made it.
- Mini apps can't check DorkOS's record of what you did. The record is kept and works again when you come back.
- A room chat DorkOS restarted after a Claude server error is no longer held to its first account and how it's paid for. Let room posts finish before you go back.
- Two new Inbox notices, about folder rules too long to show and a Remote Access confirmation refused after five wrong passwords, don't show. They may still count on the unread badge until you mark all as read.

## [0.136.0] - 2026-11-18

> DorkOS 0.136.0 helps with sites that refuse the Agent browser, such as a Google sign-in. Your agent is told to stop and hand the site to you, and you can sign in in a separate window. Agents can also message another agent's chat in a room privately.

### Note for people upgrading

- **Telegram or Slack chats you linked before this update keep asking before an agent passes your words on.** Start a new linked chat to stop the extra asks. (DOR-4593)
- **When an extension's folder has been deleted, DorkOS forgets its approval** the next time it starts or reloads extensions, and notes it in the audit log. Install it again and DorkOS asks again. Tools you set to Blocked or Ask stay that way. (DOR-4305)
- **Most DorkOS tools now refuse a setting they don't have, instead of ignoring it.** An agent or an outside MCP app that sends a misspelled or unknown setting to one of them now gets an error. (DOR-2067)
- **If you connect mail:** an agent with Read and write on a mail app can send mail without asking you. A message from someone else on Telegram, Slack, in a room or from a mini app makes that turn ask you first or refuse the send, but mail and web pages the agent reads don't count yet. Give a mail app Read unless you need your agents to send. A check before mail to someone new comes in a later release. (DOR-4446)
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now. (DOR-4453)
- Known issue: the Agent browser can take an ordinary page for a site's block page when the page's text says "press and hold" or "verify you are human", or its title is "Access denied". Your agent then stops and hands the page to you. Hand it back to carry on. We're fixing it (DOR-4662).
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- When you message an agent from your own linked Telegram or Slack chat, and it passes your ask to another agent, that agent no longer asks you before sending through a connected app. This works in linked chats you start after this update. A group chat, or someone not on the connection's Approvers list, still makes it ask, and so does any chat they ever wrote in. (DOR-4593)
- The tool for updating an agent's details now refuses any change to memory you set, and applies nothing else in that request. (DOR-3470)

### Added

- **Agents can message another agent's chat in a room privately.** A short notice in the room shows who messaged whom, without the message. Replies stay private. In a room linked to Telegram or Slack, an agent can answer a private message but can't start one. (DOR-4472)
- **The Agent browser's ⋯ menu can open a site in a separate sign-in window,** for example **Sign in to google.com in its own window**. It opens a plain browser window where you sign in yourself. (DOR-4097)

### Changed

- When a site refuses the Agent browser, such as Google's "Couldn't sign you in" page or a bot check from Cloudflare, Akamai and similar, your agent is told the site refused it, and to stop and hand the site to you instead of trying to get past it. When it hands the site to you, DorkOS offers **Open sign-in window**. (DOR-4097)
- In the Mac app, when a site won't let you sign in inside the app, a short note under the address says so, with **Open sign-in window**. After you sign in, **Open in its own window** carries on there. A sign-in there works when the Agent browser opens in its own window, not in the in-app view. For a bot check, the note offers **Open in its own window**. (DOR-4097)

### Fixed

- In the Mac app's Agent browser, every part of a site, background workers included, now sees a plain Chrome browser. This helps sites that refused to sign you in. (DOR-4650)
- Ask an agent whether it has browser profiles, and it now says the Agent browser has one default profile. Other browser tools you gave it, such as your own Chrome tools, are no longer called profiles. (DOR-4633)
- When an agent posted into a channel nobody had written in yet, from its direct chat or a task, the post never showed up, and the agent was told there was "nothing to answer". Now the post goes up, as it does in any other channel. The same fix lets a spin-off chat report back to an agent in an empty channel. (DOR-4619)
- **Switching chats right after you send no longer swaps them.** If you sent a message and quickly switched to another tab, that tab could turn into the chat you had just sent to. The same thing could pull you back after you clicked a different chat in the sidebar. Now the chat you switch to stays put. A new chat, a fork or an agent's chat that is still opening also stays out of your way if you have already moved on. (DOR-4622)
- A channel you move to another section of the sidebar now stays there, on desktop and phone.

### Going back

0.136.0 adds two database changes: a record of whose words each linked Telegram or Slack chat holds, and a route for private messages to room seats. To go back, install 0.135.13. It ignores them and starts normally. Settings need no change.

- Let private messages to room seats finish before you go back. One still waiting stays "queued" on its sender's card in 0.135.13.
- Agents can no longer message another agent's chat in a room privately. Room notices about earlier private messages stay in the room.
- When an agent passes on your words from your own linked Telegram or Slack chat, the agent it hands them to asks you first again.
- Approvals DorkOS dropped for extensions that were gone stay dropped. Installing one again asks you again.
- If you come back to 0.136.0 later, start new linked Telegram or Slack chats rather than reusing ones you began on 0.135.13.

## [0.135.13] - 2026-11-17

> DorkOS 0.135.13 adds a monthly spend limit for apps that charge per use, and makes a mini app's messages limit what an agent can do, like anyone else's. The Agent browser gets one ⋯ menu, a label that says who has the page, and the usual browser keys.

### Note for people upgrading

- **An agent's paid app actions now ask you first, at every level, Full included, even ones you picked for that agent.** This covers apps that charge per use, such as Apify, OpenAI, Twilio or Firecrawl, and GitHub Models calls. They run without asking only once you set a monthly limit and a price per run for that app. Set the limit in **Connections**, under **Spending**, and the price on the app's page. (DOR-4204)
- **A mini app's messages now limit the turn they start, like a message from someone else.** This also covers messages you write through a mini app, for now. (DOR-4587, DOR-4594)
- **If DorkOS can't read the version saved in your settings, it now stops and leaves the file unchanged.** It shows the file's path. Fix the `version` value in that file, or put back a saved copy, then restart DorkOS. If DorkOS names retired settings in your settings file, remove only those, then restart. (DOR-4341, DOR-4479)
- In the Agent browser, Disconnect is now called **Close browser**, in the new ⋯ menu. (DOR-4429)
- **If you connect mail:** an agent with Read and write on a mail app can send mail without asking you. A message from someone else on Telegram, Slack, in a room or from a mini app makes that turn ask you first or refuse the send, but mail and web pages the agent reads don't count yet. Give a mail app Read unless you need your agents to send. A check before mail to someone new comes in a later release. (DOR-4446)
- **Check your Approvers list.** DorkOS knows a Telegram or Slack message is from you only when your own ID is on that connection's **Approvers** list. If it isn't, your own messages count as someone else's, and your agent won't send through a connected app for you from there. Open **Connections**, open the chat app's settings, and add your ID under **Access Control**. If you can already message the bot privately, your ID is in the **DM Allowlist** right above it. This only helps in a private chat with the bot: in a group chat, every message counts as someone else's, yours too. (DOR-4453)
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now. (DOR-4453)
- If you run DorkOS from the command line, you can go back to the old behavior: set `DORKOS_MARK_STRANGER_TURNS=false` and restart. A mini app's messages still limit the turn either way. The Mac app has no setting for this yet. (DOR-4453)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- A mini app's reply in a room, a message it sends to one of your agents, and a chat it starts now limit the turn they start, like a message from someone else. In that turn, a send or delete through a connected app asks you first, and the agent can't raise its own access. (DOR-4587, DOR-4594)
- In a room, when an agent passes on words from someone else or from a mini app, the turn its post starts is limited too, even after DorkOS restarts. (DOR-4587)
- You can set a monthly limit on what agents spend through apps that charge per use. A paid action you picked for an agent runs without asking when you've set that app's price and the run fits the limit. At the limit, paid actions your agents run stop until you raise the limit or the month resets. (DOR-4204)
- Setting or raising the limit, and setting or lowering an app's price, asks you to confirm it's you. Only you can change them. Agents can't, and a device signed in over Wi-Fi can't either. (DOR-4204)
- A paid action never runs in a turn that read a message from someone else. When one waits on your yes, Telegram or Slack only tells you to answer in DorkOS. There's nothing to tap there. (DOR-4204)
- An agent can now change another agent's setup files, such as a hook or its settings, without you opening a terminal. You see the whole file on a card and say yes first, unless you set this one action to Allowed. It only writes inside that agent's `.claude` folder, and a turn that read a message from someone else can't use it. (DOR-4266)
- In a one-on-one chat, the canvas only shows files from the agent's own folder. An agent that tries to open another file there is told so by name, and that it can read the file and show you what's in it, or copy it into its folder. (DOR-3519)
- When a site you typed without https:// doesn't answer in time, the Agent browser says it didn't respond instead of trying plain http. When it does open a site over plain http, "Not secure" in the address bar says why, and the agent is told the page isn't secure. (DOR-4450)

### Added

- **Connections has a Spending section.** Set the monthly limit there, and see how much agents spent this month and which apps it went to. You get a notice when agents have used 80% of the limit, and another when they reach it. (DOR-4204)
- Actions that cost money say "Spends money", with a coins icon, in the app's action list and on its row in Connections. For an app that charges per use, you can set your best guess of what one run costs on its page. The limit counts each run at that price. (DOR-4204)
- When an agent's paid action needs your yes, the card shows what one run costs, or that the price is unknown, and how much is left this month, or that no limit is set. It has **Allow once** and **Don't allow**. Only you can allow it, and not from Wi-Fi. (DOR-4204)
- **Login & security shows when a remote tool last used each API key.** It counts tool (MCP) use from another device. Other API calls with the key aren't counted yet. (DOR-4206)
- **The Agent browser knows the usual browser keys.** ⌘L, ⌘R and ⌘⇧C work in the browser's bar, and inside the page in the Mac app. ⌘[ and ⌘] go back and forward, and Esc stops a load, from the browser's bar. Inside the page those keys stay the page's, as in Chrome. Esc in the browser never closes the side panel around it. The matching Windows and Linux keys work too. (DOR-4432)
- Reloading, stopping or typing an address in the Agent browser while an agent uses it takes the page for you in one step. The agent can't see or use the page until you hand it back. (DOR-4428)

### Changed

- **The Agent browser has a ⋯ menu at the end of its controls.** It lists the chat's pages, copies the address, opens the page in your own browser, forgets saved sign-ins and closes the browser. On a phone it opens as a sheet. The tab list and the Saved sign-ins row no longer sit above the page, so the page has more room. (DOR-4429)
- The browser on the canvas has the same ⋯ menu. For a web page it copies the address and opens the page in your own browser, and its notices use the same words: Open in your browser. (DOR-4435)
- The Agent browser shows who has the page in one small label beside the address: the agent, Paused, Your turn, You or Only you. Press it for Take over, Pause agent, Resume agent or Hand back. When an agent asks you to sign in or finish a step, the label turns orange and says Your turn. Press it to see the real site the page is on. (DOR-4428)
- When the Agent browser has no page to show, it says why in one short block in the middle of the panel, instead of a pile of notes at the top. A new empty page says "Type an address or a search above." With the browser closed, forgetting saved sign-ins is one small link. (DOR-4433)
- Before you approve a schedule, its card says where it will run: the agent's folder and its path, a private copy of the agent's project, DorkOS's default folder, or a fresh private folder for each run. (DOR-4067)
- A Claude Code schedule set to Never ask can now see which chats are running, read a schedule's past runs, see when each agent last worked, and read an agent's heartbeat. It sees no chat titles, run summaries or heartbeat summaries, and it can't use these in a turn that read a message from someone else. Everything else stays refused. (DOR-3971)

### Fixed

- When an agent is paused, your message stays in the box until you resume it and press Send. Messages from other chats leave it there. Held messages name the pause in the queue, in Activity and on the sender's receipt. (DOR-4348)
- An agent named "You" or "Your turn" shows in quotes in the Agent browser's label, so its name never reads like the label's own words. (DOR-4428)
- A mini app no longer loses the error reply when a request is too large. (DOR-4152)
- A Codex agent calls the page you share with it the Agent browser, like every other agent. The Agent browser guide uses the app's names, says when it uses your installed Google Chrome, and lists the versions this release pins. (DOR-3219)

### Going back

0.135.13 adds three database tables for the spend limit. To go back, install 0.135.12. It ignores them and starts normally. Settings need no change.

- There is no spend limit. A paid action you gave an agent runs without the paid-action card again, nothing counts what it spends, and the Spending section and "Spends money" marks are gone.
- Answer any waiting paid-action card before you go back.
- Spend-limit notices don't show in the 0.135.12 Inbox. The bell can still count them until you mark everything read.
- A mini app's messages no longer limit the turn they start.
- If 0.135.12 can't read the version saved in your settings, it saves a copy of the file and starts with default settings, keeping only your privacy and permission choices.
- If you come back to 0.135.13 later, the limit and prices you set are still there. Paid actions run while you were on 0.135.12 aren't counted in that month's total.

## [0.135.12] - 2026-11-16

> DorkOS 0.135.12 lets "Read and write" change things in every app connected through Composio, while deletes, sharing, money and other risky actions stay one-by-one picks. It also runs each app's screens in a frame of their own, limits what an agent can do when someone else writes in a chat, and wakes agents before their promises are due.

### Note for people upgrading

- **"Read and write" on an app drops to Read once.** It used to give only Read on every app except Gmail and Google Calendar. Now it can change things, so DorkOS lowers each saved "Read and write" on other apps connected through Composio to Read, one time, and shows a notice for each account. To let an agent change things there, open **Connections** and choose Read and write again. Gmail and Google Calendar keep their level, and actions you picked one by one stay as you chose. (DOR-4194, DOR-4461)
- **On Gmail, moving mail to trash now needs a one-by-one pick.** Read and write no longer covers it. To let an agent do it, open **Connections** and pick that action. (DOR-4194)
- **If you connect mail:** an agent with Read and write on a mail app can send mail without asking you. A message from someone else on Telegram, Slack or in a room makes that turn ask you first or refuse the send, but mail and web pages the agent reads, and replies a mini app posts in a room, don't count yet. Give a mail app Read unless you need your agents to send. A check before mail to someone new comes in a later release. (DOR-4446)
- **Apps built for an older version of DorkOS need a rebuild before their screens run again.** This includes apps other people made. Until then, the app shows that it needs an update, and its screens don't load. Its server part and its agent tools keep working. If you build apps, the [update guide](/docs/integrations/extension-frame-migration) lists the few changes: add `"clientApiVersion": 2` to the app's `extension.json`, and call your app's own server through `api.request` instead of `fetch`. Apps made by your agents from now on are built the new way. (DOR-3293)
- **If you use /flow:** the Flow app's screens show "Needs an update" until a Flow update comes out. It's on its way. Flow's tools and its background work keep working. (DOR-3293)
- **Check your Approvers list.** DorkOS knows a Telegram or Slack message is from you only when your own ID is on that connection's **Approvers** list. If it isn't, your own messages count as someone else's, and your agent won't send through a connected app for you from there. Open **Connections**, open the chat app's settings, and add your ID under **Access Control**. If you can already message the bot privately, your ID is in the **DM Allowlist** right above it. This only helps in a private chat with the bot: in a group chat, every message counts as someone else's, yours too. (DOR-4453)
- In a room bridged to Telegram or Slack, your own phone's posts still count as someone else's for now. (DOR-4453)
- If you run DorkOS from the command line, you can go back to the old behavior: set `DORKOS_MARK_STRANGER_TURNS=false` and restart. The Mac app has no setting for this yet. (DOR-4453)
- If a file you opened on a chat's canvas earlier still won't save, open it again. (DOR-4442)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in a later release (DOR-4422).
- Known issue: Codex won't start in a folder whose Git path has `* ? [ ] { }` in its name, like `site [old]`, or in a worktree whose Git folder is gone, at any level. Use another folder for now. We're fixing it (DOR-4542).

### Security

- **"Read and write" now lets an agent create and edit in every app connected through Composio that offers those actions**, like a Linear issue or a Notion page. These still need you to pick them one by one (DOR-4194, DOR-4270):
  - reaching more people or accounts: sharing, forwarding, webhooks, keys, adding users;
  - money: payments, ads, crypto and shopping apps;
  - things that can't be undone;
  - deletes, including moving to trash or archiving.
- In a repository, merging, creating branches, creating or changing a release, and writing CI or workflow files also need a one-by-one pick for that agent. (DOR-4194, DOR-4461)
- Asking a GitHub model for an answer can bill you, so Read and Read and write don't include it. It runs only for an agent you picked it for. Reading issues and listing models still work under Read. (DOR-4460)
- Each app's screens now run in a frame of their own. An app's screens can't see your sign-in or the rest of the DorkOS window, and reach DorkOS only through the actions DorkOS lets them use. (DOR-3293)
- A message from someone else on Telegram, Slack or in a room now limits what your agent can do in that turn, even at **Full**. A send through a connected app has to ask you first, and the agent can't raise a task above **Don't ask**. DorkOS can't ask you from a Telegram or Slack chat, so there the send is refused. (DOR-4453)
- In a room, a message from someone else marks the turn even when it only sits in what your agent reads, not just when it names your agent. (DOR-4453)
- An agent in a marked turn can't change a chat app's settings once it holds a saved password or key. A person has to. (DOR-4453)
- In a room bridged to a Telegram or Slack group, your agents no longer see the group's name: not in the room, the room lists, search, hand-offs, chat summaries, saved notes or the room's shared notes. They call the room "Bridged channel" until you rename the room in DorkOS. (DOR-4453)
- A bridged group's shared notes no longer start with the group's name. Notes made before this release are fixed the next time DorkOS starts and the notes have no unsaved changes. If you changed the heading yourself, it stays as you left it. (DOR-4453)
- A schedule an agent makes now runs in that agent's own folder, even when the agent asks for a "global" one or names no place. DorkOS refuses the schedule up front if that folder is the DorkOS data folder, or, below Full autonomy, your home folder. Schedules you make yourself work as before. (DOR-4067)
- When an agent proposes a schedule, the approval card shows what it asked to be allowed to do, and approving gives it exactly that, only for that schedule's runs. Giving it more than it asked for or had, letting it run programs, change files outside its folder or read files by a broad pattern each take a separate, clear choice. Rules for commands apply only to schedules that run on Claude Code. A test run before approval never runs looser than one click could approve. (DOR-3637)
- Each schedule now records who approved it, when, and where, and the approval card says so. The record clears when the schedule changes and waits for a new yes. Schedules that were on before this release carry a record too. (DOR-3641)
- Each kind of agent (Claude Code, Codex, OpenCode and the DorkOS runtime) now states which safety checks it enforces, and DorkOS treats one that states nothing as having none. Named browser profiles still work only on Claude Code, and other agents are told their runtime can't use them yet. (DOR-3596)
- Back and Forward in the Agent browser, and, in the Mac app, Go back on a page that didn't load, follow the same address rules as typing an address. A page you go back or forward to that now redirects somewhere refused is stopped before it loads. (DOR-4449)
- Below Full access, Codex can't change Git's own files, even in temporary folders. Saved sign-ins inside Git's own folders stay protected at every level. (DOR-4485)

### Added

- An agent is now woken to start a promise before it is due, not at the due time. It can say roughly how long the work takes and is woken a bit more than that before, and once more partway through. With no guess it is woken an hour before. This needs the agent's heartbeat on. (DOR-3034)
- When an agent moves or drops a promise it made to you, your Inbox tells you, with its reason. When it says it kept one, your Inbox asks you to confirm: **Yes** or **Not yet**. Not yet reopens it and wakes the agent. With no answer in a day, it shows "Kept · unconfirmed". (DOR-3034)
- An agent's Heartbeat page now says how many of its promises moved and how many it missed, under "Supporting measures". (DOR-3034)
- The Team page lists every schedule and heartbeat that is switched off or waiting, since when, and who can turn it back on. (DOR-3641)
- New agents, and agents DorkOS keeps in its own folder, now come with a guide to building a small app inside DorkOS, like an Activity card or a tab beside the chat. Agents set up in your own project folders before this release don't get it yet. (DOR-4061)
- Back and Forward work in the Agent browser. They follow the page's own history, and pressing one while an agent uses the page pauses the agent first. (DOR-4449)
- When you chat with an OpenCode agent in a project that has its own OpenCode plugins, tools or MCP servers, the chat says how many DorkOS kept off, once per chat.
- A Claude Code chat now shows the work its agent left running after it stops talking, like helpers, background commands and watchers, in the task strip above the message box. Each one shows its name and can be stopped. The status line says "background tasks" instead of "subagents", and agents see that work in the running chats list. (DOR-2065)

### Changed

- A message another agent sends to a busy chat now waits as its own row in the queue, with **Send now** and **Don't deliver**. When you don't deliver it, the other agent's chat says so by name. (DOR-3060)
- A to-do whose date moved says so under its title, with its first date. Moving a date after it has passed keeps the to-do late in the agent's on-time score, and a dropped to-do counts as not kept. (DOR-3034)
- A promise still open 15 minutes after its due time is marked missed then. (DOR-3034)
- The canvas browser and the Agent browser share one set of controls: Back, Forward, Reload and an address field that says "Not secure" for plain http pages. The address field reads what you type like a browser does: words become a DuckDuckGo search, `example.com` opens over https, and `localhost:3000` opens over plain http. (DOR-4427, DOR-4419)
- In the Mac app, when a page won't load in the Agent browser, DorkOS says why where the page would be, with one button to fix it, and the agent is told the same. A thin line shows while a page loads. There is no way past a certificate error. (DOR-4430, DOR-4431)
- In the desktop app, when a menu, notice or Settings opens over a web page in the browser panel, you see a picture of the page in its place instead of an empty box. The picture is never saved or sent. (DOR-4438)
- An app update's approval card lists each new thing it asks for, like a new website or program, instead of only saying its files changed. (DOR-4504)
- New schedules run in your time zone when you don't pick one, including ones your agents make, and each schedule shows when it runs in your time. A schedule set in another zone that runs overnight for you offers to move to your zone. (DOR-4120)

### Fixed

- The Connections page says when an app offers Read only, shows Read there even if you saved Read and write, and never changes your saved choice on its own. (DOR-4444)
- A Claude Code agent still working on a long task is no longer stopped after about four hours. Its turn now ends after 16 hours of nonstop work, and the message says why it ended. (DOR-2705)
- When a schedule fails twice in a row, the notice says why in plain words, and its card opens the schedule. A switched-off schedule, or failures from before its last change, no longer raise that card. (DOR-4121, DOR-4127)
- A file you open yourself on a chat's canvas can now be edited and saved, as long as it sits in that agent's folder. (DOR-4442)
- An account's usage percent no longer goes blank after a limit notice with no number. (DOR-3589)
- An agent on OpenCode can read the skills of a package you installed for all your projects, even in a scheduled run. The new access only lets it read that folder. (DOR-4386)
- In the desktop app, a web page in the browser panel no longer vanishes when a tooltip opens elsewhere, and dialogs show above it. (DOR-4417, DOR-4418)
- Rest the pointer on Back, Forward or Reload in the Agent browser and a label names the button. (DOR-4427)
- Project discovery and Git status work again in worktrees Codex creates, and scheduled tasks whose folders arrive together are picked up. (DOR-4486, DOR-4495)
- Room instructions no longer describe a posting limit that no longer exists, and agents are told how to check a handed-off room post when their chat can't receive replies. (DOR-3817)

### Going back

0.135.12 adds new columns to the database for schedules, to-dos and canvas documents, and two database rules that note when a schedule turns off. To go back, install 0.135.11. It ignores all of these and starts normally. Settings need no change.

- Notices about promises, and about access changing to Read, don't show in the 0.135.11 Inbox. The bell can still count them until you mark everything read.
- Access that 0.135.12 lowered to Read stays at Read. On 0.135.11, Read and write changes things only in Gmail and Google Calendar again.
- If you update to 0.135.12 again later, the one-time drop to Read doesn't run again. Every saved Read and write then lets agents change things in that app, including one you chose while on 0.135.11.
- Apps you didn't rebuild run their screens again, but no app's screens run in a frame of their own. An app rebuilt for 0.135.12 still loads, but its calls to `api.request` fail.
- A message from someone else on Telegram, Slack or in a room no longer limits what your agent can do, and your agents see bridged group names again. A shared notes heading DorkOS already changed to "Bridged channel" stays changed.
- Schedules run without the extra actions you approved for them, and agents are woken for promises at the due time again. A date moved while on 0.135.11 isn't recorded as a move.

## [0.135.11] - 2026-11-15

> DorkOS 0.135.11 keeps a project's own settings out of OpenCode chats, and out of Codex chats below Full, blocks a project's OpenCode plugins at the start of each turn, keeps anonymous data off until you answer, and lets an agent's chats claim a job so two never take the same one.

### Note for people upgrading

- **If you ran an OpenCode or Codex agent in a project you didn't write, update.**
- **OpenCode chats in DorkOS no longer read a project's own OpenCode settings**, in any project, your own included. That means its `opencode.json` and its `.opencode` folder, with the MCP servers, models, agents and skills set there. Put what you need in `~/.config/opencode`. The project's `AGENTS.md` still reaches the agent; a `CLAUDE.md` on its own no longer does.
- **An OpenCode chat in a folder with its own OpenCode plugins stops with a message**, even in your own project. DorkOS looks in every folder from the chat's folder up to the top of the disk, your home folder included. Move plugins you want to `~/.config/opencode`. A way to allow your own projects' plugins is coming. (DOR-4394)
- **Below Full, a Codex chat no longer uses a folder's own Codex settings or the MCP servers they name**, unless you trusted that folder in Codex. Chats on DorkOS credits never load them. (DOR-4408)
- Anonymous install, heartbeat and usage data now wait for your answer to the sharing question. If you saw the question but never answered it, they stop until you do. (DOR-4400)
- `dorkos telemetry enable errors` without `--channel` now changes nothing. Use `--channel errors`. (DOR-4414)
- A Codex, DorkOS runtime or OpenCode chat that had Plan, Auto or Never ask saved now runs in that runtime's most careful mode: Ask first on Codex and the DorkOS runtime, Default on OpenCode. (DOR-4411)
- Upgrade settings last used before 0.115 through version 0.115 first. DorkOS stops before changing older settings and explains the two steps. A settings file you wrote by hand still starts normally, unless it holds a setting only versions before 0.115 wrote: `sessionSecret`, a tunnel passcode setting, `telemetry.enabled`, or the onboarding steps `tasks` or `adapters`. Remove that setting and start again. (DOR-4188, DOR-4376)
- On Linux, Codex at Full access doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask first or Workspace write there for now. We're fixing it (DOR-3965).
- On a Mac, Codex chats can't delete or move folders (rm -r, rmdir, mv). We're fixing it (DOR-4358).
- Known issue: offline, OpenCode's first turn in a new folder can take about a minute. Online, the first turn waits about 10 seconds once. A fix is coming in the next release (DOR-4422).

### Security

- **A project's own OpenCode plugins are blocked at the start of each turn.** If the project has any, OpenCode doesn't run that turn, and the chat says "OpenCode can't run in this project. It has its own plugins." Your own plugins in `~/.config/opencode` keep working. More work to close this fully is tracked in DOR-4412. (DOR-4394)
- A project's own MCP servers don't load in OpenCode chats either. (DOR-4394)
- **DorkOS's check before an OpenCode agent runs a shell command, edits a file or fetches a page stays on, whatever the project's settings say.** If any agent the project defines would skip that check, that chat can't start helper agents. (DOR-4394)
- **A Codex chat loads a folder's own Codex settings only at Full on your own Codex sign-in, or when you trusted that folder in Codex.** When DorkOS loads them at Full, Activity says so, also when you open a chat in a subfolder of that repo. (DOR-4408, DOR-4410)
- DorkOS now lists, one time, every folder your own Codex settings trust in Activity, so you can review them in Codex. It never changes that file. (DOR-4410)
- When DorkOS hands a project's `AGENTS.md` or `CLAUDE.md` to an agent itself, as it does for OpenCode chats, it now reads only real files: a link is skipped. Past about 32,000 characters in all, the text is cut short with a note saying so, so it can't crowd out the agent's own instructions. (DOR-4405)
- When DorkOS starts, it asks Claude Code for the list of models. That check now loads only your own Claude settings, never the project settings of your default folder. (DOR-4409)
- **Setting a chat to a mode its runtime doesn't have is refused**, such as Plan on a Codex chat. The error lists the modes that runtime has. (DOR-4411)

### Added

- **An agent's chats can claim a job**, like a ticket or a pull request, so its other chats see it is taken. When an agent starts a new chat on a job another of its chats holds, DorkOS stops and names that chat, unless the agent says to start anyway. A claim ends when the chat lets it go, or after two hours without work. (DOR-4019)
- Shell commands agents run can now tell which DorkOS chat they're in, through `DORKOS_SESSION_ID`: on Claude Code (hooks too), Codex and OpenCode, and on the DorkOS runtime at Full autonomy. If OpenCode can't look up the chat, the command still runs without it. (DOR-4380)

### Fixed

- **Anonymous install, heartbeat and usage data stay off until you answer the sharing question**, even if your settings file says otherwise. Settings and `dorkos telemetry status` show them as off until you choose, and your first answer turns on only what you chose. (DOR-4400)
- `dorkos telemetry enable errors` without `--channel` now asks "Did you mean `--channel errors`?" and changes nothing. `--channel errors` still turns on crash reports alone. (DOR-4414)
- Pausing an agent just as another agent's message starts no longer loses that message. It goes back in line, waits while the agent is paused, and runs once when you resume it. The agent that sent it sees it as waiting, not failed. (DOR-4353)
- Codex chats get their DorkOS tools again when they start, open or resume. (DOR-3169)
- A Codex chat started without an agent now says "This chat has no DorkOS tools." A Codex chat that loses them partway through says so and tries to get them back with your next message, and DorkOS writes a warning to its log. (DOR-4385, DOR-4393, DOR-4384)
- A Codex agent is now told to use the DorkOS browser for websites, since Codex can't start its own browser on a Mac. (DOR-4357)
- Safety checks from installed packages, like Safety Hooks, now stop risky shell commands such as `git stash` and `pkill` for agents on OpenCode and the DorkOS runtime too, in every mode. They don't run on Codex yet, and the install screen and the runtime picker say so. (DOR-4379)
- In the Mac app, when an agent hands you its browser and the page stays in the Agent browser panel, the panel now says so above the page, for example "Your turn: Atlas can't see or use this window." The hand-off card in the chat shows the same strip, now with a hand icon. (DOR-3111)
- On OpenCode, which keeps only one skill per name, an installed package never replaces a skill of yours with the same name, whether yours is in the project or in your home folder. DorkOS leaves the package's skill out, says so on the install screen, and tells the agent which one it has. (DOR-4387, DOR-4392)

### Going back

0.135.11 adds one table to the database, for job claims. To go back, install 0.135.10; it ignores that table, and claims stop working there. Going back also undoes this release's OpenCode, Codex and sharing changes. OpenCode chats that were kept from starting helpers stay that way, and chats moved to their runtime's most careful mode stay in it.

Older releases (v0.1.0 – v0.135.10) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.135.10.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.135.10.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.141.0...HEAD
[0.141.0]: https://github.com/dork-labs/dorkos/compare/v0.140.1...v0.141.0
[0.140.1]: https://github.com/dork-labs/dorkos/compare/v0.140.0...v0.140.1
[0.140.0]: https://github.com/dork-labs/dorkos/compare/v0.139.0...v0.140.0
[0.139.0]: https://github.com/dork-labs/dorkos/compare/v0.138.0...v0.139.0
[0.138.0]: https://github.com/dork-labs/dorkos/compare/v0.137.0...v0.138.0
[0.137.0]: https://github.com/dork-labs/dorkos/compare/v0.136.0...v0.137.0
[0.136.0]: https://github.com/dork-labs/dorkos/compare/v0.135.13...v0.136.0
[0.135.13]: https://github.com/dork-labs/dorkos/compare/v0.135.12...v0.135.13
[0.135.12]: https://github.com/dork-labs/dorkos/compare/v0.135.11...v0.135.12
[0.135.11]: https://github.com/dork-labs/dorkos/compare/v0.135.10...v0.135.11

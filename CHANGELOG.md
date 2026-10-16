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

## [0.118.0] - 2026-10-16

> DorkOS 0.118.0 lets you drag files onto the message box in the desktop app again, lets you share a live browser page with your agent, shows whether each agent in a space is there, and makes space pages harder to attack.

### Added

- Share a live page with your agent inside DorkOS or in a new browser window. Pause the agent while you use the page. Separate browser choices keep their own saved sign-ins (DOR-2929).
- Spaces (experimental): a space's channel members list can now show whether each agent is there, as "Available" or "Offline since" a time. The DorkOS app that runs the agent tells the space. An agent shows no status, never "Offline", until its app reports it (DOR-2877)
- Show recorded save confirmation and safe retry for session file edits, and wait for the current save before removing the document.
- Spaces (experimental): while your computer is on, DorkOS tells each space your agents belong to that they are there. A space's member list in the app then shows each agent as "Available" or "Offline since" a time. Removing an agent from a space, or disconnecting the space, stops it. A space that does not track this yet gets nothing new, and shows no status (DOR-2878)

### Changed

- When an app can't be connected because its sign-in setup in DorkOS has a problem, the connect dialog now says so and drops the retry button. Before, it said the app "isn't available right now" and asked you to try again in a few minutes, which never helped.
- The "What should I call you?" card and the "What kind of work do you do?" card in the sidebar now show the DorkOS logo larger, on its own line at the top. The question and its explanation sit under it at full width, so they no longer squeeze into a narrow column.
- If you run your own space server or move a space between servers: exports from this release use a new format, version 3, that lists each agent as a member beside the people, and says which member wrote every message. This release still imports exports from older releases. An older release cannot import an export from this one; it says the export's version is not supported (DOR-2876)
- Space pages are harder to attack. A page now runs only the space server's own code, never code written into the page or loaded from another site. No other site can show a space page inside its own. A file opened straight from a space can't run anything (DOR-2957)

### Removed

- Replace the former hidden-browser setup with the two live-page choices. Existing custom browser tools and saved sign-ins stay available (DOR-2929).

### Fixed

- In the desktop app, dragging files onto the message box now attaches them, the same as the paperclip does. Before, the app quietly refused to read a dropped file, so nothing happened. (DOR-2870)

### Note for people upgrading

- If you run your own space server, take a backup before you upgrade. This release makes a one-way change to the space's database when it starts. Nothing changes for the people and agents using the space. Earlier releases do not check for this change and will start on the upgraded database anyway, so never start one on it: going back means restoring the backup (DOR-2876)

## [0.117.0] - 2026-10-15

> DorkOS 0.117.0 shares the apps you connect with every agent on Trusted, holds an agent's irreversible action in a connected app for 60 seconds so anyone can cancel it, and fixes Gmail sends, turning on login and long chats.

### Added

- On Trusted, when an agent working on its own takes an action in a connected app that can't be taken back, like deleting or sending an email, DorkOS holds it for 60 seconds first. Every open DorkOS window shows a notification in the Inbox with **Cancel**, and your phone gets one too if you turned phone alerts on. Clicking the alert opens the Inbox right on it (DOR-2739)
- Anyone can cancel a waiting action, a person or another agent, except the agent that asked. A cancelled action never runs, and the agent is told who cancelled it. Stopping the chat cancels it too. If DorkOS restarts while it waits, it is dropped and never runs; if it restarts just as the action is sent, the notification says it may have run and which app to check (DOR-2739)
- If nobody cancels, DorkOS checks once more that it still may run without asking, then runs it exactly as asked, on the same account, and a second notification says it ran. If the notification can't be shown or the action can't be recorded, you get an approval card instead. This is a cancel, not an undo. On Careful, in a chat that asks first, or when someone outside your team started the chat, you still get an approval card (DOR-2739)

### Changed

- On Trusted, an app you connect is shared with every agent right away, including agents you add later, at **Read and write**, or **Read** where that is all the app offers. Pick **Only agents you pick** in **Who can use it?** to narrow it. Deleting things still needs you to allow it one action at a time, and on Careful nobody can use a new app until you choose (DOR-2739)
- The first time DorkOS starts on Trusted after this update, each connected app no agent could use yet is shared with every agent the same way, once. An app you had already given to some agents stays exactly as it was (DOR-2739)
- The one-time "Agents now work without asking" note lists the apps it shared, each with **Choose agents**, which opens that app's **Who can use it?** so you can pick agents one by one. If you had already dismissed the note, it shows once more to name them (DOR-2739)

### Fixed

- Connecting a service that signs in with a key, such as PostHog or 1Password, failed with "isn't available right now", every time. It now asks for your key and connects. Monday could not be connected at all; it now signs in like other apps.
- Spaces (experimental): in a channel with slow mode, the wait shown after a held post now starts at the time the space gave, not one second more.
- Turn on **Require login** when this computer already has an owner, and DorkOS now asks for that owner's password instead of a create-account form that could only fail. A wrong password leaves login off, so you can't lock yourself out. Forgot it? The dialog shows the command that resets it (DOR-2964)
- Stop showing your email as your name. New accounts no longer save the email as the name, and an older account whose name is just its email lets DorkOS ask what to call you (DOR-2964)
- Stop pointing to Settings › Login & security to change your email. Nothing there changes it, so the Profile hint now says so (DOR-2964)
- Keep a previous document’s save result from changing the document you open next.
- Save the latest buffered draft when you close a document editor.
- Fix Claude Code agents failing to update widgets they are allowed to change.
- Keep overlapping editor saves from silently replacing a newer file version.
- Agents can send email and save drafts through a connected Gmail account again when there is no attachment. Before, any action that could take a file was refused, even when no file was sent.
- When an agent asks to use an app you already have an account for, its request card now lets you connect a different account too. Before, the card only offered your existing accounts, so an agent that needed its own mailbox could only be told "Not now".
- Chats on a model with a one-million-token memory, like Opus 5.5 (1M) or Sonnet 5, showed a 200k limit. The context meter now shows the real size. Agents in those chats are no longer told their conversation is nearly full, or nudged to summarize it, at a fifth of the real limit.
- When a message arrived in a chat while an approval was waiting, the "waiting on you" card could stay up after you answered. Its buttons did nothing and the message box stayed hidden until the agent finished. The card now clears as soon as you answer.

## [0.116.0] - 2026-10-15

> DorkOS 0.116.0 lets you open DorkOS on your phone or tablet over your Wi-Fi, keeps the side panel focused, and lets mini apps your agent builds use Hono with nothing installed.

### Added

- On a Mac, open DorkOS on your phone or tablet over your home or office Wi-Fi, with no tunnel. Turn on **Let devices on my Wi-Fi in** in Settings → Remote access, then scan the QR code it shows.
- The switch takes effect right away, with no restart, and turning it off shuts the door at once.
- It needs a login. If login is off, DorkOS walks you through creating your account first, and turning login off later turns Wi-Fi access off too.
- Only devices on the same network as your computer get in.
- The connection between your devices is not encrypted yet, so use it on a network you trust.
- Watch the experimental agent computer beside its chat or in picture-in-picture while switching chats. Moving or closing its view keeps the computer running and returns control. (DOR-2916)
- An extension's server half can now use Hono with nothing installed. `import { Hono } from 'hono'` used to fail to build for an extension your agent made.
- A fetch handler now knows whether a person sent the request. Put `requirePerson()` in front of a route to keep agents and other websites out of it, or call `checkPerson()` in a handler written without Hono.

### Changed

- Keep the right panel focused on relevant views. Add pages, documents and shells from the + menu. (DOR-2916)
- Close a resource view without stopping its work. Remove shared documents or stop shells through separate menu actions. (DOR-2916)
- Use larger controls on phones. Panels stay usable when the keyboard opens. (DOR-2916)
- A fetch handler's reply can no longer set cookies, run scripts in a page it serves, or redirect to another website. This is the same rule extensions that run in their own process already followed. A redirect to one of its own paths, like `/done`, now lands inside the extension.

### Fixed

- An extension's server half now starts when DorkOS's data folder sits inside a project set up for modern JavaScript modules. Before, it could stop at startup with "module is not defined".

## [0.115.0] - 2026-10-15

> DorkOS 0.115.0 lets your agents work without asking first, opens long chats on their newest messages, and keeps your computer awake while background helpers work.

### Added

- The Terms for DorkOS Cloud are now on the website at dorkos.ai/cloud/terms. They cover the paid services: who can use them, refunds, and what happens if something goes wrong. The pricing page, the site footer and the main Terms of Service link to them.

### Changed

- Agents now work on their own. A new install starts on **Trusted**: every area is Allowed except Safety limits and Reach & secrets, which still ask, and a chat edits files and runs commands without stopping to check with you. **Careful**, for anyone who would rather approve things by hand, is the other choice. Updating an existing install moves you to Trusted once and shows a one-time note, "Agents now work without asking," unless you had already chosen Careful or told DorkOS to keep asking you (DOR-2739)
- Removing a package, deleting a scheduled task, and removing an agent now run and land in your activity feed on Trusted, instead of waiting for a card. Changing an agent's safety boundaries or what it runs on, and running a package from a folder, still always ask (DOR-2739)
- On Trusted, your agents can message each other across projects by default. DorkOS turns this on once, the first time it starts; turning it off in Team → Access keeps it off from then on. A Careful install is left as it was (DOR-2739)
- A schedule one of your agents proposes for itself starts running right away on Trusted, with a notification and a **Pause** button, instead of waiting for your approval. On Careful it still waits (DOR-2739)
- A mini app your agent builds for you with `create_extension` turns on by itself on Trusted, bound to the exact folder and the permissions it asked for at the time. On Careful it still waits for you (DOR-2739)
- On Trusted, your agents can change permissions too, and each change lands in the history with the agent's name. To keep a setting no agent can undo, set the Permissions area itself to Ask or Blocked. Installing or updating a package still asks, on any preset (DOR-2739)
- A tool or script DorkOS can't place as one of your agents, and an agent whose turn someone outside your team started, still have to ask before an action with no undo or any change to permissions, on any preset (DOR-2739)
- A new Telegram or Slack connection now lets its agent start conversations by default on Trusted (DOR-2739)
- Every page of DorkOS starts with a smaller download. Settings and Scheduled tasks now load when you first open them instead of with the app, which trims about 7% off what each page downloads first. They are fetched quietly once the app is idle, so they usually still open at once.
- A long chat now opens on its newest 150 messages, so it shows up fast however long it is. Press **Earlier messages** at the top to read older ones, 100 at a time. A link to an older message, from search or another chat, reads back until it finds it, up to about 2,000 messages back. The "New messages" line still lands in the right place.

### Fixed

- Agents can build extensions again. In a chat they only had the extension guide, not the tools to create, test or reload one, so asking an agent for a mini app went nowhere.
- When DorkOS Cloud had a brief outage just as your credits token was due to renew, DorkOS stopped trying. Your next chat on credits then had to wait for a new token, or failed. Now DorkOS keeps trying, waiting a little longer each time.
- Sorting the Tasks list by **Last run** now puts the task that ran most recently first. It used to sort by when each task was last edited instead. Tasks that never ran go last.
- Your computer now stays awake while an agent's background helper is still working, and while the agent writes up what the helper found. Before, it could fall asleep as soon as the agent said "I'll report back". Other background work, like a server left running, keeps it awake for at most 20 minutes.
- Your computer now stays awake for 3 minutes after the last piece of work ends, up from 30 seconds, so it no longer dozes off in the gap between one reply and the next.
- If your computer refuses to stay awake, DorkOS now tries again on its own, and switching the Sleep setting off and on tries again right away. Before, the switch was greyed out until you restarted DorkOS.
- The Sleep setting now says plainly that closing the lid usually still puts the computer to sleep, and that the screen still locks.

### Note for people upgrading

- If you see the "Agents now work without asking" note, **Got it** keeps your agents working the new way; **Keep asking me** switches you to Careful and keeps anything you set to Blocked, so your agents keep asking first. Either answer, the note shows once and does not come back (DOR-2739)

## [0.114.1] - 2026-10-14

> DorkOS 0.114.1 keeps the app quick and light while your agents work. Chats open and switch without waiting, coming back to the tab is quiet, and DorkOS does far less busywork in the background.

### Added

- If you turn on feature-usage data, DorkOS now also says when you finish or skip setup, and once a day that it is running. Both are off until you turn that channel on, like every other event, and stop the moment you turn it off.
- An install command copied from dorkos.ai can now end with a short install tag, like `--ref=k3j4mnb8x2qa.hn`. It is a random code made for that one copy, plus the campaign tag of the link you came from. DorkOS keeps it on your computer and sends it only with the "finished setup" event, only when feature-usage data is on. The tag is only a label on two events; it never links the app to a website visitor or an account. The website adds a tag only for visitors who allow analytics cookies and do not send Do Not Track or Global Privacy Control. The privacy and telemetry pages say exactly what it holds.

### Changed

- Opening a chat you have already seen in the sidebar now shows it straight away, instead of waiting for the server to answer first. DorkOS still checks with the server in the background, and tells you if the chat is gone.
- When you click an agent, its row lights up at once, even while DorkOS is still finding out which chat to open. After your computer wakes from sleep, clicking an agent no longer waits for a fresh list either.
- Switching back to the DorkOS tab no longer asks the server again for every list and badge on screen, so coming back is quiet and fast. Live updates keep most of them current. If the tab was hidden for more than half a minute, DorkOS catches up once when you return. Things that change outside DorkOS, like your files, still refresh when you come back.
- DorkOS asks the server far less often while you just look at the screen. The relay activity list, agent health and your community spaces follow live updates instead of re-asking every few seconds. Most changes show right away. A few can take up to a minute, like a chat app quietly losing its connection.
- Going back to a chat you opened recently no longer downloads its whole history again; it shows what the app already has. When the agent finishes a reply, DorkOS fetches only that last exchange instead of the entire chat, so long chats stay quick turn after turn.
- A long chat stays smooth while the agent is replying. Before, every new word redrew every message on screen and rebuilt the whole history. Now only the reply being written redraws, and the history is prepared once.
- Replies stream more smoothly in very long chats. Each new word used to rearrange every message in the chat; now only the newest messages are rearranged, about 15 times less work in a 3,000-message chat.

### Fixed

- Long chats open fast. DorkOS used to read a chat's whole history from disk every time you opened it, and after every reply. A very long chat could freeze the whole app for a moment each time and use hundreds of megabytes of memory. Now DorkOS remembers what it already read and only reads what is new (DOR-2889)
- DorkOS uses less memory the longer it runs. Every Codex, OpenCode or Doe chat you opened stayed in memory until DorkOS restarted. Now a chat nobody has used for 10 to 20 minutes lets go of that memory, and comes back as normal when you open it again. Each chat's replay buffer is also half the size it was (DOR-2897)
- DorkOS answers a little faster everywhere. It used to read and check your whole settings file from disk every time it looked up a setting, several times for every request. Now it keeps the last copy in memory and reads the file again only when it changed, including when you edit it by hand or with `dorkos config set` (DOR-2898)
- DorkOS does less busywork in the background. Every five minutes it checked all your scheduled tasks against their files, and rewrote every one of them and reset its timer, even when nothing had changed. Now it only touches a task whose file changed, or whose timer had gone missing (DOR-2899)
- DorkOS no longer rewrites its agent list and message rules every five minutes for nothing. Its regular check of your agents rewrote each agent's record and saved the message rules file about 30 times in a row, even when nothing had changed. Each save also made DorkOS reload that file. Now it writes only when something actually changed (DOR-2900)
- DorkOS's log files stay a sensible size while it runs. A log file used to be split by size and day only when DorkOS started, so a server that stayed up wrote one file without limit; one reached 53 MB. DorkOS now keeps the last 14 days of logs, up to 200 MB in all, and each log line is about eight times cheaper to write (DOR-2902)
- DorkOS no longer pauses for a moment once a day while it saves its daily backup of your data. It now copies the database a little at a time and keeps answering in between (DOR-2906)
- When DorkOS Cloud is down or doesn't recognize your computer, DorkOS now waits longer between tries, up to 5 minutes for new events and 30 minutes for credits, instead of asking every 30 or 60 seconds for hours and filling the log with the same warning. It goes back to asking often as soon as a try works or you link again (DOR-2903)
- Building the message search index is lighter on DorkOS. It no longer lists the thousands of helper-agent transcripts it never indexes, and it saves a very long chat to the index a piece at a time instead of all at once. If DorkOS stops partway through a long chat, it carries on from where it got to (DOR-2904)
- On macOS, DorkOS no longer keeps a file open for every chat on your computer just to notice when one changes. It held hundreds open at once, which could run into the system's limit on open files. Now it watches the folders instead, and checks once a minute for any change it missed (DOR-2907)
- Stop the experimental Agent computer when you quit the desktop app, keeping its saved files.

save also made DorkOS reload that file. Now it writes only when something actually changed (DOR-2900)

- DorkOS's log files stay a sensible size while it runs. A log file used to be split by size and day only when DorkOS started, so a server that stayed up wrote one file without limit; one reached 53 MB. DorkOS now keeps the last 14 days of logs, up to 200 MB in all, and each log line is about eight times cheaper to write (DOR-2902)
- DorkOS no longer pauses for a moment once a day while it saves its daily backup of your data. It now copies the database a little at a time and keeps answering in between (DOR-2906)
- When DorkOS Cloud is down or doesn't recognize your computer, DorkOS now waits longer between tries, up to 5 minutes for new events and 30 minutes for credits, instead of asking every 30 or 60 seconds for hours and filling the log with the same warning. It goes back to asking often as soon as a try works or you link again (DOR-2903)
- Building the message search index is lighter on DorkOS. It no longer lists the thousands of helper-agent transcripts it never indexes, and it saves a very long chat to the index a piece at a time instead of all at once. If DorkOS stops partway through a long chat, it carries on from where it got to (DOR-2904)
- On macOS, DorkOS no longer keeps a file open for every chat on your computer just to notice when one changes. It held hundreds open at once, which could run into the system's limit on open files. Now it watches the folders instead, and checks once a minute for any change it missed (DOR-2907)
- Stop the experimental Agent computer when you quit the desktop app, keeping its saved files.

## [0.114.0] - 2026-10-13

> DorkOS 0.114.0 makes the app fast again when your agents are busy: switching agents and tabs no longer freezes, and messages send without timing out. Mini apps can now show only where you choose, and agents work without the old posting limits, while turns started by strangers stay limited.

### Added

- Choose where a mini app's right-panel tab shows: everywhere, or only beside the agents, channels and pages you pick. Set it in Settings → Extensions under **Panel tab shows** (DOR-2867)
- Hide a mini app's tab in a channel, in chats with one agent, or on one page with **Hide here** in the panel's **⋯** menu, and bring a hidden one back with **Show here** (DOR-2867)
- Open a mini app's full page straight from its panel tab, with **Open full page** in the same menu (DOR-2867)
- Mini apps can say where their tab belongs by default with `showIn`, and agents can set where a tab shows for you (DOR-2867)
- Reach your mini apps' pages (the app calls them extensions) from the new Add-ons section at the bottom of the sidebar. Each page shows its own name and icon, and the one you are on is marked. It stays there when you open a space. On a phone it is in the All tab (DOR-2868)
- A `DORKOS_CLOUD_API_URL` setting, to send only those requests somewhere else
- The website now counts desktop app downloads, including ones from links on other sites. Each count carries a random one-time ID, no cookie and not your IP address, and none is made when your browser asks not to be tracked. The privacy page says so.
- Try a separate Linux desktop through the **Agent computer** experiment on Apple Silicon Macs. Turn it on in **Settings → Experiments**, then open **Team**. View the desktop, take control, and stop it without losing its saved files. The experiment is off by default; live account sign-in and agent replies are not yet confirmed.
- After your first run sets up an AI, the sidebar offers to join the DorkOS community, right after it asks your name and your work. Join opens the join form with the address filled in, and Not now hides it for good. It appears only once the community space exists (DOR-2873)
- The person running a Community server can open sign-up only to people who live in certain countries, with `COMMUNITY_ALLOWED_COUNTRIES` (for example `US`). Everyone who creates an account then ticks a box that says "I live in the United States" first, whether they sign up with a password, Google, GitHub, or single sign-on, or join an open space. People who already have an account are never asked. A server behind a proxy that adds each visitor's country can also set `COMMUNITY_COUNTRY_HEADER`, so a sign-up from a country outside the list is turned away. Leave both unset and nothing changes (DOR-2847)

### Changed

- Agents now have the same freedom as people in rooms and notes. An agent can post as many messages in one turn as it needs, change a room's canvas more than three times in one turn, react more than 20 times an hour and send you more than 10 notes an hour. Agents are still asked to keep it short, and everything they post stays in the room for you to read. The safeguards that stop agents replying to each other forever are unchanged (DOR-2739)
- The `rooms.maxPostsPerTurn` and `rooms.maxCanvasOpsPerTurn` settings are gone. Upgrading removes them from your config file (DOR-2739)
- The "Running unattended at full power" banner is gone, and so is the Control Center line that said the same thing. Full power is the normal way agents work now (DOR-2739)
- Saving a task or approving a schedule at Full autonomy no longer opens a confirmation first. Setting a Telegram or Slack connection to Full autonomy still asks, because strangers can message that chat (DOR-2739)
- `dorkos task create` no longer prints a "Runs at full power" line (DOR-2739)
- When someone outside your team starts a turn, for example with a Telegram or Slack message, that turn can post at most three messages in rooms and send you at most three notes. Your own agents' turns are never counted. A Codex or OpenCode agent posting into a room other than the one it is answering is not counted yet (DOR-2739)

### Removed

- The Add-ons list in the phone's You tab is gone. Find those pages under Add-ons in the All tab instead (DOR-2868)

### Fixed

- On a fresh install, requests for DorkOS credits, your balance and your plan now go to the DorkOS Cloud service. They went to the dorkos.ai website, which can't answer them, so every one failed (DOR-2673)
- A brand-new install no longer says "While you were away" a few seconds after setup. Your first daily summary arrives the morning after you set DorkOS up.
- On your first day, the sidebar shows one "Getting started" list instead of two. The card at the bottom waits until the list at the top is done, and the questions about your name and your work still get asked meanwhile.
- Your first chat with DorkBot is listed under DorkBot's name, not "Session". A chat with no known agent now says "Chat".
- One unfinished upload no longer keeps a deleted space stuck "deleting" for good. The server now waits at most a day for such an upload, then finishes removing the space.
- A space server's log now says when a space is more than two days past its deletion date and still not gone.
- One chat the app can't read no longer empties your recent chats list. That one chat is left out, and the rest of the list shows as usual.
- When a space holds your message (you're muted, slow mode is on, or you haven't accepted the rules yet) and you send it again, its files are no longer uploaded a second time. The files you already uploaded go with it. This works in the DorkOS app and on the space's web page, even if you edit the message first.
- A Codex or OpenCode chat started in an agent's folder now answers. Before, every message failed with "couldn't confirm this chat can use connected apps", and trying again never helped. When a chat has no recorded agent, it runs without connected apps instead.
- While a space is on hold, you can now accept its rules from the DorkOS app, just as you already could on the space's web page. Accepting the rules changes nothing anyone else sees, so a hold doesn't stop it.
- DorkOS no longer slows to a crawl while your agents are working. When any chat changed, every open window asked again for every agent's chats, and those requests piled up until switching tabs or agents took seconds and messages failed to send. The app now asks at most once every few seconds, asks that arrive together share one answer, and a new chat still shows up in your recent chats right away.
- If someone asks to take over a space you own, DorkOS now tells you even while spaces are switched off. It checks in the background about once an hour.
- DorkOS no longer slows down or freezes when you have a lot of Codex history. Switching agents and tabs stays quick, and messages send without timing out.
- Opening a chat no longer searches every Claude project folder on your computer each time. DorkOS remembers where each chat lives after the first look, and checks the folder you opened it from first. On a computer with many projects and several Claude accounts, this saves a noticeable pause on every chat you open (DOR-2892)
- The app stays quick while your agents work. Each time an agent wrote to a chat, DorkOS re-read that project's chats and rebuilt your Recent list from scratch, over and over. Now a chat that is being written to updates its row every few seconds, and the Recent list is rebuilt only when a chat is added or removed. A chat that an agent writes to without pausing now keeps its row up to date, instead of freezing until the agent stops (DOR-2893)
- DorkOS no longer reads through your chats every five minutes for nothing. A background check listed all of them to clean up the canvas of deleted chats, even when no chat had been deleted. Now it only looks when there is something to clean up (DOR-2905)

## [0.111.0] - 2026-10-12

> DorkOS 0.111.0 fixes who gets credit for a room post: a post from a chat an agent started is now stamped with that agent, never with you. A chat can also be set to never ask, and agents can find the right app for a job.

### Added

- A Claude Code chat can now be set to **Never ask**. Turn it on under **Ask first** on the chat's trust dial. The agent runs only what you have already allowed, and refuses everything else instead of stopping to ask you. It never gets to do more than **Ask first** lets it. Only you can turn it on: no DorkOS tool lets an agent switch a chat to it, and a chat set to it cannot start another chat that would ask you. Codex and OpenCode chats don't offer it
- An agent can now describe a job in plain words, such as "summarise my inbox", and get back a short list of apps that could do it, with the ways to connect each one (DOR-2854)
- When an agent looks up an app, it can now see whether you have already given it an account there. When it looks up a marketplace package, it can see whether that package is already installed for it. If DorkOS can't tell, the agent is told that instead of being told no (DOR-2854)

### Changed

- Agents are now told to mention a connection or a DorkOS package when it would clearly make a task go better and you do not have it yet: what it is, why it would help, and that you decide on the Connections or Marketplace page (DOR-2852)
- They are told to mention it only once, to leave it out when it would change nothing for the task, and in a shared room to bring it up only if someone asked
- The top Autonomy level is now called Self-starter instead of Rogue. A Self-starter agent takes the next step in its job before you ask, but still waits for your yes on things that need one
- The two top Chaos levels are now called Bold and Daredevil instead of Reckless and YOLO. Both still move fast on their own work, but neither force pushes, drops tables, deletes what it didn't make, or skips the checks that protect your data
- Every Autonomy level now has clearer instructions, including the default. No level can make an agent skip asking first anymore. A lower level only makes it check in more. Your saved slider positions stay the same

### Fixed

- In a chat that answers for an agent in a channel, a message another agent or person posted in that channel now shows their name and face, with the channel it came from. Before, it looked like you wrote it
- Your own channel posts in that chat still show as yours, with the channel beside them

### Security

- Room posts from a chat an agent started are now stamped with that agent, never with you. Before, a chat an agent started in a folder of its own saved its channel posts under your name, so they could look like your approval
- A chat with no agent behind it can no longer post, react or act in channels as you. It is refused instead

## [0.110.0] - 2026-10-12

> DorkOS 0.110.0 gives a new DorkOS a simple start: one screen, a short way to connect your own AI, and a first job from DorkBot in #team. Connecting an app like Gmail now shows both ways in, and messages between chats start the moment a chat is free.

### Added

- Extension authors can now serve an extension's own API with a fetch handler: a function that takes a standard web request and returns a response. Any handler of that shape, such as a Hono app, works as it is. It runs inside DorkOS on Node, so code that needs Bun or Deno's own features does not. The Express router still works, and both can be used together
- People who run a Community server can now give one of its reserved web addresses, such as `official`, to a new space of their own. It takes a key made for that one job and a written reason, and the server keeps a record of who gave the address out and why. Everyone else is still refused every reserved address, and addresses that are pages of the server can never be given out. See "Giving a reserved web address to a community" in the server's operations guide

### Changed

- Every agent now follows the same rules for when to act and when to ask first. It does routine work and anything you asked for without checking in, and tells you what it did
- Before an agent sends something people outside your team will see, spends money or deletes things, it asks first unless you asked or it is its job. Promises to customers, signing up for things, spending past its limit and giving someone new access always need a yes from you or the agent's manager
- When an agent gets stuck on something only you can do, like a sign-in, it no longer just says it can't. It does every step it can, asks DorkOS for the access, suggests one way forward, and finishes once you choose
- These rules apply even when an agent's DorkOS knowledge setting is off, and in chats that are not tied to an agent
- A new DorkOS starts with one screen. **Use my own AI** lists every way in, one row each: an OpenAI, Anthropic or OpenRouter key, an AI app you already sign in to, or any other service. Paste a key and DorkOS picks the model. A model on your own computer is listed too, but it can't reach a first reply yet (DOR-2783)
- **Continue with DorkOS** is on the same screen and signs you in with the code already filled in. Finishing that path with a card still waits on DorkOS Cloud, so for now use **Use my own AI** (DOR-2783)
- Every path ends in #team, where DorkBot says hello and offers a first job: **Build me a tracker for my customers**, **Make a daily plan board**, or **Something else**. One press, and DorkBot starts on it. Skipped the account? The same spot opens the two ways to connect AI in Settings instead (DOR-2783)

### Removed

- The old first run is gone: the setup scan, the power-level step and the scripted chat with DorkBot. Set your name and the kind of work you do in Settings › Profile. Full power is still offered the first time an agent needs it (DOR-2783)

### Fixed

- The first time you connect an app like Gmail, DorkOS now offers both ways in: use a DorkOS account (sign in or create one), or paste your own Composio key. Before, someone without a DorkOS account saw only the key and could get stuck
- If your DorkOS account is linked but can't connect apps right now, you can now link it again from that same step, or use your own key instead
- When you ask an agent to connect an app like Gmail and DorkOS can't reach it yet, the agent now tells you your choices right away: sign in to a DorkOS account (or create one), or use your own Composio key. It asks which you want and helps you do it. Before, it waited quietly while you were left to work it out alone
- When an agent asks you for access to a service, it now looks up that service's exact name first, so the request names the right app. Agents are also told that signing in to a service's command-line tool gives DorkOS no access (DOR-2236)
- A message one chat sends another now starts as soon as that chat is free. Before, if the chat had finished its turn but was still wrapping up background work, the message could sit in its queue for up to five minutes after the work ended, even after an interrupt
- A chat sending a second message to a busy chat now hears "queued" at once. Before, after a long wait, it could be held for up to five minutes before it heard back
- A chat started from a room conversation is now told to report in the room. Before, it was told to message a chat that cannot take messages, and every try was refused
- In a direct message that still lists a removed agent, the other agents are now told it is retired and will not reply, so they stop waiting on it. The app already showed it that way
- A chat that hit an error in its very first moments could send two "stopped on an error" phone pings, or one after it had already recovered. It now sends at most one, and none once the error clears
- A connection you just added no longer vanishes for a moment if DorkOS reloads its connection settings at the same time. Before, removing or editing it right away said it could not be found
- A connection you remove stays removed. Before, a reload at the same moment could start it again and leave it answering messages, even though the app no longer listed it
- Removing a connection can no longer remove a different one when the connection settings reload at the same moment
- Two changes saved close together are now written in order, so an older save can no longer overwrite a newer one
- Turning off or reloading an extension now stops every repeating task it started, including ones it started after it finished loading. Before, those kept running, so after a reload the old copy's tasks could run beside the new one's
- Turning on a room's files, or keeping changes made outside DorkOS, no longer fails when your profile name is made only of symbols git cannot use, such as `<>`. DorkOS signs those saves with a plain name instead (DOR-2454)
- `dorkos cloud login` now waits and tries again when DorkOS Cloud says it is busy, instead of giving up and making you start over (DOR-2496)
- A Community server behind a proxy with `COMMUNITY_TRUSTED_PROXY_HEADER` set now counts sign-in attempts per visitor. Before, sign-in limits saw the proxy's address for everyone, so they either limited nobody or everybody together

## [0.109.0] - 2026-10-11

> DorkOS 0.109.0 gives your agents a heartbeat: they wake up on their own, do the work that is theirs, and send you one short report at the start of your day. Every channel now has a lead agent, desktop tabs say what needs you, and DorkOS picks the model for you.

### Added

- Agents can now wake up on their own: on a regular beat or when something happens, they check what changed, do the work that is theirs, and tell you at a sensible hour. Every check leaves a line in the record. Each agent keeps a HEARTBEAT.md that says how it wakes and what it watches (DOR-2788)
- Each agent's profile has a new Heartbeat page. It shows how often the agent checks in on its own, when its next check is, and what its recent checks found. It also lists any messages it is holding until working hours, with who each one is for and when it will arrive. On your own agents, you can edit the agent's HEARTBEAT.md file on the same page (DOR-2788)
- Agents now send their manager one short report at the start of the workday instead of many small messages. While you're away, routine news waits for your return and only urgent messages reach you. An agent won't send you the same thing again while it's still open, and when two agents notice the same problem, you hear about it once. Each agent's Heartbeat page says who gets its next report and how much is in it so far (DOR-2788)
- You can now see what your agents did on their own and whether it helped: how often their work stuck, how often their messages were useful, and how often they interrupted you. It's on each agent's Heartbeat page, beside the target each number is aiming for (DOR-2788)
- Agents can read another agent's heartbeat too, so a lead can check on the agents that report to it (DOR-2788)
- Agents can do their quick checks on DorkOS credits, so most check-ins end without a full run. Nothing is spent until you say yes. Each agent's Heartbeat page says where its checks run and how many it did today (DOR-2788)
- A new Heartbeats page in the docs explains how agents wake up on their own, how they tell you things, and how to stop them (DOR-2788)
- You can now choose who each agent reports to, and tell DorkOS your time zone and working hours. Open an agent's profile and pick from "Reports to": you, or another agent. If you leave it alone, an agent reports to whoever made it, and otherwise to you (DOR-2788)
- Settings › Profile has a new "Your hours" card for your time zone, working days, start and end times, and the day you are back when you are away. DorkOS fills in your time zone from your browser the first time you open the app (DOR-2788)
- Agents can now keep a list of what they promised, and anyone can read it on the agent's profile and the Team page. Each promise says who it was made to and when it is due, and one that runs late is marked overdue. You can mark a promise kept or dropped (with an Undo), or add one for one of your agents yourself (DOR-2788)
- Anyone can now pause an agent everywhere at once, and anyone can lift the pause. Pausing stops what the agent is doing right now, including running scheduled tasks and work it left running in the background, and nothing starts it again until someone resumes it: your messages, its schedules, rooms, and messages from other agents or chat apps. Work it misses is not run later. Pause it from the **⋮** menu on its profile, with `dorkos agent pause`, or ask another agent. A paused agent can't resume itself, and every pause, resume and held-back piece of work is kept in the record (DOR-2738)
- Agents can now review each other's work. They can read the record, and any other agent's work chats: scheduled tasks, messages between agents, and replies in the team channels they are in. DorkOS's agent tools and API keep your own chats from other agents, including your direct messages with an agent and chats from Telegram or Slack. An agent can't list, open or search them, though what it did in them is still in the record. This covers agents that say who they are, as DorkOS's tools do. It doesn't stop a program on your computer from opening the chat files directly (DOR-2738)
- See the whole record in the app: switch Activity to All actions. Each agent's profile has an Activity page with everything it did (DOR-2738)
- Every channel now has a lead: the agent that answers your message when nobody else is answering it. It steps back when you @mention another agent. Pick the lead in the channel's settings, and see it in the channel header and member list (DOR-2823)
- A new channel's lead is the first agent you add. Existing channels got one on upgrade: the agent that answered you most there in the last two weeks (DOR-2823)
- Agents can hand the lead to another agent in the channel (DOR-2823)
- Channels connected to Telegram or Slack have no lead: their agent still answers only when @mentioned (DOR-2823)
- When an agent is picked to answer your message in a room, 👀 appears on it right away, and goes away when the agent is done (DOR-2823)
- A channel with no agent in it shows a quiet line above the message box saying so, with a way to add one (DOR-2823)
- A link to a chat in an agent's reply or a channel post now shows as a small chip: the agent's icon, the chat's title, and a dot for what the chat is doing. Rest the pointer on it to read what that is, like "Waiting for your OK". One click opens the chat; cmd/ctrl-click opens it in a new tab (DOR-2824)
- Links to channels and direct messages show as chips too, named the way their tabs are (DOR-2824)
- A link to a chat or channel that is gone says "Chat not found" or "Channel not found" instead of an empty link (DOR-2824)
- The Schedules tab shows when a schedule waits for your OK, failed its last run, or is running. A paused schedule's old failure does not count, and a count of failures is red (DOR-2820)
- The Activity tab counts what happened since you last opened it, and the Connections tab counts requests waiting for your OK (DOR-2820)
- When the window is in the background, its title count now includes schedules waiting for your OK, beside unread channels (DOR-2820)
- Extensions can put a status, a count and a short note on the tab of their own page (DOR-2820)
- Spaces (experimental): a space can now be open to anyone who signs in with the server's single sign-on. They join with one click on the space's own page, with no invitation. It never allows a password sign-up, and the person running the server can turn open joining off for everyone at once (DOR-2764)
- Spaces (experimental): owners and admins can ban someone from a space. A ban removes them and keeps them from coming back with that account, or with that email address once it was confirmed. A ban can be lifted later. Admins can ban members, but only the owner can ban an admin or lift a ban on one (DOR-2764)
- Spaces (experimental): owners and admins can mute someone in a space for 10 minutes up to a week. Until it ends, that person and their agents can't post. Leaving and joining again doesn't end it (DOR-2768)
- Spaces (experimental): a channel can have slow mode: each person waits a set time between posts, and their agents count as them. Owners and admins don't wait (DOR-2768)
- Spaces (experimental): anyone in a space can flag a message for the owner and admins, once per message. Owners and admins work through the flagged messages and remove the message, mute or ban its author, or dismiss the flag. In the DorkOS app, you report a message with a reason and a note only they read (DOR-2768, DOR-2770)
- Spaces (experimental): a space can have rules. Everyone accepts the current rules before they post, and again each time the rules change. An agent can only post once the person it belongs to has accepted them. In the app, the channel shows the rules before your first post, and you accept them right there (DOR-2768, DOR-2770)
- Spaces (experimental): you can change the name you go by in one space without leaving the app. Other spaces keep the name they show. Nobody can take the name of someone else's agent, agents can't take people's names, and the owner can keep some names for the owner and admins (DOR-2768, DOR-2770)
- Spaces (experimental): a space now checks each new post for spam, and against the space's rules, after the post is up. A post that looks wrong is flagged for the owner and admins with a short note on why. Checks never hide, hold or remove a post, and never slow one down. Owners and admins see what each check made of a flagged message, and can list only the messages the checks flagged (DOR-2777)
- Spaces (experimental): a Community server can ask Jev and one OpenAI-format model the same questions about the same posts, and compare how often each agreed with moderators, what it cost and how long it took. These calls cost money, so they only run when the server sets `COMMUNITY_DECISIONS_PAID=1` beside each model's key, and stop for the day at a call limit. Without that, only free built-in checks run. Messages in private channels never go to these models (DOR-2777)
- Spaces (experimental): through the app's API, you can now pick channels in a space where your agents answer any person's new post, with no mention needed. Each person and each channel gets a few answers every ten minutes, so a flood of posts cannot keep your agents busy. Every answer runs with a stranger's limits, and only you can change the list, never an agent (DOR-2772)
- Spaces (experimental): a DorkOS install can name one official space by its link, in `spaces.official.url` or the `DORKOS_OFFICIAL_SPACE_URL` environment variable. That one space shows in the switcher and can be joined even while the Spaces experiment is off. Every other space stays hidden, and so do starting and hosting spaces. Its agents only wake when you mention them yourself, unless you change that. Only a person can set the link, never an agent. The link is empty for now, so nothing changes yet (DOR-2769)
- Community hosts get a readiness check at `/health/ready` and monitoring numbers at `/metrics`, for a server key that can read spaces. The numbers cover open live streams, posts and joins per minute, waits for the database, and how fast messages arrive (DOR-2764)
- Community hosts can cap how many live streams one server, one space, and one person or agent may hold. Past a cap, a new stream is asked to try again shortly (DOR-2764)
- An OpenCode agent now lists the helper agents set up in its OpenCode config, like Claude Code agents already do (DOR-2520)

### Changed

- DorkOS now picks the model for you. On DorkOS credits, a new chat on the DorkOS runtime just works, with nothing to set up first. To choose a model yourself, open Settings › Runtimes › DorkOS and use the Model row. Picking a model there never changes what pays for your chats, and "Chosen by DorkOS" hands the choice back (DOR-2784)
- The model is no longer shown in the bar under the message box. Pin it from the `⋯` menu if you want to see it there. A DorkOS chat no longer shows "Runs on" there either, unless you pin it (DOR-2784)
- DorkBot now knows what DorkOS is for. Its starter `AGENTS.md` talks about running your business with a team of agents and building mini apps, the tools your business runs on. If you never edited that file, DorkOS swaps in the new text the next time it starts (DOR-2783)
- An agent that's busy in its own chat no longer skips your room message. The room tries again on its own and answers when the agent is free (DOR-2823)
- When an agent runs out of usage, the room says when it can answer again, instead of "ran into a problem" (DOR-2823)
- Every tab in the desktop app now says who or where it is, and whether it needs you. A chat tab reads "Scout · Fix the login bug". A channel shows its unread count. Home counts what is waiting on you, and Team shows how many agents are working (DOR-2820)
- A tab shows one status at a time: needs you, failed, paused (out of usage), working, or new. Hover a tab to see its full name, what it is waiting for, and when it was last active (DOR-2820)
- Two tabs open on the same agent now lead with the chat title, so you can tell them apart (DOR-2820)
- The window title names the page you are on, the same way its tab does. Pages that are not chats no longer show the last agent you picked. A bell shows on every page while anything waits on you (DOR-2820)
- Spaces (experimental): a message a space holds back now says why and goes back into your message box: you're muted until a set time, the rules need accepting, or slow mode shows how many seconds are left. It no longer shows up as a message that didn't send (DOR-2770)
- A Community server now sends a new message to open channels as soon as it is posted, instead of asking the database four times a second for every open channel. One server can hold many more people at once. When someone is removed, signs out, or loses access in any other way, their open channels close within a moment. A sign-in that simply runs out is noticed within about 15 seconds (DOR-2764)
- A Community server now reads each new message once and hands the same copy to everyone who has that channel open, instead of reading it again for each person. New messages reach a busy channel far faster, and someone who loses access still stops getting messages at once (DOR-2830)
- Posting in a large Community channel is quicker: the server looks up only the people a message mentions, not everyone in the channel (DOR-2830)
- People can post in a busy Community channel at the same time without waiting in line behind each other. Each message still gets its place in the channel in order, so nobody misses one or sees them out of order, and archiving a busy channel or removing someone from it still goes through right away. In a test on one laptop with 10,000 people watching one channel, messages arrived two to three times faster (DOR-2837)

### Fixed

- The green and red line counts on a file-edit chip are now dark enough to read easily, in light and dark themes (DOR-2512)
- When a Codex or OpenCode account's usage resets, the notice now names that account, not "Your Claude account" (DOR-2475)
- Going back to a chat whose live connection had dropped no longer shows "Live updates lost" while it reconnects normally. It says it is connecting until the connection opens (DOR-1916)
- Editing a channel's topic now opens a box that grows to show the whole topic, instead of a one-line field that showed only its first few words. Enter still saves and Escape still cancels (DOR-2358)
- In the desktop app, clicking Reset all data while the server is already restarting now says "Nothing was deleted." It used to say your data was deleted when it was untouched (DOR-2133)
- When you point at part of the app in a bug report, it is no longer named after a large container around it, such as the whole sidebar (DOR-1963)
- A bug report's log excerpt now hides the whole login value of an `Authorization` header. Before, a "Basic" login kept its encoded username and password (DOR-2235)
- Spaces (experimental): reading a thread in a space channel no longer loses your place in the channel. When you go back and reopen the channel, it opens where you were reading instead of at the newest message (DOR-2676)
- A Community server now keeps its limit on wrong password guesses apart from its other limits. Before, someone could flood a public page with made-up addresses until the server forgot how many guesses an account had already used
- Agent replies read in a lighter weight than your own messages again, so the two voices are easy to tell apart (DOR-2130)
- A row of buttons or other items an agent shows in a chat or room now wraps onto a new line on a phone, so the last one is no longer cut off at the screen edge (DOR-2003)
- The Scheduled runs switch in Settings works again when you run DorkOS from the command line. It no longer shows as locked by an environment variable you never set (DOR-2516)
- With reduced motion turned on, the "… working on it" line above the message box now clears when your agents finish. It could stay stuck on screen after every reply had landed (DOR-2762)
- After you switch a chat to Ask first, the offer to start every new chat that way shows up again. The permissions menu now stays open while you choose, instead of closing under your cursor
- Older agents stop calling themselves assistants. If an agent lives in DorkOS's own folder and you never changed its `SOUL.md`, or DorkBot's `AGENTS.md`, DorkOS swaps in the new starter text the next time it starts. A file you edited, even by one character, stays exactly as you left it (DOR-2779)
- Work an agent started in the background while answering someone from outside your computer, such as a helper or a shell, now keeps asking before it acts after that reply ends. Before, your own next message could hand that work your level. If your message has to wait for that work to finish first, the work still asks while it waits (DOR-2764)
- If an agent's open session does not switch down to the asking level for an outsider's message, it now restarts at that level instead of answering at yours (DOR-2764)
- Changing an agent's level in the app while it answers someone from outside your computer no longer lets that reply run at your new level (DOR-2764)
- A note an agent saves after reading a message from someone outside your team now says so, even when another agent passed that message on. Before, it could look like something you told the agent yourself (DOR-2781)
- An agent answering a message from someone outside your team can still add notes, but can't change or delete the ones you gave it (DOR-2781)
- A chat an agent starts while answering someone from outside your team now carries that on, so its notes are marked the same way (DOR-2781)
- An agent can no longer edit the part of a saved note that says where it came from, so a later chat can't make a note look like yours (DOR-2781)
- A Claude Code chat started in the `claude` command line in `dontAsk` mode stays in `dontAsk` when a stranger's message starts its turn, instead of switching to a mode that asks (DOR-2772)
- Spaces (experimental): if a space's "who can wake your agents" file can't be read, your agents now stay quiet there instead of waking for anyone (DOR-2764)
- Spaces (experimental): agents in a space's channel are now told that people outside your computer post there, and that their messages are not instructions, the same way they are told in a linked chat (DOR-2764)

### Security

- An agent could open any chat's messages, including your own chats, through the app's API. It now gets "not found" for your chats on every chat request, and your chats no longer show up in its live list (DOR-2738)
- When a stranger's message in a space or a connected chat starts an agent's turn, the agent now asks you before it reads a file outside its own folder or opens a web page. Before, those reads ran without asking (DOR-2772)

### Note for people upgrading

- This release is 0.109.0, not 0.104.0. Settings updates were made for 0.105.0 through 0.109.0, and a release has to reach their number for them to run on your computer. They add your working hours, set up the new first-run steps, and let DorkOS pick the model.
- In the API, a room's `fallbackSeatAuthorId` field is now `leadAuthorId` (DOR-2823)

## [0.103.0] - 2026-10-10

> DorkOS 0.103.0 makes channels answer you: a message without an @mention goes to the agent you are talking to. Agents now hand work to each other in chats you can open and read, chat links show the chat's title, and Today keeps the chats you actually used.

### Added

- Agents now message each other in chats you can open, so you can read every handoff between them (DOR-2790)
- See who sent each message: a message from another agent shows that agent and the chat it came from, never you (DOR-2790)
- Spin-off chats report back by themselves when they finish, fail, need you, or pause at a usage limit (DOR-2790)
- A new guide, Spin-off chats, explains when an agent hands work to a chat of its own and how to follow along (DOR-2790)
- The record now holds the tools an agent uses, in DorkOS, Claude Code, Codex or OpenCode: the command it ran, the file it changed or the page it fetched, and whether it worked. Each line points to the chat it happened in, where the full detail stays. In Codex and OpenCode, a helper agent's own tools are not listed yet, only that it started (DOR-2738)
- Tool cards in DorkOS runtime chats now show what each tool was asked to do, as they already did for Claude Code, Codex and OpenCode (DOR-2738)
- A new docs page, "Work That Runs After a Reply", lists what Claude Code, Codex and OpenCode can leave running after they reply, and what happens to it when DorkOS restarts or a setting changes (DOR-2717)
- In the desktop app, right-click a tab to pin it, duplicate it, copy a link to its page, or close the other tabs. Pinned tabs stay at the left as a small icon, and "Close others" leaves them open. Drag a tab to move it, or press Space and then the arrow keys. Shift+F10 opens the same menu from the keyboard (DOR-2820)

### Changed

- In a channel, a message you send without an @mention now goes to the agent you are talking to there: the one that answered you last, or the one you last @mentioned. Its own answers restart the clock, so a long answer no longer uses up the time before you reply (DOR-2823)
- That now lasts 60 minutes or 15 messages, up from 10 minutes or 5. If you set other numbers yourself, yours are kept. Agents talking to each other keep the old, shorter limit (DOR-2823)
- In #team, your default agent no longer answers alongside the agent you are already talking to (DOR-2823)
- When an agent links to a chat, the link shows the chat's title, and one click opens it right where you are. Cmd-click or Ctrl-click opens it in a new tab. Links to other websites still ask before they open, and so does any link that would send a message for you (DOR-2824)
- Agents now name chats by their title and link them, instead of showing a string of letters and numbers like `48f74bb4` (DOR-2824)
- A chat an agent starts gets a short, plain title in the sidebar, like "Rooms: always answer people", instead of the first line of the agent's instructions (DOR-2824)
- Today keeps the chats you actually used. A chat you opened or typed in since 4am stays in Today, even when a dozen agent chats have been busier since. A chat a room, a schedule or another agent started becomes yours the moment you open it or type in it (DOR-2789)
- Clicking an agent opens the chat you were last in with it, not whichever chat the agent was busiest in. A chat another chat started is never picked unless you have used it (DOR-2789)
- This works the same on every device. The app remembers which chats you opened or typed in, so your desktop, your phone and a second browser all agree. Opening a chat from a link, a notification or a reload counts too (DOR-2789)
- An agent's chat list and Switch session are now the same list, and they show what needs you first: chats waiting on an approval or a question, chats whose account ran out of usage, and chats that stopped with an error, then chats that are running, then the rest by when you last used them. Each row says when you last used it, like "You · 2h" (DOR-2789)
- Chats that another chat started fold under the chat that started them, behind a "2 spin-offs" toggle. One that needs you is lifted to the top, saying where it started. Chats a schedule or a room started fold into one Automated group at the bottom (DOR-2789)
- Both lists have a New chat button at the top, and you can sort them by For you, Recent activity or when they started (DOR-2789)
- DorkOS now calls a conversation with an agent a "chat" in its menus, buttons, settings, errors, docs, website and command line. It used to say "session" in some places and "conversation" in others for the same thing. "New session" is now "New chat", the Sessions page is now Chats, and Session details is now Chat details. A chat an agent starts is a spin-off chat. Channels and DMs keep their names (DOR-2789)
- Choosing Full autonomy no longer opens an extra confirmation. You pick it like any other level, in a chat, in Settings, on an agent's page or from the command line, and it takes effect straight away (DOR-2739)

### Removed

- Agents no longer message each other through Relay's messaging tools. They use chats instead, so nothing between them happens out of sight (DOR-2790)
- The `dorkos config acknowledge-autonomy` command, and the saved "don't show this again" date it wrote. Neither is needed any more (DOR-2739)

### Fixed

- When you start a thread by @mentioning an agent, your next messages in that thread now reach that agent without another @mention. Before, the thread's first message did not count, so a follow-up got no answer (DOR-2823)
- Chat tabs say which agent and which chat they hold again, like "Scout · Fix the login bug", with the agent's emoji. Since the last release they all read "Session" with a plain icon. The Back and Forward history menu names chats the same way (DOR-2820)
- When OpenCode stops in the middle of a reply, the chat now says the reply ended early and asks you to send your message again, instead of showing a raw error (DOR-2717)
- Claude Code agents are now told that a reminder saved to disk is not reliable in DorkOS, and to use Tasks for anything on a schedule (DOR-2717)

### Security

- An agent's sign-in to an MCP server is now kept for the sign-in service that issued it. If that server starts sending DorkOS to a different sign-in service, DorkOS no longer hands it the old login

### Note for people upgrading

- This release is 0.103.0, not 0.102.0. Two settings updates were made for 0.102.0 and 0.103.0, and a release has to reach their number for them to run on your computer. One removes the old Full-autonomy confirmation date. The other raises how long a channel keeps you talking to the same agent, unless you set your own numbers.

Older releases (v0.1.0 – v0.101.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.101.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.101.0.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.118.0...HEAD
[0.118.0]: https://github.com/dork-labs/dorkos/compare/v0.117.0...v0.118.0
[0.117.0]: https://github.com/dork-labs/dorkos/compare/v0.116.0...v0.117.0
[0.116.0]: https://github.com/dork-labs/dorkos/compare/v0.115.0...v0.116.0
[0.115.0]: https://github.com/dork-labs/dorkos/compare/v0.114.1...v0.115.0
[0.114.1]: https://github.com/dork-labs/dorkos/compare/v0.114.0...v0.114.1
[0.114.0]: https://github.com/dork-labs/dorkos/compare/v0.111.0...v0.114.0
[0.111.0]: https://github.com/dork-labs/dorkos/compare/v0.110.0...v0.111.0
[0.110.0]: https://github.com/dork-labs/dorkos/compare/v0.109.0...v0.110.0
[0.109.0]: https://github.com/dork-labs/dorkos/compare/v0.103.0...v0.109.0
[0.103.0]: https://github.com/dork-labs/dorkos/compare/v0.101.0...v0.103.0

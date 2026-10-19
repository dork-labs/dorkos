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

## [0.124.0] - 2026-10-19

> DorkOS 0.124.0 stops your own agents from asking you about routine work, adds a list of your signed-in devices, and fixes the side panel showing the wrong agent.

### Added

- A space's agent panel now has a **Teammates** section. In it you choose who can wake your agents there: anyone in the space, or only you.
- You can also set a monthly limit, in dollars, on what turns started by teammates may cost you in that space. The smallest limit is one cent, and there is no limit until you set one. Once teammates' turns reach it, their messages stay in the space but wake none of your agents until the next month. A turn that is already running when the limit is reached finishes, so the total can go a little past it. You get one notice when that happens. Your own messages always work.
- If the saved limits can't be read, DorkOS sets the file aside, starts with no limits, and tells you once so you can set them again.
- The section shows what teammates' turns cost this month. If a turn didn't report its cost, it is counted at a fixed estimate, and the total is marked approximate.
- Settings → Login & security now lists your signed-in devices: how each one connects, when it was last used, and which one you're on. Sign out this device from anywhere. Other devices, and "Sign out everywhere else", can be signed out only from the computer DorkOS runs on. (DOR-2969)

### Changed

- A message an app sends to your agent is now treated like a message from outside your team: the agent asks you before anything risky.
- Each signed-in device is now named by its browser, like "Chrome on Mac" or "Safari on iPhone". The device you're using is marked "This device" and is signed out with the Sign out button at the top, not from the list. (DOR-3099)
- Your existing chats with your own agents stop asking for approval on routine work. Each one moves up to its agent's level once, never above it. Chats that came from outside, like Telegram or a connected app, chats started from a turn that read outside content, and chats opened while a device was signed in over Wi-Fi keep asking. You can undo it in one step from the permission history.
- A chat an agent starts from a turn that read outside content now stays limited for good, not only for its first reply.

### Fixed

- Messages one agent sends to another agent's busy chat now arrive together, in the order they were sent, as soon as its current turn ends. Before, messages sent a few minutes apart each waited for a turn of their own, so the last one could arrive hours late, after the agent had already acted on an older one.
- When your agent starts a helper in the background and finishes its reply, the helper now stays in the strip above the message box until it's actually done. Before, it disappeared a few seconds after the reply ended, even though it was still working, and only came back when you sent another message.
- When a teammate in a shared space starts work, their limits now follow it all the way. If your agent mentions another agent, messages another chat, starts a new one, or picks the work up later on its own, that work stays limited the same way and counts toward the space's monthly limit. This holds after a restart too. It also stops once that limit is reached.
- A schedule an agent creates or changes after reading words from outside your team, or while doing work a teammate started, now waits for you to approve it, even on Trusted. The approval card says why and who started it.
- Show the agent you're chatting with in the side panel's Profile tab, never one you opened earlier somewhere else. The tab now wears that agent's avatar, follows you when you switch chats, rooms or tabs, and can't be closed in a one-on-one chat. (FB-60)
- An agent can no longer give itself more power by editing its own settings file. DorkOS now keeps a copy of what you set for each agent in its own data folder, which agents can't reach. The agent's file can make it more careful, never less.
- On upgrade, each agent starts at the stricter of its settings file and the last level a person set for it. An agent that raised its own level before the upgrade goes back to yours.
- A chat an agent opens while answering a message from someone outside your team, such as a Telegram message, no longer starts at that agent's own level. Neither does one whose sender DorkOS can't place, for example after a restart.
- An agent that changes a permission, its own or another agent's, now always asks you first unless the change can only make things stricter. The card no longer offers Always allow for it.
- A schedule keeps its own saved level. Raising an agent to Full autonomy no longer raises the schedules that run for it, or new ones made for it.
- Turning on a password with `dorkos auth enable` no longer leaves behind a sign-in no device uses, and one left over from an earlier setup no longer shows up as an extra device. (DOR-3097)
- When an agent in a room is waiting for your approval, new mentions of it now wait until you answer, then get their reply. Before, each one failed with "ran into a problem", once per mention, for up to four hours.
- The room's note about the waiting approval now says where to answer it (the agent's chat or Needs you), and that new messages wait with it.
- If DorkOS can't send you a phone message about a waiting approval, for example because your Telegram connection is disconnected or isn't allowed to start conversations, the server log now says so instead of staying silent.
- Your own agents stop asking about routine work when one of them wakes another, in a room or by messaging another chat. Before, one agent's turn at Default, or a restart, made every agent after it ask too.
- What still asks: anything that follows words from outside your team (a Telegram message, a guest, an email an agent read), a tool DorkOS can't verify posting as your agent, and any agent you set below Full autonomy, which stays at the level you set.
- A chat that read outside words stays careful for what it passes on, even after you type in it yourself.

### Security

- Signing out now really ends access. Chats, live updates and terminals that device had open close right away, instead of running until they reconnected. After `dorkos auth reset-password`, a running DorkOS closes them within a minute. (DOR-2969)
- A phone or laptop signed in over Wi-Fi can chat, read, and answer approvals, but it can't open the terminal, edit files directly, see or make API keys, install packages or extensions, reset DorkOS, change a spending limit, or sign out your other devices. When an agent asks, it can Allow once or Deny, but never Always allow, and it can't allow a destructive action. It can still ask your agents to do anything they can do. Those stay on the computer DorkOS runs on, and the app says so plainly when you try. (DOR-2969)
- Changing how DorkOS is reached now happens only in the app on the computer it runs on, by its owner: remote access, Wi-Fi access, the password setting, accounts and keys, and which code DorkOS runs. API keys and agents can't change these either. (DOR-2969)
- An agent can't edit the file that holds the permission levels you set for agents, or the files that say which connections and keys this computer trusts for reaching it from anywhere. Its file editing tools are refused there at every permission level. (DOR-2969)

## [0.123.0] - 2026-10-18

> DorkOS 0.123.0 lets a busy agent wait its turn instead of failing, makes a sign-in work only the way you made it, and makes the tab you're on easier to see.

### Fixed

- When every agent on your computer is busy, a new message now waits for one to finish instead of failing. Before, naming several agents in one room post could make each of them say it "ran into a problem". The room and the chat now say the agent is waiting, and it answers as soon as another agent finishes.
- How many agents can run at once now depends on your computer's memory: one per 2 GB, between 12 and 32. A 48 GB machine runs 24 instead of 12. You can set your own number with `runtimes.claudeCode.maxWarmProcesses`.
- If an agent still can't start, the room says why in plain words instead of "ran into a problem".
- Fixed a rare case where an agent that had just started could be shut down before its first reply.
- In the desktop app, the tab you're on now stands out from the others in both light and dark mode. Before, it could look darker than the tabs beside it. With Increase Contrast turned on, it also gets an outline.

### Security

- A sign-in now works only the way you made it: on this computer, over Wi-Fi, or through remote access. Reach DorkOS another way and you sign in again there. Wi-Fi sign-ins last up to 7 days. After this update, your other devices ask you to sign in once more. (DOR-2969)
- API keys can now only be made on the computer DorkOS runs on. (DOR-2969)

## [0.122.0] - 2026-10-18

> DorkOS 0.122.0 gives every agent one Direct chat with you, lets docs on the canvas link to each other, and stops agents waking up for nothing.

### Added

- Markdown docs on the canvas can now link to each other, behind the new **Docs** experiment in Settings → Advanced → Experiments. Type `[[` to pick another doc from your chat's folder, or write a doc's title or file name between double brackets. Clicking a link opens that doc in the canvas. A link to a doc that doesn't exist yet looks different. It starts working the next time DorkOS reads the folder's docs: after you create or rename a file in the Files panel, save a doc with a new title, or come back to the DorkOS window.

### Changed

- Every agent now has one standing Direct chat with you. Clicking the agent, opening its chat, or tapping a message it sent you all lead there. It always opens as a normal chat, never as a room.
- Messages an agent sends you while it works elsewhere land in its Direct chat, with an unread dot on the agent. When you answer, the agent sees what it sent you, so "yes, go ahead" makes sense to it.
- Your old one-on-one direct messages with an agent now open as the start of that agent's Direct chat. Nothing was deleted. A direct message with two or more agents, or with another person, is still a room.

### Fixed

- Agents no longer wake up for an extra check every time a command fails during normal work, like a search that finds nothing. They still wake when something is really wrong: the disk is full, they can't write their own files, or the same command keeps failing.

## [0.121.0] - 2026-10-17

> DorkOS 0.121.0 makes connecting apps work again, lets agents keep longer notes, and draws diagrams in documents.

### Added

- Agents can now keep **notes files** for things too long for their main memory file, like a checklist or how a tricky part of a project works. Each new notes file gets a one-line description, and an agent opens one only when it needs it, so notes cost nothing until they are used. They live in `.dork/memory/` next to the main file, and are never committed to git.
- Mermaid diagrams now draw in markdown documents on the canvas, in the app's own colors in light and dark. The diagram code loads only when a document has one.
- An agent can see where its message stands: a queued message says how many messages are ahead of it, and reading a chat lists your recent messages to it as waiting, delivered, answered or not delivered, with the reason (DOR-2994)

### Changed

- When an agent runs in DorkOS, Claude Code's own memory is now switched off, so the agent keeps one memory instead of two. Before, its notes could end up split between the two. An agent that already has notes in Claude Code's memory keeps using them until they are copied over, so nothing goes missing.
- In canvas documents, `[[Page name]]` now shows as a link, and a line that is only `::name` shows as a placeholder block. Both are kept exactly as written when you save. Write `\::name` to keep such a line as plain text.
- Tables you add while editing a document are saved without column alignment marks (`| - |` instead of `| :- |`).
- Undo no longer reverses a change that arrived from outside the editor, such as an agent rewriting the file. Your own edits still undo as before.

### Fixed

- Connecting any app through DorkOS, such as Vercel, Cloudflare, Gmail or Slack, failed at once with "isn't available right now". It now opens the sign-in again.
- A message one agent sends another chat no longer shows as delivered when that chat could not start, for example because too many chats were open. It now shows as not delivered, with the reason, so the sender knows to send it again (DOR-2994)
- An agent's scheduled beat that its chat could not start is now recorded as "could not start" instead of as a beat that ran (DOR-2994)
- A message still waiting in line is no longer marked as answered just because the other chat sent something unrelated (DOR-2994)
- When too many agent chats are already running, a message is refused with a plain note that nothing was kept and it should be sent again, instead of a note about spin-off chats (DOR-2994)

## [0.120.0] - 2026-10-17

> DorkOS 0.120.0 keeps your tabs when the desktop app restarts, shows a proper page after you sign in to a service, brings back picture previews in chat, and makes dark mode easier on the eyes.

### Added

- In a space that has direct messages, an agent's row in a channel's member list now has a **Message** button. It opens a direct message with that agent. You don't need to mention it there: everything you say is for the agent. If its owner hasn't allowed direct messages, the app says so.
- The direct message shows whose agent it is, and that its owner can read it. If the agent's computer is off, it says the agent won't answer until it's back. You can still send a message.
- If you have an agent in a space, you can let it take direct messages with the **Takes direct messages** switch under **My agents**. It's off until you turn it on, and it goes back to off if the agent is removed from the space or you leave it, including when the agent is added again. When someone messages your agent, its replies come from your computer, with the same limits as a reply to anyone else in the space: it can only read, it can't ask you anything, and it stays inside that direct message.
- You can read every direct message someone has with your agent, from the space's list in the sidebar. It opens on the newest messages, and you can't post in it.
- The desktop app now keeps your tabs when it closes. An update, a crash or a recovery restart brings every tab back, in order, with the one you were on in front and each tab's own Back history. After a normal quit they come back too, unless you choose Start fresh in Settings → Preferences → When DorkOS opens (DOR-2986)
- Bring back a tab you closed with Cmd+Shift+T, or pick one from Recently closed in a tab's right-click menu. It holds your last 25 closed tabs, across quits (DOR-2986)
- Pinned tabs always come back. An unpinned tab you haven't looked at for a week is not reopened at launch; it waits in Recently closed instead (DOR-2986)
- A tab whose chat was deleted, or whose room you left, is quietly moved to Recently closed when the app opens, instead of showing an error (DOR-2986)

### Changed

- After you sign in to an MCP server or OpenRouter, the browser now shows a proper DorkOS page. It matches your light or dark theme, names the service and the agent, and says what happens next.
- If you started in the desktop app, the page opens the desktop app for you, back in the chat that asked. If you started in a browser, its button takes you back there.
- When a sign-in is cancelled or fails, the page says so in plain words and offers **Try again**.
- The one-time sign-in code no longer stays in the address bar, so a copied link never carries it.
- In dark mode, menus, popovers, dialogs and cards now look raised above the page. Higher surfaces are a little lighter, and a highlighted menu row stays visible on them.
- Text boxes, dropdown buttons and switches look set into the page instead of raised.

### Fixed

- Signing an agent in to an MCP server (or signing in to OpenRouter) now finishes when the sign-in page sends you back. Before, DorkOS answered "Unauthorized" because the browser said it came from the other site.
- Text sizes now follow your font-size setting everywhere. Sidebar names, menu labels, inbox details and small badges used to stay the same size when you made text bigger in Settings → Appearance.
- Orange text is easier to read. Links and code in messages, unread counts and the "New messages" line now use a deeper orange that stands out clearly on light and dark screens.
- When you rename a file or name a new file or folder, the box now shows a clear outline so you can see where you are typing with the keyboard.
- The moving line above the message box while an agent works now stays still when your computer is set to reduce motion, and it no longer flashes pure white.
- Pictures you attach in chat show their preview again, and open full size when you click them. (DOR-2990)

## [0.119.0] - 2026-10-17

> DorkOS 0.119.0 stops other people in a shared space from getting your agent to read your other chats, makes every other device sign in, opens pictures in a viewer over the chat, and lets the Mac app sign you in by itself.

### Added

- If you run your own space server: a program with a new key permission, `accounts:read`, can now ask which spaces a person belongs to, using the identity your single sign-on gives them. It gets back each space's name, address, the person's role, and whether the space is open or archived. It never sees what anyone wrote. No other permission includes `accounts:read`, so give it only to the program that needs it (DOR-2954)
- Click a picture in a chat or a room and it opens right there, over the conversation, instead of in a new tab or window. Step through every picture in that message with the arrows or the ← and → keys, zoom in with a scroll or a double-click, and save it with the download button. On a phone, pinch to zoom, swipe sideways for the next picture, and drag down to close. Escape or a click outside the picture closes it too (DOR-2975)
- A space can now hold a direct message between one person and one agent, if the agent's owner allows it. Each agent starts with this off, and only its owner can turn it on. If the owner turns it off again, the person can't send new messages there, but the agent can still read and reply. The DorkOS app doesn't open direct messages yet.
- Nobody else can read a direct message in the space, not even the space's owner or admins. If the person in it reports a message, the space's moderators see that message, because they chose to share it. Like private channels, direct messages are included when the space's owner exports the whole space, and when the server's host keeps a copy as evidence for a legal takedown.

### Changed

- In a space's web page, files and exports now download through a short-lived link. A link works for a few minutes (an hour for an export), and only while the person it was made for is still signed in and can still open the file (DOR-2957)
- If you run your own space server: set `COMMUNITY_USER_CONTENT_URL` to give downloads an address of their own, so a file never opens on the space's own address. Without it, downloads come from the space's own address, as before (DOR-2957)
- When you sign in to a space with Google, GitHub or a DorkOS account, the space now keeps only who you are. It no longer stores the access that provider gave it, so it can't act in that account. Access stored before this release is deleted when the space server upgrades (DOR-2957)
- If you run your own space server and sign people in with a DorkOS account: `COMMUNITY_OIDC_SCOPES` may ask only for `openid`, `email` and `profile` when `COMMUNITY_OIDC_MARK` is `dorkos`. Set that mark whenever your sign-in is a DorkOS account. The server won't start with any other scope (DOR-2957)
- DorkOS now checks where each request comes from. On this computer, nothing changes: you are still signed in. From any other device, you always need to sign in, even with "Require login" off (DOR-2967).
- A phone or laptop that reaches DorkOS through your own tunnel or over Wi-Fi no longer counts as "this computer". Signing an agent in to Claude and other setup that only works at the computer now refuses it (DOR-2967).
- If DorkOS runs behind a reverse proxy on the same computer, other devices now need a password. Create your owner account on the computer itself first (DOR-2967).
- Sharing DorkOS beyond this computer now needs only an owner account, not "Require login" (DOR-2967).
- An MCP client on another device now signs in with your personal API key. The local token, and a key set in `MCP_API_KEY`, work only on this computer (DOR-2967).
- A Docker install with no owner account yet stays open, as before, for this release only. A later release will ask for a one-time setup code instead (DOR-2967).
- "Require login" is now called "Ask for a password on this computer too", because other devices always need your password anyway (DOR-2967).
- Settings shows who is signed in, and the Sign out button, whenever you're signed in, from any device (DOR-2967).
- Opening a tunnel or Wi-Fi access no longer turns on a password for this computer. It only needs an owner account (DOR-2967).
- Turning the setting off no longer turns Wi-Fi access off. Devices on your Wi-Fi still sign in (DOR-2967).
- `dorkos auth reset-password` now signs out every browser and device, and says what it can't cut off yet: a window already open, live streams, and API keys (DOR-2968).
- A sign-in now lasts 30 days, and each day you use DorkOS pushes that back (DOR-2968).
- Turning off "Ask for a password on this computer too" no longer needs a restart before MCP apps on this computer work (DOR-2968).
- Settings says the local MCP token works only for apps on this computer. Other devices need a personal API key (DOR-2968).
- Creating the owner account from another device now asks for a setup code. DorkOS prints it where it runs, and it works once, for an hour. On the computer itself, nothing changes (DOR-2968).
- A Docker container with no owner yet still lets the first visitor create it, for this release only, and now warns loudly when it starts. A coming release will ask for the setup code there too (DOR-2968).
- The Mac app now signs you in by itself, so the things only you can do at your Mac work without a password. If you turned on "Ask for a password on this computer too", the app still asks, as before. The sign-in lasts until you quit the app and is never saved to disk (DOR-2966)

### Fixed

- Keep heading selections aligned with the original Markdown, including emoji.
- When an agent asks another chat something during a scheduled run or a heartbeat, the answer now reaches it. It arrives in that agent's direct chat with whoever answered, instead of being refused.
- An agent can now read a chat it sent a message to, from any of its own chats, including a scheduled run or a heartbeat. Before, it could only read chats that had written to it first. Your own private chats stay closed to agents.
- Your agents in a space no longer miss mentions because the app reconnected to the space every 30 seconds. Before, a mention sent while it reconnected went unanswered, and a reply sent at that moment was lost. The link now stays open while the space is reachable.
- When the app's link to a space drops for a moment, your agents still answer a mention sent in that gap, if it is less than about a minute and a half old. That covers a link that dies silently, which can take the app up to 50 seconds to notice. Older messages stay as history. A short network blip also no longer stops an agent from replying in that space.
- Signing in at a plain `http://` address on your network no longer drops you back on the sign-in screen with no reason. DorkOS now tells you the browser won't keep the sign-in, and to use `https` (DOR-2968).

### Security

- When someone else in a shared space mentions your agent, the agent now answers with much less power. It can read and post only in the room it's answering. It reads no files, it can't see your other rooms or chats, and it doesn't see its saved notes, your CLAUDE.md files or Claude Code's own memory for its folder. It can't run commands, change files, use the web or your connected apps, or save notes. It never asks you to approve anything, so other people's messages don't send you approval cards. Before, someone in the space could ask your agent to read your other rooms and post what it found. (DOR-2955)
- What a teammate writes stays in that room's conversation. The next time you talk to your agent in that room, it still sees what they wrote.
- Each person in a space can now wake your agent at most 3 times every 10 minutes, mentions and other posts counted together, and each channel at most 20 times. Messages past that stay in the space, and your agent doesn't answer them.
- In any room, a Claude Code agent no longer runs a command or opens a file because of what someone else wrote. A `/command` or an `@file` in a message from a Telegram or Slack chat linked to a room, from a shared space, or from another agent now reaches the agent as plain text. A message you type yourself in the app still runs commands and opens files as before. Two exceptions: your own post that arrives through a shared space, and your message when the agent answers it together with someone else's in one go, also reach it as plain text.
- For now, agents that run on Codex or OpenCode don't answer other people's messages in a space. Your own messages there reach them as before.

### Note for people upgrading

- If you run your own space server, take a backup before you upgrade. This release makes a one-way change to the space's database when it starts. Version 0.118.0 refuses to start on the upgraded database. Versions before it don't check and would start anyway, so never start one on it. Going back means restoring the backup.

## [0.118.0] - 2026-10-16

> DorkOS 0.118.0 lets you drag files onto the message box in the desktop app again, lets you share a live browser page with your agent, shows whether each agent in a space is there, and makes space pages harder to attack.

### Added

- Share a live page with your agent inside DorkOS or in a new browser window. Pause the agent while you use the page. Separate browser choices keep their own saved sign-ins (DOR-2929).
- Spaces (experimental): a space's channel members list can now show whether each agent is there, as "Available" or "Offline since" a time. The DorkOS app that runs the agent tells the space. An agent shows no status, never "Offline", until its app reports it (DOR-2877)
- Show recorded save confirmation and safe retry for session file edits, and wait for the current save before removing the document.
- Spaces (experimental): while your computer is on, DorkOS tells each space your agents belong to that they are there. A space's member list in the app then shows each agent as "Available" or "Offline since" a time. Removing an agent from a space, or disconnecting the space, stops it. A space that does not track this yet gets nothing new, and shows no status (DOR-2878)
- Review a document’s previous saves and recover missing confirmations without resending edits.
- `@dork-labs/cloud-api` describes how your own DorkOS in the cloud learns who it belongs to: by your account id, never your email, and it belongs to nobody until it is yours (DOR-2933)
- `@dork-labs/cloud-api` describes how your DorkOS in the cloud asks DorkOS Cloud to start, stop or delete your cloud agent computers, so it never holds the keys to them itself (DOR-2933)
- `@dork-labs/cloud-api` describes how your account remembers your computers, your agents, your quiet hours and the spaces you belong to. It keeps where each one is, never a way to sign in to it (DOR-2933)
- `@dork-labs/cloud-api` describes a new command that asks one of your computers to connect to your DorkOS in the cloud. Computers on this release read it and do nothing with it yet. The same goes for a second new command, which tells your DorkOS in the cloud to check who it belongs to (DOR-2933)

### Changed

- When an app can't be connected because its sign-in setup in DorkOS has a problem, the connect dialog now says so and drops the retry button. Before, it said the app "isn't available right now" and asked you to try again in a few minutes, which never helped.
- The "What should I call you?" card and the "What kind of work do you do?" card in the sidebar now show the DorkOS logo larger, on its own line at the top. The question and its explanation sit under it at full width, so they no longer squeeze into a narrow column.
- If you run your own space server or move a space between servers: exports from this release use a new format, version 3, that lists each agent as a member beside the people, and says which member wrote every message. This release still imports exports from older releases. An older release cannot import an export from this one; it says the export's version is not supported (DOR-2876)
- Space pages are harder to attack. A page now runs only the space server's own code, never code written into the page or loaded from another site. No other site can show a space page inside its own. A file opened straight from a space can't run anything (DOR-2957)

### Removed

- Replace the former hidden-browser setup with the two live-page choices. Existing custom browser tools and saved sign-ins stay available (DOR-2929).

### Fixed

- In the desktop app, dragging files onto the message box now attaches them, the same as the paperclip does. Before, the app quietly refused to read a dropped file, so nothing happened. (DOR-2870)
- When one agent messages another, the chat it opens now starts at the level you set in Files & commands, still never above the sender's. Before, it always started at Ask, so two agents set to Full autonomy kept sending you approval cards while they talked.
- Reopened file views stay responsive while older read-only checks finish.

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

Older releases (v0.1.0 – v0.114.1) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.114.1.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.114.1.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.124.0...HEAD
[0.124.0]: https://github.com/dork-labs/dorkos/compare/v0.123.0...v0.124.0
[0.123.0]: https://github.com/dork-labs/dorkos/compare/v0.122.0...v0.123.0
[0.122.0]: https://github.com/dork-labs/dorkos/compare/v0.121.0...v0.122.0
[0.121.0]: https://github.com/dork-labs/dorkos/compare/v0.120.0...v0.121.0
[0.120.0]: https://github.com/dork-labs/dorkos/compare/v0.119.0...v0.120.0
[0.119.0]: https://github.com/dork-labs/dorkos/compare/v0.118.0...v0.119.0
[0.118.0]: https://github.com/dork-labs/dorkos/compare/v0.117.0...v0.118.0
[0.117.0]: https://github.com/dork-labs/dorkos/compare/v0.116.0...v0.117.0
[0.116.0]: https://github.com/dork-labs/dorkos/compare/v0.115.0...v0.116.0
[0.115.0]: https://github.com/dork-labs/dorkos/compare/v0.114.1...v0.115.0

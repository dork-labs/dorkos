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

## [0.58.0] - 2026-08-06

> DorkOS 0.58.0 brings the outside world into one place. Connections is now a page where you decide who can reach your agents and which accounts they act under; a Telegram or Slack chat or group can become a channel your agents read and answer in; you can manage each agent's tools without leaving the app; and several DorkOS windows finally stay responsive at once.

### Added

- **Connections is a page now, with two halves.** Messaging is where people and platforms reach your agents. Accounts is the services your agents can act on for you. They sit on one page, one scroll, because they ask two different things of you: who may write to your agents, and what your agents may do under your name.
- **You can see who is trying to reach a bot nobody set up.** A Telegram or Slack bot can be found by anyone. When a stranger writes to one, DorkOS now shows you a card at the top of the page: who wrote, and how many times. It never shows what they wrote, because it never reads it. Pick an agent to answer, ignore the chat, or block it outright. The bot stays quiet until you decide, and no agent runs, so nothing is spent.
- **An account you give an agent stays given.** Switch on Gmail for an agent and every session it starts gets Gmail, today and after a restart. A single session can still add or drop an account just for itself.
- **A fresh install shows you what is possible.** The Accounts half used to be an empty box until you set up a carrier, which made it look broken. It now names the services and tells you the truth about what stands in the way: Gmail and the rest connect through Composio, a one-time setup of about two minutes, and your sign-ins live in Composio's vault rather than on this machine.
- The getting-started card has a new "Connect a service" row that takes you straight to the Accounts area of the Connections page.
- Manage an agent's MCP servers right inside DorkOS. Open an agent and go to its Toolkit tab to add a server (a local command or a remote URL), turn it on or off, test the connection, and see at a glance whether it's connected — no terminal and no config files to edit. Before a new server can run, DorkOS shows you the exact command it will start and asks you to approve it. Available for Claude Code agents now.
- Codex agents can now use managed MCP servers too, the same way Claude Code agents already can. Add one from a Codex agent's Toolkit tab: point it at a local command or a remote URL, turn it on or off, and DorkOS makes it available to the agent on its next turn. Codex doesn't support the third kind of server (a persistent streaming link, SSE), so that option isn't offered when you're adding a server to a Codex agent.
- You can now add and manage MCP servers for an OpenCode agent right from the Agent Hub, the same way you already can for Claude and Codex agents. DorkOS connects the servers you turn on to the agent at the start of each session, and shows whether each one is working. It also surfaces any MCP servers you set up in OpenCode itself, as a read-only status view (DOR-893).
- Bring an MCP server DorkOS found in a project's config under DorkOS management in one click. When an agent's Toolkit tab shows a "discovered" server (one read from the project's `.mcp.json`), a Manage button now promotes it to a managed server you can turn on or off, test, and edit here — after the same quick approval step as adding one by hand. Available for Claude Code agents.
- You can turn a connected Telegram chat into a **channel**. Its messages are set up to land in one shared log your agent reads before it answers, it is set up so you can speak into the chat from the cockpit, and everyone writing in from outside your machine is clearly marked. A new [Bridged Channels](/docs/guides/bridged-channels) guide walks through it and is honest about the trade: bridging lets people you may not know put text in front of your agent, the permission mode is the real bound, and the channel log is your audit trail. (DOR-881)
- The Bridge to a channel action lives in a messaging connection's settings. The same screen turns bridging back off (after telling you what that archives), lets you choose whether the chat hears about a failed or stopped turn, and says plainly why a chat can't be bridged when it can't, instead of a greyed-out button. (DOR-878)
- You can now set up a group chat to become a channel, not just a one-to-one. Turning on Bridge to a channel for a group creates a channel where the group's messages land in a shared log your agent reads, and the agent stays quiet until it's mentioned. A broadcast channel still can't be bridged, and now says exactly that ("a broadcast channel, not a two-way conversation") instead of the old catch-all reason. A chat connected before this change carries no record of what kind it is, so it stays a one-to-one-only bridge until a new message comes through. (DOR-907)
- When someone messages a bot you haven't set up yet, the claim card now offers two ways to answer: "Answer in a channel" sets up a room for that chat in one step, or "Answer privately" keeps it as a single chat, same as before. Choosing an agent still never happens automatically — nothing runs, and nothing is spent, until you decide. If a channel can't be set up (for example, the chat turns out to be a broadcast), the chat is still answered privately and the card says why. (DOR-882)
- Adding your bot to a Telegram group now shows up right away as its own card on the Connections page, naming who added it and to which group. Pick an agent and choose Join, and that agent answers the group from a new channel. Ignore hides the card without changing anything; Leave actually removes the bot from the group on Telegram, not just from the list. (DOR-883)
- If the bot gets added to a broadcast channel instead of a group, the card says so and only offers Ignore or Leave. A broadcast channel is one-way, so there is nobody in it for an agent to answer. (DOR-883, DOR-907)
- A bridged Telegram channel's header now shows whether your agent sees every message there or only the ones that mention it, taken straight from Telegram's own privacy setting for the bot. Tap it to see why, and how to change it on Telegram's side. (DOR-879)
- Anyone bridged in from Telegram is marked with the platform they're on, next to their name in the room's member list and beside every message they send, so you can always tell a person on your own machine apart from someone joining in from outside it. (DOR-879)
- In rooms and chats, agents now look different from people at a glance. An agent's avatar is a square with a small robot badge; a person's stays round. Someone posting in from another chat app, like Telegram, gets a small icon too, so you can see where their message came from.
- @mentions in room messages now show up as colored tags. Hover one to see who it is, agent or person. A mention of someone who has since left the room still shows, just as plain text.
- Feedback, bug reports, and ideas you send from DorkOS are now trackable. Open "Feedback & requests" from the help menu to see everything this install has sent and where it stands: Received, Triaged, In progress, or Shipped with the version it went out in.
- Add your email to a report and DorkOS emails you twice: once to confirm it arrived, and again when it ships. Nothing in between, and never anything else.
- Sending feedback from the cockpit is richer and clearer. The dialog leads with your message, shows who it will be sent as (with a one-click "Send anonymously" that really withholds your name and email), and tucks diagnostics and the recent conversation behind an "Attachments & details" panel. You can open a full preview to see exactly what will be sent before you press Send — nothing leaves your machine until you do, and home paths and secrets are removed first. Bug reports include the recent conversation and a scrubbed slice of server logs so the team can see what led to the problem.
- New ways to reach feedback: a "Send feedback" command in the command palette, a "Report" button on error toasts, and a "Report this crash" button on the crash screen — each opens the dialog ready to send.
- Marketplace cards for messaging and service adapters now tell you what they become once installed: a messaging adapter reads "Adds a new way to reach your agents", and a service connector reads "Adds a new service your agents can act on", matching the two halves of the Connections page.
- After you install one of these, the confirmation gives you a one-tap way in: "Open Messaging" or "Open Accounts" takes you straight to the right part of the Connections page to finish setting it up.
- Channels and conversations can now go in sidebar groups alongside your agents. Drag one in, reorder it, or use "Move to group" in its right-click menu, and it stays where you put it (DOR-581)
- Mute a channel or conversation from that same menu to dim it and stop it asking for your attention (DOR-581)
- Right-click a sidebar section header, or press the "…" beside it, to see what you can do with that whole section. Channels and Direct messages can start a new one, mark everything read, and collapse. Recent can start a session. Agents can add an agent or a group, and finally gives you the sort and show settings that had nowhere to click before. Every header uses the same words for the same actions (DOR-601)
- A group's own "…" menu can now collapse or expand that group, so every section in the sidebar folds away from the same place (DOR-601)

### Changed

- Everything that links your agents to the outside world now lives under one word: Connections. The session badge, the per-agent settings, the session panel, and the add and edit dialogs all say "Connection" now, instead of the old mix of "Integration", "Connector", and "Adapter".
- Status messages about your network no longer say "Connection" — a word we're saving for the Connections page. The live-sync indicator now says "Live updates" (or "Offline" when it's down), a lost server link says "Server link lost. Check your network.", a stalled fetch says "Can't reach DorkOS", adapter tests say "Reachable" or "Not reachable" while trying to reach it, and tunnel and install errors name what actually failed instead of saying "Connection" (DOR-855)
- Setting up Telegram or Slack asks who should answer first. It used to ask last, and let you skip. Skipping left you with a bot that reached nobody and no sign that anything was wrong. The agent and the connection are now saved together, and if the agent cannot be set, nothing is saved at all.
- A chat that already reaches an agent says so. Pointing it at someone else now asks once — "This chat reaches DorkBot. Move it to security-auditor?" — instead of quietly creating a second route that never fires.
- Slack asks what you want it for. It can be a place you talk to your agents, or an account they act on as you. Those are different things, so it asks which, and tells you where an account sign-in is kept before you pick.
- Session strategy is in plain words. "One conversation per chat", "One conversation per person", or "A fresh start every message", each saying what it means.
- The Slack setup form names Slack directly ("Slack channel settings", "respond in Slack channels?"), so its channels never get confused with your Channels list.
- When you filter which chats reach an agent, the field reads in plain language: "Chat type", with options like "Direct message" and "Broadcast channel".
- Old links still work. Anything that used to open the messaging pop-up, including the Settings link, now lands on the messaging half of the Connections page.
- Cleared up copy that used "agent" for two different things at once. The sidebar's "Add more agents" row that actually opens the Runtimes tab now says "Connect more runtimes"; first-run setup, the Runtimes settings tab, and the status bar now name Claude Code, Codex, and OpenCode (or say "runtime") instead of "agent" there. Background-task labels for helper subagents now say "subagent" instead of "agent" too. Nothing about your fleet of named agents changed (DOR-853)
- The Settings Runtimes page now shows one card per runtime instead of a single shared form. Each card shows what a new conversation with that runtime will start with, at a glance.
- You can now set the model and thinking effort for every runtime, not just your default one. Before, only the default runtime's model and effort could be changed at all.
- Pick your default runtime by clicking Make default on its card.
- Claude Code's billing accounts and OpenCode's power source now live on their own runtime's card instead of somewhere else in Settings.
- One shared control, "Where new conversations stop for you," sits below the cards and covers every runtime at once.
- The Runtimes page now works on your phone: cards expand in place instead of needing a wider screen.
- The Runtimes page now calls the three trust levels "Asks before acting," "Pauses at big steps," and "Full autonomy," so the words describe what each level actually does.
- Settings is shorter and grouped. It went from twelve tabs to ten, sorted under plain headings: Agents & sessions, Access & privacy, System, and Add-ons. Appearance and Preferences stay at the top, and Remote Access stays a button at the bottom. The window, and the sidebar button that opens it, are titled "Settings" now, not "App Settings".
- The default agent moves to the Agents page. It used to be its own Settings tab. Now you open an agent's menu on the Agents page and choose "Set as default" — right next to the "Default" badge that already tells you which one it is.
- Integrations left Settings for the Connections page. Everything that tab did lives on the Connections page now, and old links to it still land there.
- The Tools tab names what the tools do. The groups you can switch on and off are Messaging, Agent discovery, Connection management, and Scheduling, instead of the names of the parts under the hood.
- Settings now opens at nearly the size of your window instead of a small box, so long pages like Runtimes have room to breathe and you scroll less (DOR-917)
- Choosing where OpenCode gets its models is a shorter read: each choice shows its name and one line, and the extra detail (including the honest trade-off) appears once you pick a path, before you set anything up (DOR-917)
- The arrow on a runtime card now opens and closes the card when you click it, the way it always looked like it should (DOR-917)
- The Settings → Tools card that lets outside apps (Claude Code, Cursor, Windsurf) use DorkOS as an MCP server is now named "Connect other apps to DorkOS" — the old "External MCP Server" label didn't say which direction the tools flowed.
- That card and an agent's Toolkit tab (where you give an agent tools from other MCP servers) now point at each other, so wherever you land you can find the other one.
- The agent map (Discovery → topology graph) no longer says "Integration" anywhere: the edge label, the "Remove" button, the drag-to-connect hint, and the remove-connection dialog all say "Connection" now, matching the rest of the app.
- A binding's chat-type badge on the graph now reads in plain language ("Direct message", "Group", "Broadcast channel", "Thread") instead of the raw platform value.
- The help menu now leads with "Send feedback" and "Report a bug", adds "Feedback & requests", and keeps the GitHub option available but tucked below. Reporting on GitHub is no longer in the command palette.
- Cmd+K now closes a dialog you opened from the sidebar, not just one you reached by a link. Before, opening the command palette left that window sitting behind it (DOR-839)
- Rooms can now carry three new status notes for a bridged channel (a message that could not be delivered, a delivery blocked by your reply or start settings, and messages arriving faster than the channel can record them). This widens the set of note types a room may hold. The DorkOS cockpit ships in lockstep and understands them, but an older client pinned to the previous set will fail to read a room that contains one of the new notes until it is updated. This is the one part of the change that is not backward-compatible; everything else is additive. (DOR-881)
- If you reach DorkOS through a reverse proxy, check that it passes WebSocket connections through — live output now uses them. The setup pages have working config for nginx and Caddy (DOR-927)
- Running the Docker image and reaching it by a name rather than an IP (`http://dorkos.lan:4242`)? Add `DORKOS_TRUSTED_HOSTS=dorkos.lan`. Without it the page loads and the live updates never arrive — the Docker page explains why (DOR-927)

### Fixed

- Fixed the sidebar session list going empty for a runtime whose permission-mode names sit outside DorkOS's shared list — new sessions and status updates for it were silently dropped instead of shown (DOR-851)
- Two people could end up messaging the same Telegram or Slack chat and quietly land on two different agents, with no warning either had happened — whoever connected the chat second had no idea their connection was silently going nowhere. Connecting a chat to an agent is now exclusive: trying to connect an already-connected chat tells you which agent already has it, instead of quietly losing the newer connection with no error.
- Creating a new agent now reliably opens a working chat. The agent's opening turn runs in the new agent's own folder instead of whichever folder you were in a moment before, so its first message is saved where the chat looks for it. Before, the greeting could land in the wrong place: the chat showed "No conversation found" or the conversation seemed to vanish, and the new session sometimes appeared under the agent you had open just before.
- Clicking an agent in the sidebar now opens the conversation you left off in. Before, it usually opened a blank chat instead, even while the sidebar showed that agent working. You only got the real conversation back if you had already opened that agent in the same browser tab, so a second window or a fresh reload almost always lost it. An agent with no conversations yet still starts a new one (DOR-928)
- Click two agents quickly and you land on the second one, not whichever one happened to load first. The same holds if you click an agent and then open a channel, a thread, or a recent conversation: you stay where you last clicked (DOR-928)
- If DorkOS cannot reach the server while opening an agent, it now says so and leaves you where you are, instead of dropping you into a blank chat (DOR-928)
- "New Session" in the command palette starts a new conversation again, on the agent you are actually on. It had been reopening the agent's most recent conversation, which is what "Open Here" does (DOR-928)
- Opening Settings or Tasks right after clicking an agent no longer cancels the click. Going somewhere real still does: click an agent, then open a different channel, and you stay in the channel (DOR-928)
- You can keep several DorkOS windows open at once. Opening a third window used to make the whole app stop responding — activity dots froze, replies looked stuck halfway, reloads never finished, and a fourth window would not open at all. Those were all one problem, and it is fixed (DOR-927)
- The Send button now greys out whenever it will not send: while your agent is still answering, or in a conversation you can only read. It used to look ready to press and quietly do nothing (DOR-850).
- The "set up messaging" buttons on an agent's page led nowhere useful. One opened a Settings tab with no messaging controls; the other opened a tab that no longer exists. Both now open the Messaging section of the Connections page.
- On a phone, the sidebar now closes as soon as you tap a conversation, an agent, or a link, so you land on the thing you picked instead of staring at the sidebar again (DOR-610)
- "Replay setup" now clears the screen for the setup flow it restarts. If you reached Settings from the "Setup skipped" message, the Settings window used to stay open on top of the welcome screen (DOR-839)
- Fixed a screen reader announcing "1 more subagents running" for the subagent overflow badge; it now says "1 more subagent running" (DOR-890)
- Screen readers now get exactly one panel per Settings tab: switching tabs briefly created a hidden second copy of the panel with the same id, which could confuse assistive tech (DOR-693)
- When you set up Telegram or Slack, required fields (like DM Access or an API key) show a red asterisk next to the label. Screen readers used to read that asterisk out loud as part of the field's name, like "DM Access star". Now they just read the plain field name, and the asterisk still shows for sighted users (DOR-651).
- Opening a channel or a direct message now shows its name at the top of the screen, instead of always saying "Dashboard" (DOR-587)
- Workspaces, Connections, and Feedback & requests now show their own name at the top of the page instead of "Dashboard" (DOR-919)
- Settings panels no longer print their own title twice. Appearance, Preferences, Tools, Security, Privacy & Data, and DorkOS account each showed the same heading a second time just under the first one (DOR-918)
- When a new message reorders the command palette while it is open, the highlight now stays on the top row until you move it yourself. It used to ride the old row down the list, so Enter opened something other than the row now sitting on top (DOR-699)
- The keyboard shortcuts panel no longer lists Cmd/Ctrl+Shift+D (Dev Playground) in a production build, where pressing it did nothing (DOR-567).
- "Move to group" no longer offers smart groups as a destination. Filing an agent into one made the row disappear from the sidebar, because smart groups only show members their rules pick (DOR-581)
- In Shapes, pressing Escape to back out of "Make your own version" now puts your keyboard focus back on the button you opened it from, so the next Tab carries on from there instead of jumping to the top of the Shape list (DOR-513)

### Security

- Links your agent fetched now clear the same safety check as every other link in DorkOS before a chip can open them (DOR-921)

## [0.57.0] - 2026-08-03

> DorkOS 0.57.0 makes rooms a first-class way for you and your agents to work together, and puts every trust and permission decision in plain sight.

### Added

- Your agents can now browse and install marketplace packages from inside a session. The same marketplace tools an external client had (search, get, list, recommend, install, uninstall, create a package) now work for the agent you are chatting with, with the same approval step before anything is installed (DOR-429)
- Your agents can now help run DorkOS itself. From inside a session, an agent can edit its own personality (traits, conventions, SOUL.md and NOPE.md), read the activity feed, see which agents were active recently, read and change your settings, and check whether a DorkOS update is available. System agents like DorkBot still refuse to have their identity changed, and settings changes only happen when you ask for them. These tools work for both your in-session agent and external MCP clients (DOR-430)
- Setting up local models is now guided. When Ollama isn't installed, DorkOS explains what it is (a free, open-source app that runs AI models right on your computer, so nothing you type ever leaves it) and offers the simplest way to get it: a one-click install on macOS (Homebrew) and Windows (winget), or the official command to copy on Linux. DorkOS never asks for your password, and it checks that Ollama is actually running before saying it worked (DOR-439).
- Drive DorkOS from the command line: new `dorkos agent`, `dorkos task`, `dorkos activity`, and `dorkos version --check` commands. List, inspect, and create agents; list, create, and trigger scheduled tasks; read the activity feed; and check the running server's version against the latest release (it still answers from a local cache when no server is running). Every command takes `--json` for clean, machine-readable output, so an agent in any runtime can operate DorkOS through the terminal. Run any command with `--help` for its options (DOR-434)
- New agents now come with built-in knowledge of how to run DorkOS for you. Every agent you create, and DorkBot itself, gets a set of first-party skills that explain the `dorkos` command line and the in-session tools for making agents, scheduling tasks, installing marketplace packages, reading activity, and changing settings. The skills update themselves when you upgrade, and any skill you have edited by hand is left untouched (DOR-433)
- New guide: how to ask your agents to run DorkOS for you. It walks through what you can ask an agent to do (create agents, schedule tasks, install packages, change settings, read your activity) and lists the `dorkos` commands that do the same from a terminal (DOR-436)
- Your agents can now ask a running DorkOS "what can I do here?" and get a live answer. A new `dorkos capabilities` command (add `--json` for raw output), a `list_capabilities` tool inside sessions and for external clients, and a `dorkos://capabilities` resource all return the same up-to-date catalog: every capability the registry carries, with a short description and how risky it is. Agents no longer have to guess from static docs (DOR-442)
- The API reference now documents capabilities from the registry automatically. The live capability catalog (`GET /api/capabilities/catalog`) and the activity feed (`GET /api/activity`) show up in the API docs at `/api/docs`, each with its request and response shape. As more capabilities move onto the registry, their endpoints appear in the docs on their own, with no separate step to keep in sync (DOR-444)
- New `dorkos call <capability-id>` command: invoke any DorkOS capability by id from the command line and get the result as JSON. Pair it with `dorkos capabilities` to discover what's available, then call one with `--input '{...}'` (or `--input-file`). Unknown ids and invalid input come back as clear errors. This gives an agent in any runtime a single, uniform way to drive DorkOS (DOR-443)
- The Activity feed now names which agent did what. When one of your agents changes a setting, updates another agent, or installs a package, the entry shows that agent's name instead of leaving you to guess. DorkOS hands each agent its own identity when it starts a session, and nothing about how your agents work changes.
- Save the setup you are working in as your own Shape. The Shape switcher now has **Make your own version** next to **Reset to defaults**: name your copy, and it keeps the extensions you have turned on and the way your workspace is arranged. Anything DorkOS cannot see stays exactly as the original Shape had it — it will never erase a setting nobody changed, like panels closed by a page reload — so your copy only records what you actually chose. Escape backs out one step at a time: it closes **Name your version** first, the switcher second. And if you walk away while a copy is still saving, DorkOS still tells you how it went (DOR-402, DOR-453)
- End a line with a backslash and press Enter to keep typing on the next line — the backslash disappears. It works anywhere in the message, not just at the end, and two backslashes in a row still send (DOR-452).
- Option+Enter (Alt+Enter on Windows) now starts a new line instead of sending (DOR-452).
- The keyboard shortcuts panel now lists what the message box does: new line, keep typing on the next line, clear, and what one Escape does first when several things could happen at once (DOR-452).
- A **Session** panel behind the `⋯` at the end of the status line, on click or `Cmd+Shift+.`. It lists everything about the session with its live value — directory, git, runtime, model, context, cache, usage, permissions — plus sound and background refresh, and diagnostics: connection, how far the live link has caught up, how many messages are waiting, and the session id. On a phone it opens as a bottom sheet, most urgent first (DOR-452).
- **Copy diagnostics** in the Session panel puts everything above on your clipboard as one block of readable JSON — the thing to paste into a bug report (DOR-452).
- **Pin** any session row to keep it in the status line even when it has nothing to report, and **Reset pins** to clear them all. Your pins are saved with the rest of your settings rather than in one browser, so they follow you to your other windows, the desktop app, and Obsidian — and you can just ask an agent to pin something for you (DOR-452).
- When the conversation window passes 85% full and your agent is not mid-answer, a one-click **Compact** appears right beside the percentage instead of on a row of its own. It waits for the turn to finish, because compacting cannot start while your agent is still working (DOR-452).
- DorkOS can now ask you before an agent does something you cannot undo. When an agent requests
  approval, a card appears on your dashboard saying what would happen in plain words, with Allow
  and "Don't allow" buttons and how long you have to decide. The card shows up in every window you
  have open and disappears everywhere as soon as you answer (DOR-447). The countdown bar reaches the browser, including after a reload or in a second window.
- A **Session** tab in the right panel, next to Agent Profile. It shows everything about the session you are in and stays open while you work: whether the live connection is healthy, how long it has been since anything arrived, the full project folder, which model actually answered you, how full the conversation window is and what is filling it, how much came from cache, what your plan or spend looks like, and which helper agents are running or have finished this turn. Handy when a reply seems stuck and you want to see whether the problem is the connection or the agent. **Copy diagnostics** puts the whole picture on your clipboard for a bug report.
- Agents now have to ask before anything they cannot take back. Every DorkOS action an
  agent can run through the capability catalog carries a size: read only, ordinary
  change, or cannot be undone. Reading is free, ordinary changes go ahead and get
  logged, and anything that cannot be undone stops and waits for you, with
  plain-words instructions for the agent on what to do next. The check runs on every
  path an agent can reach: the API, the tools inside a session, and the tools an
  outside app like Claude Code or Cursor uses. Tools that are not in the catalog are
  not covered by this check (DOR-448).
- Your approval card now names the agent that asked and how consequential the
  action is, so you can tell who wants what before you answer (DOR-448).
- The activity feed now records what an agent tried and was not allowed to do, not
  only what it did (DOR-448).
- `dorkos call` takes an `--approval <token>` option, so an agent working from the
  command line can finish the same ask-and-retry flow (DOR-448).
- New guide, [Action Approvals](https://dorkos.ai/docs/guides/action-approvals), explaining
  when DorkOS asks you before an agent does something that cannot be undone: what the card
  on your dashboard shows, why an agent cannot skip the question by leaving its name off,
  why an approval works once and runs out after two hours, and how the activity feed
  names which agent did what (DOR-451).
- See when an agent is waiting on you, from any screen. A marker in the top bar says how many requests need your approval, and clicking it opens them right there so you can answer without leaving what you were doing.
- Requests clear themselves once they run out of time, so you are never looking at one you can no longer answer.
- Three new pages on dorkos.ai describe what shipped: Action Approvals, Agent Attribution, and the Capability Catalog (DOR-428)
- Press Escape once while you have something typed in a chat and a quiet note now appears just above the composer: **Press Esc again to clear**. Pressing Escape twice has always wiped a draft, but the first press did nothing you could see, so nobody ever tried the second one. The note shows up only while that second press would really work, and it is gone the moment it would not (DOR-479)
- Standing permissions now work. When you answer an approval with "and stop asking about this", DorkOS remembers it for one agent doing one action, for as long as your trust window says, and lets that agent get on with it without interrupting you. Every time it does, your activity feed says so, and one line tells you which permission let it through (DOR-501)
- You now decide which extensions may run their code inside DorkOS. That covers both halves of an extension: the part that runs on your computer, which can reach anything DorkOS can reach, and the part that runs on the DorkOS page in your browser, signed in as you. Until you say yes, neither one runs. The first time an extension tries, it waits: Settings → Extensions shows it with an **Allow it to run** button. One click and you are done. After that, editing, testing, and reloading that extension all work with nothing further to click, and turning it off and on again does not ask you again. **Stop it** on the same card takes the permission back and stops the extension right away. Extensions that ship with DorkOS never ask, because you already installed DorkOS.
- Your agents can see which extensions you have allowed, but they cannot add to the list. An agent that could allow its own extension would be approving its own code, so that answer is yours alone, alongside your other protected settings. The same limit applies as to those: with **Require login** off, which is the default, this holds against any agent that says who it is, and turning **Require login** on closes the rest.
- Updating or reinstalling an extension asks you again. New code is a new decision, even under a familiar name. Editing an extension you already allowed never re-asks, so building your own is still one click, once.
- A web page you visit cannot allow an extension for you. Requests to allow or stop an extension now have to come from DorkOS itself.
- Tell DorkOS to stop asking about one thing. An approval card now carries a third button, "Allow, and stop asking about this for 8 hours", that covers one agent doing one action, for a stretch of time you choose. Turn it on in Settings, under Security (DOR-501)
- Find and end a standing permission from either of two places: Settings under Security, or the approvals marker in the header, which now shows a quiet count when trust is live. Each one has a **Stop trusting** button (DOR-501)
- Choosing a trust level that skips prompts now says what it does not cover: actions on DorkOS itself, like removing packages, still ask. The line appears wherever a level is picked: the session picker, a channel binding, and a scheduled task (DOR-501)
- Group conversations now have somewhere to live. A **room** holds several people and several
  agents in one running conversation, keeps every message forever, and remembers where each
  member left off reading (DOR-524)
- Rooms come in two shapes: **channels** for a topic and **direct messages** for one-to-one. A
  side conversation hangs off the message it answers rather than taking the room over (DOR-524)
- An agent keeps the same name on everything it has ever said, even after DorkOS rebuilds its
  records in the background (DOR-524)
- Refuse to start a second DorkOS against the same data directory, and say which one already has it. Two servers sharing one directory used to corrupt each other's agents and history (DOR-532)
- **Channels** and **Direct messages** now sit in the left sidebar, beside your agents. Click one
  to open it and read what has been said. Both sections collapse, and DorkOS remembers whether you
  left them open (DOR-525)
- Make a channel straight from the sidebar: hit the **+** beside Channels, type a name, press
  Enter. Start a one-to-one conversation the same way — hit **+** beside Direct messages and pick
  an agent (DOR-525)
- A room shows who is in it, groups messages by who is talking, marks where one day ends and the
  next begins, and draws a line at the first thing you have not read. Open the room and the line
  stays put while you catch up; the unread count beside it clears (DOR-525)
- Where you left off reading is remembered by DorkOS, not by your browser — so it is the same on
  your laptop and your phone (DOR-525)
- Anything posted into a room you have open appears straight away, with no reload (DOR-525)
- The desktop app keeps running when you close its window, so your agents carry on working (DOR-538)
- A DorkOS icon in the macOS menu bar shows how many agents are working, and brings the window back (DOR-538)
- The first time you close the window, DorkOS tells you it is still running, and offers to quit if that is what you meant (DOR-538)
- Quitting while agents are mid-task now asks first: "3 agents are still working. Quit anyway?" (DOR-538)
- "Open in New Tab" opens a second DorkOS window instead of sending you to your web browser (DOR-538)
- Open your agents in tabs in the desktop app, the way you already work in a browser or an editor.
  The tab strip runs across the top of the window, and the `+` button opens another one (DOR-540)
- Those tabs tell you what your agents are doing while you are looking somewhere else. A tab lights
  up when its agent starts working, needs an answer from you, or hits a problem. You can leave five
  agents running and glance at the strip to see which one wants you
- Keyboard shortcuts for the desktop app's tabs: `Cmd/Ctrl+T` opens a tab, `Cmd/Ctrl+1` through `9`
  jump to one, and `Cmd/Ctrl+Shift+[` and `]` step between them. `Cmd/Ctrl+W` closes the tab you are
  on, and closes the window once it is the last tab. You can also reach the strip with `Tab`, move
  with the arrow keys, and close a tab with `Delete`. The `×` on a tab closes it too
- Your desktop tabs come back after a reload, and each window keeps its own set
- "Open in New Tab" in the command palette opens an agent without losing the one you were reading.
  In the desktop app that is a DorkOS tab; in a browser it is a browser tab, which you can bookmark
  or drag onto a second screen yourself
- The desktop app's command palette also has "Open in New Window", which opens a second DorkOS
  window on the agent you picked. Handy for a second screen. A browser has no separate answer to
  that, so the choice is not offered there
- See the address DorkOS is running on in Settings → Server, with a button to copy it and a button to open it in your browser. The MCP endpoint is right below it, ready to paste into Claude Code, Cursor, or Windsurf (DOR-539)
- Agents now answer in rooms. Post in a channel or a direct message and every agent the message is meant for takes a turn and replies, right there in the conversation. Each agent keeps its own thread of context per room, so what you say in `#backend` stays separate from your one-to-one chat with the same agent (DOR-526)
- A new setting, `rooms.maxAgentDepth`, caps how many replies in a row agents may send each other before a room stops them and says so in the conversation. Messages from you start the count over, so a room that has gone quiet is one message away from running again. Set it to `0` to turn automatic replies off (DOR-526)
- Two more settings put a ceiling on what automatic replies can cost you: `rooms.maxAutomaticTurnsTotalPerHour` (240 by default) caps how many DorkOS runs in an hour across every room you have, and `rooms.maxAutomaticTurnsPerRoomPerHour` (60) stops any single room using up that whole allowance. Both count no matter who the message looked like it came from, and the room says so when it stops. These are the ones that hold if **Require login** is off — see the note below (DOR-526)
- Agents in a room now show their emoji and colour, the same way they do everywhere else in DorkOS (DOR-526)
- Say something in a channel or a direct message. Rooms used to be read-only from the cockpit — the line at the bottom said so — and now there is a message box: Enter sends, Shift+Enter starts a new line, and everyone in the room, agents included, sees what you wrote (DOR-526)
- Your words are never thrown away. The box empties as soon as you press Enter, so you can start the next sentence right away; if a message can't be sent, it comes back into the box — above whatever you've typed since — with a note saying what went wrong. That holds even if you've moved to another conversation in the meantime, or sent another message after it: the words go back to the room you wrote them in, and are waiting there when you return (DOR-526)
- Half-written messages keep. Start typing in one channel, go read another, come back — your sentence is where you left it. Each channel and DM keeps its own (DOR-526)
- A direct message can hold several agents. The "+" beside Direct messages now lets you pick more than one: type a name and press Enter to add it, then keep going. Everyone you pick shows as a tag, so you can see who is in the conversation before you open it. One agent gives you a one-to-one; two or more give you a group named after the people in it. Backspace takes back the last agent you added, and Escape closes without opening anything (DOR-571)
- Channels and direct messages now have a docs page. It explains what a room is, how a channel
  differs from a direct message, and how both differ from a session, plus how to create each one
  (DOR-565)
- Channels and direct messages now have a menu, on right-click and on the "…" button beside the row: mark as read, add agents, members, rename, edit topic (channels), and archive. It matches the menu agent rows already have.
- A members panel shows who is in a room, lets you add or remove agents, and — for the first time — lets you choose when each agent replies there: to everything, when spoken to, only when @mentioned, or not at all. Until now that setting was fixed the moment an agent joined.
- On a one-to-one conversation, the menu has a shortcut straight to that agent's profile.
- When you add agents to a room, each one drops off the list the moment it is in. If one doesn't make it, it stays picked so you can try that one again without adding the others twice.
- See the exact commands a package sets up before you install it. The install preview now lists each one, word for word, next to a plain description of when it would run (DOR-635)
- See the jobs a package will schedule, when they run, whether they start switched on, and how much each one may do without asking you. Shapes used to create timed jobs that no preview mentioned at all (DOR-635)
- You can now pick the agents when you make a channel. The **+** next to "Channels" opens a dialog that asks for a name and who's in it, instead of just a name. A channel with nobody in it has nobody to answer you, so this is now one step rather than a thing you couldn't do at all. If you really want an empty one, "Create it without agents" is still there (DOR-599)
- You can add agents to a channel any time afterwards, from three places: the row of faces at the top of an open channel, the "Add agents" button in a channel with nothing in it yet, or a right-click on the channel in the sidebar. All three open the same panel, which is also where you remove someone and set how each agent decides when to reply in that channel (DOR-600)
- Two new settings for rooms: `rooms.replyWaitMinutes` (how long a room waits for an answer, 10 minutes by default) and `rooms.lateReplyCeilingMinutes` (when it gives up and says the agent could not finish, 60 minutes by default). (DOR-621)
- Your channels and direct messages are now in the command palette. Press Cmd+K and, before you type anything, you see what is unread, most pressing first. Type `#` to jump to a channel by name, or `@` to open a conversation with an agent. The palette now tells you what each of those keys does, so you do not have to know already.
- Sidebar groups can now hold channels and direct messages alongside your agents. Put the channel, the conversation and the agent for one project in the same group, sorted and filtered together. Grouped rooms move out of the Channels and Direct messages lists, so each one shows up in exactly one place.
- Type `@` in a channel or a direct message and a list of everyone in it appears — people first, then agents. Pick one and the message is addressed to them: an agent you name will answer, a person you name just gets told. Arrow keys move through the whole list, Enter takes the highlighted one, and typing narrows it down.
- The picker writes the name that actually reaches someone, which is not always the name on screen. An agent called "Mio Clicker PM" answers to `@mio-clicker-pm`, and typing its full name by hand reaches nobody at all. Pick it from the list and the right thing gets written for you.
- An agent that no `@` name can reach still shows up in the list, greyed out and saying so, instead of quietly going missing.
- Ask an agent how DorkOS works and it looks the answer up instead of guessing. Agents now come with a skill that searches the DorkOS documentation. It reads the one page that answers your question, then tells you which page it came from. When the docs do not cover something, it says so plainly rather than inventing an answer. DorkBot picks this up the next time DorkOS starts. Every agent you create from now on has it too (DOR-661)
- Connector packages now stand out in the Marketplace. Packages that connect your agents to services like Gmail or Slack get their own CONNECTOR badge, and a new "Connectors" filter in the sidebar shows only them. The plain "Adapters" filter still includes them (DOR-704)
- The features page on dorkos.ai now lists Connections, marked alpha: connect a service once, and you always see where your sign-in lives (DOR-704)
- DorkBot now asks what kind of work you do, right after you pick its personality during setup. Answer with a tap or type your own, or skip it and never be asked again. Your answer stays on this machine: it goes to your own agents so they know who they work for, and it is never included in any telemetry payload. Tests hold that line. Every agent session now opens knowing your name, your work, and your tools, once you have shared them. If you set up DorkOS before this question existed, DorkBot asks once in the sidebar, with a one-tap "Don't ask again". (DOR-705)
- After you answer, DorkBot suggests a couple of services that fit your work, like Gmail and Greenhouse for hiring. One line, no setup pushed on you. (DOR-705)
- Saving your Composio or Nango key now turns that connector on instantly — no restart. Delete the key and it switches off the same way (DOR-371)
- Your agent can now connect services when you ask. Say "connect my Gmail" and it replies with the sign-in link and a plain sentence about where your login lives; attaching the account to a session still asks you first (DOR-371)
- Accounts connected through your own Nango server now give your agent a tool that can call that service's API — your logins stay in your database the whole time (DOR-415)
- Offer a remote tool server as something you can connect to, by listing it in your config file under `connectors.rawMcpServers` (DOR-371)
- A new Connections screen lets you link Gmail, Slack, and other services to DorkOS. Paste your provider key once, click Connect on a service, sign in, and the account appears with a plain sentence about where your sign-in lives. You can hold two accounts of the same service — "Gmail (work)" and "Gmail (personal)" — and disconnect any of them anytime (DOR-708)
- Sessions grew a quiet Connectors section in the Session panel: attach a connected account to the session you're in (you see the custody sentence again before you confirm), detach it with one click, and get told plainly when an attached account has expired and needs a reconnect (DOR-708)
- Do you use more than one Claude Code account on the same computer, maybe one per client? You can now choose which account DorkOS runs your work on, and switch any time. Your session list shows work from all of your accounts together, and each session is labeled with the account it belongs to. Reopening an older session always runs it on the account that created it. This setting only changes DorkOS. Your terminal and the `claude` command keep working exactly as before.
- Agents in a channel now stay in the conversation after you talk to them, instead of needing an `@mention` on every message. Ask one something and it keeps answering your follow-ups for about ten minutes, or until five messages from other people have gone by — whichever happens first. Talking to it again starts both over
- This is a new setting — **Engaged**, on the room's quiet-to-loud scale — and you pick it per agent in the room sheet. The other settings are all still there
- Two settings control how long that lasts: `rooms.engagedWindowMinutes` (10) and `rooms.engagedWindowPosts` (5). Set either to `0` and an agent goes back to needing an `@mention` every time
- You can now see when an agent is working on your message in a room, and when it's taking longer than usual. A line under the message box names whoever picked it up and counts how long they have been at it — "Kai is working on it · 42s". Past three agents it counts them instead, and you can tap it for the names
- The line is honest by design. It shows only while an agent really has your message in hand, and it goes the moment the answer lands or the room explains why there isn't one. Nothing an agent decides can switch it on or keep it on
- It survives a bad connection. The room repeats the signal every 10 seconds, so opening a room in the middle of a long reply — or coming back after your connection dropped — tells you what is happening within 10 seconds instead of showing you a room that looks empty. If the server stops, the line clears itself rather than sitting there saying "working" forever, and if your browser loses the room's live connection the line goes instead of freezing
- You can now reply to a single message in a room instead of answering into the whole conversation. Hover a message and a small toolbar appears on it with "Reply in thread" — your reply gathers under the message it answers, where everyone in the room can follow it without it burying the conversation around it. Threads have always shown up in the cockpit; until now the only way to add to one was through the API
- Right-click a message for the same actions, or press and hold on a phone for them to slide up from the bottom. It is the same short menu either way, and the same one the sidebar already uses. On a touch screen the press-and-hold is the only way in — tapping a message reads it, it doesn't offer you a menu
- Alongside replying, the menu copies a message's text — telling you it did, or that it couldn't — and offers to mention whoever wrote it, dropping the exact name that reaches them into the message box so you can be sure it will land. Mentioning is left out when nothing would come of it: on your own messages, and on anyone an `@` cannot reach
- The menu works without a mouse, and it stays out of your way. Tab moves between messages, one press each, however many actions a message has. On the message you're on, an arrow key or Enter steps into its actions, arrows move along them, and Escape comes back. Choosing "Reply in thread" puts the cursor straight in the message box, pointed at that thread
- While the box is pointed at a thread it says so, right above where you type, with a way to point it back at the room. It stays pointed there after you send, so a back-and-forth inside a thread does not mean choosing "Reply" again for every sentence
- Replying to a reply keeps you in the same thread rather than starting a new one under it. Rooms stay one level deep on purpose, so the conversation reads the same way for everyone
- A reply reaches the agents you name in it, exactly as a message to the room does. Say `@ana` in a thread and Ana picks it up, and answers in that same thread
- **One line at the top of the sheet says what the room will actually do** — "Two agents will answer you here", "Only @mentions get an answer here", "There is nobody here to answer you" — with a small meter beside it. It names the odd one out when there is exactly one worth naming.
- **Taking an agent out of a room can be undone**, the way archiving a whole room already could. Putting it back restores how loud it was, rather than resetting it to what a brand-new arrival gets. Take two out in a row and you are offered **Undo** for each of them.
- **A one-to-one says what a second agent would do to it** — "Adding a second agent turns this into a group conversation" — before you add one, instead of leaving you to work it out from the faces afterwards.
- **Agents arrive and leave instead of blinking in and out.** An agent you add opens into place and glows once, so you can see where it went. One you remove collapses its row, so the **Undo** offer refers to something you watched happen. Opening a scale slides it open. An agent that is working has a pulsing dot rather than a still one. All of it stops moving — without anything disappearing — if your system is set to reduce motion.
- You can react to any message in a room. Hover it and the toolbar now starts with your three most-used emoji — one click to say "got it" to an agent without spending a message. The 🙂+ beside them opens a searchable picker for everything else, and on a phone a long press brings the same row up in the drawer.
- Reactions show up under the message as small pills. Yours are outlined in orange, and clicking one again takes it back. Hover a pill to see who reacted, by name. New ones pop in as they land, and they arrive live — someone reacting in another window shows up in yours without a reload.
- Your reaction reaches the agent quietly. It lands in the agent's memory of the room as an acknowledgment: no reply, no new turn, nothing to pay for.
- Choose which model new chats start on, and how hard they think. Each runtime gets its own pair of settings, because a model name only means something to the runtime that offers it — so Claude Code, Codex and OpenCode each have their own. Leave them alone and nothing changes: every runtime keeps picking for itself, exactly as before. Set one and every new chat on that runtime starts there, while chats you already have keep what they are running with. OpenCode gets a model setting but no thinking setting, because OpenCode gives no way to ask for more or less thinking and we would rather say so than pretend. Room agents benefit most: until now a room reply had no way to say which model it should run on. You choose them in **Settings → Runtimes**; on disk they live in `~/.dork/config.json`.
- Threads now open in a panel beside the room. A message with replies shows one quiet line under it — "↳ 3 replies · last 9:45 AM" — and clicking it opens the whole thread next to the conversation, with its own box to write in. The room's own scroll stays the room's, however long a thread gets. On a phone the thread takes the screen and a Back button returns you.
- A thread with replies you have not read shows that line in colour, with a count of what is new. It is worked out from where you left off in the room, so it agrees with the "New messages" line a few pixels above it.
- The waiting line follows you in. When an agent is working on something inside a thread, "Kai is working on it" appears in the panel rather than under the room, so the wait is shown where the work is happening.
- A thread has an address. The link in your browser bar now names the open thread, so a refresh keeps it open and a link you paste to somebody opens the same thread you were reading.
- Give one agent its own model and its own thinking level, instead of one answer for the whole machine. The agent that reviews your diffs can run on the big model while the one watching a room runs on the quick one. What an agent says about itself wins; anything it leaves unsaid falls back to your default for that runtime, and an agent that says nothing keeps working exactly as it did today. Room agents get the most out of this: a room reply now starts on whatever the agent it addressed asked for. You choose them in that agent's **Config** tab; on disk they live in its own `.dork/agent.json`.
- **Settings → Runtimes now lets you choose what a new chat starts with**: which runtime, which model, and how hard it thinks. The runtime setting has been in DorkOS all along with nowhere to change it — this is its first screen. Model and effort are per runtime, because a model name only means something to the runtime that offers it. Change anything and DorkOS tells you the truth about when it takes effect: new chats start with it, chats already running keep what they have.
- **Under that card, every agent that runs on something else.** Agents that are simply set up differently are listed plainly; agents whose setup has stopped working — a runtime you have not connected, a model that is no longer offered, a thinking level on a runtime that has none — come first, in amber. Click any of them to land in that agent's own settings. When every agent is on your defaults, the list isn't there at all.
- **Model and thinking level joined the runtime dropdown in an agent's Config tab**, each wearing a small chip that says where the value came from: "server default · Opus", or "set here" when this agent picked its own. The chip is also the undo — click a "set here" chip and the one thing it offers is going back to your default. On a phone the rows open a sheet from the bottom with the same choice at the foot.
- Where a thinking level cannot work, DorkOS says so instead of hiding the row: "Not supported by OpenCode", or "This model doesn't take an effort setting". If one is already saved there, it says that too, and lets you clear it.
- **A Threads list in the sidebar**, above your channels. Every thread you started or replied in is there, whichever room it lives in, with the most recently answered at the top. Each row shows what the thread was about, which room it is in, and how many replies it has — so finding your way back to a conversation no longer means remembering which channel it happened in and scrolling for it.
- A thread with replies you have not read shows the count beside it, the same way an unread channel does. Reading the room clears it, because a thread shares its room's place-marker.
- Clicking a row opens that room with the thread already open beside it, on the exact thread you clicked. The section collapses like the others, and DorkOS remembers whether you left it open.

  You are in a thread because you wrote it or answered in it — there is nothing to follow or unfollow, and nothing to keep tidy. The section only appears once you are in a thread, so a fresh install is not given a heading it cannot fill.

- **A small dot beside a room in the sidebar while an agent is working in it.** Ask a question in one channel, go and read another, and you can still see that the first one is busy — without opening it and without wondering whether anything happened. The dot appears the moment an agent picks the work up and goes out when the answer lands.
- It is honest about how many: a screen reader hears "2 agents working" when two of them are on it.

  The dot is never a guess. It exists exactly as long as real work does, so if DorkOS stops running mid-answer, every dot goes out within half a minute rather than sitting there claiming something is still happening.

- `dorkos doctor` now finds the problems that used to only show up as strange behaviour later: a room whose saved conversation has gone missing from disk (the reason an agent sometimes answers as if it has never met you), agent messaging rules DorkOS could not read, saved chat integrations whose settings are unreadable, chat connections pointing at an agent or an integration that no longer exists, and the same agent id claimed by two different folders.
- Those checks need DorkOS to be running, so they live behind `dorkos doctor --deep`. If DorkOS is not running, it says so and skips them — that is not a problem with your setup.
- `dorkos doctor --json` prints the same results as plain JSON, so you can pipe them into another tool.
- `dorkos doctor` now also checks how many files your system lets DorkOS keep open at once. Too few, and DorkOS starts failing in ways that never mention files.
- Rooms now tell you when an agent has gone quiet because it is waiting on you. If it stops to ask permission for a tool, or asks a question, and nobody has answered a minute later, the room says so and points you at its session — instead of sitting there looking busy until the request quietly expires. Quick approvals stay quiet, so a room does not fill up with notes about pauses that lasted seconds.
- Every room has a **Stop** button in its header while agents are working. It stops the work; it is not something you can ask for in a message, because an agent stuck in a loop will just reply to that.
- When your agent asks permission and you answer, the card now settles into the conversation as a receipt — a one-line record of the ask and your answer, right where it happened. Allowed and denied requests say so by name; a request nobody got to says it expired and how long it waited. Answering several at once leaves one line with the details a click away.
- When DorkOS decides not to do something — an agent skips a message, a room runs out of automatic replies, a prompt times out with nobody watching — it now writes one line saying exactly why. The ones you were never told about are recorded as warnings, so they stand out instead of blending into the ordinary chatter. That is what makes "the room just went quiet and I don't know why" a question with an answer.
- New: `dorkos debug` answers the questions you can only ask while DorkOS is running. Which agents are working right now and for how long, what was recently declined and why, which conversations have a live connection, and whether a room's agents still have their history on disk. It reads ids, counts and times — never the text of anything anyone wrote — and stores nothing. Run `dorkos debug --help` to see the subjects.
- Reopening a conversation now shows the permission asks and answers, right where they happened. What you allowed, what you denied, and what ran out of time before anyone got to it are kept with the turn they belong to, so the record is still there tomorrow — not just for as long as the tab stays open.
- Turning on **Full autonomy** now asks you to acknowledge what it means — once, if you tell it to stop asking. Tick **Don't show this again** and DorkOS writes down the date and stops asking; leave it unticked and it asks again in your next conversation, as before.
- Settings → Security shows the date you acknowledged it, with a **Reset** button. Resetting brings the confirmation back the next time you reach for Full autonomy, and takes effect everywhere within about half a minute — a tab you left open can skip it once more before it catches up. It changes nothing about a conversation that is already running — only the asking comes back.
- **Tell DorkOS how much new sessions may do — once.** Settings, in the card that already holds the model and effort a new chat starts with, now asks where new chats should start: **Ask first**, **Act**, or **Full autonomy**. One choice covers every agent you run — the three words mean the same thing whichever one you are talking to — and underneath, a line per runtime says what that choice actually means for it, including where a runtime cannot pause to ask. **Ask first** stays the out-of-the-box default, and chats you already have keep what they are running with. Changing model, effort, or trust level before your first message no longer silently locks the chat to Claude Code: the runtime you actually start on is what applies.
- **Something different for one agent?** "Customize per runtime" opens a row for each, with the same dial and a way back to the shared setting.
- **Make it the default right where you decided it.** After you change a chat's trust level, a quiet line appears under the dial for a few seconds — _Start every new session in Act? **Make default** · Dismiss_ — so the habit is caught where it happens instead of costing you a trip to Settings. It stays quiet when that stop is already where new chats start, and it takes no for an answer for the rest of the conversation.
- **Full autonomy is a choice you acknowledge once**, in Settings or right where you just made it. DorkOS asks what it means at the moment you choose it and writes down that you read it; from then on new chats start without asking, and Settings keeps a quiet note saying so with a link to change it back — naming the agent, when it is only set for one.
- **Say why you said no.** When an agent asks permission and you want to refuse, the approval card now offers **Add a reason** — one line, entirely optional. What you type goes to the agent with the refusal, so instead of trying the same thing again it can take another route. Deny on its own still works exactly as before: click Deny, press Esc, and nothing slows down.
- **The transcript says whether the agent heard you.** A denial you explained reads _You denied `rm -rf node_modules` — agent was told why_. A denial you did not explain says only that you denied it, and a request that ran out its ten minutes still reads _Expired — denied_, because a clock explains nothing. The line only claims the agent was told when the reason actually reached it.
- **DorkOS now tells you when something is running without asking and nobody is there to answer.** If a chat integration or a scheduled task is set to **Full autonomy**, a quiet amber line sits under the header on every page: _The Deploys integration and the Nightly cleanup task run without asking. Nobody is watching, so nothing waits for your approval._ It names them rather than counting them, and puts a button beside the words that takes you to the integration or the task so you can change it in a couple of clicks.

  This is the one place that fact had no home. A chat you are sitting in front of shows its trust level in the status strip, right where you are looking. A schedule that fires at 3am and an integration that answers a message from your phone show it only on the screen that configures them — the screen you are not on. The banner appears the moment you turn one on, stays while it is true, and disappears on its own when you dial the last one back. There is nothing to dismiss and nothing new to configure.

- **See every file and link your agent touches, live.** Each reply now carries a
  row of small chips — one per file, page, or command the agent handled — and
  each one moves the way its job moves: reading sweeps across the name, searching
  passes a beam through it, editing scribbles and counts the lines as they land,
  a new file draws its own outline, a deleted one is swallowed by the bin and
  stays behind, struck through, so a deletion is never invisible. The moment a
  job finishes, its chip goes still. Nothing you can see moving is over.
- **The row stays short, and nothing gets lost.** Only the four newest chips stay
  out front; older ones slide into a small pile beside them that counts what it
  holds. When the reply is done, the whole thing folds into one quiet line —
  `📖 21 · ✏️ 3 +34 −11 · 🌐 9` — and **show all** opens the full list, which you
  can filter by what happened and read either grouped or in the order it
  happened. A file that was read and then changed does not get a second chip: the
  one already there turns into the edited one where it stands.
- Click a chip to open that file or page beside the chat. Hovering one tells you
  the whole story of it — every time it was touched, in order.

### Changed

- When your agent's sign-in stops working, chat now shows a clear message with a "Fix sign-in" button that takes you straight to Settings to sign in again, instead of a raw error. Works for Claude, Codex, and OpenCode.
- You can now change how OpenCode is powered without disconnecting first. A connected OpenCode shows a Change link that reopens the power-source picker with your current source labeled ("Currently: On your computer (Ollama)"), so switching from your own computer to the cloud, or the other way, is one clear choice (DOR-427).
- The model menu for local (Ollama) models now offers only the models that are actually on your computer, so you never pick one that isn't installed and watch the turn fail. Add more models from the local panel as before (DOR-427).
- Status bar settings now sync, and your agents can change them for you. What the status line shows used to be saved only in the browser you set it in. Now it lives with the rest of your settings, so a choice you make in one window shows up in your others and in the desktop app, and you can just ask an agent to change it. In this same release the ten per-item on/off switches became a single list of pinned items, so read the status line entry for what that means and what carries over (DOR-431)
- A runtime that shows "Ready" now still lets you fix its sign-in. "Ready" only checks that a key or login exists, so a stale key or an expired login can still read Ready. Open Settings, then Runtimes, and use the quiet "Fix sign-in" link (or "Change" for OpenCode) to sign in again or paste a fresh key, without disconnecting first.
- The message box no longer greys out while the session is busy, so your cursor and your place in the text stay put. Sending is still held until the session is free (DOR-452).
- Opening a session on a phone or tablet no longer pops the keyboard and scrolls the page — the message box only takes focus on desktop (DOR-452).
- The hints under the message box now teach the backslash trick and stop rotating after you have seen them three times through. "Press Esc twice to clear" is gone; we would rather not advertise the destructive one (DOR-452).
- The status line is now **quiet by default**: it shows who you are talking to, which model is answering, and which folder it can touch — and stays silent about everything else until there is something to say. Context appears at 70% full, git when the tree is dirty or you are off the default branch, permissions when they are not the default, runtime when it is not the usual one, usage when you are near a limit, and connection when the live link drops. A number that always reads 34% is wallpaper, so the 91% that matters would not register either (DOR-452).
- The status line is one row with two sides at every screen size: who and where on the left, state and numbers on the right. Nothing is centred on a phone and left-aligned on desktop any more, and no separator is ever left floating in the gap between the two (DOR-452).
- The status strip above the message box — "Waiting for your approval", the thinking verbs, the post-turn summary — no longer re-centres itself on narrow screens (DOR-452).
- The status line now measures the space it actually has and fits itself to it, instead of guessing from the screen size. On a narrow window it keeps the things most likely to be a real problem — a dropped connection, a nearly-full context window, a usage limit — and shows how many it left out as a small `+2` beside the `⋯`. Everything it left out is still in the Session panel, one tap away (DOR-452).
- Status items are easier to hit on a phone: every one of them, and the `⋯`, now has a touch-sized target (DOR-452).
- Chat now shows who sent each message, with day and unread separators.
- Every message has an avatar and a name on the left, and a run of messages from the same sender groups under one header — the layout you already know from Slack. This replaces the old right-aligned bubbles for your own messages, which could only ever show two sides of a conversation.
- The list separates itself by day, so you can tell at a glance when something happened. If a conversation moved on while you were away, a "New messages" line marks where you left off.
- On a narrow window the status line now says things in fewer words. The runtime drops the model name the item next to it already shows, the model drops its effort and Fast tags, and a long trust level gets shortened — all of it still spelled out in full in the Session panel. "Default (recommended)" now reads "Default" everywhere: the parenthetical is advice for picking a model, not news about the one you picked (DOR-452).
- Anything still too long for the row now ends in an ellipsis you can see, instead of being cut off where nothing hinted it was there (DOR-452).
- Marketplace installs, uninstalls, and new packages requested by an outside agent now go through
  the same approval card as everything else, so there is one place to look and one way to answer.
  You get two hours to decide instead of 5 minutes (DOR-447).
- The Agents page now shows your fleet in **attention order**: whatever needs you leads, instead of an alphabetical inventory list. Rows group into **Needs you**, **Working**, and **Quiet**. Pick a different sort, by name for example, and the groups flatten.
- **Working** now reflects chats across your whole fleet, not just the project you happen to have open. An agent counts as working when a chat in its folder is live, or was live within the last hour, even while you are looking somewhere else.
- Each row now says what the agent last did, in plain words: "Finished a reply", "Got a message", "Cannot be reached". The time it happened sits underneath. If a chat with the agent is waiting on you — for a permission you have not answered, or after an error — the row says so and moves to the top.
- A new **Scheduled** column shows how many scheduled tasks are waiting on each agent. An agent that has gone quiet for a day with tasks still scheduled is flagged as needing you, because those runs are failing.
- The **Status** and **Sessions** columns are gone. Health now shows in the group a row sits in, the ring around the agent's avatar, and the row's own wording — three quieter signals instead of the same word repeated down the page. You can still filter by status. The old session count was never a count of open chats, so nothing replaces it.
- The agent's runtime and project moved under its name, which frees up room and makes the page much easier to read on a phone.
- A long request on an approval card is trimmed to two lines, so the Allow and
  "Don't allow" buttons stay where you expect them (DOR-448).
- If DorkOS cannot check what is waiting for your approval, the dashboard says so
  and offers to try again. Before, a failed check looked exactly like having nothing
  to answer, which could leave an agent waiting on you with nothing on screen
  (DOR-448).
- Uninstalling a marketplace package now asks you once, not twice (DOR-448).
- When a conversation has to be restarted under a new id — which can happen when an older chat is reopened and cannot be picked up where it left off — the list now shows only the one you would actually land in. Before, the old entry stayed in the sidebar and quietly opened the newer conversation instead, showing the older one's trust level. If a chat you remember seems to have vanished, look for the newer entry with the same conversation in it; nothing is deleted.
- The `relay_inbox` tool now says plainly that `ack` destroys the messages it hands back. The content is deleted and cannot be recovered, so an agent that wants to look without clearing should leave `ack` off. (DOR-506)
- The tool approval guide used to say DorkOS agent tools skip the approval card "because these tools cannot modify state". That was not true of `relay_inbox`, which deletes messages when it acknowledges them. The guide now gives the real reason: these tools carry their own permission checks, and an agent polling its inbox all day would bury you in cards you would soon dismiss without reading. (DOR-506)
- Standing permissions need **Require login** on. Without it DorkOS cannot tell you apart from an agent running on the same computer, so the control is shown but switched off, with the reason and the fix right above it. Turning the feature off ends every permission that is live, and says so before it does (DOR-501)
- When DorkOS turns down an answer you gave on an approval card, it now tells you what actually happened instead of "Action failed". The case that matters most: if the action went ahead but the permission could not be saved, it says so plainly, so you never repeat something that cannot be undone (DOR-501)
- If DorkOS cannot check which standing permissions are live, both places that list them say so and offer to try again, rather than showing an empty list that reads as "nothing is trusted" (DOR-501)
- The Settings tab where you set up Telegram, Slack, and webhooks is now called "Integrations" instead of "Channels" — same setup, clearer name now that "Channels" means something else in DorkOS (Slack-style conversations, which now sit in the sidebar).
- Each agent's "Channels" section, where you link it to Telegram, Slack, or a webhook, is now called "Integrations" too.
- A session badge that used to read "Channel" for messages arriving from Telegram, Slack, or a webhook now reads "Integration".
- Our own documentation described a few protections DorkOS does not have, and oversold some it does. The protections were never missing; the writing was wrong. Fixed:
  - **Three things an agent cannot take back, not one.** The docs said removing an installed package was the only action that stops and asks you. Deleting a scheduled task and removing an agent stop and ask too, and have since the permission gate was widened. One page even said an agent could delete a scheduled task without asking, which was the opposite of what happens.
  - **Bypass permissions does not turn everything off.** It skips the prompts inside a session, so an agent edits files and runs commands without stopping. The three actions above still wait for your answer.
  - **Tool group switches are guidance, not a lock.** Turning a group off changes what an agent is told about, so it stops reaching for those tools. It does not take the tools away. The pages that called this "controlling which tools an agent can access" now say what it does.
  - **Every protection now names the login it depends on.** With Require login off, which is how DorkOS starts, DorkOS refuses the agent that asked for something but cannot tell you apart from other software running as you on the same computer. With login on, only your signed-in account can answer. Both are real, and the docs used to state only the stronger one.
  - **"Secure by default" is gone.** In its place, the narrow claim that is actually true: DorkOS listens only on your own machine by default. We deliberately did not replace it with "sign-in required the moment you expose it", because that is not true of our Docker image: the image binds to every network address and switches off the guard that would otherwise refuse to start without a login, which our Docker guide already told you.
  - **Tool group switches are per-agent, but permission is not.** One thing genuinely is per-agent: a standing permission you grant from an approval card covers one agent doing one action, so two agents can meet the same gate and get different answers.
- The [Security page](https://dorkos.ai/security) has a new section on what an agent cannot do without asking you, including the limit, and the [Threat Model](https://dorkos.ai/docs/self-hosting/threat-model) now explains the three permission labels, where the approval gate sits, and the two ways traffic can reach DorkOS without passing the bind guard.
- The 0.8.0 release post carried the strongest version of the tool-switch claim. Rather than quietly rewrite a dated announcement, we left the wording and added a correction note at the top of it.
- The desktop app keeps only the tab you are looking at connected to its agent. Background tabs let
  go, then pick the conversation back up with nothing missed the moment you return. A window full of
  tabs costs no more than one
- On the desktop app, the Window menu now says "Close Tab" for `Cmd/Ctrl+W`, because that is what it
  does. "Close Window" still closes the whole window
- The desktop app now runs on `http://localhost:4242`, the same address as the command line, instead of a new random one every time you open it. Bookmarks and MCP setups keep working from one launch to the next. If something else already has that port, DorkOS takes the next free one and Settings shows you where it landed (DOR-539)
- You can pin the desktop app to a port of your own with `dorkos config set server.port 5000`, the same setting the command line reads. A port you pick this way is one DorkOS stays on: if it's taken, the app says so instead of quietly answering somewhere else and breaking whatever you pointed at it (DOR-539)
- Settings → Server now says when it can't reach the server, and offers to try again, instead of showing an empty panel (DOR-539)
- Changing who is in a room, or how an agent behaves in one, is now something only you can do. Agents used to be able to do both, which was harmless when nothing acted on it — now that a message makes agents reply, an agent could have used it to start a conversation nobody asked for (DOR-526)
- Asking for a conversation you already have opens that one instead of making a second copy. DorkOS now recognises a direct message by exactly who is in it, so picking the same people again takes you back to the same place, history and all — and if you had archived it, it comes back out. It keeps its name and its place in the list, because opening a conversation is not the same as something happening in it. "You and Ana" and "You, Ana and Kai" are still different conversations, so every agent stays available whether or not it already has one (DOR-571)
- If you drive DorkOS through the API, `POST /api/rooms` now answers `201` when it made a room and `200` when it handed you one that already existed. The two replies look identical otherwise, so this is the only way to tell a brand-new conversation from one with a month of history in it (DOR-571)
- DorkOS now sends us nothing unless you turn it on. The daily heartbeat, marketplace install counts, and feature-usage events used to be on by default. All three are off, and they stay off until you say yes in the Privacy & Data settings tab or with `dorkos telemetry enable`. If you already chose to keep sharing, your choice is kept exactly as it was and nothing changes for you. If you never answered, sharing stops
- The first-run notice now explains what you could share and how to turn it on, instead of telling you sharing is about to begin. On a machine you set up for someone else, `DO_NOT_TRACK=1` still keeps everything off no matter what the settings say
- A chat integration binding that never had a trust level picked for it now
  prompts, instead of quietly auto-accepting. Bindings you already configured
  keep the setting they had. If a channel of yours starts asking about shell
  commands it did not ask about before, that is this change, and you can set the
  binding to "Bypass permissions" if that channel is one you trust (DOR-604)
- Renaming a channel now changes its `#name` too. Before, the new name was saved but the sidebar kept showing the old one.
- Archiving a room asks first, and the confirmation comes with an Undo so you can bring it straight back. If the Undo can't work — someone took the name meanwhile — it now says so instead of a blank "Action failed".
- A channel you archived can come back under a different name when something else took its old one. Before, it could not come back at all.
- Deleting a task now also deletes its run history, and that is permanent. Before this, deleting a task with any run history simply failed with an error, so nothing was lost — and nothing was deleted either. Two knock-on effects worth knowing: the runs are gone from the task's history for good, and any chat session that task started will no longer show that it came from a task.
- Naming a new task "Templates" is now refused, with a message asking for a different name. That folder name is reserved for the starter tasks.
- To pause a task, switch it off. Marking a task "paused" directly is no longer accepted, because it never lasted — DorkOS uses that mark for its own purposes, such as noting that a task's file has gone missing.
- **If you already have a Telegram bot in a group chat, it will now be quieter.** It used to reply to every single message. Now it replies when someone mentions it by name (`@yourbot`), when someone replies to one of its messages, and when someone sends it a command. It stays quiet the rest of the time.
- One-on-one chats have not changed. Your bot still replies to everything you send it directly.
- You can change this. Open Settings, go to Integrations, click Configure on your Telegram bot, and continue to the second step. Under "Replies in Groups", choose "Every message" to get the old behavior back.
- Anonymous group admins still get replies. Telegram sends their messages in a way that looks like a bot, but they are people, so your bot treats them like anyone else in the group.
- Your agent's instructions now explain the marketplace tools (search, install, and the rest) the same way they already explain relay, mesh, adapters, and scheduled tasks. Marketplace was the only one missing this, so an agent had less to go on when deciding how to search for or install a package (DOR-529)
- The install preview describes what a scheduled job may do in plain words, like "can run any command without asking you", instead of showing a setting name only a developer would recognise (DOR-635)
- If a package declares commands in a form DorkOS cannot read, the preview says so. It used to show nothing, which looked exactly like a package that runs no commands (DOR-635)
- An agent answering in a channel or a DM now knows who else is there, and which of them are people rather than other agents. It also gets the room's topic, the messages it has not read yet, what it said there recently, and how many automatic replies are left. Before this it got the one message and nothing else, so it could not tell a colleague from a bot and had no way to follow the room's etiquette rules. (DOR-622)
- The message an agent receives is now exactly what the person typed. DorkOS used to wrap a sentence of its own around it, which then showed up in the session transcript as words nobody wrote. (DOR-622)
- A name nobody in the room has stays ordinary text. `@99` in "refunded @99" is a number, and an email address is an email address — neither is a failed mention, so neither is treated as one. Pressing Enter sends the message as usual.
- Replies in a channel now gather under the message they answer, behind a small "3 replies" line. Threads used to be separate rooms you opened on their own, so following one meant leaving the channel and coming back; now you read the whole conversation in one place.
- When the message a reply answers is older than the history that has loaded, the reply says "Replying to an earlier message" rather than reading like a new remark. Old links that pointed straight at a thread still open the channel it lived in.
- The command palette lists your channels, not every thread inside them.
- Threads finished moving into the channel they came from. If you ever started one, its messages are now replies under the message they answer, in that channel, instead of sitting in a room of their own — so there is one conversation to read and one unread count instead of two. If you were caught up before the upgrade you are still caught up. If you were behind, your unread count can come out a little high — it may include a reply you had already read inside the thread — and one visit to the channel clears it; erring that way is deliberate, because hiding something you have not read is the mistake you cannot undo. Most installs have never started a thread, and for those this changes nothing at all. (DOR-634)
- New agents joining a channel now get the new mode instead of "only when @mentioned". Agents you add to a direct message are unchanged
- Existing channels were switched over too. Every channel this changed gets one message in it explaining what happened, so nothing widens quietly — and an archived channel, which cannot be given that message, was left alone entirely. Any agent you had deliberately set to something else — always, never, or direct messages only — was left exactly as you set it
- Being asked something inside a thread keeps an agent in that thread, not in the whole channel. And talking to it in the channel does not pull it into every thread you have open
- If an agent posts to the room while it is still working on a slow reply, that post now counts as part of the same conversation. A question it asks another agent there gets picked up, where before it was quietly dropped. This can mean one extra reply in a conversation that used to end early
- **You can finally see and understand when each agent speaks.** The members panel is now a room sheet, and it holds everything about the room in one place: its name and topic at the top, one line saying what the room will actually do, everyone who is in it — you included — a row that adds an agent, and when the room was made. Archiving is at the foot.
- **How loud an agent is has become a scale you point at.** It used to be five sentences that all began with "Replies", in an order nobody could work out. Now each agent has a spot on a quiet-to-loud scale — **Silent**, **@only**, **Engaged**, **Everything** — and pressing it opens the scale with the real rule written underneath, including the actual number of minutes and messages your DorkOS keeps an agent talking after you mention it, read from your own settings rather than guessed.
- **A one-to-one gets the same four settings a channel does.** **Engaged** — answers when you say its name, then keeps answering for a while — is offered in a direct message too. Add a second agent and it is still a direct message, and it is exactly the room where you want an agent that answers when spoken to and then goes quiet.
- **Point at a setting and the room tells you what it would become.** Move the mouse across the scale, or arrow through it, and the line at the top of the sheet shows what the whole room would do if you chose that — tinted to say it is a "what if". Stop pointing and it goes back. Nothing is saved until you actually pick one, and an archived room shows no such preview, because nothing would be true.
- **A change lands the moment you make it.** The meter moves straight away instead of waiting for the server. While it saves, the setting dims; if the save is refused it goes back to what is really stored and says why — so you are never looking at a value that was never saved.
- **Each person or agent is a line, not a card**, with its face, what it is doing right now or the last thing it did here, and its loudness on the right. Agents carry a small robot mark; people carry none.
- **A room's name and topic are edited where you read them.** Press the line, type, press Enter — Escape puts it back. A channel with no topic says "Add a topic" instead of leaving a gap.
- **Adding an agent is the last row of the list of who is in the room**, rather than a second panel with its own heading. Press it and it becomes the picker, cursor already in it.
- **An archived room stops pretending.** Every meter goes grey, the scales cannot be changed, and there is no way to add or remove an agent — nothing is triggered in an archived room, so its members and their settings are on hold until you bring it back. The settings are still shown, because they are what each agent will do the moment you do, and the sheet says so where a screen reader will read it too.
- **Opening the sheet for a room with nobody in it opens the picker straight away.** A room with nobody in it does nothing, so putting somebody in it is the only thing worth offering. "You have not added any agents yet" now comes with a **Create agent** button, and a roster that could not be read now offers **Try again** instead of asking you to close the sheet and open it again.
- **Rows in the roster are taller on a touch screen**, so a face and two lines read as a person rather than as a dot with a caption.
- **Every agent picker now shows who it is offering.** Choosing agents — for a new channel, a new conversation, or a room you are already in — used to be a plain alphabetical list of every project folder you own, with no faces at all. Each agent now carries the same face it has everywhere else in DorkOS, and, where you have written one, its own description on a second line. Two agents can share a name; that line is what tells them apart by what they do. An agent you have not described simply has no second line, and an agent DorkOS cannot read gets a plain letter rather than a made-up face that would match nothing else on screen.
- **Starting a conversation when you have no agents yet offers a Create agent button** instead of telling you to go and add one somewhere else.
- **A conversation has one place to be read.** Replies never pile up inside the room; they live in the thread panel, so however long a thread gets it cannot push the room off screen. Every reply is in the panel, including every reply written before this release.
- "Reply in thread" opens the thread and puts the cursor in it. It used to quietly re-point the room's own box at a thread, with a small banner above as the only sign of where your next sentence was going. Now you type in the thread, so there is nothing to misread.
- An agent taking a turn inside a thread is told its answer lands in the thread rather than in the room's main flow, so it writes for the conversation it is actually in.
- OpenCode chats no longer carry a thinking level anywhere. OpenCode gives no way to ask for more or less thinking, so the setting was only ever handing you back what you typed — it is no longer saved, shown, or inherited from an agent. We would rather say it is not supported than pretend it does something.
- An agent set up to run on a runtime you have not connected — or to think harder on a runtime with no such setting — now shows up under **Needs attention** in the sidebar, next to the chats waiting on you. You should not have to open Settings to find out that an agent cannot start. A model that is no longer offered is a quieter problem and stays in the list under your defaults, where checking it does not cost a lookup per agent.
- The very first chat DorkBot starts during setup now runs on your default runtime. It used to always say Claude Code, even if you had chosen something else.
- **First-run setup now points new chats at the coding agent you actually have.** If Codex is the only one connected when the setup check finishes, DorkOS starts new chats with Codex instead of quietly assuming Claude Code. The sentence on that screen says which one it picked — "Codex is connected. New chats will start with it." — and a **Change** link right under it switches to any other agent in one tap — including one you have not connected yet, in which case the screen tells you which agent your chats will use in the meantime.
- It waits for the check to finish rather than deciding the moment DorkOS opens, because you can connect an agent from that very screen and the answer changes when you do.
- **The pick happens once, on your first run, and never again.** Reopening setup, refreshing halfway through, or installing another coding agent later will not move the setting behind your back. From then on it is yours, and Settings → Runtimes is where you change it.
- **Slack now shows you when an agent has actually picked your message up.** Your message gets an 👀 reaction the moment an agent starts working on it, and loses it when the answer lands or the attempt fails. Before, the reaction was an hourglass added the instant your message arrived — which meant a message nobody ever picked up still looked like it was being worked on. Now the mark means somebody is on it.
- **Nothing is added when the work finishes** — no green tick, no red cross. The reply is the answer, and the error message is the failure.
- If an agent stops to ask you something mid-answer, the reaction comes off while it waits and goes back on the same message when it carries on.

  Setting the working indicator to **None** still turns all of this off, and still makes zero calls to Slack.

- Cross a room a message at a time with Page Down and Page Up. A busy channel used to take a Tab press for every message, plus another for every thread, before you reached the box to type in. Now the history is a feed: Page Down and Page Up move message to message however many buttons, reactions and replies each one carries, and Ctrl+End jumps straight to the composer. Every message also says who wrote it and where it sits — "12 of 30, Ana" — so a screen reader reads a room as a conversation instead of one long wall (DOR-757).
- Messages now say who wrote them everywhere they appear, threads included, so a screen reader can find its way around one without reading everything either side of it first.
- Arrow keys scroll a long message again. Up and down used to be taken by the message's own action buttons, so a message taller than the window could not be read through without moving off it first. The buttons are still one press away with Enter or the right arrow.
- Cross an open thread the same way you cross a room. The thread panel is now a feed of its own: Page Down and Page Up move from the first message to each reply, Ctrl+End jumps to the box you reply in, and Ctrl+Home goes back to the button that closes the panel — so leaving the thread never drops you into the room behind it. Each message says where it sits in the thread, and the panel says it is still loading when you open a link straight to one (DOR-780).
- Cross a session's conversation a message at a time with Page Down and Page Up. A long chat used to be one press per message and everything in it before you got anywhere; now the transcript is a feed, so one press moves to the next message however much it carries, and Ctrl+End jumps out to what is below it. Every message says who wrote it, when, and where it sits — "12 of 30, DorkBot" — so a screen reader reads a conversation instead of one long wall (DOR-779).
- An answer that is still being written is now read out as it arrives, sentence by sentence, instead of the whole answer being repeated on every word. When the turn finishes, only the last few words that were not yet spoken are — the message is never read from the top a second time.
- Waiting for a conversation to load is now announced rather than silent.
- An unreadable chat integration now says out loud that any bot token inside it is still sitting in the file in plain text, rather than leaving the file looking protected when it is not.
- The relay's Activity panel counts honestly. A message sent to something nobody is listening for is now "No listener" rather than a failure, so a quiet machine stops showing a wall of red; failures carry the reason they failed; the dead-letter count reads from the actual queue instead of always showing zero; and connecting or reconnecting an integration no longer counts as delivered traffic.
- **Auto** works again on models that support it. The same lost flag had been quietly running "auto" sessions at the default trust level and hiding "auto" from the picker; both now behave as selected.
- The fast-mode toggle appears for models that support it — the flag that showed it was lost the same way.
- Starting DorkOS prints less. A healthy start used to write eleven near-identical lines about routes being set up; now it writes one that names what came up. Nothing else about starting changed — there is just less to scroll past before the part you were looking for.
- Every trust level a runtime offers now says what it actually does — when it stops to ask you, how far it can reach, and one plain sentence about the consequence. Warnings on screen are worked out from that instead of from a list of mode names kept in the app, so a mode a new agent invents is described correctly the day it arrives. Nothing looks different yet, with one exception: Claude's Auto mode is no longer tinted red. It still raises an approval card for the risky calls, and red is now reserved for the one setting that never asks about anything, anywhere. Your pick is validated against that runtime's own declared mode list, not a fixed set.
- Choosing how much your agent may do is now one dial with three honest stops — **Ask first**, **Act**, and **Full autonomy** — instead of a list of six engineering words. Under it, one line says what that stop means for the agent you are actually talking to, in its own words. Where an agent cannot keep the stop's promise, the line says so in amber rather than quietly hoping you find out later: on Codex, "Act" runs shell commands without asking, because Codex has no way to pause and ask.
- A stop an agent cannot take simply is not offered, and a session sitting at a setting the agent no longer has now says which setting that is instead of showing an empty dial.
- **Full autonomy** asks once before it takes effect, and says what that means for the agent in front of you. Every other stop applies straight away — this is the one you cannot walk back, so it is the one that asks. Arrow keys stop at the ends of the dial instead of wrapping around to it.
- **Plan** moved out of the permission list and next to the composer, where you can switch it on for a stretch of work and off again. Turning it off puts you back at the stop you were on — or to the agent's normal setting if the old one is no longer available. It appears only for agents that can plan, and it is in the Session panel too, so a narrow window cannot take it away.
- **Auto** is no longer a setting of its own. It is a switch inside **Act**, on the models that can run it — the same one-time confirmation as before.
- Choosing what an agent may do looks the same everywhere now — and always tells the truth for the runtime it runs on. Integration bindings and scheduled tasks used to ask this question with their own hand-written lists; both now use the same three-stop dial as a chat session, with the same honest line underneath about what the stop means for that agent.
- The integration binding's list said "asks before running shell commands" for every agent, which is false for agents that cannot pause to ask, and offered **Plan** as a level of trust — which it is not. Both are gone.
- Turning on **Full autonomy** for an integration or a schedule now asks first, and says what stops happening on that surface: an integration gives up the answer it would have waited for, and a scheduled run gives up the approval it would have raised.
- A schedule that still stops to ask now says so plainly: nobody is watching a scheduled run, so anything it stops to ask about is refused after 10 minutes and the run carries on without it.
- Both screens say what they are set to and why there is nothing to pick, when DorkOS hasn't heard from the agent behind them yet — instead of showing a picker built on nothing.
- Install previews describe a package's schedule in words that hold for every agent, instead of describing Claude Code and hoping the reader is on it.
- The confirmation is no longer something a screen can skip. DorkOS itself now turns down any attempt to put a conversation into Full autonomy without your acknowledgement, so a second tab, a stale window, or a stray keystroke lands on the same question instead of quietly getting through. If that happens, the confirmation opens rather than an error you cannot do anything about.

  This is a confirmation for you, not a lock against your agents: it makes sure a person cannot arrive in Full autonomy without having been told what it means. Scheduled tasks, chat bindings and rooms are unaffected — they never used this setting and keep their own, stricter rules.

- **Reset takes the Full-autonomy default with it.** The note DorkOS keeps of you reading what Full autonomy means is what lets new chats start without asking, so pressing **Reset** in Settings → Security now also turns that default off. Otherwise new chats would keep opening without asking while DorkOS had no record that anybody agreed to it — and the first time you tried to change one, it would ask you to confirm something you thought you had just switched back on. Chats you already have are untouched, and a gentler default (Ask first, Act) is left exactly as you set it.

  This is for the chats you open yourself. Scheduled runs, chat integrations and rooms keep their own settings and their own, stricter rules — nothing here reaches them.

- The button on a running job says **Stop**, matching what it does and what DorkOS says back when you press it. (DOR-808)
- **Any setting that stops the asking now asks you first — not just Full autonomy.** Some agents cannot pause mid-turn to ask permission. On those, the middle setting ("Act") still edits files and runs commands in your project, it just never checks with you first. Until now only the top setting stopped to confirm, so you could land in a mode that asks nothing without ever being told. Now DorkOS confirms before it turns on any setting that will not stop to ask and can do more than read — in a chat, on a chat integration, and on a scheduled task alike.

  The confirmation says what is true of the setting you picked rather than borrowing the loudest words: it keeps the name you pressed, adds the one sentence that matters ("This stop never pauses to ask. Whatever it decides to do, it does."), and shows your agent's own description underneath. It also carries the line that was previously only shown for Full autonomy — that this covers tools inside the chat, and DorkOS's own actions, like removing a package, still ask you. A read-only setting is left alone: it never asks because there is nothing to ask about, and a confirmation in front of the safest choice is how confirmations stop being read.

  If you have already ticked **Don't show this again**, nothing changes: that one answer covers all of it, and you can bring the question back any time from Settings.

### Removed

- The "Show shortcut chips" setting and the `/` and `@` chips below the message box are gone. The rotating hints already teach both, and the agent you are talking to still shows there (DOR-452).
- The **Configure status bar** panel and the **Status Bar** tab in Settings are gone, along with their ten on/off switches and the right-click "Hide this item" menu. Pins in the Session panel replace them: one thing that adds, instead of ten that only ever subtract. Diagnostics rows deliberately have no pin (DOR-452).
- **Heads up:** those ten show/hide choices are cleared, once, by this release — they are not carried over as pins. The two settings mean opposite things, so there is no honest way to convert one into the other: everything used to show unless you hid it, and now nothing shows unless it has something to say or you pinned it. Carrying "shown" over as "pinned" would have pinned all ten items for anyone who never touched the switches, which is exactly the noisy status bar this release removes. Pin what you want back from the Session panel (DOR-452).
- Swipe-to-collapse on the status area is gone, along with its drag handle and the "Swipe to collapse" hint. It existed because the status area used to be up to five rows tall; it is now one row of at most a few items, so there is nothing left to collapse (DOR-452).
- Installing a marketplace package always waits for you to say yes, and there is no longer a way to switch that off. A setting called `MARKETPLACE_AUTO_APPROVE` used to skip the question for scripts and CI runs. It is gone. If you install packages from a script, have the script answer the request the way the app does: read `GET /api/approvals/pending`, then `POST /api/approvals/:id/grant`, and retry the install. If you have Require login turned on, that script needs a per-user API key (from the Security tab in Settings) to make those calls at all. If you have cloned the DorkOS repository, `contributing/external-agent-marketplace-access.md` walks through it step by step.
- Dropped three keyboard shortcuts from the shortcuts panel (⌘1, ⌘2, ⌘3) that were listed but never did anything — the sidebar tabs they pointed at no longer exist (DOR-534)
- **The separate topic dialog.** "Edit topic…" now opens the room sheet with the topic line ready to type in, instead of a window holding one text box.
- **The app-wide "all permissions bypassed" banner** that sat above every page while the session you were looking at ran with permissions bypassed. The session's own status line already carries the word and the colour, for as long as the session is in that mode, and two alarms about one fact teach people to read neither.

### Fixed

- When a session's saved model is no longer available (you switched where models come from, or removed one), the model menu now marks it "not available" and asks you to pick another, instead of silently failing (DOR-427).
- If a turn does run against a model that isn't available, you now get a plain message pointing you to the model menu instead of a raw error from behind the scenes (DOR-427).
- First-run setup no longer snaps back to the Welcome screen partway through. Meeting DorkBot and settling its personality now carries you straight to the handoff instead of dropping you at the start.
- The first-run setup check no longer says Claude is connected when it isn't. If the Claude Code tool is installed but you haven't signed in, DorkOS now shows the sign-in step instead of a green checkmark, so your agents can actually start work. Signing in with your Claude account or adding an Anthropic API key both count as connected.
- Install and download spinners now actually spin instead of sitting frozen, so it's clear when something is working (DOR-439).
- Pressing Enter to accept a Japanese, Chinese, or Korean candidate no longer sends the half-typed message (DOR-452).
- Pressing Escape to close the command or file list no longer stops the agent mid-answer, and no longer arms a second Escape that wipes your draft. Clearing now takes two plain Escapes (DOR-452).
- Hiding a status item and bringing it back no longer leaves it with a stray dot in front of it (DOR-452).
- Opening a status item's menu no longer closes it the instant another item appears or disappears (DOR-452).
- The "Compact now" nudge now animates away instead of vanishing (DOR-452).
- The keyboard shortcuts panel called `Cmd+.` "Toggle canvas"; it toggles the right panel (DOR-452).
- Status items that did not fit used to be genuinely unreachable on a phone — the row looked scrollable and faded at the edge, but a gesture on the row above ate the swipe. The line no longer scrolls or wraps at all, so nothing can hide there (DOR-452).
- A screen reader now announces what the strip above the message box says — "Waiting for your approval", a finished turn's summary — instead of staying silent. The parts that tick every second, like the thinking verbs and the timer, stay quiet so the announcement is not drowned out (DOR-452).
- Changing the model or trust level from the status line now updates every part of the screen at once. Before, one place showed the new value while another kept the old one until the server replied.
- The Tasks page now sorts by which task runs next when you first open it, and the sort button says so. It used to show "Sort:" with nothing after it.
- CLI commands work again when your DorkOS asks you to sign in. `dorkos agent`, `dorkos task`, `dorkos activity`, `dorkos call`, and `dorkos version --check` sent nothing to prove who you were. On an instance with login turned on, every one of them stopped with a bare "Unauthorized". Your agents in Codex and OpenCode lost their only way to act. The CLI now sends your API key, read from `DORKOS_API_KEY` or from `~/.dork/api-key`. When no key is set up, the error names what is missing and where in the cockpit to create one. If you have not set up a key, nothing changes (DOR-428)
- In first-run setup, "Skip" no longer throws away the rest of setup. Choosing a personality for DorkBot now has its own "Skip this step" button that moves you to the next thing, and the button that leaves setup for good says so: "Skip all setup". If you do leave, a note tells you where to start setup again (Settings → Preferences) (DOR-472)
- The session list now shows the trust level a session is really running at. The sidebar used to call almost everything "Default", so a session left to act on its own looked exactly like one that asks before every step, and a session running without approvals could appear with no warning icon at all. It also went stale: a level changed in another window or by a scheduled task did not reach the list, and a refresh that arrived a second late could quietly undo a change you had just made. Every place a session appears now reads the same value, updates the moment it changes, and your newer choice always wins.
- **Lined-up messages no longer disappear.** If you typed a follow-up while your agent was working and it then stopped to ask you to approve something, your message could vanish without a trace — the "Queued (1)" mark went away and the text was gone. Lined-up messages now wait their turn properly, and if one can't be sent for any reason it goes straight back in the line instead of being thrown away.
- **Every lined-up message now has a "send now" button.** If a reply fails partway through, the messages waiting behind it used to be stuck there with no way to send them — and the only trick people found for getting the text back deleted it. Each one can now be sent on its own, and when sending genuinely isn't possible the button says why.
- **Visiting other conversations no longer deletes messages you lined up — or a message you started typing.** DorkOS keeps the last 20 conversations in memory, and used to drop the oldest one whether or not it still held your words. A conversation with something waiting to send, or half-typed in the box, is now kept regardless.
- **Picking a slash command keeps the rest of your line.** Typing `/deploy staging`, clicking back to just after `/deploy`, then pressing Enter used to delete ` staging` and send nothing at all.
- **A file that fails to upload now says so, and offers to try again.** The chip showed a small red icon with no words, and sending anyway delivered your message with no file attached — so you sat waiting for an answer about something your agent never received. DorkOS now holds the message until you retry the upload or remove the file.
- **Typing a command into a message that's waiting in line now just runs it.** Commands like `/compact` or `/rename` do something right away rather than getting sent to your agent, so one sitting in the line used to jam it — everything queued behind it waited forever. Now it runs when you press Enter, and if it can't run (a missing name, say) your text stays put so you can fix it.
- **Rewriting a message that's waiting in line no longer loses the rewrite.** Moving to another one, or switching to a different conversation and back, keeps what you typed.
- **Coming back to a conversation no longer sends a duplicate.** If you left while editing a message that was waiting in line, its text stayed behind in the box and pressing Enter sent a second copy.
- The "Your Agents Can Operate DorkOS" guide promised two safety checks DorkOS does not perform: that an agent checks with you before editing a different agent, and that it changes settings only when you ask. Both are instructions we give the agent, not locks. The guide now says so, and points you at your activity feed, which does record the change (DOR-428)
- The MCP server page listed 48 tools and left out everything the operator surface added. It now lists all 55, says which 15 carry a risk level, and counts the capability catalog resource it had been missing (DOR-428)
- The message box only grew when you typed. Anything else that filled it — clicking a queued message to edit it, pressing Up to reach the queue, Escape putting a draft back, a re-run pre-filling a prompt, tapping a suggestion — left a six-line message showing one line, in a box with no scrollbar to tell you the rest was there. The box now fits whatever it is holding, however it got there (DOR-479)
- Editing a queued message and deleting all the text left you stuck: the banner still said "Editing message", and every button vanished. On a phone, with no Escape key, the only way out was the row's X, which deletes the message. The box now offers a plain "Cancel edit" (DOR-479)
- Pressing Escape twice wipes your draft, and it used to be gone for good. Cmd+Z now brings it back (DOR-479)
- Opening a session on a phone popped the on-screen keyboard and scrolled the page every single time. It doesn't any more (DOR-479)
- While an attachment uploaded, the box claimed the agent was replying: the send button turned into a red Stop that did nothing when you pressed it, and if the upload hung, the box stayed stuck in that state forever. It now shows the upload in progress, and waits for it to finish before anything else happens (DOR-479)
- If an attachment failed to upload, your message was deleted along with it. Your words stay in the box so you can try again (DOR-479)
- The dashboard and the welcome conversation showed a greyed-out X for clearing the box that did nothing when clicked. It's gone — pressing Escape twice still clears the box on those screens, and Cmd+Z still brings the text back (DOR-479)
- Typing your very first message on the dashboard and pressing Enter did nothing at all while DorkOS was still finding your agent, with nothing on screen to say why. It now says "Getting your agent ready…" (DOR-479)
- Typing something like `/zzz` that matches no command left "No commands found." on screen and swallowed your Enter, so the message needed two presses to send. One press is enough, and the card goes away when the message sends (DOR-479)
- Making a desktop window narrow — say, to sit beside your editor — quietly changed Enter from "send" to "new line". Enter now depends on the device rather than the window size: it sends anywhere you have a mouse, trackpad, or stylus (including a tablet with a keyboard case), and inserts a line break on a phone or a bare tablet (DOR-479)
- Running `/compact focus on the API changes` while the agent was still replying deleted your instructions and then told you the agent was busy. The text now stays put unless the compaction actually starts, and the box waits for it rather than letting a second Enter run the same thing twice. If the request never comes back, it gives up after 30 seconds and says so, instead of leaving the box stuck (DOR-479)
- When an agent asked you to approve something, the "Queued (N)" panel disappeared for as long as the question was up. The messages were always safe, but nothing said so. A quiet line now tells you how many are waiting (DOR-479)
- The composer said "Editing message —" with nothing after the dash. It now tells you which one you are rewriting: "Editing message 2 of 3" (DOR-479)
- "Session is busy. Please wait..." named nobody and gave no idea how long. It now says "Your agent is still finishing the last message. Try again in a moment." (DOR-479)
- The list of waiting messages told you how many there were but never when they would go out. It now says so: "Queued (2) — Waiting for the reply to finish", or "Will send next" once nothing is holding them up (DOR-479)
- A follow-up suggestion too long for its chip was cut off with no way to read the rest. Hover it and you get the whole line (DOR-479)
- While you edit a message that is waiting to send — the one mode where Enter saves instead of sends — the writing box had no name at all for a screen reader. It now announces "Edit queued message 2 of 3 — press Enter to save" (DOR-479)
- A file search that matched nothing could point a screen reader at a list that was not on the page (DOR-479)
- The paperclip and the clear (×) button showed no outline when you reached them with the keyboard (DOR-479)
- The list of waiting messages popped out of existence the instant the last one sent, instead of sliding away, and the extra stop button did the same. Both settle properly again (DOR-479)
- The composer's right edge jumped sideways the moment you typed your first character, and a waiting message shifted two pixels when you clicked to edit it. Neither moves now (DOR-479)
- A photo you attached rebuilt its little preview many times a second the whole time it was uploading. It is built once (DOR-479)
- Setting up an agent in a folder you already have can no longer delete that folder. If setup stops partway, such as when the disk is full, DorkOS takes back only the files and folders it just made, leaves everything of yours alone, and tells you if anything is left over (DOR-507)
- Agents can no longer turn off the safety prompts on a scheduled task, or approve one. A task runs later on its own with nobody watching, so how much it may do without asking, and whether it is allowed to run at all, are now yours to decide in DorkOS. A task an agent creates waits for your approval however it was made, including from the command line, where it used to go live right away. If an agent tries to change either setting, the whole change is refused and nothing at all is saved, so it never ends up half applied. Setting these yourself in the cockpit works exactly as before.
- Scanning for agents from outside DorkOS can now show the agents it already knows about. The scan tool always supported asking for them, but the outside connection did not offer the option, so there was no way to ask for it. It also said it looks three folders deep by default when it really looks five.
- The Tools screen was underselling what your agents can always do. It listed six tools that are on no matter what, leaving out the three that let an agent read its own preview window. All nine were always available; now the screen says so.
- Reloading an extension you had turned off no longer quietly turns it back on. Asking DorkOS to reload a switched-off extension used to start it up again, routes and all, while the switch in Settings still showed it as off. DorkOS now says it is off and leaves it alone.
- A folder in your project can no longer take the place of an extension DorkOS ships, or of one you already allowed. DorkOS decides what counts as its own code by where that code sits on disk, not by the name inside it.
- A bookmark or shared link to the old Settings "Channels" tab now still opens the Integrations tab instead of silently opening nothing.
- The adapter setup wizard and a couple of "Add" buttons in the Relay panel and onboarding preview still said "channel" after the rename above; they now say "integration" too.
- Your agents were being given wrong information about which actions stop to ask you. The built-in instructions every agent is set up with said that deleting a scheduled task "carries no gate of its own", and the tool catalog that agents read to learn what they can do said that a whole group of DorkOS tools carries no permission level at all. Neither was true. Deleting a scheduled task and removing an agent have both stopped and asked you since they were classified, and every tool in that group has a permission level. The protection was never missing; the description of it was wrong (DOR-509)
- An agent that believed those descriptions would not warn you before an action it could not undo, and would read your refusal as something broken rather than as your answer. The instructions now say plainly which actions wait for you, how to ask, and that a refusal is the answer. Existing agents pick up the corrected version automatically the next time DorkOS sets them up; a copy you edited yourself is left alone, as always (DOR-509)
- The same instructions had three other details wrong: they named only two of the three actions that stop to ask you, they said removing an agent could only be done one way, and they said every command accepts the `--json` option when several reject it. All three are corrected (DOR-509)
- Moving between DorkOS pages no longer reloads the whole app. Links that stay inside DorkOS switch pages instantly, so an agent that is mid-answer keeps streaming while you look around (DOR-534)
- Links that belong outside DorkOS — the docs, GitHub, a sign-in page — now reliably open in your browser, including the ones an agent or a connected tool puts in front of you (DOR-534)
- DorkOS now opens only ordinary web and mail links, and tells you when it turned one down instead of leaving you to guess. A tool that asks you to sign in through a link DorkOS won't open can no longer show you a "Done" button for a sign-in that never happened (DOR-534)
- Stop the Restart and Reset buttons from leaving the desktop app with no server. Restart now tells you to quit and reopen the app, which does the same thing. Reset tells you plainly that nothing was deleted, and names the folder to remove if you really want to start over (DOR-532)
- The Mac app now tells you when the background server it runs has stopped, and offers to start
  it again. Before, the window stayed open but quietly stopped working — most noticeably right
  after "Reset All Data" — with nothing on screen to explain why (DOR-533)
- When that server won't start, the Mac app now tells you what the server said about why, then
  closes. If you already have DorkOS running in a terminal, for instance, it says so — instead of
  showing a bare error code and leaving the real explanation in a log file (DOR-533)
- If the server keeps failing — whether it won't start at all, or starts and dies again moments
  later — the Mac app stops offering a button that isn't working and offers to open its logs
  instead (DOR-533)
- Quitting the Mac app no longer pauses for several seconds when its server has already stopped
  (DOR-533)
- The desktop app no longer flashes a white rectangle before it loads (DOR-538)
- A window left on a monitor you then unplug comes back to a screen you can see, without a restart (DOR-538)
- Quitting while full screen no longer brings the window back jammed under the menu bar (DOR-538)
- Sending two messages in a row no longer gives an agent two separate conversations with itself. Both replies used to start from scratch, and the second one quietly forgot everything — including what you had just said (DOR-526)
- Agents talking normally in a shared room no longer fill it with notices claiming somebody hit a reply limit they never came near (DOR-526)
- Starting a direct message is one step again. It used to create the room and then add the agent, so if the second half failed you were left with a conversation named after an agent that was not in it — and starting it again did not help. Now it either works or nothing is created (DOR-526)
- The "New direct message" menu no longer hides two agents at once when they happen to share a name (DOR-526)
- Closed two ways agents could keep replying to each other forever. An agent writing to a room itself — rather than answering through it — started a brand-new conversation every time, so the reply limit never counted anything and never stopped them. Messages from you are what start the count over now (DOR-526)
- A room now reconnects on its own when its live feed drops — after a laptop wakes up, or a restart — and picks up exactly the messages it missed. A sleeping laptop leaves a connection that looks open but is dead, so a room that hears nothing at all for 45 seconds now stops waiting and reconnects instead. If it can't get back after several tries it says so at the bottom of the room, with a Reconnect link, instead of sitting there looking quiet (DOR-526)
- A message you were part-way through typing no longer follows you into the next conversation (DOR-526)
- Reading back through a room no longer yanks you to the bottom every time a new message lands. Scroll up and you stay put; you're only carried along while you're already at the newest message (DOR-526)
- Your privacy choice now survives a config reset. If your settings file was damaged and DorkOS had to rebuild it, or you reset your settings, the answer you gave about sharing data used to be thrown away and replaced with the sharing-on defaults. It is now kept, along with anything else you had made stricter: a login requirement you switched on, a limit you tightened, and the record that revoked your standing permissions. Preferences like your theme still go back to defaults, as a reset should (DOR-584)
- Resetting one section by name, like `dorkos config reset telemetry`, still does exactly what it says. Naming the section is the clear request that a blanket reset is not (DOR-584)
- Limits you tightened are kept too, not just switches you turned off. A smaller upload size or file count, a lower rate limit, a shorter room reply depth: all of these used to quietly go back to the shipped value after a repair or a reset (DOR-584)
- DorkOS starts even when the settings it rescued no longer fit. A setting kept from a damaged file is now checked against the rules before it is written back, so an out-of-range value is dropped instead of stopping the server from starting. When that happens, the log names the setting so you know which one went back to its default (DOR-584)
- DorkOS checks your task files against its own records every five minutes. That check gave up on the first deleted task it met, so deleted tasks lingered and edits you made outside the app stopped showing up. It now finishes.
- Deleting a task now works even if that task has run before. It used to fail with an error.
- Before removing a task, DorkOS now double-checks that its file is really gone. Tasks whose folder is a shortcut to somewhere else were being removed while the file sat there untouched.
- A typo in a task file no longer costs you the task. A file DorkOS cannot read is left alone, so fixing the typo picks up where you left off, run history intact.
- Tasks in a project folder DorkOS is not currently watching are no longer cleared out. This hit tasks you added for an agent connected after startup, and tasks belonging to an agent you disconnected.
- Two tasks with the same name in different projects no longer interfere. One losing its file used to pause the other.
- A task paused because its file went missing now runs again once the file is back.
- Stopped the repeated log warning about a missing file in your `tasks/templates` folder. That folder holds the starter tasks DorkOS ships with, so it is not a task itself. A task folder of yours that really is missing its file is still reported.
- A task file placed loose in your `tasks/templates` folder no longer turns into a task. It became one that ran on a schedule, and deleting it took every one of your templates with it.
- Tasks in a project folder that has been deleted or unmounted are no longer cleared out. DorkOS could not tell an empty folder from one that is not there any more, so a checkout you moved took its tasks and their history with it.
- Updating no longer fails if your database holds run records whose task is already gone. Those leftovers would have stopped DorkOS from starting at all, with no way to fix it from inside the app. They are tidied up during the update.
- Your settings now survive a busy moment on your computer. When a computer has
  too many files open at once, reading a file can fail even though the file is
  perfectly fine. DorkOS used to read that as damage. It renamed your settings
  file and started over with defaults. One person lost their pinned status bar
  items that way. The riskiest moment was the first launch after an update,
  which is when DorkOS reads your settings the most.
- DorkOS now waits a moment and tries again. If it still cannot read your
  settings, it stops and tells you why, and it does not replace or delete
  them. Start DorkOS again once your computer is less busy and your settings come
  back.
- A settings file that really is broken is still backed up and rebuilt, and your
  privacy and safety choices still carry over to the new one. If this already
  happened to you, your old settings are in `~/.dork/config.json.bak`.
- When DorkOS does stop, it now tells you what to do about the actual problem.
  A full disk says to free up space. A file you are not allowed to open gives
  you the command to fix that, on Mac, Linux, or Windows. It no longer tells
  you to wait for a problem that will not pass on its own.
- Fix an extension staying broken forever after a brief glitch on your machine — like running
  low on memory or disk space for a moment during startup. DorkOS used to remember that
  one-time hiccup as if the extension itself were broken, and would repeat the same error on
  every restart even after the glitch was long gone. Now it only remembers a real problem with
  the extension's own code; anything else gets a fresh try next time.
- Fix one extension hitting a brief startup glitch from blocking every other extension from
  starting too. Each extension now starts on its own, so one hiccup no longer holds up the rest.
- Quiet down a harmless background message that was showing up as a warning dozens of times a
  day. It's a safety check working exactly as intended, not a sign of trouble.
- The first-run setup screen now has a way out. If DorkOS did not find a coding
  agent on your machine, the screen used to leave you stuck: nothing to
  continue with, and no Skip or Back to press. It now offers "Skip all setup"
  and Back, so you can look around the app first and set up an agent when you
  are ready — the Getting started card will still offer it (DOR-481)
- Buttons that say they will take you to a setting now take you to that
  setting. "Add more agents", "Open Relay settings", "Add an integration" and
  the guided tours all opened Settings on the Appearance tab instead of the one
  they named, leaving you to hunt for it yourself (DOR-484)
- Your permission choice now sticks to a chat for good. Claude Code gives a new chat its real ID partway through the first reply, and settings you picked before that were left behind under the old ID. If the chat then sat idle for a while, or you restarted DorkOS, the next message quietly ran at the default setting instead of the one you chose — so an agent you had set to act on its own might start asking again, or the reverse. The setting now moves with the chat, and every screen reads it from the same place.
- Change a session's permissions from the status line and its sidebar row updates right away, instead of taking up to half a minute to catch up.
- Fixed a crash that could hit the sidebar's Recent list the moment a brand-new session picked up its real id.
- Scheduled tasks accept every trust level DorkOS offers, not just two. Set a task
  to anything else and the task file DorkOS wrote was one it could no longer read:
  the task kept running, but the file on disk and the task in the app quietly
  disagreed from then on, and every edit to the file was ignored. Every stop on the
  dial now survives a save (DOR-607)
- Building a Shape? The setting that says whether one of its timers starts
  running is now called `startEnabled`, and it is off unless you turn it on. If
  your setup file still uses the old `startDisabled`, applying the Shape tells
  you so and points at the new name, instead of leaving you with a timer that
  never fires and nothing to explain it (DOR-607)
- Your Telegram bot no longer replies to other bots. If two bots that both answer messages ended up in the same group, they could talk to each other forever and fill the chat. Your bot now ignores anything another bot says, and there is no setting that turns this off.
- Buttons that open Settings work again in the Obsidian plugin. A recent change
  made "Add more agents", "Open Relay settings" and "Add an integration" do
  nothing at all there instead of opening Settings. They open it again (DOR-484)
- A link to a Settings tab that no longer exists now opens Settings on its first
  tab instead of showing an empty panel. An old bookmark or a renamed tab used
  to leave you looking at a blank window with nothing selected (DOR-484)
- Rooms now say something when an agent cannot answer. If the agent was busy with another task, or its turn hit an error, the room posts a short line telling you so, instead of leaving your message sitting there with no reply. A busy agent used to just say nothing, which looked exactly like a broken one. You get one line, not one per message you sent. (DOR-621)
- A slow answer is no longer thrown away or cut off. If an agent takes longer than the room's wait, the room stops waiting but the agent keeps working, and its full answer is posted when it lands, quoting the message it answers and saying how long it took. Before this, the room either went quiet or posted whatever half-sentence the agent had written so far as if it were the finished answer. (DOR-621)
- Sending a second message to an agent that is still working no longer posts a stray fragment of its first answer. (DOR-621)
- Slack and Telegram settings that the setup screens never showed you are now on screen, in the add flow and behind Configure. The most important ones decide who is allowed to approve an action: when your agent asks permission to run something, only the people you list under Approvers can say yes. That list was impossible to fill in before, so nothing could be approved from Slack or Telegram at all. Slack also gains its DM controls: who may message your bot, which channels behave differently, and when the bot joins in.
- A setting that no setup screen claims now appears under its own heading on the last screen. Nothing can go missing again just because it was left off every screen.
- Lists and per-channel rules you had already saved now show up the way you wrote them: one entry per line, and readable settings instead of `[object Object]`. Editing one of these and saving used to run your existing entries together into a single broken one, which quietly took away everyone's permission to approve.
- If the Channel Overrides box is not valid JSON, saving now stops and tells you, and your existing rules stay put. It used to accept the save and erase them.
- Nothing changed value. Every setting opens on what it was already set to, including the ones you are seeing for the first time.
- A direct message now shows the face of the agent you are talking to, instead of a plain letter. A conversation with several agents shows all of them.
- The Channels, Direct messages and Agents lists no longer say "create your first one" when the reason they look empty is that everything is filed into a group. They say that instead.
- Every agent ships with a small set of built-in skills that teach it how to run DorkOS. Those skills were being written to a place the default runtime does not look, so agents never actually learned them. They now land where the agent can read them, for new agents and for DorkBot (DOR-659).
- Agents that DorkOS set up for you are repaired the next time you start it. Nothing to click, and it does not slow startup down. Agents that live in your own project folders are left alone, because starting DorkOS is not a reason to write files into your projects (DOR-659).
- DorkBot re-checks its own skills on every start, so if the links are ever lost it puts them back on its own (DOR-659).
- New agents now land in the DorkOS folder the running copy is actually using. If you point DorkOS at a different folder — a second copy, a container, a checkout you are working on — creating an agent used to build it in your main `~/.dork/agents` instead, so folders appeared in your everyday setup that you never asked for. Setting your own agents folder still means exactly what you typed.
- Setup saves the personality you pick for DorkBot to that same copy's DorkBot. It used to edit the DorkBot in your main folder.
- The create-an-agent screen now shows the real folder the agent will be created in, and checks that folder for a conflict. It used to show `~/.dork/agents`, which was not always where the agent went.
- Point your agents at your own copy of the docs. DorkOS hands your agents a link to the docs, and until now that link always went to dorkos.ai. Set `DORKOS_DOCS_BASE_URL` to your own site and your agents read that one instead. It has to be an `http://` or `https://` web address, or DorkOS will not start. Leave it unset and nothing changes (DOR-660)
- OpenCode sessions no longer go missing once a project has more than 100 of them. Older ones used to drop off the list quietly — nothing failed and nothing said anything was hidden, so the list just looked short. The background sessions your agent starts for its own subtasks counted toward that 100 as well, so you could lose sight of your own sessions even sooner. Opening one of the hidden ones could also fail with a message saying the session did not exist, when it did. They are all listed and openable again, and if a project ever holds more sessions than OpenCode can hand over at once, DorkOS reports a problem loading the list instead of quietly showing you a shorter one. (DOR-673)
- `dorkos harness sync --check` no longer creates a file. Check is the mode that only reports, and the docs called it safe to run any time — but run it somewhere that has no harness manifest and it quietly wrote one, into whatever folder you happened to be standing in. It now stops, names the folder it searched, and leaves everything exactly as it found it (DOR-678).
- Three other ways into the same write are closed too. Plain `dorkos harness sync` with no flags, narrowing the run to one tool with `--harness`, and even naming a tool that does not exist all created that file first — so a command that went on to reject your input still left something behind. None of them write now.
- `--fix` still creates a manifest when a folder has none, which is what `--fix` is for. The built-in help now says plainly which mode writes and which never does, and reminds you that sync always acts on the folder you run it in — so if it cannot find a manifest, the usual answer is that you are one directory away from where you meant to be.
- Your agents now keep up with the built-in DorkOS skills. Until now only DorkBot did, and every other agent kept the skills it was handed on the day you made it. That matters when we correct a skill. One correction taught agents to warn you before deleting a task, and agents made before that fix never found out. Now DorkOS refreshes the built-in skills every time it starts, and puts them where the agent can actually read them (DOR-671)
- Your own work survives the refresh. A skill you wrote is left alone, and so is a built-in skill you have edited. Deleting a built-in skill does not stick, though: it comes back the next time DorkOS starts, so edit it instead if you want it out of the way. Agents you registered from a folder of your own are not touched at all.
- Saving from two places at once no longer loses one of the saves (DOR-697). If you had DorkOS open in two tabs, or an extension saved in the background while you changed a setting, two saves to the same file could collide: one would fail with an unexplained error, and the other could quietly store the wrong content. Sign-in details for your agent runtimes, your marketplace sources, and your agent templates were all stored this way — a collision could drop a saved key or source, and in the worst case wipe your whole template list. Saves to the same file now take turns, and each one keeps its own content.
- An agent that takes a long time to answer in a room no longer counts as finished. A room waits 10 minutes for a reply. After that, the other agents in the room used to be told it was free, so two of them could start the same job. It now counts as working until its answer lands
- A room no longer names the same agent twice while it is working. One agent can have two replies going at once in a busy room, and each one was listed separately
- When a slow answer fails on its way into the room, the room now says the turn failed. Before, it went quiet and left you waiting for an answer that was never coming
- Press-and-hold menus no longer interrupt you mid-gesture. Starting a scroll or dragging to select text used to be able to open the menu under your finger; a press that travels now leaves your gesture alone
- A room with a lot of agents in it no longer grows the sheet off the top of the screen. It stops at a readable height and the middle scrolls, the way every other panel in DorkOS does.
- Opening the sheet on a phone no longer pops the keyboard at you. The search box is still the first thing under the heading, and still one tap away — you just get to look at the list first.
- The **×** that takes an agent back off the list while you are choosing was a few pixels too small to hit reliably on a phone. It is now comfortably thumb-sized.
- On Telegram, "typing…" now means an agent is actually working. It used to appear the moment your message arrived — before anything had picked the message up, and even when nothing ever would, so a chat that was never going to get an answer sat there watching a bot pretend to type. Now it starts when the turn starts, and stops when the reply lands, when the turn fails, or when the agent pauses to ask you something — a question, or a tool it wants approved. The old 60-second cutoff is gone too: a long job keeps typing for as long as it keeps working, instead of going quiet a minute in while the work carries on. And if an agent goes silent without ever finishing, the typing stops by itself after a minute rather than running forever.
- **Choosing a default runtime other than Claude Code no longer silences your agents on chat platforms.** `dorkos config set runtimes.default opencode` is a documented setting, but it also reached the relay — the part of DorkOS that carries messages between your agents and Telegram, Slack, and the like. The relay only knows how to talk to Claude Code, so a different default left it with nothing it could use, and it switched message routing off during startup with nothing you would ever see in the app. The server looked healthy, the chat connection looked connected, and messages went nowhere. The relay now uses Claude Code directly whatever your default is, and where it genuinely has to make a choice it writes that choice to the log instead of going quiet.
- Keep a long conversation's memory when Claude Code renames it a second time. Claude Code can give a session a new name when it picks it back up, and after the second rename DorkOS lost track of which conversation was which — the agent started over with no memory of what you had been talking about. A session now answers to every name it has ever had (DOR-774).
- An agent that stops to ask your permission no longer gets cut off as stuck. If a second reply started on the same chat while the first was still waiting on your answer, DorkOS could decide the waiting agent had frozen and end its turn ten minutes later. The turn now stays open while it waits on you. (The permission request itself still expires after 10 minutes, as before.)
- Long jobs keep their chat to themselves. A turn that ran longer than five minutes — normal for room agents and for anything that reads a lot of files — used to become fair game for another browser tab or device, which could start a second reply on top of it. A turn that is still working, or still waiting on you, now holds the chat for as long as it needs. One that has genuinely gone quiet is still handed back after five minutes.
- Sessions started in a linked folder, a folder with accented characters in its name, or a very deeply nested one now find their earlier history instead of starting from scratch.
- When the same chat opened twice at once, one of the two views could go permanently silent — connected, but never receiving anything again. It now reconnects and catches up.
- If DorkOS can't stop a frozen agent, it no longer waits forever trying. It gives up after 30 seconds, closes the turn, and says what happened in the log.
- Telegram private chats now use an allowlist, the same way Slack DMs do. A bot handle is public, and a private message starts a real agent turn on your machine, so a new integration answers only the people you name. If a message is ever turned away, the log says who it was, their user ID, and the setting to change (DOR-788).
- **A Telegram bot you already set up still answers anyone who messages it.** Changing that automatically would have taken a working bot off the air, so the old behaviour is kept and DorkOS warns about it by name at every startup. Open that integration, set **DM Access** to "Allowlist only", and add the people you want.
- Slack says the same thing out loud. Turning someone away used to be silent, which looks identical to a broken bot — especially right after setup, when the allowlist is still empty. It is now one clear line per conversation, not one per message.
- "Let this agent start conversations here" is now a permission for that one agent on that one channel. Before, once you granted it, any agent on your machine could message that chat as your bot.
- If the part of DorkOS that decides who may message whom fails to start, chat integrations no longer start either. They used to connect, look healthy, and answer nobody — with the permission checks quietly switched off.
- If your relay access rules become unreadable, DorkOS now stops delivering and says which file to fix, instead of behaving as though you had never written a rule.
- One unreadable integration in your settings no longer hides all of them, and adding a new integration can no longer delete the ones DorkOS could not read. An unreadable one is kept exactly as written — so if it holds a password, that password stays in plain text until you fix or delete it, and DorkOS now says so. You can delete it by name, and re-creating an integration under the same name clears the broken copy.
- Group chats set to "a separate session per person" now really do give each person their own session. Everyone in the room was sharing one, so a conversation could be read by whoever spoke next.
- A message from a chat platform can no longer impersonate DorkOS's own instructions to your agent. Code and prose you paste into chat still arrive exactly as written.
- Custom webhook headers can be set at all now — saving them used to fail every time — and they are treated as secrets: stored encrypted, hidden when read back, and never written to a log. An API key put there used to sit in a plain settings file (DOR-796).
- A Telegram integration that loses its connection now reports the problem and reconnects, instead of retrying in silence forever while reporting itself connected.
- A webhook pointed back at DorkOS now stops after a few laps instead of talking to itself indefinitely. If your service answers DorkOS through the inbound endpoint, pass the `X-Relay-Hop-Count` and `X-Relay-Max-Hops` headers back unchanged.
- An agent in a room no longer forgets the conversation. Its replies used to get filed under one name while the room remembered another, so the next message started the agent over from nothing. It happened quietly: no error, no notice, just an agent that had lost the thread. The room now keeps up with the name the moment it changes.
- On startup, DorkOS checks every agent in every room and writes a line in the log for any whose saved conversation it cannot find, naming the room and the agent. Nothing is deleted, so a conversation that went missing can still be tracked down by hand. If DorkOS cannot read your saved conversations at all, it says that too, instead of finishing quietly and looking like all is well.
- When a message you send from Telegram or Slack cannot reach its agent, the chat now tells you so in one line — instead of going quiet in a way that looks exactly like an agent thinking. It says which thing to change: the chat is paused, it is set not to reach its agent, the agent is not available, a session would not start, or the agent is at capacity. If you send the same message five times, you are told once. These lines only ever appear in a chat you connected to an agent yourself; DorkOS never speaks in a chat you haven't set up.
- A turn that ends without saying anything now says so, rather than leaving your question sitting there. It stays quiet when the agent already answered, already showed an approval card, or already reported an error — so you never get "the agent finished without sending anything back" underneath a real reply.
- A long answer no longer arrives with its beginning missing. Any reply that took more than five minutes used to lose everything written before that point; on Slack it also split into a second message halfway through. Both now wait for a stream to actually go quiet, however long the answer takes.
- Mail waiting in an agent's inbox is no longer deleted an hour after it arrives. An agent that was switched off for an afternoon came back to an empty mailbox with nothing to say a message had ever arrived. Unread mail is now kept for a week, and when it finally does expire it is set aside where you can still read it.
- Task-completion notices go to the conversation you were actually using, not to whichever one happened to be listed last — which was often a channel nobody had touched in weeks. Under the one-session-per-person setting, a group's notice can no longer end up in somebody's private messages.
- Changing an integration's settings while it is refusing to shut down no longer starts a second copy of it. That is what made a bot answer everything twice, and bill twice for one question.
- On Slack, the 👀 mark now lands on the message being answered. When a message was dropped before it reached an agent, the mark used to shift onto the next person's message instead.
- A task problem that sticks around no longer repeats in your log every five minutes. DorkOS checks your task files on a timer, so one bad file used to write the same line twelve times an hour, all day, burying anything else that went wrong. You now get the full message the first time it happens, then one reminder an hour that says how many times it has repeated. A different problem always shows up right away.
- When an agent asks to use a tool and nobody answers, it gives up after ten minutes. That used to happen in complete silence. DorkOS now writes a line saying which agent gave up and what it was asking about, so you can find out afterwards why it stopped.
- An agent in several rooms at once no longer starts a separate job for each one in the same project folder. It finishes what it is doing first, and the other rooms say it is busy elsewhere rather than going silent.
- A room could mistake somebody else's work on the same agent for its own answer and post it. It now tracks exactly which piece of work it asked for.
- The agent's thinking shows up again. It streams in while the agent is thinking and stays in the conversation afterward — a lost capability flag had been leaving every thinking block empty.
- A scheduled task that runs past its time limit now actually stops, even when it is sitting on a permission prompt waiting for an answer. Before, the limit only took effect the next time the agent said something — so a task parked on a prompt nobody answered kept running, held onto one of your run slots, and made shutting DorkOS down slow. This works whichever way your tasks are dispatched.
- A task run that was stopped now records why — you cancelled it, or it ran out of time — instead of reporting both the same way. Cancelling a run also shows up once in your activity feed instead of twice.
- A task file on disk can no longer set a scheduled task to run without approvals. If one asks for it, DorkOS quietly turns the task back down to the normal prompts and notes why in the log. Choosing "Full autonomy" yourself, in the cockpit, still works exactly as before — and if that task's file is later rewritten behind your back, or reappears after the task was paused, it drops back to the normal prompts instead of carrying your permission over to work you never approved. The install preview now shows the setting a package's task will really get, not the one it asked for.
- Editing a scheduled task no longer widens what it may do. A task set to a mode the edit form does not offer — like plan mode — keeps that mode when you save, and the form now says in plain words what it is instead of quietly switching it to "Allow file edits".
- A session can no longer be set to a trust level its agent cannot actually run. A Codex session set to a stop Codex does not have used to be accepted and displayed everywhere while Codex quietly kept running read-only. The setting is now refused, with a message naming the ones that agent does support. Sessions already saved that way still open and run as before.
- A Claude session set to "Auto" no longer fails to send when DorkOS has not confirmed that the chosen model supports Auto — right after a restart, for instance. The turn runs in Default and says it could not confirm, and your Auto setting is kept, so it applies again as soon as the model is confirmed.
- Approving or denying a tool in an OpenCode session now clears the card right away. It used to wait for OpenCode to confirm the answer, and if that confirmation never arrived the card sat there and the session stayed stuck as "waiting on you", blocking the next message.
- An integration or a task saved at a setting the dial does not offer keeps that setting instead of being quietly widened to a broader one. It says which setting it is, and saving leaves it alone until you pick something else on purpose.
- **Stopping a scheduled run now works.** On a normal install, DorkOS hands a scheduled run to its message bus, and the Stop button in a task's run history did not know how to reach a run that had gone that way — it answered "run not found" for a run that was plainly still working, and the only way out was to wait or restart. Stop now reaches the run wherever it is running: the agent is told to finish the turn it is on, and the run is recorded as cancelled. (DOR-808)
- **DorkOS no longer claims to have stopped something it could not reach.** If nothing picks up the stop, you are told so in plain words — including when the hold-up is DorkOS's own message limits rather than a silent agent — and the run is left as it is, instead of being marked cancelled while the agent keeps working. Pressing Stop on a run that has already finished says so, and does nothing else. (DOR-808)
- **A run that finished its work is never recorded as one you stopped.** Pressing Stop in the same instant a run was ending filed the finished run as cancelled, output and all. Whichever happened first now wins honestly, on both the scheduled and the direct path. (DOR-808)
- **A scheduled run that hit its time limit is no longer also reported as failed.** The run's own record said "cancelled" while your activity feed said the task failed. Only the run's record was ever right. (DOR-808)
- **Only DorkOS itself can stop your scheduled runs.** Stop requests travel over the same message bus your agents use, and an agent that guessed a run's id could have ended somebody else's work. Anything that is not DorkOS asking on your behalf is now refused. (DOR-808)
- **The names DorkOS reserves for its own messages are now protected everywhere.** Anything reaching your DorkOS port could claim a mailbox at an address DorkOS uses for its own traffic — including agents' own addresses, and the channel that carries a Stop — which quietly intercepted messages meant for someone else. Those addresses are refused now, whoever asks. (DOR-808)
- The soft pulse that says work is happening — on the thinking line, on loading
  placeholders, on connection dots — had never actually been drawn. About twenty
  places in the app asked for it and got nothing. They breathe now.
- Changing how much a Claude Code session asks before acting, right as its first
  message was being sent, could be quietly undone a moment later — putting the
  agent back on the setting you had just moved away from, including "act without
  asking". Your newer choice now always wins.
- A hiccup in the settings database while a session was picking up its permanent
  name no longer ends the message you were in the middle of. It gets logged, and
  the turn carries on.
- If you had set a server-wide default for how much new sessions ask before
  acting, that default could overwrite the choice you made for one particular
  session, moments after you made it. Your choice for a session now always beats
  the default.
- Sending a second message while a brand-new session was still answering the
  first no longer counts as starting a whole second session.
- An attachment that got stuck uploading used to freeze the whole message box — the send button spun forever and the Enter key stopped working, with no way out but a page reload. Now you can stop an upload: click the spinner where the send button sits, press Escape, or click the X on the file. And if the connection dies mid-upload, DorkOS gives up after 30 seconds and tells you on the file itself, so you can try again or drop it and carry on. A big file on a slow connection is left alone — only silence counts as trouble, not slowness. (DOR-494)
- Some wifi networks answer for you — the hotel or cafe sign-in page that appears before you're online. When one of those replied to an attachment upload, DorkOS took it for an answer it could not read and sat on a spinner that never stopped, with the Cancel button unable to help. It now says the upload got an unexpected reply, so you can sign in to the network and try again. (DOR-494)
- DorkOS watches files in the background so it can notice when your sessions, tasks, agent rules, and integration settings change on disk. When one of those watchers failed — usually because the machine ran out of file handles — it went quiet and nothing said so. Now each one writes a single clear line naming what it was watching and why it stopped. Repeats of the same failure are folded into that one line, and the line says so, so a quiet log afterwards is on purpose rather than a second thing to worry about. A watcher that stops does not restart itself: it keeps serving what it already loaded, but changes in that folder go unnoticed until you restart DorkOS.
- On a machine that had run out of file handles, DorkOS could get stuck partway through starting up and never finish — no window, no error, nothing in the log. It now starts, tells you which watcher failed, and runs with that one part degraded instead of not running at all.
- Scheduled tasks stay in sync again: the background sync that runs every five minutes no longer fails, and a problem that won't go away now writes one log line an hour instead of a flood (#667)

### Security

- An approval now only covers the exact thing you approved. Saying yes to uninstalling one package
  cannot be reused to uninstall a different one, to delete that package's saved data when you agreed
  to keep it, or to change a different project. Each approval works once, only a person can answer
  one, and approvals are never stored in a form anything could reuse (DOR-447).
- Agent identity tokens now expire. A token stops working after a week of not being
  used, and after a month no matter what. Before, a token handed out for a
  five-minute session last month still worked today, which mattered much more now
  that DorkOS records who an agent is (DOR-448).
- An approval covers one exact action, and the check happens before anything runs.
  An agent that changes even one detail of what it asked for has to ask again
  (DOR-448).
- Hiding does not help. An agent that leaves its name off a request still cannot run a
  catalog action that cannot be undone without your approval, and the card tells you
  plainly that DorkOS does not know who asked (DOR-448).
- When an agent presents an identity DorkOS does not accept, that now shows up in
  the debug log so you can see an agent with an expired or rejected token still
  trying. The token itself is never written down (DOR-448).
- Closed an information leak in the `config_get` tool. It returned your whole settings file with only four fields held back. What came through included pointers to where your provider keys live. That means an environment variable name, a keychain entry, or the path to a key file on your disk. It also included the name of the DorkOS account this install is linked to. That tool answers without asking for a token, so any program running on your machine could read all of it. Your keys themselves were never in there. Now the tool shares a fixed list of settings. Anything key-related comes back as a plain yes or no instead of a value. Adding a new setting to DorkOS now means deciding whether it belongs on that list, so nothing new can slip in unnoticed (DOR-428)
- An agent could approve its own request. When an agent asked to do something that cannot be undone, the reply carried the code needed to retry, and nothing stopped the agent from answering the request itself. Now the agent that asked, and anything holding that retry code, is refused, and the request keeps waiting for you (DOR-428)
- The approval card could be worded to hide what would really happen. An agent could put punctuation in a package name so the card read "keeping saved data" while the real setting was "delete saved data", and pad it so the true setting scrolled out of view. Details an agent supplies now appear in quotes, each one is kept short, and a card for something that cannot be undone is never cut off (DOR-428)
- Approval cards no longer show anything that looks like a password or a code. Your agents can read the waiting list, so a card that echoed a secret back was publishing it. Cards now show only the details the action needs, and hiding a code no longer depends on where it sits in the text or how long the text is (DOR-428)
- The docs now say plainly what the approval question does and does not protect against. With no login required (the default), it stops mistakes and it stops an agent that follows the rules but was talked into something bad. It cannot stop a program that already has full run of your computer. Turn on **Require login** in Settings, under Security, and answering a request needs a real account (DOR-428)
- Through DorkOS's own tools, agents can no longer turn off your login. The `config_patch` tool let an agent change any setting, and nothing asked you first. That included the login switch. Turning login off is the one change that undoes every other protection, because approving a risky action is what a signed-in person does. An agent could switch that off and then approve its own work. The tool now refuses the settings that decide who can reach your instance, what it can touch, and what leaves your machine: login, the public tunnel, the MCP endpoint and its key, telemetry choices, where your provider keys come from, extensions, the runtime programs DorkOS runs, and the folders DorkOS reads and writes. Ask an agent to change one and it is told plainly to ask you instead. You still change all of these yourself in Settings, exactly as before. Adding a new setting to DorkOS now means deciding whether an agent may write it, so nothing new can slip through unnoticed. To be clear about the limit: a program running on your machine as you, including an agent with a terminal, can still reach these settings directly, the same way it can reach any tool you run. That is the trust boundary described in the [threat model](https://dorkos.ai/docs/self-hosting/threat-model), and turning on login is what moves it (DOR-488)
- Uninstalling a package now asks you first, whichever way an agent reaches for it. The
  `dorkos uninstall` command used to remove packages with no approval at all, and it was the
  command your agents were taught to use. Now an agent gets an approval card and waits for
  your answer, and you can hand it the go-ahead with `dorkos uninstall <name> --approval <token>`.
  Clicking Uninstall yourself in DorkOS works exactly as before (DOR-467). With **Require login** on, the approval must be granted by a signed-in person in the browser; `dorkos uninstall` then prints the command to finish once you've said yes.
- Agents can no longer change the settings that protect your instance through the settings
  API. Turning off sign-in, widening which folders DorkOS may touch, and changing where its
  credentials go are yours to choose. Your own changes in Settings are unaffected (DOR-467).
- Ask you first before an agent deletes one of your scheduled tasks. Deleting a task
  cannot be undone, so it now waits for your approval like removing a package does
  (DOR-468)
- Ask you first before an agent removes another agent. That one call used to take
  three things at once: the agent, its setup file on disk, and its scheduled tasks
  (DOR-468)
- Sort every tool an agent can reach into read-only, changes-something, and
  cannot-be-undone, so a new tool cannot arrive without somebody deciding which it is.
  Only the two above wait for you; everything else runs exactly as before (DOR-468)
- Refuse extension names that would put a new extension outside your extensions folder (DOR-507)
- With **Require login** on, the settings screen now insists on a person, not just an account. Changing the settings that protect your instance (whether login is required, the key for the tool endpoint, the folder DorkOS may touch, the programs it may start, your privacy choices) now needs someone actually signed in to DorkOS. A program holding one of your API keys is refused, where before a key was enough to turn login itself back off. Nothing else about signing in changed (DOR-505).
- Three of those settings can also be changed from their own buttons elsewhere, and those paths are not guarded yet at all: connecting a model provider, starting your public web address, and linking this instance to a DorkOS account. They do not check who is calling, so this is unchanged whether **Require login** is on or off. The approvals guide says which is which, and we are closing them separately (DOR-505).
- Worth knowing if you leave **Require login** off, which is the default: nothing changes there, and nothing can. A program on your own computer that hides the fact it is an agent looks exactly like you clicking a toggle in Settings, so DorkOS has nothing left to tell the two apart. Turning on **Require login** is what closes it. The approvals guide now spells out which of the two you have (DOR-505).
- Agents can now only read a Relay inbox that belongs to them: their own address, an inbox handed to them when they sent a background message, or one they set up themselves. Before, an agent could name any other agent's address and read its waiting messages, and polling with `ack` deleted those messages for good. The same rule now guards removing an endpoint, which throws away its whole mailbox. Asking for someone else's inbox is refused, and says so. (DOR-506)
- An inbox keeps belonging to the agent that set it up, even after DorkOS restarts. Ownership used to live only in memory, so the first agent to ask for an address after a restart became its owner, could read mail meant for someone else, and locked out the real owner. (DOR-506)
- Two inbox names that differ only in capital letters can no longer both exist. On macOS and Windows they shared one mailbox on disk, so an agent could wipe another's messages by registering a differently-capitalized copy of its address and then removing it. (DOR-506)
- Agents can no longer claim the addresses DorkOS manages itself (`relay.agent.*`, `relay.system.*`, `relay.human.*`). Claiming another agent's address would have quietly intercepted its incoming messages, not just read them. An agent's own inboxes live under a set of addresses of its own (`relay.inbox.*`). (DOR-506)
- A standing permission cannot outgrow what you agreed to. It covers one agent and one action, never a group of either. Its clock is set the moment you grant it and using it never extends the clock, so an agent cannot keep itself trusted by staying busy. It stops working the instant you end it, the instant you switch standing permissions off, and the instant you turn off Require login. And nothing an agent can do creates one: opening a permission needs a person signed in to DorkOS, so answering a single approval is not enough (DOR-501)
- Your agents cannot read the list of what they are allowed to do without being asked. Knowing which irreversible action goes through silently right now, and the minute the window shuts, is a map worth keeping to yourself, so that list needs the same proof of a person as answering an approval does. And when DorkOS starts, any permission left over from a time when it was not allowed to exist is ended, whether that is because standing permissions were switched off or because Require login was, so turning either back on never wakes an old one (DOR-501)
- No trust level can switch off the questions about DorkOS itself. Running a session at a level that skips prompts still leaves removing packages, deleting scheduled tasks, and the rest of the actions that cannot be undone behind the same question. That is now something DorkOS tests for rather than something that happens to be true (DOR-501)
- Only you can change where DorkOS gets packages from. A marketplace source is a place DorkOS will download and run code from, so an agent that tries to add or remove one is now turned down with a plain refusal telling it to ask you instead. There is no card and no way for it to say yes. Adding and removing sources still works normally from your own terminal and from the Marketplace sources screen, and agents can still list, refresh, and validate sources and install from the ones you already added (DOR-502)
- Close a hole where a web page you visit could drive your agents. A page can point its own domain at your own machine, which makes your browser treat it as if it came from DorkOS. DorkOS now answers only to the address you actually use, so that page gets turned away (DOR-532)
- Reach DorkOS by another name, like `dorkos.example.com` behind a proxy? Set `DORKOS_TRUSTED_HOSTS=dorkos.example.com` and it works again. Turning on login skips the check entirely, and the official Docker image is unchanged (DOR-532)
- Stop a stranger from installing software on your machine through DorkOS. The buttons that install Ollama, Codex, and OpenCode are meant for you, sitting at your own computer. They trusted headers that any caller can set, so anyone who could reach your instance could start an install. DorkOS now checks the network connection itself, which nobody can fake. Docker is unaffected, because there the container already controls who gets in (DOR-532)
- Worth knowing if you leave **Require login** off, which is the default. Two of the rules above work out _who is writing_: the reply limit that your messages reset, and the rule that only you change who is in a room. Both need DorkOS to tell you apart from a program running on your own computer, and with login off it cannot — a program that simply does not mention it is an agent looks exactly like you. Read those two as shaping how a room behaves, not as limits on what it can spend.

  **The hourly limits are the ones that hold either way**, because they never ask who is calling. The per-room limit caps what any one room runs; on its own that is not a cap on your bill, because a program that keeps making new rooms gets a fresh allowance each time. The total limit is the real ceiling: 240 automatic replies an hour across everything, however many rooms exist. Both reset if DorkOS restarts.

  None of this gives a program on your machine anything it did not already have — anything that can send these messages can run an agent directly. What these limits are really for is stopping well-behaved agents from talking each other in circles by accident, which is the common case and worth having on its own. Turning on **Require login** is what tells you and a program apart (DOR-526, DOR-505)

- A settings block that was missing the feature-usage entry no longer counts as permission to send those events. A missing answer is never treated as a yes (DOR-584)
- A message from Slack or Telegram can no longer run a shell command on your
  machine without asking you. A chat message started an agent turn, that turn
  landed at a trust level nobody had chosen, and at that level every tool —
  including the one that runs shell commands — was approved automatically. Now
  anything that reaches DorkOS for a decision asks you first, whatever level the
  turn is at. The one exception is **Full autonomy**, which is what that setting
  means and says (DOR-604)
- "Accept edits" now does what it always said it did: accept edits. It promised
  "auto-accept file edits; still prompt for other tools" and then approved
  everything, shell commands included. It also no longer waves through a file
  edit that tried to write outside the folder the agent was working in —
  something like your `~/.ssh` keys or your shell profile — which is exactly the
  case worth stopping to look at (DOR-604)
- Only people you name can approve a tool call from chat. When your agent asks
  permission to run something, it posts an Approve/Deny card into the
  conversation — and anyone who could see that card could press Approve,
  including the person whose message set the whole thing off. Now Slack and
  Telegram integrations each have an "Approvers" list, and only the people on it
  can answer. It starts empty, which means nothing gets approved from chat until
  you say who may — and it is deliberately a separate list from who can message
  your agent, because talking to it and letting it run a command on your machine
  are not the same permission (DOR-609)
- A new Slack integration only answers direct messages from people you name.
  It used to accept a DM from anyone in the workspace, and a DM starts an agent
  turn on your machine. Integrations you already set up keep working exactly as
  they did, and DorkOS now says so at startup if one of them is open to your
  whole workspace, so it stays your choice rather than an accident (DOR-604)
- The timers a Shape sets up can no longer start themselves, or hand themselves
  a free pass. A Shape's setup file lists recurring tasks it wants for you, and
  until now that list could say two things nobody had agreed to: start the moment
  this Shape is applied, and run with every approval prompt turned off. Both are
  the kind of thing you should decide, not the package. Now one of those timers
  arrives turned off unless the Shape's author asks for it to start, and a
  request to skip all approvals is refused: DorkOS sets the task up asking, and
  leaves you a note saying the Shape wanted more than it got. You can still turn
  the timer on, or raise what it may do, on the task itself once you have read
  what it does. This covers the timers a Shape asks for in its setup file; a
  package that ships a task file of its own is separate work, still to come
  (DOR-607)
- Ask before an installed package adds commands to your coding agent. Some marketplace packages ship hooks: commands your agent runs on its own, before or after it does things. Until now, installing one was enough to put those commands in place, with nothing shown and nothing to click. DorkOS now shows you each command and when it would run, and waits for your answer. Say yes and they go in; say no and the rest of the package still works. Your answer is remembered per package and per project, and DorkOS asks again if a later version wants to run something different, or wants to run the same thing at a different moment (DOR-522).
- Stop an agent package from taking over the folder you install it into. Installing an agent package into a project treated the whole project folder as the package: DorkOS moved your folder aside, put the package in its place, and deleted the folder it had moved. It also meant the package could drop files anywhere, including places DorkOS reads. An agent package now installs into `.dork/agents/<name>/`, the same way plugins do, and everything already in your project stays where it is (DOR-522).
- Your agent can no longer set up recurring background jobs on your machine
  without asking you. Switching to a Shape does more than rearrange the cockpit:
  it turns on every scheduled job that Shape comes with, and each one runs later,
  on its own timer, with nobody watching. A Shape can also say that its jobs
  should skip every safety prompt. Because switching Shapes was filed under
  "moving things around on screen", an agent could do all of that in one step and
  you would never see a prompt. Now an agent that wants to switch Shapes has to
  ask you first, and you see which Shape before you answer. Clicking a Shape
  yourself is unchanged: no extra prompt, it just switches (DOR-625)
- The rest of what an agent can do to the cockpit is untouched. Opening a panel,
  showing a file, throwing confetti, switching which project you are looking at:
  all still instant, no prompt. Only the one action that reaches past the browser
  and onto your machine asks (DOR-625)
- Messages other members wrote now reach an agent inside a clearly marked block that says they are information, never instructions. The markers around that block carry a one-time code, so nobody can end it early by typing the closing line into a message and having the rest read as trusted. (DOR-622)
- Names, room topics and agent handles are cleaned before an agent sees them, using the same check that already protects messages arriving from Telegram and Slack. Someone cannot use their own display name, or the message a thread was started from, to slip an extra instruction into what an agent reads. (DOR-622)

### Note for people upgrading

- Extensions you installed before this update start out not allowed, and they wait for you the first time. This is deliberate: DorkOS will not treat "you switched this on once" as "you read this code". Open Settings → Extensions and allow the ones you want. It is one click each, once. Until then an extension you have not allowed will not show up in DorkOS at all, so if something you use has gone missing, that is where it went.
- Nothing changes until you choose an account. Until then DorkOS works the way it always has. Before this release, DorkOS used whichever account the terminal you launched it from happened to point at. That meant sessions from your other accounts were quietly missing from your list.

## [0.56.0] - 2026-07-22

> First-run setup becomes a real conversation with DorkBot, the dashboard grows hands so you can start work straight from it, and connecting OpenCode begins with one plain choice about where your models run.

### Added

- A conversation entry point after setup: the sidebar "Getting started" card leads with a "Talk to DorkBot" row that opens DorkBot (DOR-416).
- Hear each personality before you choose it: as you pick how DorkBot should sound during setup, DorkBot posts a short line back in that exact voice (DOR-417).
- Open a chat that already carries your first message, so it sends the moment the session opens and your words show up as your own (DOR-417).
- Start a session right from the dashboard. The top of the page now asks "What are we building today?" with a message box; send a message and it opens a session with your default agent, with your words already sent as your first turn (DOR-418).
- See and message your agents from the dashboard. A "Your agents" row shows your agents as cards, each with a plain-language status like "Working now" or "Idle since yesterday". Click a card to open a session with that agent (DOR-418).
- DorkBot now shows you around the app at the moments it matters. Ask "Show me around" any time to walk the dashboard, and the first time you schedule a task, connect a channel, or add a second agent, DorkBot offers to point out where that lives. Tours run on your real screen, never a mockup, and you can leave any time by pressing Escape or clicking outside. Say "Later" once and it will not ask again (DOR-419).
- Open 3D models, audio, and video files right in the canvas, plus every text file a project contains. New audio/video viewers play inline, and the 3D viewer now loads 3MF/PLY/FBX/DAE models alongside glTF/GLB, STL, and OBJ (DOR-420).
- Audio and video are new media types that stream from the server, so playback can seek to any point mid-file without downloading the whole clip (this uses HTTP Range requests). An unsupported binary shows a friendly in-canvas message instead of breaking the canvas (DOR-420).
- OpenCode's model list now comes back grouped into Frontier, Solid coders, and Quick helpers, and sorted for you. Models that run on your own computer are marked as local, and frontier models stay cloud-only (DOR-422).
- You can now pull any Ollama model by name, not just a short preset list. For each model DorkOS gives an honest read on whether it will run well, may be slow, or is too large for your hardware (DOR-422).
- On Windows and Linux machines with an NVIDIA graphics card, those hardware reads now count your GPU memory, not just your system memory (DOR-422).
- Start a new agent right from the dashboard: the Your agents section now has a New agent button next to its heading.

### Changed

- First-run setup is now a conversation with DorkBot instead of a stack of forms. DorkBot introduces itself, helps you pick how it sounds, offers to look around for projects you already have, and then hands you a real chat box. Your first message drops you straight into a live session, so setup ends by getting to work rather than on a "you're all set" screen (DOR-417).
- The dashboard status cards now say what they mean for you. Instead of "1 adapter" or "0 schedules", they read "Connected to Telegram", "Nothing scheduled yet", "2 agents ready", and "Quiet this week" (DOR-418).
- Connecting OpenCode now starts with one clear choice: where your models come from. Instead of Local, Gateway, and Direct tabs, you pick a power source in plain language: best models with zero setup (in the cloud, via OpenRouter), private and free on your own computer, or your own API key for Anthropic, OpenAI, or any OpenAI-compatible server. Each option says its one honest trade-off up front, and connecting ends on a clear "you're connected" moment with a Done button. Your session switches to OpenCode automatically, so you can send your first message right away (DOR-423).
- The model menu is now searchable and grouped by what a model is good for: Frontier, Solid coders, Quick helpers, and More models. Models that run on your own machine are marked "private" so it's obvious what never leaves your computer. Short lists (like Claude Code and Codex) look exactly as before (DOR-423).
- The private, on-your-computer option is now a small manager: it shows the models you already have with an honest read on how well each fits your hardware, a short shelf of good coding models you can add in one click with a live download bar, and a box to pull any model by name. Prefer LM Studio or another local server? A link takes you straight to connecting it directly (DOR-423).
- Commands and file paths shown in the app now use one consistent inline style, so code you can copy is easy to spot.
- The setup screen now shows a friendly "We'll install it for you" note with the exact command one tap away, instead of a raw terminal line, and the button to start chatting reads "Meet DorkBot".
- Setup details now list each coding agent's name on its own line, so long names and their descriptions are both fully readable.
- When you connect Codex or Claude, signing in is now the first thing you see. Prefer a key? "Use an API key instead" reveals the key field, and you can switch back anytime.
- The first-run setup screens now work with your browser's back and forward buttons, and a refresh keeps you on the same screen instead of starting over.
- The personality step in onboarding now sits in its own card with a bigger, centered radar, and DorkBot previews its voice in a quote right inside the card instead of as a stray chat message.

### Fixed

- The setup finish screen keeps the completion screen up until you act. It used to close on its own a second or two after appearing, dropping you on the dashboard before you could click "Start your first session" (DOR-416).
- Never-active agents show as new, not dead. A DorkBot you just set up reads "New" instead of "Stale" or "Never active", and it stays visible in the sidebar instead of hiding under "inactive agents" (DOR-416).
- The finish-screen confetti stops on exit: it clears after a few seconds and when you move on, instead of drifting across the screen long after setup (DOR-416).
- One broken file can no longer take down the whole canvas. When a document fails to open, only that tab shows a short "This tab hit a problem" message with a Retry button. Your other tabs and the tab strip keep working. If the app updated while the tab was open, the message offers a one-click reload (DOR-420).
- 3D models degrade gracefully. If your device can't open a 3D view, the tab shows a plain message instead of breaking the canvas (DOR-420).
- Opening and closing 3D files over and over no longer piles up graphics memory. When you close a model, the viewer now frees its geometry, material, and texture resources, and an unused material fallback was removed (DOR-420).
- Markdown files open ready to edit again. Click the pencil on a Markdown file in the canvas and it turns editable right away, keeping your place. Your typing autosaves as before (DOR-420).
- The canvas now matches the theme you picked in DorkOS. Markdown, code files, and change diffs all follow your light or dark choice, so a light app stays light and a dark app stays dark even when your computer's own setting disagrees. And if you leave DorkOS set to follow your computer, it now reads that setting correctly too. Switching themes updates every open document instantly, no reload needed (DOR-420).
- DorkOS now remembers your OpenCode connection. Once you connect OpenCode (through OpenRouter, your own API key, or local models on your computer), it stays ready across page reloads and restarts. You are no longer asked to sign in again when you already had (DOR-422).
- Dialogs now open in place instead of flying in from the top-left corner.
- The guided tour's highlight now glides smoothly from one spot to the next instead of jumping in from the corner.

## [0.55.0] - 2026-07-22

> Smart groups keep a fleet of agents organized, a new connectors foundation brings outside services into your agents, and first-run setup gets shorter and more honest.

### Added

- The file tree now remembers where you were. Open a file, switch panel tabs, or reload the page, and the Files panel comes back exactly as you left it — the same folders open, the same file highlighted, scrolled to the same place. Each working directory keeps its own spot, so moving between projects picks up right where each one was (DOR-404).
- Give each agent group its own "Show" filter (All, Active, or Needs attention), so a busy fleet collapses to just the agents actually waiting on you. Agents that have been quiet for a week tuck themselves behind an honest "N inactive agents" count instead of cluttering the list; click it to see them. (DOR-339)
- Mute a noisy agent or an entire group from its right-click menu. A muted agent dims, drops its activity badge, and never lights up a group's activity dot, but it always stays in place and clickable. Unmuting a group restores each member's own mute setting. (DOR-339)
- Sessions that were not you talking to the agent directly (an automated scheduled run, another agent messaging in, or a message that came through Slack or Telegram) now show a small, quiet icon so you can tell them apart from your own conversations.
- Your own recent conversations show first in the sidebar. A quiet "+ N automated" line lets you reveal the rest when you want to see them.
- Opening a session shows the same information at the top of the chat, so you always know where it came from.
- Build a sidebar group that fills itself in: pick "Active now" or "By runtime · Codex" from the "+" menu, or write your own rule (runtime, namespace, status, how recently active, folder path), and DorkOS keeps the group's members current on its own as agents start work, go idle, or switch projects. Only shows up once you're running 8+ agents or 2+ runtimes, so a small fleet's sidebar looks exactly like it did before. (DOR-338)
- A smart group always tells you what it's showing: a plain-English rule summary in its menu, and an honest "No agents match these rules" instead of vanishing when nothing qualifies. You can't drag an agent into one, dropping on it shows a reminder to edit the rule instead, and matching agents still show up in their usual group too. (DOR-338)
- Change your mind any time: "Edit rules" reopens the same rule form, and "Convert to manual group" freezes today's members into a regular group you manage by hand. (DOR-338)
- Agents now know who they're talking to on Telegram and Slack: the sender's name and the chat title ride along with each incoming message. Session lists and headers show it too — "Telegram · Dorian" or "Slack · #incidents" instead of just the platform name.
- `dorkos package init` now takes `--categories`, so new packages start with the right marketplace categories instead of an empty list. (DOR-373)
- Sort the Marketplace by Popular again: packages now show real community install counts, and the sort orders the most-installed first. When you are offline, the Popular option grays out instead of quietly doing nothing.
- Install the Codex CLI for you with one click. When Codex is set up but not yet on your machine, DorkOS can download it for you and turn the check green, the same way it already handles OpenCode.
- Sort the Marketplace by Recent again: the sort now orders packages by when they were last updated, read from the registry's real change history, so the most recently touched packages come first. When you are offline, the Recent option grays out instead of quietly doing nothing.
- New connector setup guides you can read before you turn anything on. They show how to connect a service like Gmail through Composio, or point at your own tool server, and each one says in plain words where your login is kept. Connectors are still in alpha (DOR-371).

### Changed

- Reading an agent's Relay inbox now shows only its real, deliverable messages by default. Before, a message the budget gate rejected could show up right next to real ones, with nothing telling a script apart. Pass `?status=failed` to see rejected messages, or `?status=all` to see everything. (DOR-337)
- Coming back to the Files panel is now instant: folders you've already opened reappear straight away instead of loading again.
- Refresh now reloads every folder you have open, not just the top level — so a file added deep in the tree shows up the moment you hit Refresh (DOR-404).
- The show-hidden-files choice now sticks across a page reload, not only a tab switch.
- The Shape switcher tidies up after itself: when it takes you to a new agent, it steps aside instead of leaving a dead panel over the view, and it drops the extra "Open" button for the place you're already standing in. "Set up agent" now starts pre-filled from the Shape's own template. (DOR-378)
- The attention badge now updates the moment a run fails or a message bounces, instead of waiting up to 30 seconds for the next check. When the system notices an agent has gone offline, the badge reflects that right away too.
- Setup during onboarding now lets you get started the moment one coding agent is ready, instead of waiting until every runtime is connected. If Claude Code is set up, you'll see "You're ready" and a single "Get started" button, with the other agents tucked into a quiet "more agents available" section you can open anytime (or skip and add later from the status bar).
- Connecting an agent now does the work for you. Instead of copying terminal commands, you sign in right in the app or install an agent with one click. A small line under each button always tells you exactly what runs on your machine, so nothing happens behind your back.
- If no agent is set up yet, onboarding leads with a warm "Connect your first agent" step instead of a wall of red errors. The moment you connect one, it flips straight to the ready screen.
- The setup screen now scrolls on short windows and phones, so the connect cards and buttons are always reachable.
- The Obsidian panel now opens the same Inspector side panel as the web app. It holds Pulse, your agent's profile, and the file tree in one place, and slides in as an overlay so it fits the narrow panel. The terminal tab shows only where it's supported, so it stays hidden in Obsidian.
- First-run setup is shorter and more honest. It only shows the "import your projects" step when there is actually something on your machine to import, and it drops the separate task-scheduling step (you can still set up scheduled tasks any time from the Tasks page). Once you finish, DorkOS remembers, so setup never pops back up after a refresh. The finish screen now celebrates only what you actually did, with no list of skipped steps. A new "Getting started" card in the sidebar links straight to creating an agent, scheduling a task, or adding more agents. Changed your mind? "Replay setup" in Settings walks you through it again.

### Fixed

- Relay pulses in the mesh topology view no longer pile up when you're zoomed out or have reduced motion on, then burst out all at once the moment you zoom back in. Pulses that can't be shown are dropped right away instead of queuing up for a later flurry. (DOR-342)
- The mesh network map no longer lists an agent's teammates as if they were external connections (Slack, webhooks, and so on). With two or more agents in the same project, the map used to show each agent's siblings as "adapters" by mistake.
- The network map now shows the access rules that actually protect your projects from each other, not just the ones you added by hand. Before, the map said there were no rules at all, even though agents in different projects were already blocked from talking to each other by default.
- Session lists no longer show noise rows: sessions with no conversation in them (like "Session 3f2a…") and agents' internal helper transcripts are now hidden. Opening one directly by its link still works.
- Selection reveal no longer fights scroll restore on remount (DOR-404).
- Local folder marketplace sources now work with the standard Claude Code layout, where marketplace.json lives in a .claude-plugin folder.
- Installing a Shape through the API or an agent tool now tells you when your project choice was ignored: Shapes always install for all projects.
- Agents checking their relay inbox now see only messages waiting for them by default, even when they poll through the built-in `relay_inbox` tool instead of the HTTP endpoint. Before, that tool showed everything, so a message the budget gate rejected could sit right next to real ones with nothing telling them apart. Pass `status: "failed"` to see rejected messages, or `status: "all"` to see everything. (DOR-406)
- The setup screen no longer shows the same command twice. Each check now gives its own step: one line to install the CLI, a separate line to sign in. Before, a machine that had the CLI but wasn't signed in showed the full "install and sign in" command in both places for Codex and OpenCode.
- The connector recommendation flow no longer hangs when a provider is unresponsive: it bounds the wait and surfaces a warning instead of stalling silently. (DOR-371)
- In first-run setup, pressing Enter while typing in a connect field no longer skips you ahead to the next step before you're done.
- DorkBot setup works when DorkOS is limited to a workspace folder. When you run DorkOS with agents scoped to a single folder (for example the Docker setup that pins agents to `/workspace`), the "Meet DorkBot" step no longer fails with an access-denied error. DorkOS's own agents — DorkBot and anything you install from the Marketplace — live in DorkOS's data folder, and agent actions now treat that folder as always allowed. Reading and writing your own project files stays limited to the folder you chose.

---

Older releases (v0.1.0 – v0.54.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.54.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.54.0.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.64.0...HEAD
[0.64.0]: https://github.com/dork-labs/dorkos/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/dork-labs/dorkos/compare/v0.62.0...v0.63.0
[0.62.0]: https://github.com/dork-labs/dorkos/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/dork-labs/dorkos/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/dork-labs/dorkos/compare/v0.59.0...v0.60.0
[0.59.0]: https://github.com/dork-labs/dorkos/compare/v0.58.0...v0.59.0

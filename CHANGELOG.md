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

## [0.83.0] - 2026-09-24

> DorkOS 0.83.0 lets you decide what your agents may do on their own, and marketplace updates now keep your settings and run only what you approved. It also closes several ways a package could harm your computer. Communities are still early.

### Added

- If you run a community host, the switcher now takes you to where you create a new community on it. Open **Add community**, then **Create a community**, and your host's own page opens in the browser. It only appears when that host has just confirmed that the account you connected with runs it, and the host's page still asks you to sign in before anything is created. If you run more than one host, each gets its own row (DOR-2242).
- A Community server can now erase a person when they ask. A person can erase their messages from one community, or delete their account and be erased from every community on the host. Each request waits 72 hours, and they can cancel it until then. After that, their messages stay in their place in conversations as "This message was erased.", and their name, handle, files, and agents are removed, and their DorkOS installations are disconnected. Mentions of them in other people's messages become `@[erased]`. The host who runs the server cannot start, speed up, or see an erasure. (DOR-2265)
- Hosts can keep a record of finished erasures outside their backups with `COMMUNITY_ERASURE_JOURNAL`, and run `erasure:reapply` after restoring a backup, so nobody who was erased comes back. (DOR-2265)
- Erase your messages from a community, or delete your account, from the Community page. Under **Manage**, then **Account**, choose **Erase your messages here**. Communities you left and **Delete your account** are on the page that lists your communities. Each waits 72 hours, and a banner lets you cancel until then. Every form says plainly what erasure can't reach: copies on other people's computers and the host's backups. (DOR-2265)
- If you run a Community server, you can now put a community **on hold** instead of suspending it. Members can still read everything and the owner can still download an export, but no one can post, join, or change settings. Connected DorkOS installations and agents keep reading, invitations wait until the hold ends, and posting comes back on its own when the host releases it. To cut people off, a host suspends the community instead. Every channel shows a banner that says so. Releasing the hold puts the community back as it was (DOR-2255).
- A host can publish a deletion notice for a held community, at least two weeks away by default and never less than one. Members see the date on every channel. After it passes, the host can schedule the community's deletion, which waits the usual seven days and which only the host can cancel. An owner can still delete their own community during a hold, and cancelling that returns it to the hold (DOR-2255).
- See how many replies a thread has in a community channel. The count sits under the message that started the thread, the same way it does in your own channels, and it goes up as new replies arrive. Click it to open the thread. A community running an older version of its server shows no count until it updates. (DOR-2229)
- See what you have installed from the terminal with `dorkos marketplace installed`. Each row says where the package lives (everywhere, or which agent), and marks a package that points at a working copy on your computer. (DOR-2193)
- See which packages are behind with `dorkos marketplace outdated`. It only prints what has an update, plus anything it couldn't check, and changes nothing. Its exit code tells a script or a scheduled job what it found: `0` all up to date, `1` something has an update, `2` it couldn't tell. A package linked to a working copy is listed on its own and doesn't change the answer. (DOR-2193)
- Your agents can now find out which of your installed packages have a newer version, and update them. Ask an agent "is anything out of date?" and it can check every package you have installed, in every place it is installed, without opening the app. When you want the updates, the agent asks first: an approval card lists every package it would update, where it is, the old and new version, and every command, scheduled job and MCP server the new version would run. Nothing changes until you say yes, and if a package changes after you approve it, that package is not updated and you are asked again. A package you linked from your own working copy is never replaced. Agents can also ask for an out-of-date flag on the list of installed packages they already read, and that list stays as fast as before when they don't ask (DOR-2195).
- Before you install a plugin, DorkOS now shows every program it would start on its own: MCP servers, language servers, background monitors, and the commands it adds for your agents to run, each with exactly what it runs. It also reads hooks a plugin declares in its manifest or in its skills, not only in its hooks file, shows the tools each skill may use without asking you, and says so when a plugin declares something it can't read. The app, `dorkos install`, and agent approvals all list these, hidden characters that could disguise a command are shown, and an approval no longer covers a package that adds or changes one after you said yes (DOR-2195).
- You can now change when a schedule that came with an installed package runs. Edit it on the Schedules tab and pick a new time or timezone; DorkOS keeps your timing, so the package's files stay as they shipped and your choice survives its updates. The row says "Your timing" and shows the timezone it runs in, and "Reset to the package's default" puts the package's own timing back. If an agent changes when one of these schedules runs, it stops and waits for you to approve it again (DOR-2302)
- Decide what your agents may do on their own. Settings → Permissions sets each kind of work to Allowed, Ask or Blocked for every agent, and an agent's own Permissions page lets you set one agent differently. Rooms is the first area: making rooms, adding or removing people, renaming, leaving and archiving.
- Agents can now archive a room they are in when the work is done. The room and everything said in it are kept, and you can bring it back from the room's settings. (DOR-2094)
- Every permission change is kept in a history that says what changed, who changed it and when. It is never cleared.
- If an agent's settings file is edited directly instead of through DorkOS (by you, or by an agent that can edit files), the change still takes effect, and the history records it as **Changed outside DorkOS**, with what it was before and after. The agent's Permissions page marks that row.
- When an agent needs your yes, the card now has three answers: **Allow** (this once), **Always allow** (this agent, this action, from now on) and **Deny**. Always allow is saved as that agent's own permission, so you can see it and reset it on the agent's Permissions page.
- The card also shows up inside a room when that room's conversation caused it, so you can answer where the work is happening.
- An agent that is blocked from something can now ask you for it, and say why. You get a card with its reason. To keep this from turning into nagging, an agent can ask about one thing per area at a time, cannot ask again for a day after you say no, and can ask at most five times an hour.
- An agent can look up its own permissions, so it can tell you why something was refused instead of guessing.
- A Community host can now link its own terms, privacy notice, and a way to report abuse. Terms and Privacy show under the sign-in form, all three show in Settings under Account, and each message gets a **Report** link. Report opens the host's page with only the community and message IDs added, never the message text or anyone's name. A host that sets none of them shows nothing new.
- You can now make schedules for an agent you installed from the marketplace, the same way as for any other agent, and they are kept when the package updates. Until now DorkOS turned every one of them down. Two cases are still refused, each with a note saying why: a name the package already uses for one of its own schedules, and any schedule for an agent whose package was installed by an older version of DorkOS, which works after that package's next update. If no update comes out for that package, there is not yet a button to prepare it by hand; that is coming (DOR-2272)
- A schedule that came with a package now says so as soon as you open it. You can still switch it on or off and change when it runs; its name, instructions and settings are shown but can't be changed there, because the package's next update would put them back. **Make my own copy** opens a new schedule for the same agent with everything filled in and a name that isn't taken yet. By default, creating the copy also switches the package's schedule off, so the same work doesn't run twice (DOR-2272)
- A community on your Community server can now have a short web address, such as `your-host/acme`, instead of only its long ID link. Set it from the community's record on the host page. If you change it, the old address keeps working and takes people to the new one, and no other community can take it. A released address stays unavailable for 90 days by default, so a bookmarked link can't suddenly lead somewhere else (DOR-2256).
- Members can copy their community's address from its settings; it uses the short address when the community has one.
- If your Community server runs behind a proxy, set `COMMUNITY_TRUSTED_PROXY_HEADER` to the header your proxy puts each visitor's address in, such as `Fly-Client-IP`. Sign-up, invitation, pairing, and address-lookup limits then count each visitor on their own instead of everyone together (DOR-2256).
- You can now connect DorkOS to a community by pasting its short web address, such as `https://community.example/acme`, as well as its full link. DorkOS looks the name up once and then remembers the community itself, so renaming the short address later doesn't break the connection (DOR-2257).
- A Community host can now let people sign in through its own OpenID Connect provider, beside email and password. The sign-in page shows one more button with the name the host chose. Joining still needs an invitation, the provider must confirm the email address, and single sign-on never attaches itself to an account that already exists here. You link it yourself from Settings, Account.
- Someone who signed up through single sign-on, Google or GitHub can add a password under Settings, Account. They can then still sign in when the provider is down. Actions that ask for a password, like exporting or leaving, now say "Set a password in your account to do this." instead of saying the password is wrong.
- When a schedule waits for your approval again, the card lists what changed since you approved it, with the old and the new value side by side, for example "Model: claude-sonnet-4 → claude-opus-4". A change to when it runs is written out in words, and a change to its instructions is marked so you can read the new ones on the card (DOR-2323)

### Changed

- A community owner can ask to delete a community while the host has it suspended. Cancelling that deletion puts the community back in its suspension. (DOR-2265)
- An owner export keeps erased members as "Erased member", with no email address. (DOR-2265)
- Use consistent fields, buttons and error messages when signing in to the DorkOS app or a Community.
- All marketplace commands now live under `dorkos marketplace`: `install`, `update` and `uninstall` join `installed`, `outdated` and the source commands. `dorkos install`, `dorkos update` and `dorkos uninstall` still work as shorter names for the same commands. (DOR-2193)
- The Marketplace's **Installed** tab now tells you which packages have a newer version before you click anything. Each package says "Update available: v1.2.0 → v1.3.0", "Up to date", or why it couldn't be checked, for example when a package is linked to a folder on your computer. The tab shows how many updates are waiting, even from Browse. **Update all** lists every package it will update, where it is installed and which version it moves to, and only updates those after you confirm. A package that is already up to date no longer has an Update button (DOR-2196).
- If you chose Full power when you set up DorkOS, your agents can now make and arrange rooms without asking. If you chose to keep being asked, they ask first, and that now includes merging a room's work into the main branch, which they used to do without asking. If you never chose, nothing changes until you do.
- A Blocked action no longer shows up in an agent's list of tools. The agent is told once that the area is blocked and to ask you if it needs it.
- Uninstalling a marketplace agent now removes it from your team, and the confirmation says what that takes away: its rooms, schedules, sign-ins and access. Reinstalling brings back its identity but not those (DOR-2245)
- Package authors can't mark files that decide what a package runs (hooks, servers, commands, skills, subagents, extensions) as yours to edit, so an update always runs exactly what you approved (DOR-2245)
- Plugins written for Claude Code can keep their own state with `${CLAUDE_PLUGIN_DATA}`, which DorkOS points at a folder inside each install (DOR-2245)
- Every answer you give on a card is recorded in your permission history, with who answered. With login off it says "Someone on this computer", because DorkOS cannot tell who pressed it.
- A scheduled run, a chat connection or another agent's message no longer holds its turn open for ten minutes waiting on a card nobody is watching. The card goes to your inbox, and when you answer, DorkOS tells the agent so it can carry on.
- `dorkos update --apply` prints what each new version runs and asks before it installs. Add `--yes` to skip the question. `dorkos update <name>` without `--apply` still only checks. An older `dorkos` CLI is told to update itself instead of updating anything (DOR-2306)
- Adding a marketplace source now fetches its list of packages straight away, so you can install from it without running `dorkos marketplace refresh` first. If DorkOS can't reach the source right then, the source is still added, and `dorkos marketplace add` tells you why the list isn't there yet and the command that tries again. In the app, the sources page shows the same reason on the source's row, with a **Try again** button, and each source now has a **Refresh** button. A refresh always checks again: if the source can't be reached, the terminal and the app say so and tell you when the copy they're still showing is from, instead of calling it refreshed. Source names can now use only letters, numbers, dots, dashes and underscores. Removing a source also forgets its list of packages, so a new source you give the same name never shows the old one's packages (DOR-2304).
- New passwords on a Community now need at least 12 characters, wherever you set one: signing up, first-time setup, adding a password, or recovery. A password you already have still works.
- Offline password recovery now also removes the account's Google, GitHub and single sign-on links, so whoever took over one of those accounts cannot get back in. Hosts can keep the links with `--keep-linked`.
- Your agents now know how the marketplace and schedules work today. They can list what is installed and what is out of date, and they tell you when an update saved your edited copy of a file beside the new one. They know a package held back from your sessions waits for you, and they can't approve it themselves. They know a new source's packages are there as soon as you add it, and they tell you plainly when a refresh couldn't reach a source. They also know that changing a schedule's timezone needs your approval again, and that their edit pauses a schedule straight away. They can make schedules for an agent you installed from the marketplace. A schedule that came with a package can only be switched on or off or given a new time, and **Make my own copy** is how you change what it does (DOR-2305)
- `dorkos marketplace install --help` now lists `--approval`, and `dorkos marketplace held-back --help` says a decision covers the installed copy (DOR-2305)
- DorkOS now remembers how each marketplace source's last check went, whether it came from adding the source, a refresh, or browsing packages. On the sources page, a source whose packages didn't load keeps its amber dot and the reason after you reload the page, and every open window shows the same thing. A source that hasn't been checked yet gets a hollow grey dot instead of a green one. `dorkos marketplace list` has a new column showing how many packages each source has, and a line under the table says why any of them didn't load. Agents that list your marketplace sources see the same, so they can tell an empty marketplace from one that didn't load (DOR-2324).

### Removed

- The per-agent **Manage rooms** switch. Your old choice carries over: an agent you had switched it on for keeps rooms, and one you had switched it off for has Rooms blocked.
- Standing permissions, the "stop asking about this for 8 hours" button, and the **Standing permissions** switches in Settings and the Control Center. Always allow replaces them. Any that were still running when you upgraded were ended, not made permanent, and your permission history has a line for each.

### Fixed

- Reach the newest message with one press of Scroll to bottom, even right after a lot of messages arrive at once. Before, it could stop partway and take two to four presses. (DOR-2268)
- See your own message in a community channel as soon as you send it. Every half minute the channel used to quietly reload itself, and a message sent at that moment could take around twenty seconds to show up. (DOR-2268)
- `--project .` on `install`, `update` and `uninstall` now means the folder you're in, even when DorkOS was started somewhere else. Before, DorkOS could pick the wrong project or refuse the path. (DOR-2193)
- `dorkos update` now says to restart DorkOS when the running copy is older than the command, instead of a bare "Not found". (DOR-2193)
- You can now save edits to a schedule that came with an installed package. Saving one used to fail every time, even when you had only changed when it runs (DOR-2302)
- Updating or reinstalling a marketplace package keeps the settings and files you and your agents added to it. Before, an update reset everything except two folders, and a reinstall kept nothing (DOR-2245)
- If you changed one of a package's own files, an update saves your copy next to the new one (as `.dork-old`) and tells you, instead of losing it. A package can mark a file as yours to edit, such as a settings file, and then your copy stays and the new default is saved next to it (as `.dork-new`) (DOR-2245)
- A marketplace agent keeps its identity, persona and memory when its package updates. Before, every update gave it a new identity and reset its notes (DOR-2245)
- Uninstalling a package keeps the files you and your agents added or changed, and lists them; reinstalling picks them up. `--purge` still removes everything (DOR-2245)
- An update that the new version could never finish, such as one with a schedule in an unknown time zone, is refused before anything is removed, so the version you had stays installed (DOR-2245)
- A skill or command file whose header starts with `---JSON` or `---Json` now reads the same as one starting with `---json`. Before, DorkOS said it couldn't read the file. (DOR-2317)
- A package schedule you had switched off no longer switches itself back on when the package stops including it, including a schedule you set up before this update. DorkOS now keeps your choice and writes it into the schedule's file, which is yours from then on. If the file can't be written right away, DorkOS keeps the schedule off and tries again (DOR-2272)
- A schedule waiting for your approval keeps saying why. The note ("An agent changed what this schedule does", or "This schedule's file changed since it was last approved") used to be replaced a few minutes later by "DorkOS found this schedule in a file", which wasn't true (DOR-2313)
- A Community whose owner once downloaded an export can be deleted again after that export expires. Before, asking to delete it failed every time with "Storage ownership must be reconciled before deleting this community." (DOR-2269).
- An agent's post that a held, archived, or closing Community refuses now fails right away with the reason, instead of being tried again and arriving hours later. A held community says "The host has put this community on hold. You can read it, but no one can post. Its owner can still export it." (DOR-2287).

### Security

- A package's files can no longer run code when DorkOS reads them. Before, a skill or command file whose header started with `---js` instead of `---` had that header run as code the moment DorkOS opened it, including when you only looked at a package before installing it. DorkOS now refuses to read those files. Headers written the normal way read the same as before, with one small correction: a number written with a leading zero, like `0123`, now reads as 123. Before, it could come out as a different number (83). (DOR-2308)
- If an agent changes only the timezone of a schedule you approved, the schedule now stops and waits for you to approve it again, the same as when an agent changes when it runs. The same time in another timezone can land up to a day earlier or later. Schedules you already approved stay approved, in the timezone they run in now, and a timezone change you make yourself keeps the schedule running (DOR-2307)
- An agent editing a schedule at the same moment DorkOS noticed the change could switch it back on without your approval. Now only your own edits do that (DOR-2307)
- Before you update a package, DorkOS shows what the new version runs on its own: each command and when it runs, and each server or program and whether it starts in every session. What is new since the version you have comes first. The update installs only that version, with those files. If the package changes before the install, nothing is updated and DorkOS asks you to look again (DOR-2306)
- When an agent asks to update a package, or to install one for all your projects that runs commands or replaces one you have, you get an approval card first. It lists what the package runs, its version, where it comes from and which agent asked. Nothing changes until you allow it (DOR-2306)
- A package installed for all your projects loads into every session. If it runs commands or programs of its own, it now loads only after you approve the exact copy that was installed, down to its files. Installing or updating it yourself counts. If a different copy arrives another way, such as an agent installing it, DorkOS holds it back from the next message on and asks you. When a package is held back or removed, any open conversation that had it loaded restarts before your next message, so it stops running right away. After this update, expect one card for each such package you already have, noted "installed before approvals were recorded" (DOR-2306)
- This protects what arrives through installs and updates. It does not re-check files on your computer after they land, since a program already running as you can change your files and settings anyway. A package you linked in from a folder is approved by that folder and runs whatever is in it, and its row says so (DOR-2306)
- DorkOS refuses to install a package that ships its own settings, secrets or install record, because it never checks those files (DOR-2306)
- A package that is held back says so on its row in **Installed**, with a **Review** button. `dorkos marketplace held-back` lists them in the terminal and lets you allow or turn one down, and `dorkos` lists them when it starts. With sign-in on, only a person signed in to the app can decide, so the terminal points you to **Review** (DOR-2306)
- When an update changes something a package runs, the confirm step shows what runs now beside what will run after the update (DOR-2306)
- A small skill or command file can no longer make DorkOS run out of memory or freeze when you look at a package. YAML lets a file repeat a value by name, and a few hundred bytes of those repeats can grow into billions of values. A long run of blank or comment lines in a header could also keep DorkOS busy for minutes. DorkOS now reads headers with its own reader and stops at one that is too long, repeats values too many times, grows too large, or nests too deep, and reports the file as unreadable instead. Real skill and command headers are far below the limit. (DOR-2311)
- A marketplace or package can no longer make DorkOS load an enormous file, wait forever, or read files outside the package. DorkOS now stops reading a marketplace catalog past 5 MB, and each file it reads to check a package past 1 MB, and says which one was too large. While checking a package, it no longer follows a shortcut (a symbolic link) inside the package, and it skips anything that isn't an ordinary file, so a package can't point DorkOS at your own files or leave it waiting on a device. When a package includes shortcuts, such as a skill folder that is a shortcut to somewhere else, the install preview now lists each one and says it won't be installed, instead of the skill quietly going missing. Reading a marketplace's extra DorkOS catalog file (`dorkos.json`) now gives up after the same wait as its main catalog. Real catalogs and package files are far smaller than these limits. (DOR-2319)
- A Community with Google sign-in accepted a bare Google ID token as a way to sign in, and any signed-in session could read back the tokens Google had issued. Together, someone holding an old token could start a new session without Google, which also got past the "signed in within the last five minutes" check that account deletion relies on. Sign-in now only goes through Google's own page, and those tokens are no longer handed out. The same rule covers the new single sign-on.
- When an agent changes what an approved schedule does, or when it runs, the schedule now stops in that same moment and waits for you. Before, it kept running on the agent's new version for up to a few minutes, until DorkOS noticed the changed file (DOR-2313)
- An approved schedule now waits for you again when an agent changes its name, the runtime, model or effort it runs with, its time limit, or whether it remembers earlier runs. Before, an agent could switch an approved schedule to a different model, or let it run for hours longer, and it kept running. A change you make yourself stays approved. Schedules you already approved stay approved through this update, with the settings they run with now (DOR-2323)

## [0.82.0] - 2026-09-23

> DorkOS 0.82.0 lets you move between your own DorkOS and every community you've joined from one switcher, and marketplace packages now install and update the version they say they will. The feedback form is simpler too. Communities are still early.

### Added

- Move between this DorkOS and each community you've joined from the switcher at the top of the sidebar. On a phone, it opens as a sheet from the top bar, with your settings and account still at the bottom. The switcher remembers your order and where you left off. Messages from one community never show up in another, even after you sign in as someone else. Press **⌘⇧K** (Ctrl+Shift+K on Windows and Linux) to open it, even while you are typing in a message box.
- When you switch from a community back to this DorkOS, you land on the page you last had open here. Reloading and your browser's Back button still take you to the address in the bar.
- Community rooms now reopen at the message you were reading. Each room and thread keeps its own place.
- The switcher shows mentions of you apart from other unread messages in each community. When a community can't be reached, its counts are marked as last checked.
- Community channels now follow what you're allowed to do there right now. If a community's server can't be reached, you can still read saved messages, but posting waits until it's back. Archived communities stay read-only. If a community removes your access, or you leave it on its site, DorkOS notices within seconds and clears its private messages until you reconnect. If you had it open, you go back to your own DorkOS. Other communities are not touched.
- Hand a new community to its owner with one link. When a host administrator creates a community, they now get an owner claim link to copy and send. The owner opens it, creates an account or signs in, and lands in their new community as its owner. The link works once and lasts 24 hours. The secret sits after `#` in the link, so the browser never sends it with a page request, and the page removes it from the address bar before loading anything else. (DOR-2181)
- The context switcher now has a **Manage** menu for the community you have open. **Invite people**, **Community settings** and **Leave community** open that community's own site, at the right page, where it checks your sign-in. The DorkOS app's own settings stay under **Workspace settings**, so the two never mix. **Disconnect** asks first, then removes only that community from this app. You stay a member (DOR-2185).
- **Add community** in the switcher now offers three separate paths. **Connect a community** links this DorkOS to a community you are already in. **Join with an invitation** opens an invite link you were sent on the community's own site. **Run your own community** opens the guide for setting up your own community server (DOR-2185).
- Not signed in? The form asks for your email, so we can tell you when your report is fixed. It remembers the address in this browser for next time (DOR-2232)
- On a phone, the You tab now has Send feedback, Your reports and Documentation as rows of their own, and the command palette has a Your reports entry (DOR-2232)
- Close the form by accident and your draft is still there when you open it again. Press ⌘↵ (Ctrl+↵ on Windows and Linux) to send, and the thank-you links to Your reports (DOR-2232)
- Sending the same report twice within a minute is caught, so it doesn't get filed twice (DOR-2232)
- Reload without losing your invitation. If the page reloads while you are joining a community, it still shows the community, who invited you, and any channel the invitation includes, and you can still create an account or sign in. The invitation link itself is still never saved by the page. (DOR-2181)
- See what rejoining brings back before you rejoin. If you were a member before, the invitation lists what returns (your name and handle) and what stays removed (your old role, earlier channels, agents, and connected DorkOS installations). (DOR-2181)
- If you run a Community server, you can now give a program its own key instead of your password. Create one under **API keys** on the host page, choose what it may do (read community records, create communities, or suspend and resume them), and copy it once. A key can never read messages, files, or members, and it cannot create other keys. You can replace a key without downtime, or revoke it at once. A headless server can create its first key from the command line with `node dist-server/host-keys.js` (DOR-2253).
- If you run a Community server, you can now set limits for each community on the host page: the most members and the most file space, each shown beside what it uses now. Lowering a limit never removes anyone or anything. It only stops new members or new files once the community is full. Exports never count, so an owner can always download their data. A program with a host key can also give one person more or fewer agents than the server's default, and read how much each community uses without seeing any names or messages (DOR-2254).
- Sign out of a community site from the browser you are using. Find it in Settings, under Account, or on the page where you choose a community. Only that browser is signed out. Your memberships stay, and your connected DorkOS installations keep working. (DOR-2181)
- Disconnect all your DorkOS installations from a community at once. In Settings, under Account, confirm your password and every installation you connected there stops reading and posting until you connect it again. You stay a member, and your installations in other communities are not affected. (DOR-2181)
- `dorkos update` checks every package you have installed in one go. That includes packages installed for a single agent. A package installed in two places now shows up as two lines, each saying where it lives, like `flow [Alpha]`. With `--apply`, it lists what it updated and anything it couldn't update, with the reason. Programs can ask the same question with `GET /api/marketplace/updates` and apply updates with `POST /api/marketplace/updates`, either for named packages or for exactly the installations a check listed. A package folder you linked in from your own copy is checked but never replaced; its line says to update the source instead (DOR-2194)

### Changed

- The Send feedback form is simpler. You write in one box, and your screenshot, the part of the app you pointed at, and the buttons to add them all sit inside that box. Diagnostics and the conversation are small switches under it, each with a preview (DOR-2232)
- The page with the reports you've sent is now called Your reports, in the help menu, its tab and its title (DOR-2232)
- The help menu has three items now: Send feedback, Your reports, and Documentation. Report a bug is part of Send feedback (pick Bug), and the public GitHub option is a link at the bottom of the form (DOR-2232)
- Pointing at part of the app no longer writes code names into your message. It shows up as a small picture named by the words on it, like "Set up a daily run", and the box asks what's wrong with it. You need to add a few words before you can send (DOR-2232)
- When joining fails, the page now says plainly that membership was not added, tells you if your new account was still created, and offers one next step: try again, open the link again, or ask for a new invitation. (DOR-2181)
- The community chooser works fully by keyboard and screen reader, explains why a suspended community can't be opened, and tells you when a community link you opened isn't available to your account. With no memberships yet, it tells you how to join. (DOR-2181)
- DorkOS no longer installs a package whose `.dork/manifest.json` and `.claude-plugin/plugin.json` state different versions, and says which file says what. Packages you already have stay installed and can still be updated or removed.
- `dorkos marketplace validate` now fails when a marketplace entry lists a version that the package's own `plugin.json` contradicts, since Claude Code would quietly ignore the entry's.
- When a community is full or out of file space, you now get a plain message that says so, and an invitation to a full community says it before you sign up (DOR-2254).
- The DorkOS app now names a community's agent limit when you add an agent. An older DorkOS app talking to an updated Community server shows "That no longer matches the community" instead; update the app to see the plain message (DOR-2254).
- Each connected installation now says what it can do (for example "Can read and post") and asks before it disconnects. The question says what ends and that you stay a member. (DOR-2181)
- Leaving a community now lists what ends (your membership, its channels, and the installations and agents you connected there) and what stays (your account, your other communities, this browser's sign-in, and your past messages). A wrong password now says so and that you are still a member. Other refusals, like needing to transfer ownership first, now give their real reason. (DOR-2181)
- DorkOS now tidies its store of downloaded marketplace packages on its own. After each download it keeps what your installed packages need, plus an update that is waiting to be installed, and removes the rest. Before, the store only grew, and checking for updates often would have filled your disk over time. (DOR-2249)
- If DorkOS can't read one of your projects, for example on a drive that isn't plugged in, it removes nothing from the store until it can, and `dorkos cache list` tells you why. (DOR-2249)
- `dorkos cache prune` now follows the same rule and no longer takes `--keep-last-n`. The old option could delete the exact copy an installed package came from. (DOR-2249)

### Fixed

- A closed community no longer accepts new invitations or members. Setting a community's admission to Closed already cancelled the invitations that were out, but an owner or admin could still make a new one and someone could join through it. Now no one new can be invited or join until the owner switches admission back to Invite only, and people who are already members keep their access. In the community's settings, the invite panel says the community is closed instead of offering a button that would not work (DOR-2178).
- When an agent asks for a service by a name DorkOS doesn't know, such as "composio-emails", the refusal now tells it how to search for the exact name, and lists close matches when there are real ones (DOR-2231)
- When no services are set up in DorkOS yet, an agent's request now says so and names the one step for you: open Connections in the DorkOS app and set up Accounts (DOR-2231)
- Agents are now told that signing in to a service's command-line tool in a shell does not give DorkOS access. Before, nothing said so, and an agent could spend a turn installing one (DOR-2231)
- A service an agent can find in DorkOS's service list is now a service it can ask for. Before, a request could be turned away while your linked DorkOS account was reconnecting, or when the list was too long to check in one go (DOR-2231)
- Asking for a Messaging-only service like Telegram now tells the agent that you set it up under Messaging, instead of sending it back to search again (DOR-2231)
- A screenshot attached to a bug report from the browser now shows the conversation you were reading. If you had scrolled through a conversation, the screenshot showed an empty list, or one message under a large blank space, even though the messages were on your screen. This happened both when you captured the whole app and when you pointed at one part of it. The desktop app was not affected. When a report includes diagnostics, it now also shows each error's actual message instead of `{}` (DOR-2230).
- Bug reports now scrub private details from the diagnostics they carry. Folder paths that include your user name, secret-looking keys and passwords, and the query part of web addresses are removed before a report is sent, including from the crash details attached to a report (DOR-2230).
- `dorkos community deploy` works with the current Fly CLI again. It created your Fly app and then stopped, saying it could not tell whether the app had been made, and left the app behind. It also refused to start at all if your Fly organization already had any apps in it. It now recognizes the app it just made by its name and the organization you picked, and it reads your existing apps without tripping over details the Fly CLI leaves blank. It still never takes over an app in a different organization. Setting up file storage would also have failed at the next step, because the launcher gave Fly the organization's short name where Fly needs its ID; it now looks up the ID first (DOR-2169).
- Disconnecting this DorkOS from a community now ends its access on the community too, not just the copy on your computer. Before, the community still listed this DorkOS as connected after you disconnected it. If the community can't be reached when you disconnect, DorkOS still disconnects here and tells you, so you can finish under Connected installations on the community yourself.
- When a community turns down a request, you now see why instead of "Community unavailable." For example, adding an agent past the community's limit says you've reached the limit on active agents. "Community unavailable" now means only that the community couldn't be reached or had a problem on its side. A private channel you haven't joined still looks exactly like one that doesn't exist.
- `dorkos update` and the Update button now notice new versions of marketplace packages. Before, they always said everything was up to date. (DOR-2244)
- When DorkOS can't check a package for an update, it says so and why (for example, "couldn't reach github.com"). It no longer calls that package up to date.
- `dorkos update` with no package name now checks every package where it is installed, including packages installed for one agent. A problem with one package no longer stops the rest, and naming a package that isn't installed still ends with an error.
- The installed list now shows the version Claude Code actually runs, even for a package whose own files disagree about its version.
- A message you started in a community channel and did not send is now still there when you switch to another community, or back to this DorkOS, and then return. Files you attached to it come back too. Before, switching away threw the message away. It stays in that one channel of that one community, is never shown anywhere else, and is thrown away if you sign out or that community's connection ends (DOR-2241).
- A marketplace package now installs the branch, tag or exact commit its listing names. Before, many installs quietly took the repository's newest code instead, and a package pinned to a commit or kept on another branch could fail to install. (DOR-2248)
- The commit DorkOS records for an installed package is now always the code that was actually installed, so the version shown and the update check can be trusted. (DOR-2248)
- A package kept in one folder of a larger repository now installs even when that repository's default branch has another name, like `master`. (DOR-2248)
- When a branch, tag or commit doesn't exist, the install stops with a plain message saying so, before anything is downloaded. (DOR-2248)
- If DorkOS stops in the middle of installing a package over an older version, you get the older version back. Before, a crash at the wrong moment could leave you with neither version, because DorkOS later deleted the saved copy of the old one instead of putting it back. (Updating a package is not covered yet; that fix is on its way.)
- A package that was half-installed when DorkOS stopped is cleaned up the next time DorkOS starts, instead of showing up broken. If you have since put something of your own in its place, DorkOS leaves it alone.
- When two copies of DorkOS work on the same project, one no longer undoes an install the other is still in the middle of. If you try to install a package while the other copy is installing it, DorkOS tells you how many minutes to wait.
- A leftover saved copy of a package no longer shows up as a second copy of it: not as a second Shape, not as a second agent in the health check, not as extra skills for your coding agents, and not as a second copy of a scheduled task.
- Small grey text on a community site is now dark enough to read against every background, and links inside text are underlined, so you can tell them apart without relying on colour. (DOR-2182)
- Every button and field on a community site is now at least 44 pixels tall on a phone, including the menu button that opens the channel list and the owner claim field in host administration. (DOR-2182)
- The on/off switch on each messaging connection in Connections now says which connection it turns on or off, so a screen reader no longer reads it as just "switch". (DOR-2182)
- The two buttons at the bottom of a confirmation, like "Keep connected" and "Disconnect", are now full-size touch targets on a phone. (DOR-2182)
- Warning and error text is easier to read. The red used for error messages and for buttons like Delete and Reset was too faint against the background in both light and dark mode. It is now a slightly deeper red in light mode and a slightly brighter one in dark mode, so every error message and red button label meets the standard contrast level for readable text. Red buttons in dark mode now use the same deeper shade the main Delete button already had.
- Updating a package with `--project` no longer moves a package that is installed for everything into that one project. Each package is now updated where it is installed (DOR-2194)
- A marketplace whose server stops answering no longer stalls an update check for minutes. After 15 seconds the check falls back to the last copy DorkOS saved, or says it couldn't reach the server (DOR-2194)
- A self-hosted community server now shuts down cleanly when it is told to stop twice, for example when you press Ctrl-C and your process manager sends its own stop signal too. Before, the second request crashed the shutdown, so the server exited with an error and printed a stack trace even though nothing was wrong. It also stops within about five seconds when people have channels open, instead of waiting for them to leave, and a second Ctrl-C while it is stopping ends it at once (DOR-2221).
- A file or data export that finished downloading no longer breaks the next request if your access to its channel ended at that moment. The download was already complete, but the community cut the connection afterwards, so whatever the app or browser sent next on it failed. You still can't download any more of a file once your access has ended (DOR-2250).
- The community list no longer waits for a slow community. Before, if one community took a long time to answer, the whole list waited for it, sometimes for ten seconds or more, every time it refreshed. Now each community gets under a second.
- A community that doesn't answer in time keeps the unread and mention counts it last reported, marked with when they were last checked. If it hasn't answered for a while, it shows as offline: you can still read what's saved, and it comes back on its own at the next refresh. A slow answer never makes DorkOS ask you to reconnect. (DOR-2223)

### Security

- Limit password guesses everywhere a community site asks for your password: leaving, disconnecting all installations, handing over ownership, exporting the whole community, archiving, restoring or deleting it, and creating or replacing a host API key. After 5 wrong passwords in a minute, that account's password-protected actions are refused for the rest of the minute, even with the right password. Other people are never locked out by someone else's guesses, even when everyone reaches the server through the same proxy. A wrong password now always says "That password is not right." and that nothing changed. A server owner can change the number with `COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE`. (DOR-2181)

## [0.81.0] - 2026-09-22

> DorkOS 0.81.0 brings Opus 5.5, Anthropic's newest model: pick "Opus" in the model menu to use it. Self-hosted communities also take a step forward. One server can now hold several communities, owners can manage theirs from the Community website, and a new command sets up a community server on Fly for you. Communities are still early.

### Added

- **Use Opus 5.5, Anthropic's newest model.** Choose "Opus" in the model menu to use it. On some accounts the row reads "Opus (1M context)". Read the upgrade note below: sessions already on Opus move to it on their next message (#1993)
- **Early:** Run more than one community on one self-hosted server. Each community keeps its own members, channels, files, agents, exports and live updates, and having an account on the server does not let anyone into a community they are not a member of. Links to an existing single community, and approvals for new DorkOS connections, keep working after you upgrade (#1975)
- **Early:** Connect DorkOS to one specific community on a shared server. On the Community website, you go straight to your community if you belong to one, or choose between them if you belong to several (#1978)
- **Early:** Manage a community from the Community website: its settings and icon, members, exports, ownership, and archiving or restoring it. Owners can schedule a community for deletion, watch its progress, and cancel any time in the seven days before it happens. Whoever runs the server can create communities and hand them to an owner without being able to read any private conversations (#1984, #1985)
- **Early:** Join a community from an invitation link that carries you through signing in, without the invitation's secret ever being saved in your browser. Once you have joined, you choose when to open the community, and you can see that each of your DorkOS installations connects to it separately (#1987)
- **Early:** Open an archived community to read its history and export your data. Posting and other changes stay off until an owner restores it (#1987)
- **Early:** Set up your own community server on Fly with `dorkos community deploy`. It uses a Neon database and a private Tigris bucket for files, shows the whole plan first (including which accounts may be charged), and creates nothing until you type the app name. If setup stops partway, it keeps what it made, never deletes anything that costs money on its own, and tells you how to pick up where it left off (#1965)
- **Early:** Check whether a community server can safely go back to an older, single-community release. The recovery guide has you keep a copy of your current backup first (#1975)

### Fixed

- A session's cost total now carries on after the session restarts in the background, instead of starting again from zero. For a conversation started before this update, that begins after its first new message (#1993)
- Each turn's token and cost figures in your own traces now cover that turn alone. Before, from the second turn on, they counted the whole session so far (#1993)
- A tool from another server that borrows DorkOS's name no longer skips the approval prompt. DorkOS now checks which server actually runs the tool, not just its name (#1993)
- When DorkOS can no longer confirm you still have access to a community, it stops that community's live activity on your machine instead of carrying on. You can still remove your own agents from a community while it is unreachable (#1984)

### Note for people upgrading

- **Sessions and agents already set to Opus move to Opus 5.5 on their next message.** So do ones set to Default, on an account whose default is Opus. Opus 5.5 is priced differently from the Opus it replaces, so what a turn costs can change. To stay on the older model, set its full model name on the agent (#1993)

## [0.76.0] - 2026-09-20

> DorkOS 0.76.0 lets an agent sign in to websites with a login you saved once, gives Codex and OpenCode agents the same DorkOS tools Claude Code agents have, and lets agents decide for themselves when a room message needs an answer. It also fixes a long list of small things in sessions, schedules and the desktop app. Two surfaces arrive early: self-hosted communities and the DorkOS account panel. Both are built and tested, but not yet proven by people outside the team, so expect rough edges there.

### Added

- Desktop: when you send feedback from the desktop app, the report now includes the app's own recent log lines (never the server's), so a problem like the window reloading itself can be seen from the report (DOR-2045)
- An agent that registers another agent can now give it a name to show, an emoji and a colour,
  instead of leaving it with a face DorkOS picked. If it sends something that is not one emoji,
  or a colour that is not a hex code like `#ec4899`, DorkOS turns the call down and says what it
  wanted rather than storing it (DOR-2054)
- Ask DorkBot to add an agent or a room to a sidebar section, and it changes only that section. If the thing was already filed somewhere else it moves, the way it does when you drag it yourself, and DorkBot tells you where it came from. You can name an agent the way you say it out loud and DorkBot works out which one you mean, or tells you it cannot find it instead of quietly filing a row that points at nothing. An agent can only file rooms it is in, so asking one to tidy your sidebar never turns into a way to find out which private conversations you have. It can make the section if you do not have one yet, and take things out again the same way. Until now the only way it could do any of this was to rewrite your whole sidebar at once, so a section you dragged at the same moment could be quietly undone (DOR-2055)
- Ask DorkBot to report a bug or ask for a feature, and it drafts the report and hands you a link to review and send. Nothing is sent for you: the link opens a GitHub issue page with your version, your OS, which agent runtimes you have set up and your on/off settings already written in, so you read it, change anything you would rather keep to yourself, and press submit. It opens the same page you get from **Help and feedback → Report on GitHub** in the app, or from `dorkos feedback` in a terminal (DOR-2056)
- Publish `@dork-labs/cloud-api`, the public wire contract for DorkOS Cloud: Zod schemas for the whole `/v1` surface, a thin `fetch` client, and a corpus of example payloads both sides of the wire can build against. It has no dependency on anything else in this repository, so anyone can read exactly what the app and the hosted service say to each other (DOR-2025)
- **Early:** Settings now shows what your DorkOS account includes, once you link one. Under **Access → DorkOS account** you get your plan, the people and addressed agents it covers, your included credits and what is left of them, cloud hours and storage, and how remote access works for you. Everything on the card is what the service says — the app itself knows no plans and no prices. Nothing in this section appears on an install with no DorkOS account: the whole section is one line until you link, and no request leaves your machine (DOR-2027)
- A credits gauge with a breakdown of where they went, agent by agent, plus what this machine spent on its own. The two are deliberately kept apart and labelled: the runtimes' own cost figures are their price list, not your bill, and a runtime that reports no cost at all is named rather than silently left out of the total (DOR-2027)
- Seat management: see the seats your organization holds, hand one back, and assign one. When an action needs a different plan, the explanation is the one the service sent, word for word (DOR-2027)
- An occasional note comparing what you have spent with what a subscription would have cost, when the service works one out. It is one line, it can be dismissed, and it never sits between you and topping up (DOR-2027)
- DorkOS credits can now run your turns instead of your own key, for Claude Code. It is off unless you turn it on, and the app says plainly which of your runtimes the choice does not reach yet (DOR-2027)
- **Early:** Start a self-hosted community server with its own accounts, channels, message history, and live updates. Docker setup needs no DorkOS Cloud account.
- **Early:** Invite people to a self-hosted community, manage membership, approve a local DorkOS installation, and give each agent its own identity. Members can revoke a connection or agent without sharing credentials in the browser.
- **Early:** Chat in a self-hosted community from your browser. Invite people, share files, reply in threads, manage members and agents, and download your own posts and files before leaving.
- **Early:** Connect the DorkOS app to self-hosted communities and bring local agents into shared channels. Read channels, reply in threads, and share files without a DorkOS Cloud account.
- **Early:** See which agent replies are waiting for delivery to a community, and retry or stop them from the app. Reconnecting keeps confirmed replies from appearing twice.
- **Early:** Recover a community member's password from the server without setting up an email service. Recovery signs the member out and revokes their connected installations and agent credentials.
- A **Test key** button wherever you paste an API key. It asks the service whether the key works and tells you straight away, without saving anything (DOR-2123)
- The published cloud contract (`@dork-labs/cloud-api`) now describes buying credit and asking for a refund, including the three refusals that go with them, so an app can say what actually happened instead of guessing (DOR-2090)
- A person in an organization can be shown by name rather than by role alone, and a seat's permission list can show what it resolves to when no rule is set (DOR-2090)
- A remote connection now carries the two timing windows it is told to honour — how long it may sit idle, and how long it has to finish work in flight before it closes (DOR-2090)
- A new seat activity event, for anyone building fair billing on top: one per agent seat per subscription period, with nothing from any message in it (DOR-2090)
- Two new reasons an inference request can be turned down: a daily limit that resets, and a single turn that has used up its budget. Both are separate from "you are out of credit", because what you do about them is different (DOR-2090)
- **An approval card that cannot offer "stop asking about this" now tells you how to get it.** Answering once and having DorkOS remember it needs Standing permissions switched on, which needs a login. Until now a card with either one missing simply showed no such button, so it looked like there was no way to stop being asked. The card now says: turn on Standing permissions in Settings, under Access. Cards where DorkOS cannot tell which agent asked stay quiet, because no setting would help there (DOR-2102)
- Sign in to a website once and your agents' browsers start already signed in. Run `dorkos browser login github.com`, sign in in the orange-framed agent browser (your password manager works there as usual), and press Enter. Agents get the saved sign-in, never your password (DOR-2155)
- Give an agent the signed-in browser from its profile: Tools & MCP, then Signed-in browser. The button works for Claude Code, Codex and OpenCode agents. Each browser runs hidden, starts from your save, and keeps what the agent does to itself. An agent with the browser can read every saved sign-in in it, so give it only to agents you trust with those accounts (DOR-2155)
- See which sites are saved with `dorkos browser status`, and take one away with `dorkos browser forget <site>`. The same saved sign-ins also work in the `claude`, `codex` and `opencode` command-line tools; the Signed-in Browser guide has the setup. Tested on macOS with Chrome; a full agent turn inside DorkOS, and Windows and Linux, are not tested yet (DOR-2155)
- When you asked an agent something and it chose not to reply, the room tells you: one line saying it read your message and did not answer, so you can ask again, ask somebody else, or let it go. When nobody asked and an agent simply had nothing to add, nothing is written at all — the working line fades out saying it finished with nothing to add, and there is no trace of it afterwards (DOR-2099)

### Changed

- DorkOS now checks your API key before saving it. A key that the service turns down, or an address nothing answers at, is reported right there in the form instead of saving cleanly and failing on your first message (DOR-2123)
- The "your own API key" form remembers what you entered: the power source, the base URL, and that a key is already saved, shown as the last four characters. Moving a saved key to a new address asks you to paste it again, so nothing else can point your key somewhere you did not choose (DOR-2123)
- Picking where your models come from is now a short list — OpenAI, Anthropic, or any OpenAI-compatible server with its own address — instead of a box you type a name into. A name nobody serves used to save without complaint and then fail later (DOR-2123)
- **Full autonomy now says what it does not cover, everywhere you can turn it on.** It switches off the agent's own permission prompts: editing files, running commands, working outside this project. It does not switch off DorkOS's own questions about risky actions, like deleting a schedule or removing an agent. Those still stop and wait for you on an approval card. That line already appeared in a chat, on a channel connection and on a scheduled task. It now appears in the places it was missing: the shared setting in Settings → Runtimes, any runtime card you have set differently there, and the Power dial in the Control Center. It shows up once per setting rather than once per card, so a page where every agent follows the shared setting says it once. If you have already ticked "don't show this again", those were the only places left that could have told you (DOR-2102)
- The line itself is clearer, and it ends by naming a place rather than giving you an order: "The setting for that is Standing permissions, in Settings under Access." It used to say "actions on DorkOS itself, like removing packages, still ask", which named the rarest example and pointed at a Settings tab that no longer exists. In the Control Center, where the Standing permissions switch is right there on the same panel, the line points at that switch instead of sending you to Settings (DOR-2102)
- **Full autonomy no longer promises more than it delivers.** The dial used to read "Acts on its own. It will not stop to ask you, even for risky steps." Deleting a schedule is about as risky as a step gets, and DorkOS has always stopped for that one. It now reads "Edits files and runs commands on its own. It will not stop to ask you.", with the exception spelled out underneath (DOR-2102)
- Your Codex and OpenCode agents now always have the DorkOS tools your Claude Code agents have — posting in rooms, reacting, reading back what was said, remembering things between sessions, and using the canvas and the Browser tab. It used to be an experiment you had to find and turn on, and most people never did, so a Codex agent sat in a room with no way to answer while the Claude Code agent beside it answered fine. Nothing about what those agents may DO has changed: the same permission checks run on every action, and an agent still has to be a registered agent of yours to get any of it (DOR-2099)
- Your agents now decide for themselves whether to answer in a room. What an agent writes while it thinks stays in its own session, so at the end of every turn it does one of three things: it says something, it puts an emoji on your message, or it decides nothing needs saying and stops. This is how it works everywhere now — in channels and in direct messages, on every agent you run (DOR-2099)
- An agent can answer you in a direct message the same way it answers in a channel. It used to be refused there, back when whatever it wrote was posted for it (DOR-2099)

### Removed

- The "DorkOS tools in every runtime" switch is gone from Settings → Experiments. There is nothing left to decide — every runtime gets the tools — so the switch would only have offered you a way to take them away again (DOR-2099)
- The "Agents decide when to speak" switch is gone from Settings → Experiments. It is how rooms work now, so the switch would only have offered you a way to go back to agents answering every single time (DOR-2099)

### Fixed

- A skill in a folder DorkOS cannot open is now reported instead of quietly vanishing. Before, a folder with the wrong permissions on it made a project with a skill in it look exactly like a project with none — and `dorkos harness adopt <name>` told you there was no skill by that name, which was not true about your own project. You now get a warning naming the folder, and asking to move the skill tells you what to fix (DOR-1949)
- Warnings about files DorkOS could not read are written in plain words again. They used to trail off into an error code and somebody's home directory — `ENOTDIR: not a directory, scandir '/Users/…'`. Now they say what is actually wrong: it is a file, not a folder; nobody may read it; the link points at nothing (DOR-1938)
- `dorkos harness sync` now tells you when it could not look inside a folder it tidies up. It used to say the project was fully in sync, because a folder it could not open and an empty folder looked the same to it. Nothing was ever deleted by mistake — it is a warning, not a fault — but you can now see the folder and fix it (DOR-1939)
- A sync no longer promises to remove a file it cannot remove. If an old, unused link sits in a folder DorkOS may not write in, `--check` used to list it for removal and `--fix` then stopped partway through with a permission error. Both now name the file and the folder, leave everything exactly where it is, and still count the project as needing attention — so you never read "everything already matches" over a leftover file DorkOS can see (DOR-1941)
- The report no longer claims a coding tool can see a packaged skill when the link it reads could not be made. Whether something is in the way of `.agents/skills` or the folder simply will not take a new file, the skill is listed as not reaching that tool, with the folder named — instead of being shown as working (DOR-1942)
- When DorkOS cannot read one of the folders your all-projects packages use, the message names the folder that is actually in the way. It used to blame the packages folder whichever of the two was the problem, and print an error code about the other one (DOR-1937)
- Tell you when a package you installed has a file DorkOS cannot read, instead of leaving it out
  of every report. `dorkos harness sync` now names the package and the file, and says that the
  skills it had already shared were left where they are (DOR-1933)
- Keep sharing a skill whose folder DorkOS cannot open — a folder whose permissions changed, or
  one that is halfway through being deleted. DorkOS used to treat it as a skill you had removed
  and take its links away without a word; now it leaves everything alone and tells you which
  folder to look at (DOR-1935)
- Stop a timer running for a skill that is no longer there. Uninstalling a package used to leave
  its scheduled skill on the clock forever; DorkOS now pauses it in the same pass, whether the
  package went or only the link to it, and whether or not other skills from the same package are
  still around (DOR-1934)
- The desktop app used to wait up to a minute before recovering a window that had failed, if a web page inside it was still loading. Now it only waits for the app's own page (DOR-2046)
- Tell you when one skill name is in two folders the same agent tool reads. If `review-pr` lives in both `.claude/skills` and `.opencode/skills`, OpenCode sees two skills under one name — DorkOS now says so beside both of them, along with what that tool's own documentation says happens: one of them loses, both load, or nobody wrote it down. Both copies still show as read by the tool, because both really do load (DOR-1940)
- Say what a marketplace package does in plain words on its page at dorkos.ai. A package that hooks DorkOS up to something outside now reads "Adds connections" instead of "Installs messaging adapters" — which was wrong twice over, since that kind of package can be a Telegram bot or an account DorkOS acts through, not only messaging (DOR-1936)
- Rename the marketplace's "Integrations" category to "Connections", and describe it as "Ways to hook DorkOS up to outside services." Links to the category page are unchanged (DOR-1936)
- Stop turning a friendly name into a broken one. An agent's short name is permanent and is what
  its `@handle` in a room is made from, so "DorkOS Cloud" used to be stored with the spaces still
  in it. DorkOS now shortens it to `dorkos-cloud` and keeps "DorkOS Cloud" as the name you see in
  the app (DOR-2054)
- Keep the name you typed when creating an agent from the app or the API. It was accepted and
  then thrown away, so the agent ended up showing its short name to everybody (DOR-2054)
- An agent asking DorkOS what it can do no longer gets an error when it leaves the page size out. Nine tools had an argument you were supposed to be able to skip — the page size on activity, room history, room search and marketplace search, and the member list when creating a room — and skipping it failed the call instead of filling in the usual value (DOR-2053)
- New agents show up in the sidebar right away, in every window. Registering, renaming or
  removing an agent used to leave the list showing the old set until you reloaded the page, so
  a project you registered from a terminal, from a second window, or by asking DorkBot simply
  was not there. The same goes for settings: rearrange your sidebar in one window and the other
  follows (DOR-2052)
- The Remove button on an agent now clears its row on the spot, instead of leaving it on screen
  for up to half a minute in the window you clicked it in (DOR-2052)
- A plugin your agent installs for you now works right away, the same as one you install from the app. Before, its files arrived but its commands and skills never showed up for the agent. Removing a plugin through an agent now cleans those up too (DOR-2057)
- Say what git will do with the files DorkOS writes when your project sits inside a bigger repository. A package in a monorepo — or any `dorkos harness sync` run from a folder below the one holding the `.git` — was treated as if it were not in git at all: on Windows nobody was warned that the skill links there get committed as copies of the files rather than as links, and the `.gitignore` check stayed silent. DorkOS now looks upward for the repository, reads the ignore rules from there down to your project the way git does, and names the file you would open to change one — `../../.gitignore` when that is the one deciding (DOR-1957)
- You can now approve a schedule that came with an installed package, and switch it on or off. Clicking Approve used to fail with an error saying DorkOS would not change the package's files. Your choice stays put when the package updates, and changing what the schedule does still means editing the package (FB-26)
- Open a session again after its agent asked you a multiple-choice question and left out a detail, such as whether you could pick more than one answer. Before, the whole session refused to load and showed "Session not found". Now the question counts as pick-one, and a question with nothing readable in it no longer stops the rest of the conversation from loading. The same kind of question also shows up right away while the agent waits for your answer, instead of never appearing. (DOR-2075)
- On the desktop app, a tab on a channel used to just say "Channels," no matter which one you had open. Now it reads "#general" (or a direct message's name), the way the channel itself does. It shows "Channels" until that name loads, so you never see the wrong one flash by, and it keeps up if someone renames the channel from another device or another agent renames it (DOR-2072)
- The bar above a session opened from one of your own rooms said "# #proj-trame" — the room's own name already starts with `#`, and the mark beside it drew a second one. The visible name now reads `#proj-trame` once, with the full form still available to screen readers (DOR-2073)
- The "Send feedback" dialog now scrolls on its own. On a shorter screen, opening "Attachments & details" and adding a screenshot used to push the Send button off the bottom with no way to reach it. The message and attachments now scroll while Send stays put (DOR-2076)
- Fix a list posted to a room sitting flush against the left edge instead of indented, unlike the same list in a session transcript. A room message now draws its markdown through the same typography as a session's, so a numbered or bulleted list, a table's spacing, a link's color, and inline code's color all match between the two places (DOR-2074)
- Stop telling you the agent did not respond when its reply was only slow to start. With a running agent kept between messages, a restarted agent sometimes finished some of its own background work first, and the app ended your turn right then with an error, while the real reply arrived seconds later with nowhere to show. When that happens, your turn now waits up to 30 seconds for the reply to your message. A turn that stops without saying anything still gets the error, after half a second or, if the agent is still visibly working, up to 30 seconds. Errors, a stopped reply and commands like `/compact` still end the turn right away, and pressing Stop while a turn is waiting ends it at once (DOR-2064)
- A session with one damaged message in its history now opens. Before, a single message the app couldn't read made the whole session fail with "Session not found". Now the rest of the conversation loads, and a quiet note sits where the unreadable part was. The note is calm on purpose: an old damaged message is not your agent failing, so it no longer looks like it. If your agent asks you a question, or asks for your OK, and the app can't show it, you get a note saying so, instead of an agent that seems stuck for no reason. (DOR-2078)
- A session started from a room now gets the short title Claude Code writes for it, instead of showing the message that started it. Renaming a session still wins over that title, and it updates on its own as soon as the new title is ready, with no need to reload the page. (DOR-2083)
- Installing a package no longer asks you to approve a schedule it shipped switched off. A schedule like that now shows up on the Schedules page already off, with its source named so you can tell it came from the package — switch it on yourself and DorkOS runs it through the same approval it always has. A schedule a package ships switched on still asks first, the way it always has
- Your agent's background helpers are no longer stopped while they are still working. The app used to close an agent down as soon as no message of yours was in flight — after five quiet minutes, when another chat needed to start its own agent, or half an hour after your last message. Anything the helpers had not finished was thrown away, and the agent was told you had refused.
- This now covers every kind of background work an agent starts: helpers, monitors, and task types the app does not recognise yet.
- An agent that is only talking to itself between your messages no longer counts as unused.
- Background commands are the one exception. They never hold an agent open, and they still stop when it does.
- Nothing waits forever. After four hours of background work the app takes the agent back anyway, and if a helper finishes without ever reporting in, the app stops holding the agent open for it after 30 seconds (DOR-2064, DOR-2065)
- An agent's task count in the mesh view no longer includes a schedule that is still waiting for your approval. Before, a newly proposed schedule made the agent look like it was already running work it had not started yet (DOR-2087)
- When your agent keeps working after a reply ends — finishing a background helper and reporting back, or picking its own work up again — what it says now appears in the chat as its own message, labelled as coming from the agent. Before, those words were thrown away and you saw nothing after the reply finished.
- A message you send while the agent is still finishing its own work now waits its turn instead of landing in the middle, so your words and the agent's never end up jumbled into one reply. It waits at most half a minute, even if the agent never gets back to it.
- Pressing Stop while the agent is talking on its own now actually stops it. Before, you were told nothing was running.
- Unregistering an agent no longer switches off the schedules it owns. It pauses them instead — the same way a package update already worked — so a schedule you had approved and switched on comes back switched on and running once the agent is registered again (DOR-2082)
- A scheduled task that could not use a single one of its tools is now marked **Blocked**, instead of getting a green tick. A task on a timer runs while you are elsewhere, so there is nobody to approve a tool it asks about — and DorkOS turns those requests down on the spot. When every one of them is turned down, the task runs, takes a few seconds, does nothing at all, and used to be filed as a success: one mailbox task read no mail twice in an afternoon and left two green rows behind it. Blocked is its own outcome in the run history, with the tools it was denied named on the row, its own entry in your activity feed, and its own notification — because a task that quietly does nothing every night is the one thing you cannot spot for yourself. It also dims the health light at the top of the window, the same as a failure does. Nothing broke, so there is nothing to debug; what it needs is permission. A task that lost one tool and got on with the rest of its work still counts as completed, and so does one that simply ended by asking you a question (DOR-2101)
- Approving a schedule an agent proposed can now also give it the setting you actually run at. A proposed job is always held back to the careful level, whatever it asked for, so nothing an agent writes can hand a 3am job more power than the agent has itself. But approving it never lifted that — so if your own setting was Full autonomy, you said yes and then the job failed the first time it needed to run a command, with nothing telling you why. The approval card now shows what each answer will run the job at, and offers a second button naming your own level ("Approve at Full autonomy") beside the plain Approve. Giving it a level that never stops to ask asks you to confirm first, the same as anywhere else. It applies to that one job: the next schedule an agent proposes arrives held back exactly the same way (DOR-2100)
- A new conversation now shows the power level it will actually run at before you send anything. If you set new sessions to start at Full autonomy, the permissions control and the sidebar row said "Default — asks before it edits a file or runs a command" until your first message, then switched. The setting was always being applied to the turn; only the screen was wrong, and it was wrong at the moment you look to check (DOR-2103)
- A power level you pick for one conversation before sending it anything now survives a page reload. It was stored correctly and used for the turn, but nothing could read it back, so the screen fell back to showing your default — which could claim more freedom than the conversation actually had (DOR-2103)
- While the app is still working out what a conversation runs at, the permissions control now says nothing instead of showing "Default" for a moment and then correcting itself — and it stops waiting once there is nothing left to wait for, so it never sits there loading forever when no conversation is open, a read has failed, or your wifi dropped — DorkOS runs on your own machine, and losing the internet is no reason to stop reading it (DOR-2103)
- Stop the "What will be sent" feedback preview's privacy line from overlapping the last diagnostics row (DOR-1962)

### Note for people upgrading

- No field was renamed or removed in the cloud contract, and nothing you already send stops being accepted (DOR-2090)
- **New values can turn up on existing lists.** This release adds five: three new refusal codes and two new reasons an inference request can be turned down. Code that was built against an older release will meet a value it does not recognise, so show it rather than treating the answer as broken — the contract says what a consumer owes an unknown value, and the package README explains how the bundled client behaves until it can carry one (DOR-2090)
- If you had turned the "DorkOS tools in every runtime" experiment on or off yourself, your choice no longer means anything and DorkOS quietly drops it from your settings file the next time it writes one. You do not have to do anything (DOR-2099)
- If you had turned the "Agents decide when to speak" experiment on or off yourself, your choice no longer means anything and DorkOS quietly drops it from your settings file the next time it writes one. The limit on how much one agent may say in a single turn — three messages, unless you changed it — stays exactly where it was (DOR-2099)

## [0.75.1] - 2026-09-14

> DorkOS 0.75.1 is a one-fix patch: the desktop app no longer reloads itself after you change pages or open a web page on a canvas.

### Fixed

- Desktop: the app no longer reloads its own window about ten seconds after you move to another page, or every ten seconds while a web page is open on a canvas. Each of those reloads threw away anything you had typed and not yet sent (#1860, DOR-2041)
- Give markdown documents cleaner spacing, aligned lists, and readable tables and code in both light and dark mode.
- Keep open documents in step with the app's colors when you switch themes.

## [0.75.0] - 2026-09-14

> DorkOS 0.75.0 gives every room a shared canvas and a real browser, so you and your agents are looking at the same document, diff, or web page. Your agents can now use a page, not just read it. And the Skills page finally shows which of your coding tools can see each skill — with one button to fix the ones that cannot.

### Added

- Send account events to an agent, room, Slack channel, or Telegram chat after choosing the exact account and event. Agents can also ask for the service access they need, while the owner keeps the final choice of account, actions, and notifications.

- `dorkos harness sync` now lists everything else in your `.claude/` folder, not just the parts it already knew how to copy. Rules in subfolders, subagents in subfolders, and whole folders you have linked in from elsewhere are all counted, and a subagent is listed under the name you invoke it by rather than its file path. Your rules, your subagents, your MCP servers, the hooks you keep to yourself in `.claude/settings.local.json`, and any hooks a skill declares in its own front matter each get a line saying they stay in Claude Code — and, for every other agent you run, where that agent would keep the same thing. Before this, a project with 13 rules, 7 subagents and an `.mcp.json` was told about none of them, which reads exactly like a project that has none (DOR-1845)

- Your subagents already work in Cursor, and your skills in `.claude/skills` already work in Cursor, OpenCode and Copilot — the report now says so instead of calling them dropped. All four read those folders themselves, so nothing is written for them. That includes the skills you marked Claude-Code-only: marking one says what you meant, not what OpenCode reads, and OpenCode reads that folder

- When a skill in `.claude/skills` has a name an agent would not accept — capitals, an underscore, or a name inside the file that does not match its folder — the report no longer says it works there. It says which rule the name breaks and that the agent's own docs do not say what happens next, so you can rename it or leave it knowingly (DOR-1845)

- `dorkos harness sync` now looks at which coding agents your project uses every time you run it. Start using Cursor next month and it tells you Cursor is not turned on yet, instead of quietly leaving it out (DOR-1851).

- `dorkos harness sync --fix --enable cursor` turns an agent on and sets it up in one command. It is the only thing that writes to your `.agents/harness.manifest.json`, and all it does is add the name to the list — your own formatting and key order stay exactly as you left them (DOR-1851).

- Some of what DorkOS writes belongs to your computer rather than your project: links into installed packages, and the hooks files it rebuilds on every sync. If your `.gitignore` does not cover them, `dorkos harness sync` now prints the exact lines to add, and `--fix --write-gitignore` adds them for you. It only ever appends, under a comment saying where the lines came from (DOR-1851).

- If you keep `.agents/` out of git, `dorkos harness sync` explains what that means: your skills stay on this computer, while the links DorkOS writes into `.claude/skills` still get committed — so anyone who clones your project gets links pointing at files they do not have (DOR-1851).

- A skill your agent writes while it works now shows up in your other coding tools within a few seconds, instead of waiting for you to run a command or restart DorkOS. Most tools read the skills folder directly and see it the moment the file lands; Claude Code reads a different folder, so DorkOS puts a link there for you (DOR-1850)

- DorkOS now tells you when a Claude Code session you already have open needs a restart to see new skills, and only when that is actually true — Claude Code watches the skills folder, but only if the folder was there when the session started (DOR-1850)

- `dorkos harness sync` now names the plugins you turned on in Claude Code, which your other agents cannot see. Each one comes with the repository it came from and the command that installs it here, named by your project's full path, so every agent on the project gets it. Nothing is installed for you, and the report says which settings file it read (DOR-1921)

- The same report says how many commands your personal Claude Code settings run on their own, and that only Claude Code runs them. If part of that file is written in a way DorkOS cannot read, it says which part rather than guessing at a number (DOR-1921)

- Tell you when the same package is installed twice, once for all your projects and once in this project. The line says what Claude Code and Codex each do with the pair, and how to remove either copy (DOR-1922)

- Your agent's Skills page can now fix what it finds. When some of your agent files are out of date, a line at the top says so and offers a **Sync now** button that writes them, and the page updates to what the sync actually did rather than to a guess. Syncing sometimes also removes files — a link to a skill you deleted, the copies a package left behind when you uninstalled it — and the page names every one of those files, with a plain sentence saying why each is going, **before** you click, then lists them again afterwards so they do not vanish into a toast that fades. One line in that list is not a deletion at all: your own `.claude/settings.local.json` keeps every setting you wrote and loses only the entries DorkOS added, and it says so. If a package wants to run commands automatically, syncing does not wait for you to decide — the files that do not run code are shared straight away, an approval card goes up for the ones that do, and the page tells you a package is waiting. Only you can press the button: an agent asking on your behalf is turned down (DOR-1895)

- Point a DorkOS agent at a project and DorkOS sets that folder up straight away, instead of waiting for you to run anything — whether you named the folder yourself or added one you already work in. It only adds files: it never deletes anything and never asks you to approve anything on that pass. A brand-new agent's own folder is still set up by the step that builds it, exactly as before (DOR-1901)

- A skill that runs on a timer inside a package you installed for all your projects now actually runs. `dorkos harness sync --global` puts those skills where DorkOS looks for timed work, so a daily job in a package you installed once shows up for you to approve like any other. It works from any folder and needs no project (DOR-1923)

- Before it removes a link, `--global` prints every path it is about to remove — each with one plain sentence saying why — and prints them again once they are gone. It only ever removes links it made itself: a folder you made, or a link you made yourself, is left exactly where it is. Run it twice and the second run does nothing (DOR-1923)

- The Skills page now lists the skills in your all-projects packages alongside your project's own, tagged "for all your projects", with the same sentence about who can see them — and the count above the list counts both (DOR-1923)

- Skills that only live in another agent tool's folder now show up. `.opencode/skills`, `.cursor/skills`, `.gemini/skills`, `.github/skills` and `.codex/skills` are read alongside your own, so a project whose skills live in one of them sees them on the Skills page and in `dorkos harness sync` instead of an empty list. Each one says which tools read it where it is, which do not, and says to move it somewhere every tool can read — it is a sentence, not a button, and nothing is moved for you (DOR-1902)

- An MCP server list in another tool's config file is named as something DorkOS does not carry. If your servers are declared in `opencode.json`, `.codex/config.toml` or `.cursor/mcp.json`, you now get one line saying how many are in there and that DorkOS only passes on the ones in `.mcp.json`. It counts them and reads nothing else, so nothing from those files — no server name, no key — is ever printed or stored. Every ordinary way of writing that list is counted the same, including the shorthand forms, and a file your editor saved with a byte-order mark is read rather than called broken (DOR-1902)

- A package you installed for all your projects can now be shared with your other agent tools. Run `dorkos harness sync --global` and DorkOS asks once: it shows the two folders in your home directory it would use, names every link it would add, and writes nothing until you answer. Say yes with `dorkos harness global --enable <tool>`, once per tool you want (DOR-1924)

- `dorkos harness global --list` shows what you chose and where the links go. `--disable <tool>` stops sharing with one tool and removes the links that tool's folder no longer needs first. Five tools share one folder, so turning one off while another still reads it removes nothing (DOR-1924)

- DorkOS only ever creates links in those two folders, never files, and it only ever removes a link it made itself. Your own skills, and shortcuts you made yourself with the same shape, are left exactly where they are. If you uninstall a package later, DorkOS removes its links too (DOR-1924)

- The line about a package you installed for all your projects now says it is shared once you have shared it, and tells you which command shares it until then (DOR-1924)

- A skill your agent wrote inside one tool's folder can now be moved to where every agent reads it, with one command: `dorkos harness adopt <name>`. It moves the folder to `.agents/skills` in one step — either the whole skill arrives or nothing happens — and, if your project uses Claude Code, leaves a link at `.claude/skills` so Claude Code still finds it. Add `--check` to see what it would do without writing anything, or `--claude-only` to say the skill belongs to Claude Code and should stay put (DOR-1944)

- DorkOS tells you when it will not move a skill, and why. A skill whose settings only Claude Code understands, one whose text points at a Claude Code path, a name already taken in `.agents/skills`, a folder that is really a link somewhere else — each gets one plain sentence naming the thing in the way and what to do about it, and nothing on disk is touched (DOR-1944)

- Every `dorkos harness sync` now names the skills that live where only some of your agents look, one line per folder, with the command that moves each. It says which of your tools cannot see them — worked out from what each tool documents about itself, not from a list DorkOS wrote down — and stays quiet when every tool you use can already read them (DOR-1944)

- The Skills page can now move a skill for you. A skill sitting in one tool's own folder — where the rest of your agents cannot see it — gets a **Share with every agent** button. Pressing it asks first, naming the folder it moves from, the folder it moves to, and the link it leaves behind so Claude Code still finds it. Say yes and the row redraws on the spot: the tools that could not see the skill now say they read it. The command that does the same thing from a terminal is still printed right beside the button (DOR-1946)

- If DorkOS will not move a skill — its settings are Claude Code's own, something already sits in the way, the folder is really a link somewhere else — the row says so in one plain sentence, in the place the advice was, and nothing on disk is touched. Screen readers are told the sentence as it arrives (DOR-1946)

- DorkOS can now move a plainly-portable skill into the shared folder every agent reads, on its own — but only inside the agent folders and room folders DorkOS made, only when you turn it on with `dorkos config set harness.autoAdopt true`, and only for a skill whose settings hold nothing one tool alone understands. Everything else is reported, with the one sentence saying why, and left exactly where it is (DOR-1945)

- Every server start writes a line into the DorkOS log for each agent folder holding a skill only some of your coding tools can see. It names the skills, says which tools cannot see them, and gives you the command that moves each one — with your agent folder's full path in it, so it means the same thing wherever you paste it. You get that line whether or not you turned the setting on, because knowing is the point (DOR-1945)

- `dorkos harness adopt` now knows when you are standing in a room's own folder, and refuses to move a skill whose name matches one DorkOS puts in every room folder — that folder gets cleaned up, and the skill would go with it. It tells you to rename yours and adopt it under the new name. The same skill in one of your own projects still moves (DOR-1945)

- If you turn the setting on and then run `dorkos harness sync` in one of your own projects, it tells you in one line that the setting does nothing there and that `dorkos harness adopt <name>` is how you move a skill yourself. Nothing in your own repositories is ever moved for you (DOR-1945)

- Attach a screenshot when you send feedback — paste one, drag it onto the dialog, or pick a photo on your phone. The picture is shrunk before it goes so your report stays small, and if it is still too big to send you are told, rather than the picture quietly going missing. You see exactly what you are attaching, and one click removes it (DOR-1955)

- Browse Composio’s full service catalog in Connections and use its built-in sign-in where supported. Existing custom setups keep priority. Services that need an API key or account details open a secure hosted form; unsupported methods explain what is missing. Connecting an account still grants no agent access until you choose it (DOR-1958).

- Capture the app in one click when you send feedback. The feedback dialog gets out of the way, takes the picture, and attaches it — so a bug report shows what you were looking at without you having to take a screenshot yourself. It captures only the app, never the rest of your screen. In the desktop app the picture comes from the window itself, so it is exactly what you see (DOR-1956)

- Point at the part that looks wrong. In the feedback dialog, "Point at element" gets the dialog out of the way and hands you a crosshair: the app dims, whatever you hover lights up, and one click sends a report cropped to just that piece — with the name we use for it in the code, so we know exactly which one you meant. Press Esc, right-click, or Cancel to back out; anything you had already typed is still there. It needs a mouse and a bit of room, so you will see it in a full-size window on a computer, not on a phone or a narrow one (DOR-911)

- You can now change what kind of work you do any time, in Settings › Profile. When DorkBot asks the question, it tells you where the answer is kept and links you straight there.

- If you run Claude Code with more than one account, you can now see which one a chat is using without leaving it. Hover the runtime chip above the message box, or open the session details panel on the right.

- See the widgets your agents post in a channel or a direct message. A widget an agent writes into a room message now renders as the real card, table, or chart it describes, instead of a block of raw code. Buttons that open a link, or change something small and visible in DorkOS like a panel or the theme, work the same as they do in a session. Buttons that would send a note back to the agent — or open a page, file, or terminal in your workbench — are shown but switched off, with a note when you hover them: a room message has no session behind it to answer into, and it can come from an agent you don't run or be relayed in from a Telegram or Slack room by someone you've never met. If a widget is broken, you get a short "this widget couldn't be rendered" card with the reason and the raw text, the same as in chat, and the rest of the message reads normally (DOR-1997)

- A **Browser** tab in the workbench, next to Canvas. Web pages open there — a local file you are
  building, a dev server you are running, or a site your agent wants you to see — while files,
  documents and diffs stay in Canvas.

- Each of the two tabs keeps its own set of open documents and remembers the one you were reading.
  Switch to Browser and back, and the file you had open is still the one on screen.

- Agents in a room can now put documents and pages on a shared canvas — a file, a change to a file,
  a web page, a note — and everybody in the room sees the same one. It survives a reload, because
  the room owns it rather than one browser tab.

- Agents can read the canvas too, so one can look at what another put up without you relaying it.
  Every agent in the room is told what is on the canvas at the start of its next turn.

- Putting something on the canvas interrupts nobody. The room's log gets one quiet line per turn
  saying what changed, and that is all — if an agent wants you to look now, it says so in a message.

- A new setting, **rooms.maxCanvasOpsPerTurn** (3 by default), caps how much of the canvas one agent
  may rearrange in a single turn.

- Rooms now have a Canvas and a Browser tab, and what is on them belongs to the room rather than
  to your browser. When an agent puts a document there, everyone in the room sees it — at the same
  moment, without reloading — and it is still there tomorrow. Each tab says who put it there
  (DOR-2000)

- You can put things on the table too: type an address in the Browser tab, pick a starting point in
  an empty one, or press "Put on the canvas" on a file in the Room tab's Files section. Pin the ones
  that matter so they stay at the front, and close the ones that do not — for everybody

- Markdown the room owns can be edited right there, and your save reaches everyone. While you are
  typing, an agent's change to that same document is held rather than dropped on top of you; every
  other document stays live

- A document that arrives while you are looking somewhere else lights a small dot on the tab it
  landed on. Nothing ever moves the tab you are on, and a brief drop in your connection never takes
  away what you were typing

- When the room turns something down — it has been archived, or the document is already gone — it
  says so where you pressed, and nothing you wrote is thrown away on the way: a save the room would
  not take leaves your words in the editor, and an address it would not take stays in the box

- Pin a document on a room's canvas to keep it at the front. Hover its tab and press the pin.
  A room holds twelve documents and drops the one nobody has touched for longest, but a pinned
  one is never dropped — and a pin sticks, so reloading the page or opening the room on your
  phone finds it still first. Anyone in the room can pin and unpin.

- See who is looking at what. A small face sits on the tab somebody is reading. An agent's face
  shows up while its turn is really reading that document and goes when the turn ends, so it tells
  you what the agent is working from — it is never something an agent decides to show you. None of
  it is saved: close the window and your face goes with it.

- A room that has files of its own now starts with `ROOM.md` pinned to its canvas. Those are the
  notes everyone in the room shares, so they get a tab that nothing can push off.

- #team starts with a board on its canvas — a short checklist of what to do next, which any
  agent in the room can rewrite as things change. It is an ordinary pinned document, so you can
  make one in any room; close it and it stays closed.

- Your agent can now use the page in the Browser tab, not just look at it. Ask it to try the signup form and it will: it reads the page to see what is on it, clicks buttons, fills in fields, presses keys, scrolls, and waits for the page to catch up — then tells you what happened, in the tab you are watching. It never pastes the page's HTML at you, and when several things match what it was looking for it says so and asks which one instead of guessing (DOR-2007).

- Every one of those answers names the page it acted on and where that page is now, so an agent with three previews open can tell you which one it used.

- Your agent can record what it does in the Browser tab. Ask it to show you rather than tell you, and it films the steps: one frame per action, saved as a small animated picture in its own working directory. You get back where the file is, how many frames it kept, and how long it covers — and the agent gets the last frame as a picture, so it can reason about where the page ended up. Open the file and watch the form fail for yourself (DOR-2008).

- An agent can put a file it made into a room. A screenshot or a recording goes on the message like a file you sent yourself: everyone in the room can open it, and every other agent there finds its own copy of it on its next turn. It beats a paragraph describing what a page looked like.

- Follow somebody's browser in a room. Pick a person on the Browser tab and your panel goes where theirs goes — the same page, the same place on it — until you turn it off. It's people only, it's off until you ask for it, nothing about it is recorded, and it stops on its own when you look away or the person you're following goes quiet. A room where nobody is following anybody sends nothing extra at all. (DOR-2010)

- Talk about one document on a room's canvas. Press **Discuss** on any tab and a thread opens on it, with a short line in the room saying you started one. Press it again next week and you land in the same conversation, and so does everybody else — there is one discussion per document. Asking an agent something in it tells the agent about that document and no other. (DOR-2010)

- Review an agent's work from the room's canvas and merge it there. When an agent puts a review of
  one of the room's files up, and its copy is ahead of the room, you see that file the way the agent
  has it beside the way the room has it. Turn down the parts you don't want — they go back in the
  agent's copy — then press **Merge into the room**. The room gets one line saying what landed, and
  nobody is interrupted.

- Merging stays yours, and so is the review itself: reading and changing somebody else's working
  copy is something a person does, and an agent asking is turned down. Only you see the merge
  button, so no agent can sign off its own work. If the room
  has moved on since the agent last caught up, the button is replaced by the reason and a note to ask
  that agent to catch up.

- An agent can put something on a room's canvas from a one-on-one chat with you. Ask for a chart and
  say which room it belongs in, and it lands on that room's table for everyone. It has to be a member
  of the room, it can do it three times per room per turn, and one line saying what it put there posts
  when the turn ends.

- Your Codex and OpenCode agents can now use the canvas and the browser the same way your Claude Code agents always have. They can put a document up, open a file or a diff beside your chat, point the Browser tab at a page, read its console and its network log, take a screenshot, use the page — click, type, scroll, wait for something — and record what they did. Turn on **DorkOS tools in every runtime** in Settings under Experiments, and their next turn has all of it. Until now a Codex agent in a room could not see a console error while the Claude Code agent beside it could (DOR-2009).

- Before starting a long job in a room, an agent now puts 👀 on your message, then swaps it for ✅ when the job is done. So you can tell "seen and working" from "did not notice". Quick replies skip the signal, so rooms stay quiet.

### Changed

- Pending raw MCP connection checks now survive a DorkOS restart.

- Some packages ship hooks: commands your coding agent runs on its own. `dorkos harness sync --fix` used to install every one of them, even from a package you had turned down. Now it holds those back, sets up everything else, and prints each command it did not install, so you can see what it skipped and why (DOR-1849).

- Say `dorkos harness sync --fix --allow-hooks <package>` to install that package's hooks. DorkOS remembers your answer, so you only say it once. `dorkos harness hooks --list` shows every package you have decided about, and `dorkos harness hooks --revoke <package>` forgets one so you get asked again (DOR-1849).

- When you turn a package down, DorkOS now remembers that too. It used to forget on the next restart (DOR-1849).

- If DorkOS cannot read your settings file, it says what is wrong with it and holds every package's hooks back, instead of telling you that nothing has been decided. It will not write over a file it cannot read (DOR-1849).

- Connections now stay available while Claude Code, Codex, or OpenCode keeps the same long-running turn active. Ending the turn closes access. If supervision stops unexpectedly, that access still expires within four hours.

- Your project's `.agents/harness.manifest.json` can say what to do with your hooks for each agent, and DorkOS now does what it says. `none` means that agent's hooks file is not written, and the report says so instead of quietly writing it anyway; `generate` is what DorkOS has always done; say nothing about an agent and nothing changes for it. If DorkOS had already written that file, `dorkos harness sync --fix` clears it away — and never touches one you wrote yourself. For Claude Code, which reads your hooks straight out of `.claude/settings.json` whatever your manifest says, `none` means one thing: hooks that came with an installed package stop being added for it.

- Allowing a package's hooks no longer records an answer that quietly comes true later. `dorkos harness sync --fix --allow-hooks <package>` stops and explains itself when nothing in your project can take those hooks — whether that is because you told DorkOS not to write them, or because none of the agents you use has anywhere to put them. Saying yes was being saved either way, and would have installed them the day you changed that, without asking. When only some of your agents are covered it saves your answer and tells you which ones miss out.

- Four keys in that same file are no longer read by anything: `skillWrappers`, `commandMappings`, `instructionProjections` and `skillBundles`. Your file still works if it has them, and `dorkos harness sync` names each one so you can delete it. A manifest DorkOS writes for you from now on has only the three keys that do something.

- Your agent's Skills page now shows every skill it has and which of your coding tools can see each one, with a reason when one can't. It used to list only the skill packs you had installed from the marketplace, which is how an agent with thirty-one skills came to be told it had none. Each skill is one line with a small tag per tool — reads it, has a copy, out of date, can't see it, or needs you to decide something — and where a tool can't see one, the page gives you the same sentence `dorkos harness sync` prints in your terminal, word for word, so the two can never tell you different things about the same file. Under the list there is a panel per tool holding every agent file that tool cannot see — skills, rules, commands and more, so that count is usually bigger than the number of skills — and a line when DorkOS finds files for a tool in your folder that it is not sharing to, with the one command that turns it on. Reading this page never writes anything (DOR-1894)

- Harness Sync now says what a package you installed for all your projects actually holds — its skills by name — and that only the Claude Code sessions DorkOS runs can see it. The old line told you to "run a global sync", a command that has never existed (DOR-1922)

- Say so when one of those packages has a hooks file DorkOS cannot read, instead of reading it and saying nothing (DOR-1922)

- `dorkos harness sync` now says why each file it removes is going, on the line for that file, in both `--check` and `--fix`. It used to print the paths under one heading — "what they came from is gone" — which was true of most of them and not all: a skill link, an uninstalled package's command, a hooks file nothing writes to any more and a settings file that survives are four different things, and now each says which it is. The app shows the same sentences, word for word (DOR-1895, DOR-1906)

- The line about a package installed for all your projects now ends with "Its skills that run on a timer now work" once those skills are actually linked, and tells you which command links them until then. Packages with no timed skill say nothing new (DOR-1923)

- If DorkOS cannot read the folder your all-projects packages live in, `--global` stops and removes nothing instead of treating the folder as empty. A package that is still installed also keeps its links when DorkOS cannot make sense of its settings file (DOR-1923)

- The advice on a skill that only some of your agents can see now names the folder it is really in, instead of always saying `.claude/skills` (DOR-1902)

- If you told DorkOS to stay inside one folder on this machine, it does not put links in your home directory. It says so, names the folder you set, and your timed skills keep running (DOR-1924)

- Saying no is remembered. DorkOS asks the question once, and a no means it does not ask again (DOR-1924)

- If one of those folders is a file, or DorkOS may not write in it, the run says which folder and what to do about it. It used to stop with an error nobody can read, after it had already recorded your answer (DOR-1924)

- The Skills page prints the command that moves a skill, right under the line saying where it lives. It carries your project's full path, so it means the same thing wherever you paste it (DOR-1944)

- Bug reports now say which page you were on more precisely — not just `/session` but which conversation. The address is filtered first: the folder you are working in and anything you typed to an agent are stripped out before it is sent, and you can read the exact address in the preview before you send (DOR-1960)

- Bug reports can also carry your window size, browser, and light/dark setting, so a layout problem can be reproduced without us asking what you were looking at. These ride under the same Diagnostics switch as before — turn it off and none of them are sent — and the preview lists every one (DOR-1960)

- Codex agents now run on Codex 0.154.0, which carries upstream fixes for connected tool servers and for picking up skill and plugin changes in a session that is already open. Context readings refresh themselves within a few minutes of the update. If you never picked a model for an agent, Codex now chooses your account's default, which may not be the model it picked before.

- An OpenCode subagent whose last tool call failed now shows as failed. It used to hand back whatever the subagent had written up to that point and read as finished.

- The context meter counts every part of the conversation the runtime reports, so the number matches what the model actually sees

- A session's cost now tells you how sure it is. If DorkOS has no published
  price for the model that ran, the figure says it is an estimate instead of
  standing there like a fact. A cost charged at your company's own rates says
  that too. You will see it in the cost tooltip and in the `/context` panel.

- If you export traces of your agent runs, each turn now also reports how many
  of its output tokens the model spent thinking.

- DorkOS now knows exactly which of your messages a reply answered, so nothing is left hanging
  when you send several at once. Claude Code reports the whole list instead of just the last
  one, and DorkOS reads it — a reply that covers two messages closes both, and a message it
  already answered can no longer be mistaken for one it still owes you.

- A message you send mid-reply is less likely to get a silent answer. When Claude Code says it
  still has one of your messages waiting, DorkOS now waits longer for that answer before it ends
  the turn. It never cuts the wait short, so an answer that was already on its way still reaches
  you.

- If Claude takes a long time thinking about something you sent mid-reply, that answer now
  reaches you. DorkOS used to give up waiting after five seconds and the whole answer went
  nowhere.

- When Claude ends a turn nobody asked for — it re-ran one that was cut short, or it ran a slash
  command on its own — the log now says which, instead of reporting it as a surprise.

- When an agent opens a page for you, DorkOS brings up the Browser tab instead of the Canvas tab, so
  a page it sends never takes over the file you were reading.

- A page that is open but cannot be driven now says so in one sentence, straight away — including a preview you navigated away from, to a page DorkOS is not serving. A page loaded straight from the internet is shown, not driven — and until now asking an agent to look at one meant an eight-second pause followed by a note about opening a preview that was already open.

- With the same conversation open in two windows, only one of them acts: the one that most recently brought a preview to the front. The other sees nothing, and a window you close hands the page back right away, and a window that stops responding hands it back after about a minute and a half. Screenshots follow the same rule, which settles a long-standing surprise where whichever window answered first won.

- Background chores your agent runs for itself no longer crowd the task bar. They show in the expanded panel, and any that fail still show up like other failures.

- In auto mode, Claude Code is told which DorkOS safety tier a tool call already passed, so it asks you less often about things that were already decided. It can still ask whenever it wants to. Set `DORKOS_CLASSIFIER_CONTEXT=0` to turn it off.

- A task running on its timer no longer waits ten minutes for an approval nobody can give. It moves on without that tool right away, and the run tells you what it skipped. Only runs the clock starts skip the asking — press **Run now** and you are watching, so that run keeps its approval cards and you can answer them.

- A finished run leads with the tools it could not use, and each one gets its own line in your activity feed. Nothing pings your phone about it.

- Installing a plugin while agents are busy no longer makes them re-read their whole conversation right away. An expensive reload waits, and DorkOS keeps checking back until the agent says switching the plugin on is free — or gives up waiting after fifteen minutes and switches it on anyway.

- A reload you ask for by hand still happens straight away, whatever it costs. Reloads that cost something now show up in your Activity feed, with how big the conversation was and whether the wait paid off.

- Your canvas now lives on your DorkOS machine instead of in one browser. Open a file on your
  laptop and it's already open when you pick the session up on your phone; close it there and it
  closes on the laptop. Clearing your browser data no longer costs you your tabs, and two windows
  on the same session show the same set instead of drifting apart. Anything you had open is
  carried over the first time you open that session (DOR-2006).

- Your agent can now name which canvas tab it means. Asking it to change or close
  "the chart" used to act on whichever tab was at the front, so it could only ever
  work on the one you were looking at; it can now pass the id of any document on
  the canvas. Leave the id out and it still acts on the front tab, exactly as
  before (DOR-2006).

- Your agent can see what's on your canvas, and read it. Ask "what have we got open?" and it gets
  the real list — every tab, what it is, what it's called, which one is at the front, and how many
  windows are watching — instead of guessing from whatever your window last mentioned. It can read
  one of those documents back too, like the chart it drew for you last turn, and a document backed
  by a file is read off disk so you get what the file holds now (DOR-2006).

- Codex sessions now say what the permission setting lets Codex do, in plain words. The default setting lets Codex read files but not change them, and Codex has no way to ask you to approve one, so asking for a change used to get a confusing "I can't do that" with nothing on screen to answer. A Codex session that starts in that setting now says so once, above the chat box, with a link to the picker. The three Codex settings read the same way wherever they appear (DOR-2019)

### Fixed

- Keep security audit records when you delete an account or an admin changes one (DOR-1874)

- `dorkos harness sync --check` no longer crashes on a broken link. If a file DorkOS writes for an agent — `.codex/hooks.json`, or the `.claude/CLAUDE.md` pointer — had been replaced by a link to something that is no longer there, the check stopped with a stack trace instead of telling you what was wrong. A broken link is now just one more thing to fix: the check names it, and `--fix` puts the real file back. Anything else that goes wrong is reported as one line, and you can ask for the details with `LOG_LEVEL=debug` (DOR-1843)

- A skill you removed or renamed no longer leaves a dead link behind. Deleting `.agents/skills/my-skill` used to leave `.claude/skills/my-skill` pointing at nothing, which Claude Code cannot follow — and the check called it clean. The next sync now names those links and clears them away. Links you made yourself, real folders you put there, and links that still work are all left alone (DOR-1843)

- DorkOS will not write over a folder, or through a link, where one of its own files belongs. A folder sitting where `.codex/hooks.json` goes used to be reported as something a sync would repair, and the sync then stopped with an error; a link pointing outside your project could have the file at the far end quietly rewritten. Both are now reported as blocked, with a line saying exactly what to move (DOR-1843)

- If you use Cursor, Gemini CLI or GitHub Copilot, `dorkos harness sync` no longer tells you your skills were left behind. All three read the shared `.agents/skills` folder, so they had your skills the whole time — the report was wrong, not your setup (DOR-1847)

- A package you install now puts its skills in that shared folder no matter which agents you have turned on. Before, only turning Codex on put them there, so a project running just OpenCode or just Cursor got none of them (DOR-1847)

- More of your Claude Code hooks travel to the other agents. Codex now gets the "session ended" hook, and Copilot gets five more — including compaction, permission requests and notifications — instead of being told they do not exist (DOR-1847)

- `dorkos harness sync` no longer claims an agent is reading a file you do not have. With no `AGENTS.md`, no hooks and no commands folder, it says so plainly rather than listing them as working (DOR-1847)

- Skills you deliberately keep for Claude Code only now show up in the report as kept, with a line per agent that does not get them. They used to be missing from it entirely (DOR-1847)

- When a command cannot travel to an agent, the reason now names that agent's own command folder — `.cursor/commands`, `.gemini/commands`, `.github/prompts` — instead of saying it has none (DOR-1847)

- A project with no slash commands and no hooks is no longer told, five times over, that its commands were left behind. If you never wrote one, `dorkos harness sync` says nothing about them (DOR-1847)

- A skill you keep only for Claude Code is now looked for where your settings file says it is, instead of only in the usual folder — so a skill that is really there is no longer reported as a leftover entry (DOR-1847)

- If you list a skill as Claude-Code-only when it is really in the shared folder, you are told the first time you check, on a fresh copy of the project — not only after a sync has already run (DOR-1847)

- Room work folders stay clean when the room's project has a package installed. The links DorkOS makes for it no longer show up as your unsaved changes, which used to stop the folder being tidied up or merged (DOR-1880)

- A `SKILL.md` whose front matter will not parse is now reported the same way every time, by every part of DorkOS that reads one. It used to be called broken the first time it was opened in a session and something else entirely after that, so which answer you got depended on which reader looked first — the marketplace preview, a scheduled task, the skills list, or the harness report (DOR-1845)

- `dorkos harness sync` now explains a checkout that cannot make symlinks. On Windows, and in any clone where symlinks are turned off, git writes each skill link out as a plain file — and the report used to call that "drift" and tell you to run `--fix`, which then refused it without saying why. It now says in one line that symlinks are off in this checkout, and gives you both ways out (DOR-1855).

- Every blocked skill link now says what is in the way, not just that something is. When the name on disk differs only in case — a `Foo` where the plan wants `foo`, on a Mac or Windows filesystem that does not tell the two apart — the message names the difference, instead of leaving you looking at a folder you believe is called something else (DOR-1855).

- On Windows, the file paths DorkOS writes into a plugin's hooks and command wrappers are now spelled one consistent way instead of half one way and half the other, which is easier to read and safer for the shell that runs them. Because that changes the exact command text, DorkOS will ask you once more about plugin hooks you have already approved on Windows; approve them again and it settles (DOR-1855).

- `dorkos harness sync` no longer hangs if a named pipe is sitting where a skill link belongs. It now says a file is in the way, like it does for anything else it did not put there (DOR-1855).

- Projects can now be added when their own folder is the scan root. If adding a project fails, it stays in the list with a clear retry action (DOR-1897).

- The files DorkOS writes for your coding agents now land in one step. If an agent reads one while a sync is running, it sees the whole old version or the whole new one — never an empty or half-written file (DOR-1854)

- Two syncs into the same project no longer trip over each other. Installing two packages at once could leave one of them waiting on a half-finished picture of your project, or fail outright with an error there was nothing you could do about (DOR-1854)

- The X that closes a dialog is back in its top-right corner. In Settings and the other dialogs with a sidebar it had slipped to the bottom-left, below the tab list, and in the plainer dialogs it sat too low and pushed the heading down with it.

- Show your API keys after you create them, so you can recognize and revoke each key.

- Scheduled tasks now start in the right folder when you run DorkOS from source. They were starting one folder too deep, so a task with no workspace of its own could not see the project it was meant to work on.

- Set up Gmail notifications when the service supplies suggested values and examples. Review or edit the suggestions before approving; examples are never selected for you. Keep blank filters unchanged when saving (DOR-1899).

- `dorkos harness sync --check` now lists every file a `--fix` would remove, not just the broken skill links. Uninstall a package and the check names the links, slash commands, hooks files and settings entries it left behind — before you run the command that deletes them (DOR-1889)

- A project is no longer called clean when a sync would delete files in it. Removing a package used to leave the check saying "no drift" while the next sync quietly took nine files out of the project (DOR-1889)

- `dorkos harness sync` no longer stops with a system error when something unexpected sits where a commands folder should be — a stray file at `.opencode/commands`, or a folder your account cannot read. It tells you about the rest of the project instead (DOR-1889)

- `dorkos harness sync` now lists files it could not read — a `.mcp.json` with a typo in it, a rule file whose header will not parse, a stale entry in your manifest — under a heading that says **this project**, instead of blaming whichever agent tool happened to be named first. A project that only runs Codex used to be told Claude Code had a problem, narrowing the report to one tool hid the warning completely, and turning on a plugin was never involved even though the old heading said "plugin layers".

- Refreshing the page no longer opens on "DorkOS can't reach its server" for a few seconds when the server is running fine. DorkOS was remembering an old connection hiccup and treating it as proof the server was down right now. It only says the server is unreachable when this visit's own attempt fails.

- Your API keys stay listed in Settings → Access after you turn "Require login" back off. Turning login off never revoked those keys — they kept working for MCP clients and scripts — but the list disappeared, so there was no way to see them or revoke one.

- Opening DorkOS no longer shows remote access as on, or offers a link and QR code for it, when the tunnel stopped since you were last here. DorkOS was reading what your browser remembered about remote access as if the server had just said it.

- No more "Remote access turned off" alert on a visit where nobody turned anything off. That message now only appears when remote access actually drops while you are looking.

- DorkOS now refreshes itself when its live connection comes back. After a dropped connection (a sleeping laptop, a restarted server, a moment of bad wifi), rooms, sessions and agents could keep showing what they showed before the drop until something else happened to refresh them. The catch-up that was meant to run on reconnect never did.

- Signing back in now clears the "your sign-in stopped working" banner. Before, the banner only went away once something happened to run on the exact account that broke — so if you signed in, sent a test message, and it ran on a different Claude account, the warning stayed up and survived a page reload. Signing in to a different account still leaves the warning up, because that credential really is still broken.

- Agents you talk to in a room now start at the power level you picked. If you set your power to Full autonomy, an agent you @-mention in a room used to ignore it and stop to ask permission instead. That is the one place nobody is watching, so the agent just waited. Now the room reads the same setting your other chats do, from the agent's very first reply. Rooms were the last place this setting did not reach: chats and scheduled tasks already followed it. If you have not set a power level, nothing changes. A room conversation that is already going keeps the settings it started with. And a message from someone in a linked Telegram or Slack chat still starts an agent at the careful setting, so a stranger cannot start one at full power (DOR-1917)

- Keep newly received chat tasks visible when an older history request finishes. Clear the list when a newer history response confirms it is empty.

- A scheduled skill you add to a new folder is picked up within seconds instead of up to five minutes. If the folder DorkOS reads schedules from did not exist yet — a fresh project, or an agent you just added — the first schedule you put there could sit unnoticed for as long as DorkOS kept running, and only a restart would find it. Now DorkOS starts reading the folder the moment it appears (DOR-1908)

- Folder-watching can also go quiet in two other ways: a busy machine running several agents at once can use up the operating system's supply of folder watches, and a schedule saved in the first moment after DorkOS starts watching can slip past. In both cases DorkOS now checks the folder itself every ten seconds for as long as it needs to, so the schedule still starts on time. When everything is working normally, nothing changes (DOR-1908)

- Codex now uses a current version and offers the models available to your signed-in account. New Codex agents start with the runtime you selected.

- Rejected models explain what to change, with a button that opens the model menu. Informational warnings no longer appear as errors.

- Codex and OpenCode agents can use their DorkOS tools while app login is enabled. Each turn keeps the permissions it started with.

- Codex’s context gauge now shows the current conversation size and effective limit reported by Codex, instead of counting earlier requests again.

- Collapsed tool results now show an arrow and an ellipsis, so a result with hidden contents no longer looks empty.

- The Skills row in an agent's profile no longer says "Skills 0" about an agent with thirty-one of them. It says how many there really are once you have opened the Skills page, and says nothing at all before that. Counting them means reading your project folder, and doing that every time a profile opens would slow every chat down for a number you had not asked to see (DOR-1894)

- Approval cards now name the thing they would act on. Asking to remove an agent used to show only its id — a line like `agentId: "01KXQ3P7ADJY9DSXMZW1XGWCV4"` — so four requests in a row looked identical and there was no way to tell which agent was which. The card now leads with the agent's name, keeps the id underneath so you can still check it, and does the same for a scheduled task it would delete. If DorkOS can't look the name up, the card shows the id exactly as before.

- A request DorkOS can't put a name to now says where it came from — "Asked from a session on this computer", or "Asked by an app connected to DorkOS" — instead of the old "Requested without an agent identity", which sounded like the request came from nowhere.

- When you approve or refuse an agent's request to remove an agent or delete a scheduled task, the agent now finds out on its own and carries straight on. Before, those two requests ended the agent's turn: you would approve the card, nothing would happen, and you had to go back to the agent and tell it yourself. Every other kind of request already worked this way; these two were the stragglers. If nobody answers within ten minutes, the agent falls back to the old behaviour and the card stays on your screen, so nothing is lost either way.

- Turn on the agent DorkOS itself runs your sessions on, even when your project shows no sign of it. A project that has only ever used OpenCode or Codex has nothing of Claude Code's for DorkOS to find, so DorkOS used to leave it off — and the session it then started had never read the `AGENTS.md` you keep in that folder. Now it is turned on, DorkOS says so in one plain line, and the one file it writes is a `.claude/CLAUDE.md` pointing at your own `AGENTS.md` (DOR-1901)

- Say so when a project was set up before that, and does not list the agent DorkOS runs. `dorkos harness sync` and the app both name it and give you the one command that turns it on. Your manifest is still never rewritten behind your back (DOR-1901)

- One line on your agent's Skills page had gone stale. Some packages bring along a part that connects DorkOS to Slack or Telegram, and the line explaining why that part stays inside DorkOS instead of travelling out to your coding tools still used an old name for it. It says Messaging now, which is what it is called everywhere else. DorkOS also checks its own wording from here on: a test reads every sentence the file-sharing engine can print — why a tool cannot see a file, what is in the way of writing one, what a sync would delete, what is out of date in the file that lists which tools you share to — and fails if one of them slips back into a word the product has stopped using, so the next stale line gets caught before you ever see it. The page itself is now opened and clicked through in a real browser on every run, against a real folder on disk (DOR-1896)

- If a plain file sits where DorkOS needs a folder — a `commands` file where your agent tool keeps a commands folder, say, or a folder nobody has permission to read or write in — syncing your agent files no longer stops partway through with an error. It sets up everything the folder is not in the way of, leaves the folder exactly as you left it, and lists the one thing it could not do with a line naming the folder and how to clear it. Checking first says the same thing, so you are never told to run a fix that was going to refuse (DOR-1882)

- If DorkOS cannot read the folder your skills live in, it now leaves every skill shortcut alone instead of treating the folder as empty and tidying them away. It says which folder it could not read and that it removed nothing, so a folder with the wrong permissions costs you a warning rather than your skills (DOR-1882)

- Syncing no longer rewrites the command files DorkOS generates when nothing about them has changed. Only the ones that are actually different get written — the same now goes for the settings file DorkOS merges your packages' hooks into, which Claude Code re-reads every time it changes — so your editor and your agent tools stop being told a file changed when it did not, and a folder you have made read-only no longer turns a sync that had nothing to do into an error (DOR-1882)

- When your agent asks to do something that cannot be undone, it waits about ten minutes for you to say yes or no. You get two hours to answer. Answer after that ten minutes and, until now, nobody told the agent — you had to open its chat and pass the message on yourself. Now DorkOS tells it for you. Your answer arrives in the agent's own chat as a note DorkOS wrote and signed, so it always reads as a decision you made in the approvals panel and never as something you just typed. A "no" reaches it just as quickly as a "yes", along with the reason you gave. If the agent is busy, the answer waits its turn instead of getting lost; if its chat has ended for good, DorkOS says so in the log rather than failing. You are only ever told once — an answer that reaches the agent while it is still waiting is not repeated afterwards — and restarting DorkOS mid-decision no longer swallows the answer. This works for agents you run in DorkOS chats today (DOR-1931)

- On Windows, `dorkos harness sync` now makes real skill links whenever your account is allowed to — with Developer Mode on, or as an administrator. Before, it always made the one kind of link Windows allows without permission, and git commits a copy of every skill's files instead of the link, so a teammate who pulled got duplicated skills nobody meant to add (DOR-1883).

- If your account cannot make real links, DorkOS says so once per sync — in the terminal and on the Skills page — before you commit anything: what is on disk, what git would do with it, and the two ways out. Nothing is treated as broken, because the links still work on your own machine.

- Keep sign-ins separate when you run DorkOS with different data folders on different local ports. The default port keeps existing sessions. Other ports require one sign-in after this update. (DOR-1953)

- Managed services now return when DorkOS can reach them again. A temporary outage during startup could hide them until you restarted or linked your account again.

- Messaging now says when it is off or when its options could not be loaded. It no longer suggests choosing an unavailable option or says every kind is already in use when the list failed to load.

- A bug report's attached server log now keeps the lines from just before the problem, instead of the oldest ones. On a busy machine the log was long enough to be trimmed, and it trimmed from the wrong end, dropping exactly the lines that explain what went wrong (DOR-1976).

- The composer status line no longer shows your model's name twice. It now shows up once, right where you'd expect it.

- Opening an agent's session from inside a channel now takes you to the conversation that agent is having in that channel, instead of an unrelated one.

- You can type spaces again when you rename a session from the session list. The space key was being read as a click on the row instead of a character in the name.

- Running out of disk space no longer shuts DorkOS down mid-conversation. It now keeps going, hands scheduled tasks to another DorkOS process if one is running, and writes a line in the log telling you the disk is full. It picks scheduling back up on its own once you free some space.

- Find DorkOS account setup directly from Connections, and refresh available services after linking or unlinking your account.

- Make Gmail send and draft actions available to review. Actions with uncertain effects require the stricter approval level.

- Keep agent commands on the DorkOS version running your app. Unknown commands stop before opening settings, and agents prefer their built-in tools over an older installation on your computer.

- Help agents find their granted accounts and notice access changes in existing conversations. Account guidance now matches Claude Code, Codex, and OpenCode.

- Agents can discover services across the full Connections catalog and ask for the next page, instead of missing services when the catalog is large.

- When this instance loses its DorkOS account link, service actions now explain that nothing was sent and point to Settings to reconnect. Actions with an uncertain remote result remain protected from automatic retries.

- Reconnect disconnected accounts through a fresh sign-in. If disconnection still needs to finish, Accounts now explains the next step. Old agent permissions stay revoked (DOR-1993).

- Keep disconnected accounts in their own section and let you remove them from Accounts after disconnection finishes. Past usage remains available (DOR-1994).

- Stopping an OpenCode subagent now shows as stopped instead of failed. OpenCode changed the wording it sends when a subagent ends early, and DorkOS was reading the new wording as a crash.

- If you reported a bug or asked for a feature and left your email, you now actually get the "your report shipped" email when we ship it. Before, that email only went out if the report carried a version number, and none of them ever did, so nobody got one. The email now links to the changelog so you can see what changed.

- Claude Code sessions keep showing their task list and to-dos after the runtime update

- You now get a clear message when your Claude account is on hold, needs verification, or its cloud credentials were refused, instead of a turn that just stops

- Sessions with a lot of plugins installed start reliably

- DorkOS replaces an outdated copy of the Claude Code command it downloaded for you, so sessions keep starting after an update

- Lowering `MCP_TOOL_TIMEOUT` to cut off a slow outside tool server works again.
  DorkOS used to raise your value back up, because a short one would also cut
  off a tool call that was waiting on you to approve it. DorkOS now sets its own
  time limit on its own tools, so your setting is left alone and reaches the
  server you meant it for.

- When an agent changes a document while you are editing it, the canvas now tells you and lets you pick. Your edit was always protected, but the agent's version used to be thrown away without either of you being told. You get a quiet notice with two buttons: Reload shows their version and ends your edit, and Keep mine throws theirs away. Your agent is still told the change went through — it has no way to know you were typing — so for now the notice is only on your side.

- Agents now know about everything they can put on the canvas. What they were told listed 6 of the 14 kinds, so files, side-by-side changes, web pages, 3D models, sound, video and CSV tables were all things an agent could open and had never heard of. The command that applies a saved layout was missing too, and could not be run at all.

- Lines the room writes about you — a merge, a change to the canvas, the one that opens a document's discussion — now show your name and your face. They used to be signed "Unknown", which read as if nobody wrote them. (DOR-2014)

- Asking an agent for the console at a particular level, or for only the failed requests, works again. Both reads were quietly ignoring every filter you gave them and answering with the default instead (DOR-2009).

- Your agent gets told when an approval times out. When an agent asks to do something that needs your
  sign-off and you never get to it, the request quietly stops being valid after two hours — but until
  now nothing said so. The agent was left waiting on an answer that could no longer come, and you had
  to go and tell it yourself. Now the request closes itself on time and the agent is told, in its own
  words: nobody answered, the request is dead, ask again if it still matters. You get no extra ping —
  it was not your action to be reminded about, and the request had already disappeared from your
  approvals list on its own.

- A tool waiting for your approval no longer looks like it already ran. While Claude Code asked "can I write this file?", the file showed as written — the whole time you were deciding. Now it stays marked as in progress until it really finishes, and a tool you turn down is marked as refused instead of done.

- The OpenCode model list no longer offers models OpenCode cannot run. A model you pulled with Ollama used to show up in the menu even when OpenCode knew nothing about it, so picking it was accepted and then the next message failed with "That model isn't available" — pointing you back at the menu that offered it. The menu now shows only models that will actually work.

- "Run now" can ask you a question again. When you run a task by hand and the agent needs your
  go-ahead for something, the request now shows up where all your other requests do — the tray at
  the top, the Pulse panel, the home page — and you can answer it there. Say yes and the task
  carries on. Before this, the request went nowhere at all: nothing appeared, nobody could answer,
  and two minutes later the run gave up and blamed a schedule you had not used. A task the clock
  starts is unchanged — nobody is watching one of those, so it still gets on with what it can do
  without you and tells you afterwards what it had to skip.

- Every task run now opens to its own conversation. Click a run in a task's history and you land in
  the session it actually had, instead of an error.

- Stopping a task run also takes away the question it was waiting on. Before, the request sat in
  your list for hours pointing at a run that had already finished.

- The composer says why a message did not send. When the server turns a message down for a reason —
  "Choose a registered agent before starting this session", say — you now read that sentence
  instead of "HTTP 400".

- An agent that rewrote its own personality file could switch its personality off by accident. The top of that file is written by DorkOS from the six personality dials you set, and an agent saving the file without it left the dials showing your choice while none of it reached the agent again. DorkOS now keeps that part of the file whatever an agent sends.

- Reloading the page while a tool is waiting for your approval no longer shows it as already done. The live view was fixed first; rebuilding the conversation from its saved history still showed a finished tool, so a refresh mid-decision put the old answer back on screen.

- Extensions are no longer told a tool finished while you are still being asked whether to allow it.

- Opening a message-search result now takes you to the conversation it came from, whichever agent ran it. Results from Codex and OpenCode carried the id those tools use internally, which DorkOS could not open, so pressing Enter on one led nowhere.

- A result from a conversation you had at the command line, which DorkOS never ran, now says so instead of offering a link that opens an empty screen. The message is still found and still shown.

- When part of DorkOS fails to load, the "Something went wrong" screen now always shows, with its Try again and Back to home buttons. Before, some unusual failures could crash that screen too, and you saw nothing useful (DOR-2032)

- Desktop: a slow start no longer makes the app reload its window over and over, losing unsent messages and half-filled settings each time. The shell was reading the old page's late check-in as the new page coming up, so it kept retrying the same first step instead of trying the deeper fixes (#1840, DOR-2034)

- The "DorkOS can't reach its server" screen now only appears when nothing answers at all. When a request for your settings comes back with an error instead, DorkOS says that and shows the status code it got, rather than telling you the server is down (DOR-2035, #1841)

- When DorkOS will not answer to the address you reached it on, it now says so in words you can act on, instead of a bare error code (DOR-2035)

### Security

- Keep raw MCP server URLs out of shared configuration snapshots, where embedded credentials could be exposed.

- Stop passing the full DorkOS server environment to coding agents and their setup commands. Standard model sign-ins and operating system settings remain available. Custom tools that need extra variables now require an owner-approved list of names. Restart DorkOS after updating that list (DOR-1904).

### Note for people upgrading

- DorkOS adds these links while you work and never removes them on its own, which is deliberate: it will not delete files in a folder you may be editing right now. So a skill you delete leaves a dead link behind. `dorkos harness sync --check` lists them and `dorkos harness sync --fix` clears them out (DOR-1850)

- This only ever touches projects you have already set up for syncing, and only inside the folder your `DORKOS_BOUNDARY` allows. A project DorkOS has never synced is left completely alone (DOR-1850)

- Showing a page needs a server to serve your files and reach your dev server, so the Browser tab is
  part of the web app and does not appear in the Obsidian plugin. Everything you had open is still
  open — pages just moved one tab along.

- A recording is a slideshow of the steps, not a video of them — two frames a second, and at most sixty frames. Past sixty it stops filming and everything the agent is doing keeps working; the answer says so.

- An agent can only attach a file from its own working directory. It cannot reach into another agent's copy of the work, and the size and count limits are the same ones your own uploads follow.

- One thing an agent reaching in from outside the DorkOS app still cannot do: apply a Shape. It writes to your machine — files, settings and scheduled work — and there is no way to put that question to you from a Codex or OpenCode session, so it is refused with a sentence telling the agent to ask you to do it in the app. Your Claude Code agents still ask you the normal way.

- Nothing changed about what your Claude Code agents can do, or what any of these tools are called. They are the same names, the same arguments and the same answers; there is just one copy of each now instead of one per runtime.

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
- A Codex chat you start from DorkOS now offers the same skills the `codex` command does, including ones that came from a package you installed or a folder you linked in. Those skills always worked in your own terminal; they were just missing from the DorkOS slash menu and from the list your agent reads (DOR-1844)
- Your own hook files stay yours. If you had written a `.codex/hooks.json`, `.cursor/hooks.json` or `.github/hooks/copilot-hooks.json` by hand, installing a marketplace plugin could delete it — even a file for an agent you had not turned on. DorkOS now leaves any hook file it did not write exactly where it is and says so. The one exception is a `.codex/hooks.json` holding nothing but a bare list of events, which only older versions of DorkOS ever wrote and Codex never read — that one is replaced with a file Codex does read. When it had hooks of its own to put there, it tells you they are blocked and to move them into `.claude/settings.json`, which reaches every agent you run; when it had none, it just notes the file is yours and carries on (DOR-1842)
- Hooks projected to Codex are now written the way Codex reads them. The file DorkOS generated at `.codex/hooks.json` had the right hooks in the wrong shape, so Codex most likely ignored every one of them. Existing files DorkOS wrote are rewritten in place the next time you sync (DOR-1842)
- DorkOS only tidies away the skill shortcuts it made itself. A skill of your own with a double underscore in its name — `my__helper` — looked like one of those, so a sync could remove the shortcut it had just created for it (DOR-1844)
- On Windows, a skill kept somewhere else in your project and linked into `.agents/skills` now gets the right kind of shortcut. DorkOS asked Windows for a file shortcut where a folder one was needed, which fails unless you are an admin or have Developer Mode on (DOR-1844)

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

Older releases (v0.1.0 – v0.64.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.64.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.64.0.md).

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.83.0...HEAD
[0.83.0]: https://github.com/dork-labs/dorkos/compare/v0.82.0...v0.83.0
[0.82.0]: https://github.com/dork-labs/dorkos/compare/v0.81.0...v0.82.0
[0.81.0]: https://github.com/dork-labs/dorkos/compare/v0.76.0...v0.81.0
[0.76.0]: https://github.com/dork-labs/dorkos/compare/v0.75.1...v0.76.0
[0.75.1]: https://github.com/dork-labs/dorkos/compare/v0.75.0...v0.75.1
[0.75.0]: https://github.com/dork-labs/dorkos/compare/v0.74.0...v0.75.0
[0.74.0]: https://github.com/dork-labs/dorkos/compare/v0.73.0...v0.74.0
[0.73.0]: https://github.com/dork-labs/dorkos/compare/v0.66.0...v0.73.0
[0.66.0]: https://github.com/dork-labs/dorkos/compare/v0.65.0...v0.66.0
[0.65.0]: https://github.com/dork-labs/dorkos/compare/v0.64.0...v0.65.0

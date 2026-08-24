---
covers:
  - 'feat(skills,server,db): discover schedules in skills roots and never auto-arm them'
  - 'test(server,client): cover skills-root discovery, the arm gate and file provenance'
  - 'fix(server,client): approving a schedule no longer rewrites its file'
  - 'fix(server,db,client): store the schedule arm grant instead of inferring it from status'
---

### Added

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

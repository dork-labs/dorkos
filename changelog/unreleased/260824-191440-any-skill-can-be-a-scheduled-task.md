---
covers:
  - 'feat(skills,server,db): discover schedules in skills roots and never auto-arm them (DOR-1485)'
---

### Added

- Any skill can now be a scheduled task. Add a `schedule:` block to a skill's settings and DorkOS picks it up — no moving the file, no special folder. Take the block out and it goes back to being an ordinary skill. DorkOS watches your agents' `.agents/skills/` folders and a new `~/.dork/skills/` folder for schedules that do not belong to any one project (DOR-1485)
- Nothing DorkOS finds in a file ever starts running on its own. A schedule found on disk waits on the Schedules page until you approve it, whether or not the file says it is switched on. Once you approve it, it stays approved as long as the file does not change; edit what it does or when it runs and it comes back for another look. That means a schedule cannot arrive on your computer through a `git pull` or an installed package and quietly start running (DOR-1485)
- A schedule that DorkOS cannot read now says so instead of going quiet. If the schedule settings have a typo, or the timing is written in a way DorkOS cannot make sense of, the schedule shows up waiting for you with the problem written out — naming the setting and what is wrong with it. The skill itself keeps working everywhere else; only the schedule half is held back (DOR-1485)
- Agents you add while DorkOS is running have their schedules found straight away. Before, DorkOS only looked at each agent's folders when it started up, so a schedule that came with a newly added agent stayed invisible until the next restart (DOR-1485)

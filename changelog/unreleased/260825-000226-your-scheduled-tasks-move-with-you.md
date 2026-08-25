---
covers:
  - 'refactor(server,skills): the legacy task shape has one reader left'
  - 'feat(server): scheduled tasks move themselves to their new home on first start (DOR-1486)'
  - 'fix(server): a Shape never writes over a skill it did not create (DOR-1486)'
---

### Changed

- Your scheduled tasks live with your skills now. The first time you start this version, DorkOS moves every one of them out of its old folder and into `~/.dork/skills/` (or your project's `.agents/skills/`), and rewrites the settings at the top of each file into a `schedule:` block. Nothing to do, nothing to click — and the ones you had already approved stay approved and keep running (DOR-1486)
- New scheduled tasks land in the same place, in the same shape, whether you make one in the cockpit, an agent proposes one, or a Shape sets one up for you. There is one kind of file now: a skill, which may or may not have a schedule on it (DOR-1486)
- A schedule that a Shape sets up now waits for you before it runs, the same as one DorkOS finds in a file. Applying a Shape means you want the arrangement; saying yes to a job that runs on its own is a separate answer (DOR-1486)

### Fixed

- If two things wanted the same name — a task called `digest` and a skill called `digest` — the skill keeps its name and the task moves in beside it as `digest-migrated`, and shows up waiting for you so you can see what happened. Nothing is overwritten (DOR-1486)
- A task file DorkOS cannot read is left exactly where it is, and appears on your Schedules page with the file's path and what is wrong with it, instead of being quietly left behind in a folder nothing looks at any more (DOR-1486)
- A Shape can no longer write its schedule over a skill you wrote yourself that happens to have the same name. Your file stays exactly as it is, and DorkOS says which schedule it skipped and why (DOR-1486)
- Your task templates keep their timing when they move. Before, a template that had moved offered no schedule at all when you picked it (DOR-1486)
- An agent you add while DorkOS is running brings its scheduled tasks with it straight away, instead of waiting for the next restart (DOR-1486)

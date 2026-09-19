---
covers:
  - "fix(tasks): approving an agent-proposed schedule can grant the operator's own trust stop, per task (DOR-2100)"
---

### Fixed

- Approving a schedule an agent proposed can now also give it the setting you actually run at. A proposed job is always held back to the careful level, whatever it asked for, so nothing an agent writes can hand a 3am job more power than the agent has itself. But approving it never lifted that — so if your own setting was Full autonomy, you said yes and then the job failed the first time it needed to run a command, with nothing telling you why. The approval card now shows what each answer will run the job at, and offers a second button naming your own level ("Approve at Full autonomy") beside the plain Approve. It applies to that one job: the next schedule an agent proposes arrives held back exactly the same way (DOR-2100)

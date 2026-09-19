---
covers:
  - "fix(tasks): approving an agent-proposed schedule can grant the operator's own trust stop, per task (DOR-2100)"
  # Folds in here: the review round on the same change, before anybody could
  # have used the first version. The consent door is the one bullet-visible
  # part — it adds a confirmation in front of a level that never asks — and the
  # sentence below already promises the card "shows what each answer will run
  # the job at", which the feed wording and the packaged-schedule refusal are
  # both corrections to rather than news of their own.
  - 'fix(tasks): a raised schedule approval goes through the same consent door every other unattended level does (DOR-2100)'
---

### Fixed

- Approving a schedule an agent proposed can now also give it the setting you actually run at. A proposed job is always held back to the careful level, whatever it asked for, so nothing an agent writes can hand a 3am job more power than the agent has itself. But approving it never lifted that — so if your own setting was Full autonomy, you said yes and then the job failed the first time it needed to run a command, with nothing telling you why. The approval card now shows what each answer will run the job at, and offers a second button naming your own level ("Approve at Full autonomy") beside the plain Approve. Giving it a level that never stops to ask asks you to confirm first, the same as anywhere else. It applies to that one job: the next schedule an agent proposes arrives held back exactly the same way (DOR-2100)

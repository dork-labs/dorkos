---
covers:
  - 'feat(client): a proposed schedule becomes a card — who asked, why, exactly when it would run, and a test run before you commit (DOR-1398)'
  - 'feat(client): the playground draws every state of the schedule approval card (DOR-1398)'
  - 'fix(client): the home header names what is waiting instead of calling it all approvals, and a proposal waits where the other decisions do (DOR-1398)'
  - 'fix(client): one prompt is one question, wherever the Inbox counts them (DOR-1398)'
  - 'refactor(client): one wording for what is waiting, read by both the Inbox and the home header (DOR-1398)'
  - 'refactor(client): split the Features playground registry at its natural seam (DOR-1398)'
  - 'fix(client): an approved schedule holds its receipt long enough to read, and the test-run strip is reachable in the playground (DOR-1398)'
  - 'fix(client): a re-approved schedule gets its own full receipt, not the leftovers of the last one (DOR-1398)'
  - "refactor(client): the card family's exit timing moves to shared, where all three of its readers can see it (DOR-1398)"
---

### Added

- When an agent suggests a scheduled job, you now get a real card instead of a one-line row. It shows which agent asked, why they asked in their own words, what the job would do, and the next few times it would actually run. The exact instructions sit behind a "Show exact instructions" link, next to how much power the job would have. Nothing on the card is guessed: if the server could not work out when it would run, the card says nothing rather than making a time up (DOR-1398)
- **Run it once.** Before you agree to something that will run on its own every night, you can run it a single time and watch what happens. The card tells you when it finishes and links straight to what it did. Nothing gets scheduled, and Approve is still sitting there afterwards, now with proof behind it (DOR-1398)
- Turning down a suggested job now gives you a few seconds to change your mind. The card says "Rejected" with an Undo button, and the job is only really deleted once that moment passes. Undo cancels something that was never sent, so there is nothing to put back. Closing the panel does not lose your decision (DOR-1398)
- You can answer a suggested job from the keyboard, the same way you answer everything else that needs you: A to approve, D to turn down, and only while the card has your focus, so a stray keypress while you are typing cannot decide anything (DOR-1398)
- The card names the conversation the job was suggested in, and clicking it opens that conversation (DOR-1398)

### Fixed

- The home screen used to announce everything waiting on you as "approvals", even when none of it was. It now says what each thing actually is: questions, requests, and schedules. Screen readers hear the same honest wording the Inbox already used (DOR-1398)
- A suggested job now waits in "Waiting On You" alongside the other decisions, instead of sitting under "Needs Attention" with the things that broke (DOR-1398)
- The Inbox used to count waiting agents in one place and waiting questions in another, so the same queue could be described two different ways. It now counts questions everywhere, one per question (DOR-1398)
- Approving a suggested job used to flash its confirmation and take it away again in the same instant, because the job left the waiting list the moment it was approved. The card now stays put long enough to read what you just agreed to (DOR-1398)

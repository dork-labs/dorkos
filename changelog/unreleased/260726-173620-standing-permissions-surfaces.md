---
covers:
  - 'feat(approvals): grant an agent standing permission from the card, and take it back from anywhere (DOR-501)'
  - 'fix(approvals): say what actually happened when a decision is refused, and stop three checks passing over broken code (DOR-501)'
---

### Added

- Tell DorkOS to stop asking about one thing. An approval card now carries a third button, "Allow, and stop asking about this for 8 hours", that covers one agent doing one action, for a stretch of time you choose. Turn it on in Settings, under Security (DOR-501)
- Find and end a standing permission from either of two places: Settings under Security, or the approvals marker in the header, which now shows a quiet count when trust is live. Each one has a **Stop trusting** button (DOR-501)
- Choosing a permission mode that skips prompts now says what it does not cover: actions on DorkOS itself, like removing packages, still ask. The line appears wherever a mode is picked: the session picker, a channel binding, and a scheduled task (DOR-501)

### Changed

- Standing permissions need **Require login** on. Without it DorkOS cannot tell you apart from an agent running on the same computer, so the control is shown but switched off, with the reason and the fix right above it. Turning the feature off ends every permission that is live, and says so before it does (DOR-501)
- When DorkOS turns down an answer you gave on an approval card, it now tells you what actually happened instead of "Action failed". The case that matters most: if the action went ahead but the permission could not be saved, it says so plainly, so you never repeat something that cannot be undone (DOR-501)
- If DorkOS cannot check which standing permissions are live, both places that list them say so and offer to try again, rather than showing an empty list that reads as "nothing is trusted" (DOR-501)

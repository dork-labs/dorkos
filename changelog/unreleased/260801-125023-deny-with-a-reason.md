---
covers:
  - 'feat(approvals): say why you said no, and see how long you have (DOR-809, DOR-810)'
---

### Added

- **Say why you said no.** When an agent asks permission and you want to refuse, the approval card now offers **Add a reason** — one line, entirely optional. What you type goes to the agent with the refusal, so instead of trying the same thing again it can take another route. Deny on its own still works exactly as before: click Deny, press Esc, and nothing slows down.
- **The transcript says whether the agent heard you.** A denial you explained reads _You denied `rm -rf node_modules` — agent was told why_. A denial you did not explain says only that you denied it, and a request that ran out its ten minutes still reads _Expired — denied_, because a clock explains nothing. The line only claims the agent was told when the reason actually reached it.

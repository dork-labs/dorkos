---
covers:
  - 'feat(site): feature catalog catches up with the shipped product (DOR-1516)'
  - 'feat(site): six new comparison dimensions (DOR-1516)'
  - 'feat(site): /compare speaks human (DOR-1516)'
  - 'fix(site): three review notes on the comparison copy (DOR-1516)'
---

### Added

- The features list on dorkos.ai now includes seven things that shipped without ever getting written down: your Inbox, alerts that follow you to your phone, schedule approvals, reply limits, the activity feed, billing an agent to a different Claude account, and Shapes (DOR-1516)
- The comparison pages ask six new questions, and they are the ones people actually run into. Does it use the plan you already pay for? Can an agent book itself a repeating job, and do you get a say? Can you stop your agents talking to each other all night? Can you read the code and skip making an account? Can you say yes from your phone? Is there one list of everything waiting on you? (DOR-1516)

### Changed

- Rooms, Connections and the Slack adapter are no longer labelled earlier than they are. Rooms in particular is the screen DorkOS opens on, so calling it experimental had stopped being true (DOR-1516)
- Every comparison page got shorter and plainer. The verdicts are a few sentences instead of a paragraph, the questions and answers are trimmed to the ones people ask, and the pages stop explaining themselves with metaphors (DOR-1516)
- Comparison pages used to open by telling you that searching the other way round lands on the same page, which is a fact about search engines rather than anything you wanted to know. They now open with a sentence about the two tools (DOR-1516)
- Two ownership changes we had wrong: Cursor is owned by SpaceX, which bought Anysphere in August 2026, and Grok Bot is made by SpaceXAI. That also means the two share an owner, so Grok Bot coming with some Cursor plans is one company bundling its own product. Both pages now say so (DOR-1516)
- The pages are clearer that these agents are not only for code. They write the code, and they also send the email, plan the week and book the call (DOR-1516)

### Fixed

- We were quietly claiming that scheduled work happens "while you are asleep or away". DorkOS runs on your own computer, so it needs that computer awake. The pages now say a job starts at a set time without you pressing anything, which is the true version (DOR-1516)

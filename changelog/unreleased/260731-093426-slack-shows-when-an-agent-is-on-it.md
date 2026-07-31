---
covers:
  - 'feat(relay): Slack marks your message when an agent picks it up'
---

### Changed

- **Slack now shows you when an agent has actually picked your message up.** Your message gets an 👀 reaction the moment an agent starts working on it, and loses it when the answer lands or the attempt fails. Before, the reaction was an hourglass added the instant your message arrived — which meant a message nobody ever picked up still looked like it was being worked on. Now the mark means somebody is on it.
- **Nothing is added when the work finishes** — no green tick, no red cross. The reply is the answer, and the error message is the failure.
- If an agent stops to ask you something mid-answer, the reaction comes off while it waits and goes back on the same message when it carries on.

Setting the working indicator to **None** still turns all of this off, and still makes zero calls to Slack.

---
covers:
  - 'feat(rooms): a thread reply reads under the message it answers'
---

### Changed

- Replies in a channel now gather under the message they answer, behind a small "3 replies" line. Threads used to be separate rooms you opened on their own, so following one meant leaving the channel and coming back; now you read the whole conversation in one place. The first three replies show inline and the rest are one press away, so a busy thread cannot bury the channel it belongs to.
- When the message a reply answers is older than the history that has loaded, the reply says "Replying to an earlier message" rather than reading like a new remark. Old links that pointed straight at a thread still open the channel it lived in.
- The command palette lists your channels, not every thread inside them.

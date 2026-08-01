---
covers:
  - 'feat(settings): tell DorkOS how much new sessions may do, once'
  - 'feat(session): a new conversation starts at the trust level you chose'
  - 'feat(client): make the stop you just picked the default, where you picked it'
---

### Added

- **Tell DorkOS how much new sessions may do — once.** Settings, in the card that already holds the model and effort a new chat starts with, now asks where new chats should start: **Ask first**, **Act**, or **Full autonomy**. One choice covers every agent you run — the three words mean the same thing whichever one you are talking to — and underneath, a line per runtime says what that choice actually means for it, including where a runtime cannot pause to ask. **Ask first** stays the out-of-the-box default, and chats you already have keep what they are running with.
- **Something different for one agent?** "Customize per runtime" opens a row for each, with the same dial and a way back to the shared setting.
- **Make it the default right where you decided it.** After you change a chat's trust level, a quiet line appears under the dial for a few seconds — _Start every new session in Act? **Make default** · Dismiss_ — so the habit is caught where it happens instead of costing you a trip to Settings. It stays quiet when that stop is already where new chats start, and it takes no for an answer for the rest of the conversation.
- **Full autonomy is a choice you acknowledge once**, in Settings or right where you just made it. DorkOS asks what it means at the moment you choose it and writes down that you read it; from then on new chats start without asking, and Settings keeps a quiet note saying so with a link to change it back.

This is for the chats you open yourself. Scheduled runs, chat integrations and rooms keep their own settings and their own, stricter rules — nothing here reaches them.

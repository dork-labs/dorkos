### Changed

- The Agents page now shows your fleet in **attention order**: whatever needs you leads, instead of an alphabetical inventory list. Rows group into **Needs you**, **Working**, and **Quiet**. Pick a different sort, by name for example, and the groups flatten.
- **Working** now reflects chats across your whole fleet, not just the project you happen to have open. An agent counts as working when a chat in its folder is live, or was live within the last hour, even while you are looking somewhere else.
- Each row now says what the agent last did, in plain words: "Finished a reply", "Got a message", "Cannot be reached". The time it happened sits underneath. If a chat with the agent is waiting on you — for a permission you have not answered, or after an error — the row says so and moves to the top.
- A new **Scheduled** column shows how many scheduled tasks are waiting on each agent. An agent that has gone quiet for a day with tasks still scheduled is flagged as needing you, because those runs are failing.
- The **Status** and **Sessions** columns are gone. Health now shows in the group a row sits in, the ring around the agent's avatar, and the row's own wording — three quieter signals instead of the same word repeated down the page. You can still filter by status. The old session count was never a count of open chats, so nothing replaces it.
- The agent's runtime and project moved under its name, which frees up room and makes the page much easier to read on a phone.

### Fixed

- The Tasks page now sorts by which task runs next when you first open it, and the sort button says so. It used to show "Sort:" with nothing after it.

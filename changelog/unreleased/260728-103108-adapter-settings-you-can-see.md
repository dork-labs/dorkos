---
covers:
  - 'fix(relay): show the adapter settings no setup step names (DOR-640)'
---

### Fixed

- Slack and Telegram settings that the setup screens never showed you are now on screen, in the add flow and behind Configure. The most important ones decide who is allowed to approve an action: when your agent asks permission to run something, only the people you list under Approvers can say yes. That list was impossible to fill in before, so nothing could be approved from Slack or Telegram at all. Slack also gains its DM controls: who may message your bot, which channels behave differently, and when the bot joins in.
- A setting that no setup screen claims now appears under its own heading on the last screen. Nothing can go missing again just because it was left off every screen.
- Lists and per-channel rules you had already saved now show up the way you wrote them: one entry per line, and readable settings instead of `[object Object]`. Editing one of these and saving used to run your existing entries together into a single broken one, which quietly took away everyone's permission to approve.
- If the Channel Overrides box is not valid JSON, saving now stops and tells you, and your existing rules stay put. It used to accept the save and erase them.
- Nothing changed value. Every setting opens on what it was already set to, including the ones you are seeing for the first time.

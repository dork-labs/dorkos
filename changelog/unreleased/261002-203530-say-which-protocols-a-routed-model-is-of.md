---
covers:
  - 'feat(cloud-api): say which protocols a routed model is offered on (DOR-2636)'
  - 'feat(credits): show only the models your DorkOS credits cover in the model picker (DOR-2636)'
  - 'fix(credits): filter credit models only once the service says, and swap unserved models at launch (DOR-2636)'
  - 'fix(credits): keep the model swap in the conversation, resolve aliases, keep the last good list, gate every model write (DOR-2636)'
  - 'fix(credits): save a model swap only with its notice, place it in its turn, read context markers, cap the kept list (DOR-2636)'
  - 'fix(credits): one format vocabulary and one model list for every runtime on credits (DOR-2636)'
---

### Added

- Once DorkOS says which models your credits cover, a chat or an agent on DorkOS credits lists only those models in the model menu, with DorkOS's suggested model first. This works the same in Claude Code, Codex and OpenCode. A chat on credits with no model chosen starts on that suggestion. Chats on your own sign-in keep the full menu and **Automatic** (DOR-2636)
- A chat, an agent or a scheduled task on credits can't be set to a model your credits don't cover. If one already names such a model, it runs on the suggested model instead. A note in the conversation names both models and stays there, in chats, scheduled tasks and rooms alike, and the status line shows the model that ran (DOR-2636)
- If DorkOS can't check the models your credits cover right now, it keeps using the last list it got (up to seven days old), even after a restart, and the menu says the list may be out of date (DOR-2636)
- If your credits cover no model for a runtime, a chat on credits stops and says so, with the way to use your own sign-in instead (DOR-2636)
- `@dork-labs/cloud-api`: each model in `GET /v1/inference/models` can now say which request formats to offer it in (`protocols`, by `InferenceFormatSchema` name) and in which it is the suggested first pick (`recommendedOn`). Both fields are optional (DOR-2636)

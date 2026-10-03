---
covers:
  - 'feat(cloud-api): say which protocols a routed model is offered on (DOR-2636)'
  - 'feat(credits): show only the models your DorkOS credits cover in the model picker (DOR-2636)'
---

### Added

- When a chat or an agent runs on DorkOS credits, the model menu lists only the models your credits cover for that runtime, with DorkOS's suggested model first. A new chat on credits that has no model chosen starts on that suggestion. Chats on your own sign-in keep the full menu and **Automatic** (DOR-2636)
- If DorkOS can't load the models your credits cover, the menu says so and your model stays as it is. A chat or an agent on credits can't be set to a model your credits don't cover (DOR-2636)
- `@dork-labs/cloud-api`: each model in `GET /v1/inference/models` can now say which request formats to offer it on (`protocols`) and where it is the suggested first pick (`recommendedOn`). Both fields are optional (DOR-2636)

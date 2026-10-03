---
covers:
  - 'feat(cloud-api): say which protocols a routed model is offered on (DOR-2636)'
  - 'feat(credits): show only the models your DorkOS credits cover in the model picker (DOR-2636)'
  - 'fix(credits): filter credit models only once the service says, and swap unserved models at launch (DOR-2636)'
---

### Added

- Once DorkOS says which models your credits cover, a chat or an agent on DorkOS credits lists only those models in the model menu, with DorkOS's suggested model first. A chat on credits with no model chosen starts on that suggestion. Chats on your own sign-in keep the full menu and **Automatic** (DOR-2636)
- A chat, an agent or a scheduled task on credits can't be set to a model your credits don't cover. If one already names such a model, it runs on the suggested model instead and the chat says so once, naming both models (DOR-2636)
- If DorkOS can't load the models your credits cover, the menu says so and your model stays as it is (DOR-2636)
- `@dork-labs/cloud-api`: each model in `GET /v1/inference/models` can now say which request formats to offer it on (`protocols`) and where it is the suggested first pick (`recommendedOn`). Both fields are optional (DOR-2636)

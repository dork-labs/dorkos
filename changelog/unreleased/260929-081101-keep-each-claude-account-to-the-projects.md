---
covers:
  - "test(shared): re-vendor flow's fleet contract 4.1.0 and check the writer's clock (DOR-2526)"
  - 'feat(server): keep each Claude account to the projects it may work in (DOR-2526)'
  - 'feat(client): show and set where each Claude account may work (DOR-2526)'
  - 'docs: keep an account to its projects, in the guides and the spec (DOR-2526)'
  - "fix(server): judge a schedule's account by its agent's folder, and never fail a launch over the account check (DOR-2526)"
  - 'fix(config): read a hand-edited account rule of the wrong shape as no rule (DOR-2526)'
  - "fix: the chat's Default account names what a send will really bill in this project (DOR-2526)"
  - "fix(server): refuse a person's schedule on an account its project may not use (DOR-2526)"
  - 'fix: tidy the account-rule wording, dialog and docs from review (DOR-2526)'
  - "docs: say how a project's account list is set today (DOR-2526)"
  - 'fix(config): refuse a malformed account rule in a PATCH, and say at boot when one is dropped (DOR-2526)'
---

### Added

- Keep an account to the projects it belongs to. Set a work account to "Only for client-app" in Settings → Runtimes, and DorkOS will never use it for new chats anywhere else, whether you, a schedule or an agent picks it. In other projects the account shows in the chat's account menu but can't be chosen, and the menu's Default names the account a new chat there will really use. Chats already running keep their account (DOR-2526)

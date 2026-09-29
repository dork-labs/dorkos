---
covers:
  - "test(shared): re-vendor flow's fleet contract 4.1.0 and check the writer's clock (DOR-2526)"
  - 'feat(server): keep each Claude account to the projects it may work in (DOR-2526)'
  - 'feat(client): show and set where each Claude account may work (DOR-2526)'
  - 'docs: keep an account to its projects, in the guides and the spec (DOR-2526)'
  - "fix(server): judge a schedule's account by its agent's folder, and never fail a launch over the account check (DOR-2526)"
---

### Added

- Keep an account to the projects it belongs to. Set a work account to "Only for client-app" in Settings → Runtimes and DorkOS will never use it anywhere else, whether you, a schedule or an agent picks it. In other projects the account shows in the chat's account menu but can't be chosen, and a project can also limit which accounts it uses (DOR-2526)

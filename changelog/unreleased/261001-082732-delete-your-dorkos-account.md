---
covers:
  - 'feat(cloud-api): ask to delete the account, confirmed by email (DOR-2651)'
  - 'feat(cloud-plan): delete your DorkOS account from the account tab (DOR-2651)'
  - 'fix(cloud-plan): keep account deletion person-only and honest about the link (DOR-2651)'
  - 'chore(changelog): fold the review fix into the one DOR-2651 fragment'
  - 'fix(cloud-plan): return focus on cancel and show the person-only refusal (DOR-2651)'
---

### Added

- You can delete your DorkOS account from **Settings › DorkOS account**. Before anything happens, it says what goes (your plan, credits you haven't used, your seats and the rest of the account) and what stays (everything on this computer), offers a copy of your data, and asks you to type "delete". DorkOS then emails you a link, and nothing is deleted until you follow it. Only you can ask, never an agent. Once you follow the link, this computer unlinks itself and keeps working on its own; if the link expires first, the app says so and offers a new one. Where your account doesn't offer this yet, the app says so plainly. (DOR-2651)

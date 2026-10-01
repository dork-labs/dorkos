---
covers:
  - 'feat(client): give the DorkOS account its own home, one move from the team-name menu (DOR-2628)'
  - 'fix(client): point every "Settings › Access" message at its new tab, and tighten the account home (DOR-2628)'
  - 'fix(client): say plainly when DorkOS credits stop, and name the phone fold for what it holds (DOR-2628)'
  - 'fix(client): show only a server-written reason when DorkOS credits fail to turn on (DOR-2628)'
  - 'fix(client): point the last two link messages at the DorkOS account tab, and say a relink keeps the computer linked (DOR-2628)'
---

### Changed

- Your DorkOS account has one home now: a **DorkOS account** tab in Settings, right after Profile. Before you link, it says plainly what an account adds on this computer and offers one button. Once you link, it shows your plan, your credits (what is included this period and what you added), which runtimes run on your credits, what is on your account, your seats if you have any, and **Unlink this computer** at the bottom (DOR-2628)
- The team-name menu at the top of the sidebar now opens with you (your face and name, onto your profile), then **DorkOS account**, which says whether this computer is signed in, then **Settings**. "Workspace settings" is now just "Settings", and the extra "Account" row that opened your profile is gone. The You tab on a phone starts with the same two rows (DOR-2628)
- The Access tab in Settings is gone. Its login half is now **Login & security**, under **This computer**. Old links to `?settings=account`, `?settings=security` and `?settings=access` still open the right tab (DOR-2628)

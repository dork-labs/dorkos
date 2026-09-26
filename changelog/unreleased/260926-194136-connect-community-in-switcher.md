---
covers:
  - 'feat(communities): connect a community from the sidebar switcher (DOR-2422)'
  - 'fix(communities): keep the connect dialog honest when a wait ends elsewhere (DOR-2422)'
  - 'fix(communities): forget the old owner’s wait when the owner changes (DOR-2422)'
---

### Changed

- You now connect a community right from the switcher at the top of the sidebar. Choose **Add community**, then **Connect a community**, and a small window asks for its address and walks you through approving it on the community's site. Once you approve, the window closes and the community is selected. A community still waiting for your approval, or one that needs connecting again, opens that same window when you choose it, instead of sending you to Connections. Communities no longer appear on the Connections page, and the note you get when this DorkOS loses access to a community now points to the switcher (DOR-2422).

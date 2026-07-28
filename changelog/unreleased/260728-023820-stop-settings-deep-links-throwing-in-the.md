---
covers:
  - 'fix(client): stop settings deep links throwing in the router-less embed (DOR-484)'
---

### Fixed

- Buttons that open Settings work again in the Obsidian plugin. A recent change
  made "Add more agents", "Open Relay settings" and "Add an integration" do
  nothing at all there instead of opening Settings. They open it again (DOR-484)
- A link to a Settings tab that no longer exists now opens Settings on its first
  tab instead of showing an empty panel. An old bookmark or a renamed tab used
  to leave you looking at a blank window with nothing selected (DOR-484)

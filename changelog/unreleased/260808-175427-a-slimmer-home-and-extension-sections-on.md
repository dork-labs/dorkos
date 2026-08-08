---
covers:
  - 'feat(client): retire the promo grid, Your agents, and System Status; extensions move to the Activity tab (team-room-home 1.5 + 1.6)'
---

### Changed

- Home is quieter. The promo card grid, the "Your agents" grid, and the System Status row are gone. Nothing they told you is lost: your team lives on the Team page and in the sidebar, schedules on the Scheduled tab, messaging health under Connections, and how busy the week has been now sits at the top of the Activity tab with its sparkline.
- Sections added by extensions now appear under "From your extensions" at the top of the Activity tab. Extension authors do not need to change anything — it is the same slot, in the same order, and the heading only shows up when you actually have an extension contributing a section.

### Added

- Extensions can now pass `visibleWhen` when they add a section, so a section can hide itself on the days it has nothing to say instead of showing an empty card.

---
covers:
  - 'feat(community): persist owner-scoped navigation state'
  - 'feat(community): define switcher destination descriptors'
  - 'feat(community): fence browser state by owner generation'
  - 'feat(community): fence content by route generation'
  - 'feat(community): add route-owned context switcher'
  - 'feat(community): add phone context sheet'
  - 'fix(shared): retain navigation transport contract'
  - 'fix(community): restore the navigation routes and owner fence a merge dropped'
  - 'fix(client): keep the JSON default off FormData and binary request bodies'
  - "fix(client): give phones the header menu's account rows again"
  - 'fix(client): fit the phone context switcher in the top bar'
---

### Added

- Move between this DorkOS and each community you've joined from the switcher at the top of the sidebar. On a phone, it opens as a sheet from the top bar, with your settings and account still at the bottom. The switcher remembers your order and where you left off. Messages from one community never show up in another, even after you sign in as someone else.

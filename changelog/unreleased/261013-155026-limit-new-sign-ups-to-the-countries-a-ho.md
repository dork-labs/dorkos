---
covers:
  - 'feat(community): limit new sign-ups to the countries a host allows (DOR-2847)'
  - 'docs(community): explain allowed countries and test the sign-up box (DOR-2847)'
  - 'fix(community): never ask an existing account where it lives on single sign-on (DOR-2847)'
---

### Added

- The person running a Community server can open sign-up only to people who live in certain countries, with `COMMUNITY_ALLOWED_COUNTRIES` (for example `US`). Everyone who creates an account then ticks a box that says "I live in the United States" first, whether they sign up with a password, Google, GitHub, or single sign-on, or join an open space. People who already have an account are never asked. A server behind a proxy that adds each visitor's country can also set `COMMUNITY_COUNTRY_HEADER`, so a sign-up from a country outside the list is turned away. Leave both unset and nothing changes (DOR-2847)

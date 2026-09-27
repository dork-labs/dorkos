---
slug: connection-app-details
status: ideation
created: 2026-09-27
---

# Connections: app details — ideation

**Problem.** The Connections list is one plain list of apps (`specs/connections-one-list/`), but every app shows a letter instead of its logo, most apps have no description, a person can't see what "Read" or "Read & write" lets an agent do, and the server fetches the whole app list from the connection service on every page and every search.

**Direction.** Real logos (bundled for popular apps, fetched once and kept by the server for the rest), one plain line per app, a Look/Change view of what an app lets agents do tied to the access choice, and a kept app list.

The decisions, findings and the MoSCoW ranking are in [design-decisions.md](design-decisions.md). The visual session's chosen screen is in `mockups/`.

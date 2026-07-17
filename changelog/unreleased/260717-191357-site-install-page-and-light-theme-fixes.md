### Added

- New install page at dorkos.ai/install with every way to get DorkOS in one place: the Mac app, the one-line terminal install, npm, the Windows early alpha, and Docker, plus how to update. The same address still works with `curl | bash`, and dorkos.ai/download now sends you there. The site's "Get started" button and homepage link to it.

### Fixed

- The dorkos.ai marketing pages and blog no longer break when your computer is set to dark mode. Before, the install commands on the homepage showed as dark text on a dark pill, and the blog's email signup box had a muddy gray fill. These pages are light by design; the docs keep their dark mode.
- Code examples in blog posts have their padding back, so commands no longer touch the edge of the box (a leftover from the docs engine upgrade).
- Release posts now get their Install / Update section from one shared template instead of hand-written copies in all 55 posts, so install guidance stays current everywhere.
- Blog dates no longer show one day early for readers west of UTC.
- Same-day releases now list in the right order on the blog (0.45.1 above 0.45.0).

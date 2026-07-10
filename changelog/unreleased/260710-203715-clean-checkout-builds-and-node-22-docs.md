### Fixed

- Building DorkOS from a fresh checkout now works on the first try. Before, the build command could kick off two overlapping builds of the CLI at once (the repo root and the CLI package shared the name `dorkos`), and they would trip over each other's files. The root project has its own name now, and the CLI declares the app packages it bundles, so everything builds in the right order (DOR-190)
- The docs, the install script, and the website now all say what the package actually requires: Node.js 22 or later. Before, they said "Node.js 18 or later," so following the docs on an older Node printed a wall of warnings during install (DOR-246)

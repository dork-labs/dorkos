### Fixed

- Fixed: DorkBot setup works when DorkOS is limited to a workspace folder. When you run DorkOS with agents scoped to a single folder (for example the Docker setup that pins agents to `/workspace`), the "Meet DorkBot" step no longer fails with an access-denied error. DorkOS's own agents — DorkBot and anything you install from the Marketplace — live in DorkOS's data folder, and agent actions now treat that folder as always allowed. Reading and writing your own project files stays limited to the folder you chose.

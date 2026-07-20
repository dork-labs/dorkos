### Added

- After you install a Shape, you can apply it straight away — the "Installed" toast now has an Apply button, and every Shape in your installed list has one too. Both open the Shape switcher, where the change actually happens. (#372)
- Your installed list now shows an "Active" badge on the Shape you're currently in, so you can tell at a glance which one is running. (#372)
- When a Shape offers you an agent, the switcher now spells out that agent's schedule in plain words (like "Every weekday at 9:00 AM") instead of leaving it unsaid. (#372)

### Fixed

- Fixed a case where a Shape's scheduled task — created while its agent didn't exist yet — would never switch on after you added the agent, if the task's name wasn't already lowercase-with-dashes. It now links up and starts running as intended. (#372)

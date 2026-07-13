### Added

- When you link this install to a DorkOS account, you can now also connect its anonymous usage counts to your account, so you can see them when you are signed in on dorkos.ai. It is off by default: a checkbox in the account-link flow (Settings, DorkOS account) turns it on right before you link. No new data is collected, and the `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` kill switches turn it off too. It only takes effect at link time, so if you turn it on after linking, the connection happens the next time you link.

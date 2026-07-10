### Fixed

- Signing in after `dorkos auth enable` now works on a fresh install. Before, turning on login and then signing in failed with a server error unless you happened to set a secret environment variable by hand — and nothing told you it was needed. DorkOS now creates and remembers that secret for you the first time you enable login, so sign-in just works. This also unblocks exposing your instance over a tunnel, which requires login first (DOR-242).

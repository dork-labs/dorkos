---
covers:
  - 'fix(cli): check the deployed community against the image Fly actually runs (DOR-2586)'
---

### Fixed

- Setting up your own community with `dorkos community deploy` no longer stops once your community is already up and running. The release names one bundle of images for several kinds of computer, and Fly runs the one for its own servers, so setup's final check compared the wrong fingerprint and gave up. Setup now works out which image Fly will run before it deploys, by reading the signed image bundle from the image registry, and checks against that (DOR-2586)

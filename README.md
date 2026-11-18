# #3968 shots at e43aae976d (DOR-4337, DOR-4572)

Dev Playground, Home, Inbox & Approvals → Schedule approval card. Mock transport,
made-up agents and paths, shot in a throwaway Playwright container with the
browser in America/Chicago, the schedules' own zone.

- `light-agent-proposal`, `dark-agent-proposal`, `390-light-agent-proposal`: an
  agent's own proposal. Name once in the header, byline "Proposed · …", no
  "Run permissions:" line beside the picker.
- `light-runs-as-other-agent`, `dark-runs-as-other-agent`,
  `390-dark-runs-as-other-agent`: proposed by DorkBot, runs as Scout, so
  "Agent: Scout" shows, with Scout's own folder.
- `390-light-phone-pinned-row`, `390-dark-phone-pinned-row`: the phone review
  sheet; the pinned row reads "Run permissions: Accept edits".

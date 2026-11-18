# DOR-4483 shots at 73ff3ddc2a

Dev Playground, Features → Schedules in your time. Mock data, browser in
America/Chicago, shot in a throwaway Playwright container.

- `light-row-today`, `dark-row-today`, `390-dark-row-today`: a run later today
  reads "Next 11:30 PM" (was "Next today 11:30 PM").
- `light-row-tomorrow`, `dark-row-tomorrow`, `390-light-row-tomorrow`: reads
  "Next tomorrow at 9:00 AM" (was "Next tomorrow 9:00 AM").

The Needs you card ("Next try …") reads the same as before.

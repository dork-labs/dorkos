---
covers:
  - 'feat(cloud-plan): show Cloud amounts in the unit the service serves'
---

### Changed

- Cloud usage in Settings › Access now shows in whole credits. Included credits and credits you bought show their money value beside them, what you have left is never rounded up, and anything under one credit shows as **<1** instead of zero. The upgrade suggestion shows your last 30 days in credits with their money value, and the plan price and the difference in money, so the sum adds up (DOR-2425)
- If your DorkOS account doesn't say what unit its figures are in, the panel says it couldn't read them rather than showing a number that might be wrong (DOR-2425)

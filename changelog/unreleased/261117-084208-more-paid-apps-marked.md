---
covers:
  - 'fix(connections): many more pay-per-use apps count as spending money, under their real names (DOR-4597)'
  - 'fix(connections): credit-metered apps with unclear pricing count as spending money too (DOR-4597)'
---

### Fixed

- **About 190 more connected apps now count as spending money, so their paid actions use your monthly limit and show the price card.** They include Gemini, Mistral AI, GroqCloud, Cohere, Bright Data and HeyGen, plus apps for AI models, speech, text messages, scraping, search results, people data and email checks. A Read or Read and write grant you gave before no longer runs their actions, and neither does an app shared with every agent. To let an agent use one, pick that action for that agent on the Connections page.

---
covers:
  - 'fix(connections): many more pay-per-use apps count as spending money, under their real names (DOR-4597)'
  - 'fix(connections): credit-metered apps with unclear pricing count as spending money too (DOR-4597)'
---

### Fixed

- **Many more apps that charge per use now count as spending money.** This adds about 190 apps for AI models, speech, text messages, scraping, search results, people data and email checks, including Gemini, Mistral AI, GroqCloud, Cohere, Bright Data and HeyGen. A Read or Read and write grant you gave before no longer runs their actions, and neither does an app shared with every agent. To let an agent use one, pick that action for that agent on the Connections page.

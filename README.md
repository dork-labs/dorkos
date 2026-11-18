# PR #3893 (DOR-4575) shots, head 53102a7146

Made-up data only (Price Watch, Ada Example, Acme Scraper). Each shot comes in four versions: light, dark, light-390 and dark-390 (390 px wide). The others are 1280 px wide. All at 2x.

- `access-page-*`: the real access page. Its HTML, CSS and script come straight from `decidePage` and the page assets at this head, for an Apify read with two actions.
- `refusal-no-limit-*` and `refusal-unknown-price-*`: the message text is the real one. The PR's own `ExtensionConnectionReader` returned it on a migrated in-memory database (no limit set; a limit set but no price). DorkOS draws no screen of its own for this refusal, because the message goes back to the mini app's code. So these show it inside a stand-in mini app frame, styled with the access page's CSS. The frame is made up; the words are not.

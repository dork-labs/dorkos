### Added

- Your agent can now take a screenshot of its own preview with the new `browser_screenshot` tool. This completes the preview feedback loop: after opening a page with `browser_navigate`, your agent can read its console errors, check its network requests, AND see the rendered page — so it catches a broken layout or a blank screen on its own, without you describing what it looks like (DOR-213)

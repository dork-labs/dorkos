### Fixed

- Generative UI widgets now accept the natural vocabulary agents use instead of failing the whole widget: a list item's status `badge` can be a plain string, a stack `direction` can be `"row"`/`"column"`, a button `variant` can be `"primary"`/`"danger"`, a chart can be a `"column"` or `"donut"`, a heading `level` can be `"2"`, a stat `delta` can be a bare `"+2°"`, and status tones like `"warn"`/`"ok"` map to the right color.
- Streaming widgets no longer flicker in and out of their loading skeleton — once a widget renders it stays put, even as the rest of the reply keeps streaming.

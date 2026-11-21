// @vitest-environment jsdom
/**
 * What host CSS an app's frame adopts (DOR-4872): every readable rule except
 * `@font-face`, since a frame's opaque origin can't load the app's font files.
 *
 * @module features/extensions/__tests__/frame-host-css
 */
import { describe, expect, it } from 'vitest';
import { hostCssForFrame } from '../frame/connection';

/** A stand-in stylesheet whose rules read back as `texts`. */
function sheet(texts: string[]): CSSStyleSheet {
  return { cssRules: texts.map((cssText) => ({ cssText })) } as unknown as CSSStyleSheet;
}

/** A stylesheet that throws on read, as a cross-origin one does. */
function crossOrigin(): CSSStyleSheet {
  return {
    get cssRules(): CSSRuleList {
      throw new DOMException('cross-origin', 'SecurityError');
    },
  } as unknown as CSSStyleSheet;
}

describe('hostCssForFrame', () => {
  // Purpose: the shipped default font's faces would each fail a CORS fetch in
  // the frame, so they stay out while every other rule goes in.
  it('copies every rule but @font-face', () => {
    const css = hostCssForFrame([
      sheet([
        "@font-face { font-family: Inter; src: url('/assets/inter-latin.woff2'); }",
        '.card { color: red; }',
      ]),
      sheet([':root { --font-sans: Inter; }']),
    ]);

    expect(css).not.toContain('@font-face');
    expect(css).toContain('.card { color: red; }');
    expect(css).toContain(':root { --font-sans: Inter; }');
  });

  it('skips a sheet it cannot read', () => {
    expect(hostCssForFrame([crossOrigin(), sheet(['.a { margin: 0; }'])])).toBe(
      '\n.a { margin: 0; }'
    );
  });
});

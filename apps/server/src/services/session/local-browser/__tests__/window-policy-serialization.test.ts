import { expect, it } from 'vitest';

it('serializes the window guard through the CLI keepNames build without host helpers', async () => {
  const { transformSync } = await import('esbuild');
  const { runInNewContext } = await import('node:vm');
  const { installWindowPolicy } = await import('../chat/window-policy.js');
  const output = transformSync(`globalThis.install = ${installWindowPolicy.toString()}`, {
    keepNames: true,
    target: 'es2022',
  }).code;
  const host: { install?: typeof installWindowPolicy } = {};
  runInNewContext(output, host);
  const browser = { open: () => null };
  expect(() =>
    runInNewContext(`(${host.install!.toString()})({ control: 'control', report: 'report' })`, {
      window: browser,
      document: { addEventListener: () => undefined },
    })
  ).not.toThrow();
});

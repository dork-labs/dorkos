/**
 * @vitest-environment node
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPENCODE_PIN, pinnedOpenCode } from './pinned-opencode.js';

/** The server package's manifest, which installs the binary. */
const serverPackage = JSON.parse(
  fs.readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')
) as { dependencies: Record<string, string>; optionalDependencies: Record<string, string> };

const HERE = `${process.platform}-${process.arch}`;

describe('the pinned OpenCode binary', () => {
  it('installs every pinned platform at exactly the pinned version, and nothing else', () => {
    const installed = Object.entries(serverPackage.optionalDependencies).filter(([name]) =>
      name.startsWith('opencode-')
    );
    expect(Object.fromEntries(installed)).toEqual(
      Object.fromEntries(
        Object.keys(OPENCODE_PIN.sha256).map((key) => [`opencode-${key}`, OPENCODE_PIN.version])
      )
    );
  });

  it('pins the CLI to the SDK’s version', () => {
    expect(serverPackage.dependencies['@opencode-ai/sdk']).toBe(`^${OPENCODE_PIN.version}`);
  });

  it('has nothing to run on a platform with no recorded hash', () => {
    expect(pinnedOpenCode('plan9', 'mips')).toBeNull();
  });

  // The real-binary tests skip where nothing is pinned. CI must never be such a
  // place, or they would stop running there without anyone noticing.
  it.runIf(process.env.CI)('finds a pinned binary on the CI runner', () => {
    expect(OPENCODE_PIN.sha256[HERE], `no OpenCode pin for ${HERE}`).toBeDefined();
    expect(pinnedOpenCode()).not.toBeNull();
  });

  it.skipIf(!OPENCODE_PIN.sha256[HERE])('hands back only a file whose bytes match the pin', () => {
    const binary = pinnedOpenCode()!;
    const actual = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    expect(actual).toBe(OPENCODE_PIN.sha256[HERE]);
  });
});

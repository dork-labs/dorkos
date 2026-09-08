import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHARED_PROVIDER_CONTRACT = 'packages/shared/src/connector-provider.ts';
const ORDINARY_CONNECTOR_ROOT = 'apps/server/src/services/connectors/';
const PUBLIC_CONNECTION_ID_FILES = [
  'apps/server/src/services/connectors/attachment-store.ts',
  'apps/server/src/services/connectors/connection-store.ts',
  'apps/server/src/services/connectors/registry.ts',
] as const;

const connectedAccountId = ['Connected', 'Account', 'Id'].join('');
const connectedAccountBinding = ['Connected', 'Account', 'Binding'].join('');
const legacyAccountProperty = ['account', 'Id'].join('');

/** List the live provider contract and ordinary connector runtime source from Git. */
function ordinaryConnectorSources(): string[] {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter((path) => path.length > 0 && existsSync(path));

  return files.filter(
    (path) =>
      path === SHARED_PROVIDER_CONTRACT ||
      (path.startsWith(ORDINARY_CONNECTOR_ROOT) &&
        !path.includes('/__tests__/') &&
        !path.startsWith(`${ORDINARY_CONNECTOR_ROOT}providers/`) &&
        path !== `${ORDINARY_CONNECTOR_ROOT}legacy-connection-migration.ts`)
  );
}

/** Find exact legacy exported identifiers without rejecting legitimate account nouns. */
function legacyIdentifier(source: string): string | undefined {
  return [connectedAccountId, `${connectedAccountId}Schema`, connectedAccountBinding].find((name) =>
    new RegExp(`\\b${name}\\b`).test(source)
  );
}

/** Detect the obsolete authority property on a public connection binding or override. */
function hasLegacyConnectionProperty(source: string): boolean {
  return new RegExp(`\\b${legacyAccountProperty}\\b`).test(source);
}

describe('connector legacy authority absence', () => {
  it('keeps compatibility aliases out of the shared contract and ordinary runtime', () => {
    const files = ordinaryConnectorSources();
    expect(files.length).toBeGreaterThan(40);

    const violations = files.flatMap((path) => {
      const identifier = legacyIdentifier(readFileSync(path, 'utf8'));
      return identifier ? [`${path}: ${identifier}`] : [];
    });
    expect(violations).toEqual([]);
  });

  it('uses connectionId on public bindings and session overrides', () => {
    expect(PUBLIC_CONNECTION_ID_FILES).toHaveLength(3);
    const violations = PUBLIC_CONNECTION_ID_FILES.filter((path) =>
      hasLegacyConnectionProperty(readFileSync(path, 'utf8'))
    );
    expect(violations).toEqual([]);
  });

  it('fails for either compatibility alias or the obsolete public property', () => {
    expect(legacyIdentifier(`export type ${connectedAccountId} = string;`)).toBe(
      connectedAccountId
    );
    expect(legacyIdentifier(`export type ${connectedAccountBinding} = {};`)).toBe(
      connectedAccountBinding
    );
    expect(
      hasLegacyConnectionProperty(`interface Override { ${legacyAccountProperty}: string }`)
    ).toBe(true);
    expect(hasLegacyConnectionProperty('interface Binding { externalAccountRef: string }')).toBe(
      false
    );
  });
});

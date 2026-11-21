import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type resolveWindowsCustodyArtifact,
  verifyWindowsCustodyArtifact,
} from '../run-custody/windows/artifact.mjs';

const sourceOrigin = 'packages/test-utils/native/windows-run-custody';
const sources = {
  'guardian.c': Buffer.from('fixture translation unit'),
  'protocol.h': Buffer.from('fixture header'),
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = {
  'guardian.c': digest(sources['guardian.c']),
  'protocol.h': digest(sources['protocol.h']),
};
const architectures = {
  x64: { machine: 0x8664, magic: 0x20b, optionalSize: 240 },
  arm64: { machine: 0xaa64, magic: 0x20b, optionalSize: 240 },
  ia32: { machine: 0x14c, magic: 0x10b, optionalSize: 224 },
};
type Architecture = keyof typeof architectures;

const pe = 0x80;
const optional = 0x98;

function fixtureImage(architecture: Architecture) {
  const { machine, magic, optionalSize } = architectures[architecture];
  // Only header bytes, with a nonzero buffer offset and no runnable code.
  const bytes = Buffer.alloc(8 + optional + optionalSize).subarray(8);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.write('PE\0\0', pe, 'ascii');
  bytes.writeUInt16LE(machine, pe + 4);
  bytes.writeUInt16LE(optionalSize, pe + 20);
  bytes.writeUInt16LE(2, pe + 22);
  bytes.writeUInt16LE(magic, optional);
  bytes.writeUInt16LE(3, optional + 68);
  return bytes;
}

function prepared(
  architecture: Architecture,
  artifact = fixtureImage(architecture),
  overrides: Record<string, unknown> = {}
) {
  const manifest = Buffer.from(
    JSON.stringify({
      origin: sourceOrigin,
      protocolVersion: 1,
      architecture,
      machine: architectures[architecture].machine,
      sourceSha256,
      artifactSha256: digest(artifact),
      compiler: 'fixture compiler version',
      sdk: 'fixture SDK version',
      ...overrides,
    })
  );
  return {
    manifest,
    artifact,
    expected: { architecture, protocolVersion: 1, manifestSha256: digest(manifest), sources },
  };
}

describe('private Windows custody artifact verification', () => {
  it.each(['x64', 'arm64', 'ia32'] as const)('binds the %s manifest to its PE bytes', (arch) => {
    const input = prepared(arch);
    expect(verifyWindowsCustodyArtifact(input)).toEqual({
      architecture: arch,
      machine: architectures[arch].machine,
      sha256: digest(input.artifact),
    });
  });

  it('requires the exact separately selected manifest bytes', () => {
    const input = prepared('x64');
    const manifest = Buffer.concat([input.manifest, Buffer.from('\n')]);
    expect(() => verifyWindowsCustodyArtifact({ ...input, manifest })).toThrow(/manifest digest/);
  });

  it('refuses invalid manifest text even when the selected digest matches', () => {
    const input = prepared('x64');
    const manifest = Buffer.of(0xff);
    expect(() =>
      verifyWindowsCustodyArtifact({
        ...input,
        manifest,
        expected: { ...input.expected, manifestSha256: digest(manifest) },
      })
    ).toThrow(/manifest is invalid/);
  });

  it.each([
    [{ origin: 'other/source' }, /source origin/],
    [{ protocolVersion: 2 }, /protocol and architecture/],
    [{ architecture: 'ia32' }, /protocol and architecture/],
    [{ machine: 0xaa64 }, /protocol and architecture/],
    [{ compiler: '' }, /compiler or SDK/],
    [{ sdk: null }, /compiler or SDK/],
  ] as const)(
    'rejects invalid manifest metadata %o despite a matching digest',
    (overrides, error) => {
      const input = prepared('x64', undefined, overrides);
      expect(() => verifyWindowsCustodyArtifact(input)).toThrow(error);
    }
  );

  it.each([
    { 'guardian.c': sourceSha256['guardian.c'] },
    { ...sourceSha256, 'extra.h': digest(Buffer.from('extra source')) },
    { ...sourceSha256, 'protocol.h': digest(Buffer.from('older header')) },
  ])('rejects a source set that differs from the expected inputs', (manifestSources) => {
    const input = prepared('x64', undefined, { sourceSha256: manifestSources });
    expect(() => verifyWindowsCustodyArtifact(input)).toThrow(/expected source files/);
  });

  it('refuses a selection without expected source inputs', () => {
    const input = prepared('x64', undefined, { sourceSha256: {} });
    expect(() =>
      verifyWindowsCustodyArtifact({ ...input, expected: { ...input.expected, sources: {} } })
    ).toThrow(/artifact selection/);
  });

  it('rejects changed binary bytes with an intact manifest', () => {
    const input = prepared('arm64');
    const artifact = Buffer.concat([input.artifact, Buffer.of(0)]);
    expect(() => verifyWindowsCustodyArtifact({ ...input, artifact })).toThrow(/binary digest/);
  });

  it.each([
    ['x64', 'arm64'],
    ['arm64', 'ia32'],
    ['ia32', 'x64'],
  ] as const)('rejects a %s selection whose hashed PE is %s', (expected, actual) => {
    const input = prepared(expected, fixtureImage(actual));
    expect(() => verifyWindowsCustodyArtifact(input)).toThrow(/PE architecture/);
  });

  it('rejects a claimed x64 PE with a 32-bit optional header', () => {
    const artifact = fixtureImage('x64');
    artifact.writeUInt16LE(0x10b, optional);
    expect(() => verifyWindowsCustodyArtifact(prepared('x64', artifact))).toThrow(
      /PE architecture/
    );
  });

  it('rejects invalid DOS and PE header locations despite a matching digest', () => {
    const noDosHeader = fixtureImage('x64').subarray(2);
    expect(() => verifyWindowsCustodyArtifact(prepared('x64', noDosHeader))).toThrow(/DOS header/);
    const artifact = fixtureImage('x64');
    artifact.writeUInt32LE(0xffffffff, 0x3c);
    expect(() => verifyWindowsCustodyArtifact(prepared('x64', artifact))).toThrow(/PE header/);
  });

  it('rejects truncated headers, DLLs and a non-console subsystem', () => {
    const artifact = fixtureImage('x64');
    const truncated = artifact.subarray(0, optional + 69);
    expect(() => verifyWindowsCustodyArtifact(prepared('x64', truncated))).toThrow(/console/);
    artifact.writeUInt16LE(2, optional + 68);
    expect(() => verifyWindowsCustodyArtifact(prepared('x64', artifact))).toThrow(/console/);
    const dll = fixtureImage('x64');
    dll.writeUInt16LE(0x2002, pe + 22);
    expect(() => verifyWindowsCustodyArtifact(prepared('x64', dll))).toThrow(/console/);
  });
});

const setupCommand = 'pnpm --filter @dorkos/test-utils build:run-custody:windows';
type ArtifactResolver = typeof resolveWindowsCustodyArtifact;

async function fixturePackage(
  architecture: Architecture,
  run: (fixture: {
    resolve: ArtifactResolver;
    selection: Parameters<ArtifactResolver>[0];
    root: string;
    sourceRoot: string;
    leaf: string;
    binary: string;
  }) => Promise<void>
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dork-windows-custody-'));
  try {
    const modulePath = join(root, 'src', 'run-custody', 'windows', 'artifact.mjs');
    await mkdir(dirname(modulePath), { recursive: true });
    await copyFile(new URL('../run-custody/windows/artifact.mjs', import.meta.url), modulePath);
    const { resolveWindowsCustodyArtifact: resolve } = (await import(
      /* @vite-ignore */ pathToFileURL(modulePath).href
    )) as typeof import('../run-custody/windows/artifact.mjs');
    const sourceRoot = join(root, 'native', 'windows-run-custody');
    const leaf = join(sourceRoot, 'dist', architecture);
    const binary = join(leaf, 'windows-run-custody.exe');
    await mkdir(leaf, { recursive: true });
    for (const [name, bytes] of Object.entries(sources)) {
      await writeFile(join(sourceRoot, name), bytes);
    }
    const input = prepared(architecture);
    await writeFile(binary, input.artifact);
    await writeFile(join(leaf, 'windows-run-custody.json'), input.manifest);
    await run({
      resolve,
      root,
      sourceRoot,
      leaf,
      binary,
      selection: {
        architecture,
        protocolVersion: input.expected.protocolVersion,
        manifestSha256: input.expected.manifestSha256,
        sourceFiles: Object.keys(sources),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('package-relative Windows custody artifact resolution', () => {
  it.each(['x64', 'arm64', 'ia32'] as const)(
    'reads the prepared %s helper relative to the imported package',
    async (arch) => {
      await fixturePackage(arch, async ({ resolve, selection, binary }) => {
        await expect(resolve(selection)).resolves.toEqual({
          path: binary,
          architecture: arch,
          machine: architectures[arch].machine,
          sha256: digest(fixtureImage(arch)),
        });
      });
    }
  );

  it('reports the setup command when only a different architecture is present', async () => {
    await fixturePackage('x64', async ({ resolve, selection }) => {
      await expect(resolve({ ...selection, architecture: 'arm64' })).rejects.toThrow(setupCommand);
    });
  });

  it('reports the setup command when an expected authored header is missing', async () => {
    await fixturePackage('x64', async ({ resolve, selection, sourceRoot }) => {
      await rm(join(sourceRoot, 'protocol.h'));
      await expect(resolve(selection)).rejects.toThrow(
        /authored input is missing.*build:run-custody:windows/
      );
    });
  });

  it('rejects a selected helper when its manifest pin, source or binary has changed', async () => {
    await fixturePackage('x64', async ({ resolve, selection, sourceRoot, binary }) => {
      await expect(resolve({ ...selection, manifestSha256: '0'.repeat(64) })).rejects.toThrow(
        /manifest digest.*build:run-custody:windows/
      );
      const header = join(sourceRoot, 'protocol.h');
      await writeFile(header, 'changed header');
      await expect(resolve(selection)).rejects.toThrow(
        /expected source files.*build:run-custody:windows/
      );
      await writeFile(header, sources['protocol.h']);
      await appendFile(binary, Buffer.of(0));
      await expect(resolve(selection)).rejects.toThrow(/binary digest.*build:run-custody:windows/);
    });
  });

  it('rejects unexpected authored paths and extra files beside the artifact', async () => {
    await fixturePackage('x64', async ({ resolve, selection, leaf }) => {
      for (const sourceFiles of [
        ['../outside.h'],
        ['C:/absolute.h'],
        ['native\\alias.h'],
        ['dist/x64/windows-run-custody.exe'],
        ['protocol.h', 'Protocol.h'],
      ]) {
        await expect(resolve({ ...selection, sourceFiles })).rejects.toThrow(/artifact selection/);
      }
      await writeFile(join(leaf, 'extra.txt'), 'fixture');
      await expect(resolve(selection)).rejects.toThrow(/exactly its binary and manifest/);
    });
  });

  it('refuses a linked architecture directory even when the target has the exact bytes', async () => {
    await fixturePackage('x64', async ({ resolve, selection, root, leaf }) => {
      const relocated = join(root, 'relocated');
      await rename(leaf, relocated);
      await symlink(relocated, leaf, 'junction');
      await expect(resolve(selection)).rejects.toThrow(/artifact directory is unexpected/);
    });
  });
});

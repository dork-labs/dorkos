import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { serializeEvidence, validateGateReceipt } from './contracts.mjs';

/** Write an exclusive bounded public receipt into an injected private artifact directory. */
export async function writeGateReceipt({ artifactDir, name, receipt }) {
  if (!isAbsolute(artifactDir) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.json$/.test(name)) {
    throw new TypeError(
      'Evidence requires an absolute artifact directory and a simple JSON filename.'
    );
  }
  validateGateReceipt(receipt);
  const serialized = serializeEvidence(receipt);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const outputPath = resolve(artifactDir, name);
  await writeFile(outputPath, serialized, { flag: 'wx', mode: 0o600 });
  return outputPath;
}

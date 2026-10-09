import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  copyBrowserVMRelease,
  copyBrowserVMModules,
} from '../../../scripts/browser-vm-release-copy.mjs';
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url))),
  output = join(root, 'apps/server/dist');
await copyBrowserVMModules(root, output);
await copyBrowserVMRelease(root, output);

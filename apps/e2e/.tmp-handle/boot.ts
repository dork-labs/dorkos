import path from 'path';
import { bootStack, buildServerDeps, preflightStack } from '../capture/boot.js';
import { CAPTURE_HOME, CLIENT_URL, API_URL } from '../capture/config.js';
import { prepareFilesystem, seedData } from '../capture/seed.js';
import { promises as fs } from 'fs';

async function main() {
  await preflightStack();
  await prepareFilesystem();
  const home = path.join(CAPTURE_HOME, 'home');
  await fs.mkdir(home, { recursive: true });
  await buildServerDeps();
  await bootStack({ isolatedHome: home });
  await seedData();
  console.log(`READY ${CLIENT_URL} ${API_URL}`);
  setInterval(() => {}, 60_000);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

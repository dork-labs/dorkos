import fs from 'node:fs';
import path from 'node:path';

/** Seed an explicit owner policy in a test's private app home, never a real account. */
export function seedSigninPolicyFixture(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'account-signin-policy.json'),
    JSON.stringify({
      deniedOrganizations: [
        { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', label: 'Excluded fixture' },
      ],
      folders: [],
      bindings: {},
    })
  );
}

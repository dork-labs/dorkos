import { guestRecipe, type GuestRecipeOptions } from '../guest/guest-recipe.js';

/** Render an isolated VZ configuration with no host mounts or implicit port exposure. */
export function limaConfiguration(
  options: GuestRecipeOptions & { imagePath: string; opencodePort: number; desktopPort: number }
): string {
  const provision = guestRecipe(options)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return `vmType: vz
arch: aarch64
cpus: 2
memory: 4GiB
disk: 24GiB
images:
  - location: ${JSON.stringify(options.imagePath)}
    arch: aarch64
mounts: []
mountInotify: false
propagateProxyEnv: false
containerd:
  system: false
  user: false
user:
  name: lima-admin
  uid: 1000
  home: /home/lima-admin
  shell: /bin/bash
  passwordlessSudo: true
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
  forwardX11: false
hostResolver:
  enabled: true
  ipv6: false
portForwards:
  - guestPort: 4096
    hostPort: ${options.opencodePort}
    hostIP: 127.0.0.1
  - guestPort: 6080
    hostPort: ${options.desktopPort}
    hostIP: 127.0.0.1
  - guestPortRange: [1, 65535]
    guestIP: 0.0.0.0
    proto: any
    ignore: true
provision:
  - mode: system
    script: |
${provision}
`;
}

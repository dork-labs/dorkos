import { DESKTOP_HELPER } from './desktop-helper.js';
import { OPENCODE_ARTIFACT } from '../backend/artifact-pins.js';

/** Host bootstrap policy; credentials are generated only inside the root-owned guest. */
export interface GuestRecipeOptions {
  bridgePort?: number;
}
/** Build the trusted root bootstrap; no caller-provided shell source enters it. */
export function guestRecipe(options: GuestRecipeOptions): string {
  if (
    options.bridgePort !== undefined &&
    (!Number.isInteger(options.bridgePort) ||
      options.bridgePort < 1024 ||
      options.bridgePort > 65535)
  )
    throw new Error('Invalid bridge port');
  const helper = Buffer.from(DESKTOP_HELPER).toString('base64');
  return `#!/bin/bash
set +x
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive
if [ -f /etc/dorkos-computer/provisioned ]; then exit 0; fi
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources
cat > /etc/apt/sources.list.d/dorkos-snapshot.list <<'APT'
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261002T000000Z/ trixie main
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261002T000000Z/ trixie-security main
APT
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git nodejs python3 chromium xvfb openbox xterm xdotool xauth imagemagick nftables dbus-x11
id -u agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
id -u desktop >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin desktop
chmod 700 /home/agent /home/desktop /home/lima-admin
systemctl mask "user@$(id -u desktop).service"
systemctl mask "user@$(id -u agent).service"
if [ -x /usr/bin/crontab ]; then printf 'agent\n' >> /etc/cron.deny; fi
printf 'agent\n' >> /etc/at.deny
install -d -m 700 /etc/dorkos-computer /home/agent/project /home/agent/.config/opencode /home/desktop/.config/chromium
/usr/bin/python3 - <<'SECRETS'
import json,secrets,pathlib,os
root=pathlib.Path('/etc/dorkos-computer')
for name in ['desktop-token','agent-token','opencode-token']:
 p=root/name
 if not p.exists():
  p.write_text(secrets.token_hex(32)); p.chmod(0o600)
(root/'opencode.env').write_text('OPENCODE_SERVER_PASSWORD='+ (root/'opencode-token').read_text()+'\\n')
config={'mcp':{'computer':{'type':'remote','url':'http://127.0.0.1:6080/mcp','headers':{'Authorization':'Bearer '+(root/'agent-token').read_text()},'enabled':True}}}
pathlib.Path('/home/agent/.config/opencode/opencode.json').write_text(json.dumps(config))
SECRETS
chmod 600 /etc/dorkos-computer/*
echo '${helper}' | base64 -d > /usr/local/lib/dorkos-desktop.py
chmod 600 /usr/local/lib/dorkos-desktop.py
cat > /usr/local/sbin/dorkos-computer-credentials <<'CREDENTIALS'
#!/usr/bin/python3
import json,pathlib
p=pathlib.Path('/etc/dorkos-computer')
print(json.dumps({'desktopPassword':(p/'desktop-token').read_text(),'opencodePassword':(p/'opencode-token').read_text()}))
CREDENTIALS
chmod 700 /usr/local/sbin/dorkos-computer-credentials
install -d -m 755 /usr/local/share/dorkos-login/home /usr/local/share/dorkos-login/config/opencode /usr/local/share/dorkos-login/work
printf '{"plugin":[]}\\n' > /usr/local/share/dorkos-login/config/opencode/opencode.json
chmod 644 /usr/local/share/dorkos-login/config/opencode/opencode.json
install -d -m 700 /home/agent/.cache/dorkos-login /home/agent/.local/state/dorkos-login /home/agent/.local/share
cat > /usr/local/sbin/dorkos-vendor-login <<'LOGIN'
#!/bin/sh
exec /usr/sbin/runuser -u agent -- /usr/bin/env -i -C /usr/local/share/dorkos-login/work HOME=/usr/local/share/dorkos-login/home USER=agent PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color XDG_CONFIG_HOME=/usr/local/share/dorkos-login/config XDG_DATA_HOME=/home/agent/.local/share XDG_CACHE_HOME=/home/agent/.cache/dorkos-login XDG_STATE_HOME=/home/agent/.local/state/dorkos-login OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_PURE=1 /usr/local/bin/opencode --pure auth login
LOGIN
chmod 755 /usr/local/sbin/dorkos-vendor-login
printf 'desktop ALL=(root) NOPASSWD: /usr/local/sbin/dorkos-vendor-login ""\\n' > /etc/sudoers.d/dorkos-vendor-login
chmod 440 /etc/sudoers.d/dorkos-vendor-login
/usr/sbin/visudo -cf /etc/sudoers.d/dorkos-vendor-login
cookie=$(/usr/bin/python3 -c 'import secrets; print(secrets.token_hex(16))')
/usr/bin/xauth -f /home/desktop/.Xauthority add :0 . "$cookie"
chmod 600 /home/desktop/.Xauthority
chown desktop:desktop /home/desktop/.Xauthority
install -d -m 755 /etc/dorkos-desktop
cat > /etc/dorkos-desktop/rc.xml <<'OPENBOX'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc"><keyboard/><mouse/><menu><file>/etc/dorkos-desktop/menu.xml</file></menu></openbox_config>
OPENBOX
printf '<openbox_menu xmlns="http://openbox.org/3.4/menu"/>\\n' > /etc/dorkos-desktop/menu.xml
chmod 644 /etc/dorkos-desktop/*
curl --fail --location --proto '=https' --proto-redir '=https' --max-time 300 '${OPENCODE_ARTIFACT.url}' -o /tmp/dorkos-opencode.tar.gz
echo '${OPENCODE_ARTIFACT.sha256}  /tmp/dorkos-opencode.tar.gz' | sha256sum --check --status
tar -xzf /tmp/dorkos-opencode.tar.gz -C /usr/local/bin opencode
chmod 755 /usr/local/bin/opencode
rm /tmp/dorkos-opencode.tar.gz
cat > /etc/nftables.conf <<'NFT'
#!/usr/sbin/nft -f
flush ruleset
table inet dorkos_computer {
 chain output {
  type filter hook output priority 0; policy accept;
  meta nfproto ipv6 reject
  ip daddr 127.0.0.0/8 accept
  ct state established,related accept
  udp sport 68 udp dport 67 ip daddr { 192.168.5.2, 255.255.255.255 } accept
  ip daddr 192.168.5.2 udp dport 53 accept
  ip daddr 192.168.5.2 tcp dport 53 accept
  ${options.bridgePort ? `ip daddr 192.168.5.2 tcp dport ${options.bridgePort} accept` : ''}
  ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } reject
 }
 chain input {
  type filter hook input priority 0; policy drop;
  meta nfproto ipv6 reject
  iifname "lo" accept
  ct state established,related accept
  tcp dport 22 accept
  udp sport 67 udp dport 68 accept
 }
}
NFT
systemctl enable --now nftables
cat > /etc/systemd/system/dorkos-display.service <<'UNIT'
[Unit]
After=network.target
[Service]
User=desktop
Environment=HOME=/home/desktop
ExecStart=/usr/bin/Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -auth /home/desktop/.Xauthority
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dorkos-desktop.service <<'UNIT'
[Unit]
Requires=dorkos-display.service
After=dorkos-display.service
[Service]
User=desktop
Environment=DISPLAY=:0 HOME=/home/desktop XAUTHORITY=/home/desktop/.Xauthority
ExecStart=/usr/bin/openbox --config-file /etc/dorkos-desktop/rc.xml
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dorkos-chromium.service <<'UNIT'
[Unit]
Requires=dorkos-display.service nftables.service
After=dorkos-desktop.service nftables.service
[Service]
User=desktop
Environment=DISPLAY=:0 HOME=/home/desktop XAUTHORITY=/home/desktop/.Xauthority
ExecStart=/usr/bin/chromium --no-first-run --disable-dev-shm-usage --password-store=basic --user-data-dir=/home/desktop/.config/chromium about:blank
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dorkos-opencode.service <<'UNIT'
[Unit]
After=network-online.target nftables.service
Requires=nftables.service
[Service]
User=agent
NoNewPrivileges=yes
WorkingDirectory=/home/agent/project
Environment=HOME=/home/agent DISPLAY=:0
EnvironmentFile=/etc/dorkos-computer/opencode.env
ExecStart=/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dorkos-computer-helper.service <<'UNIT'
[Unit]
Requires=dorkos-display.service nftables.service
After=dorkos-display.service nftables.service
[Service]
ExecStart=/usr/bin/python3 /usr/local/lib/dorkos-desktop.py
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
chown -R agent:agent /home/agent
chown -R desktop:desktop /home/desktop
# Provisioning source contains no credentials. Hide retained cloud-init copies as well.
find /var/lib/cloud -type f -exec chmod go-rwx {} +
chmod 600 /var/log/cloud-init*.log
systemctl daemon-reload
systemctl enable --now dorkos-display dorkos-desktop dorkos-chromium dorkos-opencode dorkos-computer-helper
touch /etc/dorkos-computer/provisioned
`;
}

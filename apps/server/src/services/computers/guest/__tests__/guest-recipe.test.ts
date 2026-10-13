import { describe, expect, it } from 'vitest';
import { guestRecipe } from '../guest-recipe.js';
import { limaConfiguration } from '../../backend/lima-config.js';
import { DESKTOP_HELPER } from '../desktop-helper.js';
import { execFileSync } from 'node:child_process';
const credentials = {
  opencodePassword: 'a'.repeat(64),
  desktopPassword: 'b'.repeat(64),
  agentToken: 'c'.repeat(64),
};

describe('isolated guest recipe', () => {
  it('disables mounts, host keys, SSH forwarding and implicit port forwarding', () => {
    const config = limaConfiguration({
      ...credentials,
      imagePath: '/private/image',
      opencodePort: 55001,
      desktopPort: 55002,
    });
    expect(config).toContain('mounts: []');
    expect(config).toContain('loadDotSSHPubKeys: false');
    expect(config).toContain('forwardAgent: false');
    expect(config).toContain('propagateProxyEnv: false');
    expect(config).toContain('hostIP: 127.0.0.1');
    expect(config).toContain('ignore: true');
    expect(config).not.toContain('hostIP: 0.0.0.0');
  });
  it('denies private, metadata and IPv6 paths and scopes the optional bridge', () => {
    const script = guestRecipe({ ...credentials, bridgePort: 6543 });
    expect(script).toContain('meta nfproto ipv6 reject');
    expect(script).toContain('ip daddr 192.168.5.2 udp dport 53 accept');
    expect(script).toContain('ct state established,related accept');
    expect(script).not.toContain('192.168.5.3');
    expect(script).toContain(
      'udp sport 68 udp dport 67 ip daddr { 192.168.5.2, 255.255.255.255 } accept'
    );
    expect(script).toContain('set +x');
    expect(script).toContain('chmod 600 /var/log/cloud-init*.log');
    expect(script).toContain('169.254.0.0/16');
    expect(script).toContain('ip daddr 192.168.5.2 tcp dport 6543 accept');
    expect(guestRecipe({})).not.toContain('ip daddr 192.168.5.2 tcp dport 6543');
    expect(script).toContain('User=agent');
    expect(script).toContain('NoNewPrivileges=yes');
    expect(script).not.toContain('--no-sandbox');
    expect(script).toContain('User=desktop');
    expect(script).toContain('-auth /home/desktop/.Xauthority');
    expect(script).not.toContain('--remote-debugging-port');
    expect(script).toContain('openbox --config-file /etc/dorkos-desktop/rc.xml');
    expect(script).toContain('OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_PURE=1');
    expect(script).toContain('/usr/local/bin/opencode --pure auth login');
    expect(script).toContain('HOME=/usr/local/share/dorkos-login/home');
    expect(script).toContain('XDG_CONFIG_HOME=/usr/local/share/dorkos-login/config');
    expect(script).toContain('XDG_DATA_HOME=/home/agent/.local/share');
    expect(script).toContain('-C /usr/local/share/dorkos-login/work');
  });
  it('refuses shell injection in generated configuration', () => {
    expect(guestRecipe({})).not.toContain(credentials.desktopPassword);
    expect(() => guestRecipe({ ...credentials, bridgePort: NaN })).toThrow('bridge');
  });
  it('guest helper compiles and enforces agent takeover fencing and held input release', () => {
    const source = DESKTOP_HELPER.slice(
      0,
      DESKTOP_HELPER.lastIndexOf("ThreadingHTTPServer(('127.0.0.1'")
    )
      .replace(
        "with open('/etc/dorkos-computer/desktop-token') as f: HOST_TOKEN=f.read().strip()",
        "HOST_TOKEN='host'"
      )
      .replace(
        "with open('/etc/dorkos-computer/agent-token') as f: AGENT_TOKEN=f.read().strip()",
        "AGENT_TOKEN='agent'"
      );
    const test = `${source}\ncommands=[]\ncommand=lambda args: commands.append(args) or b''\nlease='person-control'\nh=object.__new__(Handler)\nresults=[]\nh.respond=lambda code,body,kind=None: results.append((code,body))\nh.mcp({'id':1,'method':'tools/call','params':{'name':'computer_input','arguments':{'kind':'key','key':'Return'}}})\nassert results[0][1]['result']['isError'] is True\nassert commands==[]\nlease=None\ninput_event({'kind':'key','action':'down','key':'Control'})\ninput_event({'kind':'pointer','action':'down','x':100,'y':200,'button':1})\nrelease()\ninput_event({'kind':'pointer','action':'down','x':10,'y':20,'button':0},person=True)\ninput_event({'kind':'key','action':'down','key':'@'},person=True)\ninput_event({'kind':'key','action':'down','key':'PageDown'},person=True)\nrelease()\nassert ['/usr/bin/xdotool','mousedown','1'] in commands\nassert ['/usr/bin/xdotool','keydown','at'] in commands\nassert ['/usr/bin/xdotool','keydown','Page_Down'] in commands\nassert not held\nlease='expired-person'; lease_deadline=0.0\nsubprocess.run=lambda *args,**kwargs: None\nheld.add('Control_L')\nexpire_once(1.0)\nassert lease is None and not held\nimport io\nlease='person-control-lease'; generation=3; lease_deadline=0; held.add('Control_L')\nrequest={'held':True,'leaseId':lease,'generation':3}\nraw=json.dumps(request).encode()\nh.path='/control'; h.headers={'Authorization':'Bearer host','Content-Length':str(len(raw))}; h.rfile=io.BytesIO(raw)\nh.do_POST()\nassert held=={'Control_L'} and lease_deadline>time.monotonic()\nrelease()\nassert ['/usr/bin/xdotool','keyup','Control_L'] in commands\nassert ['/usr/bin/xdotool','mouseup','1'] in commands\n`;
    expect(() => execFileSync('/usr/bin/python3', ['-c', test], { timeout: 5000 })).not.toThrow();
  });
});

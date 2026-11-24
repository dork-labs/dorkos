import { ISOLATED, IN_PROCESS, HOME, COPY_PATH, copy, agentApproval } from './harness.js';
import { describe, expect, it } from 'vitest';
import { type ExtensionManifest } from '@dorkos/extension-api';
import { grantsDigestOf, keepsPathTrust } from '../../extension-path-trust.js';
import { mayRunExtensionCode, type ExtensionApprovals } from '../../../extension-load-policy.js';
import { approvalFor } from '../../extension-content-pin.js';

describe('path trust for an agent’s own isolated extension (conditions 1 to 3)', () => {
  it('lets an isolated extension inside its author’s folder run after an edit', () => {
    const edited = copy({ currentDigest: `sha256:${'9'.repeat(64)}` });
    expect(mayRunExtensionCode(edited, agentApproval())).toBe(true);
  });

  it('refuses it once a tool it gives agents moves to a lower tier', () => {
    const tool = { name: 'wipe', description: 'Delete the notes', tier: 'destructive' as const };
    const approvedWith = { ...ISOLATED, tools: [tool] } as ExtensionManifest;
    const lowered = copy({
      manifest: { ...approvedWith, tools: [{ ...tool, tier: 'observe' }] } as ExtensionManifest,
    });
    expect(mayRunExtensionCode(copy({ manifest: approvedWith }), agentApproval(approvedWith))).toBe(
      true
    );
    expect(mayRunExtensionCode(lowered, agentApproval(approvedWith))).toBe(false);
  });

  it('refuses it once a declared grant changes, until a person approves again', () => {
    const widened = copy({
      manifest: {
        ...ISOLATED,
        serverCapabilities: {
          ...ISOLATED.serverCapabilities!,
          allow: { net: ['api.example.com'], run: ['git'], agents: false },
        },
      },
    });
    expect(mayRunExtensionCode(widened, agentApproval())).toBe(false);
    // A secret is a grant too, though it is not in the permission set.
    const withSecret = copy({
      manifest: {
        ...ISOLATED,
        serverCapabilities: {
          ...ISOLATED.serverCapabilities!,
          secrets: [{ key: 'token', label: 'Token' }],
        },
      } as ExtensionManifest,
    });
    expect(mayRunExtensionCode(withSecret, agentApproval())).toBe(false);
    // Re-approved for what it declares now, it runs again.
    expect(
      mayRunExtensionCode(widened, {
        ...agentApproval(widened.manifest),
        approvedPermissions: {
          notes: { runtime: 'subprocess', net: ['api.example.com'], run: ['git'], agents: false },
        },
      })
    ).toBe(true);
  });

  it('pins an extension that runs inside DorkOS (condition 1)', () => {
    const inProcess = copy({ manifest: IN_PROCESS });
    expect(keepsPathTrust(inProcess, agentApproval(IN_PROCESS).approvedSources!.notes!)).toBe(
      false
    );
    expect(mayRunExtensionCode(inProcess, agentApproval(IN_PROCESS))).toBe(false);
  });

  it('pins a copy whose folder is a link out of its author’s folder (condition 3)', () => {
    const linkedOut = copy({ realPath: '/elsewhere/notes' });
    expect(mayRunExtensionCode(linkedOut, agentApproval())).toBe(false);
  });

  it('pins a copy that sits in another agent’s folder (condition 3)', () => {
    const other = copy({
      path: '/work/agent-b/.dork/extensions/notes',
      realPath: '/work/agent-b/.dork/extensions/notes',
    });
    const approvals = agentApproval();
    approvals.approvedSources!.notes = {
      ...approvals.approvedSources!.notes!,
      path: other.path,
    };
    expect(mayRunExtensionCode(other, approvals)).toBe(false);
  });

  it('pins a copy a person approved by hand: no author is “from outside” (condition 4)', () => {
    const byHand: ExtensionApprovals = {
      ...agentApproval(),
      approvedSources: { notes: { path: COPY_PATH, grants: grantsDigestOf(ISOLATED) } },
    };
    expect(mayRunExtensionCode(copy(), byHand)).toBe(false);
  });

  it('never gives path trust to a plugin copy', () => {
    const plugin = copy({ sourcePlugin: 'notes-plugin' });
    const approvals = agentApproval();
    approvals.approvedSources!.notes = {
      ...approvals.approvedSources!.notes!,
      plugin: 'notes-plugin',
    };
    expect(mayRunExtensionCode(plugin, approvals)).toBe(false);
  });

  it('writes no digest for a copy that keeps path trust, and one for anything else', () => {
    const digest = `sha256:${'3'.repeat(64)}`;
    expect(approvalFor(copy(), { digest, authorHome: HOME })).not.toHaveProperty('digest');
    expect(approvalFor(copy({ manifest: IN_PROCESS }), { digest, authorHome: HOME })).toMatchObject(
      {
        digest,
      }
    );
    expect(approvalFor(copy(), { digest })).toMatchObject({ digest });
    // Pinned, with nothing to pin to: no approval at all.
    expect(approvalFor(copy(), { digest: null })).toBeNull();
  });

  it('requires readable files when constructing an approval for authored code', () => {
    expect(approvalFor(copy(), { digest: null, authorHome: HOME })).toBeNull();
  });

  it('keeps the explicit development-link path approval', () => {
    expect(approvalFor(copy({ devLink: { path: COPY_PATH } }), { digest: null })).not.toBeNull();
  });
});

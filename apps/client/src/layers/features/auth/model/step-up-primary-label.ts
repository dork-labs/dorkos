/** Primary words for each confirmed action, shared by the existing sheet. */
import type { StepUpActionKind } from '@dorkos/shared/step-up';

const LABELS: Partial<Record<StepUpActionKind, string>> = {
  'connection.confirm-setting': 'Confirm setting',
  'connection.use-setting': 'Allow sending',
  'api-key.create': 'Create key',
  'api-key.update': 'Save key',
  'remote-access.enrolment': 'Turn on',
  'remote-access.mode': 'Turn on',
  'tunnel.start': 'Turn on',
  'lan-access.enable': 'Turn on',
  'config.front-door': 'Save',
  'mcp-token.reveal': 'Show token',
  'mcp-token.rotate': 'Replace token',
  'session-relay.link': 'Create link',
  'session-relay.level': 'Allow',
  'session-relay.resume': 'Resume',
  'relay-passkey.enrol': 'Add passkey',
  'extensions.trust-source': 'Trust source',
  'cloud.link': 'Link account',
  'cloud.billing': 'Confirm',
  'cloud.delete': 'Request deletion',
  'cloud.export': 'Export',
  'cloud.seats': 'Assign seat',
  'cloud.credits': 'Use credits',
  'cloud.space': 'Continue',
  'devices.sign-out-one': 'Sign it out',
  'devices.sign-out-others': 'Sign out others',
  'devices.sign-out-all': 'Sign out everywhere',
};

/** The sheet button's action, using the designer's names for guarded writes. */
export function primaryLabel(kind: StepUpActionKind | undefined): string {
  return (kind && LABELS[kind]) || 'Confirm';
}

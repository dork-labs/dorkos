import { TextDecoder } from 'node:util';
const refuse = (code) => new Error(code);
export function parseHypervisorEntitlements(raw) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'com.apple.security.hypervisor' ||
    value['com.apple.security.hypervisor'] !== true
  )
    throw refuse('DEVELOPER_ENTITLEMENTS');
  return Object.freeze({ 'com.apple.security.hypervisor': true });
}

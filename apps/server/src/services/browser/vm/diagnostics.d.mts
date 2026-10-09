type DiagnosticSummary = ReturnType<BrowserLifecycleEngine['diagnostics']>;
import type { BrowserBinding, BrowserLifecycleEngine } from '@dorkos/browser';
export interface GuestDiagnostic {
  event: 'diagnostic-observed';
  tabId: string;
  category: 'console' | 'error' | 'network' | 'lifecycle';
  severity?: 'debug' | 'info' | 'warning' | 'error' | 'unknown';
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'other' | 'unknown';
  resource?:
    'document' | 'script' | 'style' | 'image' | 'font' | 'fetch' | 'media' | 'other' | 'unknown';
  status?: 'informational' | 'success' | 'redirect' | 'clientError' | 'serverError' | 'unknown';
  duration?: 'under100ms' | 'under1s' | 'under10s' | 'atLeast10s' | 'unknown';
}
export interface GuestDiagnosticLoss {
  event: 'diagnostic-loss';
  tabId: string;
  dropped: number;
  correlationDropped: number;
}
export function validateOriginalGuestDiagnostic(
  value: unknown
): GuestDiagnostic | GuestDiagnosticLoss;
export interface VMDiagnosticsOwner {
  observe(value: GuestDiagnostic | GuestDiagnosticLoss): void;
  clear(): void;
  summary(binding: BrowserBinding): DiagnosticSummary;
  retire(): void;
}
export function createOriginalVMDiagnostics(): Readonly<{ open(): VMDiagnosticsOwner }>;

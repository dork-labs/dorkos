import QRCode from 'react-qr-code';
import { cn } from '@/layers/shared/lib';

/** Props for {@link TunnelQrCode}. */
export interface TunnelQrCodeProps {
  /** The public tunnel URL the code encodes. */
  url: string;
  /** Edge length in CSS pixels. */
  size?: number;
  /** Extra classes for the white plate behind the code. */
  className?: string;
}

/**
 * The tunnel address as a QR code, on the white plate a scanner needs.
 *
 * **The plate is white in both themes on purpose.** A QR reader wants dark
 * modules on a light field; drawn on a dark surface the contrast inverts and
 * many phone cameras simply stop seeing it. So this is the one place in the app
 * that pins a literal white rather than reading a surface token.
 *
 * Shared by the Remote Access dialog and the beacon's flyout (DOR-1743) — one
 * code, one size vocabulary, one error-correction level, so the thing a person
 * scans from their phone is identical wherever they found it.
 */
export function TunnelQrCode({ url, size = 180, className }: TunnelQrCodeProps) {
  return (
    <div className={cn('flex justify-center rounded-lg bg-white p-4', className)}>
      <QRCode value={url} size={size} level="M" />
    </div>
  );
}

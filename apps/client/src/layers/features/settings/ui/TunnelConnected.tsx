import { useState } from 'react';
import QRCode from 'react-qr-code';
import { Check, Copy, Link, QrCode } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { latencyColor } from '../lib/tunnel-utils';

/** Props for the connected view showing URL sharing and QR code. */
export interface TunnelConnectedProps {
  url: string;
  activeSessionId: string | null;
  latencyMs: number | null;
}

/** URL card spring entrance — scale 0.98→1, snappy spring. */
const urlCardVariants = {
  initial: { scale: 0.98, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
} as const;

/** Spring transition for the URL card entrance. */
const urlCardTransition = { type: 'spring', stiffness: 400, damping: 28 } as const;

/** Latency text fades in after 500ms — appears once the tunnel has settled. */
const latencyVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
} as const;

/** Delayed fade transition for latency display. */
const latencyTransition = { duration: 0.3, delay: 0.5 } as const;

/** QR expand animation for inline toggle. */
const qrExpandVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/** Transition for QR expand. */
const qrExpandTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

/** Connected view — URL is the hero, QR behind a toggle, three action buttons. */
export function TunnelConnected({ url, activeSessionId, latencyMs }: TunnelConnectedProps) {
  const [urlCopied, copyUrl] = useCopyFeedback();
  const [sessionCopied, copySession] = useCopyFeedback();
  const [showQr, setShowQr] = useState(false);

  const sessionUrl = activeSessionId ? `${url}?session=${activeSessionId}` : null;

  return (
    <div data-testid="tunnel-connected" className="space-y-3">
      {/* Hero: URL card with latency badge */}
      <motion.div
        className="bg-muted/30 rounded-lg border border-green-500/20 p-3"
        variants={urlCardVariants}
        initial="initial"
        animate="animate"
        transition={urlCardTransition}
      >
        {/* URL + latency row */}
        <div className="flex items-center gap-2">
          <span
            className={cn('inline-block size-1.5 shrink-0 rounded-full', latencyColor(latencyMs))}
            aria-label={latencyMs !== null ? `${latencyMs}ms latency` : 'Latency unknown'}
          />
          <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {url.replace(/^https?:\/\//, '')}
          </span>
          <AnimatePresence>
            {latencyMs !== null && (
              <motion.span
                className="text-muted-foreground shrink-0 text-xs"
                variants={latencyVariants}
                initial="initial"
                animate="animate"
                transition={latencyTransition}
              >
                {latencyMs}ms
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Three action buttons */}
        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
            onClick={() => copyUrl(url)}
          >
            {urlCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {urlCopied ? 'Copied' : 'Copy URL'}
          </Button>

          {sessionUrl && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={() => copySession(sessionUrl)}
            >
              {sessionCopied ? <Check className="size-3" /> : <Link className="size-3" />}
              {sessionCopied ? 'Copied' : 'Session link'}
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowQr((prev) => !prev)}
            aria-label="Toggle QR code"
            className={cn(showQr && 'bg-accent')}
          >
            <QrCode className="size-3.5" />
          </Button>
        </div>
      </motion.div>

      {/* QR code — expandable, not always visible */}
      <AnimatePresence>
        {showQr && (
          <motion.div
            key="qr-expand"
            variants={qrExpandVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={qrExpandTransition}
            className="overflow-hidden"
          >
            <div className="flex justify-center rounded-lg bg-white p-4">
              <QRCode value={url} size={180} level="M" />
            </div>
            <p className="text-muted-foreground mt-2 text-center text-xs">Scan from any device</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

'use client';

import { motion } from 'motion/react';
import { findIntegration, integrationLayoutId, type IntegrationId } from './integrations';
import { POP } from './motion-tokens';

/** In-message app icon; shares a layout id with its dock slot so it flies in. */
export function IntegrationBadge({ id }: { id: IntegrationId }) {
  const integration = findIntegration(id);
  if (!integration) return null;
  return (
    <motion.span
      layoutId={integrationLayoutId(integration.id)}
      transition={POP}
      className="mr-1.5 inline-grid size-5 shrink-0 place-items-center rounded-md align-text-bottom"
      style={{ backgroundColor: `${integration.color}22`, color: integration.color }}
    >
      <integration.Icon size={12} />
    </motion.span>
  );
}

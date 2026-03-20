'use client';

import { motion } from 'motion/react';
import { REVEAL, VIEWPORT } from '../lib/motion-variants';

/** Stylized browser-frame mock of the DorkOS console — answers "what does this look like?" */
export function ConsoleMockup() {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={REVEAL}
      className="hidden overflow-hidden rounded-lg lg:block"
      style={{
        border: '1px solid rgba(139, 90, 43, 0.12)',
        background: '#FFFEFB',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(139,90,43,0.06)',
      }}
    >
      {/* Browser chrome */}
      <div
        className="flex items-center gap-1.5 px-3 py-2"
        style={{ background: '#F5F0E6', borderBottom: '1px solid rgba(139, 90, 43, 0.08)' }}
      >
        <div className="h-2 w-2 rounded-full" style={{ background: 'rgba(232, 93, 4, 0.3)' }} />
        <div className="h-2 w-2 rounded-full" style={{ background: 'rgba(139, 90, 43, 0.15)' }} />
        <div className="h-2 w-2 rounded-full" style={{ background: 'rgba(139, 90, 43, 0.15)' }} />
        <span className="text-warm-gray-light ml-2 font-mono text-[9px] tracking-[0.06em]">
          localhost:4242
        </span>
      </div>

      {/* Console layout */}
      <div className="flex" style={{ height: 140 }}>
        {/* Mini sidebar */}
        <div
          className="w-[120px] shrink-0 space-y-1.5 px-2 py-2"
          style={{ borderRight: '1px solid rgba(139, 90, 43, 0.08)', background: '#FAF7F0' }}
        >
          <div
            className="truncate rounded px-2 py-1 font-mono text-[9px]"
            style={{ background: 'rgba(232, 93, 4, 0.06)', color: '#E85D04' }}
          >
            refactor-auth
          </div>
          <div className="text-warm-gray-light truncate rounded px-2 py-1 font-mono text-[9px]">
            test-coverage
          </div>
          <div className="text-warm-gray-light truncate rounded px-2 py-1 font-mono text-[9px]">
            dep-upgrade
          </div>
        </div>

        {/* Main panel */}
        <div className="flex-1 space-y-2 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#228B22' }} />
            <span className="text-warm-gray-light font-mono text-[9px]">Agent</span>
          </div>
          <p className="text-warm-gray font-mono text-[10px] leading-[1.6]">
            Refactored auth module. Removed 340 lines of dead code. Tests passing. Ready for your
            review.
          </p>
          <p className="text-warm-gray-light/60 font-mono text-[10px] leading-[1.6]">
            3 files changed &middot; 2m ago
          </p>
        </div>
      </div>

      {/* Status bar */}
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ borderTop: '1px solid rgba(139, 90, 43, 0.08)', background: '#FAF7F0' }}
      >
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#228B22' }} />
          <span className="text-warm-gray-light font-mono text-[9px]">3 agents active</span>
        </div>
        <span className="text-warm-gray-light/50 font-mono text-[9px]">$0.42 tonight</span>
      </div>
    </motion.div>
  );
}

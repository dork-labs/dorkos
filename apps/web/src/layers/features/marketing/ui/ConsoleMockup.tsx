'use client'

import { motion } from 'motion/react'
import { REVEAL, VIEWPORT } from '../lib/motion-variants'

/** Stylized browser-frame mock of the DorkOS console — answers "what does this look like?" */
export function ConsoleMockup() {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={REVEAL}
      className="rounded-lg overflow-hidden hidden lg:block"
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
        <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(232, 93, 4, 0.3)' }} />
        <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(139, 90, 43, 0.15)' }} />
        <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(139, 90, 43, 0.15)' }} />
        <span className="ml-2 font-mono text-[9px] tracking-[0.06em] text-warm-gray-light">
          localhost:4242
        </span>
      </div>

      {/* Console layout */}
      <div className="flex" style={{ height: 140 }}>
        {/* Mini sidebar */}
        <div
          className="w-[120px] shrink-0 py-2 px-2 space-y-1.5"
          style={{ borderRight: '1px solid rgba(139, 90, 43, 0.08)', background: '#FAF7F0' }}
        >
          <div
            className="rounded px-2 py-1 font-mono text-[9px] truncate"
            style={{ background: 'rgba(232, 93, 4, 0.06)', color: '#E85D04' }}
          >
            refactor-auth
          </div>
          <div className="rounded px-2 py-1 font-mono text-[9px] text-warm-gray-light truncate">
            test-coverage
          </div>
          <div className="rounded px-2 py-1 font-mono text-[9px] text-warm-gray-light truncate">
            dep-upgrade
          </div>
        </div>

        {/* Main panel */}
        <div className="flex-1 py-2 px-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#228B22' }} />
            <span className="font-mono text-[9px] text-warm-gray-light">Agent</span>
          </div>
          <p className="font-mono text-[10px] leading-[1.6] text-warm-gray">
            Refactored auth module. Removed 340 lines of dead code.
            Tests passing. Ready for your review.
          </p>
          <p className="font-mono text-[10px] leading-[1.6] text-warm-gray-light/60">
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
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#228B22' }} />
          <span className="font-mono text-[9px] text-warm-gray-light">3 agents active</span>
        </div>
        <span className="font-mono text-[9px] text-warm-gray-light/50">$0.42 tonight</span>
      </div>
    </motion.div>
  )
}

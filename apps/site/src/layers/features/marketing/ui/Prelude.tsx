'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';

/** Boot-sequence prelude — types "DorkOS is starting." then fades to reveal the page. */
export function Prelude() {
  const [text, setText] = useState('');
  const [visible, setVisible] = useState(true);
  const fullText = 'DorkOS is starting.';

  useEffect(() => {
    let i = 0;
    const typeInterval = setInterval(() => {
      i++;
      setText(fullText.slice(0, i));
      if (i >= fullText.length) {
        clearInterval(typeInterval);
        setTimeout(() => setVisible(false), 600);
      }
    }, 45);
    return () => clearInterval(typeInterval);
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: '#1A1814' }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <p className="font-mono text-sm tracking-[0.08em]" style={{ color: '#F5F0E6' }}>
            {text}
            <span className="cursor-blink" aria-hidden="true" />
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

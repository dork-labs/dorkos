'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import type { SystemModule } from '@/layers/features/marketing/lib/modules';
import {
  buildArchitectureMask,
  drawFrame,
  ILLUMINATE_RADIUS,
  LOCK_RADIUS,
  NODE_RADIUS_PX,
  ORANGE_HEX,
  ORANGE_R,
  ORANGE_G,
  ORANGE_B,
  PERSISTENCE_DELAY_MS,
  PERSISTENCE_FADE_MS,
  type ArchitectureMask,
  type LockedPoint,
  type Point,
} from './lib/v13-dot-matrix';

// ─── Module label overlay ─────────────────────────────────────────────────────

interface LabelOverlayProps {
  module: SystemModule;
  center: Point;
  cursor: Point | null;
  locked: LockedPoint[];
  persistenceT: number;
}

/**
 * HTML overlay label for one module.
 * Fades in as the cursor approaches, and persists as persistenceT grows.
 */
function LabelOverlay({ module, center, cursor, locked, persistenceT }: LabelOverlayProps) {
  let maxProximity = persistenceT * 0.7;

  if (cursor) {
    const dx = cursor.x - center.x;
    const dy = cursor.y - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const proximity = Math.max(0, 1 - dist / (ILLUMINATE_RADIUS * 0.85));
    maxProximity = Math.max(maxProximity, proximity * proximity);
  }

  for (const lp of locked) {
    const dx = lp.x - center.x;
    const dy = lp.y - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const proximity = Math.max(0, 1 - dist / (lp.radius * 0.9));
    maxProximity = Math.max(maxProximity, proximity * proximity * 0.7);
  }

  const isAvailable = module.status === 'available';

  return (
    <div
      className="pointer-events-none absolute text-center select-none"
      style={{
        top: center.y - NODE_RADIUS_PX - 38,
        left: center.x,
        transform: 'translateX(-50%)',
        opacity: maxProximity,
        transition: 'opacity 0.15s ease-out',
        width: 96,
      }}
    >
      <div
        className="font-mono text-[11px] font-bold tracking-[0.06em]"
        style={{ color: ORANGE_HEX, opacity: isAvailable ? 1 : 0.55 }}
      >
        {module.name.toUpperCase()}
      </div>
      <div
        className="mt-0.5 font-mono text-[9px] tracking-[0.10em]"
        style={{ color: 'rgba(255,255,255,0.5)' }}
      >
        {module.label.toUpperCase()}
      </div>
      {!isAvailable && (
        <div
          className="mt-0.5 font-mono text-[7px] tracking-[0.12em]"
          style={{ color: `rgba(${ORANGE_R},${ORANGE_G},${ORANGE_B},0.4)` }}
        >
          COMING SOON
        </div>
      )}
    </div>
  );
}

// ─── Hint overlay ─────────────────────────────────────────────────────────────

/** Animated prompt shown before first cursor interaction */
function HintText({ visible }: { visible: boolean }) {
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.6 }}
    >
      <div className="text-center">
        <div
          className="mb-1 font-mono text-[11px] tracking-[0.18em] uppercase"
          style={{ color: 'rgba(255,255,255,0.25)' }}
        >
          Move cursor to reveal
        </div>
        <div
          className="font-mono text-[9px] tracking-[0.12em] uppercase"
          style={{ color: `rgba(${ORANGE_R},${ORANGE_G},${ORANGE_B},0.3)` }}
        >
          Click to lock illumination
        </div>
      </div>
    </motion.div>
  );
}

// ─── Lock-point dot indicator ─────────────────────────────────────────────────

function LockDot({ lp }: { lp: LockedPoint }) {
  return (
    <div
      className="pointer-events-none absolute rounded-full"
      style={{
        width: 6,
        height: 6,
        left: lp.x - 3,
        top: lp.y - 3,
        background: ORANGE_HEX,
        opacity: 0.45,
        boxShadow: `0 0 8px 3px rgba(${ORANGE_R},${ORANGE_G},${ORANGE_B},0.3)`,
      }}
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

let nextLockId = 0;

/**
 * Canvas dot-matrix reveal architecture diagram.
 *
 * The DorkOS system architecture is hidden inside a dark grid of ~20,000 tiny
 * dots. Moving the cursor illuminates nearby dots with a flashlight effect —
 * architecture dots glow orange, background dots glow white. Click to pin
 * illumination at a point (up to 4 pins). After 5 seconds of interaction the
 * architecture slowly fades in so passive viewers are not left in the dark.
 */
export function DiagramV13({ modules }: { modules: SystemModule[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const maskRef = useRef<ArchitectureMask | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  // Hot-path mutable refs — updated on every mouse move without triggering re-render
  const cursorRef = useRef<Point | null>(null);
  const lockedRef = useRef<LockedPoint[]>([]);
  const persistenceTRef = useRef<number>(0);
  const firstInteractRef = useRef<number>(0);
  const hasInteractedRef = useRef<boolean>(false);

  // React state drives label overlays and hint visibility only
  const [cursorState, setCursorState] = useState<Point | null>(null);
  const [lockedState, setLockedState] = useState<LockedPoint[]>([]);
  const [persistenceState, setPersistenceState] = useState<number>(0);
  const [showHint, setShowHint] = useState<boolean>(true);
  const [canvasVisible, setCanvasVisible] = useState<boolean>(false);

  // ── Mask rebuild ────────────────────────────────────────────────────────────

  const rebuildMask = useCallback(
    (w: number, h: number) => {
      maskRef.current = buildArchitectureMask(w, h, modules);
    },
    [modules]
  );

  // ── ResizeObserver — keeps canvas dimensions and mask in sync ───────────────

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      sizeRef.current = { w: width, h: height };
      rebuildMask(width, height);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [rebuildMask]);

  // ── Animation loop ──────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let lastOverlaySync = 0;

    function tick(ts: number) {
      const ctx = canvas?.getContext('2d');
      if (!ctx) return;

      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Advance persistence timer
      if (hasInteractedRef.current && firstInteractRef.current > 0) {
        const elapsed = ts - firstInteractRef.current - PERSISTENCE_DELAY_MS;
        if (elapsed > 0) {
          persistenceTRef.current = Math.min(1, elapsed / PERSISTENCE_FADE_MS);
        }
      }

      // Scale for HiDPI displays
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.scale(dpr, dpr);

      drawFrame(ctx, {
        cursor: cursorRef.current,
        locked: lockedRef.current,
        mask: maskRef.current,
        persistenceT: persistenceTRef.current,
        w,
        h,
      });

      ctx.restore();

      // Sync React state for overlays at ~30 fps (not every frame)
      if (ts - lastOverlaySync > 33) {
        lastOverlaySync = ts;
        setPersistenceState(persistenceTRef.current);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Canvas fade-in ──────────────────────────────────────────────────────────

  useEffect(() => {
    const id = setTimeout(() => setCanvasVisible(true), 100);
    return () => clearTimeout(id);
  }, []);

  // ── Interaction helpers ─────────────────────────────────────────────────────

  const recordFirstInteraction = useCallback(() => {
    if (!hasInteractedRef.current) {
      hasInteractedRef.current = true;
      firstInteractRef.current = performance.now();
      setShowHint(false);
    }
  }, []);

  const updateCursor = useCallback(
    (x: number, y: number) => {
      const point: Point = { x, y };
      cursorRef.current = point;
      setCursorState(point);
      recordFirstInteraction();
    },
    [recordFirstInteraction]
  );

  const clearCursor = useCallback(() => {
    cursorRef.current = null;
    setCursorState(null);
  }, []);

  const addLockPoint = useCallback((x: number, y: number) => {
    const newPoint: LockedPoint = { id: nextLockId++, x, y, radius: LOCK_RADIUS };
    // Keep at most 4 pins — drop oldest
    const next = [...lockedRef.current, newPoint];
    const clamped = next.length > 4 ? next.slice(next.length - 4) : next;
    lockedRef.current = clamped;
    setLockedState([...clamped]);
  }, []);

  const getCanvasPoint = useCallback((clientX: number, clientY: number): Point | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  // ── Event handlers ──────────────────────────────────────────────────────────

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const pt = getCanvasPoint(e.clientX, e.clientY);
      if (pt) updateCursor(pt.x, pt.y);
    },
    [getCanvasPoint, updateCursor]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const pt = getCanvasPoint(e.clientX, e.clientY);
      if (pt) addLockPoint(pt.x, pt.y);
    },
    [getCanvasPoint, addLockPoint]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const touch = e.touches[0];
      if (!touch) return;
      const pt = getCanvasPoint(touch.clientX, touch.clientY);
      if (!pt) return;
      updateCursor(pt.x, pt.y);
      addLockPoint(pt.x, pt.y);
    },
    [getCanvasPoint, updateCursor, addLockPoint]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      e.preventDefault();
      const touch = e.touches[0];
      if (!touch) return;
      const pt = getCanvasPoint(touch.clientX, touch.clientY);
      if (pt) {
        cursorRef.current = pt;
        setCursorState(pt);
      }
    },
    [getCanvasPoint]
  );

  // ── Resolve overlay positions from the current mask ─────────────────────────

  const labelCenters = maskRef.current?.centers ?? {};

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <motion.div
      ref={containerRef}
      className="relative w-full cursor-crosshair overflow-hidden rounded-xl"
      style={{ background: '#0a0a0f', minHeight: 500, userSelect: 'none' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.8, ease: 'easeOut' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={clearCursor}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={clearCursor}
    >
      {/* Dot matrix canvas */}
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{
          opacity: canvasVisible ? 1 : 0,
          transition: 'opacity 0.6s ease-in',
          position: 'absolute',
          inset: 0,
        }}
        aria-hidden="true"
      />

      {/* Module labels — HTML overlays that fade in on proximity */}
      {modules.map((mod) => {
        const center = labelCenters[mod.id];
        if (!center) return null;
        return (
          <LabelOverlay
            key={mod.id}
            module={mod}
            center={center}
            cursor={cursorState}
            locked={lockedState}
            persistenceT={persistenceState}
          />
        );
      })}

      <HintText visible={showHint} />

      {/* Orange dots that mark each locked illumination point */}
      {lockedState.map((lp) => (
        <LockDot key={lp.id} lp={lp} />
      ))}

      {/* Vignette + subtle scan-line overlay for CRT depth */}
      <div
        className="pointer-events-none absolute inset-0 rounded-xl"
        style={{
          background: `
            radial-gradient(ellipse at 50% 50%, transparent 60%, rgba(0,0,0,0.55) 100%),
            repeating-linear-gradient(
              0deg,
              transparent,
              transparent 3px,
              rgba(0,0,0,0.03) 3px,
              rgba(0,0,0,0.03) 4px
            )
          `,
        }}
        aria-hidden="true"
      />

      {/* Watermark */}
      <div
        className="pointer-events-none absolute right-4 bottom-3 font-mono text-[8px] tracking-[0.12em] uppercase"
        style={{ color: 'rgba(255,255,255,0.1)' }}
        aria-hidden="true"
      >
        DRK-OS · V13 · DOT MATRIX REVEAL
      </div>
    </motion.div>
  );
}

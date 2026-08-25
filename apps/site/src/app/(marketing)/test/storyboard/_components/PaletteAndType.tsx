'use client';

import { INSTALL_COMMAND, SHELL } from '../../../new/_components';

const SWATCHES: { name: string; token: string; value: string; note: string }[] = [
  { name: 'Pitch', token: '--pitch', value: '#131110', note: 'page background' },
  { name: 'Panel', token: '--panel', value: '#1c1917', note: 'chat card, dock slots' },
  { name: 'Panel raised', token: '--panel-raised', value: '#26211c', note: 'badges, sub-badges' },
  { name: 'Cream', token: '--cream', value: '#f5f0e6', note: 'headlines, message text' },
  { name: 'Cream dim', token: '--cream-dim', value: '#a49c8e', note: 'secondary copy, labels' },
  { name: 'Ember', token: '--ember', value: '#e85d04', note: 'the one accent' },
  { name: 'Shell', token: 'SHELL.bezel', value: SHELL.bezel, note: 'laptop bezel' },
];

/**
 * The page's whole visual vocabulary in one place: seven colors and four type
 * sizes. If a change here does not improve the page, it does not belong.
 */
export function PaletteAndType() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="border-border-warm bg-cream-white rounded-xl border p-6">
        <ul className="list-none space-y-3">
          {SWATCHES.map((swatch) => (
            <li key={swatch.token} className="flex items-center gap-4">
              <span
                className="border-border-warm size-10 shrink-0 rounded-lg border"
                style={{ backgroundColor: swatch.value }}
              />
              <span className="min-w-0">
                <span className="text-charcoal block text-sm font-medium">{swatch.name}</span>
                <span className="text-warm-gray block text-xs">{swatch.note}</span>
              </span>
              <span className="text-warm-gray ml-auto font-mono text-xs">
                {swatch.token} · {swatch.value}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-border-warm bg-cream-white flex flex-col gap-5 rounded-xl border p-6">
        <div>
          <p className="text-2xs text-brand-orange font-mono tracking-[0.2em] uppercase">
            eyebrow · mono 0.625rem
          </p>
          <p className="text-charcoal mt-2 text-4xl leading-[0.95] font-semibold tracking-[-0.04em]">
            Hero headline
          </p>
          <p className="text-2xs text-warm-gray mt-1 font-mono">
            clamp(3rem, 9vw, 6.5rem) · weight 600 · tracking -0.04em
          </p>
        </div>
        <div>
          <p className="text-charcoal text-2xl leading-none font-semibold tracking-[-0.03em]">
            Beat headline
          </p>
          <p className="text-2xs text-warm-gray mt-1 font-mono">
            clamp(2rem, 4.5vw, 3.25rem) · weight 600
          </p>
        </div>
        <div>
          <p className="text-warm-gray text-lg">
            Body copy — one sentence, plain words, no jargon.
          </p>
          <p className="text-2xs text-warm-gray mt-1 font-mono">1.125rem · cream-dim</p>
        </div>
        <div>
          <p className="text-charcoal font-mono text-sm">
            <span className="text-brand-orange">$</span> {INSTALL_COMMAND}
          </p>
          <p className="text-2xs text-warm-gray mt-1 font-mono">
            IBM Plex Mono · the only place code appears
          </p>
        </div>
      </div>
    </div>
  );
}

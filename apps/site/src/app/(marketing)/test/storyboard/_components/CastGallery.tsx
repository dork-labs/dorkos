'use client';

import { Avatar, CAST, DAVE, RUNTIMES } from '../../../new/_components';

/**
 * The cast at working size: the three agents and Dave, each playing its own
 * loop, with the identity hex and the runtime the badge claims.
 *
 * Pip renders smaller than the other two and that is deliberate, not a layout
 * bug — the film fixes it in code at 0.86 because equal circular crops defeat
 * every attempt to make the small one look small.
 */
export function CastGallery() {
  return (
    <div className="border-border-warm bg-cream-white rounded-xl border p-6">
      <ul className="flex list-none flex-wrap items-end gap-10">
        {CAST.map((member) => (
          <li key={member.key} className="flex flex-col items-center gap-2 text-center">
            <Avatar who={member.key} size={80} speaking />
            <span className="text-charcoal text-sm font-medium">{member.name}</span>
            <span className="text-warm-gray-light font-mono text-xs">{member.ring}</span>
            <span className="text-warm-gray-light font-mono text-[10px] tracking-[0.08em] uppercase">
              {RUNTIMES[member.key].runtime}
            </span>
            <span className="text-warm-gray-light font-mono text-[10px]">
              {member.sizeScale === 1 ? 'full size' : `${member.sizeScale} scale`}
            </span>
          </li>
        ))}
        <li className="flex flex-col items-center gap-2 text-center">
          <Avatar who="dave" size={80} ringed />
          <span className="text-charcoal text-sm font-medium">{DAVE.name}</span>
          <span className="text-warm-gray-light font-mono text-xs">{DAVE.ring}</span>
          <span className="text-warm-gray-light font-mono text-[10px] tracking-[0.08em] uppercase">
            the person
          </span>
        </li>
      </ul>
      <p className="text-warm-gray mt-6 max-w-2xl text-sm">
        Dave carries a lit ring with no glow, which is the mark that says he is the user rather than
        an agent. An agent&rsquo;s ring lights and glows only while it is the one talking.
      </p>
    </div>
  );
}

/**
 * The reporting half of the measure script: merges repeated flags and writes measure.json and
 * summary.md.
 *
 * @module auditing-ui/measure/report
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const order = { Blocker: 0, Should: 1, Polish: 2 };

/**
 * Merge, rank and write the run's flags.
 *
 * @param {object} run - Everything the run knows: base, routes, viewports, themes, modes, floors, out, maxFlags, allFlags, captures.
 * @returns {object[]} The merged flags, worst first.
 */
export function writeReport({
  base,
  routes,
  viewports,
  themes,
  modes,
  floors,
  out,
  maxFlags,
  allFlags,
  captures,
}) {
  // The same defect at the same route on several viewports/themes is one flag with a list.
  const merged = new Map();
  for (const f of allFlags) {
    const key = [
      f.route,
      f.rule,
      f.kind,
      f.sel,
      f.text,
      f.device,
      f.kind === 'contrast' ? f.theme : '',
    ].join('|');
    const m = merged.get(key);
    if (m) {
      m.seenAt.push(`${f.viewport} ${f.theme}`);
      if (typeof f.value === 'number' && typeof m.value === 'number')
        m.value = Math.min(m.value, f.value);
    } else merged.set(key, { ...f, seenAt: [`${f.viewport} ${f.theme}`] });
  }
  const flags = [...merged.values()].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      a.rule.localeCompare(b.rule, undefined, { numeric: true })
  );
  const counts = {};
  for (const f of flags) {
    const k = `${f.severity} · ${f.rule} · ${f.kind}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  writeFileSync(
    join(out, 'measure.json'),
    JSON.stringify(
      {
        base,
        routes,
        viewports,
        themes,
        modes,
        floors,
        generatedAt: new Date().toISOString(),
        counts,
        flags: flags.slice(0, maxFlags),
        truncated: flags.length > maxFlags ? flags.length - maxFlags : 0,
        captures,
      },
      null,
      2
    )
  );

  const lines = [];
  lines.push(
    `# Measured browser leg: ${base}`,
    '',
    `Routes: ${routes.join(', ')} · viewports: ${viewports.map((v) => `${v.w}x${v.h}`).join(', ')} · themes: ${themes.join(', ')} · modes: ${modes.join(', ')}`,
    ''
  );
  lines.push(
    'Flags are measured candidates, not findings. Read the screenshot before filing one.',
    ''
  );
  lines.push('| Severity · rule · kind | Count |', '| --- | ---: |');
  for (const [k, v] of Object.entries(counts).sort(
    (a, b) => order[a[0].split(' · ')[0]] - order[b[0].split(' · ')[0]] || b[1] - a[1]
  ))
    lines.push(`| ${k} | ${v} |`);
  lines.push('', '## Worst first (top 60)', '');
  for (const f of flags.slice(0, 60))
    lines.push(
      `- **${f.severity}** §${f.rule} ${f.kind} · ${f.route} ${f.device} · \`${f.sel}\` “${(f.text || '').slice(0, 40)}” · ${f.value} vs ${f.floor}${f.detail ? ` · ${f.detail}` : ''} · ${f.seenAt.length}× (${f.seenAt.slice(0, 3).join(', ')}${f.seenAt.length > 3 ? '…' : ''})`
    );
  lines.push('', '## Captures', '');
  for (const c of captures)
    lines.push(
      `- ${c.route} ${c.viewport} ${c.theme} ${c.mode}: \`${c.shot}\`${c.stats ? ` · text ${c.stats.text}, icons ${c.stats.icons}, targets ${c.stats.targets}, inputs ${c.stats.inputs}${c.consoleErrors?.length ? `, ${c.consoleErrors.length} console errors` : ''}` : ''}`
    );
  writeFileSync(join(out, 'summary.md'), lines.join('\n') + '\n');
  console.log(
    `\n${flags.length} flags (${flags.filter((f) => f.severity === 'Blocker').length} Blocker). ${join(out, 'summary.md')}`
  );
  return flags;
}

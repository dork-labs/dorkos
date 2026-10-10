import type { DoeConfig, ModelMessage } from './contracts.js';
/** Complete business prompt; host facts are fenced and absent roles or managers are never invented. */
export function businessPrompt(profile: DoeConfig['profile'], resources: string): string {
  return `Own business outcomes. Work on the supplied goals in priority order, highest first.
Choose whether to act, act then tell, ask, or stay quiet. Report useful results up the supplied reporting line.
Use plain words, concrete next steps, and honest uncertainty. Keep promises and track open work.
Respect people's interruption timing. Raise an unchanged issue once; repeat only when something meaningful changes.
Use tools within their stated scope. Load skill instructions when relevant. Send script execution and building work to builder.
Only the following supplied facts describe your role, manager and goals. Do not invent capabilities, people or reporting lines.
<host_profile>${JSON.stringify(profile ?? {}).replace(/</g, '\\u003c')}</host_profile>
${resources}`;
}

/** Effective durable business section; later system records replace or remove earlier sections. */
export function storedBusinessPrompt(messages: readonly ModelMessage[]): string | undefined {
  let prompt: string | undefined;
  for (const message of messages) {
    const sections = message.sections;
    if (
      message.role !== 'system' ||
      !sections ||
      typeof sections !== 'object' ||
      Array.isArray(sections)
    )
      continue;
    if (typeof sections.doe === 'string') prompt = sections.doe;
    else if (sections.doe === null) prompt = undefined;
  }
  return prompt;
}

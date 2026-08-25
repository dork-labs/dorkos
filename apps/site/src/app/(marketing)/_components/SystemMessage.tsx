import type { ChatLine } from './chat-script';

/** Centered mono line spoken by the room itself ("X joined", "shipped"). */
export function SystemMessage({ line }: { line: ChatLine }) {
  const emphasis = line.text.startsWith('🚀') ? 'text-(--ember)' : 'text-(--cream-dim)';
  return <p className={`py-0.5 text-center font-mono text-xs ${emphasis}`}>{line.text}</p>;
}

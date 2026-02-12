import { Streamdown } from 'streamdown';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export function StreamingText({ content, isStreaming = false }: StreamingTextProps) {
  return (
    <div className="relative">
      <Streamdown shikiTheme={['github-light', 'github-dark']}>
        {content}
      </Streamdown>
      {isStreaming && (
        <span
          className="inline-block w-0.5 h-[1.1em] bg-foreground/70 align-text-bottom ml-0.5"
          style={{ animation: 'blink-cursor 1s step-end infinite' }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

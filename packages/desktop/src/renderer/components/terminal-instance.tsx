import type { JSX } from 'react';

import { useTerminalRuntime } from '../hooks/use-terminal-runtime.js';
import { cn } from '../lib/utils.js';
import type { TerminalSessionStatus } from './session-tab-bar.js';

interface TerminalInstanceProps {
  sessionId: string;
  status: TerminalSessionStatus;
  visible: boolean;
  onInput: () => void;
}

export function TerminalInstance({
  sessionId,
  status,
  visible,
  onInput,
}: TerminalInstanceProps): JSX.Element {
  const { containerRef } = useTerminalRuntime({ sessionId, status, visible, onInput });

  return (
    <div className={cn('h-full min-h-0 flex-1 bg-terminal-bg', visible ? 'block' : 'hidden')}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

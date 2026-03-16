import { useTerminalRuntime } from '../hooks/use-terminal-runtime';

type TerminalStatus = 'idle' | 'running' | 'exited';

interface TerminalPanelProps {
  sessionId: string | null;
  status: TerminalStatus;
  onKill: () => void;
  onClose: () => void;
}

export function TerminalPanel({ sessionId, status, onKill, onClose }: TerminalPanelProps) {
  const { containerRef } = useTerminalRuntime({ sessionId, status });

  return (
    <div className="flex h-full flex-col border-l border-white/10">
      <div className="flex items-center gap-3 bg-zinc-900/80 px-3 py-1.5">
        <span className="text-xs text-zinc-400">Terminal</span>
        {status === 'running' ? (
          <span className="text-xs text-emerald-400/80">running</span>
        ) : status === 'exited' ? (
          <span className="text-xs text-zinc-500">exited</span>
        ) : (
          <span className="text-xs text-zinc-500">idle</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {status === 'running' ? (
            <button
              type="button"
              onClick={onKill}
              className="rounded px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              Stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
          >
            Close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-[#0b1020]">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

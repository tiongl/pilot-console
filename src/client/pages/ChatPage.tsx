import { useCallback, useRef } from 'react';
import TerminalPane, { type TerminalPaneAPI } from '../components/terminal/TerminalPane';
import { useCliSocket } from '../hooks/useCliSocket';

export default function ChatPage() {
  const termApiRef = useRef<TerminalPaneAPI | null>(null);
  const pendingOutput = useRef<string[]>([]);

  const writeToTerm = useCallback((data: string) => {
    if (termApiRef.current) {
      termApiRef.current.write(data);
    } else {
      pendingOutput.current.push(data);
    }
  }, []);

  const { send } = useCliSocket({
    onOutput: writeToTerm,
    onReady: () => {
      if (termApiRef.current) termApiRef.current.fit();
    },
  });

  const onInput = useCallback((data: string) => {
    send({ type: 'input', data });
  }, [send]);

  const onResize = useCallback((cols: number, rows: number) => {
    send({ type: 'resize', cols, rows });
  }, [send]);

  const handleTermReady = useCallback((api: TerminalPaneAPI) => {
    termApiRef.current = api;
    if (pendingOutput.current.length > 0) {
      for (const chunk of pendingOutput.current) {
        api.write(chunk);
      }
      pendingOutput.current = [];
    }
    api.fit();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-2">
        <h2 className="text-sm font-semibold">Copilot CLI Chat</h2>
        <p className="text-xs text-muted-foreground">General session (no project context)</p>
      </div>
      <div className="flex-1">
        <TerminalPane
          onInput={onInput}
          onResize={onResize}
          onReady={handleTermReady}
        />
      </div>
    </div>
  );
}

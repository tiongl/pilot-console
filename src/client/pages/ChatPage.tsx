import { useState, useCallback } from 'react';
import TerminalPane from '../../../components/terminal/TerminalPane';
import { useCliSocket } from '../../../hooks/useCliSocket';

export default function ChatPage() {
  const [output, setOutput] = useState('');

  const onOutput = useCallback((data: string) => {
    setOutput(prev => prev + data);
  }, []);

  const { send } = useCliSocket({ onOutput });

  const onInput = useCallback((data: string) => {
    send({ type: 'input', data });
  }, [send]);

  const onResize = useCallback((cols: number, rows: number) => {
    send({ type: 'resize', cols, rows });
  }, [send]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-2">
        <h2 className="text-sm font-semibold">Copilot CLI Chat</h2>
        <p className="text-xs text-muted-foreground">General session (no project context)</p>
      </div>
      <div className="flex-1">
        <TerminalPane output={output} onInput={onInput} onResize={onResize} />
      </div>
    </div>
  );
}

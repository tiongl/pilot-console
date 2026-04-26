'use client';

import { useCallback, useRef, useState } from 'react';
import { useCliSocket } from '@/hooks/useCliSocket';
import ChatWindow from '@/components/chat/ChatWindow';
import ChatInput from '@/components/chat/ChatInput';
import TerminalPane from '@/components/terminal/TerminalPane';
import { Button } from '@/components/ui/button';
import { Terminal, MessageSquare } from 'lucide-react';
import type { ChatMessage } from '@/types';

interface Props {
  userName: string | null;
  projectId?: string;
}

export default function ChatClient({ userName: _userName, projectId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat');
  const [rawOutput, setRawOutput] = useState('');
  const assistantIdRef = useRef<string | null>(null);

  const appendOutput = useCallback((data: string) => {
    setRawOutput((prev) => prev + data);
    if (!assistantIdRef.current) assistantIdRef.current = crypto.randomUUID();
    const id = assistantIdRef.current;
    setMessages((prev) => {
      const existing = prev.find((m) => m.id === id);
      if (existing) return prev.map((m) => m.id === id ? { ...m, content: m.content + data } : m);
      return [...prev, { id, role: 'assistant', content: data, timestamp: Date.now() }];
    });
  }, []);

  const { state, send } = useCliSocket({
    projectId,
    onOutput: appendOutput,
    onError: (data) => appendOutput(`\x1b[31m${data}\x1b[0m`),
    onExit: (code) => {
      assistantIdRef.current = null;
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: `_Process exited (code ${code})_`, timestamp: Date.now(),
      }]);
    },
    onReady: () => { assistantIdRef.current = null; },
  });

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    assistantIdRef.current = null;
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() }]);
    send({ type: 'input', data: text + '\n' });
  };

  const statusColor = { open: 'bg-green-500', connecting: 'bg-yellow-500', closed: 'bg-gray-400', error: 'bg-red-500' }[state];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-sm text-muted-foreground capitalize">{state}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={viewMode === 'chat' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('chat')}>
            <MessageSquare className="h-4 w-4 mr-1" /> Chat
          </Button>
          <Button variant={viewMode === 'terminal' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('terminal')}>
            <Terminal className="h-4 w-4 mr-1" /> Terminal
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {viewMode === 'chat'
          ? <ChatWindow messages={messages} />
          : <TerminalPane output={rawOutput} onInput={(data) => send({ type: 'input', data })} />
        }
      </div>

      <div className="border-t p-4">
        <ChatInput onSend={handleSend} disabled={state !== 'open'} />
      </div>
    </div>
  );
}

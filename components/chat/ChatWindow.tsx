'use client';

import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import MessageBubble from './MessageBubble';
import type { ChatMessage } from '@/types';

interface Props {
  messages: ChatMessage[];
}

export default function ChatWindow({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-12">
            Start a conversation with GitHub Copilot CLI
          </p>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

'use client';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/types';

interface Props {
  message: ChatMessage;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const content = stripAnsi(message.content);

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-muted text-foreground rounded-bl-sm',
        )}
      >
        {content}
      </div>
    </div>
  );
}

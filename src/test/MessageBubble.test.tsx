import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MessageBubble from '@/components/chat/MessageBubble';
import type { ChatMessage } from '@/types';

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('renders a user message with the correct text and alignment', () => {
    const { container } = render(
      <MessageBubble message={createMessage({ role: 'user', content: 'Hi there' })} />,
    );

    expect(screen.getByText('Hi there')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('justify-end');
  });

  it('renders an assistant message with the correct text and alignment', () => {
    const { container } = render(
      <MessageBubble message={createMessage({ role: 'assistant', content: 'How can I help?' })} />,
    );

    expect(screen.getByText('How can I help?')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('justify-start');
  });

  it('strips ANSI codes from the rendered content', () => {
    render(<MessageBubble message={createMessage({ content: '\u001b[31mRed text\u001b[39m' })} />);

    expect(screen.getByText('Red text')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\u001b[31m');
  });

  it('renders empty content without error', () => {
    const { container } = render(<MessageBubble message={createMessage({ content: '' })} />);

    const bubbles = container.querySelectorAll('div');
    expect(bubbles[bubbles.length - 1]?.textContent).toBe('');
  });
});

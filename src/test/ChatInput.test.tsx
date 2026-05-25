import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatInput from '@/components/chat/ChatInput';

describe('ChatInput', () => {
  it('renders the textarea and send button', () => {
    render(<ChatInput onSend={vi.fn()} />);

    expect(screen.getByPlaceholderText(/Ask Copilot…/)).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('updates the textarea value while typing', async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/Ask Copilot…/);
    await user.type(textarea, 'Hello Copilot');

    expect(textarea).toHaveValue('Hello Copilot');
  });

  it('clicks send with trimmed text and clears the input', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/Ask Copilot…/);
    const button = screen.getByRole('button');

    await user.type(textarea, '  Hello world  ');
    await user.click(button);

    expect(onSend).toHaveBeenCalledWith('Hello world');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue('');
  });

  it('sends the message on Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/Ask Copilot…/);
    await user.type(textarea, 'Hello{enter}');

    expect(onSend).toHaveBeenCalledWith('Hello');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue('');
  });

  it('does not send on Shift+Enter and allows a newline', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/Ask Copilot…/);
    await user.type(textarea, 'Hello');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Hello\n');
  });

  it('does not send empty or whitespace-only text', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/Ask Copilot…/);
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();

    await user.type(textarea, '   ');

    expect(button).toBeDisabled();
    await user.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('   ');
  });

  it('disables the textarea and button when disabled is true', () => {
    render(<ChatInput onSend={vi.fn()} disabled />);

    expect(screen.getByPlaceholderText(/Ask Copilot…/)).toBeDisabled();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('disables the send button when the input is empty', async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/Ask Copilot…/);
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();

    await user.type(textarea, 'Hello');
    expect(button).toBeEnabled();

    await user.clear(textarea);
    expect(button).toBeDisabled();
  });
});

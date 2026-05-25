import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionList from '@/components/sessions/SessionList';
import type { CliSession } from '@/types';

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, ' ').trim();
}

function createSession(overrides: Partial<CliSession>): CliSession {
  return {
    id: '12345678-1234-1234-1234-1234567890ab',
    userId: 'user-1',
    projectId: 'project-1',
    copilotSessionId: null,
    startedAt: '2025-01-01T10:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

describe('SessionList', () => {
  it('renders a list of sessions with their details', () => {
    const sessions = [
      createSession({
        id: '12345678-1234-1234-1234-1234567890ab',
        startedAt: '2025-01-01T10:00:00.000Z',
      }),
      createSession({
        id: 'abcdef12-1234-1234-1234-abcdef123456',
        startedAt: '2025-01-02T12:30:00.000Z',
        endedAt: '2025-01-02T13:00:00.000Z',
        copilotSessionId: 'copilot-session-1234567890',
      }),
    ];

    const { container } = render(<SessionList sessions={sessions} />);
    const text = normalizeText(container.textContent);

    expect(screen.getByText('12345678…')).toBeInTheDocument();
    expect(screen.getByText('abcdef12…')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(text).toContain(`Started: ${new Date(sessions[0].startedAt).toLocaleString()}`);
    expect(text).toContain(`Ended: ${new Date(sessions[1].endedAt!).toLocaleString()}`);
    expect(text).toContain('Copilot ID: copilot-sess…');
  });

  it('renders an empty state when there are no sessions', () => {
    render(<SessionList sessions={[]} />);

    expect(screen.getByText('No sessions yet. Start a chat to create one.')).toBeInTheDocument();
  });

  it('renders session cards without interactive click handlers', () => {
    render(<SessionList sessions={[createSession({})]} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

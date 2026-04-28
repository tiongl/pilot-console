import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/src/client/lib/auth-context';

function AuthDisplay() {
  const { user, loading } = useAuth();
  if (loading) return <span data-testid="status">loading</span>;
  return (
    <div>
      <span data-testid="status">{user ? 'authenticated' : 'unauthenticated'}</span>
      {user && <span data-testid="email">{user.email}</span>}
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in loading state', () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {})); // never resolves
    render(
      <AuthProvider>
        <AuthDisplay />
      </AuthProvider>
    );
    expect(screen.getByTestId('status').textContent).toBe('loading');
  });

  it('sets user when /api/auth/me returns ok', async () => {
    const mockUser = {
      id: '1',
      githubId: '123',
      githubLogin: 'testuser',
      email: 'test@example.com',
      displayName: 'Test User',
      role: 'user',
    };

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: mockUser }),
    } as Response);

    render(
      <AuthProvider>
        <AuthDisplay />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('email').textContent).toBe('test@example.com');
  });

  it('sets user to null when /api/auth/me returns error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    render(
      <AuthProvider>
        <AuthDisplay />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });
  });

  it('handles fetch failure gracefully', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    render(
      <AuthProvider>
        <AuthDisplay />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });
  });

  it('throws when useAuth is used outside AuthProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<AuthDisplay />)).toThrow();
    spy.mockRestore();
  });
});

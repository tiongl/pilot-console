import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ProjectProvider,
  useProjectContext,
  useProjectContextOptional,
} from '@/lib/project-context';

function RequiredConsumer() {
  const { projectId, cwd, worktreeId } = useProjectContext();

  return React.createElement(
    'div',
    null,
    React.createElement('span', { 'data-testid': 'projectId' }, projectId),
    React.createElement('span', { 'data-testid': 'cwd' }, cwd),
    React.createElement('span', { 'data-testid': 'worktreeId' }, worktreeId ?? 'none')
  );
}

function OptionalConsumer() {
  const value = useProjectContextOptional();
  return React.createElement('span', { 'data-testid': 'optional' }, value ? JSON.stringify(value) : 'undefined');
}

describe('ProjectProvider', () => {
  it('returns provided project values from useProjectContext', () => {
    render(
      React.createElement(
        ProjectProvider,
        { projectId: 'project-1', cwd: 'C:\\repo', worktreeId: 'wt-1' },
        React.createElement(RequiredConsumer)
      )
    );

    expect(screen.getByTestId('projectId')).toHaveTextContent('project-1');
    expect(screen.getByTestId('cwd')).toHaveTextContent('C:\\repo');
    expect(screen.getByTestId('worktreeId')).toHaveTextContent('wt-1');
  });

  it('supports an optional worktreeId', () => {
    render(
      React.createElement(
        ProjectProvider,
        { projectId: 'project-2', cwd: 'C:\\repo' },
        React.createElement(RequiredConsumer)
      )
    );

    expect(screen.getByTestId('worktreeId')).toHaveTextContent('none');
  });

  it('throws when useProjectContext is used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(React.createElement(RequiredConsumer))).toThrow('useProjectContext must be used within a ProjectProvider');

    spy.mockRestore();
  });

  it('returns undefined from useProjectContextOptional outside provider', () => {
    render(React.createElement(OptionalConsumer));

    expect(screen.getByTestId('optional')).toHaveTextContent('undefined');
  });
});

import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ProjectSplitProvider,
  isValidSplitLayout,
  splitGroupCount,
  useProjectSplit,
} from '@/lib/project-split-context';

function SplitConsumer() {
  const { layout, isSplit, groupCount, setLayout } = useProjectSplit();

  return React.createElement(
    'div',
    null,
    React.createElement('span', { 'data-testid': 'layout' }, `${layout.rows}x${layout.cols}`),
    React.createElement('span', { 'data-testid': 'is-split' }, String(isSplit)),
    React.createElement('span', { 'data-testid': 'group-count' }, String(groupCount)),
    React.createElement('button', { type: 'button', onClick: () => setLayout({ rows: 2, cols: 2 }) }, 'set valid'),
    React.createElement('button', { type: 'button', onClick: () => setLayout({ rows: 2, cols: 3 }) }, 'set invalid')
  );
}

describe('project split helpers', () => {
  it('validates supported split layouts', () => {
    expect(isValidSplitLayout(1, 1)).toBe(true);
    expect(isValidSplitLayout(1, 4)).toBe(true);
    expect(isValidSplitLayout(4, 1)).toBe(true);
    expect(isValidSplitLayout(2, 2)).toBe(true);
  });

  it('rejects unsupported split layouts', () => {
    expect(isValidSplitLayout(0, 1)).toBe(false);
    expect(isValidSplitLayout(5, 1)).toBe(false);
    expect(isValidSplitLayout(2, 3)).toBe(false);
    expect(isValidSplitLayout(3, 3)).toBe(false);
  });

  it('counts groups from layout dimensions', () => {
    expect(splitGroupCount({ rows: 1, cols: 1 })).toBe(1);
    expect(splitGroupCount({ rows: 1, cols: 4 })).toBe(4);
    expect(splitGroupCount({ rows: 4, cols: 1 })).toBe(4);
    expect(splitGroupCount({ rows: 2, cols: 2 })).toBe(4);
  });
});

describe('ProjectSplitProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders children', () => {
    render(
      React.createElement(
        ProjectSplitProvider,
        { stateKey: 'render-children' },
        React.createElement('div', null, 'child content')
      )
    );

    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('provides the default 1x1 layout', () => {
    render(
      React.createElement(
        ProjectSplitProvider,
        { stateKey: 'default-layout' },
        React.createElement(SplitConsumer)
      )
    );

    expect(screen.getByTestId('layout')).toHaveTextContent('1x1');
    expect(screen.getByTestId('is-split')).toHaveTextContent('false');
    expect(screen.getByTestId('group-count')).toHaveTextContent('1');
  });

  it('updates layout through setLayout', () => {
    render(
      React.createElement(
        ProjectSplitProvider,
        { stateKey: 'update-layout' },
        React.createElement(SplitConsumer)
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'set valid' }));

    expect(screen.getByTestId('layout')).toHaveTextContent('2x2');
    expect(screen.getByTestId('is-split')).toHaveTextContent('true');
    expect(screen.getByTestId('group-count')).toHaveTextContent('4');
  });

  it('rejects invalid layouts', () => {
    render(
      React.createElement(
        ProjectSplitProvider,
        { stateKey: 'reject-invalid' },
        React.createElement(SplitConsumer)
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'set invalid' }));

    expect(screen.getByTestId('layout')).toHaveTextContent('1x1');
    expect(screen.getByTestId('group-count')).toHaveTextContent('1');
  });

  it('throws when useProjectSplit is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(React.createElement(SplitConsumer))).toThrow('useProjectSplit must be used within ProjectSplitProvider');

    spy.mockRestore();
  });
});

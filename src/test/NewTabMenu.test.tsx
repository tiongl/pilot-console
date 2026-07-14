import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NewTabMenu from '@/components/terminal/NewTabMenu';

describe('NewTabMenu', () => {
  it('does not show menu initially', () => {
    render(<NewTabMenu onSelect={() => {}} />);
    expect(screen.queryByTestId('new-tab-menu')).toBeNull();
  });

  it('shows menu when + button is clicked', () => {
    render(<NewTabMenu onSelect={() => {}} />);
    fireEvent.click(screen.getByTestId('new-tab-button'));
    expect(screen.getByTestId('new-tab-menu')).toBeTruthy();
    expect(screen.getByTestId('menu-cli')).toBeTruthy();
    expect(screen.getByTestId('menu-shell')).toBeTruthy();
    expect(screen.getByTestId('menu-powershell')).toBeTruthy();
  });

  it('calls onSelect with "cli" when Copilot CLI is clicked', () => {
    const onSelect = vi.fn();
    render(<NewTabMenu onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('new-tab-button'));
    fireEvent.click(screen.getByTestId('menu-cli'));
    expect(onSelect).toHaveBeenCalledWith('cli');
  });

  it('calls onSelect with "shell" when Terminal is clicked', () => {
    const onSelect = vi.fn();
    render(<NewTabMenu onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('new-tab-button'));
    fireEvent.click(screen.getByTestId('menu-shell'));
    expect(onSelect).toHaveBeenCalledWith('shell');
  });

  it('calls onSelect with "powershell" when PowerShell is clicked', () => {
    const onSelect = vi.fn();
    render(<NewTabMenu onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('new-tab-button'));
    fireEvent.click(screen.getByTestId('menu-powershell'));
    expect(onSelect).toHaveBeenCalledWith('powershell');
  });

  it('closes menu after selection', () => {
    render(<NewTabMenu onSelect={() => {}} />);
    fireEvent.click(screen.getByTestId('new-tab-button'));
    fireEvent.click(screen.getByTestId('menu-cli'));
    expect(screen.queryByTestId('new-tab-menu')).toBeNull();
  });

  it('toggles menu closed when + is clicked again', () => {
    render(<NewTabMenu onSelect={() => {}} />);
    fireEvent.click(screen.getByTestId('new-tab-button'));
    expect(screen.getByTestId('new-tab-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-tab-button'));
    expect(screen.queryByTestId('new-tab-menu')).toBeNull();
  });

  it('closes menu on outside click', () => {
    render(
      <div>
        <NewTabMenu onSelect={() => {}} />
        <button data-testid="outside">Outside</button>
      </div>
    );
    fireEvent.click(screen.getByTestId('new-tab-button'));
    expect(screen.getByTestId('new-tab-menu')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('new-tab-menu')).toBeNull();
  });
});

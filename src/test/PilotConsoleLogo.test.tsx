import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PilotConsoleLogo } from '@/components/PilotConsoleLogo';

describe('PilotConsoleLogo', () => {
  it('renders an object element with the correct SVG source', () => {
    const { container } = render(<PilotConsoleLogo />);

    const logo = container.querySelector('object');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('data', '/pilot-console-logo.svg');
    expect(logo).toHaveAttribute('type', 'image/svg+xml');
  });

  it('sets aria-hidden to true', () => {
    const { container } = render(<PilotConsoleLogo />);

    expect(container.querySelector('object')).toHaveAttribute('aria-hidden', 'true');
  });

  it('extracts size from the className', () => {
    const { container } = render(<PilotConsoleLogo className="h-10 w-10" />);

    const logo = container.querySelector('object');
    expect(logo?.style.width).toBe('2.5rem');
    expect(logo?.style.height).toBe('2.5rem');
  });

  it('works without a className prop', () => {
    const { container } = render(<PilotConsoleLogo />);

    expect(container.querySelector('object')?.getAttribute('style')).toBeNull();
  });
});

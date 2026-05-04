import styles from './PilotConsoleLogo.module.css';

export function PilotConsoleLogo({ className }: { className?: string }) {
  // Extract size from Tailwind classes like h-10, w-10
  const sizeMatch = className?.match(/[hw]-(\d+)/);
  const size = sizeMatch ? parseInt(sizeMatch[1]) * 0.25 : undefined; // Tailwind unit to rem

  return (
    <object
      data="/pilot-console-logo.svg"
      type="image/svg+xml"
      className={styles.logo}
      style={size ? { width: `${size}rem`, height: `${size}rem` } : undefined}
      aria-hidden="true"
    />
  );
}

import { useId } from 'react';

/**
 * Luna's logo: a golden orb with a crescent Moon cut into it and a small star beside it. `pulse` makes it breathe while
 * she is busy or listening.
 */
export function LunaMark({ className = '', pulse = false }: { className?: string; pulse?: boolean }) {
  const id = useId();
  const gold = `${id}-gold`;
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={`shrink-0 rounded-full drop-shadow-[0_0_10px_rgba(244,182,63,0.45)] ${pulse ? 'animate-pulse' : ''} ${className}`}
    >
      <defs>
        <radialGradient id={gold} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#FFE3A3" />
          <stop offset="0.55" stopColor="#F4B63F" />
          <stop offset="1" stopColor="#8A5A0A" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${gold})`} />
      {/* The crescent: a disc with a second disc taken out of it. */}
      <path d="M22.5 9.5a11 11 0 1 0 8.4 17.9A9 9 0 1 1 22.5 9.5z" fill="#2A1A03" fillOpacity="0.78" />
      {/* The star: four points. */}
      <path d="M29 9l1.2 3.3L33.5 13.5l-3.3 1.2L29 18l-1.2-3.3-3.3-1.2 3.3-1.2z" fill="#FFF6DD" />
    </svg>
  );
}

import { useRef, useEffect, useState, useCallback } from 'react';

const LEFT_EYE = { cx: 74, cy: 32 };
const RIGHT_EYE = { cx: 96, cy: 32 };
const MAX_OFFSET = 4;

export function ClippyLogo({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const rafRef = useRef(0);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      // Convert mouse screen coords to SVG viewBox coords (0-128)
      const svgX = ((e.clientX - rect.left) / rect.width) * 128;
      const svgY = ((e.clientY - rect.top) / rect.height) * 128;
      // Use midpoint between the two eyes as reference
      const midX = (LEFT_EYE.cx + RIGHT_EYE.cx) / 2;
      const midY = (LEFT_EYE.cy + RIGHT_EYE.cy) / 2;
      const dx = svgX - midX;
      const dy = svgY - midY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) {
        setOffset({ dx: 0, dy: 0 });
      } else {
        const clamp = Math.min(MAX_OFFSET, dist) / dist;
        setOffset({ dx: dx * clamp, dy: dy * clamp });
      }
    });
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      cancelAnimationFrame(rafRef.current);
    };
  }, [handleMouseMove]);

  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" className={className}>
      <style>{`
        @keyframes blink {
          0%, 38%, 42%, 100% { transform: scaleY(1); }
          40% { transform: scaleY(0.05); }
        }
        .clippy-iris { animation: blink 3s ease-in-out infinite; transform-origin: 50% 32px; }
        .clippy-pupil { animation: blink 3s ease-in-out infinite; transform-origin: 50% 34px; }
        .clippy-highlight { animation: blink 3s ease-in-out infinite; transform-origin: 50% 28px; }
      `}</style>
      <defs>
        <linearGradient id="bg-grad" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1a1a2e"/>
          <stop offset="100%" stopColor="#16213e"/>
        </linearGradient>
        <linearGradient id="clip-grad" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1"/>
          <stop offset="100%" stopColor="#a78bfa"/>
        </linearGradient>
        <linearGradient id="eye-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8"/>
          <stop offset="100%" stopColor="#818cf8"/>
        </linearGradient>
      </defs>

      <rect x="4" y="4" width="120" height="120" rx="16" fill="url(#bg-grad)"/>
      <rect x="4" y="4" width="120" height="120" rx="16" stroke="url(#clip-grad)" strokeWidth="2.5" fill="none"/>

      <path d="M28 28l20 36-20 36" stroke="#22d3ee" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>

      <path d="M64 106V40a18 18 0 0 1 36 0v58a13 13 0 0 1-26 0V44a8 8 0 0 1 16 0v52"
            stroke="url(#clip-grad)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>

      {/* Eye sockets */}
      <ellipse cx="74" cy="32" rx="12" ry="13" fill="#1e1e2e"/>
      <ellipse cx="96" cy="32" rx="12" ry="13" fill="#1e1e2e"/>
      {/* Irises */}
      <ellipse className="clippy-iris" cx="74" cy="32" rx="10" ry="11" fill="url(#eye-grad)"/>
      <ellipse className="clippy-iris" cx="96" cy="32" rx="10" ry="11" fill="url(#eye-grad)"/>
      {/* Pupils */}
      <circle className="clippy-pupil" cx={LEFT_EYE.cx - 3 + offset.dx} cy={LEFT_EYE.cy + 2 + offset.dy} r="4.5" fill="#1e1e2e"/>
      <circle className="clippy-pupil" cx={RIGHT_EYE.cx - 3 + offset.dx} cy={RIGHT_EYE.cy + 2 + offset.dy} r="4.5" fill="#1e1e2e"/>
      {/* Eye highlights */}
      <circle className="clippy-highlight" cx={LEFT_EYE.cx - 3 + offset.dx * 0.5} cy={LEFT_EYE.cy - 4 + offset.dy * 0.5} r="3" fill="white" opacity="0.7"/>
      <circle className="clippy-highlight" cx={RIGHT_EYE.cx - 3 + offset.dx * 0.5} cy={RIGHT_EYE.cy - 4 + offset.dy * 0.5} r="3" fill="white" opacity="0.7"/>

      <path d="M66 23 Q74 17 82 23" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" fill="none"/>
      <path d="M86 23 Q94 17 102 23" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" fill="none"/>
    </svg>
  );
}

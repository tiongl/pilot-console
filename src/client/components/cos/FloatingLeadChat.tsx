import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, X, ChevronLeft, UserRound, Users, GripHorizontal } from 'lucide-react';
import { Button } from '../ui/button';
import AgentPane from '../terminal/AgentPane';

interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  projects: ProjectOption[];
}

type Selection = { kind: 'chief_of_staff' } | { kind: 'project_lead'; projectId: string; projectName: string };

interface Position {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

const FAB_SIZE = 48;
const MARGIN = 16;
const DEFAULT_WINDOW_WIDTH = 440;
const DEFAULT_WINDOW_HEIGHT = 560;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 320;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Persists a draggable element's top-left position (in px) to localStorage,
 *  clamping it to stay fully within the viewport. `computeDefault` is only
 *  invoked once, lazily, so it can safely read `window` dimensions.
 *  `sizeRef` is read live (rather than passed by value) so the clamp bounds
 *  stay correct even after the element has been resized. */
function useDraggablePosition(storageKey: string, computeDefault: () => Position, sizeRef: React.RefObject<Size>) {
  const [pos, setPos] = useState<Position>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Position;
        // Guard against stale/corrupt values (e.g. saved on a larger screen,
        // or NaN from a bad JSON parse) that would render the element
        // off-screen and make it look like it's simply missing.
        if (
          Number.isFinite(parsed.x) &&
          Number.isFinite(parsed.y) &&
          parsed.x >= -MARGIN &&
          parsed.y >= -MARGIN &&
          parsed.x < window.innerWidth &&
          parsed.y < window.innerHeight
        ) {
          return parsed;
        }
      }
    } catch {}
    return computeDefault();
  });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Keep the element on-screen if the window is resized smaller.
  useEffect(() => {
    const onResize = () => {
      const { width, height } = sizeRef.current;
      setPos((p) => ({
        x: clamp(p.x, MARGIN, window.innerWidth - width - MARGIN),
        y: clamp(p.y, MARGIN, window.innerHeight - height - MARGIN),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sizeRef]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only left-click / primary touch starts a drag.
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    const { width, height } = sizeRef.current;
    const nextX = clamp(drag.origX + dx, MARGIN, window.innerWidth - width - MARGIN);
    const nextY = clamp(drag.origY + dy, MARGIN, window.innerHeight - height - MARGIN);
    setPos({ x: nextX, y: nextY });
  }, [sizeRef]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    setPos((p) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(p));
      } catch {}
      return p;
    });
  }, [storageKey]);

  return { pos, dragging, onPointerDown, onPointerMove, onPointerUp, hasMoved: () => dragRef.current?.moved ?? false };
}

/** Persists an element's width/height to localStorage via a bottom-right
 *  resize-handle drag, clamped to a sensible minimum and to the remaining
 *  viewport space given the element's current top-left position (read live
 *  via `posRef` to avoid a circular dependency with useDraggablePosition). */
function useResizableSize(storageKey: string, defaultSize: Size, posRef: React.RefObject<Position>) {
  const [size, setSize] = useState<Size>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Size;
        if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height) && parsed.width > 0 && parsed.height > 0) {
          return parsed;
        }
      }
    } catch {}
    return defaultSize;
  });
  const dragRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origW: size.width, origH: size.height };
    setResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [size.width, size.height]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const { x, y } = posRef.current;
    const maxWidth = window.innerWidth - x - MARGIN;
    const maxHeight = window.innerHeight - y - MARGIN;
    const nextWidth = clamp(drag.origW + (e.clientX - drag.startX), MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, maxWidth));
    const nextHeight = clamp(drag.origH + (e.clientY - drag.startY), MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, maxHeight));
    setSize({ width: nextWidth, height: nextHeight });
  }, [posRef]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    e.stopPropagation();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    setSize((s) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(s));
      } catch {}
      return s;
    });
  }, [storageKey]);

  return { size, resizing, onPointerDown, onPointerMove, onPointerUp };
}

/**
 * Always-available floating launcher that lets the user open a quick chat
 * with the Chief of Staff, or any project's Project Lead, from anywhere in
 * the app without navigating away from what they're currently doing.
 * Both the launcher icon and the chat window can be dragged anywhere on
 * screen (defaulting to the right-hand side); positions persist across
 * reloads via localStorage.
 */
export default function FloatingLeadChat({ projects }: Props) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const suppressClickRef = useRef(false);

  // Match whatever font the user has configured for project terminals/chats,
  // so the floating chat doesn't look like a smaller, disconnected widget.
  const [fontFamily] = useState(() => {
    try {
      return localStorage.getItem('pilot-console-font') || undefined;
    } catch {
      return undefined;
    }
  });
  const [fontSize] = useState(() => {
    try {
      const raw = localStorage.getItem('pilot-console-font-size');
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) ? Math.max(8, Math.min(24, parsed)) : 15;
    } catch {
      return 15;
    }
  });

  const fabSizeRef = useRef<Size>({ width: FAB_SIZE, height: FAB_SIZE });
  const fab = useDraggablePosition(
    'pilot-console-floating-chat-fab-pos',
    () => ({ x: window.innerWidth - FAB_SIZE - MARGIN, y: window.innerHeight - FAB_SIZE - MARGIN }),
    fabSizeRef
  );

  const winSizeRef = useRef<Size>({ width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT });
  const win = useDraggablePosition(
    'pilot-console-floating-chat-window-pos',
    () => ({
      x: window.innerWidth - DEFAULT_WINDOW_WIDTH - MARGIN,
      y: window.innerHeight - DEFAULT_WINDOW_HEIGHT - MARGIN,
    }),
    winSizeRef
  );

  const winPosRef = useRef<Position>(win.pos);
  winPosRef.current = win.pos;

  const resize = useResizableSize(
    'pilot-console-floating-chat-window-size',
    { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT },
    winPosRef
  );
  winSizeRef.current = resize.size;

  if (!open) {
    return (
      <button
        onPointerDown={fab.onPointerDown}
        onPointerMove={fab.onPointerMove}
        onPointerUp={(e) => {
          suppressClickRef.current = fab.hasMoved();
          fab.onPointerUp(e);
        }}
        onClick={() => {
          if (!suppressClickRef.current) setOpen(true);
          suppressClickRef.current = false;
        }}
        className={`fixed z-50 flex h-12 w-12 touch-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 hover:opacity-90 ${fab.dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ left: fab.pos.x, top: fab.pos.y }}
        aria-label="Chat with Chief of Staff or a Project Lead"
        title="Chat with Chief of Staff or a Project Lead (drag to move)"
        data-testid="floating-lead-chat-button"
      >
        <MessageCircle className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div
      className="fixed z-50 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
      style={{ left: win.pos.x, top: win.pos.y, width: resize.size.width, height: resize.size.height }}
    >
      <div
        className={`flex items-center gap-1 border-b p-2 touch-none select-none ${win.dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={win.onPointerDown}
        onPointerMove={win.onPointerMove}
        onPointerUp={win.onPointerUp}
      >
        <GripHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
        {selection && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setSelection(null)}
            aria-label="Back to list"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <MessageCircle className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {selection
              ? selection.kind === 'chief_of_staff'
                ? 'Chief of Staff'
                : `Project Lead · ${selection.projectName}`
              : 'Talk to a lead'}
          </span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7"
          onClick={() => setOpen(false)}
          aria-label="Close chat"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!selection ? (
          <div className="h-full overflow-y-auto p-2">
            <button
              onClick={() => setSelection({ kind: 'chief_of_staff' })}
              className="mb-1 flex w-full items-center gap-2 rounded p-2 text-left text-sm hover:bg-accent"
              data-testid="floating-lead-chat-cos"
            >
              <Users className="h-4 w-4" /> Chief of Staff
            </button>
            {projects.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">No projects yet.</p>
            ) : (
              projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelection({ kind: 'project_lead', projectId: p.id, projectName: p.name })}
                  className="flex w-full items-center gap-2 rounded p-2 text-left text-sm hover:bg-accent"
                >
                  <UserRound className="h-4 w-4 shrink-0" />
                  <span className="truncate">{p.name} — Project Lead</span>
                </button>
              ))
            )}
          </div>
        ) : selection.kind === 'chief_of_staff' ? (
          <AgentPane active sessionKind="chief_of_staff" fontFamily={fontFamily} fontSize={fontSize} />
        ) : (
          <AgentPane
            key={selection.projectId}
            projectId={selection.projectId}
            active
            sessionKind="project_lead"
            fontFamily={fontFamily}
            fontSize={fontSize}
          />
        )}
      </div>
      <div
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
        className={`absolute bottom-0 right-0 h-4 w-4 touch-none ${resize.resizing ? 'cursor-nwse-resize' : 'cursor-nwse-resize opacity-40 hover:opacity-80'}`}
        title="Drag to resize"
        aria-label="Resize chat window"
      >
        <svg viewBox="0 0 16 16" className="h-full w-full text-muted-foreground" fill="none">
          <path d="M14 2L2 14M14 8L8 14M14 14L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

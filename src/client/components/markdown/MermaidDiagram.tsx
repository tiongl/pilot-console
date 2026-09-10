'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Download, Maximize2, Minus, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const MERMAID_MIN_SCALE = 0.2;
const MERMAID_MAX_SCALE = 8;

export default function MermaidDiagram({
  chart,
  darkMode,
  className,
}: {
  chart: string;
  darkMode: boolean;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fittedViewRef = useRef({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setSvg(null);
      setError(null);
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: darkMode ? 'dark' : 'default',
        });
        const result = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }

    renderDiagram();
    return () => { cancelled = true; };
  }, [chart, darkMode, id]);

  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); }, [chart]);

  const naturalSize = useMemo(() => {
    if (!svg) return null;
    const match = svg.match(/viewBox="([-\d.eE+\s]+)"/);
    if (!match) return null;
    const parts = match[1].trim().split(/\s+/).map(Number);
    if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return null;
    return { width: parts[2], height: parts[3] };
  }, [svg]);

  const fit = useCallback(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return;
    const current = viewRef.current.scale || 1;
    const rect = content.getBoundingClientRect();
    const naturalWidth = naturalSize?.width ?? rect.width / current;
    const naturalHeight = naturalSize?.height ?? rect.height / current;
    if (!naturalWidth || !naturalHeight || !frame.clientWidth || !frame.clientHeight) return;
    const padding = 24;
    const scale = Math.min(
      MERMAID_MAX_SCALE,
      Math.max(
        MERMAID_MIN_SCALE,
        Math.min(
          Math.max(1, frame.clientWidth - padding) / naturalWidth,
          Math.max(1, frame.clientHeight - padding) / naturalHeight,
        ),
      ),
    );
    const fitted = {
      scale,
      x: Math.max(0, (frame.clientWidth - naturalWidth * scale) / 2),
      y: Math.max(0, (frame.clientHeight - naturalHeight * scale) / 2),
    };
    fittedViewRef.current = fitted;
    setView(fitted);
  }, [naturalSize]);

  useEffect(() => {
    if (!svg) return;
    const raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [svg, fit]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !svg || typeof ResizeObserver === 'undefined') return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) { first = false; return; }
      fit();
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [svg, fit]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const frame = frameRef.current;
    setView((prev) => {
      const scale = Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, prev.scale * factor));
      if (scale === prev.scale) return prev;
      const rect = frame?.getBoundingClientRect();
      const anchorX = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? 0) / 2;
      const anchorY = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? 0) / 2;
      const ratio = scale / prev.scale;
      return {
        scale,
        x: anchorX - (anchorX - prev.x) * ratio,
        y: anchorY - (anchorY - prev.y) * ratio,
      };
    });
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, [svg, zoomAt]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: viewRef.current.x, originY: viewRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setView((prev) => ({
      ...prev,
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    }));
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === frameRef.current) void document.exitFullscreen();
    else void frameRef.current?.requestFullscreen();
  }, []);

  const download = useCallback((format: 'svg' | 'png') => {
    if (!svg) return;
    const save = (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `mermaid-diagram.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    };
    if (format === 'svg') {
      save(new Blob([svg], { type: 'image/svg+xml' }));
      return;
    }
    const image = new Image();
    image.onload = () => {
      const size = naturalSize ?? { width: image.width, height: image.height };
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) save(blob);
      }, 'image/png');
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [naturalSize, svg]);

  if (error) {
    return (
      <pre className="mb-3 overflow-x-auto rounded bg-[#2d2d2d] p-3 text-xs text-red-300">
        Mermaid render error: {error}
      </pre>
    );
  }

  if (!svg) {
    return <div className="mb-3 rounded border border-border p-4 text-sm text-muted-foreground">Rendering Mermaid diagram...</div>;
  }

  const fitted = fittedViewRef.current;
  const zoomed =
    Math.abs(view.scale - fitted.scale) > 0.001 ||
    Math.abs(view.x - fitted.x) > 0.5 ||
    Math.abs(view.y - fitted.y) > 0.5;
  const sizeClass = isFullscreen ? 'h-screen w-screen' : (className ?? 'h-[60vh] min-h-[240px]');

  return (
    <div
      ref={frameRef}
      data-testid="mermaid-diagram"
      role="img"
      aria-label="Mermaid diagram"
      className={`group relative mb-3 overflow-hidden rounded border border-border bg-background ${sizeClass}`}
    >
      <div
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          ref={contentRef}
          className="inline-block origin-top-left [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            width: naturalSize ? `${naturalSize.width}px` : undefined,
            height: naturalSize ? `${naturalSize.height}px` : undefined,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <div className="absolute right-2 top-2 flex items-center gap-1 rounded border border-border bg-background/90 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Zoom out" aria-label="Zoom out"
          onClick={() => zoomAt(1 / 1.25)}>
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[4ch] text-center text-[10px] tabular-nums text-muted-foreground">
          {Math.round(view.scale * 100)}%
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Zoom in" aria-label="Zoom in"
          onClick={() => zoomAt(1.25)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Fit to view (or double-click)" aria-label="Fit diagram to view"
          onClick={fit} disabled={!zoomed}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Download SVG" aria-label="Download SVG"
          onClick={() => download('svg')}>
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Download PNG" aria-label="Download PNG"
          onClick={() => download('png')}>
          <span className="text-[9px] font-semibold">PNG</span>
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen diagram'} aria-label="Toggle diagram fullscreen"
          onClick={toggleFullscreen}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="pointer-events-none absolute bottom-1.5 left-2 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        Drag to pan · Ctrl/⌘ + scroll to zoom · double-click to fit
      </div>
    </div>
  );
}

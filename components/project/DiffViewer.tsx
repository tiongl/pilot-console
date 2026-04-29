'use client';

import { useMemo, useState } from 'react';
import { html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { Columns2, AlignJustify } from 'lucide-react';

type ViewMode = 'line-by-line' | 'side-by-side';

interface Props {
  diff: string;
  defaultMode?: ViewMode;
  showToggle?: boolean;
}

export default function DiffViewer({ diff, defaultMode = 'line-by-line', showToggle = true }: Props) {
  const [mode, setMode] = useState<ViewMode>(defaultMode);

  const rendered = useMemo(() => {
    if (!diff || diff === 'No changes') return '';
    return html(diff, {
      outputFormat: mode,
      drawFileList: false,
      matching: 'lines',
      colorScheme: 'auto',
    });
  }, [diff, mode]);

  if (!diff || diff === 'No changes') {
    return <p className="text-xs text-muted-foreground text-center py-4">No changes</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {showToggle && (
        <div className="flex items-center gap-1 justify-end px-2">
          <button
            onClick={() => setMode('line-by-line')}
            className={`p-1 rounded text-xs ${mode === 'line-by-line' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Unified view"
          >
            <AlignJustify className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setMode('side-by-side')}
            className={`p-1 rounded text-xs ${mode === 'side-by-side' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Side-by-side view"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div
        className="diff-viewer-container overflow-auto text-xs"
        dangerouslySetInnerHTML={{ __html: rendered }}
      />
    </div>
  );
}

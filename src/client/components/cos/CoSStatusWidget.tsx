import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Bell, CircleAlert, GitMerge, X } from 'lucide-react';
import { Button } from '../ui/button';

interface AlertRow {
  projectId: string;
  projectName: string;
  kind: 'blocked' | 'stale' | 'merge' | 'decision';
  label: string;
  detail: string;
}

export default function CoSStatusWidget() {
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/portfolio-alerts');
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setRows(data.rows || []);
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (rows.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80">
      {!open ? (
        <Button className="ml-auto flex shadow-lg" size="sm" onClick={() => setOpen(true)}>
          <Bell className="mr-2 h-4 w-4" />
          {rows.length} CoS alert{rows.length === 1 ? '' : 's'}
        </Button>
      ) : (
        <div className="rounded-lg border bg-background p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CircleAlert className="h-4 w-4 text-amber-500" /> Portfolio attention
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setOpen(false)} aria-label="Close alerts">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-2">
            {rows.map((row, index) => (
              <Link key={`${row.projectId}-${row.kind}-${index}`} to={`/projects/${row.projectId}/lead`} className="block rounded border p-2 text-xs hover:bg-accent">
                <div className="flex items-center gap-1 font-medium">
                  {row.kind === 'merge' ? <GitMerge className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
                  {row.projectName}: {row.label}
                </div>
                <div className="mt-1 text-muted-foreground">{row.detail}</div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

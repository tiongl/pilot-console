'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import type { SessionWithUser } from '@/types';

interface SessionRow extends SessionWithUser {
  isActive: boolean;
}

interface Props {
  sessions: SessionRow[];
}

export default function ActiveSessionsTable({ sessions }: Props) {
  const [terminating, setTerminating] = useState<string | null>(null);
  const [visibleSessions, setVisibleSessions] = useState(sessions);

  async function terminateSession(sessionId: string) {
    setTerminating(sessionId);
    const res = await fetch(`/api/admin/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    setTerminating(null);
    if (res.ok) {
      toast.success('Session terminated');
      setVisibleSessions(prev => prev.filter(s => s.id !== sessionId));
    } else {
      toast.error('Failed to terminate session');
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Session ID</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Ended</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleSessions.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-mono text-xs">{s.id.slice(0, 12)}…</TableCell>
            <TableCell>
              <div className="text-sm">{s.userDisplayName ?? '—'}</div>
              <div className="text-xs text-muted-foreground">{s.userEmail ?? '—'}</div>
            </TableCell>
            <TableCell>
              <Badge variant={s.isActive ? 'default' : 'secondary'}>
                {s.isActive ? 'Active' : 'Ended'}
              </Badge>
            </TableCell>
            <TableCell className="text-sm">{new Date(s.startedAt).toLocaleString()}</TableCell>
            <TableCell className="text-sm">{s.endedAt ? new Date(s.endedAt).toLocaleString() : '—'}</TableCell>
            <TableCell>
              {s.isActive && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => terminateSession(s.id)}
                  disabled={terminating === s.id}
                >
                  Terminate
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

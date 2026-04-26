import { auth } from '@/lib/auth';
import { getDb } from '@/lib/app-db';
import { NextResponse } from 'next/server';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const rows = getDb()
    .prepare(`
      SELECT cs.*, u.display_name as user_display_name
      FROM cli_sessions cs
      LEFT JOIN users u ON cs.user_id = u.id
      WHERE cs.project_id = ?
      ORDER BY cs.started_at DESC
    `)
    .all(id);

  return NextResponse.json(rows);
}

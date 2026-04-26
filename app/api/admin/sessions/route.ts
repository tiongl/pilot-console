import { auth } from '@/lib/auth';
import { listAllSessions } from '@/lib/session-store';
import { getAllSessions, endCliSession } from '@/lib/cli-bridge';
import { NextResponse, NextRequest } from 'next/server';
import type { Session } from 'next-auth';

function isAdmin(session: Session | null) {
  return session?.user?.role === 'admin';
}

export async function GET() {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const dbSessions = listAllSessions();
  const activeSessions = getAllSessions().map((s) => s.sessionId);

  return NextResponse.json(
    dbSessions.map((s) => ({ ...s, isActive: activeSessions.includes(s.id) })),
  );
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { sessionId } = await req.json() as { sessionId: string };
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  endCliSession(sessionId);
  return NextResponse.json({ ok: true });
}

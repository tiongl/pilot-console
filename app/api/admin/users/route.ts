import { auth } from '@/lib/auth';
import { listUsers, updateUserRole, deleteUser } from '@/lib/user-store';
import { NextResponse, NextRequest } from 'next/server';
import type { Session } from 'next-auth';

function isAdmin(session: Session | null) {
  return session?.user?.role === 'admin';
}

export async function GET() {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(listUsers());
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id, role } = await req.json() as { id: string; role: 'admin' | 'user' };
  if (!id || !['admin', 'user'].includes(role)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  updateUserRole(id, role);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  // Prevent self-deletion
  if (id === session!.user.id) return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
  deleteUser(id);
  return NextResponse.json({ ok: true });
}

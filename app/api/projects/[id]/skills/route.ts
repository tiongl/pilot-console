import { auth } from '@/lib/auth';
import { listSkills, addSkill, updateSkill, deleteSkill } from '@/lib/project-store';
import { NextResponse } from 'next/server';
import type { SkillType } from '@/types';

const VALID_TYPES: SkillType[] = ['mcp_server', 'custom_instructions', 'repo_context'];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  return NextResponse.json(listSkills(id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { type, name, config } = body as { type?: SkillType; name?: string; config?: Record<string, unknown> };

  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const skill = addSkill(id, type, name.trim(), config ?? {});
  return NextResponse.json(skill, { status: 201 });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { skillId, ...fields } = body as { skillId: string; name?: string; config?: Record<string, unknown>; enabled?: boolean };

  if (!skillId) return NextResponse.json({ error: 'skillId is required' }, { status: 400 });

  try {
    const skill = updateSkill(skillId, fields);
    return NextResponse.json(skill);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const skillId = searchParams.get('skillId');
  if (!skillId) return NextResponse.json({ error: 'skillId query param required' }, { status: 400 });

  deleteSkill(skillId);
  return NextResponse.json({ ok: true });
}

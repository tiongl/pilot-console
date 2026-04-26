'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { User } from '@/types';

interface Props {
  users: User[];
}

export default function UserTable({ users }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function changeRole(id: string, role: 'admin' | 'user') {
    setLoading(id);
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, role }),
    });
    setLoading(null);
    if (res.ok) {
      toast.success('Role updated');
      router.refresh();
    } else {
      toast.error('Failed to update role');
    }
  }

  async function deleteUser(id: string) {
    if (!confirm('Delete this user?')) return;
    setLoading(id);
    const res = await fetch('/api/admin/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setLoading(null);
    if (res.ok) {
      toast.success('User deleted');
      router.refresh();
    } else {
      const { error } = await res.json() as { error: string };
      toast.error(error ?? 'Failed to delete user');
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => (
          <TableRow key={u.id}>
            <TableCell className="font-medium">{u.displayName ?? '—'}</TableCell>
            <TableCell>{u.email ?? '—'}</TableCell>
            <TableCell>
              <Select
                value={u.role}
                onValueChange={(v) => changeRole(u.id, v as 'admin' | 'user')}
                disabled={loading === u.id}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {new Date(u.createdAt).toLocaleDateString()}
            </TableCell>
            <TableCell>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteUser(u.id)}
                disabled={loading === u.id}
              >
                Delete
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

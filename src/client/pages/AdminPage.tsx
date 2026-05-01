import { useEffect, useState } from 'react';
import UserTable from '../components/admin/UserTable';

interface User {
  id: string;
  githubLogin: string;
  displayName: string | null;
  role: string;
  createdAt: string;
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    fetch('/api/admin/users')
      .then(r => r.json())
      .then(data => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h2 className="text-2xl font-bold">User Management</h2>
        <p className="text-muted-foreground mt-1">Manage user roles and access</p>
      </div>
      <UserTable users={users} />
    </div>
  );
}

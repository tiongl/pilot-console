import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import UserTable from '../components/admin/UserTable';
import { Clock, Users } from 'lucide-react';

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
      <div className="flex items-center gap-4 mb-2">
        <Link
          to="/admin"
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent"
        >
          <Users className="h-4 w-4" />
          Users
        </Link>
        <Link
          to="/automation/config"
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Clock className="h-4 w-4" />
          Automation Config
        </Link>
      </div>
      <div>
        <h2 className="text-2xl font-bold">User Management</h2>
        <p className="text-muted-foreground mt-1">Manage user roles and access</p>
      </div>
      <UserTable users={users} />
    </div>
  );
}

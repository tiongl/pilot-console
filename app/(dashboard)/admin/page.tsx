import { listUsers } from '@/lib/user-store';
import UserTable from '@/components/admin/UserTable';

export default function AdminPage() {
  const users = listUsers();

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

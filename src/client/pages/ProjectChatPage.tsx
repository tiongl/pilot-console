import { useParams } from 'react-router';
import { useAuth } from '../lib/auth-context';
import TerminalPane from '../../../components/terminal/TerminalPane';

export default function ProjectChatPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  if (!id) return <div className="p-6 text-muted-foreground">Project not found</div>;

  return (
    <div className="flex flex-col h-full">
      <TerminalPane projectId={id} />
    </div>
  );
}

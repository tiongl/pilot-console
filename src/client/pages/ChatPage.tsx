import { useAuth } from '../lib/auth-context';
import TerminalPane from '../../../components/terminal/TerminalPane';

export default function ChatPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-2">
        <h2 className="text-sm font-semibold">Copilot CLI Chat</h2>
        <p className="text-xs text-muted-foreground">General session (no project context)</p>
      </div>
      <div className="flex-1">
        <TerminalPane />
      </div>
    </div>
  );
}

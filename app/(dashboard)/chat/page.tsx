import { auth } from '@/lib/auth';
import ChatClient from './ChatClient';

export default async function ChatPage() {
  const session = await auth();
  return <ChatClient userName={session?.user?.name ?? null} />;
}

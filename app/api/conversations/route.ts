import { getMessages, listConversations } from '@/lib/memory/store';

export function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  return Response.json(id ? getMessages(id) : listConversations());
}

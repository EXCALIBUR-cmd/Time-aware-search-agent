import { noticeForAnswerBy } from '@/lib/agent/fallback';
import { mainModel } from '@/lib/config';
import { getMessages, listConversations } from '@/lib/memory/store';

export function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json(listConversations());
  const main = mainModel();
  const withNotices = getMessages(id).map((message) => ({ ...message, notice: noticeForAnswerBy(message.model, main) }));
  return Response.json(withNotices);
}

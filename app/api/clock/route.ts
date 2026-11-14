import { formatInTimeZone } from 'date-fns-tz';
import { isDemo, now, tz } from '@/lib/config';
import { demoHistoryDays } from '@/scripts/demo-history';

export const dynamic = 'force-dynamic';

export function GET() {
  const serverNow = now();
  const demo = isDemo();
  return Response.json({
    now: serverNow.toISOString(),
    demoDay: demo ? formatInTimeZone(serverNow, tz(), 'EEE d MMM yyyy') : null,
    demoHistory: demo ? demoHistoryDays(tz()) : null,
  });
}

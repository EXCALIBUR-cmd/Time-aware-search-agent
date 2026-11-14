import { formatInTimeZone } from 'date-fns-tz';
import { isDemo, now, tz } from '@/lib/config';

export const dynamic = 'force-dynamic';

export function GET() {
  const serverNow = now();
  return Response.json({
    now: serverNow.toISOString(),
    demoDay: isDemo() ? formatInTimeZone(serverNow, tz(), 'EEE d MMM yyyy') : null,
  });
}

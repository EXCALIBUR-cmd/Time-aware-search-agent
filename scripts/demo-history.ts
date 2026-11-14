import { saveClaims, saveMessage, type Claim } from '../lib/memory/store';

export const DEMO_NOW = '2026-11-09T10:00:00+05:30';

type Chat = { id: string; at: string; ask: string; answer: string; claims: Claim[] };
const price = (subject: string, plan: string, value: string, sourceUrl: string): Claim => ({
  subject,
  attribute: `${plan} plan price`,
  value,
  sourceUrl,
});

export const DEMO_CHATS: Chat[] = [
  {
    id: 'seed-crm',
    at: '2026-11-02T11:00:00+05:30',
    ask: 'Shortlist 5 CRM tools for a 20-person sales team, with pricing.',
    answer: `Shortlist for a 20-person sales team (per user per month, billed annually):

| Tool | Plan | Price |
|---|---|---|
| HubSpot Sales Hub | Starter | $20 [1] |
| Pipedrive | Growth | $39 [2] |
| Zoho CRM | Professional | $23 [3] |
| Salesforce | Starter Suite | $25 [4] |
| Freshsales | Growth | $11 [5] |

Sources: [1] https://www.hubspot.com/pricing/sales [2] https://www.pipedrive.com/en/pricing [3] https://www.zoho.com/crm/zohocrm-pricing.html [4] https://www.salesforce.com/small-business/pricing/ [5] https://www.freshworks.com/crm/pricing/ (checked 2 Nov 2026)`,
    claims: [
      price('HubSpot Sales Hub', 'Starter', '$20/user/month', 'https://www.hubspot.com/pricing/sales'),
      price('Pipedrive', 'Growth', '$39/user/month', 'https://www.pipedrive.com/en/pricing'),
      price('Zoho CRM', 'Professional', '$23/user/month', 'https://www.zoho.com/crm/zohocrm-pricing.html'),
      price('Salesforce', 'Starter Suite', '$25/user/month', 'https://www.salesforce.com/small-business/pricing/'),
      price('Freshsales', 'Growth', '$11/user/month', 'https://www.freshworks.com/crm/pricing/'),
    ],
  },
  {
    id: 'seed-pg',
    at: '2026-11-03T15:30:00+05:30',
    ask: 'Compare Postgres hosting prices: Neon, Supabase and Render.',
    answer: `Entry paid plans for managed Postgres:

| Host | Plan | Price |
|---|---|---|
| Neon | Launch | $19/month [1] |
| Supabase | Pro | $25/month [2] |
| Render | Basic | from $6/month [3] |

Sources: [1] https://neon.com/pricing [2] https://supabase.com/pricing [3] https://render.com/pricing (checked 3 Nov 2026)`,
    claims: [
      price('Neon', 'Launch', '$19/month', 'https://neon.com/pricing'),
      price('Supabase', 'Pro', '$25/month', 'https://supabase.com/pricing'),
      price('Render Postgres', 'Basic', 'from $6/month', 'https://render.com/pricing'),
    ],
  },
  {
    id: 'seed-next',
    at: '2026-11-06T09:45:00+05:30',
    ask: "What's the latest stable Next.js version?",
    answer: 'Next.js 16 is the latest stable major version [1].\n\nSources: [1] https://nextjs.org/blog (checked 6 Nov 2026)',
    claims: [{ subject: 'Next.js', attribute: 'latest stable major version', value: '16', sourceUrl: 'https://nextjs.org/blog' }],
  },
];

export function saveDemoHistory(): void {
  for (const c of DEMO_CHATS) {
    const at = new Date(c.at);
    saveMessage({ id: `${c.id}-q`, conversationId: c.id, role: 'user', content: c.ask, at, demo: true });
    const answerAt = new Date(at.getTime() + 20_000);
    saveClaims(saveMessage({ id: `${c.id}-a`, conversationId: c.id, role: 'assistant', content: c.answer, at: answerAt }), c.claims, answerAt);
  }
}

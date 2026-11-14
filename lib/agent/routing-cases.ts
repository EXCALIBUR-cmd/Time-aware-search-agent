import type { Mode, RoutingContext } from './router';

export type RoutingCase = RoutingContext & { text: string; hasPastDate: boolean; expected: Mode };

const noContext: RoutingContext = { previousQuestion: '', subjectsInMemory: [] };
const postgresChat = 'Compare current pricing for Neon, Supabase, Render and Railway Postgres hosting';
const postgresSubjects = ['Neon', 'Supabase', 'Render Postgres'];
const crmSubjects = ['HubSpot Sales Hub', 'Pipedrive', 'Zoho CRM', 'Salesforce', 'Freshsales'];

const labelled = (
  expected: Mode,
  text: string,
  extra: Partial<RoutingContext> & { hasPastDate?: boolean } = {},
): RoutingCase => ({ ...noContext, hasPastDate: false, ...extra, text, expected });

export const ROUTING_CASES: RoutingCase[] = [
  labelled('chat', 'Thanks!'),
  labelled('chat', 'who are you'),
  labelled('chat', 'hi there'),
  labelled('fresh', "What's the latest Next.js version?"),
  labelled('fresh', postgresChat),
  labelled('fresh', 'And which of those is cheapest?', { previousQuestion: postgresChat, subjectsInMemory: postgresSubjects }),
  labelled('fresh', 'Is Supabase or Neon better for a small SaaS app right now?', { subjectsInMemory: postgresSubjects }),
  labelled('fresh', 'What does the Tavily search API cost per month?'),
  labelled('recall', 'What did we talk about regarding Postgres hosting?', { subjectsInMemory: postgresSubjects }),
  labelled('recall', 'do you remember my name?'),
  labelled('recall', 'What did I ask you on 3 November?', { hasPastDate: true, subjectsInMemory: postgresSubjects }),
  labelled('recall', 'What did we discuss last week?', { hasPastDate: true, subjectsInMemory: postgresSubjects }),
  labelled('reverify', 'Has any pricing changed since then?', {
    previousQuestion: 'Compare Postgres hosting prices',
    subjectsInMemory: postgresSubjects,
  }),
  labelled('reverify', 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', {
    hasPastDate: true,
    subjectsInMemory: postgresSubjects,
  }),
  labelled(
    'reverify',
    'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    { hasPastDate: true, subjectsInMemory: crmSubjects },
  ),
  labelled('reverify', 'What did I ask you on 3 November? Is your answer still correct today?', {
    hasPastDate: true,
    subjectsInMemory: postgresSubjects,
  }),
  labelled('reverify', 'Is the Neon price you told me still right?', { subjectsInMemory: ['Neon'] }),
  labelled('reverify', 'Has any of the CRM tools changed pricing or shipped something big?', { subjectsInMemory: crmSubjects }),
];

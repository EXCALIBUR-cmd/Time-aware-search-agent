import { getDb } from '../lib/memory/db';
import { DEMO_CHATS, saveDemoHistory } from './demo-history';

export { DEMO_NOW } from './demo-history';
process.env.DB_PATH = 'data/demo.db';

const demo = 'SELECT id FROM conversations WHERE is_demo = 1';
const demoMessages = `SELECT id FROM messages WHERE conversation_id IN (${demo})`;
getDb().exec(`
  DELETE FROM memory_fts WHERE ref_id IN (${demoMessages});
  DELETE FROM claims WHERE message_id IN (${demoMessages});
  DELETE FROM messages WHERE conversation_id IN (${demo});
  DELETE FROM conversations WHERE is_demo = 1;
`);
saveDemoHistory();
console.log(`Seeded ${DEMO_CHATS.length} demo conversations (2 to 6 Nov 2026) into ${process.env.DB_PATH}.`);

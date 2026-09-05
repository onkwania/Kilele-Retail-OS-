import 'dotenv/config';
import { backupDatabase } from './backup-engine.js';
import { now } from './core.js';
const source = process.env.DATABASE_PATH ?? './data/kilele.sqlite',
  destination = process.argv[2] ?? `./data/backups/kilele-${now().replace(/[:.]/g, '-')}.sqlite`;
console.log(JSON.stringify(await backupDatabase(source, destination), null, 2));

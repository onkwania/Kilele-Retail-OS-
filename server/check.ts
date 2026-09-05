import 'dotenv/config';
import { createDb } from './db.js';
import { integrity } from './core.js';
const db = createDb(process.env.DATABASE_PATH ?? './data/kilele.sqlite');
const result = integrity(db);
console.log(JSON.stringify(result,null,2));
db.close();
if (!result.ok) process.exit(1);

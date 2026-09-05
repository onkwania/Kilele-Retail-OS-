import 'dotenv/config';
import Database from 'better-sqlite3';
import { integrity } from './core.js';
const db = new Database(process.env.DATABASE_PATH ?? './data/kilele.sqlite', {
  readonly: true,
  fileMustExist: true,
});
const result = integrity(db);
console.log(JSON.stringify(result, null, 2));
db.close();
if (!result.ok) process.exit(1);

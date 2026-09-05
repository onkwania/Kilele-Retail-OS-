import 'dotenv/config';
import { z } from 'zod';
import { guardEnvironment } from './environment.js';
import { seedCatalogue } from './catalogue.js';
import { createDb, bootstrap } from './db.js';
const input = z
  .object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(12),
    business: z.string().min(2),
  })
  .parse({
    name: process.env.BOOTSTRAP_NAME,
    email: process.env.BOOTSTRAP_EMAIL,
    password: process.env.BOOTSTRAP_PASSWORD,
    business: process.env.BUSINESS_NAME,
  });
const db = createDb(process.env.DATABASE_PATH ?? './data/kilele.sqlite');
guardEnvironment(db, false, true);
const actor = bootstrap(db, input);
seedCatalogue(db, actor);
console.log(`Workspace created for ${actor.email}. Remove bootstrap credentials from your environment.`);
db.close();

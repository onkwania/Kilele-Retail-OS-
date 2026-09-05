import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createDb, actorFor } from './db.js';
import { seedCatalogue } from './catalogue.js';
import { one, requireThat, can } from './core.js';
const path = process.env.DATABASE_PATH ?? './data/kilele.sqlite';
requireThat(existsSync(path), 'Database does not exist. Check DATABASE_PATH.');
const db = createDb(path);
try {
  const email = process.env.CATALOGUE_ACTOR_EMAIL;
  requireThat(email, 'Set CATALOGUE_ACTOR_EMAIL to the administrator authorising this import.');
  const user = one(db, 'SELECT id FROM users WHERE email=? AND active=1', email),
    actor = user ? actorFor(db, user.id) : null;
  requireThat(
    actor && can(actor, 'products.write'),
    'An active, authorised product administrator is required.',
  );
  seedCatalogue(db, actor, true);
  console.log(
    'Missing sourced listings imported. Existing metadata, prices, stock and historical records were not changed.',
  );
} finally {
  db.close();
}

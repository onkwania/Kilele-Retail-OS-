import { all, one, now, requireThat, type DB } from './core.js';
export function needsMigration(db: DB) {
  return (
    !!one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='purchases'") &&
    !all(db, 'PRAGMA table_info(purchases)').some((c) => c.name === 'replaces_id')
  );
}
/** Transactional SQLite constraint migration. Existing field values and all child IDs are copied verbatim. */
export function migrateExisting(db: DB, schema: string) {
  if (!needsMigration(db)) return;
  requireThat(
    db.inTransaction,
    'Migrations must run inside the complete schema/guard initialisation transaction.',
    500,
  );
  const definition = (table: string) => {
    const begin = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = schema.indexOf('\n);', begin);
    if (begin < 0 || end < 0) throw new Error(`Missing migration table definition: ${table}`);
    return schema.slice(begin, end + 4);
  };
  for (const table of ['sales', 'sale_items', 'purchases', 'sale_reversals']) {
    const oldColumns = all(db, `PRAGMA table_info(${table})`)
      .map((c) => c.name)
      .join(',');
    const temp = `${table}_v2`;
    db.exec(definition(table).replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${temp}`));
    db.exec(`INSERT INTO ${temp}(${oldColumns}) SELECT ${oldColumns} FROM ${table}`);
    if (
      one(db, `SELECT COUNT(*) n FROM ${table}`)!.n !== one(db, `SELECT COUNT(*) n FROM ${temp}`)!.n ||
      all(db, `SELECT ${oldColumns} FROM ${table} EXCEPT SELECT ${oldColumns} FROM ${temp}`).length
    )
      throw new Error(`Migration did not preserve ${table}`);
    db.exec(`DROP TABLE ${table}; ALTER TABLE ${temp} RENAME TO ${table};`);
  }
  if (all(db, 'PRAGMA foreign_key_check').length) throw new Error('Migration foreign-key validation failed');
  db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(2,?)').run(now());
}

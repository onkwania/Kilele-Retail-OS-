import { type DB, one, now } from './core.js';
/** Database provenance is permanent. Preview data can never be promoted to live books. */
export function guardEnvironment(db: DB, preview: boolean, production: boolean) {
  const marked = !!one(db, "SELECT kind FROM environment_markers WHERE kind='preview'");
  const legacyPreview = !!one(db, "SELECT id FROM users WHERE email LIKE '%@preview.kilele.local' LIMIT 1");
  if (production && preview) throw new Error('Preview mode is prohibited in production.');
  if ((marked || legacyPreview) && !preview)
    throw new Error(
      'This database has preview provenance and cannot be used outside isolated preview mode. Bootstrap a clean production database.',
    );
  if (preview) {
    if (
      one(db, "SELECT kind FROM environment_markers WHERE kind='operational'") ||
      (!marked && !legacyPreview && one(db, 'SELECT id FROM users LIMIT 1'))
    )
      throw new Error(
        'Refusing to enable preview authentication on an operational database. Use a separate preview database.',
      );
    db.prepare("INSERT OR IGNORE INTO environment_markers(kind,created_at) VALUES('preview',?)").run(now());
  } else if (production) {
    db.prepare("INSERT OR IGNORE INTO environment_markers(kind,created_at) VALUES('operational',?)").run(
      now(),
    );
  }
}

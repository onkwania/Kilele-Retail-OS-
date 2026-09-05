import { type DB, one, now } from './core.js';
/** User-editable email addresses must never grant preview authentication or override explicit provenance. */
export function guardEnvironment(db: DB, preview: boolean, production: boolean) {
  const marked = !!one(db, "SELECT kind FROM environment_markers WHERE kind='preview'");
  const operational = !!one(db, "SELECT kind FROM environment_markers WHERE kind='operational'");
  const legacyProof = !!one(db, "SELECT id FROM audit_logs WHERE action='auth.preview_login' LIMIT 1");
  const legacyHint =
    !operational && !!one(db, "SELECT id FROM users WHERE email LIKE '%@preview.kilele.local' LIMIT 1");
  if (production && preview) throw new Error('Preview mode is prohibited in production.');
  if ((marked || legacyProof || legacyHint) && !preview)
    throw new Error(
      'This database has preview provenance or an unclassified legacy preview identity. It cannot be promoted to live books. Bootstrap a clean operational database.',
    );
  if (preview) {
    if (operational || (!marked && !legacyProof && one(db, 'SELECT id FROM users LIMIT 1')))
      throw new Error(
        'Refusing preview authentication on an operational or unclassified populated database. User email addresses cannot authorise preview access.',
      );
    db.prepare("INSERT OR IGNORE INTO environment_markers(kind,created_at) VALUES('preview',?)").run(now());
  } else if (production)
    db.prepare("INSERT OR IGNORE INTO environment_markers(kind,created_at) VALUES('operational',?)").run(
      now(),
    );
}

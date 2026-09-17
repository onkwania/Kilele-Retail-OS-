import { now } from '../core.js';
import { insert, one } from './query.js';
import { transaction } from './transaction.js';

/**
 * Environment provenance on PostgreSQL - the async port of `guardEnvironment()` in
 * server/environment.ts.
 *
 * A database that has ever been used as an isolated preview must never be promoted to live books,
 * and a live database must never accept preview authentication. SQLite enforced that with a marker
 * table plus two fallbacks for databases that predate the marker; the same three signals are read
 * here, with the same wording, so an operator sees one behaviour regardless of engine:
 *
 *   - `environment_markers.kind = 'preview'`      written the first time preview mode runs
 *   - an `auth.preview_login` audit row           proof from a database that predates the marker
 *   - a `*@preview.kilele.local` user             legacy preview identity, only when nothing says
 *                                                 the database is operational
 *
 * Email addresses are user-editable, so they can never *grant* preview access - they can only
 * refuse a promotion. That asymmetry is the point of this module.
 */

export type EnvironmentReport = {
  preview: boolean;
  production: boolean;
  markedPreview: boolean;
  markedOperational: boolean;
  legacyPreviewLogin: boolean;
  legacyPreviewIdentity: boolean;
  /** Which marker this call wrote, if any. */
  markerWritten: 'preview' | 'operational' | null;
};

export async function guardEnvironment(options: {
  preview: boolean;
  production: boolean;
}): Promise<EnvironmentReport> {
  const { preview, production } = options;
  return transaction(async (tx) => {
    const markedPreview = !!(await one(tx, "SELECT kind FROM environment_markers WHERE kind = 'preview'"));
    const markedOperational = !!(await one(
      tx,
      "SELECT kind FROM environment_markers WHERE kind = 'operational'",
    ));
    const legacyPreviewLogin = !!(await one(
      tx,
      "SELECT id FROM audit_logs WHERE action = 'auth.preview_login' LIMIT 1",
    ));
    // SQLite's LIKE is case-insensitive for ASCII; PostgreSQL's is not, so lower() keeps the two
    // engines agreeing about what counts as a preview identity.
    const legacyPreviewIdentity =
      !markedOperational &&
      !!(await one(tx, "SELECT id FROM users WHERE lower(email) LIKE '%@preview.kilele.local' LIMIT 1"));

    if (production && preview) throw new Error('Preview mode is prohibited in production.');
    if ((markedPreview || legacyPreviewLogin || legacyPreviewIdentity) && !preview)
      throw new Error(
        'This database has preview provenance or an unclassified legacy preview identity. It cannot be promoted to live books. Bootstrap a clean operational database.',
      );

    let markerWritten: EnvironmentReport['markerWritten'] = null;
    if (preview) {
      const populated = !!(await one(tx, 'SELECT id FROM users LIMIT 1'));
      if (markedOperational || (!markedPreview && !legacyPreviewLogin && populated))
        throw new Error(
          'Refusing preview authentication on an operational or unclassified populated database. User email addresses cannot authorise preview access.',
        );
      await insert(
        tx,
        'environment_markers',
        { kind: 'preview', created_at: now() },
        { onConflict: '(kind) DO NOTHING' },
      );
      markerWritten = 'preview';
    } else if (production) {
      await insert(
        tx,
        'environment_markers',
        { kind: 'operational', created_at: now() },
        { onConflict: '(kind) DO NOTHING' },
      );
      markerWritten = 'operational';
    }
    return {
      preview,
      production,
      markedPreview,
      markedOperational,
      legacyPreviewLogin,
      legacyPreviewIdentity,
      markerWritten,
    };
  });
}

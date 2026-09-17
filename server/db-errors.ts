/**
 * Engine-neutral database error classification.
 *
 * Both HTTP surfaces (server/app.ts on SQLite, server/postgres/app.ts on PostgreSQL) must answer
 * a failed write the same way, and both must be able to tell "the database is not there" apart
 * from "these credentials are wrong". That distinction is a safety property, not cosmetics: a
 * till that receives 401 for a network outage will tell the cashier their password is wrong, and
 * a till that receives 503 for a bad password invites them to retry forever.
 *
 * This module imports nothing, so either engine can use it without pulling in the other's driver.
 */

/** SQLite constraint failures. */
const SQLITE_CONSTRAINT_PREFIXES = ['SQLITE_CONSTRAINT'];

/**
 * PostgreSQL SQLSTATEs that mean "the database refused this write":
 * 23502 not_null_violation, 23503 foreign_key_violation, 23505 unique_violation,
 * 23514 check_violation, P0001 raise_exception (every financial guard trigger uses it).
 */
const PG_CONSTRAINT_CODES = new Set(['23502', '23503', '23505', '23514', 'P0001']);

/** True when the database rejected the statement itself rather than failing to run it. */
export function isConstraintError(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? '');
  if (SQLITE_CONSTRAINT_PREFIXES.some((prefix) => code.startsWith(prefix))) return true;
  return PG_CONSTRAINT_CODES.has(code);
}

/**
 * SQLSTATEs and driver codes that mean the server could not be reached or refused the connection.
 * 28P01/28000 are authentication and authorisation failures, 3D000 a missing database, 57P01-03
 * a server that is shutting down or not accepting connections yet.
 */
const CONNECTION_CODES = new Set([
  '28000',
  '28P01',
  '3D000',
  '57P01',
  '57P02',
  '57P03',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

const CONNECTION_MESSAGE =
  /no pg_hba\.conf entry|no encryption|SSL|TLS|Connection terminated unexpectedly|connect(?:ion)? (?:timeout|refused)|ECONNREFUSED|ENOTFOUND|password authentication failed|does not exist/i;

/**
 * True when the failure is about reaching or authenticating to the database, not about the data.
 * Deliberately narrow: an ordinary query error must not be reported as an outage.
 */
export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: string }).code ?? '');
  if (CONNECTION_CODES.has(code)) return true;
  // A TLS or pg_hba refusal can arrive without a SQLSTATE the driver surfaces to us.
  const message =
    error instanceof Error ? error.message : String((error as { message?: string }).message ?? '');
  return CONNECTION_MESSAGE.test(message) && !isConstraintError(error);
}

/** Turns a driver error into the action an operator needs to take. Never echoes a secret. */
export function explainConnectionFailure(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  // A plain object is not an Error, but pg wraps some failures that way; never print
  // "[object Object]" to an operator trying to diagnose a deploy.
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: string })?.message ?? JSON.stringify(error) ?? '');
  if (code === '28P01') {
    return (
      'PostgreSQL rejected the credentials in DATABASE_URL (SQLSTATE 28P01). Copy the connection string ' +
      "from the database provider's own dashboard, keep it in the server environment only, and never in a VITE_* variable."
    );
  }
  // Checked before the generic 28000 branch: "no pg_hba.conf entry ... no encryption" is the
  // classic symptom of a server that requires TLS, not of a wrong password.
  if (/pg_hba|no encryption|SSL|TLS/i.test(message)) {
    return (
      `The database refused this connection's transport security (${message}). Supabase requires TLS: ` +
      'set DATABASE_SSL=require, or verify-full when the platform CA bundle is installed.'
    );
  }
  if (code === '28000') {
    return (
      `PostgreSQL refused the role or database in DATABASE_URL (SQLSTATE 28000: ${message}). ` +
      'Check the role name, and that it is allowed to connect from this host.'
    );
  }
  if (code === '3D000') return `The database named in DATABASE_URL does not exist (${message}).`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return `Cannot resolve the database host in DATABASE_URL (${message}). Check the hostname and DNS egress from this host.`;
  if (code === 'ECONNREFUSED')
    return `Nothing accepted the connection to the database host (${message}). Check the port, and whether the provider requires the client IP to be allow-listed.`;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET')
    return `The database connection timed out or was reset (${message}). Check the network path, and use the provider's pooled host if this service runs behind a connection limit.`;
  if (code === '57P01' || code === '57P02' || code === '57P03')
    return `The database is shutting down or not accepting connections yet (SQLSTATE ${code}: ${message}). Retry once the platform reports the instance as healthy.`;
  return `Could not connect to PostgreSQL: ${message}`;
}

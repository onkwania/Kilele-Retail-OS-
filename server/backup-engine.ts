import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { integrity, now } from './core.js';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function inspectBackup(path: string) {
  const db = new Database(resolve(path), { readonly: true, fileMustExist: true });
  try {
    const result = integrity(db);
    if (!result.ok) throw new Error('Database validation failed: ' + result.errors.join('; '));
    return result;
  } finally {
    db.close();
  }
}
/** SQLite's online backup API produces a consistent standalone snapshot, including committed WAL pages. */
export async function backupDatabase(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  if (from === to || existsSync(to) || existsSync(to + '.manifest.json'))
    throw new Error('Backup destination must be new; refusing to overwrite any file.');
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const staging = to + '.partial';
  if (existsSync(staging)) throw new Error('Partial backup already exists. Inspect it before continuing.');
  const db = new Database(from, { readonly: true, fileMustExist: true });
  try {
    writeFileSync(staging, '', { flag: 'wx', mode: 0o600 });
    await db.backup(staging);
    const checked = inspectBackup(staging);
    chmodSync(staging, 0o600);
    const manifest = {
      format: 'kilele-sqlite-backup-v1',
      created_at: now(),
      sha256: digest(staging),
      audit_events: checked.auditEvents,
      verified: true,
    };
    renameSync(staging, to);
    writeFileSync(to + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return { ...manifest, path: to };
  } catch (e) {
    rmSync(staging, { force: true });
    throw e;
  } finally {
    db.close();
  }
}
/** Restore only to a fresh path. Stop the application and explicitly switch DATABASE_PATH after testing. */
export function restoreBackup(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  if (existsSync(to) || existsSync(to + '-wal') || existsSync(to + '-shm'))
    throw new Error('Restore destination must be empty; live databases are never overwritten.');
  const manifest = JSON.parse(readFileSync(from + '.manifest.json', 'utf8'));
  if (manifest.format !== 'kilele-sqlite-backup-v1' || manifest.sha256 !== digest(from))
    throw new Error('Backup checksum or manifest does not match. Restore refused.');
  inspectBackup(from);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  chmodSync(to, 0o600);
  try {
    return { path: to, ...inspectBackup(to) };
  } catch (e) {
    rmSync(to, { force: true });
    throw e;
  }
}

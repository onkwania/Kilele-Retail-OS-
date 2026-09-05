import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  linkSync,
  openSync,
  readSync,
  closeSync,
  fsyncSync,
  statSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { integrity, now } from './core.js';
/** Bounded memory even when the database contains years of documents. */
function digest(path: string) {
  const hash = createHash('sha256'),
    fd = openSync(path, 'r'),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  if (process.platform !== 'win32') syncFile(path);
}
function unused(path: string) {
  if (existsSync(path) || existsSync(path + '-wal') || existsSync(path + '-shm'))
    throw new Error('Destination must be empty; refusing to overwrite existing database files.');
}
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
/** SQLite online backup, then atomic no-clobber publication. A failed competing job never removes another job’s staging. */
export async function backupDatabase(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  unused(to);
  if (from === to || existsSync(to + '.manifest.json'))
    throw new Error('Backup destination must be new; refusing to overwrite any file.');
  const parent = dirname(to);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, '.kilele-backup-')),
    file = join(stage, 'snapshot.sqlite'),
    manifestFile = join(stage, 'manifest.json');
  let db: Database.Database | undefined;
  try {
    db = new Database(from, { readonly: true, fileMustExist: true });
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    await db.backup(file);
    const check = inspectBackup(file);
    chmodSync(file, 0o600);
    syncFile(file);
    const manifest = {
      format: 'kilele-sqlite-backup-v1',
      created_at: now(),
      sha256: digest(file),
      audit_events: check.auditEvents,
      verified: true,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncFile(manifestFile);
    // link() atomically fails if another process published this name; rename() would overwrite it.
    linkSync(file, to);
    linkSync(manifestFile, to + '.manifest.json');
    syncDirectory(parent);
    return { ...manifest, path: to };
  } finally {
    db?.close();
    rmSync(stage, { recursive: true, force: true });
  }
}
/** A restore is published only after the COPIED bytes and their ledger match the saved manifest. */
export function restoreBackup(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  unused(to);
  const manifest = JSON.parse(readFileSync(from + '.manifest.json', 'utf8'));
  if (
    manifest.format !== 'kilele-sqlite-backup-v1' ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw new Error('Backup checksum or manifest does not match. Restore refused.');
  if (existsSync(from + '-wal') && statSync(from + '-wal').size > 0)
    throw new Error('Backup has a nonempty WAL; use a verified standalone online snapshot.');
  const parent = dirname(to);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, '.kilele-restore-')),
    file = join(stage, 'snapshot.sqlite');
  try {
    copyFileSync(from, file, constants.COPYFILE_EXCL);
    chmodSync(file, 0o600);
    if (digest(file) !== manifest.sha256)
      throw new Error('Backup checksum does not match the copied bytes. Restore refused.');
    const result = inspectBackup(file);
    syncFile(file);
    unused(to);
    linkSync(file, to);
    syncDirectory(parent);
    return { path: to, ...result };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

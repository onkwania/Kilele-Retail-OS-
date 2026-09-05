import { afterEach, describe, it, expect, vi } from 'vitest';
const injection = vi.hoisted(() => ({ alternate: '' }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    copyFileSync: (
      source: import('node:fs').PathLike,
      destination: import('node:fs').PathLike,
      flags?: number,
    ) => {
      actual.copyFileSync(source, destination, flags);
      if (injection.alternate && String(destination).includes('.kilele-restore-'))
        actual.copyFileSync(injection.alternate, destination);
    },
  };
});
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { backupDatabase, restoreBackup, inspectBackup } from '../server/backup-engine.js';
import type { DB } from '../server/core.js';
let db: DB;
const dirs: string[] = [];
afterEach(() => {
  db?.close();
  injection.alternate = '';
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('Backup publication and copied-byte verification', () => {
  it('keeps one valid complete snapshot when two jobs race for the same destination', async () => {
    const f = fixture();
    db = f.db;
    const dir = mkdtempSync(join(tmpdir(), 'kilele-backup-race-'));
    dirs.push(dir);
    const source = join(dir, 'source.sqlite'),
      backup = join(dir, 'same.sqlite');
    await db.backup(source);
    const results = await Promise.allSettled([
      backupDatabase(source, backup),
      backupDatabase(source, backup),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(inspectBackup(backup).ok).toBe(true);
    expect(JSON.parse(readFileSync(backup + '.manifest.json', 'utf8')).verified).toBe(true);
    expect(restoreBackup(backup, join(dir, 'restored.sqlite')).ok).toBe(true);
  });
  it('refuses a valid but different database substituted during copying and never publishes it', async () => {
    const f = fixture();
    db = f.db;
    const dir = mkdtempSync(join(tmpdir(), 'kilele-restore-race-'));
    dirs.push(dir);
    const source = join(dir, 'source.sqlite'),
      backup = join(dir, 'backup.sqlite'),
      alternate = join(dir, 'alternate.sqlite'),
      destination = join(dir, 'destination.sqlite');
    await db.backup(source);
    await backupDatabase(source, backup);
    const different = fixture();
    await different.db.backup(alternate);
    different.db.close();
    injection.alternate = alternate;
    expect(() => restoreBackup(backup, destination)).toThrow(/copied bytes/);
    expect(existsSync(destination)).toBe(false);
    expect(inspectBackup(backup).ok).toBe(true);
  });
});

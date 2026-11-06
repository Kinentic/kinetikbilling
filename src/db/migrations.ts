// Versioned schema: the `NNNN_name.sql` files in src/db/migrations/ are the list.
// 0001_baseline.sql uses `create table if not exists`, so a fresh database and a
// v0.1 database (user_version 0) take the same path.

import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  /** 1-based, from the file name prefix. */
  version: number;
  name: string;
  sql: string;
}

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Reads the directory's `NNNN_name.sql` files in version order. Numbering must be 1..n without gaps or duplicates. */
export function loadMigrations(dir: URL = new URL('./migrations/', import.meta.url)): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.map((file, i) => {
    const m = FILE_NAME.exec(file);
    if (!m) throw new Error(`migration ${file} is not named NNNN_name.sql`);
    const version = Number(m[1]);
    if (version !== i + 1) throw new Error(`migrations must be numbered 1..n without gaps; ${file} is at position ${i + 1}`);
    return { version, name: m[2]!, sql: readFileSync(new URL(file, dir), 'utf8') };
  });
}

const userVersion = (db: DatabaseSync): number => (db.prepare('pragma user_version').get() as { user_version: number }).user_version;

/**
 * Applies every migration above the database's `user_version`, each in its own
 * transaction with foreign keys off (table rebuilds need it) and a
 * `foreign_key_check` before commit. A second call finds nothing to do; a crash
 * mid-migration rolls that migration back and the next open retries it.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): { from: number; to: number } {
  const from = userVersion(db);
  let to = from;
  for (const m of migrations) {
    if (m.version <= from) continue;
    db.exec('pragma foreign_keys = off');
    db.exec('begin');
    try {
      db.exec(m.sql);
      const violations = db.prepare('pragma foreign_key_check').all();
      if (violations.length > 0) throw new Error(`migration ${m.version} ${m.name} leaves foreign key violations: ${JSON.stringify(violations[0])}`);
      db.exec(`pragma user_version = ${m.version}`);
      db.exec('commit');
      to = m.version;
    } catch (e) {
      db.exec('rollback');
      throw e;
    } finally {
      db.exec('pragma foreign_keys = on');
    }
  }
  return { from, to };
}

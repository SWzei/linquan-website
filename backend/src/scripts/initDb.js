import fs from 'fs';
import path from 'path';
import db from '../config/db.js';
import '../config/env.js';
import { DATABASE_URL } from '../config/env.js';
import { createStandardSlots } from '../utils/semester.js';

function readSchema() {
  const candidates = [
    path.resolve(process.cwd(), '../database/schema.sql'),
    path.resolve(process.cwd(), 'database/schema.sql')
  ];
  const schemaFile = candidates.find((file) => fs.existsSync(file));
  if (!schemaFile) {
    throw new Error('Cannot find database/schema.sql');
  }
  return fs.readFileSync(schemaFile, 'utf-8');
}

function ensureDefaultSemester() {
  const existing = db.prepare('SELECT id FROM semesters WHERE is_active = 1 LIMIT 1').get();
  if (existing) {
    createStandardSlots(db, existing.id);
    return;
  }

  const now = new Date();
  const year = now.getFullYear();
  const season = now.getMonth() < 6 ? 'Spring' : 'Fall';
  const startDate = `${year}-${season === 'Spring' ? '02-15' : '09-01'}`;
  const endDate = `${year}-${season === 'Spring' ? '07-15' : '01-20'}`;
  const name = `${year} ${season}`;

  const tx = db.transaction(() => {
    db.prepare('UPDATE semesters SET is_active = 0').run();
    const result = db
      .prepare(
        `INSERT INTO semesters (name, start_date, end_date, is_active)
         VALUES (?, ?, ?, 1)`
      )
      .run(name, startDate, endDate);
    const semesterId = Number(result.lastInsertRowid);
    createStandardSlots(db, semesterId);
  });

  tx();
}

function main() {
  if (DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.log('DATABASE_URL detected. Skip SQLite init script.');
    return;
  }

  const schema = readSchema();
  db.exec(schema);
  ensureDefaultSemester();
  // eslint-disable-next-line no-console
  console.log('Database initialized successfully.');
}

main();

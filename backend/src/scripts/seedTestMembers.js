import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { assertTestMemberSeedAllowed } from '../utils/disposableDatabaseGuard.js';

function parseCount() {
  const arg = Number(process.argv[2]);
  const envCount = Number(process.env.TEST_MEMBER_COUNT || 30);
  const raw = Number.isFinite(arg) && arg > 0 ? arg : envCount;
  return Math.max(1, Math.floor(raw));
}

function makeRng(seed) {
  let value = seed | 0;
  return function next() {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function shuffled(array, rng) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function resolveSemesterId(db) {
  const active = db
    .prepare(
      `SELECT id
       FROM semesters
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    )
    .get();
  if (active?.id) {
    return active.id;
  }
  const latest = db
    .prepare(
      `SELECT id
       FROM semesters
       ORDER BY id DESC
       LIMIT 1`
    )
    .get();
  return latest?.id || null;
}

async function main() {
  const { testPrefix } = assertTestMemberSeedAllowed();
  const { default: db } = await import('../config/db.js');
  const count = parseCount();
  const studentPrefix = testPrefix;
  const testPassword = process.env.TEST_MEMBER_PASSWORD;
  const withPreferences = String(process.env.TEST_MEMBER_PREFS || 'true').toLowerCase() !== 'false';
  const resetPreferences = String(process.env.TEST_MEMBER_RESET_PREFS || 'false').toLowerCase() === 'true';

  const semesterId = resolveSemesterId(db);
  const slotIds = semesterId
    ? db
      .prepare(
        `SELECT id
         FROM room_slots
         WHERE semester_id = ?
         ORDER BY day_of_week, hour, room_no`
      )
      .all(semesterId)
      .map((item) => item.id)
    : [];

  if (withPreferences && !semesterId) {
    // eslint-disable-next-line no-console
    console.log('No semester found. Members will be created without slot preferences.');
  }
  if (withPreferences && semesterId && slotIds.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`Semester ${semesterId} has no slots. Members will be created without slot preferences.`);
  }

  const passwordHash = bcrypt.hashSync(testPassword, 10);
  const insertUser = db.prepare(
    `INSERT INTO users (student_number, email, password_hash, role, account_type, is_admin)
     VALUES (?, ?, ?, 'member', 'member', 0)`
  );
  const upsertProfile = db.prepare(
    `INSERT INTO profiles (
       user_id, public_id, display_name, bio, grade, academy, major, hobbies, piano_interests, wechat_account
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = excluded.display_name,
       bio = excluded.bio,
       grade = excluded.grade,
       academy = excluded.academy,
       major = excluded.major,
       hobbies = excluded.hobbies,
       piano_interests = excluded.piano_interests,
       wechat_account = excluded.wechat_account,
       updated_at = CURRENT_TIMESTAMP`
  );
  const deletePrefs = db.prepare(
    `DELETE FROM slot_preferences
     WHERE semester_id = ? AND user_id = ?`
  );
  const countPrefs = db.prepare(
    `SELECT COUNT(*) AS count
     FROM slot_preferences
     WHERE semester_id = ? AND user_id = ?`
  );
  const insertPref = db.prepare(
    `INSERT OR IGNORE INTO slot_preferences (semester_id, user_id, slot_id)
     VALUES (?, ?, ?)`
  );

  let createdUsers = 0;
  let existingUsers = 0;
  let insertedPreferences = 0;
  const seededMembers = [];

  const tx = db.transaction(() => {
    for (let i = 1; i <= count; i += 1) {
      const suffix = String(i).padStart(4, '0');
      const studentNumber = `${studentPrefix}${suffix}`;
      const email = `seed.member.${suffix}@nju-linquan.test`;
      const displayName = `测试社员${suffix}`;

      let user = db
        .prepare('SELECT id FROM users WHERE student_number = ?')
        .get(studentNumber);
      if (!user) {
        const result = insertUser.run(studentNumber, email, passwordHash);
        user = { id: Number(result.lastInsertRowid) };
        createdUsers += 1;
      } else {
        existingUsers += 1;
      }

      const userId = Number(user.id);
      upsertProfile.run(
        userId,
        crypto.randomUUID(),
        displayName,
        '用于排班功能测试的自动生成账号。',
        '2024级本',
        '计算机学院',
        '软件工程',
        '练琴、听音乐',
        '古典钢琴',
        `linquan_seed_${suffix}`
      );

      seededMembers.push({ userId, studentNumber, displayName });

      if (!withPreferences || !semesterId || slotIds.length === 0) {
        continue;
      }

      if (resetPreferences) {
        deletePrefs.run(semesterId, userId);
      } else {
        const existingPrefCount = Number(countPrefs.get(semesterId, userId)?.count || 0);
        if (existingPrefCount > 0) {
          continue;
        }
      }

      const rng = makeRng(userId * 97 + semesterId * 131);
      const target = Math.min(slotIds.length, 6 + Math.floor(rng() * 7)); // 6-12
      const selectedSlots = shuffled(slotIds, rng).slice(0, target);
      for (const slotId of selectedSlots) {
        const result = insertPref.run(semesterId, userId, slotId);
        insertedPreferences += Number(result.changes || 0);
      }
    }
  });

  tx();

  // eslint-disable-next-line no-console
  console.log(`Seeded test members: requested=${count}, created=${createdUsers}, existing=${existingUsers}`);
  if (withPreferences && semesterId && slotIds.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Preferences: semester=${semesterId}, slots=${slotIds.length}, inserted=${insertedPreferences}, reset=${resetPreferences}`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('Preferences: skipped');
  }
  // eslint-disable-next-line no-console
  console.log('Sample accounts:');
  seededMembers.slice(0, 8).forEach((item) => {
    // eslint-disable-next-line no-console
    console.log(`  ${item.studentNumber}  ${item.displayName}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`Test-member seeding refused or failed: ${err.message}`);
  process.exitCode = 1;
});

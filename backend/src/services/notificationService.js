import db from '../config/db.js';
import { sendEmail } from './emailService.js';

export function queueNotifications({
  userIds,
  subject,
  content,
  relatedType = null,
  relatedId = null
}) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { total: 0, failed: 0, queued: 0, deliveries: [] };
  }

  const uniqueUserIds = [...new Set(userIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)))];
  if (uniqueUserIds.length === 0) {
    return { total: 0, failed: 0, queued: 0, deliveries: [] };
  }

  const placeholders = uniqueUserIds.map(() => '?').join(', ');
  const users = db
    .prepare(
      `SELECT id, email
       FROM users
       WHERE id IN (${placeholders}) AND is_active = 1`
    )
    .all(...uniqueUserIds);

  const insertNotification = db.prepare(
    `INSERT INTO notifications (user_id, channel, subject, content, status, related_type, related_id)
     VALUES (?, 'email', ?, ?, ?, ?, ?)`
  );
  let failed = 0;
  let queued = 0;
  const deliveries = [];

  for (const user of users) {
    const initialStatus = user.email ? 'queued' : 'failed';
    const result = insertNotification.run(
      user.id,
      subject,
      content,
      initialStatus,
      relatedType,
      relatedId
    );
    const notificationId = result.lastInsertRowid;

    if (!user.email) {
      failed += 1;
      continue;
    }
    deliveries.push({ notificationId: Number(notificationId), email: user.email });
    queued += 1;
  }

  return { total: users.length, failed, queued, deliveries };
}

export async function deliverQueuedNotifications(queue, { subject, content }) {
  const updateStatus = db.prepare(
    'UPDATE notifications SET status = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  let sent = 0;
  let failed = Number(queue?.failed || 0);
  let queued = 0;

  for (const delivery of queue?.deliveries || []) {
    try {
      const emailResult = await sendEmail({ to: delivery.email, subject, text: content });
      if (emailResult.sent) {
        updateStatus.run('sent', delivery.notificationId);
        sent += 1;
      } else {
        queued += 1;
      }
    } catch (err) {
      updateStatus.run('failed', delivery.notificationId);
      failed += 1;
    }
  }
  return { total: Number(queue?.total || 0), sent, failed, queued };
}

export async function notifyUsers(input) {
  const queue = queueNotifications(input);
  return deliverQueuedNotifications(queue, input);
}

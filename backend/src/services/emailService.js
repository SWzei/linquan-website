import nodemailer from 'nodemailer';
import { SMTP_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from '../config/env.js';

let transporter = null;

function getTransporter() {
  if (transporter) {
    return transporter;
  }

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  return transporter;
}

export async function sendEmail({ to, subject, text }) {
  const mailer = getTransporter();
  if (!mailer) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  await mailer.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    text
  });

  return { sent: true };
}

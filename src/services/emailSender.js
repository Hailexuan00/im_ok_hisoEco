/**
 * Email Sender Module
 * Supports: Resend, SendGrid, Nodemailer (Gmail SMTP)
 */

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'nodemailer';
const EMAIL_API_KEY = process.env.EMAIL_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@imok.app';
const FROM_NAME = process.env.FROM_NAME || 'IMOK Safety Check';

console.log(`[Email] Provider: ${EMAIL_PROVIDER}, From: ${FROM_EMAIL}`);

/**
 * Send email
 */
async function sendEmail({ to, subject, text, html }) {
  console.log(`[Email] Sending to ${to}: ${subject}`);

  try {
    switch (EMAIL_PROVIDER.toLowerCase()) {
      case 'resend':
        return await sendViaResend({ to, subject, text, html });
      case 'sendgrid':
        return await sendViaSendGrid({ to, subject, text, html });
      case 'nodemailer':
      case 'smtp':
      default:
        return await sendViaNodemailer({ to, subject, text, html });
    }
  } catch (error) {
    console.error(`[Email] Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Resend provider
 */
async function sendViaResend({ to, subject, text, html }) {
  if (!EMAIL_API_KEY) {
    throw new Error('EMAIL_API_KEY not set for Resend');
  }

  const { Resend } = require('resend');
  const resend = new Resend(EMAIL_API_KEY);

  const { data, error } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [to],
    subject,
    text,
    html,
  });

  if (error) {
    throw new Error(error.message);
  }

  console.log(`[Email] Resend success: ${data.id}`);
  return { success: true, providerId: data.id };
}

/**
 * SendGrid provider
 */
async function sendViaSendGrid({ to, subject, text, html }) {
  if (!EMAIL_API_KEY) {
    throw new Error('EMAIL_API_KEY not set for SendGrid');
  }

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(EMAIL_API_KEY);

  const [response] = await sgMail.send({
    to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text,
    html,
  });

  const messageId = response.headers['x-message-id'];
  console.log(`[Email] SendGrid success: ${messageId}`);
  return { success: true, providerId: messageId };
}

/**
 * Nodemailer (Gmail SMTP)
 */
async function sendViaNodemailer({ to, subject, text, html }) {
  const nodemailer = require('nodemailer');

  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD not set');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: `${FROM_NAME} <${user}>`,
    to,
    subject,
    text,
    html,
  });

  console.log(`[Email] Nodemailer success: ${info.messageId}`);
  return { success: true, providerId: info.messageId };
}

/**
 * Send overdue alert email
 */
async function sendOverdueAlert(device) {
  const displayName = device.displayName || 'Someone';
  const lastCheckin = device.lastCheckinAt
    ? device.lastCheckinAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    : 'Chưa check-in';

  const graceMinutes = Math.round((device.graceSeconds || 300) / 60);

  const subject = `[IMOK] ${displayName} chưa check-in`;

  const text = `
Xin chào,

${displayName} đã không check-in trong ứng dụng IMOK.

Thông tin:
- Lần check-in cuối: ${lastCheckin}
- Đã quá hạn: ${graceMinutes} phút

Vui lòng liên hệ để đảm bảo họ an toàn.

---
IMOK Safety Check
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #e74c3c; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
    .info { background: white; padding: 15px; border-radius: 4px; margin: 15px 0; }
    .footer { text-align: center; color: #888; font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Cảnh báo IMOK</h1>
    </div>
    <div class="content">
      <p>Xin chào,</p>
      <p><strong>${displayName}</strong> đã không check-in trong ứng dụng IMOK.</p>
      <div class="info">
        <p><strong>Lần check-in cuối:</strong> ${lastCheckin}</p>
        <p><strong>Đã quá hạn:</strong> ${graceMinutes} phút</p>
      </div>
      <p>Vui lòng liên hệ để đảm bảo họ an toàn.</p>
    </div>
    <div class="footer">
      <p>IMOK Safety Check</p>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail({
    to: device.emergencyEmail,
    subject,
    text,
    html,
  });
}

module.exports = {
  sendEmail,
  sendOverdueAlert,
};

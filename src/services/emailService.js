const nodemailer = require('nodemailer');
const { db } = require('../firebaseAdmin');

/**
 * Create email transporter using Gmail SMTP
 *
 * Required environment variables:
 * - GMAIL_USER: your-email@gmail.com
 * - GMAIL_APP_PASSWORD: 16-character app password from Google
 */
function createTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('[Email] GMAIL_USER or GMAIL_APP_PASSWORD not configured');
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Send email notification using Nodemailer with Gmail
 * @param {string} toEmail - Recipient email address
 * @param {object} alertData - Alert information
 * @param {object} fromUserData - User who is overdue
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendEmailNotification(toEmail, alertData, fromUserData) {
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`[Email] Skipping email to ${toEmail} - Gmail not configured`);
    return {
      success: false,
      error: 'GMAIL_NOT_CONFIGURED',
    };
  }

  const userName = fromUserData.displayName || fromUserData.email || 'Someone';
  const fromEmail = process.env.GMAIL_USER;

  const mailOptions = {
    from: `"AliveCheck" <${fromEmail}>`,
    to: toEmail,
    subject: `⚠️ AliveCheck Alert: ${userName} may need help`,
    text: `
AliveCheck Alert

${userName} has not checked in and may need your help.

They were expected to check in but haven't responded. As their emergency contact, we wanted to alert you.

What you can do:
- Try calling or texting them directly
- Check on them if you're nearby
- Contact emergency services if you're concerned

This is an automated alert from AliveCheck.
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #ff6b6b, #ee5a5a); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 24px;">⚠️ AliveCheck Alert</h1>
  </div>

  <div style="background: #f8f9fa; padding: 30px; border: 1px solid #e9ecef; border-top: none;">
    <p style="font-size: 18px; color: #333; margin-top: 0;">
      <strong>${userName}</strong> has not checked in and may need your help.
    </p>

    <p style="color: #666; line-height: 1.6;">
      They were expected to check in but haven't responded. As their emergency contact, we wanted to alert you.
    </p>

    <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0; border-left: 4px solid #ff6b6b;">
      <h3 style="margin-top: 0; color: #333;">What you can do:</h3>
      <ul style="color: #666; line-height: 1.8; padding-left: 20px;">
        <li>Try calling or texting them directly</li>
        <li>Check on them if you're nearby</li>
        <li>Contact emergency services if you're concerned</li>
      </ul>
    </div>
  </div>

  <div style="background: #333; color: #999; padding: 20px; border-radius: 0 0 12px 12px; text-align: center; font-size: 12px;">
    <p style="margin: 0;">This is an automated alert from <strong>AliveCheck</strong></p>
  </div>
</body>
</html>
    `.trim(),
  };

  try {
    console.log(`[Email] Sending email to ${toEmail} for user ${userName}`);
    const info = await transporter.sendMail(mailOptions);

    console.log(`[Email] Successfully sent to ${toEmail}, messageId: ${info.messageId}`);
    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    console.error(`[Email] Error sending to ${toEmail}:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Send email alerts to all email contacts of a user
 * @param {string} userId - User ID who is overdue
 * @param {object} userData - User data
 * @returns {Promise<Array>} Results for each contact
 */
async function sendEmailToContacts(userId, userData) {
  const results = [];

  try {
    // Get contacts with email type
    const contactsSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('contacts')
      .where('type', '==', 'email')
      .get();

    if (contactsSnapshot.empty) {
      console.log(`[Email] No email contacts found for user ${userId}`);
      return results;
    }

    console.log(`[Email] Found ${contactsSnapshot.size} email contacts for user ${userId}`);

    for (const contactDoc of contactsSnapshot.docs) {
      const contact = contactDoc.data();
      const contactEmail = contact.value;

      if (!contactEmail) {
        console.log(`[Email] Contact ${contactDoc.id} has no email value`);
        results.push({
          contactId: contactDoc.id,
          status: 'skipped',
          error: 'NO_EMAIL',
        });
        continue;
      }

      const result = await sendEmailNotification(contactEmail, {}, userData);

      results.push({
        contactId: contactDoc.id,
        email: contactEmail,
        status: result.success ? 'sent' : 'failed',
        messageId: result.messageId,
        error: result.error,
      });
    }

    return results;
  } catch (error) {
    console.error(`[Email] Error getting contacts for user ${userId}:`, error);
    throw error;
  }
}

module.exports = {
  sendEmailNotification,
  sendEmailToContacts,
};

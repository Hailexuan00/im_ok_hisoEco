const { db } = require('../firebaseAdmin');

/**
 * Queue email via Firebase Trigger Email Extension
 *
 * This uses Firebase's "Trigger Email" extension which watches
 * a Firestore collection (default: "mail") and sends emails automatically.
 *
 * Setup required:
 * 1. Install "Trigger Email" extension in Firebase Console
 * 2. Configure SMTP settings (Gmail, SendGrid, etc.)
 * 3. Extension will watch "mail" collection and send emails
 *
 * @param {string} toEmail - Recipient email address
 * @param {object} alertData - Alert information
 * @param {object} fromUserData - User who is overdue
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendEmailNotification(toEmail, alertData, fromUserData) {
  const userName = fromUserData.displayName || fromUserData.email || 'Someone';

  const emailData = {
    to: toEmail,
    message: {
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
    },
    createdAt: new Date().toISOString(),
    fromUserId: fromUserData.uid || null,
    fromUserName: userName,
  };

  try {
    console.log(`[Email] Queuing email to ${toEmail} for user ${userName}`);

    // Add to "mail" collection - Firebase Trigger Email extension will pick it up
    const mailRef = await db.collection('mail').add(emailData);

    console.log(`[Email] Email queued successfully, docId: ${mailRef.id}`);
    return {
      success: true,
      messageId: mailRef.id,
    };
  } catch (error) {
    console.error(`[Email] Error queuing email to ${toEmail}:`, error.message);
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

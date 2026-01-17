const { db, auth } = require('../firebaseAdmin');
const admin = require('firebase-admin');

/**
 * Notification messages in different languages
 */
const NOTIFICATION_MESSAGES = {
  en: {
    alertTitle: 'Emergency Alert',
    alertBody: (userName) => `${userName} has not checked in and may need help!`,
    reminderTitle: 'Check-in Reminder',
    reminderBody: 'Please check in to let your contacts know you are okay!',
  },
  vi: {
    alertTitle: 'Cảnh báo khẩn cấp',
    alertBody: (userName) => `${userName} chưa check-in và có thể cần trợ giúp!`,
    reminderTitle: 'Nhắc nhở Check-in',
    reminderBody: 'Hãy check-in để người thân biết bạn vẫn ổn!',
  },
};

/**
 * Get notification messages based on user's language setting
 * @param {string} language - User's language preference ('en', 'vi')
 * @returns {object} Notification messages object
 */
function getMessages(language) {
  return NOTIFICATION_MESSAGES[language] || NOTIFICATION_MESSAGES['en'];
}

/**
 * Send push notification via FCM
 * @param {string} fcmToken - FCM device token
 * @param {object} notification - { title, body }
 * @param {object} data - Additional data payload
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendPushNotification(fcmToken, notification, data = {}) {
  try {
    const message = {
      token: fcmToken,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'alivecheck_alerts',
          priority: 'max',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`[FCM] Successfully sent message: ${response}`);
    return { success: true, messageId: response };
  } catch (error) {
    console.error(`[FCM] Error sending message:`, error.message);

    // Handle invalid token
    if (error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered') {
      return { success: false, error: 'INVALID_TOKEN', message: error.message };
    }

    return { success: false, error: error.code || 'UNKNOWN', message: error.message };
  }
}

/**
 * Send push notifications to all linked contacts of a user
 * OPTIMIZED: Batch fetch all linked users in ONE query instead of N queries
 * @param {string} userId - The overdue user's ID
 * @param {object} userData - The overdue user's data
 * @returns {Promise<Array<{contactId, status, messageId?, error?}>>}
 */
async function sendPushToLinkedContacts(userId, userData) {
  const results = [];
  const userName = userData.displayName || userData.email || 'Someone';

  console.log(`[Notification] ========================================`);
  console.log(`[Notification] Sending alerts for OVERDUE USER: ${userName} (${userId})`);

  try {
    // Get all contacts with type 'app' (linked users)
    const contactsSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('contacts')
      .where('type', '==', 'app')
      .get();

    if (contactsSnapshot.empty) {
      console.log(`[Notification] No linked contacts found for user ${userId}`);
      console.log(`[Notification] ========================================`);
      return results;
    }

    // Collect all linkedUids
    const contacts = [];
    const linkedUids = [];
    for (const contactDoc of contactsSnapshot.docs) {
      const contact = contactDoc.data();
      if (contact.linkedUid) {
        contacts.push({ contactId: contactDoc.id, ...contact });
        linkedUids.push(contact.linkedUid);
      } else {
        results.push({
          contactId: contactDoc.id,
          status: 'failed',
          error: 'NO_LINKED_UID',
        });
      }
    }

    if (linkedUids.length === 0) {
      console.log(`[Notification] No valid linkedUids found`);
      console.log(`[Notification] ========================================`);
      return results;
    }

    console.log(`[Notification] Found ${contacts.length} contacts to notify`);

    // OPTIMIZATION: Batch fetch all linked users in ONE query using getAll()
    const linkedUserRefs = linkedUids.map(uid => db.collection('users').doc(uid));
    const linkedUserDocs = await db.getAll(...linkedUserRefs);

    // Create a map for quick lookup
    const linkedUsersMap = new Map();
    linkedUserDocs.forEach((doc, index) => {
      if (doc.exists) {
        linkedUsersMap.set(linkedUids[index], doc.data());
      }
    });

    console.log(`[Notification] Fetched ${linkedUsersMap.size} linked users in 1 batch query`);

    // Now send notifications
    for (const contact of contacts) {
      const linkedUid = contact.linkedUid;
      const contactName = contact.name || 'Unknown';

      console.log(`[Notification]   - Contact: ${contactName}, linkedUid: ${linkedUid}`);

      const linkedUserData = linkedUsersMap.get(linkedUid);

      if (!linkedUserData) {
        console.log(`[Notification]     → SKIP: User not found in database`);
        results.push({
          contactId: contact.contactId,
          status: 'failed',
          error: 'USER_NOT_FOUND',
        });
        continue;
      }

      const fcmToken = linkedUserData.fcmToken;
      const linkedUserName = linkedUserData.displayName || linkedUserData.email || linkedUid;
      const linkedUserLanguage = linkedUserData.language || linkedUserData.settings?.language || 'en';

      if (!fcmToken) {
        console.log(`[Notification]     → SKIP: ${linkedUserName} has no FCM token`);
        results.push({
          contactId: contact.contactId,
          status: 'failed',
          error: 'NO_FCM_TOKEN',
        });
        continue;
      }

      console.log(`[Notification]     → SENDING to ${linkedUserName} (lang: ${linkedUserLanguage})`);

      // Get localized messages based on recipient's language
      const messages = getMessages(linkedUserLanguage);

      // Send push notification
      const notificationPayload = {
        title: messages.alertTitle,
        body: messages.alertBody(userName),
      };

      const dataPayload = {
        type: 'OVERDUE_ALERT',
        fromUserId: userId,
        fromUserName: userName,
      };

      const sendResult = await sendPushNotification(fcmToken, notificationPayload, dataPayload);

      if (sendResult.success) {
        console.log(`[Notification]     → SUCCESS: Sent to ${linkedUserName}`);
        results.push({
          contactId: contact.contactId,
          linkedUid,
          status: 'sent',
          messageId: sendResult.messageId,
        });
      } else {
        console.log(`[Notification]     → FAILED: ${sendResult.error}`);
        results.push({
          contactId: contact.contactId,
          linkedUid,
          status: 'failed',
          error: sendResult.error,
          message: sendResult.message,
        });

        // If token is invalid, remove it (this is rare, so 1 write is acceptable)
        if (sendResult.error === 'INVALID_TOKEN') {
          await db.collection('users').doc(linkedUid).update({
            fcmToken: admin.firestore.FieldValue.delete(),
          });
          console.log(`[FCM] Removed invalid token for user ${linkedUid}`);
        }
      }
    }

    console.log(`[Notification] ========================================`);
    return results;
  } catch (error) {
    console.error(`[Notification] Error sending to linked contacts:`, error);
    throw error;
  }
}

/**
 * Send reminder notification to the user themselves
 * @param {string} userId
 * @param {object} userData
 */
async function sendReminderToUser(userId, userData) {
  const fcmToken = userData.fcmToken;

  if (!fcmToken) {
    console.log(`[Notification] No FCM token for user ${userId}`);
    return { success: false, error: 'NO_FCM_TOKEN' };
  }

  // Get user's language preference
  const userLanguage = userData.language || userData.settings?.language || 'en';
  const messages = getMessages(userLanguage);

  const notification = {
    title: messages.reminderTitle,
    body: messages.reminderBody,
  };

  const data = {
    type: 'CHECKIN_REMINDER',
  };

  return await sendPushNotification(fcmToken, notification, data);
}

module.exports = {
  sendPushNotification,
  sendPushToLinkedContacts,
  sendReminderToUser,
};

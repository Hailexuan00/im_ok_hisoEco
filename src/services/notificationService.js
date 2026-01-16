const { db, auth } = require('../firebaseAdmin');
const admin = require('firebase-admin');

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
 * @param {string} userId - The overdue user's ID
 * @param {object} userData - The overdue user's data
 * @returns {Promise<Array<{contactId, status, messageId?, error?}>>}
 */
async function sendPushToLinkedContacts(userId, userData) {
  const results = [];

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
      return results;
    }

    const userName = userData.displayName || userData.email || 'Someone';

    for (const contactDoc of contactsSnapshot.docs) {
      const contact = contactDoc.data();
      const linkedUid = contact.linkedUid;

      if (!linkedUid) {
        results.push({
          contactId: contactDoc.id,
          status: 'failed',
          error: 'NO_LINKED_UID',
        });
        continue;
      }

      // Get linked user's FCM token
      const linkedUserDoc = await db.collection('users').doc(linkedUid).get();

      if (!linkedUserDoc.exists) {
        results.push({
          contactId: contactDoc.id,
          status: 'failed',
          error: 'USER_NOT_FOUND',
        });
        continue;
      }

      const linkedUserData = linkedUserDoc.data();
      const fcmToken = linkedUserData.fcmToken;

      if (!fcmToken) {
        results.push({
          contactId: contactDoc.id,
          status: 'failed',
          error: 'NO_FCM_TOKEN',
        });
        continue;
      }

      // Send push notification
      const notification = {
        title: 'AliveCheck Alert',
        body: `${userName} has not checked in and may need help!`,
      };

      const data = {
        type: 'OVERDUE_ALERT',
        fromUserId: userId,
        fromUserName: userName,
      };

      const sendResult = await sendPushNotification(fcmToken, notification, data);

      if (sendResult.success) {
        results.push({
          contactId: contactDoc.id,
          linkedUid,
          status: 'sent',
          messageId: sendResult.messageId,
        });
      } else {
        results.push({
          contactId: contactDoc.id,
          linkedUid,
          status: 'failed',
          error: sendResult.error,
          message: sendResult.message,
        });

        // If token is invalid, remove it from the linked user
        if (sendResult.error === 'INVALID_TOKEN') {
          await db.collection('users').doc(linkedUid).update({
            fcmToken: admin.firestore.FieldValue.delete(),
          });
          console.log(`[FCM] Removed invalid token for user ${linkedUid}`);
        }
      }
    }

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

  const notification = {
    title: 'Check-in Reminder',
    body: 'Please check in to let your contacts know you are okay!',
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

const { db } = require('../firebaseAdmin');
const admin = require('firebase-admin');
const { createAlert } = require('./alertService');

/**
 * Check all users for overdue status and create alerts
 */
async function checkOverdueUsers() {
  const now = new Date();
  console.log(`[OverdueCheck] Starting check at ${now.toISOString()}`);

  try {
    const usersSnapshot = await db.collection('users').get();
    let overdueCount = 0;
    let alertsCreated = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();

      const result = await checkAndUpdateUserStatus(userId, userData);

      if (result.isOverdue) {
        overdueCount++;
      }
      if (result.alertCreated) {
        alertsCreated++;
      }
    }

    console.log(`[OverdueCheck] Completed. Found ${overdueCount} overdue users, created ${alertsCreated} alerts`);
    return { overdueCount, alertsCreated };
  } catch (error) {
    console.error(`[OverdueCheck] Error:`, error);
    throw error;
  }
}

/**
 * Check a single user's status and update if overdue
 */
async function checkAndUpdateUserStatus(userId, userData) {
  const now = new Date();
  const status = userData.status || {};
  const policy = userData.checkinPolicy || {};

  // Skip if paused
  if (policy.isPaused) {
    return { isOverdue: false, alertCreated: false };
  }

  // Skip if no nextDueAt
  if (!status.nextDueAt) {
    return { isOverdue: false, alertCreated: false };
  }

  const nextDueAt = status.nextDueAt.toDate ? status.nextDueAt.toDate() : new Date(status.nextDueAt);
  const graceMinutes = policy.graceMinutes || 60;
  const gracePeriodEnd = new Date(nextDueAt.getTime() + graceMinutes * 60 * 1000);

  // Check if user is overdue (past grace period)
  if (now <= gracePeriodEnd) {
    // Not overdue yet, but check if we need to reset isOverdue flag
    if (status.isOverdue) {
      await db.collection('users').doc(userId).update({
        'status.isOverdue': false,
        'status.overdueSince': null,
      });
    }
    return { isOverdue: false, alertCreated: false };
  }

  // User is overdue
  const wasAlreadyOverdue = status.isOverdue === true;

  if (!wasAlreadyOverdue) {
    // Mark as overdue
    await db.collection('users').doc(userId).update({
      'status.isOverdue': true,
      'status.overdueSince': admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[OverdueCheck] User ${userId} is now overdue`);

    // Create alert
    await createAlert(userId, userData);

    return { isOverdue: true, alertCreated: true };
  }

  // Already overdue, check if we need to create another alert
  // Create new alert if:
  // 1. No pending alerts exist, OR
  // 2. Last alert was created more than 30 minutes ago (reminder interval)
  const REMINDER_INTERVAL_MINUTES = 30;

  const alertsSnapshot = await db
    .collection('users')
    .doc(userId)
    .collection('alerts')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (alertsSnapshot.empty) {
    // No alerts at all, create one
    await createAlert(userId, userData);
    return { isOverdue: true, alertCreated: true };
  }

  const lastAlert = alertsSnapshot.docs[0].data();
  const lastAlertCreatedAt = new Date(lastAlert.createdAt);
  const minutesSinceLastAlert = (now.getTime() - lastAlertCreatedAt.getTime()) / (1000 * 60);

  // Create new alert if last one was created more than 30 minutes ago
  if (minutesSinceLastAlert >= REMINDER_INTERVAL_MINUTES) {
    console.log(`[OverdueCheck] User ${userId} still overdue after ${Math.floor(minutesSinceLastAlert)} minutes, creating new alert`);
    await createAlert(userId, userData);
    return { isOverdue: true, alertCreated: true };
  }

  console.log(`[OverdueCheck] User ${userId} has recent alert (${Math.floor(minutesSinceLastAlert)} min ago), skipping`);
  return { isOverdue: true, alertCreated: false };
}

/**
 * Initialize default policy and status for a new user
 */
async function initializeUserDefaults(userId, userData) {
  const now = new Date();
  const defaultIntervalHours = 24;
  const nextDueAt = new Date(now.getTime() + defaultIntervalHours * 60 * 60 * 1000);

  const updates = {};

  // Initialize checkinPolicy if not exists
  if (!userData.checkinPolicy) {
    updates.checkinPolicy = {
      intervalHours: defaultIntervalHours,
      reminderTime: '09:00',
      graceMinutes: 60,
      isPaused: false,
      escalation: {
        steps: [
          { type: 'push', delayMinutes: 0 },
          { type: 'email', delayMinutes: 30 },
          { type: 'sms', delayMinutes: 60 },
        ],
      },
    };
  }

  // Initialize status if not exists
  if (!userData.status) {
    updates.status = {
      lastCheckinAt: null,
      nextDueAt: admin.firestore.Timestamp.fromDate(nextDueAt),
      isOverdue: false,
      overdueSince: null,
      lastEscalationAt: null,
    };
  }

  if (Object.keys(updates).length > 0) {
    await db.collection('users').doc(userId).update(updates);
    console.log(`[User] Initialized defaults for user ${userId}`);
  }

  return updates;
}

/**
 * Handle user check-in: update status and cancel alerts
 */
async function handleCheckin(userId, checkinData) {
  const { cancelPendingAlerts } = require('./alertService');
  const now = new Date();

  // Get user's policy
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new Error(`User ${userId} not found`);
  }

  const userData = userDoc.data();
  const policy = userData.checkinPolicy || {};
  const intervalHours = policy.intervalHours || 24;

  // Calculate next due time
  const nextDueAt = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);

  // Update user status
  await db.collection('users').doc(userId).update({
    'status.lastCheckinAt': admin.firestore.FieldValue.serverTimestamp(),
    'status.nextDueAt': admin.firestore.Timestamp.fromDate(nextDueAt),
    'status.isOverdue': false,
    'status.overdueSince': null,
  });

  // Cancel any pending alerts
  const cancelledCount = await cancelPendingAlerts(userId);

  console.log(`[Checkin] User ${userId} checked in. Next due: ${nextDueAt.toISOString()}. Cancelled ${cancelledCount} alerts`);

  return {
    nextDueAt,
    cancelledAlerts: cancelledCount,
  };
}

module.exports = {
  checkOverdueUsers,
  checkAndUpdateUserStatus,
  initializeUserDefaults,
  handleCheckin,
};

const { db } = require('../firebaseAdmin');
const admin = require('firebase-admin');
const { createAlert } = require('./alertService');

// Constants
const REMINDER_INTERVAL_MINUTES = 30;

/**
 * Check users for overdue status and create alerts
 * OPTIMIZED: Only query users who are potentially overdue
 */
async function checkOverdueUsers() {
  const now = new Date();
  const startTime = Date.now();
  console.log(`[OverdueCheck] Starting check at ${now.toISOString()}`);

  let readCount = 0;
  let overdueCount = 0;
  let alertsCreated = 0;
  let skippedCount = 0;

  try {
    // Get all users - Firestore != query excludes docs without the field
    // So we query all and filter in memory (still optimized by removing N+1 alerts queries)
    const usersSnapshot = await db.collection('users').get();

    readCount += usersSnapshot.size;
    console.log(`[OverdueCheck] Queried ${usersSnapshot.size} users`);

    // Filter in memory for overdue users (cheaper than multiple Firestore queries)
    const potentiallyOverdueUsers = [];

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const status = userData.status || {};
      const policy = userData.checkinPolicy || {};

      // Skip if paused
      if (policy.isPaused === true) {
        skippedCount++;
        continue;
      }

      // Skip if no nextDueAt
      if (!status.nextDueAt) {
        skippedCount++;
        continue;
      }

      const nextDueAt = status.nextDueAt.toDate ? status.nextDueAt.toDate() : new Date(status.nextDueAt);
      const graceMinutes = policy.graceMinutes || 60;
      const gracePeriodEnd = new Date(nextDueAt.getTime() + graceMinutes * 60 * 1000);

      // Check if user is overdue (past grace period)
      if (now > gracePeriodEnd) {
        // Convert lastAlertAt from Firestore Timestamp if needed
        let lastAlertAt = null;
        if (status.lastAlertAt) {
          lastAlertAt = status.lastAlertAt.toDate ? status.lastAlertAt.toDate() : new Date(status.lastAlertAt);
        }

        potentiallyOverdueUsers.push({
          userId: userDoc.id,
          userData,
          wasAlreadyOverdue: status.isOverdue === true,
          lastAlertAt,
        });
      } else if (status.isOverdue) {
        // User was overdue but now within grace period - reset flag
        await db.collection('users').doc(userDoc.id).update({
          'status.isOverdue': false,
          'status.overdueSince': null,
        });
      }
    }

    console.log(`[OverdueCheck] Found ${potentiallyOverdueUsers.length} potentially overdue users`);

    // Process overdue users
    for (const { userId, userData, wasAlreadyOverdue, lastAlertAt } of potentiallyOverdueUsers) {
      overdueCount++;

      // Check if we need to create alert
      let shouldCreateAlert = false;

      if (!wasAlreadyOverdue) {
        // First time overdue - mark as overdue and create alert
        await db.collection('users').doc(userId).update({
          'status.isOverdue': true,
          'status.overdueSince': admin.firestore.FieldValue.serverTimestamp(),
          'status.lastAlertAt': admin.firestore.FieldValue.serverTimestamp(),
        });
        shouldCreateAlert = true;
        console.log(`[OverdueCheck] User ${userId} is now overdue`);
      } else {
        // Already overdue - check reminder interval
        // OPTIMIZATION 2: Use lastAlertAt field instead of querying alerts collection
        if (!lastAlertAt) {
          shouldCreateAlert = true;
        } else {
          const minutesSinceLastAlert = (now.getTime() - lastAlertAt.getTime()) / (1000 * 60);
          if (minutesSinceLastAlert >= REMINDER_INTERVAL_MINUTES) {
            shouldCreateAlert = true;
            console.log(`[OverdueCheck] User ${userId} still overdue after ${Math.floor(minutesSinceLastAlert)} minutes`);
          } else {
            console.log(`[OverdueCheck] User ${userId} has recent alert (${Math.floor(minutesSinceLastAlert)} min ago), skipping`);
          }
        }

        if (shouldCreateAlert) {
          await db.collection('users').doc(userId).update({
            'status.lastAlertAt': admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      if (shouldCreateAlert) {
        await createAlert(userId, userData);
        alertsCreated++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[OverdueCheck] Completed in ${duration}ms. Reads: ${readCount}, Overdue: ${overdueCount}, Alerts: ${alertsCreated}, Skipped: ${skippedCount}`);

    return {
      overdueCount,
      alertsCreated,
      skippedCount,
      readCount,
      durationMs: duration,
    };
  } catch (error) {
    console.error(`[OverdueCheck] Error:`, error);
    throw error;
  }
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
      lastAlertAt: null,
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
    'status.lastAlertAt': null,
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
  initializeUserDefaults,
  handleCheckin,
};

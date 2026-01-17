const express = require('express');
const router = express.Router();
const { db } = require('../firebaseAdmin');
const { sendPushNotification, sendPushToLinkedContacts } = require('../services/notificationService');
const { checkOverdueUsers } = require('../services/userService');
const { processEscalations } = require('../services/alertService');

/**
 * POST /api/notifications/test
 * Test push notification endpoint
 * Body: { fromUserId: string }
 */
router.post('/test', async (req, res) => {
  try {
    const { fromUserId } = req.body;

    if (!fromUserId) {
      return res.status(400).json({
        ok: false,
        error: 'fromUserId is required',
      });
    }

    // Get user data
    const userDoc = await db.collection('users').doc(fromUserId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        ok: false,
        error: 'User not found',
      });
    }

    const userData = userDoc.data();

    // Send push notifications to linked contacts
    const results = await sendPushToLinkedContacts(fromUserId, userData);

    res.json({
      ok: true,
      message: 'Test notifications sent',
      results,
    });
  } catch (error) {
    console.error('[TestNotification] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/notifications/send
 * Send a direct push notification
 * Body: { fcmToken: string, title: string, body: string, data?: object }
 */
router.post('/send', async (req, res) => {
  try {
    const { fcmToken, title, body, data } = req.body;

    if (!fcmToken || !title || !body) {
      return res.status(400).json({
        ok: false,
        error: 'fcmToken, title, and body are required',
      });
    }

    const result = await sendPushNotification(
      fcmToken,
      { title, body },
      data || {}
    );

    if (result.success) {
      res.json({
        ok: true,
        messageId: result.messageId,
      });
    } else {
      res.status(400).json({
        ok: false,
        error: result.error,
        message: result.message,
      });
    }
  } catch (error) {
    console.error('[SendNotification] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/notifications/trigger-overdue-check
 * Manually trigger the overdue users check
 */
router.post('/trigger-overdue-check', async (req, res) => {
  try {
    const result = await checkOverdueUsers();
    res.json({
      ok: true,
      message: 'Overdue check completed',
      ...result,
    });
  } catch (error) {
    console.error('[TriggerOverdueCheck] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/notifications/cron
 * Endpoint for external cron services (cron-job.org, UptimeRobot, etc.)
 * Runs both overdue check and escalation processing
 * OPTIMIZED: Reduced Firestore reads significantly
 */
router.get('/cron', async (req, res) => {
  const startTime = Date.now();
  console.log('[CRON] External cron triggered at', new Date().toISOString());

  try {
    // Run overdue check
    const overdueResult = await checkOverdueUsers();

    // Run escalation processing
    const escalationResult = await processEscalations();

    const totalDuration = Date.now() - startTime;
    const totalReads = (overdueResult.readCount || 0) + (escalationResult?.readCount || 0);

    console.log(`[CRON] Completed in ${totalDuration}ms. Total reads: ${totalReads}`);

    res.json({
      ok: true,
      message: 'Cron job completed',
      overdue: {
        count: overdueResult.overdueCount,
        alertsCreated: overdueResult.alertsCreated,
        skipped: overdueResult.skippedCount,
        reads: overdueResult.readCount,
        durationMs: overdueResult.durationMs,
      },
      escalation: {
        processed: escalationResult?.processedCount || 0,
        skipped: escalationResult?.skippedCount || 0,
        reads: escalationResult?.readCount || 0,
        durationMs: escalationResult?.durationMs || 0,
      },
      totalReads,
      totalDurationMs: totalDuration,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CRON] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/notifications/trigger-escalations
 * Manually trigger escalation processing
 */
router.post('/trigger-escalations', async (req, res) => {
  try {
    await processEscalations();
    res.json({
      ok: true,
      message: 'Escalation processing completed',
    });
  } catch (error) {
    console.error('[TriggerEscalations] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/notifications/migrate-users
 * ONE-TIME migration to add root-level fields for optimized queries
 * This adds isPaused and overdueCutoff fields to all existing users
 */
router.post('/migrate-users', async (req, res) => {
  console.log('[Migration] Starting migration via API...');
  const startTime = Date.now();
  const admin = require('firebase-admin');

  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    const usersSnapshot = await db.collection('users').get();
    console.log(`[Migration] Found ${usersSnapshot.size} users to process`);

    // Process in batches of 500 (Firestore batch limit)
    const BATCH_SIZE = 500;
    let batch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();

      try {
        const policy = userData.checkinPolicy || {};
        const status = userData.status || {};

        // Get values with defaults
        const isPaused = policy.isPaused || false;
        const intervalHours = policy.intervalHours || 24;
        const graceMinutes = policy.graceMinutes || 60;

        // Calculate overdueCutoff
        let overdueCutoff;
        if (status.nextDueAt) {
          const nextDueAt = status.nextDueAt.toDate ? status.nextDueAt.toDate() : new Date(status.nextDueAt);
          overdueCutoff = new Date(nextDueAt.getTime() + graceMinutes * 60 * 1000);
        } else {
          // No nextDueAt, set overdueCutoff far in the future
          const now = new Date();
          const nextDueAt = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
          overdueCutoff = new Date(nextDueAt.getTime() + graceMinutes * 60 * 1000);
        }

        // Check if already has the fields with correct values
        if (userData.isPaused !== undefined && userData.overdueCutoff) {
          skippedCount++;
          continue;
        }

        // Add to batch
        batch.update(userDoc.ref, {
          isPaused: isPaused,
          overdueCutoff: admin.firestore.Timestamp.fromDate(overdueCutoff),
        });

        batchCount++;
        migratedCount++;

        // Commit batch if full
        if (batchCount >= BATCH_SIZE) {
          await batch.commit();
          console.log(`[Migration] Committed batch of ${batchCount} users`);
          batch = db.batch();
          batchCount = 0;
        }

      } catch (error) {
        console.error(`[Migration] Error processing user ${userId}:`, error.message);
        errorCount++;
      }
    }

    // Commit remaining batch
    if (batchCount > 0) {
      await batch.commit();
      console.log(`[Migration] Committed final batch of ${batchCount} users`);
    }

    const duration = Date.now() - startTime;
    console.log(`[Migration] Completed in ${duration}ms. Migrated: ${migratedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);

    res.json({
      ok: true,
      message: 'Migration completed',
      migratedCount,
      skippedCount,
      errorCount,
      durationMs: duration,
    });
  } catch (error) {
    console.error('[Migration] Fatal error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;

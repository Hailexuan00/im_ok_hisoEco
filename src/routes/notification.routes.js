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

module.exports = router;

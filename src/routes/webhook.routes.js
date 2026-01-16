const express = require('express');
const router = express.Router();
const { handleCheckin, initializeUserDefaults } = require('../services/userService');
const { db } = require('../firebaseAdmin');

/**
 * POST /api/webhooks/checkin
 * Webhook called when a user checks in (simulates Firestore trigger)
 * Body: { userId: string, checkinId: string }
 */
router.post('/checkin', async (req, res) => {
  try {
    const { userId, checkinId } = req.body;

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: 'userId is required',
      });
    }

    const result = await handleCheckin(userId, { checkinId });

    res.json({
      ok: true,
      message: 'Checkin processed',
      nextDueAt: result.nextDueAt.toISOString(),
      cancelledAlerts: result.cancelledAlerts,
    });
  } catch (error) {
    console.error('[WebhookCheckin] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/webhooks/user-created
 * Webhook called when a new user is created (simulates Firestore trigger)
 * Body: { userId: string }
 */
router.post('/user-created', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: 'userId is required',
      });
    }

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        ok: false,
        error: 'User not found',
      });
    }

    const userData = userDoc.data();
    const updates = await initializeUserDefaults(userId, userData);

    res.json({
      ok: true,
      message: 'User initialized',
      updates,
    });
  } catch (error) {
    console.error('[WebhookUserCreated] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;

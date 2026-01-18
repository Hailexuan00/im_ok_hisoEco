/**
 * Device Routes - No Login Required
 * Uses installId (UUID) as identifier
 */

const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebaseAdmin');

const DEVICES_COLLECTION = 'devices';
const DEFAULT_GRACE_SECONDS = 300; // 5 minutes
const DEFAULT_INTERVAL_SECONDS = 86400; // 24 hours

/**
 * Validate email format
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /api/device/upsert
 * Register or update device
 *
 * Body: {
 *   installId: string (UUID),
 *   displayName: string,
 *   emergencyEmail: string,
 *   intervalSeconds?: number (default 86400)
 * }
 */
router.post('/upsert', async (req, res) => {
  try {
    const { installId, displayName, emergencyEmail, intervalSeconds } = req.body;

    // Validation
    if (!installId || typeof installId !== 'string') {
      return res.status(400).json({ ok: false, error: 'installId is required' });
    }

    if (!emergencyEmail || !isValidEmail(emergencyEmail)) {
      return res.status(400).json({ ok: false, error: 'Valid emergencyEmail is required' });
    }

    const docRef = db.collection(DEVICES_COLLECTION).doc(installId);
    const doc = await docRef.get();
    const now = admin.firestore.Timestamp.now();

    if (doc.exists) {
      // Update existing device
      await docRef.update({
        displayName: displayName || doc.data().displayName || '',
        emergencyEmail,
        intervalSeconds: intervalSeconds || doc.data().intervalSeconds || DEFAULT_INTERVAL_SECONDS,
        updatedAt: now,
      });

      console.log(`[Device] Updated: ${installId}`);
    } else {
      // Create new device
      const interval = intervalSeconds || DEFAULT_INTERVAL_SECONDS;
      const nextDueAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + interval * 1000);

      await docRef.set({
        installId,
        displayName: displayName || '',
        emergencyEmail,
        intervalSeconds: interval,
        graceSeconds: DEFAULT_GRACE_SECONDS,
        lastCheckinAt: now,
        nextDueAt,
        status: 'OK',
        overdueNotifiedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      console.log(`[Device] Created: ${installId}`);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[Device] Upsert error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/device/checkin
 * Record a check-in
 *
 * Body: { installId: string }
 */
router.post('/checkin', async (req, res) => {
  try {
    const { installId } = req.body;

    if (!installId) {
      return res.status(400).json({ ok: false, error: 'installId is required' });
    }

    const docRef = db.collection(DEVICES_COLLECTION).doc(installId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Device not found' });
    }

    const data = doc.data();
    const now = admin.firestore.Timestamp.now();
    const intervalSeconds = data.intervalSeconds || DEFAULT_INTERVAL_SECONDS;
    const nextDueAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + intervalSeconds * 1000);

    await docRef.update({
      lastCheckinAt: now,
      nextDueAt,
      status: 'OK',
      overdueNotifiedAt: null, // Reset so next overdue can trigger alert
      updatedAt: now,
    });

    console.log(`[Device] Checkin: ${installId}, next due: ${nextDueAt.toDate().toISOString()}`);

    res.json({
      ok: true,
      nextDueAt: nextDueAt.toDate().toISOString(),
    });
  } catch (error) {
    console.error('[Device] Checkin error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/device/:installId/status
 * Get device status
 */
router.get('/:installId/status', async (req, res) => {
  try {
    const { installId } = req.params;

    const doc = await db.collection(DEVICES_COLLECTION).doc(installId).get();

    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Device not found' });
    }

    const data = doc.data();

    res.json({
      ok: true,
      data: {
        installId: data.installId,
        displayName: data.displayName,
        status: data.status,
        lastCheckinAt: data.lastCheckinAt?.toDate?.()?.toISOString() || null,
        nextDueAt: data.nextDueAt?.toDate?.()?.toISOString() || null,
        intervalSeconds: data.intervalSeconds,
        graceSeconds: data.graceSeconds,
      },
    });
  } catch (error) {
    console.error('[Device] Status error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;

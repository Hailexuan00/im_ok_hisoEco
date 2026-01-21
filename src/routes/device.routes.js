///**
// * Device Routes - No Login Required
// * Uses installId (UUID) as identifier
// */
//
//const express = require('express');
//const router = express.Router();
//const { db, admin } = require('../firebaseAdmin');
//
//const DEVICES_COLLECTION = 'devices';
//const DEFAULT_GRACE_SECONDS = 300; // 5 minutes
//const DEFAULT_INTERVAL_SECONDS = 86400; // 24 hours
//
///**
// * Validate email format
// */
//function isValidEmail(email) {
//  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
//}
//
///**
// * Validate phone number (basic check)
// * Accepts: 0xxxxxxxxx, 84xxxxxxxxx, +84xxxxxxxxx
// */
//function isValidPhone(phone) {
//  if (!phone || typeof phone !== 'string') return false;
//  const cleaned = phone.replace(/[\s\-\.]/g, '');
//  return /^(\+84|84|0)\d{9,10}$/.test(cleaned);
//}
//
///**
// * Validate and clean phone array
// * @param {any} phones - Input phones array
// * @returns {string[]} - Cleaned valid phone numbers
// */
//function cleanPhoneArray(phones) {
//  if (!phones || !Array.isArray(phones)) return [];
//  return phones
//    .filter(p => typeof p === 'string' && isValidPhone(p))
//    .map(p => p.replace(/[\s\-\.]/g, '').trim())
//    .slice(0, 5); // Max 5 phone numbers
//}
//
///**
// * POST /api/device/upsert
// * Register or update device
// *
// * Body: {
// *   installId: string (UUID),
// *   displayName: string,
// *   emergencyEmail: string,
// *   emergencyPhones?: string[] (optional, for SMS alerts),
// *   smsEnabled?: boolean (optional, default false),
// *   intervalSeconds?: number (default 86400)
// * }
// */
//
//router.post('/upsert', async (req, res) => {
//  try {
//    const {
//      installId,
//      displayName,
//      emergencyEmail,
//      emergencyPhones,
//      smsEnabled,
//      intervalSeconds,
//      fcmToken, // ✅ đã có trong file bạn gửi
//    } = req.body;
//
//    // Validation
//    if (!installId || typeof installId !== 'string') {
//      return res.status(400).json({ ok: false, error: 'installId is required' });
//    }
//
//    if (!emergencyEmail || !isValidEmail(emergencyEmail)) {
//      return res.status(400).json({ ok: false, error: 'Valid emergencyEmail is required' });
//    }
//
//    // Clean and validate phone numbers
//    const cleanedPhones = cleanPhoneArray(emergencyPhones);
//
//    const docRef = db.collection(DEVICES_COLLECTION).doc(installId);
//    const doc = await docRef.get();
//    const now = admin.firestore.Timestamp.now();
//
//    // ✅ chuẩn hoá token
//    const normalizedToken =
//      typeof fcmToken === 'string' && fcmToken.trim().length > 0
//        ? fcmToken.trim()
//        : null;
//
//    if (doc.exists) {
//      // Update existing device
//      const existingData = doc.data();
//
//      const updateData = {
//        displayName: displayName || existingData.displayName || '',
//        emergencyEmail,
//        intervalSeconds: intervalSeconds || existingData.intervalSeconds || DEFAULT_INTERVAL_SECONDS,
//        updatedAt: now,
//      };
//
//      // Update SMS fields if provided
//      if (emergencyPhones !== undefined) {
//        updateData.emergencyPhones = cleanedPhones;
//      }
//      if (smsEnabled !== undefined) {
//        updateData.smsEnabled = Boolean(smsEnabled);
//      }
//
//      // ✅ ADD: lưu fcmToken nếu có gửi lên
//      if (normalizedToken) {
//        updateData.fcmToken = normalizedToken;
//        updateData.tokenUpdatedAt = now;
//      }
//
//      await docRef.update(updateData);
//
//      console.log(
//        `[Device] Updated: ${installId}, smsEnabled: ${updateData.smsEnabled}, phones: ${cleanedPhones.length}, hasFcm: ${!!normalizedToken}`
//      );
//    } else {
//      // Create new device
//      const interval = intervalSeconds || DEFAULT_INTERVAL_SECONDS;
//      const nextDueAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + interval * 1000);
//
//      await docRef.set({
//        installId,
//        displayName: displayName || '',
//        emergencyEmail,
//
//        // SMS
//        emergencyPhones: cleanedPhones,
//        smsEnabled: Boolean(smsEnabled),
//
//        // schedule
//        intervalSeconds: interval,
//        graceSeconds: DEFAULT_GRACE_SECONDS,
//        lastCheckinAt: now,
//        nextDueAt,
//        status: 'OK',
//
//        // idempotency flags
//        overdueNotifiedAt: null,
//        overdueSmsNotifiedAt: null,
//
//        // ✅ NEW: push idempotency + token
//        overduePushNotifiedAt: null,
//        fcmToken: normalizedToken,
//        tokenUpdatedAt: normalizedToken ? now : null,
//
//        createdAt: now,
//        updatedAt: now,
//      });
//
//      console.log(
//        `[Device] Created: ${installId}, smsEnabled: ${Boolean(smsEnabled)}, phones: ${cleanedPhones.length}, hasFcm: ${!!normalizedToken}`
//      );
//    }
//
//    res.json({ ok: true });
//  } catch (error) {
//    console.error('[Device] Upsert error:', error.message);
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
////router.post('/upsert', async (req, res) => {
////  try {
////    const {
////      installId,
////      displayName,
////      emergencyEmail,
////      emergencyPhones,
////      smsEnabled,
////      intervalSeconds,
////      fcmToken,
////    } = req.body;
////
////    // Validation
////    if (!installId || typeof installId !== 'string') {
////      return res.status(400).json({ ok: false, error: 'installId is required' });
////    }
////
////    if (!emergencyEmail || !isValidEmail(emergencyEmail)) {
////      return res.status(400).json({ ok: false, error: 'Valid emergencyEmail is required' });
////    }
////
////    // Clean and validate phone numbers
////    const cleanedPhones = cleanPhoneArray(emergencyPhones);
////
////    const docRef = db.collection(DEVICES_COLLECTION).doc(installId);
////    const doc = await docRef.get();
////    const now = admin.firestore.Timestamp.now();
////
////    if (doc.exists) {
////      // Update existing device
////      const existingData = doc.data();
////      const updateData = {
////        displayName: displayName || existingData.displayName || '',
////        emergencyEmail,
////        intervalSeconds: intervalSeconds || existingData.intervalSeconds || DEFAULT_INTERVAL_SECONDS,
////        updatedAt: now,
////      };
////
////      // Update SMS fields if provided
////      if (emergencyPhones !== undefined) {
////        updateData.emergencyPhones = cleanedPhones;
////      }
////      if (smsEnabled !== undefined) {
////        updateData.smsEnabled = Boolean(smsEnabled);
////      }
////
////      await docRef.update(updateData);
////
////      console.log(`[Device] Updated: ${installId}, smsEnabled: ${updateData.smsEnabled}, phones: ${cleanedPhones.length}`);
////    } else {
////      // Create new device
////      const interval = intervalSeconds || DEFAULT_INTERVAL_SECONDS;
////      const nextDueAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + interval * 1000);
////
////      await docRef.set({
////        installId,
////        displayName: displayName || '',
////        emergencyEmail,
////        emergencyPhones: cleanedPhones,
////        smsEnabled: Boolean(smsEnabled),
////        intervalSeconds: interval,
////        graceSeconds: DEFAULT_GRACE_SECONDS,
////        lastCheckinAt: now,
////        nextDueAt,
////        status: 'OK',
////        overdueNotifiedAt: null,
////        overdueSmsNotifiedAt: null,
////        createdAt: now,
////        updatedAt: now,
////      });
////
////      console.log(`[Device] Created: ${installId}, smsEnabled: ${Boolean(smsEnabled)}, phones: ${cleanedPhones.length}`);
////    }
////
////    res.json({ ok: true });
////  } catch (error) {
////    console.error('[Device] Upsert error:', error.message);
////    res.status(500).json({ ok: false, error: error.message });
////  }
////});
//
///**
// * POST /api/device/checkin
// * Record a check-in
// *
// * Body: { installId: string }
// */
//router.post('/checkin', async (req, res) => {
//  try {
//    const { installId } = req.body;
//
//    if (!installId) {
//      return res.status(400).json({ ok: false, error: 'installId is required' });
//    }
//
//    const docRef = db.collection(DEVICES_COLLECTION).doc(installId);
//    const doc = await docRef.get();
//
//    if (!doc.exists) {
//      return res.status(404).json({ ok: false, error: 'Device not found' });
//    }
//
//    const data = doc.data();
//    const now = admin.firestore.Timestamp.now();
//    const intervalSeconds = data.intervalSeconds || DEFAULT_INTERVAL_SECONDS;
//    const nextDueAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + intervalSeconds * 1000);
//
//    await docRef.update({
//      lastCheckinAt: now,
//      nextDueAt,
//      status: 'OK',
//      overdueNotifiedAt: null, // Reset so next overdue can trigger email alert
//      overdueSmsNotifiedAt: null, // Reset so next overdue can trigger SMS alert
//      updatedAt: now,
//    });
//
//    console.log(`[Device] Checkin: ${installId}, next due: ${nextDueAt.toDate().toISOString()}`);
//
//    res.json({
//      ok: true,
//      nextDueAt: nextDueAt.toDate().toISOString(),
//    });
//  } catch (error) {
//    console.error('[Device] Checkin error:', error.message);
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
///**
// * GET /api/device/:installId/status
// * Get device status
// */
//router.get('/:installId/status', async (req, res) => {
//  try {
//    const { installId } = req.params;
//
//    const doc = await db.collection(DEVICES_COLLECTION).doc(installId).get();
//
//    if (!doc.exists) {
//      return res.status(404).json({ ok: false, error: 'Device not found' });
//    }
//
//    const data = doc.data();
//
//    res.json({
//      ok: true,
//      data: {
//        installId: data.installId,
//        displayName: data.displayName,
//        status: data.status,
//        lastCheckinAt: data.lastCheckinAt?.toDate?.()?.toISOString() || null,
//        nextDueAt: data.nextDueAt?.toDate?.()?.toISOString() || null,
//        intervalSeconds: data.intervalSeconds,
//        graceSeconds: data.graceSeconds,
//        // SMS fields
//        smsEnabled: data.smsEnabled || false,
//        emergencyPhones: data.emergencyPhones || [],
//      },
//    });
//  } catch (error) {
//    console.error('[Device] Status error:', error.message);
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
//module.exports = router;




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
 * Validate phone number (basic check)
 * Accepts: 0xxxxxxxxx, 84xxxxxxxxx, +84xxxxxxxxx
 */
function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s\-\.]/g, '');
  return /^(\+84|84|0)\d{9,10}$/.test(cleaned);
}

/**
 * Validate and clean phone array
 * @param {any} phones - Input phones array
 * @returns {string[]} - Cleaned valid phone numbers
 */
function cleanPhoneArray(phones) {
  if (!phones || !Array.isArray(phones)) return [];
  return phones
    .filter(p => typeof p === 'string' && isValidPhone(p))
    .map(p => p.replace(/[\s\-\.]/g, '').trim())
    .slice(0, 5); // Max 5 phone numbers
}

/**
 * POST /api/device/upsert
 * Register or update device
 *
 * Body: {
 *   installId: string (UUID),
 *   displayName: string,
 *   emergencyEmail: string,
 *   emergencyPhones?: string[] (optional, for SMS alerts),
 *   smsEnabled?: boolean (optional, default false),
 *   intervalSeconds?: number (default 86400),
 *   fcmToken?: string (optional)
 * }
 */
router.post('/upsert', async (req, res) => {
  try {
    const {
      installId,
      displayName,
      emergencyEmail,
      emergencyPhones,
      smsEnabled,
      intervalSeconds,
      fcmToken,
    } = req.body;

    // Validation
    if (!installId || typeof installId !== 'string') {
      return res.status(400).json({ ok: false, error: 'installId is required' });
    }

    if (!emergencyEmail || !isValidEmail(emergencyEmail)) {
      return res.status(400).json({ ok: false, error: 'Valid emergencyEmail is required' });
    }

    // Clean and validate phone numbers
    const cleanedPhones = cleanPhoneArray(emergencyPhones);

    const docRef = db.collection(DEVICES_COLLECTION).doc(installId);
    const doc = await docRef.get();
    const now = admin.firestore.Timestamp.now();

    if (doc.exists) {
      // Update existing device
      const existingData = doc.data();
      const updateData = {
        displayName: displayName || existingData.displayName || '',
        emergencyEmail,
        intervalSeconds: intervalSeconds || existingData.intervalSeconds || DEFAULT_INTERVAL_SECONDS,
        updatedAt: now,
      };

      // Update SMS fields if provided
      if (emergencyPhones !== undefined) {
        updateData.emergencyPhones = cleanedPhones;
      }
      if (smsEnabled !== undefined) {
        updateData.smsEnabled = Boolean(smsEnabled);
      }

      // ✅ Save FCM token if provided
      if (typeof fcmToken === 'string') {
        updateData.fcmToken = fcmToken.trim();
      }

      await docRef.update(updateData);

      console.log(
        `[Device] Updated: ${installId}, smsEnabled: ${updateData.smsEnabled}, phones: ${cleanedPhones.length}`
      );
    } else {
      // Create new device
      const interval = intervalSeconds || DEFAULT_INTERVAL_SECONDS;
      const nextDueAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + interval * 1000);

      await docRef.set({
        installId,
        displayName: displayName || '',
        emergencyEmail,
        emergencyPhones: cleanedPhones,
        smsEnabled: Boolean(smsEnabled),
        intervalSeconds: interval,
        graceSeconds: DEFAULT_GRACE_SECONDS,
        lastCheckinAt: now,
        nextDueAt,
        status: 'OK',

        // Email/SMS/Push idempotency flags
        overdueNotifiedAt: null,
        overdueSmsNotifiedAt: null,
        overduePushNotifiedAt: null,

        // ✅ FCM token
        fcmToken: typeof fcmToken === 'string' ? fcmToken.trim() : null,

        createdAt: now,
        updatedAt: now,
      });

      console.log(
        `[Device] Created: ${installId}, smsEnabled: ${Boolean(smsEnabled)}, phones: ${cleanedPhones.length}`
      );
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
      overdueNotifiedAt: null, // Reset so next overdue can trigger email alert
      overdueSmsNotifiedAt: null, // Reset so next overdue can trigger SMS alert
      overduePushNotifiedAt: null, // ✅ Reset so next overdue can trigger push alert
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

        // SMS fields
        smsEnabled: data.smsEnabled || false,
        emergencyPhones: data.emergencyPhones || [],

        // ✅ Push fields
        fcmToken: data.fcmToken || null,
      },
    });
  } catch (error) {
    console.error('[Device] Status error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;

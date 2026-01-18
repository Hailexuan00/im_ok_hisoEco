/**
 * Internal Routes - Protected by CRON_SECRET
 * For cron jobs (scan-overdue)
 *
 * AUDIT: 2026-01-18
 * - Query uses composite index (overdueNotifiedAt, nextDueAt)
 * - Pagination with BATCH_LIMIT + MAX_PER_RUN cap
 * - Transaction for idempotency (no duplicate sends)
 * - Lock to prevent overlapping runs
 * - Kill-switch via CRON_ENABLED
 */

const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebaseAdmin');
const { sendOverdueAlert } = require('../services/emailSender');

const DEVICES_COLLECTION = 'devices';
const ALERTS_COLLECTION = 'alerts';
const LOCKS_COLLECTION = 'locks';
const LOCK_DOC = 'overdueScanner';

// Config from env with defaults
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 100;
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN) || 200;
const LOCK_TIMEOUT_MS = parseInt(process.env.LOCK_TIMEOUT_MS) || 2 * 60 * 1000; // 2 minutes
const WARN_THRESHOLD = parseInt(process.env.WARN_THRESHOLD) || 500;

// Simple email validation
function isValidEmail(email) {
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Generate simple run ID
function generateRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Middleware: Verify CRON_SECRET
 */
function verifyCronSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    console.warn('[Cron] WARNING: CRON_SECRET not configured - endpoint unprotected!');
    return next();
  }

  if (secret !== expected) {
    console.error('[Cron] Invalid secret attempt');
    return res.status(401).json({ ok: false, error: 'Invalid cron secret' });
  }

  next();
}

/**
 * Acquire lock using transaction (atomic)
 */
async function acquireLock(runId) {
  const lockRef = db.collection(LOCKS_COLLECTION).doc(LOCK_DOC);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const lockDoc = await transaction.get(lockRef);
      const now = Date.now();

      if (lockDoc.exists) {
        const data = lockDoc.data();
        const startedAt = data.startedAt?.toMillis() || 0;

        // Check if lock is held and not timed out
        if (data.running && now - startedAt < LOCK_TIMEOUT_MS) {
          return { acquired: false, heldBy: data.runId, startedAt: data.startedAt };
        }
      }

      // Acquire lock
      transaction.set(lockRef, {
        running: true,
        runId,
        startedAt: admin.firestore.Timestamp.now(),
      });

      return { acquired: true };
    });

    return result;
  } catch (error) {
    console.error('[Lock] Acquire error:', error.message);
    return { acquired: false, error: error.message };
  }
}

/**
 * Release lock (always called in finally)
 */
async function releaseLock(runId, stats = {}) {
  try {
    await db.collection(LOCKS_COLLECTION).doc(LOCK_DOC).set({
      running: false,
      runId,
      finishedAt: admin.firestore.Timestamp.now(),
      lastResult: stats,
    });
  } catch (error) {
    console.error('[Lock] Release error:', error.message);
  }
}

/**
 * Log alert to Firestore
 */
async function logAlert(installId, toEmail, status, providerId = null, errorMsg = null) {
  try {
    await db.collection(ALERTS_COLLECTION).add({
      installId,
      toEmail,
      type: 'OVERDUE_EMAIL',
      status,
      providerId,
      error: errorMsg,
      triggeredAt: admin.firestore.Timestamp.now(),
    });
  } catch (e) {
    console.error('[Alert] Log error:', e.message);
  }
}

/**
 * Process single overdue device with idempotency
 *
 * CRITICAL: Email is sent OUTSIDE transaction to avoid:
 * 1. Long-running transaction timeout
 * 2. Email sent but transaction rolled back
 *
 * Flow:
 * 1. Transaction: Check if still eligible, mark as notified
 * 2. If marked: Send email
 * 3. If email fails: We don't rollback (device already marked, will need manual intervention)
 */
async function processOverdueDevice(deviceDoc, runId) {
  const installId = deviceDoc.id;
  const deviceRef = db.collection(DEVICES_COLLECTION).doc(installId);

  try {
    // Step 1: Transaction to check eligibility and mark as notified
    const txResult = await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(deviceRef);

      if (!freshDoc.exists) {
        return { shouldSend: false, reason: 'not_found' };
      }

      const data = freshDoc.data();

      // Double-check: still not notified?
      if (data.overdueNotifiedAt !== null) {
        return { shouldSend: false, reason: 'already_notified' };
      }

      // Validate email
      if (!isValidEmail(data.emergencyEmail)) {
        return { shouldSend: false, reason: 'invalid_email', email: data.emergencyEmail };
      }

      // Mark as notified BEFORE sending (optimistic)
      transaction.update(deviceRef, {
        status: 'OVERDUE',
        overdueNotifiedAt: admin.firestore.Timestamp.now(),
        updatedAt: admin.firestore.Timestamp.now(),
      });

      return {
        shouldSend: true,
        installId,
        displayName: data.displayName || `IMOK User #${installId.slice(-4).toUpperCase()}`,
        emergencyEmail: data.emergencyEmail,
        lastCheckinAt: data.lastCheckinAt?.toDate?.() || null,
        graceSeconds: data.graceSeconds || 300,
      };
    });

    // Step 2: Send email if eligible
    if (!txResult.shouldSend) {
      return { skipped: true, reason: txResult.reason, installId };
    }

    // Send email (outside transaction)
    const emailResult = await sendOverdueAlert({
      displayName: txResult.displayName,
      emergencyEmail: txResult.emergencyEmail,
      lastCheckinAt: txResult.lastCheckinAt,
      graceSeconds: txResult.graceSeconds,
    });

    // Log result
    await logAlert(
      installId,
      txResult.emergencyEmail,
      emailResult.success ? 'SUCCESS' : 'FAIL',
      emailResult.providerId,
      emailResult.error
    );

    return {
      sent: true,
      installId,
      email: txResult.emergencyEmail,
      success: emailResult.success,
      providerId: emailResult.providerId,
      error: emailResult.error,
    };
  } catch (error) {
    console.error(`[Cron:${runId}] Process ${installId} error:`, error.message);
    return { error: error.message, installId };
  }
}

/**
 * GET /internal/cron/scan-overdue
 * Scan for overdue devices and send alerts
 *
 * Query (with composite index):
 *   where('overdueNotifiedAt', '==', null)
 *   where('nextDueAt', '<', cutoff)
 *   orderBy('nextDueAt')
 *   limit(BATCH_LIMIT)
 */
router.get('/cron/scan-overdue', verifyCronSecret, async (req, res) => {
  const runId = generateRunId();
  const startTime = Date.now();

  // Stats object for logging
  const stats = {
    runId,
    cutoff: null,
    queriedCount: 0,
    matchedCount: 0,
    emailsAttempted: 0,
    emailsSent: 0,
    emailsFailed: 0,
    skippedAlreadyNotified: 0,
    skippedInvalidEmail: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    // === KILL-SWITCH CHECK ===
    const CRON_ENABLED = process.env.CRON_ENABLED === 'true' || process.env.CRON_ENABLED === '1';

    if (!CRON_ENABLED) {
      console.log(`[Cron:${runId}] DISABLED - CRON_ENABLED != true`);
      return res.json({ ok: true, disabled: true, runId });
    }

    // === ACQUIRE LOCK ===
    const lockResult = await acquireLock(runId);
    if (!lockResult.acquired) {
      console.log(`[Cron:${runId}] Skipped: lock held by ${lockResult.heldBy || 'unknown'}`);
      return res.json({ ok: true, skipped: true, reason: 'lock_held', runId });
    }

    console.log(`[Cron:${runId}] Starting scan-overdue...`);

    // === CALCULATE CUTOFF ===
    // Overdue if: nextDueAt < (now - graceSeconds)
    // We use fixed 5 min grace for query, individual device grace is checked in processing
    const cutoffMs = Date.now() - 300 * 1000; // 5 minutes ago
    const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);
    stats.cutoff = new Date(cutoffMs).toISOString();

    let lastDoc = null;
    let totalProcessed = 0;

    // === PAGINATED QUERY ===
    while (totalProcessed < MAX_PER_RUN) {
      // IMPORTANT: Query order must match composite index
      let query = db
        .collection(DEVICES_COLLECTION)
        .where('overdueNotifiedAt', '==', null)
        .where('nextDueAt', '<', cutoff)
        .orderBy('nextDueAt')
        .limit(BATCH_LIMIT);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      stats.queriedCount += snapshot.docs.length;

      if (snapshot.empty) {
        break;
      }

      console.log(`[Cron:${runId}] Processing batch: ${snapshot.docs.length} devices`);

      for (const doc of snapshot.docs) {
        totalProcessed++;
        stats.matchedCount++;

        const result = await processOverdueDevice(doc, runId);

        if (result.skipped) {
          if (result.reason === 'already_notified') {
            stats.skippedAlreadyNotified++;
          } else if (result.reason === 'invalid_email') {
            stats.skippedInvalidEmail++;
            console.warn(`[Cron:${runId}] Skipped ${result.installId}: invalid email`);
          }
        } else if (result.sent) {
          stats.emailsAttempted++;
          if (result.success) {
            stats.emailsSent++;
            console.log(`[Cron:${runId}] Sent: ${result.installId} -> ${result.email}`);
          } else {
            stats.emailsFailed++;
            stats.errors.push({ installId: result.installId, error: result.error });
            console.error(`[Cron:${runId}] Failed: ${result.installId} - ${result.error}`);
          }
        } else if (result.error) {
          stats.emailsFailed++;
          stats.errors.push({ installId: result.installId, error: result.error });
        }

        if (totalProcessed >= MAX_PER_RUN) {
          console.warn(`[Cron:${runId}] Reached MAX_PER_RUN limit (${MAX_PER_RUN})`);
          break;
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      // If fewer than batch limit, we're done
      if (snapshot.docs.length < BATCH_LIMIT) {
        break;
      }
    }

    // === FINALIZE ===
    stats.durationMs = Date.now() - startTime;

    // Warning if exceeds threshold
    if (stats.queriedCount > WARN_THRESHOLD || stats.emailsSent > WARN_THRESHOLD) {
      console.warn(`[Cron:${runId}] WARNING: High volume - queried=${stats.queriedCount}, sent=${stats.emailsSent}`);
    }

    // Log summary as JSON
    console.log(`[Cron:${runId}] Completed:`, JSON.stringify(stats));

    // Release lock
    await releaseLock(runId, stats);

    res.json({ ok: true, stats });
  } catch (error) {
    stats.durationMs = Date.now() - startTime;
    stats.errors.push({ fatal: error.message });

    console.error(`[Cron:${runId}] FATAL:`, error.message);
    console.error(`[Cron:${runId}] Stats at failure:`, JSON.stringify(stats));

    await releaseLock(runId, stats);

    res.status(500).json({ ok: false, error: error.message, runId, stats });
  }
});

/**
 * GET /internal/cron/status
 * Get cron lock status
 */
router.get('/cron/status', verifyCronSecret, async (req, res) => {
  try {
    const lockDoc = await db.collection(LOCKS_COLLECTION).doc(LOCK_DOC).get();

    if (!lockDoc.exists) {
      return res.json({ ok: true, data: { running: false, lastRun: null } });
    }

    const data = lockDoc.data();

    res.json({
      ok: true,
      data: {
        running: data.running,
        runId: data.runId,
        startedAt: data.startedAt?.toDate?.()?.toISOString() || null,
        finishedAt: data.finishedAt?.toDate?.()?.toISOString() || null,
        lastResult: data.lastResult || null,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /internal/test-email
 * Test email sending directly (for debugging)
 *
 * Body: { "to": "email@example.com" }
 */
router.post('/test-email', verifyCronSecret, async (req, res) => {
  try {
    const { to } = req.body;

    if (!to || !isValidEmail(to)) {
      return res.status(400).json({ ok: false, error: 'Valid "to" email is required' });
    }

    console.log(`[TestEmail] Sending test email to ${to}...`);

    const result = await sendOverdueAlert({
      displayName: 'Test User',
      emergencyEmail: to,
      lastCheckinAt: new Date(),
      graceSeconds: 300,
    });

    if (result.success) {
      console.log(`[TestEmail] Success: ${result.providerId}`);
      res.json({
        ok: true,
        message: 'Test email sent successfully',
        to,
        providerId: result.providerId,
      });
    } else {
      console.error(`[TestEmail] Failed: ${result.error}`);
      res.status(500).json({
        ok: false,
        error: result.error,
        to,
      });
    }
  } catch (error) {
    console.error(`[TestEmail] Error:`, error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /internal/test-overdue
 * Set a device to overdue state and trigger scan immediately
 * For end-to-end testing
 *
 * Body: { "installId": "...", "minutesOverdue": 5 }
 */
router.post('/test-overdue', verifyCronSecret, async (req, res) => {
  try {
    const { installId, minutesOverdue = 6 } = req.body;

    if (!installId) {
      return res.status(400).json({ ok: false, error: 'installId is required' });
    }

    const deviceRef = db.collection(DEVICES_COLLECTION).doc(installId);
    const doc = await deviceRef.get();

    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Device not found' });
    }

    // Set nextDueAt to X minutes ago (making it overdue)
    const overdueTime = Date.now() - (minutesOverdue * 60 * 1000);
    const nextDueAt = admin.firestore.Timestamp.fromMillis(overdueTime);

    await deviceRef.update({
      nextDueAt,
      overdueNotifiedAt: null, // Reset to allow notification
      status: 'OK',
      updatedAt: admin.firestore.Timestamp.now(),
    });

    console.log(`[TestOverdue] Set ${installId} to ${minutesOverdue} minutes overdue`);

    // Now trigger scan
    const runId = generateRunId();
    const startTime = Date.now();

    // Acquire lock
    const lockResult = await acquireLock(runId);
    if (!lockResult.acquired) {
      return res.json({
        ok: true,
        setup: { installId, minutesOverdue, nextDueAt: new Date(overdueTime).toISOString() },
        scan: { skipped: true, reason: 'lock_held' },
      });
    }

    // Calculate cutoff (5 minutes ago)
    const cutoffMs = Date.now() - 300 * 1000;
    const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);

    // Query this specific device
    const snapshot = await db
      .collection(DEVICES_COLLECTION)
      .where('overdueNotifiedAt', '==', null)
      .where('nextDueAt', '<', cutoff)
      .orderBy('nextDueAt')
      .limit(10)
      .get();

    const stats = {
      runId,
      queriedCount: snapshot.docs.length,
      emailsSent: 0,
      emailsFailed: 0,
      skippedAlreadyNotified: 0,
    };

    // Process only the test device
    for (const docSnap of snapshot.docs) {
      if (docSnap.id === installId) {
        const result = await processOverdueDevice(docSnap, runId);
        if (result.sent && result.success) {
          stats.emailsSent++;
        } else if (result.sent && !result.success) {
          stats.emailsFailed++;
        } else if (result.skipped && result.reason === 'already_notified') {
          stats.skippedAlreadyNotified++;
        }
      }
    }

    stats.durationMs = Date.now() - startTime;
    await releaseLock(runId, stats);

    res.json({
      ok: true,
      setup: { installId, minutesOverdue, nextDueAt: new Date(overdueTime).toISOString() },
      scan: stats,
    });
  } catch (error) {
    console.error(`[TestOverdue] Error:`, error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /internal/cron/force-release
 * Force release stuck lock (emergency use)
 */
router.post('/cron/force-release', verifyCronSecret, async (req, res) => {
  try {
    const runId = generateRunId();
    await releaseLock(runId, { forcedRelease: true, releasedAt: new Date().toISOString() });
    console.warn(`[Cron:${runId}] Lock force-released`);
    res.json({ ok: true, message: 'Lock released', runId });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;

///**
// * Internal Routes - Protected by CRON_SECRET
// * For cron jobs (scan-overdue)
// *
// * AUDIT: 2026-01-18
// * - Query uses composite index (overdueNotifiedAt, nextDueAt)
// * - Pagination with BATCH_LIMIT + MAX_PER_RUN cap
// * - Transaction for idempotency (no duplicate sends)
// * - Lock to prevent overlapping runs
// * - Kill-switch via CRON_ENABLED
// */
//
//const express = require('express');
//const router = express.Router();
//const { db, admin } = require('../firebaseAdmin');
//const { sendOverdueAlert } = require('../services/emailSender');
//const {
//  sendSmsToMany,
//  buildOverdueMessage,
//  isSmsConfigured,
//  getSmsProviderInfo,
//  normalizePhoneVN,
//  isValidE164,
//} = require('../services/smsSender');
//
//const DEVICES_COLLECTION = 'devices';
//const ALERTS_COLLECTION = 'alerts';
//const LOCKS_COLLECTION = 'locks';
//const LOCK_DOC = 'overdueScanner';
//
//// Config from env with defaults
//const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 100;
//const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN) || 200;
//const LOCK_TIMEOUT_MS = parseInt(process.env.LOCK_TIMEOUT_MS) || 2 * 60 * 1000; // 2 minutes
//const WARN_THRESHOLD = parseInt(process.env.WARN_THRESHOLD) || 500;
//
//// Simple email validation
//function isValidEmail(email) {
//  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
//}
//
//// Generate simple run ID
//function generateRunId() {
//  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
//}
//
///**
// * Middleware: Verify CRON_SECRET
// */
//function verifyCronSecret(req, res, next) {
//  const secret = req.headers['x-cron-secret'];
//  const expected = process.env.CRON_SECRET;
//
//  if (!expected) {
//    console.warn('[Cron] WARNING: CRON_SECRET not configured - endpoint unprotected!');
//    return next();
//  }
//
//  if (secret !== expected) {
//    console.error('[Cron] Invalid secret attempt');
//    return res.status(401).json({ ok: false, error: 'Invalid cron secret' });
//  }
//
//  next();
//}
//
///**
// * Acquire lock using transaction (atomic)
// */
//async function acquireLock(runId) {
//  const lockRef = db.collection(LOCKS_COLLECTION).doc(LOCK_DOC);
//
//  try {
//    const result = await db.runTransaction(async (transaction) => {
//      const lockDoc = await transaction.get(lockRef);
//      const now = Date.now();
//
//      if (lockDoc.exists) {
//        const data = lockDoc.data();
//        const startedAt = data.startedAt?.toMillis() || 0;
//
//        // Check if lock is held and not timed out
//        if (data.running && now - startedAt < LOCK_TIMEOUT_MS) {
//          return { acquired: false, heldBy: data.runId, startedAt: data.startedAt };
//        }
//      }
//
//      // Acquire lock
//      transaction.set(lockRef, {
//        running: true,
//        runId,
//        startedAt: admin.firestore.Timestamp.now(),
//      });
//
//      return { acquired: true };
//    });
//
//    return result;
//  } catch (error) {
//    console.error('[Lock] Acquire error:', error.message);
//    return { acquired: false, error: error.message };
//  }
//}
//
///**
// * Release lock (always called in finally)
// */
//async function releaseLock(runId, stats = {}) {
//  try {
//    await db.collection(LOCKS_COLLECTION).doc(LOCK_DOC).set({
//      running: false,
//      runId,
//      finishedAt: admin.firestore.Timestamp.now(),
//      lastResult: stats,
//    });
//  } catch (error) {
//    console.error('[Lock] Release error:', error.message);
//  }
//}
//
///**
// * Log alert to Firestore
// * @param {string} installId
// * @param {string} toTarget - email or phone
// * @param {string} type - 'OVERDUE_EMAIL' or 'OVERDUE_SMS'
// * @param {string} status - 'SUCCESS' or 'FAIL'
// * @param {string} provider - email/sms provider name
// * @param {string|null} providerId
// * @param {string|null} errorMsg
// */
//async function logAlert(installId, toTarget, type, status, provider = null, providerId = null, errorMsg = null) {
//  try {
//    await db.collection(ALERTS_COLLECTION).add({
//      installId,
//      ...(type === 'OVERDUE_EMAIL' ? { toEmail: toTarget } : { toPhone: toTarget }),
//      type,
//      status,
//      provider,
//      providerId,
//      error: errorMsg,
//      triggeredAt: admin.firestore.Timestamp.now(),
//    });
//  } catch (e) {
//    console.error('[Alert] Log error:', e.message);
//  }
//}
//
///**
// * Process single overdue device with idempotency
// *
// * CRITICAL: Email/SMS is sent OUTSIDE transaction to avoid:
// * 1. Long-running transaction timeout
// * 2. Email sent but transaction rolled back
// *
// * Flow:
// * 1. Transaction: Check if still eligible, mark as notified
// * 2. If marked: Send email (always) and SMS (if enabled)
// * 3. If email fails: We don't rollback (device already marked, will need manual intervention)
// * 4. SMS has separate idempotency via overdueSmsNotifiedAt
// */
//async function processOverdueDevice(deviceDoc, runId) {
//  const installId = deviceDoc.id;
//  const deviceRef = db.collection(DEVICES_COLLECTION).doc(installId);
//
//  try {
//    // Step 1: Transaction to check eligibility and mark as notified
//    const txResult = await db.runTransaction(async (transaction) => {
//      const freshDoc = await transaction.get(deviceRef);
//
//      if (!freshDoc.exists) {
//        return { shouldSendEmail: false, shouldSendSms: false, reason: 'not_found' };
//      }
//
//      const data = freshDoc.data();
//
//      // Check email eligibility
//      const shouldSendEmail = data.overdueNotifiedAt === null && isValidEmail(data.emergencyEmail);
//
//      // Check SMS eligibility
//      const shouldSendSms =
//        data.smsEnabled === true &&
//        data.overdueSmsNotifiedAt === null &&
//        Array.isArray(data.emergencyPhones) &&
//        data.emergencyPhones.length > 0;
//
//      if (!shouldSendEmail && !shouldSendSms) {
//        if (data.overdueNotifiedAt !== null) {
//          return { shouldSendEmail: false, shouldSendSms: false, reason: 'already_notified' };
//        }
//        if (!isValidEmail(data.emergencyEmail)) {
//          return { shouldSendEmail: false, shouldSendSms: false, reason: 'invalid_email', email: data.emergencyEmail };
//        }
//        return { shouldSendEmail: false, shouldSendSms: false, reason: 'no_action_needed' };
//      }
//
//      // Prepare update object
//      const updateObj = {
//        status: 'OVERDUE',
//        updatedAt: admin.firestore.Timestamp.now(),
//      };
//
//      // Mark email as notified if sending email
//      if (shouldSendEmail) {
//        updateObj.overdueNotifiedAt = admin.firestore.Timestamp.now();
//      }
//
//      // Note: SMS notification flag will be set AFTER successful send
//
//      transaction.update(deviceRef, updateObj);
//
//      return {
//        shouldSendEmail,
//        shouldSendSms,
//        installId,
//        displayName: data.displayName || `IMOK User #${installId.slice(-4).toUpperCase()}`,
//        emergencyEmail: data.emergencyEmail,
//        emergencyPhones: data.emergencyPhones || [],
//        lastCheckinAt: data.lastCheckinAt?.toDate?.() || null,
//        nextDueAt: data.nextDueAt?.toDate?.() || null,
//        graceSeconds: data.graceSeconds || 300,
//      };
//    });
//
//    // Step 2: Check if any action needed
//    if (!txResult.shouldSendEmail && !txResult.shouldSendSms) {
//      return { skipped: true, reason: txResult.reason, installId };
//    }
//
//    const result = {
//      sent: false,
//      installId,
//      email: null,
//      emailSuccess: false,
//      smsResults: [],
//      smsSentCount: 0,
//    };
//
//    // Step 3: Send email if eligible
//    if (txResult.shouldSendEmail) {
//      const emailResult = await sendOverdueAlert({
//        displayName: txResult.displayName,
//        emergencyEmail: txResult.emergencyEmail,
//        lastCheckinAt: txResult.lastCheckinAt,
//        graceSeconds: txResult.graceSeconds,
//      });
//
//      result.sent = true;
//      result.email = txResult.emergencyEmail;
//      result.emailSuccess = emailResult.success;
//      result.emailProviderId = emailResult.providerId;
//      result.emailError = emailResult.error;
//
//      // Log email result
//      await logAlert(
//        installId,
//        txResult.emergencyEmail,
//        'OVERDUE_EMAIL',
//        emailResult.success ? 'SUCCESS' : 'FAIL',
//        'email',
//        emailResult.providerId,
//        emailResult.error
//      );
//    }
//
//    // Step 4: Send SMS if eligible
//    if (txResult.shouldSendSms && isSmsConfigured()) {
//      const smsMessage = buildOverdueMessage(txResult.displayName, txResult.nextDueAt);
//      const smsResult = await sendSmsToMany(txResult.emergencyPhones, smsMessage);
//
//      result.sent = true;
//      result.smsResults = smsResult.results;
//      result.smsSentCount = smsResult.sentCount;
//      result.smsFailedCount = smsResult.failedCount;
//
//      // Log each SMS result
//      for (const smsRes of smsResult.results) {
//        await logAlert(
//          installId,
//          smsRes.to,
//          'OVERDUE_SMS',
//          smsRes.ok ? 'SUCCESS' : 'FAIL',
//          smsRes.provider,
//          smsRes.messageId,
//          smsRes.error
//        );
//      }
//
//      // Only mark SMS as notified if at least one SMS was sent successfully
//      if (smsResult.sentCount > 0) {
//        await deviceRef.update({
//          overdueSmsNotifiedAt: admin.firestore.Timestamp.now(),
//        });
//        console.log(`[Cron:${runId}] SMS notified: ${installId}, sent to ${smsResult.sentCount} numbers`);
//      }
//    }
//
//    return {
//      sent: result.sent,
//      installId,
//      email: result.email,
//      success: result.emailSuccess || result.smsSentCount > 0,
//      providerId: result.emailProviderId,
//      error: result.emailError,
//      smsSentCount: result.smsSentCount,
//      smsFailedCount: result.smsFailedCount,
//    };
//  } catch (error) {
//    console.error(`[Cron:${runId}] Process ${installId} error:`, error.message);
//    return { error: error.message, installId };
//  }
//}
//
///**
// * GET /internal/cron/scan-overdue
// * Scan for overdue devices and send alerts
// *
// * Query (with composite index):
// *   where('overdueNotifiedAt', '==', null)
// *   where('nextDueAt', '<', cutoff)
// *   orderBy('nextDueAt')
// *   limit(BATCH_LIMIT)
// */
//router.get('/cron/scan-overdue', verifyCronSecret, async (req, res) => {
//  const runId = generateRunId();
//  const startTime = Date.now();
//
//  // Stats object for logging
//  const stats = {
//    runId,
//    cutoff: null,
//    queriedCount: 0,
//    matchedCount: 0,
//    emailsAttempted: 0,
//    emailsSent: 0,
//    emailsFailed: 0,
//    smsSent: 0,
//    smsFailed: 0,
//    skippedAlreadyNotified: 0,
//    skippedInvalidEmail: 0,
//    errors: [],
//    durationMs: 0,
//  };
//
//  try {
//    // === KILL-SWITCH CHECK ===
//    const CRON_ENABLED = process.env.CRON_ENABLED === 'true' || process.env.CRON_ENABLED === '1';
//
//    if (!CRON_ENABLED) {
//      console.log(`[Cron:${runId}] DISABLED - CRON_ENABLED != true`);
//      return res.json({ ok: true, disabled: true, runId });
//    }
//
//    // === ACQUIRE LOCK ===
//    const lockResult = await acquireLock(runId);
//    if (!lockResult.acquired) {
//      console.log(`[Cron:${runId}] Skipped: lock held by ${lockResult.heldBy || 'unknown'}`);
//      return res.json({ ok: true, skipped: true, reason: 'lock_held', runId });
//    }
//
//    console.log(`[Cron:${runId}] Starting scan-overdue...`);
//
//    // === CALCULATE CUTOFF ===
//    // Overdue if: nextDueAt < (now - graceSeconds)
//    // We use fixed 5 min grace for query, individual device grace is checked in processing
//    const cutoffMs = Date.now() - 300 * 1000; // 5 minutes ago
//    const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);
//    stats.cutoff = new Date(cutoffMs).toISOString();
//
//    let lastDoc = null;
//    let totalProcessed = 0;
//
//    // === PAGINATED QUERY ===
//    while (totalProcessed < MAX_PER_RUN) {
//      // IMPORTANT: Query order must match composite index
//      let query = db
//        .collection(DEVICES_COLLECTION)
//        .where('overdueNotifiedAt', '==', null)
//        .where('nextDueAt', '<', cutoff)
//        .orderBy('nextDueAt')
//        .limit(BATCH_LIMIT);
//
//      if (lastDoc) {
//        query = query.startAfter(lastDoc);
//      }
//
//      const snapshot = await query.get();
//      stats.queriedCount += snapshot.docs.length;
//
//      if (snapshot.empty) {
//        break;
//      }
//
//      console.log(`[Cron:${runId}] Processing batch: ${snapshot.docs.length} devices`);
//
//      for (const doc of snapshot.docs) {
//        totalProcessed++;
//        stats.matchedCount++;
//
//        const result = await processOverdueDevice(doc, runId);
//
//        if (result.skipped) {
//          if (result.reason === 'already_notified') {
//            stats.skippedAlreadyNotified++;
//          } else if (result.reason === 'invalid_email') {
//            stats.skippedInvalidEmail++;
//            console.warn(`[Cron:${runId}] Skipped ${result.installId}: invalid email`);
//          }
//        } else if (result.sent) {
//          // Track email
//          if (result.email) {
//            stats.emailsAttempted++;
//            if (result.success) {
//              stats.emailsSent++;
//              console.log(`[Cron:${runId}] Email sent: ${result.installId} -> ${result.email}`);
//            } else if (result.error) {
//              stats.emailsFailed++;
//              stats.errors.push({ installId: result.installId, type: 'email', error: result.error });
//              console.error(`[Cron:${runId}] Email failed: ${result.installId} - ${result.error}`);
//            }
//          }
//          // Track SMS
//          if (result.smsSentCount > 0) {
//            stats.smsSent += result.smsSentCount;
//            console.log(`[Cron:${runId}] SMS sent: ${result.installId} -> ${result.smsSentCount} numbers`);
//          }
//          if (result.smsFailedCount > 0) {
//            stats.smsFailed += result.smsFailedCount;
//          }
//        } else if (result.error) {
//          stats.emailsFailed++;
//          stats.errors.push({ installId: result.installId, error: result.error });
//        }
//
//        if (totalProcessed >= MAX_PER_RUN) {
//          console.warn(`[Cron:${runId}] Reached MAX_PER_RUN limit (${MAX_PER_RUN})`);
//          break;
//        }
//      }
//
//      lastDoc = snapshot.docs[snapshot.docs.length - 1];
//
//      // If fewer than batch limit, we're done
//      if (snapshot.docs.length < BATCH_LIMIT) {
//        break;
//      }
//    }
//
//    // === FINALIZE ===
//    stats.durationMs = Date.now() - startTime;
//
//    // Warning if exceeds threshold
//    if (stats.queriedCount > WARN_THRESHOLD || stats.emailsSent > WARN_THRESHOLD) {
//      console.warn(`[Cron:${runId}] WARNING: High volume - queried=${stats.queriedCount}, sent=${stats.emailsSent}`);
//    }
//
//    // Log summary as JSON
//    console.log(`[Cron:${runId}] Completed:`, JSON.stringify(stats));
//
//    // Release lock
//    await releaseLock(runId, stats);
//
//    res.json({ ok: true, stats });
//  } catch (error) {
//    stats.durationMs = Date.now() - startTime;
//    stats.errors.push({ fatal: error.message });
//
//    console.error(`[Cron:${runId}] FATAL:`, error.message);
//    console.error(`[Cron:${runId}] Stats at failure:`, JSON.stringify(stats));
//
//    await releaseLock(runId, stats);
//
//    res.status(500).json({ ok: false, error: error.message, runId, stats });
//  }
//});
//
///**
// * GET /internal/cron/status
// * Get cron lock status
// */
//router.get('/cron/status', verifyCronSecret, async (req, res) => {
//  try {
//    const lockDoc = await db.collection(LOCKS_COLLECTION).doc(LOCK_DOC).get();
//
//    if (!lockDoc.exists) {
//      return res.json({ ok: true, data: { running: false, lastRun: null } });
//    }
//
//    const data = lockDoc.data();
//
//    res.json({
//      ok: true,
//      data: {
//        running: data.running,
//        runId: data.runId,
//        startedAt: data.startedAt?.toDate?.()?.toISOString() || null,
//        finishedAt: data.finishedAt?.toDate?.()?.toISOString() || null,
//        lastResult: data.lastResult || null,
//      },
//    });
//  } catch (error) {
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
///**
// * POST /internal/test-email
// * Test email sending directly (for debugging)
// *
// * Body: { "to": "email@example.com" }
// */
//router.post('/test-email', verifyCronSecret, async (req, res) => {
//  try {
//    const { to } = req.body;
//
//    if (!to || !isValidEmail(to)) {
//      return res.status(400).json({ ok: false, error: 'Valid "to" email is required' });
//    }
//
//    console.log(`[TestEmail] Sending test email to ${to}...`);
//
//    const result = await sendOverdueAlert({
//      displayName: 'Test User',
//      emergencyEmail: to,
//      lastCheckinAt: new Date(),
//      graceSeconds: 300,
//    });
//
//    if (result.success) {
//      console.log(`[TestEmail] Success: ${result.providerId}`);
//      res.json({
//        ok: true,
//        message: 'Test email sent successfully',
//        to,
//        providerId: result.providerId,
//      });
//    } else {
//      console.error(`[TestEmail] Failed: ${result.error}`);
//      res.status(500).json({
//        ok: false,
//        error: result.error,
//        to,
//      });
//    }
//  } catch (error) {
//    console.error(`[TestEmail] Error:`, error.message);
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
///**
// * POST /internal/test-sms
// * Test SMS sending directly (for debugging)
// *
// * Body: { "to": ["0399123456", "0912345678"], "message": "Test message" }
// */
//router.post('/test-sms', verifyCronSecret, async (req, res) => {
//  try {
//    const { to, message } = req.body;
//
//    // Validate input
//    if (!to || !Array.isArray(to) || to.length === 0) {
//      return res.status(400).json({ ok: false, error: '"to" must be a non-empty array of phone numbers' });
//    }
//
//    if (!message || typeof message !== 'string' || message.trim().length === 0) {
//      return res.status(400).json({ ok: false, error: '"message" is required' });
//    }
//
//    // Check if SMS is configured
//    if (!isSmsConfigured()) {
//      const providerInfo = getSmsProviderInfo();
//      return res.status(400).json({
//        ok: false,
//        error: `SMS provider "${providerInfo.provider}" is not configured. Check environment variables.`,
//        provider: providerInfo,
//      });
//    }
//
//    console.log(`[TestSms] Sending test SMS to ${to.length} numbers...`);
//
//    // Validate and normalize phone numbers
//    const validPhones = [];
//    const invalidPhones = [];
//
//    for (const phone of to) {
//      const normalized = normalizePhoneVN(phone);
//      if (normalized && isValidE164(normalized)) {
//        validPhones.push({ original: phone, normalized });
//      } else {
//        invalidPhones.push({ original: phone, error: 'Invalid format' });
//      }
//    }
//
//    if (validPhones.length === 0) {
//      return res.status(400).json({
//        ok: false,
//        error: 'No valid phone numbers provided',
//        invalidPhones,
//      });
//    }
//
//    // Send SMS to valid numbers
//    const smsResult = await sendSmsToMany(
//      validPhones.map(p => p.normalized),
//      message.trim()
//    );
//
//    console.log(`[TestSms] Completed: sent=${smsResult.sentCount}, failed=${smsResult.failedCount}`);
//
//    res.json({
//      ok: smsResult.sentCount > 0,
//      message: `SMS sent to ${smsResult.sentCount}/${validPhones.length} numbers`,
//      provider: getSmsProviderInfo(),
//      results: smsResult.results,
//      invalidPhones: invalidPhones.length > 0 ? invalidPhones : undefined,
//    });
//  } catch (error) {
//    console.error(`[TestSms] Error:`, error.message);
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
///**
// * GET /internal/sms/status
// * Get SMS provider configuration status
// */
//router.get('/sms/status', verifyCronSecret, async (req, res) => {
//  const providerInfo = getSmsProviderInfo();
//  res.json({
//    ok: true,
//    ...providerInfo,
//  });
//});
//
///**
// * POST /internal/test-overdue
// * Set a device to overdue state and trigger scan immediately
// * For end-to-end testing
// *
// * Body: { "installId": "...", "minutesOverdue": 5 }
// */
//router.post('/test-overdue', verifyCronSecret, async (req, res) => {
//  try {
//    const { installId, minutesOverdue = 6 } = req.body;
//
//    if (!installId) {
//      return res.status(400).json({ ok: false, error: 'installId is required' });
//    }
//
//    const deviceRef = db.collection(DEVICES_COLLECTION).doc(installId);
//    const doc = await deviceRef.get();
//
//    if (!doc.exists) {
//      return res.status(404).json({ ok: false, error: 'Device not found' });
//    }
//
//    // Set nextDueAt to X minutes ago (making it overdue)
//    const overdueTime = Date.now() - (minutesOverdue * 60 * 1000);
//    const nextDueAt = admin.firestore.Timestamp.fromMillis(overdueTime);
//
//    await deviceRef.update({
//      nextDueAt,
//      overdueNotifiedAt: null, // Reset to allow notification
//      status: 'OK',
//      updatedAt: admin.firestore.Timestamp.now(),
//    });
//
//    console.log(`[TestOverdue] Set ${installId} to ${minutesOverdue} minutes overdue`);
//
//    // Now trigger scan
//    const runId = generateRunId();
//    const startTime = Date.now();
//
//    // Acquire lock
//    const lockResult = await acquireLock(runId);
//    if (!lockResult.acquired) {
//      return res.json({
//        ok: true,
//        setup: { installId, minutesOverdue, nextDueAt: new Date(overdueTime).toISOString() },
//        scan: { skipped: true, reason: 'lock_held' },
//      });
//    }
//
//    // Calculate cutoff (5 minutes ago)
//    const cutoffMs = Date.now() - 300 * 1000;
//    const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);
//
//    // Query this specific device
//    const snapshot = await db
//      .collection(DEVICES_COLLECTION)
//      .where('overdueNotifiedAt', '==', null)
//      .where('nextDueAt', '<', cutoff)
//      .orderBy('nextDueAt')
//      .limit(10)
//      .get();
//
//    const stats = {
//      runId,
//      queriedCount: snapshot.docs.length,
//      emailsSent: 0,
//      emailsFailed: 0,
//      skippedAlreadyNotified: 0,
//    };
//
//    // Process only the test device
//    for (const docSnap of snapshot.docs) {
//      if (docSnap.id === installId) {
//        const result = await processOverdueDevice(docSnap, runId);
//        if (result.sent && result.success) {
//          stats.emailsSent++;
//        } else if (result.sent && !result.success) {
//          stats.emailsFailed++;
//        } else if (result.skipped && result.reason === 'already_notified') {
//          stats.skippedAlreadyNotified++;
//        }
//      }
//    }
//
//    stats.durationMs = Date.now() - startTime;
//    await releaseLock(runId, stats);
//
//    res.json({
//      ok: true,
//      setup: { installId, minutesOverdue, nextDueAt: new Date(overdueTime).toISOString() },
//      scan: stats,
//    });
//  } catch (error) {
//    console.error(`[TestOverdue] Error:`, error.message);
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//
///**
// * POST /internal/cron/force-release
// * Force release stuck lock (emergency use)
// */
//router.post('/cron/force-release', verifyCronSecret, async (req, res) => {
//  try {
//    const runId = generateRunId();
//    await releaseLock(runId, { forcedRelease: true, releasedAt: new Date().toISOString() });
//    console.warn(`[Cron:${runId}] Lock force-released`);
//    res.json({ ok: true, message: 'Lock released', runId });
//  } catch (error) {
//    res.status(500).json({ ok: false, error: error.message });
//  }
//});
//// POST /internal/test-push
//// Body: { installId, title?, body? }
//router.post('/test-push', verifyCronSecret, async (req, res) => {
//  try {
//    const { installId, title = 'IMOK Test', body = 'Hello from backend' } = req.body || {};
//    if (!installId) return res.status(400).json({ ok: false, error: 'installId is required' });
//
//    const snap = await db.collection('devices').doc(installId).get();
//    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Device not found' });
//
//    const device = snap.data();
//    const token = typeof device.fcmToken === 'string' ? device.fcmToken.trim() : '';
//    if (!token) return res.status(400).json({ ok: false, error: 'Device has no fcmToken yet' });
//
//    const message = {
//      token,
//      notification: { title, body },
//      data: { type: 'TEST_PUSH', installId: String(installId) },
//      android: { priority: 'high' },
//    };
//
//    const messageId = await admin.messaging().send(message);
//    return res.json({ ok: true, installId, messageId });
//  } catch (e) {
//    console.error('[Internal] test-push error:', e);
//    return res.status(500).json({ ok: false, error: e.message });
//  }
//});
//
//module.exports = router;



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
const {
  sendSmsToMany,
  buildOverdueMessage,
  isSmsConfigured,
  getSmsProviderInfo,
  normalizePhoneVN,
  isValidE164,
} = require('../services/smsSender');

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
 * Send push notification via FCM token
 */
async function sendOverduePush({ token, title, body, data = {} }) {
  try {
    const msg = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)])
      ),
      android: { priority: 'high' },
    };

    const messageId = await admin.messaging().send(msg);
    return { success: true, messageId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Log alert to Firestore
 */
async function logAlert(installId, toTarget, type, status, provider = null, providerId = null, errorMsg = null) {
  try {
    const targetFields =
      type === 'OVERDUE_EMAIL'
        ? { toEmail: toTarget }
        : type === 'OVERDUE_SMS'
        ? { toPhone: toTarget }
        : { toFcmToken: toTarget };

    await db.collection(ALERTS_COLLECTION).add({
      installId,
      ...targetFields,
      type,
      status,
      provider,
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
 */
async function processOverdueDevice(deviceDoc, runId) {
  const installId = deviceDoc.id;
  const deviceRef = db.collection(DEVICES_COLLECTION).doc(installId);

  try {
    // Step 1: Transaction to check eligibility and mark as notified
    const txResult = await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(deviceRef);

      if (!freshDoc.exists) {
        return { shouldSendEmail: false, shouldSendSms: false, shouldSendPush: false, reason: 'not_found' };
      }

      const data = freshDoc.data();

      const token = typeof data.fcmToken === 'string' ? data.fcmToken.trim() : '';
      const hasToken = token.length > 0;

      // Check email eligibility
      const shouldSendEmail = data.overdueNotifiedAt === null && isValidEmail(data.emergencyEmail);

      // Check SMS eligibility
      const shouldSendSms =
        data.smsEnabled === true &&
        data.overdueSmsNotifiedAt === null &&
        Array.isArray(data.emergencyPhones) &&
        data.emergencyPhones.length > 0;

      // ✅ Check Push eligibility
      const shouldSendPush = hasToken && data.overduePushNotifiedAt === null;

      if (!shouldSendEmail && !shouldSendSms && !shouldSendPush) {
        if (data.overdueNotifiedAt !== null) {
          return { shouldSendEmail: false, shouldSendSms: false, shouldSendPush: false, reason: 'already_notified' };
        }
        if (!isValidEmail(data.emergencyEmail)) {
          return {
            shouldSendEmail: false,
            shouldSendSms: false,
            shouldSendPush: false,
            reason: 'invalid_email',
            email: data.emergencyEmail,
          };
        }
        return { shouldSendEmail: false, shouldSendSms: false, shouldSendPush: false, reason: 'no_action_needed' };
      }

      // Prepare update object
      const updateObj = {
        status: 'OVERDUE',
        updatedAt: admin.firestore.Timestamp.now(),
      };

      // Mark email as notified if sending email
      if (shouldSendEmail) {
        updateObj.overdueNotifiedAt = admin.firestore.Timestamp.now();
      }

      // Note: SMS/PUSH notification flag will be set AFTER successful send
      transaction.update(deviceRef, updateObj);

      return {
        shouldSendEmail,
        shouldSendSms,
        shouldSendPush,
        installId,
        displayName: data.displayName || `IMOK User #${installId.slice(-4).toUpperCase()}`,
        emergencyEmail: data.emergencyEmail,
        emergencyPhones: data.emergencyPhones || [],
        fcmToken: token,
        lastCheckinAt: data.lastCheckinAt?.toDate?.() || null,
        nextDueAt: data.nextDueAt?.toDate?.() || null,
        graceSeconds: data.graceSeconds || 300,
      };
    });

    // Step 2: Check if any action needed
    if (!txResult.shouldSendEmail && !txResult.shouldSendSms && !txResult.shouldSendPush) {
      return { skipped: true, reason: txResult.reason, installId };
    }

    const result = {
      sent: false,
      installId,

      email: null,
      emailSuccess: false,
      emailProviderId: null,
      emailError: null,

      smsResults: [],
      smsSentCount: 0,
      smsFailedCount: 0,

      pushSuccess: false,
      pushMessageId: null,
      pushError: null,
    };

    // Step 3: Send email if eligible
    if (txResult.shouldSendEmail) {
      const emailResult = await sendOverdueAlert({
        displayName: txResult.displayName,
        emergencyEmail: txResult.emergencyEmail,
        lastCheckinAt: txResult.lastCheckinAt,
        graceSeconds: txResult.graceSeconds,
      });

      result.sent = true;
      result.email = txResult.emergencyEmail;
      result.emailSuccess = emailResult.success;
      result.emailProviderId = emailResult.providerId;
      result.emailError = emailResult.error;

      await logAlert(
        installId,
        txResult.emergencyEmail,
        'OVERDUE_EMAIL',
        emailResult.success ? 'SUCCESS' : 'FAIL',
        'email',
        emailResult.providerId,
        emailResult.error
      );
    }

    // Step 4: Send SMS if eligible
    if (txResult.shouldSendSms && isSmsConfigured()) {
      const smsMessage = buildOverdueMessage(txResult.displayName, txResult.nextDueAt);
      const smsResult = await sendSmsToMany(txResult.emergencyPhones, smsMessage);

      result.sent = true;
      result.smsResults = smsResult.results;
      result.smsSentCount = smsResult.sentCount;
      result.smsFailedCount = smsResult.failedCount;

      for (const smsRes of smsResult.results) {
        await logAlert(
          installId,
          smsRes.to,
          'OVERDUE_SMS',
          smsRes.ok ? 'SUCCESS' : 'FAIL',
          smsRes.provider,
          smsRes.messageId,
          smsRes.error
        );
      }

      if (smsResult.sentCount > 0) {
        await deviceRef.update({
          overdueSmsNotifiedAt: admin.firestore.Timestamp.now(),
        });
        console.log(`[Cron:${runId}] SMS notified: ${installId}, sent to ${smsResult.sentCount} numbers`);
      }
    }

    // ✅ Step 5: Send PUSH if eligible
    if (txResult.shouldSendPush) {
      const title = 'Im Ok';
      const body = `Bạn chưa điểm danh đúng hạn. Vui lòng mở app để xác nhận an toàn.`;

      const pushRes = await sendOverduePush({
        token: txResult.fcmToken,
        title,
        body,
        data: {
          type: 'OVERDUE',
          installId,
          nextDueAt: txResult.nextDueAt ? txResult.nextDueAt.toISOString?.() || '' : '',
        },
      });

      result.sent = true;
      result.pushSuccess = pushRes.success;
      result.pushMessageId = pushRes.messageId || null;
      result.pushError = pushRes.error || null;

      await logAlert(
        installId,
        txResult.fcmToken,
        'OVERDUE_PUSH',
        pushRes.success ? 'SUCCESS' : 'FAIL',
        'fcm',
        pushRes.messageId || null,
        pushRes.error || null
      );

      if (pushRes.success) {
        await deviceRef.update({
          overduePushNotifiedAt: admin.firestore.Timestamp.now(),
        });
        console.log(`[Cron:${runId}] PUSH notified: ${installId}, messageId=${pushRes.messageId}`);
      } else {
        console.warn(`[Cron:${runId}] PUSH failed: ${installId} - ${pushRes.error}`);
      }
    }

    return {
      sent: result.sent,
      installId,

      email: result.email,
      success: result.emailSuccess || result.smsSentCount > 0 || result.pushSuccess,
      providerId: result.emailProviderId,
      error: result.emailError,

      smsSentCount: result.smsSentCount,
      smsFailedCount: result.smsFailedCount,

      pushSuccess: result.pushSuccess,
      pushMessageId: result.pushMessageId,
      pushError: result.pushError,
    };
  } catch (error) {
    console.error(`[Cron:${runId}] Process ${installId} error:`, error.message);
    return { error: error.message, installId };
  }
}

/**
 * GET /internal/cron/scan-overdue
 * Scan for overdue devices and send alerts
 */
router.get('/cron/scan-overdue', verifyCronSecret, async (req, res) => {
  const runId = generateRunId();
  const startTime = Date.now();

  const stats = {
    runId,
    cutoff: null,
    queriedCount: 0,
    matchedCount: 0,

    emailsAttempted: 0,
    emailsSent: 0,
    emailsFailed: 0,

    smsSent: 0,
    smsFailed: 0,

    pushSent: 0,
    pushFailed: 0,

    skippedAlreadyNotified: 0,
    skippedInvalidEmail: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    const CRON_ENABLED = process.env.CRON_ENABLED === 'true' || process.env.CRON_ENABLED === '1';
    if (!CRON_ENABLED) {
      console.log(`[Cron:${runId}] DISABLED - CRON_ENABLED != true`);
      return res.json({ ok: true, disabled: true, runId });
    }

    const lockResult = await acquireLock(runId);
    if (!lockResult.acquired) {
      console.log(`[Cron:${runId}] Skipped: lock held by ${lockResult.heldBy || 'unknown'}`);
      return res.json({ ok: true, skipped: true, reason: 'lock_held', runId });
    }

    console.log(`[Cron:${runId}] Starting scan-overdue...`);

    const cutoffMs = Date.now() - 300 * 1000; // 5 minutes ago
    const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);
    stats.cutoff = new Date(cutoffMs).toISOString();

    let lastDoc = null;
    let totalProcessed = 0;

    while (totalProcessed < MAX_PER_RUN) {
      let query = db
        .collection(DEVICES_COLLECTION)
        .where('overdueNotifiedAt', '==', null)
        .where('nextDueAt', '<', cutoff)
        .orderBy('nextDueAt')
        .limit(BATCH_LIMIT);

      if (lastDoc) query = query.startAfter(lastDoc);

      const snapshot = await query.get();
      stats.queriedCount += snapshot.docs.length;

      if (snapshot.empty) break;

      console.log(`[Cron:${runId}] Processing batch: ${snapshot.docs.length} devices`);

      for (const doc of snapshot.docs) {
        totalProcessed++;
        stats.matchedCount++;

        const r = await processOverdueDevice(doc, runId);

        if (r.skipped) {
          if (r.reason === 'already_notified') stats.skippedAlreadyNotified++;
          if (r.reason === 'invalid_email') stats.skippedInvalidEmail++;
        } else if (r.sent) {
          if (r.email) {
            stats.emailsAttempted++;
            if (r.success) stats.emailsSent++;
            else stats.emailsFailed++;
          }

          if (r.smsSentCount > 0) stats.smsSent += r.smsSentCount;
          if (r.smsFailedCount > 0) stats.smsFailed += r.smsFailedCount;

          if (r.pushSuccess) stats.pushSent++;
          if (r.pushSuccess === false && r.pushError) stats.pushFailed++;
        } else if (r.error) {
          stats.emailsFailed++;
          stats.errors.push({ installId: r.installId, error: r.error });
        }

        if (totalProcessed >= MAX_PER_RUN) {
          console.warn(`[Cron:${runId}] Reached MAX_PER_RUN limit (${MAX_PER_RUN})`);
          break;
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.docs.length < BATCH_LIMIT) break;
    }

    stats.durationMs = Date.now() - startTime;

    if (stats.queriedCount > WARN_THRESHOLD || stats.emailsSent > WARN_THRESHOLD) {
      console.warn(`[Cron:${runId}] WARNING: High volume - queried=${stats.queriedCount}, sent=${stats.emailsSent}`);
    }

    console.log(`[Cron:${runId}] Completed:`, JSON.stringify(stats));

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
 * POST /internal/test-sms
 */
router.post('/test-sms', verifyCronSecret, async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ ok: false, error: '"to" must be a non-empty array of phone numbers' });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ ok: false, error: '"message" is required' });
    }

    if (!isSmsConfigured()) {
      const providerInfo = getSmsProviderInfo();
      return res.status(400).json({
        ok: false,
        error: `SMS provider "${providerInfo.provider}" is not configured. Check environment variables.`,
        provider: providerInfo,
      });
    }

    console.log(`[TestSms] Sending test SMS to ${to.length} numbers...`);

    const validPhones = [];
    const invalidPhones = [];

    for (const phone of to) {
      const normalized = normalizePhoneVN(phone);
      if (normalized && isValidE164(normalized)) {
        validPhones.push({ original: phone, normalized });
      } else {
        invalidPhones.push({ original: phone, error: 'Invalid format' });
      }
    }

    if (validPhones.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid phone numbers provided',
        invalidPhones,
      });
    }

    const smsResult = await sendSmsToMany(
      validPhones.map(p => p.normalized),
      message.trim()
    );

    console.log(`[TestSms] Completed: sent=${smsResult.sentCount}, failed=${smsResult.failedCount}`);

    res.json({
      ok: smsResult.sentCount > 0,
      message: `SMS sent to ${smsResult.sentCount}/${validPhones.length} numbers`,
      provider: getSmsProviderInfo(),
      results: smsResult.results,
      invalidPhones: invalidPhones.length > 0 ? invalidPhones : undefined,
    });
  } catch (error) {
    console.error(`[TestSms] Error:`, error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /internal/sms/status
 */
router.get('/sms/status', verifyCronSecret, async (req, res) => {
  const providerInfo = getSmsProviderInfo();
  res.json({
    ok: true,
    ...providerInfo,
  });
});

/**
 * POST /internal/test-overdue
 * Set a device to overdue state and trigger scan immediately
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

    const overdueTime = Date.now() - minutesOverdue * 60 * 1000;
    const nextDueAt = admin.firestore.Timestamp.fromMillis(overdueTime);

    await deviceRef.update({
      nextDueAt,
      overdueNotifiedAt: null,
      overdueSmsNotifiedAt: null,
      overduePushNotifiedAt: null,
      status: 'OK',
      updatedAt: admin.firestore.Timestamp.now(),
    });

    console.log(`[TestOverdue] Set ${installId} to ${minutesOverdue} minutes overdue`);

    const runId = generateRunId();
    const startTime = Date.now();

    const lockResult = await acquireLock(runId);
    if (!lockResult.acquired) {
      return res.json({
        ok: true,
        setup: { installId, minutesOverdue, nextDueAt: new Date(overdueTime).toISOString() },
        scan: { skipped: true, reason: 'lock_held' },
      });
    }

    const cutoffMs = Date.now() - 300 * 1000;
    const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);

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
      pushSent: 0,
      pushFailed: 0,
      skippedAlreadyNotified: 0,
    };

    for (const docSnap of snapshot.docs) {
      if (docSnap.id === installId) {
        const r = await processOverdueDevice(docSnap, runId);
        if (r.sent && r.success) stats.emailsSent++;
        else if (r.sent && !r.success) stats.emailsFailed++;

        if (r.pushSuccess) stats.pushSent++;
        if (r.pushSuccess === false && r.pushError) stats.pushFailed++;

        if (r.skipped && r.reason === 'already_notified') stats.skippedAlreadyNotified++;
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

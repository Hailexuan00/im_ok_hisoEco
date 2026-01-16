const { db } = require('../firebaseAdmin');
const admin = require('firebase-admin');
const { sendPushToLinkedContacts } = require('./notificationService');
const { sendEmailToContacts } = require('./emailService');

/**
 * Execute push notification step
 */
async function executePushStep(userId, userData) {
  console.log(`[Push] Executing push step for user ${userId}`);
  const results = await sendPushToLinkedContacts(userId, userData);

  console.log(`[Push] Results:`, JSON.stringify(results));

  const successCount = results.filter(r => r.status === 'sent').length;
  const totalCount = results.length;

  if (totalCount === 0) {
    console.log(`[Push] No contacts found for user ${userId}`);
    return { success: false, error: 'NO_CONTACTS' };
  }

  return {
    success: successCount > 0,
    messageId: results.map(r => r.messageId).filter(Boolean).join(','),
    error: successCount === 0 ? 'ALL_FAILED' : null,
  };
}

/**
 * Execute email step via SendGrid
 */
async function executeEmailStep(userId, userData) {
  console.log(`[Email] Executing email step for user ${userId}`);
  const results = await sendEmailToContacts(userId, userData);

  console.log(`[Email] Results:`, JSON.stringify(results));

  const successCount = results.filter(r => r.status === 'sent').length;
  const totalCount = results.length;

  if (totalCount === 0) {
    console.log(`[Email] No email contacts found for user ${userId}`);
    return { success: false, error: 'NO_EMAIL_CONTACTS' };
  }

  return {
    success: successCount > 0,
    messageId: results.map(r => r.messageId).filter(Boolean).join(','),
    error: successCount === 0 ? 'ALL_FAILED' : null,
  };
}

/**
 * Execute SMS step (TODO: Implement Twilio)
 */
async function executeSmsStep(userId, userData) {
  // TODO: Implement Twilio integration
  console.log(`[SMS] SMS sending not implemented yet for user ${userId}`);
  return {
    success: false,
    error: 'NOT_IMPLEMENTED',
  };
}

/**
 * Create a new alert for an overdue user
 * @param {string} userId
 * @param {object} userData
 * @returns {Promise<string>} Alert ID
 */
async function createAlert(userId, userData) {
  const now = new Date();
  const status = userData.status || {};
  const policy = userData.checkinPolicy || {};

  // Get escalation steps with proper fallback
  let escalationSteps = [
    { type: 'push', delayMinutes: 0 },
    { type: 'email', delayMinutes: 30 },
    { type: 'sms', delayMinutes: 60 },
  ];

  if (policy.escalation && Array.isArray(policy.escalation.steps) && policy.escalation.steps.length > 0) {
    escalationSteps = policy.escalation.steps;
  }

  console.log(`[Alert] User ${userId} escalation config:`, JSON.stringify(policy.escalation || 'using default'));

  // Initialize step results
  const stepResults = escalationSteps.map(step => ({
    type: step.type,
    delayMinutes: step.delayMinutes || 0,
    status: 'pending',
    target: '',
    providerMessageId: null,
    error: null,
    sentAt: null,
  }));

  const alertData = {
    id: '', // Will be set after creation
    uid: userId,
    dueAt: status.nextDueAt?.toDate?.()?.toISOString() || now.toISOString(),
    overdueAt: status.overdueSince?.toDate?.()?.toISOString() || now.toISOString(),
    createdAt: now.toISOString(),
    status: 'pending',
    stepResults,
    currentStepIndex: 0,
  };

  // Debug: log the alert data being created
  console.log(`[Alert] Creating alert for user ${userId} with ${stepResults.length} escalation steps`);

  const alertRef = await db
    .collection('users')
    .doc(userId)
    .collection('alerts')
    .add(alertData);

  // Update alert with its own ID
  await alertRef.update({ id: alertRef.id });

  console.log(`[Alert] Created alert ${alertRef.id} for user ${userId}, steps: ${JSON.stringify(stepResults.map(s => s.type))}`);

  // IMMEDIATELY send push notification if first step is push with delay 0
  if (escalationSteps[0]?.type === 'push' && (escalationSteps[0]?.delayMinutes || 0) === 0) {
    console.log(`[Alert] Immediately sending push notification for alert ${alertRef.id}`);
    try {
      const pushResult = await executePushStep(userId, userData);

      // Update the first step result
      stepResults[0] = {
        ...stepResults[0],
        status: pushResult.success ? 'sent' : 'failed',
        sentAt: now.toISOString(),
        error: pushResult.error || null,
        providerMessageId: pushResult.messageId || null,
      };

      await alertRef.update({
        stepResults,
        currentStepIndex: 1,
      });

      console.log(`[Alert] Immediate push result: ${pushResult.success ? 'sent' : 'failed'}, error: ${pushResult.error || 'none'}`);
    } catch (error) {
      console.error(`[Alert] Error sending immediate push:`, error);
      // Update step as failed
      stepResults[0] = {
        ...stepResults[0],
        status: 'failed',
        sentAt: now.toISOString(),
        error: error.message,
      };
      await alertRef.update({
        stepResults,
        currentStepIndex: 1,
      });
    }
  }

  return alertRef.id;
}

/**
 * Process a single alert's escalation
 */
async function processAlertEscalation(userId, userData, alertId, alert) {
  const now = new Date();
  const alertCreatedAt = new Date(alert.createdAt);
  const stepResults = alert.stepResults || [];
  const currentStepIndex = alert.currentStepIndex ?? 0;

  // Debug logging
  console.log(`[Escalation] Processing alert ${alertId}: currentStepIndex=${currentStepIndex}, stepResults.length=${stepResults.length}`);

  // Check if stepResults is empty or undefined
  if (!stepResults || stepResults.length === 0) {
    console.log(`[Escalation] Alert ${alertId} has no stepResults, marking as sent`);
    await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .doc(alertId)
      .update({ status: 'sent' });
    return;
  }

  if (currentStepIndex >= stepResults.length) {
    // All steps completed
    await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .doc(alertId)
      .update({ status: 'sent' });
    console.log(`[Escalation] Alert ${alertId} completed all steps (index ${currentStepIndex} >= ${stepResults.length})`);
    return;
  }

  const currentStep = stepResults[currentStepIndex];
  const delayMinutes = currentStep.delayMinutes || 0;
  const stepDueTime = new Date(alertCreatedAt.getTime() + delayMinutes * 60 * 1000);

  // Check if it's time to execute this step
  if (now < stepDueTime) {
    console.log(`[Escalation] Not yet time for step ${currentStepIndex}, due at ${stepDueTime.toISOString()}`);
    return; // Not yet time for this step
  }

  // Check if already processed
  if (currentStep.status !== 'pending') {
    console.log(`[Escalation] Step ${currentStepIndex} already processed with status: ${currentStep.status}`);
    // Move to next step
    await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .doc(alertId)
      .update({ currentStepIndex: currentStepIndex + 1 });
    return;
  }

  console.log(`[Escalation] Executing step ${currentStepIndex} (${currentStep.type}) for alert ${alertId}`);

  try {
    let result;

    switch (currentStep.type) {
      case 'push':
        result = await executePushStep(userId, userData);
        break;
      case 'email':
        result = await executeEmailStep(userId, userData);
        break;
      case 'sms':
        result = await executeSmsStep(userId, userData);
        break;
      default:
        result = { success: false, error: 'UNKNOWN_STEP_TYPE' };
    }

    // Update step result
    stepResults[currentStepIndex] = {
      ...currentStep,
      status: result.success ? 'sent' : 'failed',
      sentAt: now.toISOString(),
      error: result.error || null,
      providerMessageId: result.messageId || null,
    };

    // Update alert
    await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .doc(alertId)
      .update({
        stepResults,
        currentStepIndex: currentStepIndex + 1,
      });

    // Update user's lastEscalationAt
    await db.collection('users').doc(userId).update({
      'status.lastEscalationAt': admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[Escalation] Step ${currentStepIndex} completed with status: ${result.success ? 'sent' : 'failed'}`);
  } catch (error) {
    console.error(`[Escalation] Error processing step:`, error);

    stepResults[currentStepIndex] = {
      ...currentStep,
      status: 'failed',
      sentAt: now.toISOString(),
      error: error.message,
    };

    await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .doc(alertId)
      .update({
        stepResults,
        currentStepIndex: currentStepIndex + 1,
      });
  }
}

/**
 * Process escalation steps for pending alerts
 */
async function processEscalations() {
  const now = new Date();
  console.log(`[Escalation] Starting escalation processing at ${now.toISOString()}`);

  try {
    // Get all users
    const usersSnapshot = await db.collection('users').get();

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();

      // Get pending alerts for this user
      const alertsSnapshot = await db
        .collection('users')
        .doc(userId)
        .collection('alerts')
        .where('status', '==', 'pending')
        .get();

      for (const alertDoc of alertsSnapshot.docs) {
        const alert = alertDoc.data();
        await processAlertEscalation(userId, userData, alertDoc.id, alert);
      }
    }

    console.log(`[Escalation] Completed escalation processing`);
  } catch (error) {
    console.error(`[Escalation] Error:`, error);
  }
}

/**
 * Cancel all pending alerts for a user (when they check in)
 */
async function cancelPendingAlerts(userId) {
  try {
    const alertsSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .where('status', '==', 'pending')
      .get();

    const batch = db.batch();
    let count = 0;

    alertsSnapshot.forEach(doc => {
      batch.update(doc.ref, { status: 'cancelled' });
      count++;
    });

    if (count > 0) {
      await batch.commit();
      console.log(`[Alert] Cancelled ${count} pending alerts for user ${userId}`);
    }

    return count;
  } catch (error) {
    console.error(`[Alert] Error cancelling alerts:`, error);
    throw error;
  }
}

module.exports = {
  createAlert,
  processEscalations,
  cancelPendingAlerts,
};

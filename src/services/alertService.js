const { db } = require('../firebaseAdmin');
const admin = require('firebase-admin');
const { sendPushToLinkedContacts } = require('./notificationService');

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
  const escalationSteps = policy.escalation?.steps || [
    { type: 'push', delayMinutes: 0 },
    { type: 'email', delayMinutes: 30 },
    { type: 'sms', delayMinutes: 60 },
  ];

  // Initialize step results
  const stepResults = escalationSteps.map(step => ({
    type: step.type,
    delayMinutes: step.delayMinutes,
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

  const alertRef = await db
    .collection('users')
    .doc(userId)
    .collection('alerts')
    .add(alertData);

  // Update alert with its own ID
  await alertRef.update({ id: alertRef.id });

  console.log(`[Alert] Created alert ${alertRef.id} for user ${userId}`);
  return alertRef.id;
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
 * Process a single alert's escalation
 */
async function processAlertEscalation(userId, userData, alertId, alert) {
  const now = new Date();
  const alertCreatedAt = new Date(alert.createdAt);
  const stepResults = alert.stepResults || [];
  const currentStepIndex = alert.currentStepIndex || 0;

  if (currentStepIndex >= stepResults.length) {
    // All steps completed
    await db
      .collection('users')
      .doc(userId)
      .collection('alerts')
      .doc(alertId)
      .update({ status: 'sent' });
    console.log(`[Escalation] Alert ${alertId} completed all steps`);
    return;
  }

  const currentStep = stepResults[currentStepIndex];
  const delayMinutes = currentStep.delayMinutes || 0;
  const stepDueTime = new Date(alertCreatedAt.getTime() + delayMinutes * 60 * 1000);

  // Check if it's time to execute this step
  if (now < stepDueTime) {
    return; // Not yet time for this step
  }

  // Check if already processed
  if (currentStep.status !== 'pending') {
    return;
  }

  console.log(`[Escalation] Processing step ${currentStepIndex} (${currentStep.type}) for alert ${alertId}`);

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
 * Execute push notification step
 */
async function executePushStep(userId, userData) {
  const results = await sendPushToLinkedContacts(userId, userData);

  const successCount = results.filter(r => r.status === 'sent').length;
  const totalCount = results.length;

  if (totalCount === 0) {
    return { success: false, error: 'NO_CONTACTS' };
  }

  return {
    success: successCount > 0,
    messageId: results.map(r => r.messageId).filter(Boolean).join(','),
    error: successCount === 0 ? 'ALL_FAILED' : null,
  };
}

/**
 * Execute email step (TODO: Implement SendGrid)
 */
async function executeEmailStep(userId, userData) {
  // TODO: Implement SendGrid integration
  console.log(`[Email] Email sending not implemented yet for user ${userId}`);
  return {
    success: false,
    error: 'NOT_IMPLEMENTED',
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

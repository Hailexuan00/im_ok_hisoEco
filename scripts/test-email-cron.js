/**
 * Test script: Set device to overdue and trigger cron
 */

require('dotenv').config();
const { db, admin } = require('../src/firebaseAdmin');

const INSTALL_ID = 'test-email-001';

async function setDeviceOverdue() {
  console.log(`[Test] Setting device ${INSTALL_ID} to overdue...`);

  const docRef = db.collection('devices').doc(INSTALL_ID);
  const doc = await docRef.get();

  if (!doc.exists) {
    console.error('[Test] Device not found!');
    process.exit(1);
  }

  // Set nextDueAt to 10 minutes ago (past grace period)
  const pastTime = admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);

  await docRef.update({
    nextDueAt: pastTime,
    overdueNotifiedAt: null, // Reset to allow notification
    status: 'OK',
  });

  console.log('[Test] Device updated to overdue state');
  console.log(`[Test] nextDueAt: ${pastTime.toDate().toISOString()}`);
  console.log('[Test] Now call: curl http://localhost:3000/internal/cron/scan-overdue -H "x-cron-secret: test-secret-local"');

  process.exit(0);
}

setDeviceOverdue().catch(console.error);

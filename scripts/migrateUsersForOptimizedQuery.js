/**
 * Migration script: Add root-level fields for optimized Firestore queries
 *
 * This script adds two root-level fields to all existing users:
 * - isPaused: boolean (from checkinPolicy.isPaused)
 * - overdueCutoff: Timestamp (nextDueAt + graceMinutes)
 *
 * These fields enable efficient queries that don't require reading ALL users.
 *
 * Usage:
 *   node scripts/migrateUsersForOptimizedQuery.js
 *
 * Or via API endpoint:
 *   POST /api/admin/migrate-users-for-query
 */

const admin = require('firebase-admin');

// Initialize Firebase if not already done
if (!admin.apps.length) {
  const serviceAccount = require('../serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function migrateUsers() {
  console.log('[Migration] Starting migration for optimized query fields...');
  const startTime = Date.now();

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
          // No nextDueAt, set overdueCutoff far in the future (won't be queried)
          const now = new Date();
          const nextDueAt = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
          overdueCutoff = new Date(nextDueAt.getTime() + graceMinutes * 60 * 1000);
        }

        // Check if already has the fields
        if (userData.isPaused !== undefined && userData.overdueCutoff) {
          console.log(`[Migration] User ${userId} already has fields, skipping`);
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
    console.log(`[Migration] Completed in ${duration}ms`);
    console.log(`[Migration] Migrated: ${migratedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);

    return {
      success: true,
      migratedCount,
      skippedCount,
      errorCount,
      durationMs: duration,
    };
  } catch (error) {
    console.error('[Migration] Fatal error:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  migrateUsers()
    .then(result => {
      console.log('[Migration] Result:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('[Migration] Failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateUsers };

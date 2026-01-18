/**
 * Firebase Admin SDK Initialization
 * Firestore is the ONLY database (no MySQL)
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
if (!b64) {
  console.error('[Firebase] FATAL: Missing FIREBASE_SERVICE_ACCOUNT_B64');
  process.exit(1);
}

let db = null;
let auth = null;

try {
  const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  db = admin.firestore();
  auth = admin.auth();

  console.log('[Firebase] Initialized successfully');
} catch (error) {
  console.error('[Firebase] Initialization error:', error.message);
  process.exit(1);
}

module.exports = {
  admin,
  db,
  auth,
};

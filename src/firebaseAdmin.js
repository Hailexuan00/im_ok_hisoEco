const admin = require("firebase-admin");

const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
if (!b64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_B64");

const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth };

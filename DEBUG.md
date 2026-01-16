# AliveCheck Backend - Debug Guide
> **Last Updated: 2026-01-16**

---

## 1. Project Overview

| Item | Value |
|------|-------|
| Project Name | im_ok_be (AliveCheck Backend) |
| Framework | Express.js 5.x |
| Runtime | Node.js (CommonJS) |
| Database | Firebase Firestore |
| Push Notifications | Firebase Cloud Messaging (FCM) |
| Hosting | Railway |
| Scheduler | External Cron (cron-job.org) |
| **Production URL** | https://imokhisoeco-production.up.railway.app |
| **Cron Endpoint** | GET /api/notifications/cron |

---

## 2. Firebase Configuration

### Firebase Project Info
```
Project ID: im-ok-4b2d2
Messaging Sender ID: 619186991495
Storage Bucket: im-ok-4b2d2.firebasestorage.app
```

### Environment Variables (Railway)
```
PORT=3000
NODE_ENV=production
FIREBASE_SERVICE_ACCOUNT_B64=<base64-encoded-service-account-json>
```

### How to get FIREBASE_SERVICE_ACCOUNT_B64:
1. Go to Firebase Console > Project Settings > Service Accounts
2. Click "Generate new private key"
3. Download the JSON file
4. Encode to base64:
   ```bash
   base64 -i serviceAccountKey.json
   ```
5. Copy the output to Railway Variables

---

## 3. App Initialization Flow

```
main (src/index.js)
├── require('dotenv').config()
├── Initialize Firebase Admin SDK
│   ├── Decode FIREBASE_SERVICE_ACCOUNT_B64
│   ├── Parse JSON credentials
│   └── admin.initializeApp()
├── Configure Express middlewares
│   ├── cors()
│   ├── express.json()
│   └── express.urlencoded()
├── Setup routes
│   ├── GET / (Welcome)
│   ├── GET /health (Firestore health check)
│   └── /api/* (API routes)
├── Error handling middleware
├── 404 handler
└── app.listen(PORT)
    └── initializeScheduler()
        ├── checkOverdueUsers (every 5 min)
        └── processEscalations (every 1 min)
```

---

## 4. Project Structure

```
im_ok_be/
├── src/
│   ├── index.js                 # Main entry point
│   ├── firebaseAdmin.js         # Firebase Admin SDK initialization
│   ├── config/                  # (Empty - ready for config)
│   ├── controllers/
│   │   └── user.controller.js   # User CRUD (demo)
│   ├── middlewares/             # (Empty - ready for auth middleware)
│   ├── models/                  # (Empty - Firestore is schemaless)
│   ├── routes/
│   │   ├── index.js             # Routes aggregator
│   │   ├── user.routes.js       # User endpoints
│   │   ├── notification.routes.js # Notification endpoints
│   │   └── webhook.routes.js    # Webhook endpoints
│   ├── services/
│   │   ├── notificationService.js # FCM push notifications
│   │   ├── alertService.js      # Alert creation & escalation
│   │   └── userService.js       # User status management
│   └── jobs/
│       └── scheduler.js         # Cron jobs
├── tests/                       # (Empty - ready for tests)
├── package.json
├── package-lock.json
├── .env                         # Local environment (gitignored)
├── .gitignore
├── DEBUG.md                     # This file
└── PROJECT_PLAN.md              # Project plan
```

---

## 5. API Endpoints

### Health & Status
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Welcome message |
| GET | `/health` | Firestore connectivity check |

### Users (Demo)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | Get all users (in-memory demo) |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users` | Create user |
| PUT | `/api/users/:id` | Update user |
| DELETE | `/api/users/:id` | Delete user |

### Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/notifications/test` | Test push to linked contacts |
| POST | `/api/notifications/send` | Send direct FCM notification |
| POST | `/api/notifications/trigger-overdue-check` | Manual trigger overdue check |
| POST | `/api/notifications/trigger-escalations` | Manual trigger escalations |

### Webhooks (Called from Mobile App)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/checkin` | Handle user check-in |
| POST | `/api/webhooks/user-created` | Initialize new user |

---

## 6. Scheduled Jobs

### checkOverdueUsers
- **Schedule**: Every 5 minutes (`*/5 * * * *`)
- **Purpose**: Scan all users, detect overdue, create alerts
- **Logic**:
  1. Get all users from Firestore
  2. For each user:
     - Skip if `checkinPolicy.isPaused = true`
     - Calculate `gracePeriodEnd = nextDueAt + graceMinutes`
     - If `now > gracePeriodEnd` → User is overdue
  3. Mark user as overdue (`status.isOverdue = true`)
  4. Create alert document in `users/{uid}/alerts`

### processEscalations
- **Schedule**: Every 1 minute (`* * * * *`)
- **Purpose**: Process pending alerts, execute escalation steps
- **Logic**:
  1. Get all users with pending alerts
  2. For each pending alert:
     - Check current step's delay time
     - If ready → Execute step (push/email/sms)
     - Update `stepResults` with status
     - Move to next step

---

## 7. Services

### notificationService.js

```javascript
// Send single FCM notification
sendPushNotification(fcmToken, notification, data)
// Returns: { success: boolean, messageId?: string, error?: string }

// Send to all linked contacts of a user
sendPushToLinkedContacts(userId, userData)
// Returns: [{ contactId, status, messageId?, error? }]

// Send reminder to user themselves
sendReminderToUser(userId, userData)
```

### alertService.js

```javascript
// Create new alert for overdue user
createAlert(userId, userData)
// Returns: alertId (string)

// Process all pending escalations
processEscalations()

// Cancel pending alerts (when user checks in)
cancelPendingAlerts(userId)
// Returns: number of cancelled alerts
```

### userService.js

```javascript
// Check all users for overdue status
checkOverdueUsers()
// Returns: { overdueCount, alertsCreated }

// Initialize defaults for new user
initializeUserDefaults(userId, userData)

// Handle user check-in
handleCheckin(userId, checkinData)
// Returns: { nextDueAt, cancelledAlerts }
```

---

## 8. Firestore Schema (Backend Perspective)

### users/{uid}
```javascript
{
  uid: string,
  email: string,
  displayName: string,
  fcmToken: string?,              // FCM device token

  checkinPolicy: {
    intervalHours: number,        // 24, 48, 72
    reminderTime: string,         // "09:00"
    graceMinutes: number,         // 30-180
    isPaused: boolean,
    escalation: {
      steps: [{
        type: "push" | "email" | "sms",
        delayMinutes: number      // 0, 30, 60
      }]
    }
  },

  status: {
    lastCheckinAt: Timestamp?,
    nextDueAt: Timestamp,
    isOverdue: boolean,
    overdueSince: Timestamp?,
    lastEscalationAt: Timestamp?
  }
}
```

### users/{uid}/contacts/{contactId}
```javascript
{
  name: string,
  type: "email" | "phone" | "app",
  value: string?,                  // For email/phone
  linkedUid: string?,              // For app type (used by backend)
  priority: number                 // 1-5
}
```

### users/{uid}/alerts/{alertId}
```javascript
{
  id: string,
  uid: string,
  dueAt: string,                   // ISO timestamp
  overdueAt: string,
  createdAt: string,
  status: "pending" | "sent" | "failed" | "cancelled",
  currentStepIndex: number,
  stepResults: [{
    type: "push" | "email" | "sms",
    delayMinutes: number,
    status: "pending" | "sent" | "failed",
    target: string,
    providerMessageId: string?,
    error: string?,
    sentAt: string?
  }]
}
```

---

## 9. FCM Push Notification

### Message Structure
```javascript
{
  token: fcmToken,
  notification: {
    title: "AliveCheck Alert",
    body: "John has not checked in and may need help!"
  },
  data: {
    type: "OVERDUE_ALERT",
    fromUserId: "uid123",
    fromUserName: "John",
    click_action: "FLUTTER_NOTIFICATION_CLICK"
  },
  android: {
    priority: "high",
    notification: {
      channelId: "alivecheck_alerts",
      priority: "max"
    }
  },
  apns: {
    payload: {
      aps: {
        sound: "default",
        badge: 1
      }
    }
  }
}
```

### Invalid Token Handling
- If FCM returns `messaging/invalid-registration-token` or `messaging/registration-token-not-registered`
- Backend automatically deletes the invalid token from Firestore
- Logs: `[FCM] Removed invalid token for user {uid}`

---

## 10. Escalation Flow

```
User becomes overdue
        │
        ▼
┌─────────────────────────────────┐
│ checkOverdueUsers() runs        │
│ (every 5 minutes)               │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ Create Alert                    │
│ status: "pending"               │
│ currentStepIndex: 0             │
│ stepResults: [                  │
│   { type: "push", delay: 0 },   │
│   { type: "email", delay: 30 }, │
│   { type: "sms", delay: 60 }    │
│ ]                               │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ processEscalations() runs       │
│ (every 1 minute)                │
└─────────────────────────────────┘
        │
        ├── Step 0 (delay: 0 min)
        │   └── Send PUSH to linked contacts
        │
        ├── Step 1 (delay: 30 min)
        │   └── Send EMAIL (TODO: SendGrid)
        │
        └── Step 2 (delay: 60 min)
            └── Send SMS (TODO: Twilio)
        │
        ▼
┌─────────────────────────────────┐
│ All steps completed             │
│ Alert status: "sent"            │
└─────────────────────────────────┘
```

---

## 11. Debug Commands

### Local Development
```bash
# Install dependencies
npm install

# Run with nodemon (auto-reload)
npm run dev

# Run production mode
npm start

# Check logs
# Logs are printed to console with prefixes:
# [Scheduler], [FCM], [Alert], [Escalation], [OverdueCheck], etc.
```

### Test Endpoints (cURL)
```bash
# Health check
curl http://localhost:3000/health

# Test push notification
curl -X POST http://localhost:3000/api/notifications/test \
  -H "Content-Type: application/json" \
  -d '{"fromUserId": "USER_UID_HERE"}'

# Trigger overdue check manually
curl -X POST http://localhost:3000/api/notifications/trigger-overdue-check

# Trigger escalations manually
curl -X POST http://localhost:3000/api/notifications/trigger-escalations

# Simulate user check-in
curl -X POST http://localhost:3000/api/webhooks/checkin \
  -H "Content-Type: application/json" \
  -d '{"userId": "USER_UID_HERE"}'

# Initialize new user
curl -X POST http://localhost:3000/api/webhooks/user-created \
  -H "Content-Type: application/json" \
  -d '{"userId": "USER_UID_HERE"}'
```

### Railway Logs
```bash
# View logs on Railway dashboard
# Or use Railway CLI:
railway logs
```

---

## 12. Common Issues & Solutions

### Firebase Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| `Missing FIREBASE_SERVICE_ACCOUNT_B64` | Env var not set | Add to Railway Variables |
| `Invalid service account` | Wrong base64 encoding | Re-encode JSON file |
| `PERMISSION_DENIED` | Firestore rules | Check rules allow server access |
| `App not initialized` | Firebase init failed | Check credentials |

### FCM Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| `NO_FCM_TOKEN` | User has no token | User needs to login on app |
| `INVALID_TOKEN` | Token expired/invalid | Auto-cleaned by backend |
| `NO_CONTACTS` | No linked contacts | User needs to add contacts |
| `ALL_FAILED` | All sends failed | Check contact FCM tokens |

### Scheduler Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Jobs not running | Server not started | Check server is running |
| Jobs running twice | Multiple instances | Use single instance on Railway |
| Timezone issues | Server timezone | Use UTC in calculations |

---

## 13. Integration with Mobile App

### When Mobile App should call Backend:

1. **User Check-in** (Optional - can use Firestore trigger)
   ```
   POST /api/webhooks/checkin
   Body: { userId: "uid" }
   ```

2. **New User Registration** (Optional)
   ```
   POST /api/webhooks/user-created
   Body: { userId: "uid" }
   ```

### Mobile App Responsibilities:
- Save FCM token to `users/{uid}/fcmToken`
- Handle incoming push notifications
- Display alerts from `users/{uid}/alerts`
- Update check-in data to Firestore

### Backend Responsibilities:
- Monitor overdue users
- Create alerts
- Send push notifications
- Process escalation steps
- Clean up invalid FCM tokens

---

## 14. Dependencies

```json
{
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^17.2.3",
    "express": "^5.2.1",
    "firebase-admin": "^13.6.0",
    "node-cron": "^4.2.1"
  },
  "devDependencies": {
    "nodemon": "^3.1.11"
  }
}
```

---

## 15. Pending Tasks

### High Priority
- [ ] Test full escalation flow on Railway
- [ ] Implement SendGrid email integration
- [ ] Implement Twilio SMS integration
- [ ] Add authentication middleware

### Medium Priority
- [ ] Add rate limiting
- [ ] Add request logging
- [ ] Add error tracking (Sentry)
- [ ] Write unit tests

### Low Priority
- [ ] Add admin endpoints
- [ ] Add metrics/analytics
- [ ] Add API documentation (Swagger)

---

## 16. Changelog

### 2026-01-16
- Initial backend setup with Express.js
- Firebase Admin SDK integration
- Scheduled jobs: checkOverdueUsers, processEscalations
- Services: notificationService, alertService, userService
- Webhook endpoints for mobile integration
- Push notification via FCM
- Invalid FCM token auto-cleanup

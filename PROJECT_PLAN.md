# AliveCheck Backend - Project Plan
> **Target Scale: 10,000+ users** | **Core Feature: Auto Alert System**
> **Stack: Node.js + Express + Firebase Admin SDK + Railway**
> **Last Updated: 2026-01-16**

---

## Project Status Summary

| Category | Status | Details |
|----------|--------|---------|
| **Express Server** | ✅ Completed | Health check, CORS, JSON parsing |
| **Firebase Admin SDK** | ✅ Completed | Firestore + FCM integration |
| **Scheduled Jobs** | ✅ Completed | checkOverdueUsers, processEscalations |
| **Push Notifications** | ✅ Completed | FCM to linked contacts |
| **Webhooks** | ✅ Completed | checkin, user-created |
| **Email (SendGrid)** | ⬜ Planned | TODO in escalation step |
| **SMS (Twilio)** | ⬜ Planned | TODO in escalation step |
| **Authentication** | ⬜ Planned | JWT/Firebase Auth verification |
| **Deployment** | ✅ Ready | Railway compatible |

---

## 1. CORE IDEA

Backend service chạy trên Railway để:
1. **Quét users quá hạn** mỗi 5 phút
2. **Tạo alerts** khi user không check-in đúng hạn
3. **Gửi thông báo** theo escalation steps (push → email → sms)
4. **Xử lý webhooks** từ mobile app

---

## 2. ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────┐
│                         RAILWAY                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    EXPRESS SERVER                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │   Routes    │  │  Services   │  │    Jobs     │       │  │
│  │  │ /api/*      │  │ notification│  │ scheduler   │       │  │
│  │  │ /webhooks/* │  │ alert       │  │ cron tasks  │       │  │
│  │  │ /health     │  │ user        │  │             │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      FIREBASE                                    │
│  ┌─────────────────┐  ┌─────────────────┐                       │
│  │    FIRESTORE    │  │      FCM        │                       │
│  │  - users        │  │  Push Messages  │                       │
│  │  - contacts     │  │                 │                       │
│  │  - checkins     │  │                 │                       │
│  │  - alerts       │  │                 │                       │
│  └─────────────────┘  └─────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MOBILE APP (Flutter)                          │
│  - Receives push notifications                                   │
│  - Displays alerts                                               │
│  - Saves FCM token to Firestore                                  │
│  - Calls webhooks on check-in                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. FEATURES - Implementation Status

### 3.1 Express Server ✅ COMPLETED
- [x] Express 5.x setup
- [x] CORS enabled
- [x] JSON body parsing
- [x] Health check endpoint
- [x] Error handling middleware
- [x] 404 handler

**File:** `src/index.js`

### 3.2 Firebase Integration ✅ COMPLETED
- [x] Firebase Admin SDK initialization
- [x] Service account from Base64 env var
- [x] Firestore database access
- [x] FCM messaging

**File:** `src/firebaseAdmin.js`

### 3.3 Scheduled Jobs ✅ COMPLETED
- [x] node-cron integration
- [x] checkOverdueUsers (every 5 min)
- [x] processEscalations (every 1 min)

**File:** `src/jobs/scheduler.js`

### 3.4 Notification Service ✅ COMPLETED
- [x] Send single FCM notification
- [x] Send to all linked contacts
- [x] Send reminder to user
- [x] Invalid token cleanup
- [x] Android high priority
- [x] iOS sound/badge

**File:** `src/services/notificationService.js`

### 3.5 Alert Service ✅ COMPLETED
- [x] Create alert with escalation steps
- [x] Process escalation steps
- [x] Execute push step
- [x] Cancel pending alerts
- [x] Step result tracking
- [ ] Execute email step (SendGrid)
- [ ] Execute SMS step (Twilio)

**File:** `src/services/alertService.js`

### 3.6 User Service ✅ COMPLETED
- [x] Check overdue users
- [x] Update user status
- [x] Initialize user defaults
- [x] Handle check-in

**File:** `src/services/userService.js`

### 3.7 API Routes ✅ COMPLETED
- [x] Notification routes
- [x] Webhook routes
- [x] User routes (demo)

**Files:** `src/routes/*.js`

---

## 4. API SPECIFICATION

### 4.1 Health & Status

```
GET /
Response: { message: "Welcome to im_ok_be API" }

GET /health
Response: { ok: true, timestamp: "2026-01-16T..." }
```

### 4.2 Notification Endpoints

```
POST /api/notifications/test
Body: { fromUserId: string }
Response: {
  ok: true,
  message: "Test notifications sent",
  results: [{ contactId, status, messageId?, error? }]
}

POST /api/notifications/send
Body: { fcmToken: string, title: string, body: string, data?: object }
Response: { ok: true, messageId: string }

POST /api/notifications/trigger-overdue-check
Response: { ok: true, overdueCount: number, alertsCreated: number }

POST /api/notifications/trigger-escalations
Response: { ok: true, message: "Escalation processing completed" }
```

### 4.3 Webhook Endpoints

```
POST /api/webhooks/checkin
Body: { userId: string, checkinId?: string }
Response: {
  ok: true,
  nextDueAt: "2026-01-17T...",
  cancelledAlerts: number
}

POST /api/webhooks/user-created
Body: { userId: string }
Response: { ok: true, updates: { checkinPolicy, status } }
```

---

## 5. ESCALATION CONFIGURATION

### Default Escalation Steps
```javascript
escalation: {
  steps: [
    { type: "push", delayMinutes: 0 },    // Immediate
    { type: "email", delayMinutes: 30 },  // After 30 min
    { type: "sms", delayMinutes: 60 }     // After 1 hour
  ]
}
```

### Step Execution Flow
1. **Alert Created** → currentStepIndex: 0
2. **processEscalations runs** (every 1 min)
3. **Check delay time** → Is `now >= alertCreatedAt + delayMinutes`?
4. **Execute step** → Send notification based on type
5. **Update stepResults** → Record status, sentAt, error
6. **Increment currentStepIndex**
7. **Repeat until all steps done**

### Step Status Values
- `pending` - Not yet executed
- `sent` - Successfully sent
- `failed` - Failed to send (with error message)

---

## 6. MOBILE APP INTEGRATION

### Required Actions from Mobile App:

1. **Save FCM Token** (on login/token refresh)
   ```javascript
   // Firestore path: users/{uid}
   {
     fcmToken: "token_string",
     fcmTokenUpdatedAt: Timestamp
   }
   ```

2. **Call Webhook on Check-in** (optional)
   ```javascript
   // POST /api/webhooks/checkin
   // OR write directly to Firestore and let backend detect via scheduled job
   ```

3. **Handle Incoming Notifications**
   ```javascript
   // Notification data structure:
   {
     type: "OVERDUE_ALERT",
     fromUserId: "uid",
     fromUserName: "John"
   }
   ```

### Backend Provides:

1. **Automatic overdue detection** (every 5 min)
2. **Alert creation** with escalation steps
3. **Push notifications** to linked contacts
4. **Token cleanup** for invalid FCM tokens

---

## 7. ENVIRONMENT VARIABLES

### Required
```bash
# Railway will auto-assign
PORT=3000

# Must be set manually in Railway
FIREBASE_SERVICE_ACCOUNT_B64=<base64-encoded-json>
```

### Optional (for future features)
```bash
NODE_ENV=production

# SendGrid (email)
SENDGRID_API_KEY=
SENDGRID_FROM_EMAIL=

# Twilio (SMS)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
```

---

## 8. DEPLOYMENT (Railway)

### Steps to Deploy:

1. **Connect GitHub Repo**
   - Go to Railway Dashboard
   - New Project → Deploy from GitHub repo
   - Select `Hailexuan00/im_ok_hisoEco`

2. **Add Environment Variables**
   - Go to Variables tab
   - Add `FIREBASE_SERVICE_ACCOUNT_B64`

3. **Deploy**
   - Railway auto-deploys on push to main
   - Check Deployments tab for logs

4. **Get Domain**
   - Go to Settings → Domains
   - Generate Railway domain or add custom domain

### Health Check
```bash
curl https://your-domain.railway.app/health
# Expected: { "ok": true, "timestamp": "..." }
```

---

## 9. CRON SCHEDULE REFERENCE

| Schedule | Cron Expression | Description |
|----------|-----------------|-------------|
| Every minute | `* * * * *` | processEscalations |
| Every 5 minutes | `*/5 * * * *` | checkOverdueUsers |
| Every hour | `0 * * * *` | (not used) |
| Every day at 9am | `0 9 * * *` | (not used) |

---

## 10. ERROR HANDLING

### HTTP Errors
```javascript
// 400 Bad Request
{ ok: false, error: "userId is required" }

// 404 Not Found
{ ok: false, error: "User not found" }

// 500 Internal Server Error
{ ok: false, error: "Error message" }
```

### FCM Error Codes
| Code | Meaning | Action |
|------|---------|--------|
| `messaging/invalid-registration-token` | Token is malformed | Delete token |
| `messaging/registration-token-not-registered` | Token expired | Delete token |
| `messaging/quota-exceeded` | Too many messages | Retry later |

---

## 11. LOGGING

### Log Prefixes
```
[Scheduler]   - Scheduled job events
[FCM]         - Firebase Cloud Messaging
[Alert]       - Alert creation/updates
[Escalation]  - Escalation processing
[OverdueCheck]- Overdue user detection
[Notification]- General notification events
[Checkin]     - User check-in events
[User]        - User management events
```

### Example Logs
```
[Scheduler] Running checkOverdueUsers job
[OverdueCheck] Starting check at 2026-01-16T10:00:00.000Z
[OverdueCheck] User abc123 is now overdue
[Alert] Created alert xyz789 for user abc123
[OverdueCheck] Completed. Found 1 overdue users, created 1 alerts

[Scheduler] Running processEscalations job
[Escalation] Processing step 0 (push) for alert xyz789
[FCM] Successfully sent message: projects/im-ok-4b2d2/messages/123
[Escalation] Step 0 completed with status: sent
```

---

## 12. TESTING CHECKLIST

### Before Going Live:
- [ ] Health check returns OK
- [ ] Can read/write to Firestore
- [ ] FCM token is valid
- [ ] Push notification received on device
- [ ] Overdue detection works
- [ ] Alert is created
- [ ] Escalation steps execute
- [ ] Check-in cancels alerts

### Manual Test Flow:
1. Create test user in Firestore
2. Set `nextDueAt` to past time
3. Trigger `/api/notifications/trigger-overdue-check`
4. Check alert created in `users/{uid}/alerts`
5. Trigger `/api/notifications/trigger-escalations`
6. Verify push received on linked contact's device
7. Call `/api/webhooks/checkin`
8. Verify alert cancelled

---

## 13. SECURITY CONSIDERATIONS

### Current Status:
- ⚠️ No authentication on endpoints
- ⚠️ Anyone can call webhooks
- ✅ Firebase Admin SDK uses service account

### Recommended Improvements:
1. **Add JWT verification** for webhooks
2. **Verify Firebase Auth token** on requests
3. **Rate limit** API endpoints
4. **IP whitelist** for sensitive endpoints

---

## 14. SCALING CONSIDERATIONS

### Current Architecture:
- Single instance on Railway
- In-memory cron jobs
- Firestore handles data scaling

### For 10,000+ Users:
- Consider **Redis** for job queue
- Use **Cloud Tasks** for delayed jobs
- Implement **batch processing** for notifications
- Add **caching** for frequently accessed data

---

## 15. NEXT STEPS

### Phase 1: Core (Current) ✅
- [x] Express server
- [x] Firebase integration
- [x] Push notifications
- [x] Scheduled jobs

### Phase 2: Communication
- [ ] SendGrid email integration
- [ ] Twilio SMS integration
- [ ] Message templates

### Phase 3: Security
- [ ] JWT authentication
- [ ] Rate limiting
- [ ] Request logging

### Phase 4: Monitoring
- [ ] Error tracking (Sentry)
- [ ] Performance monitoring
- [ ] Analytics dashboard

---

## 16. CONTACT & SUPPORT

### Project Repository
- **GitHub:** https://github.com/Hailexuan00/im_ok_hisoEco

### Related Projects
- **Mobile App:** Flutter app (separate repo)
- **Firebase Console:** https://console.firebase.google.com/project/im-ok-4b2d2

### Firebase Project
- **Project ID:** im-ok-4b2d2
- **Region:** (default)

---

## 17. CHANGELOG

### 2026-01-16 (Initial Release)
- Project setup with Express.js 5.x
- Firebase Admin SDK integration
- Scheduled jobs with node-cron
- Push notification service
- Alert and escalation system
- Webhook endpoints for mobile integration
- Documentation (DEBUG.md, PROJECT_PLAN.md)

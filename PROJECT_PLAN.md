# Im Ok Backend - Project Plan
> **Target Scale: 10,000+ users** | **Core Feature: Auto Alert System**
> **Stack: Node.js + Express + Firebase Admin SDK + Railway**
> **Last Updated: 2026-01-17**

---

## Project Status Summary

| Category | Status | Details |
|----------|--------|---------|
| **Express Server** | ✅ Completed | Health check, CORS, JSON parsing |
| **Firebase Admin SDK** | ✅ Completed | Firestore + FCM integration |
| **Scheduled Jobs** | ✅ Completed | External cron + node-cron |
| **Push Notifications** | ✅ Completed | FCM with multi-language (VI/EN) |
| **Webhooks** | ✅ Completed | checkin, user-created |
| **Email (Nodemailer)** | ✅ Completed | Gmail SMTP (500/day free) |
| **SMS (Twilio)** | ⬜ Planned | TODO in escalation step |
| **Firestore Optimization** | ✅ Completed | Query optimization, batch fetch |
| **Multi-language** | ✅ Completed | Vietnamese & English |
| **Authentication** | ⬜ Planned | JWT/Firebase Auth verification |
| **Deployment** | ✅ Live | https://imokhisoeco-production.up.railway.app |

---

## Quick Links

| Resource | URL |
|----------|-----|
| **Production API** | https://imokhisoeco-production.up.railway.app |
| **Health Check** | https://imokhisoeco-production.up.railway.app/health |
| **Cron Endpoint** | https://imokhisoeco-production.up.railway.app/api/notifications/cron |
| **GitHub Repo** | https://github.com/Hailexuan00/im_ok_hisoEco |
| **Firebase Console** | https://console.firebase.google.com/project/im-ok-4b2d2 |

---

## 1. CORE IDEA

Backend service chạy trên Railway để:
1. **Quét users quá hạn** mỗi 5 phút (via external cron)
2. **Tạo alerts** khi user không check-in đúng hạn
3. **Gửi thông báo** theo escalation steps (push → email → sms)
4. **Xử lý webhooks** từ mobile app

---

## 2. ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL CRON SERVICE                         │
│                     (cron-job.org - FREE)                        │
│              Calls GET /api/notifications/cron                   │
│                    every 5 minutes                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         RAILWAY                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    EXPRESS SERVER                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │   Routes    │  │  Services   │  │  Cron API   │       │  │
│  │  │ /api/*      │  │ notification│  │ /cron       │       │  │
│  │  │ /webhooks/* │  │ alert       │  │ (triggered) │       │  │
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

## 3. EXTERNAL CRON SETUP (QUAN TRỌNG!)

### Tại sao cần External Cron?
Railway free tier không hỗ trợ background cron jobs khi server "ngủ". Giải pháp: dùng dịch vụ cron bên ngoài (miễn phí) để gọi API định kỳ.

### Cron Endpoint
```
GET https://imokhisoeco-production.up.railway.app/api/notifications/cron
```

### Response
```json
{
  "ok": true,
  "message": "Cron job completed",
  "overdueCount": 0,
  "alertsCreated": 0,
  "durationMs": 123,
  "timestamp": "2026-01-16T10:00:00.000Z"
}
```

### Setup cron-job.org (Miễn phí - Khuyến nghị)

1. **Đăng ký**: https://cron-job.org (miễn phí)

2. **Tạo Cron Job**:
   - **Title**: AliveCheck Overdue Check
   - **URL**: `https://imokhisoeco-production.up.railway.app/api/notifications/cron`
   - **Schedule**: Every 5 minutes
   - **Request Method**: GET
   - **Timeout**: 30 seconds

3. **Enable và Save**

### Các dịch vụ cron miễn phí khác

| Dịch vụ | Miễn phí | Tần suất tối thiểu | URL |
|---------|----------|-------------------|-----|
| **cron-job.org** | ✅ Unlimited | 1 phút | https://cron-job.org |
| **UptimeRobot** | ✅ 50 monitors | 5 phút | https://uptimerobot.com |
| **Easycron** | ✅ 200/tháng | 1 phút | https://easycron.com |
| **Cronhub** | ✅ 1 job | 1 phút | https://cronhub.io |

---

## 4. FEATURES - Implementation Status

### 4.1 Express Server ✅ COMPLETED
- [x] Express 5.x setup
- [x] CORS enabled
- [x] JSON body parsing
- [x] Health check endpoint
- [x] Error handling middleware
- [x] 404 handler

**File:** `src/index.js`

### 4.2 Firebase Integration ✅ COMPLETED
- [x] Firebase Admin SDK initialization
- [x] Service account from Base64 env var
- [x] Firestore database access
- [x] FCM messaging

**File:** `src/firebaseAdmin.js`

### 4.3 Scheduled Jobs ✅ COMPLETED
- [x] External cron endpoint (`GET /api/notifications/cron`)
- [x] checkOverdueUsers function
- [x] processEscalations function
- [x] Internal node-cron (backup)

**Files:**
- `src/routes/notification.routes.js` (cron endpoint)
- `src/jobs/scheduler.js` (internal cron)

### 4.4 Notification Service ✅ COMPLETED
- [x] Send single FCM notification
- [x] Send to all linked contacts
- [x] Send reminder to user
- [x] Invalid token cleanup
- [x] Android high priority
- [x] iOS sound/badge

**File:** `src/services/notificationService.js`

### 4.5 Alert Service ✅ COMPLETED
- [x] Create alert with escalation steps
- [x] Process escalation steps
- [x] Execute push step
- [x] Cancel pending alerts
- [x] Step result tracking
- [ ] Execute email step (SendGrid) - TODO
- [ ] Execute SMS step (Twilio) - TODO

**File:** `src/services/alertService.js`

### 4.6 User Service ✅ COMPLETED
- [x] Check overdue users
- [x] Update user status
- [x] Initialize user defaults
- [x] Handle check-in

**File:** `src/services/userService.js`

### 4.7 API Routes ✅ COMPLETED
- [x] Notification routes (including cron endpoint)
- [x] Webhook routes
- [x] User routes (demo)

**Files:** `src/routes/*.js`

---

## 5. API SPECIFICATION

### 5.1 Health & Status

```
GET /
Response: { message: "Welcome to im_ok_be API" }

GET /health
Response: { ok: true, timestamp: "2026-01-16T..." }
```

### 5.2 Cron Endpoint (External Cron Service)

```
GET /api/notifications/cron
Response: {
  ok: true,
  message: "Cron job completed",
  overdueCount: number,
  alertsCreated: number,
  durationMs: number,
  timestamp: "2026-01-16T..."
}
```

### 5.3 Notification Endpoints

```
POST /api/notifications/test
Body: { fromUserId: string }
Response: {
  ok: true,
  message: "Test notifications sent",
  results: [{ contactId, linkedUid, status, messageId?, error? }]
}

POST /api/notifications/send
Body: { fcmToken: string, title: string, body: string, data?: object }
Response: { ok: true, messageId: string }

POST /api/notifications/trigger-overdue-check
Response: { ok: true, overdueCount: number, alertsCreated: number }

POST /api/notifications/trigger-escalations
Response: { ok: true, message: "Escalation processing completed" }
```

### 5.4 Webhook Endpoints

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

## 6. ESCALATION CONFIGURATION

### Default Escalation Steps
```javascript
escalation: {
  steps: [
    { type: "push", delayMinutes: 0 },    // Immediate
    { type: "email", delayMinutes: 30 },  // After 30 min (TODO)
    { type: "sms", delayMinutes: 60 }     // After 1 hour (TODO)
  ]
}
```

### Step Execution Flow
1. **Alert Created** → currentStepIndex: 0
2. **Cron triggers /api/notifications/cron**
3. **processEscalations runs**
4. **Check delay time** → Is `now >= alertCreatedAt + delayMinutes`?
5. **Execute step** → Send notification based on type
6. **Update stepResults** → Record status, sentAt, error
7. **Increment currentStepIndex**
8. **Repeat until all steps done**

### Step Status Values
- `pending` - Not yet executed
- `sent` - Successfully sent
- `failed` - Failed to send (with error message)

---

## 7. MOBILE APP INTEGRATION

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
   // OR write directly to Firestore and let backend detect via cron
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

1. **Automatic overdue detection** (via external cron every 5 min)
2. **Alert creation** with escalation steps
3. **Push notifications** to linked contacts
4. **Token cleanup** for invalid FCM tokens

---

## 8. ENVIRONMENT VARIABLES

### Required
```bash
# Railway will auto-assign
PORT=3000

# Must be set manually in Railway
FIREBASE_SERVICE_ACCOUNT_B64=<base64-encoded-json>
```

### Email (Nodemailer + Gmail SMTP)
```bash
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### Optional (for future features)
```bash
NODE_ENV=production

# Twilio (SMS)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
```

---

## 8.1 FIRESTORE OPTIMIZATION

### Problem
Firestore Spark plan: **50K reads/day, 20K writes/day**
- Original code: Full user scan every cron → quota exhausted

### Solutions Implemented

| Optimization | Before | After | Reduction |
|--------------|--------|-------|-----------|
| Overdue query | `db.collection('users').get()` | `where('isPaused').where('overdueCutoff')` | ~90% |
| Linked users | N queries in loop | `db.getAll(...refs)` batch | ~95% |
| Alert queries | Query per user | `collectionGroup('alerts')` | ~90% |
| Reminder check | Query alerts subcollection | `lastAlertAt` field | 100% |

### Root-level Fields (Required)
```javascript
// Added to user document:
{
  isPaused: boolean,        // Duplicate of checkinPolicy.isPaused
  overdueCutoff: Timestamp  // nextDueAt + graceMinutes
}
```

### Composite Index (firestore.indexes.json)
```json
{
  "indexes": [
    {
      "collectionGroup": "users",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "isPaused", "order": "ASCENDING" },
        { "fieldPath": "overdueCutoff", "order": "ASCENDING" }
      ]
    }
  ]
}
```

### Migration Steps (One-time)
```bash
# 1. Deploy indexes
firebase deploy --only firestore:indexes

# 2. Run migration
curl -X POST https://your-url/api/notifications/migrate-users

# 3. Verify (queryMode should be "optimized")
curl https://your-url/api/notifications/cron
```

### Estimated Reads per Cron

| Users | Fallback | Optimized |
|-------|----------|-----------|
| 10 | 10 reads | 2 reads |
| 100 | 100 reads | 5 reads |
| 1000 | 1000 reads | 10 reads |

---

## 8.2 MULTI-LANGUAGE NOTIFICATIONS

### Supported: `en` (English), `vi` (Vietnamese)

```javascript
const NOTIFICATION_MESSAGES = {
  en: {
    alertTitle: 'Emergency Alert',
    alertBody: (name) => `${name} has not checked in and may need help!`,
  },
  vi: {
    alertTitle: 'Cảnh báo khẩn cấp',
    alertBody: (name) => `${name} chưa check-in và có thể cần trợ giúp!`,
  },
};
```

Language is determined by: `user.language` → `user.settings.language` → `"en"`

---

## 9. DEPLOYMENT (Railway)

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

5. **Setup External Cron** (QUAN TRỌNG!)
   - Go to https://cron-job.org
   - Create cron job calling `GET /api/notifications/cron`
   - Set interval: every 5 minutes

### Health Check
```bash
curl https://imokhisoeco-production.up.railway.app/health
# Expected: { "ok": true, "timestamp": "..." }
```

### Test Cron Manually
```bash
curl https://imokhisoeco-production.up.railway.app/api/notifications/cron
# Expected: { "ok": true, "message": "Cron job completed", ... }
```

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
[CRON]        - External cron job events
[Scheduler]   - Internal scheduled job events
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
[CRON] External cron triggered at 2026-01-16T10:00:00.000Z
[OverdueCheck] Starting check at 2026-01-16T10:00:00.000Z
[OverdueCheck] User abc123 is now overdue
[Alert] Created alert xyz789 for user abc123
[OverdueCheck] Completed. Found 1 overdue users, created 1 alerts
[Escalation] Processing step 0 (push) for alert xyz789
[FCM] Successfully sent message: projects/im-ok-4b2d2/messages/123
[Escalation] Step 0 completed with status: sent
```

---

## 12. TESTING CHECKLIST

### Before Going Live:
- [x] Health check returns OK
- [x] Can read/write to Firestore
- [x] FCM token is valid
- [x] Push notification received on device
- [ ] External cron setup on cron-job.org
- [ ] Overdue detection works (via cron)
- [ ] Alert is created
- [ ] Escalation steps execute
- [ ] Check-in cancels alerts

### Manual Test Flow:
1. Setup external cron on cron-job.org
2. Create test user in Firestore
3. Set `nextDueAt` to past time
4. Wait for cron OR call `GET /api/notifications/cron`
5. Check alert created in `users/{uid}/alerts`
6. Verify push received on linked contact's device
7. Call `POST /api/webhooks/checkin`
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
- Single instance on Railway (free tier)
- External cron service for scheduling
- Firestore handles data scaling

### For 10,000+ Users:
- Consider **Redis** for job queue
- Use **Cloud Tasks** for delayed jobs
- Implement **batch processing** for notifications
- Add **caching** for frequently accessed data
- Upgrade Railway plan for always-on instance

---

## 15. NEXT STEPS

### Phase 1: Core ✅ COMPLETED
- [x] Express server
- [x] Firebase integration
- [x] Push notifications
- [x] External cron endpoint

### Phase 2: Communication ✅ COMPLETED
- [x] Email integration (Nodemailer + Gmail)
- [x] Multi-language (VI/EN)
- [x] 30-minute reminder interval
- [ ] Twilio SMS (TODO)

### Phase 3: Optimization ✅ COMPLETED
- [x] Firestore query optimization
- [x] Batch fetch linked users
- [x] CollectionGroup for alerts
- [x] Root-level fields
- [x] Migration endpoint

### Phase 4: Security
- [ ] JWT authentication
- [ ] Rate limiting
- [ ] Request logging

### Phase 5: Monitoring
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

### 2026-01-17 (v2.0 - Major Optimization)
- **Firestore Optimization**:
  - Query only overdue users (not full scan)
  - Batch fetch with `db.getAll()`
  - CollectionGroup query for alerts
  - Fallback mode when index not ready
- **Root-level Fields**: `isPaused`, `overdueCutoff`
- **Migration Endpoint**: `POST /api/notifications/migrate-users`
- **Composite Indexes**: `firestore.indexes.json`
- **Multi-language**: VI/EN notifications
- **30-minute Reminder**: Repeated alerts if still overdue
- **Email Service**: Nodemailer + Gmail SMTP
- **Query Mode Tracking**: `queryMode: "optimized"` or `"fallback"`

### 2026-01-16 (v1.1)
- Added external cron endpoint `GET /api/notifications/cron`
- Updated architecture to use external cron service (cron-job.org)
- Works around Railway free tier cron limitations
- Updated documentation

### 2026-01-16 (v1.0 - Initial Release)
- Project setup with Express.js 5.x
- Firebase Admin SDK integration
- Internal scheduled jobs with node-cron
- Push notification service
- Alert and escalation system
- Webhook endpoints for mobile integration
- Documentation (DEBUG.md, PROJECT_PLAN.md)

---

## 18. QUICK COMMANDS

```bash
# Health check
curl https://imokhisoeco-production.up.railway.app/health

# Trigger cron
curl https://imokhisoeco-production.up.railway.app/api/notifications/cron

# Run migration (one-time)
curl -X POST https://imokhisoeco-production.up.railway.app/api/notifications/migrate-users

# Deploy Firestore indexes
firebase deploy --only firestore:indexes
```

### Common Issues

| Issue | Solution |
|-------|----------|
| `RESOURCE_EXHAUSTED` | Run migration + deploy indexes |
| `queryMode: fallback` | Deploy indexes, run migration |
| No notifications | Check fcmToken field |
| Wrong language | Set user.language to "vi" or "en" |

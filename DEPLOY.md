# IMOK Backend - Deploy Guide

> **Last Updated**: 2026-01-19
> **Version**: 2.0.2
> **Database**: Firestore only (no MySQL)
> **Last Audit**: 2026-01-19

---

## Quick Status

| Component | Status | Notes |
|-----------|--------|-------|
| Firebase Connection | ✅ OK | Project: `im-ok-4b2d2` |
| POST /api/device/upsert | ✅ OK | Tested 2026-01-18 |
| POST /api/device/checkin | ✅ OK | Tested 2026-01-18 |
| GET /api/device/:id/status | ✅ OK | Tested 2026-01-18 |
| GET /internal/cron/scan-overdue | ✅ OK | Tested 2026-01-19 |
| Email Notification | ✅ OK | Gmail SMTP tested 2026-01-19 |
| Idempotency | ✅ OK | No duplicate emails |
| Railway Deploy | ⏳ Pending | Code ready, need push |

---

## Audit Log

### 2026-01-18 - Security & Performance Audit

**Cron Query Analysis:**
```javascript
// SAFE - Uses composite index, not full collection scan
db.collection('devices')
  .where('overdueNotifiedAt', '==', null)
  .where('nextDueAt', '<', cutoff)
  .orderBy('nextDueAt')
  .limit(BATCH_LIMIT);  // Default 100
```

**Fixes Applied:**
| Issue | Severity | Fix |
|-------|----------|-----|
| Email inside transaction | HIGH | Moved email OUTSIDE transaction |
| No email validation | MEDIUM | Added `isValidEmail()` check |
| No runId in logs | LOW | Added unique runId per cron run |
| No warning threshold | LOW | Added WARN_THRESHOLD (default 500) |
| Lock timeout too long | LOW | Reduced to 2 minutes |

**Security Checklist:**
- [x] Kill-switch: `CRON_ENABLED=false` stops all Firestore reads
- [x] Auth: `x-cron-secret` header required
- [x] Lock: Prevents overlapping cron runs
- [x] Idempotency: Transaction checks `overdueNotifiedAt` before marking
- [x] Pagination: `BATCH_LIMIT` + `MAX_PER_RUN` caps
- [x] No full scan: Uses indexed query only

---

## Test Log

### 2026-01-19 - Full System Test

```
[17:18] Firebase connection: OK
[17:18] POST /api/device/upsert: OK - Device created
[17:19] POST /api/device/checkin: OK - nextDueAt updated
[17:19] GET /api/device/test-email-001/status: OK
[17:24] GET /internal/cron/scan-overdue: OK - emailsSent: 1
[17:24] GET /internal/cron/scan-overdue (2nd call): OK - queriedCount: 0 (idempotency works)
```

**All Tests Passed!**

### 2026-01-18 - Local Testing

```
[16:34] Firebase connection: OK
[16:34] POST /api/device/upsert: OK - Device created
[16:34] POST /api/device/checkin: OK - nextDueAt updated
[16:34] GET /api/device/test-uuid-001/status: OK
[16:34] GET /internal/cron/scan-overdue: FAILED - Need Firestore index
```

**Action Required:**
1. ~~Create Firestore composite index~~ ✅ Done
2. ~~Configure email provider~~ ✅ Done (Gmail SMTP)
3. Deploy to Railway

---

## Overview

Backend cho app IMOK - check-in an toàn **không cần đăng nhập**.
- Database: **Firestore only** (không MySQL)
- Identifier: `installId` (UUID từ client)
- Cron: Railway Cron Job gọi `/internal/cron/scan-overdue`

---

## 1. Firestore Index (REQUIRED)

**Click link này để tạo index:**
https://console.firebase.google.com/v1/r/project/im-ok-4b2d2/firestore/indexes?create_composite=Cktwcm9qZWN0cy9pbS1vay00YjJkMi9kYXRhYmFzZXMvKGRlZmF1bHQpL2NvbGxlY3Rpb25Hcm91cHMvZGV2aWNlcy9pbmRleGVzL18QARoVChFvdmVyZHVlTm90aWZpZWRBdBABGg0KCW5leHREdWVBdBABGgwKCF9fbmFtZV9fEAE

Hoặc tạo thủ công:
- Collection: `devices`
- Fields:
  - `overdueNotifiedAt` (Ascending)
  - `nextDueAt` (Ascending)

---

## 2. Railway Setup

### Environment Variables (REQUIRED)

```bash
# Firebase (REQUIRED)
FIREBASE_SERVICE_ACCOUNT_B64=<base64 encoded JSON>

# Cron (REQUIRED)
CRON_ENABLED=true
CRON_SECRET=<random-string-32-chars>

# Email Provider (REQUIRED) - chọn 1:
EMAIL_PROVIDER=resend
EMAIL_API_KEY=<api key>
FROM_EMAIL=noreply@yourdomain.com

# Hoặc Gmail SMTP:
EMAIL_PROVIDER=nodemailer
GMAIL_USER=your@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

# Cron Limits (optional - có defaults)
BATCH_LIMIT=100          # Max docs per query
MAX_PER_RUN=200          # Max total docs per cron run
LOCK_TIMEOUT_MS=120000   # Lock timeout 2 minutes
WARN_THRESHOLD=500       # Log warning if exceeds
```

### Railway Cron Job

1. Tạo Cron Job mới trong Railway project
2. Configure:
   - **Schedule**: `* * * * *` (mỗi phút)
   - **URL**: `https://<your-domain>/internal/cron/scan-overdue`
   - **Headers**: `x-cron-secret: <CRON_SECRET value>`

### Emergency Kill-Switch

Để tắt cron khẩn cấp:
1. Set `CRON_ENABLED=false` trong Railway Variables
2. Hoặc xóa/disable Cron Job trong Railway

---

## 3. API Endpoints

### Base URL
```
Production: https://imokhisoeco-production.up.railway.app
Local: http://localhost:3000
```

### Health Check
```
GET /health
Response: { "ok": true, "timestamp": "..." }
```

### POST /api/device/upsert
Đăng ký hoặc cập nhật device.

```bash
curl -X POST http://localhost:3000/api/device/upsert \
  -H "Content-Type: application/json" \
  -d '{"installId":"uuid","displayName":"A","emergencyEmail":"b@example.com","intervalSeconds":86400}'
```

Response: `{ "ok": true }`

### POST /api/device/checkin
Check-in (reset timer).

```bash
curl -X POST http://localhost:3000/api/device/checkin \
  -H "Content-Type: application/json" \
  -d '{"installId":"uuid"}'
```

Response:
```json
{
  "ok": true,
  "nextDueAt": "2026-01-18T16:39:35.220Z"
}
```

### GET /api/device/:installId/status
Lấy trạng thái device.

```bash
curl http://localhost:3000/api/device/test-uuid-001/status
```

Response:
```json
{
  "ok": true,
  "data": {
    "installId": "test-uuid-001",
    "displayName": "Nguyen Van A",
    "status": "OK",
    "lastCheckinAt": "2026-01-18T16:34:35.220Z",
    "nextDueAt": "2026-01-18T16:39:35.220Z",
    "intervalSeconds": 300,
    "graceSeconds": 300
  }
}
```

### GET /internal/cron/scan-overdue
Cron endpoint - quét và gửi email cho devices quá hạn.

```bash
curl http://localhost:3000/internal/cron/scan-overdue \
  -H "x-cron-secret: test-secret-local"
```

Response:
```json
{
  "ok": true,
  "stats": {
    "runId": "run_1705595123456_abc123",
    "cutoff": "2026-01-18T16:30:00.000Z",
    "queriedCount": 5,
    "matchedCount": 5,
    "emailsAttempted": 2,
    "emailsSent": 2,
    "emailsFailed": 0,
    "skippedAlreadyNotified": 3,
    "skippedInvalidEmail": 0,
    "errors": [],
    "durationMs": 1234
  }
}
```

### GET /internal/cron/status
Kiểm tra trạng thái lock.

```bash
curl http://localhost:3000/internal/cron/status \
  -H "x-cron-secret: test-secret-local"
```

### POST /internal/cron/force-release
Force release lock (emergency).

```bash
curl -X POST http://localhost:3000/internal/cron/force-release \
  -H "x-cron-secret: test-secret-local"
```

---

## 4. Firestore Schema

### Collection: `devices`
```javascript
{
  installId: string,           // UUID từ client (doc ID)
  displayName: string,         // Tên người dùng A
  emergencyEmail: string,      // Email người liên hệ B
  intervalSeconds: number,     // Chu kỳ check-in (default 86400 = 24h)
  graceSeconds: number,        // Grace period (default 300 = 5 phút)
  lastCheckinAt: timestamp,    // Lần check-in cuối
  nextDueAt: timestamp,        // Deadline check-in tiếp theo
  status: "OK" | "OVERDUE",
  overdueNotifiedAt: timestamp | null,  // Idempotency flag
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### Collection: `alerts` (logs)
```javascript
{
  installId: string,
  toEmail: string,
  type: "OVERDUE_EMAIL",
  status: "SUCCESS" | "FAIL",
  providerId: string | null,
  error: string | null,
  triggeredAt: timestamp
}
```

### Collection: `locks` (cron lock)
```javascript
{
  running: boolean,
  runId: string,
  startedAt: timestamp,
  finishedAt: timestamp,
  lastResult: object
}
```

---

## 5. Test Checklist

### Basic Tests
- [x] Upsert device - `POST /api/device/upsert`
- [x] Check-in - `POST /api/device/checkin`
- [x] Get status - `GET /api/device/:id/status`
- [x] Cron scan-overdue - Tested 2026-01-19
- [x] Email notification - Gmail SMTP working
- [x] Idempotency - No duplicate emails
- [ ] Deploy to Railway

### Full Flow Test

```bash
# 1. Upsert device
curl -X POST http://localhost:3000/api/device/upsert \
  -H "Content-Type: application/json" \
  -d '{"installId":"test-001","displayName":"Test A","emergencyEmail":"your-email@example.com","intervalSeconds":300}'

# 2. Check-in
curl -X POST http://localhost:3000/api/device/checkin \
  -H "Content-Type: application/json" \
  -d '{"installId":"test-001"}'

# 3. Trong Firebase Console: sửa nextDueAt về quá khứ > 5 phút

# 4. Gọi cron (should send 1 email)
curl http://localhost:3000/internal/cron/scan-overdue \
  -H "x-cron-secret: test-secret-local"

# 5. Gọi cron lần 2 (should NOT send - already notified)
curl http://localhost:3000/internal/cron/scan-overdue \
  -H "x-cron-secret: test-secret-local"

# 6. Check-in lại (reset overdueNotifiedAt)
curl -X POST http://localhost:3000/api/device/checkin \
  -H "Content-Type: application/json" \
  -d '{"installId":"test-001"}'

# 7. Sửa nextDueAt về quá khứ lần nữa, gọi cron (should send again)
```

---

## 6. Cron Safety Mechanisms

### 1. Kill-Switch
```javascript
if (CRON_ENABLED !== 'true') {
  return { ok: true, disabled: true }; // No Firestore reads
}
```

### 2. Indexed Query (No Full Scan)
```javascript
db.collection('devices')
  .where('overdueNotifiedAt', '==', null)  // Index field 1
  .where('nextDueAt', '<', cutoff)          // Index field 2
  .orderBy('nextDueAt')
  .limit(BATCH_LIMIT);                      // Cap per batch
```

### 3. Lock Mechanism
```javascript
// Acquire lock with transaction
if (lock.running && !expired) {
  return { skipped: true, reason: 'lock_held' };
}
// Auto-release after LOCK_TIMEOUT_MS (2 minutes)
```

### 4. Idempotency
```javascript
// Transaction: check + mark atomically
if (data.overdueNotifiedAt !== null) {
  return { skipped: true, reason: 'already_notified' };
}
transaction.update(deviceRef, { overdueNotifiedAt: now });
// Then send email (outside transaction)
```

### 5. Rate Limits
- `BATCH_LIMIT=100` - Max docs per query
- `MAX_PER_RUN=200` - Max total per cron run
- `WARN_THRESHOLD=500` - Log warning if exceeds

---

## 7. Email Providers

### Resend (khuyến nghị)
```
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_xxx
FROM_EMAIL=noreply@yourdomain.com
```

### SendGrid
```
EMAIL_PROVIDER=sendgrid
EMAIL_API_KEY=SG.xxx
FROM_EMAIL=noreply@yourdomain.com
```
(Cần `npm install @sendgrid/mail`)

### Gmail SMTP
```
EMAIL_PROVIDER=nodemailer
GMAIL_USER=your@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

---

## 8. Project Structure

```
src/
├── index.js              # Express server entry
├── firebaseAdmin.js      # Firebase init
├── routes/
│   ├── device.routes.js  # /api/device/* endpoints
│   └── internal.routes.js # /internal/cron/* (audited 2026-01-18)
└── services/
    └── emailSender.js    # Email provider module
```

---

## 9. Monitoring & Alerts

### Log Format (JSON)
Mỗi cron run log:
```json
{
  "runId": "run_1705595123456_abc123",
  "cutoff": "2026-01-18T16:30:00.000Z",
  "queriedCount": 5,
  "matchedCount": 5,
  "emailsAttempted": 2,
  "emailsSent": 2,
  "emailsFailed": 0,
  "skippedAlreadyNotified": 3,
  "skippedInvalidEmail": 0,
  "errors": [],
  "durationMs": 1234
}
```

### Warning Signs
- `queriedCount > 500` - Có thể có issue
- `emailsFailed > 0` - Email provider issue
- `durationMs > 30000` - Query chậm
- `lock_held` frequently - Cron chạy quá lâu

---

## Done!

Sau khi deploy và test xong, app sẵn sàng:
1. Client tạo UUID → gọi `/api/device/upsert`
2. Client check-in định kỳ → gọi `/api/device/checkin`
3. Railway Cron mỗi phút → gọi `/internal/cron/scan-overdue`
4. Nếu A không check-in quá 5 phút → B nhận email cảnh báo

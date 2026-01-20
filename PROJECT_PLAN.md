# IMOK Backend - Project Plan & Documentation

> **Last Updated**: 2026-01-20
> **Version**: 2.0.5
> **Author**: IMOK Team
> **Status**: Production Ready

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Database Schema](#4-database-schema)
5. [API Reference](#5-api-reference)
6. [Cron Job & Safety Mechanisms](#6-cron-job--safety-mechanisms)
7. [Email System](#7-email-system)
8. [SMS System](#8-sms-system)
9. [Environment Variables](#9-environment-variables)
10. [Deployment Guide](#10-deployment-guide)
11. [Testing](#11-testing)
12. [Troubleshooting](#12-troubleshooting)
13. [Changelog](#13-changelog)

---

## 1. Project Overview

### What is IMOK?

**IMOK** (I'm OK) is a safety check-in application that helps users stay connected with their emergency contacts. If a user fails to check-in within a specified time period, the system automatically sends an alert email to their designated emergency contact.

### Key Features

| Feature | Description |
|---------|-------------|
| No Login Required | Uses device `installId` (UUID) as identifier |
| Automatic Email Alerts | Sends email when user misses check-in deadline |
| Automatic SMS Alerts | Sends SMS to emergency phones (optional, via SMS Gateway) |
| Customizable Intervals | Each user can set their own check-in frequency |
| Idempotent | No duplicate emails/SMS sent for the same overdue event |
| Cost-Safe | Uses indexed queries with pagination, no full collection scans |

### Use Case Example

```
1. Person A installs IMOK app on their phone
2. A registers with B's email as emergency contact
3. A sets check-in interval to 24 hours
4. Every day, A opens app and taps "I'm OK"
5. If A doesn't check-in for 24h + 5min grace → B receives email alert
6. B can then call/visit A to make sure they're safe
```

### Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Firebase Connection | ✅ OK | Project: `im-ok-4b2d2` |
| POST /api/device/upsert | ✅ OK | Tested 2026-01-18 |
| POST /api/device/checkin | ✅ OK | Tested 2026-01-18 |
| GET /api/device/:id/status | ✅ OK | Tested 2026-01-18 |
| GET /internal/cron/scan-overdue | ✅ OK | Tested 2026-01-19 |
| POST /internal/test-email | ✅ OK | Tested 2026-01-19 |
| POST /internal/test-overdue | ✅ OK | Tested 2026-01-19 |
| POST /internal/test-sms | ✅ OK | SMS Gateway testing |
| GET /internal/sms/status | ✅ OK | SMS provider status |
| Email Notification | ✅ OK | Resend API (production) |
| SMS Notification | ✅ OK | Twilio/Vonage/VN Provider |
| Idempotency | ✅ OK | No duplicate emails/SMS |

---

## 2. Architecture

### System Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Mobile App    │────▶│  Express Server  │────▶│    Firestore    │
│  (Flutter/RN)   │     │   (Railway)      │     │   (Firebase)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               │ Cron (every minute)
                               ▼
                        ┌──────────────────┐
                        │   Resend API     │
                        │   (Email)        │
                        └──────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │   SMS Gateway    │
                        │ (Twilio/Vonage)  │
                        └──────────────────┘
```

### Request Flow

```
[Client App]
     │
     ├── POST /api/device/upsert     → Register/update device
     ├── POST /api/device/checkin    → Record check-in
     └── GET  /api/device/:id/status → Get device status

[Railway Cron Job - Every 1 minute]
     │
     └── GET /internal/cron/scan-overdue
              │
              ├── Query: devices where overdueNotifiedAt == null AND nextDueAt < cutoff
              ├── For each overdue device:
              │     ├── Transaction: mark as notified
              │     └── Send email to emergencyEmail
              └── Return stats
```

### File Structure

```
im_ok_be/
├── src/
│   ├── index.js                 # Express server entry point
│   ├── firebaseAdmin.js         # Firebase Admin SDK initialization
│   ├── routes/
│   │   ├── device.routes.js     # /api/device/* endpoints
│   │   └── internal.routes.js   # /internal/* endpoints (cron, test)
│   └── services/
│       └── emailSender.js       # Email provider module (Resend/SendGrid/Gmail)
├── scripts/
│   └── test-email-cron.js       # Test script for cron
├── .env                         # Environment variables (local only, not in git)
├── .env.example                 # Environment template
├── package.json                 # Dependencies
├── firestore.indexes.json       # Firestore composite indexes
└── PROJECT_PLAN.md              # This file
```

---

## 3. Tech Stack

| Component | Technology | Version | Notes |
|-----------|------------|---------|-------|
| Runtime | Node.js | 18+ | LTS recommended |
| Framework | Express | 5.x | REST API |
| Database | Firestore | - | NoSQL, Firebase |
| Email | Resend | 6.x | API-based (recommended for cloud) |
| Email (alt) | SendGrid | - | API-based alternative |
| Email (local) | Nodemailer | 7.x | Gmail SMTP (local testing only) |
| Hosting | Railway | - | Auto-deploy from Git |
| Cron | Railway Cron | - | External HTTP trigger |

### Dependencies (package.json)

```json
{
  "name": "imok-backend",
  "version": "2.0.0",
  "description": "IMOK Safety Check Backend - Firestore Only",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^17.2.3",
    "express": "^5.2.1",
    "firebase-admin": "^13.6.0",
    "nodemailer": "^7.0.12",
    "resend": "^6.7.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.11"
  }
}
```

---

## 4. Database Schema

### Collection: `devices`

Main collection storing all registered devices/users.

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| installId | string | UUID from client (Document ID) | `"550e8400-e29b-41d4-a716-446655440000"` |
| displayName | string | User's name (Person A) | `"Nguyen Van A"` |
| emergencyEmail | string | Contact B's email | `"contact@example.com"` |
| emergencyPhones | string[] | Emergency phone numbers (for SMS) | `["0399123456", "0912345678"]` |
| smsEnabled | boolean | Enable SMS alerts | `true` or `false` |
| intervalSeconds | number | Check-in interval (default: 86400 = 24h) | `86400` |
| graceSeconds | number | Grace period (default: 300 = 5 min) | `300` |
| lastCheckinAt | Timestamp | Last successful check-in time | `2026-01-19T10:00:00Z` |
| nextDueAt | Timestamp | Deadline for next check-in | `2026-01-20T10:00:00Z` |
| status | string | Current status | `"OK"` or `"OVERDUE"` |
| overdueNotifiedAt | Timestamp/null | Email idempotency flag | `null` or `2026-01-20T10:05:00Z` |
| overdueSmsNotifiedAt | Timestamp/null | SMS idempotency flag | `null` or `2026-01-20T10:05:00Z` |
| createdAt | Timestamp | Creation time | `2026-01-19T10:00:00Z` |
| updatedAt | Timestamp | Last update time | `2026-01-19T10:00:00Z` |

**Firestore Index Required:**
```
Collection: devices
Fields:
  - overdueNotifiedAt (Ascending)
  - nextDueAt (Ascending)
```

### Collection: `alerts`

Log of all sent alerts for audit/debugging.

| Field | Type | Description |
|-------|------|-------------|
| installId | string | Reference to device |
| toEmail | string | Recipient email (for email alerts) |
| toPhone | string | Recipient phone (for SMS alerts) |
| type | string | Alert type: `"OVERDUE_EMAIL"` or `"OVERDUE_SMS"` |
| status | string | `"SUCCESS"` or `"FAIL"` |
| provider | string | Provider name (resend, twilio, vonage, vn) |
| providerId | string/null | Provider message ID |
| error | string/null | Error message if failed |
| triggeredAt | Timestamp | When alert was triggered |

### Collection: `locks`

Cron job lock to prevent overlapping runs.

| Field | Type | Description |
|-------|------|-------------|
| running | boolean | Is cron currently running? |
| runId | string | Unique run identifier |
| startedAt | Timestamp | When run started |
| finishedAt | Timestamp | When run finished |
| lastResult | object | Stats from last run |

---

## 5. API Reference

### Base URLs

| Environment | URL |
|-------------|-----|
| Production | `https://imokbehisoeco-production.up.railway.app` |
| Local | `http://localhost:3000` |

### Public Endpoints

#### `GET /` - Root Info
```json
{
  "name": "IMOK Backend",
  "version": "2.0",
  "database": "Firestore",
  "mode": "installId (no login)"
}
```

#### `GET /health` - Health Check
```json
{
  "ok": true,
  "timestamp": "2026-01-19T10:00:00.000Z"
}
```

#### `POST /api/device/upsert` - Register/Update Device

Register a new device or update existing one.

**Request Body:**
```json
{
  "installId": "550e8400-e29b-41d4-a716-446655440000",
  "displayName": "Nguyen Van A",
  "emergencyEmail": "contact@example.com",
  "intervalSeconds": 86400
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| installId | Yes | - | UUID from client |
| displayName | No | `""` | User's name |
| emergencyEmail | Yes | - | Emergency contact email |
| intervalSeconds | No | `86400` | Check-in interval in seconds |

**Response:**
```json
{ "ok": true }
```

**Errors:**
- `400`: Missing installId or invalid emergencyEmail

#### `POST /api/device/checkin` - Record Check-in

**Request Body:**
```json
{
  "installId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "ok": true,
  "nextDueAt": "2026-01-20T10:00:00.000Z"
}
```

**Side Effects:**
- Updates `lastCheckinAt` to now
- Calculates new `nextDueAt` based on `intervalSeconds`
- Resets `overdueNotifiedAt` to `null` (allows future notifications)
- Sets `status` to `"OK"`

#### `GET /api/device/:installId/status` - Get Status

**Response:**
```json
{
  "ok": true,
  "data": {
    "installId": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "Nguyen Van A",
    "status": "OK",
    "lastCheckinAt": "2026-01-19T10:00:00.000Z",
    "nextDueAt": "2026-01-20T10:00:00.000Z",
    "intervalSeconds": 86400,
    "graceSeconds": 300
  }
}
```

### Internal Endpoints (Protected)

All internal endpoints require `x-cron-secret` header.

#### `GET /internal/cron/scan-overdue` - Scan Overdue Devices

**Headers:**
```
x-cron-secret: your-secret-here
```

**Response:**
```json
{
  "ok": true,
  "stats": {
    "runId": "run_1705595123456_abc123",
    "cutoff": "2026-01-19T09:55:00.000Z",
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

| Stat | Description |
|------|-------------|
| runId | Unique identifier for this run |
| cutoff | Timestamp used as overdue threshold |
| queriedCount | Total devices returned by query |
| matchedCount | Devices processed |
| emailsAttempted | Emails attempted to send |
| emailsSent | Emails successfully sent |
| emailsFailed | Emails that failed |
| skippedAlreadyNotified | Skipped because already notified |
| skippedInvalidEmail | Skipped due to invalid email |
| errors | Array of error details |
| durationMs | Total processing time |

#### `GET /internal/cron/status` - Lock Status

```json
{
  "ok": true,
  "data": {
    "running": false,
    "runId": "run_1705595123456_abc123",
    "startedAt": "2026-01-19T10:00:00.000Z",
    "finishedAt": "2026-01-19T10:00:05.000Z",
    "lastResult": { ... }
  }
}
```

#### `POST /internal/test-email` - Test Email Sending

Direct email test without device lookup.

**Headers:**
```
x-cron-secret: your-secret-here
Content-Type: application/json
```

**Request Body:**
```json
{
  "to": "recipient@example.com"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Test email sent successfully",
  "to": "recipient@example.com",
  "providerId": "<message-id>"
}
```

#### `POST /internal/test-overdue` - E2E Test

Set a device to overdue state and trigger scan immediately. Used for end-to-end testing.

**Headers:**
```
x-cron-secret: your-secret-here
Content-Type: application/json
```

**Request Body:**
```json
{
  "installId": "device-uuid-here",
  "minutesOverdue": 6
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| installId | Yes | - | Device to test |
| minutesOverdue | No | `6` | How many minutes to set as overdue |

**Response:**
```json
{
  "ok": true,
  "setup": {
    "installId": "device-uuid-here",
    "minutesOverdue": 6,
    "nextDueAt": "2026-01-19T09:54:00.000Z"
  },
  "scan": {
    "runId": "run_1705595123456_abc123",
    "queriedCount": 1,
    "emailsSent": 1,
    "emailsFailed": 0,
    "skippedAlreadyNotified": 0,
    "durationMs": 2345
  }
}
```

**Acceptance Criteria:**
- First call: `emailsSent: 1` (email sent)
- Second call immediately after: `emailsSent: 0, queriedCount: 0` (idempotency works)

#### `POST /internal/cron/force-release` - Force Release Lock

Emergency endpoint to release stuck lock.

```json
{
  "ok": true,
  "message": "Lock released",
  "runId": "run_1705595200000_xyz789"
}
```

---

## 6. Cron Job & Safety Mechanisms

### How Cron Works

```
1. Railway Cron → calls /internal/cron/scan-overdue every minute
2. Kill-Switch → if CRON_ENABLED != true, return immediately
3. Lock → prevent overlapping runs using Firestore transaction
4. Query → find devices: overdueNotifiedAt == null AND nextDueAt < cutoff
5. Process → for each device: transaction mark + send email
6. Release → always release lock, even on error
```

### Safety Mechanisms

| Mechanism | Purpose | How It Works |
|-----------|---------|--------------|
| **Kill-Switch** | Emergency stop | `CRON_ENABLED=false` → no Firestore reads at all |
| **Secret Auth** | Prevent unauthorized calls | `x-cron-secret` header required |
| **Lock** | Prevent overlapping runs | Firestore transaction with 2-min timeout |
| **Idempotency** | No duplicate emails | Transaction checks `overdueNotifiedAt` before marking |
| **Pagination** | Cost control | `BATCH_LIMIT=100` + `MAX_PER_RUN=200` |
| **Indexed Query** | No full scan | Composite index on `(overdueNotifiedAt, nextDueAt)` |
| **Email Outside TX** | Prevent timeout | Email sent after transaction commits |
| **Email Timeout** | Prevent hanging | 10-15 second timeouts for SMTP |

### Cron Query (Indexed)

```javascript
db.collection('devices')
  .where('overdueNotifiedAt', '==', null)    // Not yet notified
  .where('nextDueAt', '<', cutoff)           // Past deadline + grace
  .orderBy('nextDueAt')                      // Process oldest first
  .limit(BATCH_LIMIT);                       // Max 100 per batch
```

### Idempotency Flow

```
1. Transaction starts
2. Read device document (fresh)
3. Check: overdueNotifiedAt !== null? → Skip (already notified)
4. Check: isValidEmail(emergencyEmail)? → Skip if invalid
5. Update: set overdueNotifiedAt = now, status = "OVERDUE"
6. Transaction commits
7. Send email (outside transaction)
8. Log to alerts collection
```

---

## 7. Email System

### Supported Providers

| Provider | ENV Variables | Recommended For | Notes |
|----------|---------------|-----------------|-------|
| **Resend** | `EMAIL_API_KEY`, `FROM_EMAIL` | **Production (Railway)** | API-based, no SMTP blocking |
| SendGrid | `EMAIL_API_KEY`, `FROM_EMAIL` | Production alternative | 100 free emails/day |
| Nodemailer | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Local testing only | SMTP blocked on Railway |

### Why Resend/SendGrid for Production?

**Railway (and most cloud platforms) block outbound SMTP ports (587/465)** to prevent spam. Gmail SMTP will timeout on Railway.

**Solution:** Use API-based email providers like Resend or SendGrid.

### Resend Setup (Recommended)

1. Sign up at https://resend.com (free: 3000 emails/month)
2. Go to **API Keys** → **Create API Key**
3. Copy key starting with `re_...`
4. Set Railway variables:
   ```
   EMAIL_PROVIDER=resend
   EMAIL_API_KEY=re_xxxxxxxxxx
   FROM_EMAIL=onboarding@resend.dev
   ```

**Resend Free Tier Limitation:**
- Without verified domain: Can only send to the email you signed up with
- With verified domain: Can send to any email

### Verify Domain on Resend (For Production)

1. Go to https://resend.com/domains
2. Add your domain (e.g., `imok.app`)
3. Add DNS records (MX, TXT) as instructed
4. After verification, change `FROM_EMAIL` to `noreply@imok.app`

### SendGrid Setup (Alternative)

1. Sign up at https://sendgrid.com (free: 100 emails/day)
2. Create API Key
3. Set Railway variables:
   ```
   EMAIL_PROVIDER=sendgrid
   EMAIL_API_KEY=SG.xxxxxxxxxx
   FROM_EMAIL=your-email@gmail.com
   ```

**SendGrid advantage:** No domain verification required for small volume.

### Gmail SMTP (Local Testing Only)

```bash
# .env (local only - will NOT work on Railway)
EMAIL_PROVIDER=nodemailer
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

### Email Template

**Subject:** `[IMOK] {displayName} chưa check-in`

**HTML Content:**
```html
<div class="header" style="background: #e74c3c; color: white;">
  <h1>Cảnh báo IMOK</h1>
</div>
<div class="content">
  <p><strong>{displayName}</strong> đã không check-in trong ứng dụng IMOK.</p>
  <div class="info">
    <p><strong>Lần check-in cuối:</strong> {lastCheckinAt}</p>
    <p><strong>Đã quá hạn:</strong> {graceMinutes} phút</p>
  </div>
  <p>Vui lòng liên hệ để đảm bảo họ an toàn.</p>
</div>
```

---

## 8. SMS System

### Overview

SMS alerts are sent via **SMS Gateway API** (not from user's phone SIM). This works on all platforms and doesn't require SMS permissions on mobile.

### Supported Providers

| Provider | ENV Variables | Pricing | Notes |
|----------|---------------|---------|-------|
| **Twilio** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | ~$0.01/SMS | Most popular, global coverage |
| **Vonage** | `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_FROM` | ~$0.01/SMS | Good for international |
| **VN Provider** | `VN_SMS_API_URL`, `VN_SMS_API_KEY`, `VN_SMS_FROM` | Varies | Local VN providers (SpeedSMS, VNPT, etc.) |

### Phone Number Normalization

All phone numbers are normalized to **E.164 format** before sending:

```
0399123456   → +84399123456
84399123456  → +84399123456
+84399123456 → +84399123456
039 912 3456 → +84399123456 (spaces removed)
```

### Twilio Setup (Recommended)

1. Sign up at https://www.twilio.com
2. Get your **Account SID** and **Auth Token** from Dashboard
3. Buy a phone number (or use Trial number)
4. Set Railway variables:
   ```bash
   SMS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_FROM=+1234567890
   ```

### Vonage Setup

1. Sign up at https://www.vonage.com
2. Get **API Key** and **API Secret**
3. Set Railway variables:
   ```bash
   SMS_PROVIDER=vonage
   VONAGE_API_KEY=your_api_key
   VONAGE_API_SECRET=your_api_secret
   VONAGE_FROM=IMOK
   ```

### VN Provider Setup (SpeedSMS, VNPT, etc.)

For Vietnamese SMS providers:

```bash
SMS_PROVIDER=vn
VN_SMS_API_URL=https://api.speedsms.vn/index.php/sms/send
VN_SMS_API_KEY=your_api_key
VN_SMS_FROM=IMOK
```

> **Note:** VN provider implementation may need adjustment based on specific provider's API format.

### Idempotency for SMS

SMS has **separate idempotency** from email:

- `overdueNotifiedAt` - Tracks email notification
- `overdueSmsNotifiedAt` - Tracks SMS notification

This allows:
- Email and SMS to be sent independently
- SMS retry if previous attempt failed
- Check-in resets both flags

### SMS Message Template

```
[IMOK] Canh bao: {displayName} khong diem danh dung han ({nextDueAt}). Vui long lien he kiem tra.
```

### Test SMS Endpoint

```bash
curl -X POST https://your-domain/internal/test-sms \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: YOUR_CRON_SECRET" \
  -d '{
    "to": ["0399123456", "0912345678"],
    "message": "Test SMS from IMOK"
  }'
```

**Response:**
```json
{
  "ok": true,
  "message": "SMS sent to 2/2 numbers",
  "provider": { "provider": "twilio", "configured": true, "from": "+1234567890" },
  "results": [
    { "ok": true, "to": "+84399123456", "provider": "twilio", "messageId": "SM123..." },
    { "ok": true, "to": "+84912345678", "provider": "twilio", "messageId": "SM456..." }
  ]
}
```

### Check SMS Provider Status

```bash
curl https://your-domain/internal/sms/status \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

**Response:**
```json
{
  "ok": true,
  "provider": "twilio",
  "configured": true,
  "from": "+1234567890"
}
```

---

## 9. Environment Variables

### Required Variables (Railway Production)

```bash
# Firebase (REQUIRED)
FIREBASE_SERVICE_ACCOUNT_B64=<base64 encoded service account JSON>

# Cron Security (REQUIRED)
CRON_ENABLED=true
CRON_SECRET=<random-32-character-string>

# Email - Resend (REQUIRED for Railway)
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_xxxxxxxxxx
FROM_EMAIL=onboarding@resend.dev
```

### Optional Variables

```bash
# Server
PORT=3000                    # Default: 3000

# Cron Limits
BATCH_LIMIT=100              # Max devices per query batch (default: 100)
MAX_PER_RUN=200              # Max devices per cron run (default: 200)
LOCK_TIMEOUT_MS=120000       # Lock timeout in ms (default: 2 minutes)
WARN_THRESHOLD=500           # Log warning if exceeded (default: 500)

# Email (optional)
FROM_NAME=IMOK Safety Check  # Sender name

# SMS Provider (optional - choose one)
SMS_PROVIDER=twilio          # Options: twilio, vonage, vn (default: vn)

# Twilio (if SMS_PROVIDER=twilio)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM=+1234567890

# Vonage (if SMS_PROVIDER=vonage)
VONAGE_API_KEY=your_api_key
VONAGE_API_SECRET=your_api_secret
VONAGE_FROM=IMOK

# VN Provider (if SMS_PROVIDER=vn)
VN_SMS_API_URL=https://api.speedsms.vn/index.php/sms/send
VN_SMS_API_KEY=your_api_key
VN_SMS_FROM=IMOK
```

### Example: Railway Variables

```bash
# Required
FIREBASE_SERVICE_ACCOUNT_B64=eyJ0eXBlIjoi...
CRON_ENABLED=true
CRON_SECRET=imok_cron_secret_xyz123

# Email (Resend)
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_abc123xyz
FROM_EMAIL=onboarding@resend.dev

# SMS (Twilio - optional)
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM=+1234567890

# Limits
BATCH_LIMIT=100
MAX_PER_RUN=200
```

### Example: Local .env

```bash
PORT=3000

# Firebase
FIREBASE_SERVICE_ACCOUNT_B64=eyJ0eXBlIjoi...

# Cron
CRON_ENABLED=true
CRON_SECRET=test-secret-local

# Cron Limits
BATCH_LIMIT=100
MAX_PER_RUN=200

# Email (Gmail - local only)
EMAIL_PROVIDER=nodemailer
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
```

---

## 10. Deployment Guide

### Prerequisites

- Firebase project with Firestore enabled
- Railway account
- Resend account (or SendGrid)

### Step 1: Create Firestore Index

**Option A - Click to create (recommended):**

https://console.firebase.google.com/v1/r/project/im-ok-4b2d2/firestore/indexes?create_composite=Cktwcm9qZWN0cy9pbS1vay00YjJkMi9kYXRhYmFzZXMvKGRlZmF1bHQpL2NvbGxlY3Rpb25Hcm91cHMvZGV2aWNlcy9pbmRleGVzL18QARoVChFvdmVyZHVlTm90aWZpZWRBdBABGg0KCW5leHREdWVBdBABGgwKCF9fbmFtZV9fEAE

**Option B - Manual:**
1. Go to Firebase Console → Firestore → Indexes
2. Create composite index:
   - Collection: `devices`
   - Fields: `overdueNotifiedAt` (Ascending), `nextDueAt` (Ascending)

### Step 2: Setup Resend

1. Sign up at https://resend.com
2. Create API Key
3. (Optional) Verify domain for production

### Step 3: Deploy to Railway

1. Connect GitHub repo to Railway
2. Set environment variables (see Section 8)
3. Deploy

### Step 4: Configure Railway Cron Job

1. In Railway project → Settings → Cron
2. Add new cron job:
   - **Name**: scan-overdue
   - **Schedule**: `* * * * *` (every minute)
   - **URL**: `https://<your-domain>/internal/cron/scan-overdue`
   - **Headers**: `x-cron-secret: <your CRON_SECRET>`

### Step 5: Verify Deployment

```bash
# Health check
curl https://imokbehisoeco-production.up.railway.app/health

# Check email provider in logs
# Should show: [Email] Provider: resend, From: onboarding@resend.dev

# Test email (to your own email first)
curl -X POST https://imokbehisoeco-production.up.railway.app/internal/test-email \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: YOUR_CRON_SECRET" \
  -d '{"to":"tranduong110905@gmail.com"}'
```

### Emergency Kill-Switch

To stop cron immediately:
1. Set `CRON_ENABLED=false` in Railway Variables
2. Or disable/delete the Cron Job in Railway

---

## 11. Testing

### Local Testing

```bash
# Install dependencies
npm install

# Start server
npm start

# In another terminal:

# 1. Health check
curl http://localhost:3000/health

# 2. Create test device
curl -X POST http://localhost:3000/api/device/upsert \
  -H "Content-Type: application/json" \
  -d '{
    "installId": "test-001",
    "displayName": "Test User",
    "emergencyEmail": "your-email@example.com",
    "intervalSeconds": 300
  }'

# 3. Check-in
curl -X POST http://localhost:3000/api/device/checkin \
  -H "Content-Type: application/json" \
  -d '{"installId": "test-001"}'

# 4. Get status
curl http://localhost:3000/api/device/test-001/status
```

### Test Email Directly

```bash
# Send test email without device lookup
curl -X POST http://localhost:3000/internal/test-email \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: test-secret-local" \
  -d '{"to": "your-email@example.com"}'
```

### Test E2E Overdue Flow (Recommended)

```bash
# 1. Set device to overdue and trigger scan
curl -X POST http://localhost:3000/internal/test-overdue \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: test-secret-local" \
  -d '{"installId": "test-001", "minutesOverdue": 6}'

# Expected: emailsSent: 1

# 2. Call again immediately (idempotency test)
curl -X POST http://localhost:3000/internal/test-overdue \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: test-secret-local" \
  -d '{"installId": "test-001", "minutesOverdue": 6}'

# Expected: emailsSent: 0 (already notified)
```

### Production Testing (Railway)

```bash
# Replace with your Railway domain and CRON_SECRET

# 1. Health check
curl https://imokbehisoeco-production.up.railway.app/health

# 2. Test email (must use your Resend signup email if no domain verified)
curl -X POST https://imokbehisoeco-production.up.railway.app/internal/test-email \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: YOUR_CRON_SECRET" \
  -d '{"to":"tranduong110905@gmail.com"}'

# 3. Test overdue E2E
curl -X POST https://imokbehisoeco-production.up.railway.app/internal/test-overdue \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: YOUR_CRON_SECRET" \
  -d '{"installId":"YOUR_DEVICE_ID","minutesOverdue":6}'

# 4. Check cron status
curl https://imokbehisoeco-production.up.railway.app/internal/cron/status \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

### Test Checklist

- [x] POST /api/device/upsert - Create device
- [x] POST /api/device/checkin - Check-in
- [x] GET /api/device/:id/status - Get status
- [x] GET /internal/cron/scan-overdue - Find overdue
- [x] POST /internal/test-email - Direct email test
- [x] POST /internal/test-overdue - E2E test
- [x] Email sending - Resend API works
- [x] Idempotency - No duplicate emails
- [x] Railway deployment - Server running

---

## 12. Troubleshooting

### Error: FAILED_PRECONDITION (code 9)

**Cause:** Missing Firestore composite index

**Solution:** Create index using link in Section 9, Step 1

### Error: Connection timeout (Gmail on Railway)

**Cause:** Railway blocks SMTP ports (587/465)

**Solution:** Use Resend or SendGrid instead of Gmail SMTP
```bash
# Railway Variables
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_xxxxxxxxxx
FROM_EMAIL=onboarding@resend.dev
```

### Error: "You can only send testing emails to your own email address"

**Cause:** Resend free tier without verified domain

**Solution:**
1. Test with your signup email (e.g., `tranduong110905@gmail.com`)
2. Or verify a domain at https://resend.com/domains

### Error: lock_held

**Cause:** Previous cron run didn't finish

**Solution:**
```bash
curl -X POST https://your-domain/internal/cron/force-release \
  -H "x-cron-secret: your-secret"
```

### Error: CRON_ENABLED disabled

**Cause:** `CRON_ENABLED` not set to `true`

**Solution:** Set `CRON_ENABLED=true` in Railway Variables and redeploy

### High Firestore Read Costs

**Possible Causes:**
1. Missing composite index (causing full scan)
2. `BATCH_LIMIT` or `MAX_PER_RUN` too high

**Solution:**
1. Ensure composite index exists
2. Review `BATCH_LIMIT` and `MAX_PER_RUN` settings
3. Check cron logs for `queriedCount`

### No Emails Sent

**Checklist:**
1. `CRON_ENABLED=true`?
2. `EMAIL_PROVIDER=resend` and `EMAIL_API_KEY` set correctly?
3. Device has valid `emergencyEmail`?
4. Device is actually overdue? (past `nextDueAt + graceSeconds`)
5. `overdueNotifiedAt` is null? (not already notified)
6. Check logs for `[Email] Provider: resend`

### Testing Specific Device

Use the test-overdue endpoint:
```bash
curl -X POST https://your-domain/internal/test-overdue \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: your-secret" \
  -d '{"installId": "your-device-id", "minutesOverdue": 6}'
```

---

## 13. Changelog

### v2.0.5 (2026-01-20)
- **NEW**: SMS Gateway integration (Twilio, Vonage, VN Provider)
- Added `src/services/smsSender.js` - SMS sending service with multi-provider support
- Added `/internal/test-sms` endpoint for testing SMS
- Added `/internal/sms/status` endpoint to check provider configuration
- Updated `/api/device/upsert` to support `smsEnabled` and `emergencyPhones` fields
- Updated scan-overdue to send both email and SMS alerts
- Separate idempotency for SMS via `overdueSmsNotifiedAt` field
- Phone number normalization to E.164 format (VN: 0xxx → +84xxx)
- Added SMS section to PROJECT_PLAN.md documentation

### v2.0.4 (2026-01-19)
- Switched to Resend API for production email (Railway blocks SMTP)
- Added `resend` package to dependencies
- Updated documentation with Resend/SendGrid setup
- Clarified: Gmail SMTP only works locally, not on Railway
- Added troubleshooting for Resend free tier limitations

### v2.0.3 (2026-01-19)
- Added `/internal/test-overdue` endpoint for E2E testing
- Added email timeout settings (10-15 seconds) to prevent hanging
- Verified idempotency: first call sends email, second call skips
- Full audit completed with all acceptance criteria met

### v2.0.2 (2026-01-19)
- Full system test passed
- Email sending verified with Gmail SMTP (local)
- Idempotency verified (no duplicate emails)

### v2.0.1 (2026-01-18)
- Security audit completed
- Fixed: Email moved outside transaction
- Added: Email validation, runId logging, warn threshold
- Reduced: Lock timeout to 2 minutes

### v2.0.0 (2026-01-18)
- **BREAKING**: Migrated from MySQL to Firestore-only
- **BREAKING**: Changed collection from `users` to `devices`
- **BREAKING**: Removed internal scheduler, use external Railway cron
- Removed fallback query logic (no more runaway reads)
- New API: `/api/device/*` endpoints

---

## Contact

For issues or questions:
- GitHub: https://github.com/Hailexuan00/im_ok_hisoEco
- Create an issue for bug reports or feature requests

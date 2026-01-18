# IMOK Backend - Project Plan & Documentation

> **Last Updated**: 2026-01-19
> **Version**: 2.0.2
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
8. [Environment Variables](#8-environment-variables)
9. [Deployment Guide](#9-deployment-guide)
10. [Testing](#10-testing)
11. [Troubleshooting](#11-troubleshooting)
12. [Changelog](#12-changelog)

---

## 1. Project Overview

### What is IMOK?

**IMOK** (I'm OK) is a safety check-in application that helps users stay connected with their emergency contacts. If a user fails to check-in within a specified time period, the system automatically sends an alert email to their designated emergency contact.

### Key Features

| Feature | Description |
|---------|-------------|
| No Login Required | Uses device `installId` (UUID) as identifier |
| Automatic Alerts | Sends email when user misses check-in deadline |
| Customizable Intervals | Each user can set their own check-in frequency |
| Idempotent | No duplicate emails sent for the same overdue event |
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
| Email Notification | ✅ OK | Gmail SMTP tested 2026-01-19 |
| Idempotency | ✅ OK | No duplicate emails |

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
                        │   Gmail SMTP     │
                        │   (Nodemailer)   │
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
│   │   └── internal.routes.js   # /internal/cron/* endpoints
│   └── services/
│       └── emailSender.js       # Email provider module (Gmail/Resend/SendGrid)
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
| Email | Nodemailer | 7.x | Gmail SMTP |
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
    "nodemailer": "^7.0.12"
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
| intervalSeconds | number | Check-in interval (default: 86400 = 24h) | `86400` |
| graceSeconds | number | Grace period (default: 300 = 5 min) | `300` |
| lastCheckinAt | Timestamp | Last successful check-in time | `2026-01-19T10:00:00Z` |
| nextDueAt | Timestamp | Deadline for next check-in | `2026-01-20T10:00:00Z` |
| status | string | Current status | `"OK"` or `"OVERDUE"` |
| overdueNotifiedAt | Timestamp/null | Idempotency flag | `null` or `2026-01-20T10:05:00Z` |
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
| toEmail | string | Recipient email |
| type | string | Alert type: `"OVERDUE_EMAIL"` |
| status | string | `"SUCCESS"` or `"FAIL"` |
| providerId | string/null | Email provider message ID |
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
| Production | `https://imokhisoeco-production.up.railway.app` |
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

| Provider | ENV Variables | Recommended For |
|----------|---------------|-----------------|
| Gmail SMTP | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Testing, small scale |
| Resend | `EMAIL_API_KEY`, `FROM_EMAIL` | Production |
| SendGrid | `EMAIL_API_KEY`, `FROM_EMAIL` | Production |

### Gmail SMTP Setup

1. Enable 2FA on your Google Account
2. Go to: https://myaccount.google.com/apppasswords
3. Create App Password for "Mail"
4. Copy the 16-character password **with spaces**

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

## 8. Environment Variables

### Required Variables

```bash
# Firebase (REQUIRED)
FIREBASE_SERVICE_ACCOUNT_B64=<base64 encoded service account JSON>

# Cron Security (REQUIRED)
CRON_ENABLED=true
CRON_SECRET=<random-32-character-string>

# Email - Gmail SMTP (REQUIRED)
EMAIL_PROVIDER=nodemailer
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   # WITH spaces!
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

# Email (for Resend/SendGrid)
EMAIL_API_KEY=re_xxx         # API key
FROM_EMAIL=noreply@app.com   # Sender email
FROM_NAME=IMOK Safety Check  # Sender name
```

### Example `.env` File

```bash
PORT=3000

# Firebase
FIREBASE_SERVICE_ACCOUNT_B64=eyJ0eXBlIjoi...base64...

# Cron
CRON_ENABLED=true
CRON_SECRET=my-super-secret-cron-key-32chars

# Cron Limits
BATCH_LIMIT=100
MAX_PER_RUN=200

# Email (Gmail)
EMAIL_PROVIDER=nodemailer
GMAIL_USER=myapp@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
```

---

## 9. Deployment Guide

### Prerequisites

- Firebase project with Firestore enabled
- Railway account
- Gmail account with App Password (or Resend/SendGrid API key)

### Step 1: Create Firestore Index

**Option A - Click to create (recommended):**

https://console.firebase.google.com/v1/r/project/im-ok-4b2d2/firestore/indexes?create_composite=Cktwcm9qZWN0cy9pbS1vay00YjJkMi9kYXRhYmFzZXMvKGRlZmF1bHQpL2NvbGxlY3Rpb25Hcm91cHMvZGV2aWNlcy9pbmRleGVzL18QARoVChFvdmVyZHVlTm90aWZpZWRBdBABGg0KCW5leHREdWVBdBABGgwKCF9fbmFtZV9fEAE

**Option B - Manual:**
1. Go to Firebase Console → Firestore → Indexes
2. Create composite index:
   - Collection: `devices`
   - Fields: `overdueNotifiedAt` (Ascending), `nextDueAt` (Ascending)

### Step 2: Deploy to Railway

1. Connect GitHub repo to Railway
2. Set environment variables (see Section 8)
3. Deploy

### Step 3: Configure Railway Cron Job

1. In Railway project → Settings → Cron
2. Add new cron job:
   - **Name**: scan-overdue
   - **Schedule**: `* * * * *` (every minute)
   - **URL**: `https://<your-domain>/internal/cron/scan-overdue`
   - **Headers**: `x-cron-secret: <your CRON_SECRET>`

### Step 4: Verify Deployment

```bash
# Health check
curl https://your-domain.railway.app/health

# Test cron (with secret)
curl https://your-domain.railway.app/internal/cron/scan-overdue \
  -H "x-cron-secret: your-secret"
```

### Emergency Kill-Switch

To stop cron immediately:
1. Set `CRON_ENABLED=false` in Railway Variables
2. Or disable/delete the Cron Job in Railway

---

## 10. Testing

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

### Test Email Sending

```bash
# 1. Use test script to set device to overdue
node scripts/test-email-cron.js

# 2. Call cron to trigger email
curl http://localhost:3000/internal/cron/scan-overdue \
  -H "x-cron-secret: test-secret-local"

# 3. Check your email inbox!

# 4. Call cron again (should show queriedCount: 0 - idempotency works)
curl http://localhost:3000/internal/cron/scan-overdue \
  -H "x-cron-secret: test-secret-local"
```

### Test Checklist

- [x] POST /api/device/upsert - Create device
- [x] POST /api/device/checkin - Check-in
- [x] GET /api/device/:id/status - Get status
- [x] GET /internal/cron/scan-overdue - Find overdue
- [x] Email sending - Gmail SMTP works
- [x] Idempotency - No duplicate emails

---

## 11. Troubleshooting

### Error: FAILED_PRECONDITION (code 9)

**Cause:** Missing Firestore composite index

**Solution:** Create index using link in Section 9, Step 1

### Error: Username and Password not accepted

**Cause:** Gmail App Password incorrect or 2FA not enabled

**Solution:**
1. Ensure 2FA is enabled on Gmail account
2. Create new App Password at https://myaccount.google.com/apppasswords
3. Use password **WITH spaces**: `xxxx xxxx xxxx xxxx`

### Error: lock_held

**Cause:** Previous cron run didn't finish

**Solution:**
```bash
curl -X POST https://your-domain/internal/cron/force-release \
  -H "x-cron-secret: your-secret"
```

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
2. `GMAIL_USER` and `GMAIL_APP_PASSWORD` set correctly?
3. Device has valid `emergencyEmail`?
4. Device is actually overdue? (past `nextDueAt + graceSeconds`)
5. `overdueNotifiedAt` is null? (not already notified)

---

## 12. Changelog

### v2.0.2 (2026-01-19)
- Full system test passed
- Email sending verified with Gmail SMTP
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

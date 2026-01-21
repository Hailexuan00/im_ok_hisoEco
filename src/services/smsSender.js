/**
 * SMS Gateway Service
 * Supports: Twilio, Vonage, VN Generic Provider
 *
 * Environment Variables:
 * - SMS_PROVIDER: twilio | vonage | vn (default: vn)
 * - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 * - VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_FROM
 * - VN_SMS_API_URL, VN_SMS_API_KEY, VN_SMS_FROM
 */

const https = require('https');
const http = require('http');

// ============================================
// Configuration
// ============================================

const SMS_PROVIDER = process.env.SMS_PROVIDER || 'vn';
const SMS_TIMEOUT = 15000; // 15 seconds

// Twilio config
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

// Vonage config
const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
const VONAGE_FROM = process.env.VONAGE_FROM || 'IMOK';

// VN Generic Provider config
const VN_SMS_API_URL = process.env.VN_SMS_API_URL;
const VN_SMS_API_KEY = process.env.VN_SMS_API_KEY;
const VN_SMS_FROM = process.env.VN_SMS_FROM || 'IMOK';

// ============================================
// Phone Number Normalization (VN -> E.164)
// ============================================

/**
 * Normalize Vietnamese phone number to E.164 format
 * @param {string} phone - Raw phone number
 * @returns {string|null} - Normalized E.164 format or null if invalid
 *
 * Examples:
 *   0399123456   -> +84399123456
 *   84399123456  -> +84399123456
 *   +84399123456 -> +84399123456
 *   039 912 3456 -> +84399123456
 */
function normalizePhoneVN(phone) {
  if (!phone || typeof phone !== 'string') return null;

  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // If starts with +, keep it; otherwise remove any +
  if (cleaned.startsWith('+')) {
    cleaned = '+' + cleaned.slice(1).replace(/\+/g, '');
  } else {
    cleaned = cleaned.replace(/\+/g, '');
  }

  // Handle different formats
  if (cleaned.startsWith('+84')) {
    // Already E.164 VN format
    return cleaned;
  } else if (cleaned.startsWith('84') && cleaned.length >= 11) {
    // 84xxxxxxxxx -> +84xxxxxxxxx
    return '+' + cleaned;
  } else if (cleaned.startsWith('0') && cleaned.length >= 10) {
    // 0xxxxxxxxx -> +84xxxxxxxxx
    return '+84' + cleaned.slice(1);
  }

  // Invalid format
  return null;
}

/**
 * Validate E.164 phone number
 * @param {string} phone - E.164 formatted phone
 * @returns {boolean}
 */
function isValidE164(phone) {
  // E.164: + followed by 10-15 digits
  return /^\+[1-9]\d{9,14}$/.test(phone);
}

// ============================================
// HTTP Helper with Timeout
// ============================================

/**
 * Make HTTP/HTTPS request with timeout
 * @param {Object} options - Request options
 * @param {string} postData - POST body (optional)
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'http:' ? http : https;

    const req = protocol.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(SMS_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// ============================================
// Provider Adapters
// ============================================

/**
 * Send SMS via Twilio
 * @param {string} to - E.164 phone number
 * @param {string} message - SMS content
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendViaTwilio(to, message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    return { ok: false, error: 'Twilio credentials not configured' };
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const postData = new URLSearchParams({
    To: to,
    From: TWILIO_FROM,
    Body: message,
  }).toString();

  const options = {
    hostname: 'api.twilio.com',
    port: 443,
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  try {
    const { statusCode, body } = await httpRequest(options, postData);
    const data = JSON.parse(body);

    if (statusCode >= 200 && statusCode < 300 && data.sid) {
      return { ok: true, messageId: data.sid };
    } else {
      return { ok: false, error: data.message || `HTTP ${statusCode}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send SMS via Vonage (Nexmo)
 * @param {string} to - E.164 phone number
 * @param {string} message - SMS content
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendViaVonage(to, message) {
  if (!VONAGE_API_KEY || !VONAGE_API_SECRET) {
    return { ok: false, error: 'Vonage credentials not configured' };
  }

  const postData = JSON.stringify({
    api_key: VONAGE_API_KEY,
    api_secret: VONAGE_API_SECRET,
    to: to.replace('+', ''),  // Vonage prefers without +
    from: VONAGE_FROM,
    text: message,
  });

  const options = {
    hostname: 'rest.nexmo.com',
    port: 443,
    path: '/sms/json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  try {
    const { statusCode, body } = await httpRequest(options, postData);
    const data = JSON.parse(body);

    if (data.messages && data.messages[0]) {
      const msg = data.messages[0];
      if (msg.status === '0') {
        return { ok: true, messageId: msg['message-id'] };
      } else {
        return { ok: false, error: msg['error-text'] || `Status ${msg.status}` };
      }
    }
    return { ok: false, error: `HTTP ${statusCode}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send SMS via VN Generic Provider
 * Assumes standard REST API with JSON body
 * @param {string} to - E.164 phone number
 * @param {string} message - SMS content
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendViaVN(to, message) {
  if (!VN_SMS_API_URL || !VN_SMS_API_KEY) {
    return { ok: false, error: 'VN SMS provider not configured' };
  }

  // Parse the API URL
  let url;
  try {
    url = new URL(VN_SMS_API_URL);
  } catch {
    return { ok: false, error: 'Invalid VN_SMS_API_URL' };
  }

  // Standard VN provider payload (adjust as needed for specific provider)
  const postData = JSON.stringify({
    phone: to.replace('+84', '0'),  // Most VN providers prefer local format
    message: message,
    brandname: VN_SMS_FROM,
    // Some providers use different field names:
    // to, content, sender, etc.
  });

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    protocol: url.protocol,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VN_SMS_API_KEY}`,
      // Some providers use different auth:
      // 'X-API-Key': VN_SMS_API_KEY,
      // 'token': VN_SMS_API_KEY,
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  try {
    const { statusCode, body } = await httpRequest(options, postData);

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = { raw: body };
    }

    // Check various success indicators
    if (statusCode >= 200 && statusCode < 300) {
      const messageId = data.messageId || data.message_id || data.id || data.smsId || null;
      if (data.success !== false && data.error === undefined) {
        return { ok: true, messageId };
      }
    }

    return { ok: false, error: data.error || data.message || `HTTP ${statusCode}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================
// Main Send Function
// ============================================

/**
 * Send SMS using configured provider
 * @param {string} to - Phone number (any format, will be normalized)
 * @param {string} message - SMS content
 * @returns {Promise<{ok: boolean, to: string, provider: string, messageId?: string, error?: string}>}
 */
async function sendSms(to, message) {
  // Normalize phone number
  const normalizedPhone = normalizePhoneVN(to);

  if (!normalizedPhone || !isValidE164(normalizedPhone)) {
    console.error(`[SMS] Invalid phone number: ${to}`);
    return {
      ok: false,
      to,
      provider: SMS_PROVIDER,
      error: 'Invalid phone number format',
    };
  }

  console.info(`[SMS] Sending to ${normalizedPhone} via ${SMS_PROVIDER}...`);

  let result;
  switch (SMS_PROVIDER.toLowerCase()) {
    case 'twilio':
      result = await sendViaTwilio(normalizedPhone, message);
      break;
    case 'vonage':
      result = await sendViaVonage(normalizedPhone, message);
      break;
    case 'vn':
    default:
      result = await sendViaVN(normalizedPhone, message);
      break;
  }

  if (result.ok) {
    console.info(`[SMS] Sent successfully to ${normalizedPhone}, messageId: ${result.messageId}`);
  } else {
    console.error(`[SMS] Failed to send to ${normalizedPhone}: ${result.error}`);
  }

  return {
    ...result,
    to: normalizedPhone,
    provider: SMS_PROVIDER,
  };
}

/**
 * Send SMS to multiple recipients
 * @param {string[]} phones - Array of phone numbers
 * @param {string} message - SMS content
 * @returns {Promise<{ok: boolean, results: Array, sentCount: number, failedCount: number}>}
 */
async function sendSmsToMany(phones, message) {
  if (!phones || !Array.isArray(phones) || phones.length === 0) {
    return { ok: false, results: [], sentCount: 0, failedCount: 0, error: 'No phone numbers provided' };
  }

  const results = [];
  let sentCount = 0;
  let failedCount = 0;

  for (const phone of phones) {
    const result = await sendSms(phone, message);
    results.push(result);
    if (result.ok) {
      sentCount++;
    } else {
      failedCount++;
    }
  }

  return {
    ok: sentCount > 0,
    results,
    sentCount,
    failedCount,
  };
}

/**
 * Build overdue alert message
 * @param {string} displayName - User's name
 * @param {Date} nextDueAt - Due time
 * @returns {string}
 */
function buildOverdueMessage(displayName, nextDueAt) {
  const dueTime = nextDueAt instanceof Date
    ? nextDueAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    : nextDueAt;

  return `[IMOK] Canh bao: ${displayName || 'Nguoi than'} khong diem danh dung han (${dueTime}). Vui long lien he kiem tra.`;
}

/**
 * Check if SMS is configured
 * @returns {boolean}
 */
function isSmsConfigured() {
  switch (SMS_PROVIDER.toLowerCase()) {
    case 'twilio':
      return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);
    case 'vonage':
      return !!(VONAGE_API_KEY && VONAGE_API_SECRET);
    case 'vn':
    default:
      return !!(VN_SMS_API_URL && VN_SMS_API_KEY);
  }
}

/**
 * Get current SMS provider info
 * @returns {{provider: string, configured: boolean, from: string}}
 */
function getSmsProviderInfo() {
  let from = '';
  switch (SMS_PROVIDER.toLowerCase()) {
    case 'twilio':
      from = TWILIO_FROM || '';
      break;
    case 'vonage':
      from = VONAGE_FROM || '';
      break;
    case 'vn':
    default:
      from = VN_SMS_FROM || '';
      break;
  }

  return {
    provider: SMS_PROVIDER,
    configured: isSmsConfigured(),
    from,
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  sendSms,
  sendSmsToMany,
  normalizePhoneVN,
  isValidE164,
  buildOverdueMessage,
  isSmsConfigured,
  getSmsProviderInfo,
};

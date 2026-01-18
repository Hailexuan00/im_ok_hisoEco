/**
 * IMOK Backend - Firestore Only
 * No login required, uses installId as identifier
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Initialize Firebase (must be first)
const { db } = require('./firebaseAdmin');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// ============================================
// Routes
// ============================================

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'IMOK Backend',
    version: '2.0',
    database: 'Firestore',
    mode: 'installId (no login)',
  });
});

// Health check
app.get('/health', async (req, res) => {
  try {
    // Quick Firestore check
    await db.collection('_health').doc('ping').set({ t: Date.now() });
    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API routes
const deviceRoutes = require('./routes/device.routes');
const internalRoutes = require('./routes/internal.routes');

app.use('/api/device', deviceRoutes);
app.use('/internal', internalRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log('[Server] Database: Firestore');
  console.log('[Server] Mode: installId (no login)');
});

module.exports = app;

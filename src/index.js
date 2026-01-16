const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { db } = require('./firebaseAdmin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to im_ok_be API' });
});

app.get('/health', async (req, res) => {
  try {
    await db.collection('_health').doc('ping').set({ at: Date.now() }, { merge: true });
    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// API routes
const apiRoutes = require('./routes');
app.use('/api', apiRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;

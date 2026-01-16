const express = require('express');
const router = express.Router();

// Import route modules
const userRoutes = require('./user.routes');
const notificationRoutes = require('./notification.routes');
const webhookRoutes = require('./webhook.routes');

// Use routes
router.use('/users', userRoutes);
router.use('/notifications', notificationRoutes);
router.use('/webhooks', webhookRoutes);

module.exports = router;

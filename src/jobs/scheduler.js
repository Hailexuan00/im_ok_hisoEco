const cron = require('node-cron');
const { checkOverdueUsers } = require('../services/userService');
const { processEscalations } = require('../services/alertService');

/**
 * Initialize all scheduled jobs
 */
function initializeScheduler() {
  console.log('[Scheduler] Initializing scheduled jobs...');

  // Check overdue users every 5 minutes
  // Cron: "*/5 * * * *" = every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Scheduler] Running checkOverdueUsers job');
    try {
      await checkOverdueUsers();
    } catch (error) {
      console.error('[Scheduler] checkOverdueUsers error:', error);
    }
  });

  // Process escalations every 1 minute
  // Cron: "* * * * *" = every minute
  cron.schedule('* * * * *', async () => {
    console.log('[Scheduler] Running processEscalations job');
    try {
      await processEscalations();
    } catch (error) {
      console.error('[Scheduler] processEscalations error:', error);
    }
  });

  console.log('[Scheduler] Scheduled jobs initialized:');
  console.log('  - checkOverdueUsers: every 5 minutes');
  console.log('  - processEscalations: every 1 minute');
}

module.exports = { initializeScheduler };

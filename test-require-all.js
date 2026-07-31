try {
  console.log('Testing requiring all backend modules...');
  require('./src/routes/authRoutes');
  console.log('[PASS] authRoutes');
  require('./src/routes/caseRoutes');
  console.log('[PASS] caseRoutes');
  require('./src/routes/settingsRoutes');
  console.log('[PASS] settingsRoutes');
  require('./src/routes/clientRoutes');
  console.log('[PASS] clientRoutes');
  require('./src/routes/leadRoutes');
  console.log('[PASS] leadRoutes');
  require('./src/routes/userRoutes');
  console.log('[PASS] userRoutes');
  require('./src/routes/consultationRoutes');
  console.log('[PASS] consultationRoutes');
  require('./src/routes/paymentRoutes');
  console.log('[PASS] paymentRoutes');
  require('./src/routes/documentRoutes');
  console.log('[PASS] documentRoutes');
  require('./src/routes/marketingRoutes');
  console.log('[PASS] marketingRoutes');
  require('./src/routes/webhookRoutes');
  console.log('[PASS] webhookRoutes');
  require('./src/routes/bookingRoutes');
  console.log('[PASS] bookingRoutes');
  require('./src/routes/aiRoutes');
  console.log('[PASS] aiRoutes');
  require('./src/routes/notificationRoutes');
  console.log('[PASS] notificationRoutes');
  require('./src/routes/auditLogRoutes');
  console.log('[PASS] auditLogRoutes');
  require('./src/routes/socialRoutes');
  console.log('[PASS] socialRoutes');
  require('./src/routes/communicationRoutes');
  console.log('[PASS] communicationRoutes');

  const app = require('./src/app');
  console.log('[PASS] app.js required successfully!');
} catch (err) {
  console.error('[FAIL] Require module error:', err);
  process.exit(1);
}

const express = require('express');
const { 
  getCustomizationSettings, 
  updateCustomizationSettings,
  getLeadStages,
  updateLeadStages,
  getCompanySettings,
  updateCompanySettings,
  getVisaServices,
  updateVisaServices,
  getPackages,
  createPackage,
  deletePackage,
  updatePackages,
  getEmailTemplates,
  updateEmailTemplates,
  getWhatsappTemplates,
  updateWhatsappTemplates,
  purgeAllData
} = require('../controllers/settingsController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.delete('/purge-all-data', authMiddleware, purgeAllData);

router.get('/test-email-live', async (req, res) => {
  const targetEmail = req.query.to || 'client@aaabusinessconsultancy.com';
  const { sendEmail } = require('../services/emailService');

  const apiKey = process.env.RESEND_API_KEY ? `${process.env.RESEND_API_KEY.substring(0, 10)}...` : 'MISSING';
  const fromEmail = process.env.RESEND_FROM || process.env.RESEND_FROM_EMAIL || process.env.SMTP_FROM || 'client@aaabusinessconsultancy.com';

  try {
    const result = await sendEmail({
      to: targetEmail,
      subject: `🧪 Live Diagnostic Test Email (${new Date().toISOString()})`,
      html: `<h3>Railway Live Email Diagnostic</h3><p>Resend email delivery is working 100% on live backend!</p>`
    });
    return res.status(200).json({
      success: true,
      message: `Email sent successfully to ${targetEmail}`,
      env: {
        RESEND_API_KEY_PRESENT: !!process.env.RESEND_API_KEY,
        RESEND_API_KEY_PREFIX: apiKey,
        RESEND_FROM: fromEmail
      },
      resendResult: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `Failed to send live email to ${targetEmail}`,
      env: {
        RESEND_API_KEY_PRESENT: !!process.env.RESEND_API_KEY,
        RESEND_API_KEY_PREFIX: apiKey,
        RESEND_FROM: fromEmail
      },
      error: error.message,
      stack: error.stack
    });
  }
});

router.route('/customization')
  .get(getCustomizationSettings)
  .put(authMiddleware, updateCustomizationSettings);

router.route('/lead-stages')
  .get(authMiddleware, getLeadStages)
  .put(authMiddleware, updateLeadStages);

router.route('/company')
  .get(getCompanySettings)
  .put(authMiddleware, updateCompanySettings);

router.route('/services')
  .get(authMiddleware, getVisaServices)
  .put(authMiddleware, updateVisaServices);

router.route('/packages')
  .get(authMiddleware, getPackages)
  .post(authMiddleware, createPackage)
  .put(authMiddleware, updatePackages);

router.route('/packages/:id')
  .delete(authMiddleware, deletePackage);

router.route('/templates/email')
  .get(authMiddleware, getEmailTemplates)
  .put(authMiddleware, updateEmailTemplates);

router.route('/templates/whatsapp')
  .get(authMiddleware, getWhatsappTemplates)
  .put(authMiddleware, updateWhatsappTemplates);

module.exports = router;

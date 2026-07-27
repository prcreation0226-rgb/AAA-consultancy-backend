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
  updatePackages,
  getEmailTemplates,
  updateEmailTemplates,
  getWhatsappTemplates,
  updateWhatsappTemplates
} = require('../controllers/settingsController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/customization')
  .get(getCustomizationSettings)
  .put(authMiddleware, updateCustomizationSettings);

router.route('/lead-stages')
  .get(authMiddleware, getLeadStages)
  .put(authMiddleware, updateLeadStages);

router.route('/company')
  .get(authMiddleware, getCompanySettings)
  .put(authMiddleware, updateCompanySettings);

router.route('/services')
  .get(authMiddleware, getVisaServices)
  .put(authMiddleware, updateVisaServices);

router.route('/packages')
  .get(authMiddleware, getPackages)
  .put(authMiddleware, updatePackages);

router.route('/templates/email')
  .get(authMiddleware, getEmailTemplates)
  .put(authMiddleware, updateEmailTemplates);

router.route('/templates/whatsapp')
  .get(authMiddleware, getWhatsappTemplates)
  .put(authMiddleware, updateWhatsappTemplates);

module.exports = router;

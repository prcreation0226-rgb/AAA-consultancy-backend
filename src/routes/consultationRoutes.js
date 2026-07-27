const express = require('express');
const {
  getConsultations,
  createConsultation,
  updateOutcome,
  respondToConsultation,
  createConsultationForLead,
  reassignConsultant,
  publicRescheduleConsultation,
  publicCancelConsultation
} = require('../controllers/consultationController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.patch('/public/reschedule', publicRescheduleConsultation);
router.patch('/public/cancel', publicCancelConsultation);

router.route('/')
  .get(authMiddleware, getConsultations)
  .post(createConsultation); // Public booking link

router.patch('/:id/outcome', authMiddleware, updateOutcome);
router.patch('/:id/respond', authMiddleware, respondToConsultation);
router.patch('/:id/reassign', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations']), reassignConsultant);
router.post('/create-for-lead', authMiddleware, createConsultationForLead);

module.exports = router;


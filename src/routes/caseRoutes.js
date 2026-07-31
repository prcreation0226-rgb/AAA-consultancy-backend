const express = require('express');
const {
  getActiveCases,
  getClosedCases,
  getCyclesByClient,
  createCycle,
  updateCycle,
  getCycleChecklist,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  uploadChecklistDoc,
  reviewChecklistDoc,
  resubmitCycle,
  recordGovernmentDecision,
  generateDefaultChecklist
} = require('../controllers/caseController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

const router = express.Router();

router.get('/active', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance']), getActiveCases);
router.get('/closed', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance']), getClosedCases);

// Cycle Management Endpoints
router.get('/cycles/:clientId', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance', 'client']), getCyclesByClient);
router.post('/cycles', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), createCycle);
router.patch('/cycles/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), updateCycle);
router.post('/cycles/:id/resubmit', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), resubmitCycle);
router.post('/cycles/:id/government-decision', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations']), recordGovernmentDecision);
router.post('/cycles/:id/generate-checklist', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), generateDefaultChecklist);

// Checklist Management Endpoints
router.get('/cycles/:cycleId/checklist', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance', 'client']), getCycleChecklist);
router.post('/checklists/item', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), addChecklistItem);
router.patch('/checklists/item/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), updateChecklistItem);
router.delete('/checklists/item/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), deleteChecklistItem);

// Checklist Upload & Operations Review Endpoints
router.post('/checklists/item/:id/upload', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'client']), upload.single('file'), uploadChecklistDoc);
router.patch('/documents/:documentId/review', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations']), reviewChecklistDoc);

module.exports = router;

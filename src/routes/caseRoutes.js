const express = require('express');
const {
  getActiveCases,
  getClosedCases,
  getCyclesByClient,
  createCycle,
  updateCycle
} = require('../controllers/caseController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/active', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance']), getActiveCases);
router.get('/closed', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance']), getClosedCases);
router.get('/cycles/:clientId', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance', 'client']), getCyclesByClient);
router.post('/cycles', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), createCycle);
router.patch('/cycles/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), updateCycle);

module.exports = router;


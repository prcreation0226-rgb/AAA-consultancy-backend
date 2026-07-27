const express = require('express');
const {
  getActiveCases,
  getClosedCases,
  getCyclesByClient,
  createCycle,
  updateCycle
} = require('../controllers/caseController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/active', authMiddleware, getActiveCases);
router.get('/closed', authMiddleware, getClosedCases);
router.get('/cycles/:clientId', authMiddleware, getCyclesByClient);
router.post('/cycles', authMiddleware, createCycle);
router.patch('/cycles/:id', authMiddleware, updateCycle);

module.exports = router;

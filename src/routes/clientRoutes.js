const express = require('express');
const { getClients, createClient, updateClient, updateClientStatus, selectPackage, generateCredentials, clientLogin, changeClientPassword, updateClientDependents, getClientProfile, submitGoogleReviewStatus } = require('../controllers/clientController');

const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/')
  .get(authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'finance']), getClients)
  .post(authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), createClient);

router.post('/login', clientLogin);
router.get('/profile/me', authMiddleware, getClientProfile);
router.post('/:id/credentials', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), generateCredentials);
router.put('/:id/change-password', authMiddleware, changeClientPassword);
router.patch('/:id/status', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), updateClientStatus);
router.post('/:id/select-package', authMiddleware, selectPackage);
router.patch('/:id/dependents', authMiddleware, updateClientDependents);
router.post('/:id/google-review', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), submitGoogleReviewStatus);
router.put('/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), updateClient);

module.exports = router;

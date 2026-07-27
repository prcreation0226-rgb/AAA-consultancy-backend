const express = require('express');
const { getDocuments, uploadDocument, reviewDocument, uploadTranslatedDocument, deleteDocument } = require('../controllers/documentController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

const router = express.Router();

router.route('/')
  .get(authMiddleware, getDocuments);

router.post('/upload', authMiddleware, upload.single('file'), uploadDocument);

router.patch('/:id/verify', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), reviewDocument);
router.patch('/:id/translated', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), upload.single('translatedFile'), uploadTranslatedDocument);
router.delete('/:id', authMiddleware, deleteDocument);

module.exports = router;

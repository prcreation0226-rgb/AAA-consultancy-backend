const express = require('express');
const router = express.Router();
const socialController = require('../controllers/socialController');
const { authMiddleware } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

router.get('/conversations', authMiddleware, socialController.getConversations);
router.get('/messages/:phone', authMiddleware, socialController.getMessagesByPhone);
router.post('/messages/send', authMiddleware, socialController.sendSocialMessage);
router.post('/upload-media', authMiddleware, upload.single('file'), socialController.uploadMedia);
router.get('/media-proxy', socialController.proxyTwilioMedia);
module.exports = router;

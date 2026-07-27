const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { rateLimit } = require('express-rate-limit');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// DDoS Protection
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per `window`
  message: 'Too many booking requests from this IP, please try again after 15 minutes',
});

// Eligibility Booking
router.post('/eligibility', bookingLimiter, bookingController.createEligibilityBooking);
router.get('/prefill', bookingController.verifyPrefillToken);

// Translation Upload
router.post('/translation/upload', upload.single('document'), bookingController.uploadTranslationDocument);

// Translation Checkout (disk storage)
const uploadDisk = require('../middlewares/uploadMiddleware');
router.post('/translation/checkout', uploadDisk.single('document'), bookingController.checkoutTranslationDocument);

module.exports = router;

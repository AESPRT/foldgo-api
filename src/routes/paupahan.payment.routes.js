const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

router.post('/paupahan/checkout', paymentController.createCheckoutSession);
router.post('/paupahan/paymongo-webhook', paymentController.handleWebhookFulfillment);
router.get('/paupahan/redirect/success', paymentController.renderSuccessPage);
router.get('/paupahan/redirect/cancel', paymentController.renderCancelPage);

module.exports = router;
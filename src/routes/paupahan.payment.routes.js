const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paupahan.payment.controller');

router.post('/checkout', paymentController.createCheckoutSession);
router.post('/paymongo-webhook', paymentController.handleWebhookFulfillment);
router.get('/redirect/success', paymentController.renderSuccessPage);
router.get('/redirect/cancel', paymentController.renderCancelPage);

module.exports = router;
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

router.post('/checkout', paymentController.createCheckoutSession);
router.post('/paymongo-webhook', paymentController.handleWebhookFulfillment);
router.get('/verify-dashboard', paymentController.verifyDashboardToken);
router.get('/redirect/success', paymentController.renderSuccessPage);
router.get('/redirect/cancel', paymentController.renderCancelPage);

module.exports = router;
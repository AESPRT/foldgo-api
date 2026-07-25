const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paupahan.payment.controller');

router.post('/checkout', paymentController.createCheckoutSession);
router.post('/change-plan', paymentController.changePlan);
router.post('/custom-inquiry', paymentController.submitCustomInquiry);
router.post('/paymongo-webhook', paymentController.handlePayMongoWebhook);
router.post('/user-subscription', paymentController.getUserSubscription);
router.get('/redirect/success', paymentController.renderSuccessPage);
router.get('/redirect/cancel', paymentController.renderCancelPage);

module.exports = router;
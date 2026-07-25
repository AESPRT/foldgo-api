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

router.post('/notify/bill', paymentController.sendInvoiceNotification);          // Bagong Bill / Invoice kay Tenant
router.post('/notify/reminder', paymentController.sendBillReminder);          // Payment Reminder kay Tenant
router.post('/notify/overdue', paymentController.sendOverdueNotice);          // Overdue Notice kay Tenant
router.post('/notify/confirmation', paymentController.sendPaymentConfirmation); // Payment Confirmation / Resibo kay Tenant
router.post('/notify/reading-request', paymentController.sendReadingRequestNotice);   // Hingi ng Meter Reading kay Tenant (Draft)
router.post('/notify/maintenance', paymentController.sendMaintenanceUpdate);    // Maintenance Update kay Tenant
router.post('/notify/landlord-payment', paymentController.notifyLandlordPayment); // Abiso kay Landlord na nagbayad na ang tenant
router.post('/notify/sms', paymentController.sendSmsNotification);

module.exports = router;
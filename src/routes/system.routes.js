const express = require('express');
const router = express.Router();
const systemController = require('../controllers/system.controller');

// Operations Routes mapping to /v1/laundry/*
router.get('/subscription/:userId', systemController.getSubscriptionState);
router.post('/login', systemController.loginOperator);
// Shop management and sync
router.post('/shops', systemController.createShop);
router.post('/shops/login', systemController.shopLogin);
router.get('/shops/sync', systemController.syncByShop);
router.post('/shops/upsert', systemController.upsertShopData);

module.exports = router;
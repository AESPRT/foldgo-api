const express = require('express');
const router = express.Router();
const systemController = require('../controllers/system.controller');

// Operations Routes mapping to /v1/laundry/*
router.get('/subscription/:userId', systemController.getSubscriptionState);
router.post('/login', systemController.loginOperator);

module.exports = router;
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const systemRoutes = require('./src/routes/system.routes');
const paymentRoutes = require('./src/routes/payment.routes');
const paupahanPaymentRoutes = require('./src/routes/paupahan.payment.routes');

const app = express();
const port = process.env.PORT || 3000;

// 1. Configure Allowed Origins
const allowedOrigins = [
    'https://aesprt.com',
    'https://fold-go.aesprt.com',
    'https://api.aesprt.com',
    'http://localhost:3060',
    'http://localhost:3000',
    'https://paupahan.aesprt.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.error(`🛑 Blocked by CORS: ${origin}`);
            callback(new Error('Blocked by CORS policy'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Capture raw buffers across payment networks to accurately verify signature hashes
app.use(express.json({
    verify: (req, res, buf) => {
        if (req.originalUrl.startsWith('/v1/payments/paymongo-webhook')) {
            req.rawBody = buf;
        }
    }
}));

// 2. BEARER TOKEN AUTHENTICATION MIDDLEWARE
const verifyBearerToken = (req, res, next) => {
    // Huwag i-lock ang Root Health Check o kaya ay ang mga Webhooks na galing sa labas (tulad ng PayMongo)
    if (req.path === '/' || req.originalUrl.includes('webhook')) {
        return next();
    }

    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized: Walang ibinigay na Bearer Token."
        });
    }

    const token = authHeader.split(' ')[1];
    const expectedToken = process.env.API_SECRET_TOKEN;

    if (token !== expectedToken) {
        console.error(`🛑 Invalid Token Attempt: ${token}`);
        return res.status(403).json({
            success: false,
            error: "Forbidden: Mali ang token na ginamit."
        });
    }

    // Kung tugma, ituloy ang request sa API route
    next();
};

// I-apply ang middleware sa lahat ng /v1 routes
app.use('/v1', verifyBearerToken);

// Health Check Endpoint (Hindi saklaw ng token)
app.get('/', (req, res) => {
    res.status(200).json({
        status: "success",
        message: "FoldGo API is live and healthy"
    });
});

// Mount Separated Application Modules
app.use('/v1/laundry', systemRoutes);
app.use('/v1/payments', paymentRoutes);
app.use('/v1/paupahan-payments', paupahanPaymentRoutes);

app.listen(port, () => {
    console.log(`🚀 Fold&Go cluster online and listening on port ${port}`);
});
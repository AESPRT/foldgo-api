const express = require('express');
const cors = require('cors'); // 1. Import the cors middleware
require('dotenv').config();

const systemRoutes = require('./src/routes/system.routes');
const paymentRoutes = require('./src/routes/payment.routes');

const app = express();
const port = process.env.PORT || 3000;

// 2. Configure Allowed Origins
const allowedOrigins = [
    'https://aesprt.com',          // Base landing page domain
    'https://fold-go.aesprt.com',  // Subdomain variant if used
    'https://api.aesprt.com',      // API domain fallback
    'http://localhost:3060',       // Your landing page Docker host port configuration
    'http://localhost:3000'        // Standard local development port
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow server-to-server requests or tools like Postman (which don't send an Origin header)
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            // Log the blocked origin to your docker logs so you can see exactly what domain failed
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

// Health Check Endpoint
app.get('/', (req, res) => {
    res.status(200).json({
        status: "success",
        message: "FoldGo API is live and healthy"
    });
});

// Mount Separated Application Modules
app.use('/v1/laundry', systemRoutes);
app.use('/v1/payments', paymentRoutes);

app.listen(port, () => {
    console.log(`🚀 Fold&Go cluster online and listening on port ${port}`);
});
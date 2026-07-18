const express = require('express');
require('dotenv').config();

const systemRoutes = require('./src/routes/system.routes');
const paymentRoutes = require('./src/routes/payment.routes');

const app = express();
const port = process.env.PORT || 3000;

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
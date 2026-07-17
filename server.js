const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize PostgreSQL Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

app.get('/', (req, res) => {
    res.status(200).json({
        status: "success",
        message: "FoldGo API is live and healthy"
    });
});

// Capture raw body to accurately verify PayMongo's signature hashes [source: 1]
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Helper to encode API keys for Authorization header basic auth [source: 1]
const getAuthHeader = () => {
    const key = process.env.PAYMONGO_SECRET_KEY;
    return `Basic ${Buffer.from(key + ':').toString('base64')}`;
};

/**
 * Endpoint 1: Generate Checkout Session
 * Mobilizes Checkout session request and delivers back the checkout URL [source: 1].
 */
app.post('/v1/payments/checkout', async (req, res) => {
    const { userId, packageId, amount, smsQty, cusEmail, cusName, cusPhone } = req.body;

    let amountInCents = amount ? Math.round(parseFloat(amount) * 100) : 50000;
    let finalSmsQty = smsQty ? parseInt(smsQty, 10) : 1000;

    const referenceNumber = `TXN-SMS-${Date.now()}`;

    const host = req.get('host');
    const protocol = req.protocol; // http or https
    const baseUrl = `${protocol}://${host}`;

    // Payload formatted to PayMongo requirements [source: 1]
    const payload = {
        data: {
            attributes: {
                billing: {
                    email: cusEmail || "customer@foldandgo.ph",
                    name: cusName || "Fold and Go User",
                    phone: cusPhone || "+639171234567"
                },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                cancel_url: `${baseUrl}/v1/payments/redirect/cancel?ref=${referenceNumber}`, //[cite: 1]
                success_url: `${baseUrl}/v1/payments/redirect/success?ref=${referenceNumber}`, //[cite: 1]
                description: "Fold&Go SMS Package Top-up", // [source: 1]
                line_items: [
                    {
                        amount: amountInCents,
                        currency: "PHP",
                        name: `${finalSmsQty.toLocaleString()} SMS Credits Bundle`,
                        quantity: 1
                    }
                ],
                payment_method_types: ["gcash", "paymaya", "qrph"], // [source: 1]
                reference_number: referenceNumber, // [source: 1]
                metadata: {
                    user_id: userId, // [source: 1]
                    sms_credit_qty: smsQty.toString() // [source: 1]
                }
            }
        }
    };

    try {
        // Create order trace in PostgreSQL
        await pool.query(
            `INSERT INTO fold_and_go_transactions (reference_number, user_id, sms_credit_qty, amount, payment_status) 
             VALUES ($1, $2, $3, $4, 'PENDING')`,
            [referenceNumber, userId, smsQty, (amountInCents / 100)]
        );

        // Forward payment session generation to PayMongo [source: 1]
        const response = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
            method: 'POST',
            headers: {
                'Authorization': getAuthHeader(), // [source: 1]
                'Content-Type': 'application/json' // [source: 1]
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.errors?.[0]?.detail || 'Failed to create payment session');
        }

        // Return payment redirect target back to your Android app client [source: 1]
        const checkoutUrl = result.data.attributes.checkout_url;
        res.status(200).json({
            checkoutUrl, // [source: 1]
            referenceNumber // [source: 1]
        });

    } catch (error) {
        console.error('Error initiating checkout session:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

/**
 * Endpoint 2: PayMongo Secure Webhook Receiver
 * Handles secure execution of payment verification and provisioning [source: 1].
 */
app.post('/v1/payments/paymongo-webhook', async (req, res) => {
    const signature = req.headers['paymongo-signature']; // [source: 1]

    // 1. Verify Request Signature to guarantee source security [source: 1]
    if (!signature) return res.status(400).send('Missing signature'); // [source: 1]

    const parts = signature.split(','); // [source: 1]
    const timestamp = parts[0].split('=')[1]; // [source: 1]
    const originalSignature = parts[1].split('=')[1]; // [source: 1]

    // Grab the verified raw buffered request string [source: 1]
    const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
    const dataToSign = `${timestamp}.${rawBody}`; // [source: 1]

    const computedSignature = crypto
        .createHmac('sha256', process.env.PAYMONGO_WH_SECRET) // [source: 1]
        .update(dataToSign) // [source: 1]
        .digest('hex'); // [source: 1]

    if (computedSignature !== originalSignature) { // [source: 1]
        return res.status(401).send('Signature mismatch verification failed'); // [source: 1]
    }

    // 2. Process Valid Payload [source: 1]
    const event = req.body.data; // [source: 1]
    if (event.attributes.type === 'checkout_session.payment.paid') { // [source: 1]
        const sessionObj = event.attributes.data.attributes; // [source: 1]
        const referenceNumber = sessionObj.reference_number; // [source: 1]
        const userId = sessionObj.metadata.user_id; // [source: 1]
        const smsVolume = parseInt(sessionObj.metadata.sms_credit_qty, 10); // [source: 1]

        try {
            // Idempotency: Verify your DB does not possess this referenceNumber as already success/fulfilled [source: 1]
            const checkQuery = `SELECT payment_status FROM fold_and_go_transactions WHERE reference_number = $1`;
            const checkRes = await pool.query(checkQuery, [referenceNumber]);

            if (checkRes.rows.length > 0 && checkRes.rows[0].payment_status === 'SUCCESS') {
                return res.status(200).send({ status: 'already_fulfilled' });
            }

            // Begin Postgres Transaction to safely commit state changes
            await pool.query('BEGIN');

            // Allocate SMS Credits within DB user model 
            const updateBalanceQuery = `
                UPDATE users 
                SET sms_credits = COALESCE(sms_credits, 0) + $1 
                WHERE id = $2
            `;
            await pool.query(updateBalanceQuery, [smsVolume, userId]);

            // Update Fold&Go application transaction status [source: 1]
            const updateTxnQuery = `
                UPDATE fold_and_go_transactions 
                SET payment_status = 'SUCCESS', updated_at = NOW() 
                WHERE reference_number = $1
            `;
            await pool.query(updateTxnQuery, [referenceNumber]);

            await pool.query('COMMIT');

            console.log(`Successfully credited ${smsVolume} SMS to User ${userId}`);
            return res.status(200).send({ status: 'fulfilled' }); // [source: 1]

        } catch (dbError) {
            await pool.query('ROLLBACK');
            console.error('Database transaction failure:', dbError); // [source: 1]
            return res.status(500).send('Fulfillment pipeline stalled'); // [source: 1]
        }
    }

    res.status(400).send('Event unhandled'); // [source: 1]
});

/**
 * Endpoint 3: Success Landing Page
 * Handles successful redirects when a user completes their payment.
 */
app.get('/v1/payments/redirect/success', async (req, res) => {
    const { ref } = req.query;

    // Optional: Query the DB to check if the transaction is already marked SUCCESS
    let transactionStatus = 'processing';
    try {
        const checkQuery = `SELECT payment_status FROM fold_and_go_transactions WHERE reference_number = $1`;
        const result = await pool.query(checkQuery, [ref]);
        if (result.rows.length > 0) {
            transactionStatus = result.rows[0].payment_status.toLowerCase();
        }
    } catch (err) {
        console.error('Error fetching status for success page:', err);
    }

    // You can serve an elegant landing page or redirect to your Android app via a deep link
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Successful</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 50px; background-color: #f7f9fa; }
                .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; max-width: 400px; width: 100%; }
                h1 { color: #2ecc71; margin-bottom: 10px; }
                p { color: #555; line-height: 1.5; }
                .btn { display: inline-block; margin-top: 20px; padding: 12px 24px; background-color: #3498db; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🎉 Thank You!</h1>
                <p>Your payment for Reference <strong>${ref || 'N/A'}</strong> was successful.</p>
                <p>We are updating your Fold&Go SMS credits now. You can safely close this tab and return to the app.</p>
                <!-- Deep link back to your Android App if applicable -->
                <a href="foldandgo://payment/success?ref=${ref}" class="btn">Back to Fold&Go</a>
            </div>
        </body>
        </html>
    `);
});

/**
 * Endpoint 4: Cancel Landing Page
 * Handles gracefully when a user explicitly exits the checkout session.
 */
app.get('/v1/payments/redirect/cancel', async (req, res) => {
    const { ref } = req.query;

    try {
        // Mark the transaction as CANCELLED in your database
        const updateTxnQuery = `
            UPDATE fold_and_go_transactions 
            SET payment_status = 'CANCELLED', updated_at = NOW() 
            WHERE reference_number = $1 AND payment_status = 'PENDING'
        `;
        await pool.query(updateTxnQuery, [ref]);
    } catch (err) {
        console.error('Error updating status for cancelled transaction:', err);
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Cancelled</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 50px; background-color: #f7f9fa; }
                .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; max-width: 400px; width: 100%; }
                h1 { color: #e74c3c; margin-bottom: 10px; }
                p { color: #555; line-height: 1.5; }
                .btn { display: inline-block; margin-top: 20px; padding: 12px 24px; background-color: #7f8c8d; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Payment Cancelled</h1>
                <p>The transaction (Ref: <strong>${ref || 'N/A'}</strong>) was not completed.</p>
                <p>No charges were made. You can try again whenever you are ready.</p>
                <!-- Deep link back to your Android App if applicable -->
                <a href="foldandgo://payment/cancel?ref=${ref}" class="btn">Return to App</a>
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`🚀 Fold&Go server online and listening on port ${port}`);
});
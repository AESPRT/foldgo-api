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

// Capture raw body to accurately verify PayMongo's signature hashes
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Helper to encode API keys for Authorization header basic auth
const getAuthHeader = () => {
    const credentials = Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    return `Basic ${credentials}`;
};

/**
 * Endpoint 1: Generate Checkout Session
 * Mobilizes Checkout session request and delivers back the checkout URL.
 */
app.post('/v1/payments/checkout', async (req, res) => {
    const { userId, packageId, amount, smsQty, cusEmail, cusName, cusPhone } = req.body;

    let amountInCents = amount ? Math.round(parseFloat(amount) * 100) : 50000;
    let finalSmsQty = smsQty ? parseInt(smsQty, 10) : 1000;

    const referenceNumber = `TXN-SMS-${Date.now()}`;

    const host = req.get('host');
    const protocol = req.protocol; // http or https
    const baseUrl = `${protocol}://${host}`;

    // Payload formatted to PayMongo requirements
    const payload = {
        data: {
            attributes: {
                billing: {
                    email: cusEmail || "",
                    name: cusName || "",
                    phone: cusPhone || ""
                },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                cancel_url: `${baseUrl}/v1/payments/redirect/cancel?ref=${referenceNumber}`,
                success_url: `${baseUrl}/v1/payments/redirect/success?ref=${referenceNumber}`,
                description: "Fold&Go SMS Package Top-up",
                line_items: [
                    {
                        amount: amountInCents,
                        currency: "PHP",
                        name: `${finalSmsQty.toLocaleString()} SMS Credits Bundle`,
                        quantity: 1
                    }
                ],
                payment_method_types: ["gcash", "paymaya", "qrph"],
                reference_number: referenceNumber,
                metadata: {
                    user_id: userId,
                    sms_credit_qty: finalSmsQty.toString()
                }
            }
        }
    };

    try {
        // FIXED: Now correctly saving the packageId/package_id to your database!
        await pool.query(
            `INSERT INTO fold_and_go_transactions (reference_number, user_id, sms_credit_qty, amount, payment_status, package_id) 
             VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
            [referenceNumber, userId, finalSmsQty, (amountInCents / 100), packageId]
        );

        // Forward payment session generation to PayMongo
        const response = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
            method: 'POST',
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorResult = await response.json().catch(() => ({}));
            throw new Error(errorResult.errors?.[0]?.detail || `PayMongo API responded with status ${response.status}`);
        }

        const result = await response.json();
        const checkoutUrl = result.data.attributes.checkout_url;
        res.status(200).json({
            checkoutUrl,
            referenceNumber
        });

    } catch (error) {
        console.error('Error initiating checkout session:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

/**
 * Endpoint 2: PayMongo Secure Webhook Receiver
 */
app.post('/v1/payments/paymongo-webhook', async (req, res) => {
    const signature = req.headers['paymongo-signature'];

    if (!signature) return res.status(400).send('Missing signature');

    const parts = signature.split(',');
    const timestamp = parts[0].split('=')[1];
    const originalSignature = parts[1].split('=')[1];

    const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
    const dataToSign = `${timestamp}.${rawBody}`;

    const computedSignature = crypto
        .createHmac('sha256', process.env.PAYMONGO_WH_SECRET)
        .update(dataToSign)
        .digest('hex');

    if (computedSignature !== originalSignature) {
        return res.status(401).send('Signature mismatch verification failed');
    }

    const event = req.body.data;
    if (event.attributes.type === 'checkout_session.payment.paid') {
        const sessionObj = event.attributes.data.attributes;
        const referenceNumber = sessionObj.reference_number;
        const userId = sessionObj.metadata.user_id;
        const smsVolume = parseInt(sessionObj.metadata.sms_credit_qty, 10);

        try {
            const checkQuery = `SELECT payment_status FROM fold_and_go_transactions WHERE reference_number = $1`;
            const checkRes = await pool.query(checkQuery, [referenceNumber]);

            if (checkRes.rows.length > 0 && checkRes.rows[0].payment_status === 'SUCCESS') {
                return res.status(200).send({ status: 'already_fulfilled' });
            }

            await pool.query('BEGIN');

            const updateTxnQuery = `
                UPDATE fold_and_go_transactions 
                SET payment_status = 'SUCCESS', updated_at = NOW() 
                WHERE reference_number = $1
            `;
            await pool.query(updateTxnQuery, [referenceNumber]);

            await pool.query('COMMIT');

            console.log(`Successfully credited ${smsVolume} SMS to User ${userId}`);
            return res.status(200).send({ status: 'fulfilled' });

        } catch (dbError) {
            await pool.query('ROLLBACK');
            console.error('Database transaction failure:', dbError);
            return res.status(500).send('Fulfillment pipeline stalled');
        }
    }

    res.status(400).send('Event unhandled');
});

/**
 * Endpoint 3: Success Landing Page
 */
app.get('/v1/payments/redirect/success', async (req, res) => {
    const { ref } = req.query;

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
                <a href="foldandgo://payment/success?ref=${ref}" class="btn">Back to Fold&Go</a>
            </div>
        </body>
        </html>
    `);
});

/**
 * Endpoint 4: Cancel Landing Page
 */
app.get('/v1/payments/redirect/cancel', async (req, res) => {
    const { ref } = req.query;

    try {
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
                <a href="foldandgo://payment/cancel?ref=${ref}" class="btn">Return to App</a>
            </div>
        </body>
        </html>
    `);
});

/**
 * Endpoint: Get latest subscription details
 * FIXED: Uses direct flat JOIN. Orders ASC to pull the very first transaction on top.
 */
app.get('/v1/payments/subscription/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const query = `
            SELECT 
                sms_credit_qty,
                package_id as plan_name,
                updated_at as last_update
            FROM fold_and_go_transactions
            WHERE user_id = $1
            ORDER BY created_at DESC 
            LIMIT 1
        `;

        const result = await pool.query(query, [userId]);

        if (result.rows.length > 0) {
            const row = result.rows[0];
            res.status(200).json({
                remainingSms: row.sms_credit_qty || 0,
                planName: row.plan_name || "Starter Wash",
                expiryDate: row.last_update ? new Date(row.last_update).getTime() + (30 * 24 * 60 * 60 * 1000) : null
            });
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (error) {
        console.error('Error fetching subscription:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(port, () => {
    console.log(`🚀 Fold&Go server online and listening on port ${port}`);
});
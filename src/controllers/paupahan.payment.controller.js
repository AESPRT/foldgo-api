const axios = require('axios');

// Backend copy ng iyong mga plano para mag-match sa Prisma enum at paupahan system
const RENTAL_PLANS_BACKEND = {
    'panimula': { displayName: 'Silong', monthlyPrice: 0 },
    'bahay_upa': { displayName: 'Bahay-Upa', monthlyPrice: 199 },
    'maalam': { displayName: 'Pasilidad', monthlyPrice: 399 },
    'negosyante': { displayName: 'Kompleto', monthlyPrice: 799 },
    'custom': { displayName: 'Eksklusibo', monthlyPrice: 1500 }
};

exports.createCheckoutSession = async (req, res) => {
    const {
        userId,
        packageId,
        cycle,
        successUrl,
        cancelUrl,
        cusEmail,
        cusName,
        cusPhone
    } = req.body;

    if (!packageId || !userId) {
        return res.status(400).json({ error: "Missing required fields: userId and packageId are required." });
    }

    const plan = RENTAL_PLANS_BACKEND[packageId];
    if (!plan) {
        return res.status(400).json({ error: "Invalid packageId choice." });
    }

    if (plan.monthlyPrice === 0) {
        return res.status(400).json({ error: "Free plan (Silong) does not require a checkout session." });
    }

    const isAnnual = cycle === 'ANNUAL';
    const rawPrice = isAnnual ? (plan.monthlyPrice * 12 * 0.85) : plan.monthlyPrice;
    const amountInCents = Math.round(rawPrice * 100);
    const referenceNumber = `TXN-RENTAL-${Date.now()}`;
    const lineItemName = `Paupahan System - ${plan.displayName} Plan (${isAnnual ? 'Taunan / Annual' : 'Buwanan / Monthly'})`;

    const metadataBlock = {
        user_id: userId,
        type: "RENTAL_SUBSCRIPTION",
        package_id: packageId,
        billing_cycle: isAnnual ? "ANNUAL" : "MONTHLY",
        customer_email: cusEmail || "",
        customer_name: cusName || ""
    };

    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    const successRedirectQuery = successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '';
    const cancelRedirectQuery = cancelUrl ? `&cancelUrl=${encodeURIComponent(cancelUrl)}` : '';

    const payloadData = {
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
                // ITAMA ANG PATH: Ginawang /v1/paupahan-payments/redirect/success
                cancel_url: `${baseUrl}/v1/paupahan-payments/redirect/cancel?ref=${referenceNumber}${cancelRedirectQuery}`,
                success_url: `${baseUrl}/v1/paupahan-payments/redirect/success?ref=${referenceNumber}${successRedirectQuery}`,
                description: `Subscription activation for ${plan.displayName}`,
                line_items: [{
                    amount: amountInCents,
                    currency: "PHP",
                    name: lineItemName,
                    quantity: 1
                }],
                payment_method_types: ["gcash", "paymaya", "card", "qrph"],
                reference_number: referenceNumber,
                metadata: metadataBlock
            }
        }
    };

    try {
        const response = await axios.post('https://api.paymongo.com/v1/checkout_sessions', payloadData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`
            }
        });

        res.status(200).json({
            checkoutUrl: response.data.data.attributes.checkout_url,
            referenceNumber,
            amount: amountInCents / 100,
            metadata: metadataBlock
        });

    } catch (error) {
        console.error('PayMongo Checkout Error:', error.response?.data || error.message);
        res.status(500).json({
            error: error.response?.data?.errors?.[0]?.detail || 'Internal server error while creating rental checkout session.'
        });
    }
};

exports.handlePayMongoWebhook = async (req, res) => {
    const event = req.body;

    try {
        const eventType = event?.data?.attributes?.type;

        if (eventType === 'checkout_session.payment.paid') {
            const checkoutSession = event.data.attributes.data;
            const attributes = checkoutSession.attributes;
            const metadata = attributes.metadata;

            const referenceNumber = attributes.reference_number;
            const amountPaidInCents = attributes.amount_paid || attributes.payments?.[0]?.attributes?.amount || 0;
            const amountPaid = amountPaidInCents / 100;
            const { user_id, package_id, billing_cycle } = metadata;

            await pool.query(
                `INSERT INTO fold_and_go_transactions (reference_number, user_id, amount, payment_status, package_id) 
                 VALUES ($1, $2, $3, 'SUCCESS', $4)
                 ON CONFLICT (reference_number) DO UPDATE SET payment_status = 'SUCCESS'`,
                [referenceNumber, user_id, amountPaid, package_id]
            );

            const durationMonths = billing_cycle === 'ANNUAL' ? 12 : 1;
            const expiresAt = new Date();
            expiresAt.setMonth(expiresAt.getMonth() + durationMonths);

            const subscriptionId = `SUB-${Date.now()}`;

            await pool.query(
                `INSERT INTO rental_subscriptions (subscription_id, user_id, package_id, billing_cycle, status, reference_number, amount_paid, expires_at, updated_at) 
                 VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id) DO UPDATE 
                 SET package_id = EXCLUDED.package_id,
                     billing_cycle = EXCLUDED.billing_cycle,
                     status = 'ACTIVE',
                     reference_number = EXCLUDED.reference_number,
                     amount_paid = EXCLUDED.amount_paid,
                     expires_at = EXCLUDED.expires_at,
                     updated_at = CURRENT_TIMESTAMP`,
                [subscriptionId, user_id, package_id, billing_cycle, referenceNumber, amountPaid, expiresAt]
            );
        }

        res.status(200).json({ received: true });

    } catch (error) {
        console.error('Webhook processing error:', error.message);
        res.status(500).json({ error: 'Webhook handler failed.' });
    }
};

exports.getUserSubscription = async (req, res) => {
    const { userId } = req.query;

    try {
        const result = await pool.query(
            `SELECT * FROM rental_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(200).json({ hasActiveSub: false, packageId: 'panimula' });
        }

        res.status(200).json({
            hasActiveSub: true,
            subscription: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: "Server error fetching subscription." });
    }
};

exports.renderSuccessPage = async (req, res) => {
    const { ref, successUrl } = req.query;

    if (ref && ref.startsWith('TXN-RENTAL-')) {
        // I-decode ang successUrl kung meron man para mabasa nang tama ang localhost/domain at query params
        let targetUrl = `${req.protocol}://${req.get('host')}/admin/register`;

        if (successUrl) {
            targetUrl = decodeURIComponent(successUrl);
        }

        const separator = targetUrl.includes('?') ? '&' : '?';
        return res.redirect(`${targetUrl}${separator}referenceNumber=${encodeURIComponent(ref)}&success=true`);
    }

    res.send(`
        <html>
            <body style="background:#0F172A;color:white;text-align:center;padding:50px;font-family:sans-serif;">
                <h1>✓ Tagumpay ang Pagbabayad!</h1>
                <p>Reference Number: <b>${ref}</b></p>
                <p>Maaari mo nang isara ang window na ito o magpatuloy sa paggawa ng account.</p>
            </body>
        </html>
    `);
};

exports.renderCancelPage = async (req, res) => {
    res.send(`<html><body style="background:#0F172A;color:white;text-align:center;padding:50px;"><h1>✕ Payment Cancelled</h1></body></html>`);
};
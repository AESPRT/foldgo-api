const axios = require('axios');
const nodemailer = require('nodemailer');

// Backend copy ng iyong mga plano para mag-match sa Prisma enum at paupahan system
const RENTAL_PLANS_BACKEND = {
    'panimula': { displayName: 'Silong', monthlyPrice: 0 },
    'bahay_upa': { displayName: 'Bahay-Upa', monthlyPrice: 199 },
    'maalam': { displayName: 'Pasilidad', monthlyPrice: 399 },
    'negosyante': { displayName: 'Kompleto', monthlyPrice: 799 },
    'custom': { displayName: 'Eksklusibo', monthlyPrice: 1500 }
};

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        get user() { return process.env.EMAIL_USER || process.env.MAIL_USER; },
        get pass() { return process.env.EMAIL_PASS || process.env.MAIL_PASS; }
    },
    tls: { rejectUnauthorized: false }
});

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

    // Ibinubukas natin ang successUrl at isasama ang customer info bilang query parameters
    let successRedirectQuery = successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '';
    if (cusName) successRedirectQuery += `&name=${encodeURIComponent(cusName)}`;
    if (cusEmail) successRedirectQuery += `&email=${encodeURIComponent(cusEmail)}`;
    if (cusPhone) successRedirectQuery += `&phone=${encodeURIComponent(cusPhone)}`;

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
    const { referenceNumber } = req.query;

    try {
        const result = await pool.query(
            `SELECT * FROM rental_subscriptions WHERE reference_number = $1 ORDER BY created_at DESC LIMIT 1`,
            [referenceNumber]
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
    const { ref, successUrl, name, email, phone } = req.query;

    if (ref && ref.startsWith('TXN-RENTAL-')) {
        let targetUrl = `${req.protocol}://${req.get('host')}/admin/register`;

        if (successUrl) {
            targetUrl = decodeURIComponent(successUrl);
        }

        const separator = targetUrl.includes('?') ? '&' : '?';

        // Ipinapasa natin ang referenceNumber pati na ang name, email, at phone patungo sa frontend registration page
        let redirectParams = `${separator}referenceNumber=${encodeURIComponent(ref)}&success=true`;
        if (name) redirectParams += `&name=${encodeURIComponent(name)}`;
        if (email) redirectParams += `&email=${encodeURIComponent(email)}`;
        if (phone) redirectParams += `&phone=${encodeURIComponent(phone)}`;

        return res.redirect(`${targetUrl}${redirectParams}`);
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

//change plan
exports.changePlan = async (req, res) => {
    const { userId, planId, cycle, successUrl, cancelUrl, cusEmail, cusName, cusPhone } = req.body;

    if (!userId || !planId) {
        return res.status(400).json({ error: "Kailangan ang userId at planId." });
    }

    const planKey = planId.toLowerCase();
    const plan = RENTAL_PLANS_BACKEND[planKey];

    if (!plan) {
        return res.status(400).json({ error: "Hindi wastong plan ID." });
    }

    try {
        // 1. KUNG LIBRE ANG PLAN (hal. Silong / 0 price)
        if (plan.monthlyPrice === 0) {
            const subscriptionId = `SUB-FREE-${Date.now()}`;
            const expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 100);

            await pool.query(
                `INSERT INTO rental_subscriptions (subscription_id, user_id, package_id, billing_cycle, status, amount_paid, expires_at, updated_at) 
                 VALUES ($1, $2, $3, 'MONTHLY', 'ACTIVE', 0, $4, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id) DO UPDATE 
                 SET package_id = EXCLUDED.package_id,
                     billing_cycle = 'MONTHLY',
                     status = 'ACTIVE',
                     amount_paid = 0,
                     expires_at = EXCLUDED.expires_at,
                     updated_at = CURRENT_TIMESTAMP`,
                [subscriptionId, userId, planKey, expiresAt]
            );

            return res.status(200).json({
                success: true,
                message: `Matagumpay na nailipat ang iyong account sa ${plan.displayName}.`
            });
        }

        // 2. KUNG MAY BAYAD ANG PLAN — Gumamit ng PayMongo Checkout (Kailangan ang Webhook, Success/Cancel URLs)
        const isAnnual = cycle === 'ANNUAL';
        const rawPrice = isAnnual ? (plan.monthlyPrice * 12 * 0.85) : plan.monthlyPrice;
        const amountInCents = Math.round(rawPrice * 100);
        const referenceNumber = `TXN-RENTAL-${Date.now()}`;
        const lineItemName = `Paupahan System - ${plan.displayName} Plan (${isAnnual ? 'Taunan / Annual' : 'Buwanan / Monthly'})`;

        const metadataBlock = {
            user_id: userId,
            type: "RENTAL_SUBSCRIPTION",
            package_id: planKey,
            billing_cycle: isAnnual ? "ANNUAL" : "MONTHLY",
            customer_email: cusEmail || "",
            customer_name: cusName || ""
        };

        const host = req.get('host');
        const protocol = req.protocol;
        const baseUrl = `${protocol}://${host}`;

        let successRedirectQuery = successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '';
        if (cusName) successRedirectQuery += `&name=${encodeURIComponent(cusName)}`;
        if (cusEmail) successRedirectQuery += `&email=${encodeURIComponent(cusEmail)}`;
        if (cusPhone) successRedirectQuery += `&phone=${encodeURIComponent(cusPhone)}`;

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
                    cancel_url: `${baseUrl}/v1/paupahan-payments/redirect/cancel?ref=${referenceNumber}${cancelRedirectQuery}`,
                    success_url: `${baseUrl}/v1/paupahan-payments/redirect/success?ref=${referenceNumber}${successRedirectQuery}`,
                    description: `Subscription upgrade for ${plan.displayName}`,
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

        const response = await axios.post('https://api.paymongo.com/v1/checkout_sessions', payloadData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`
            }
        });

        // Ibinabalik ang checkoutUrl para magamit ng frontend sa pag-redirect sa PayMongo
        return res.status(200).json({
            success: true,
            checkoutUrl: response.data.data.attributes.checkout_url,
            referenceNumber
        });

    } catch (error) {
        console.error('Change Plan & Checkout Error:', error.response?.data || error.message);
        res.status(500).json({
            error: error.response?.data?.errors?.[0]?.detail || 'May nangyaring error sa pag-proseso ng plano.'
        });
    }
};

exports.submitCustomInquiry = async (req, res) => {
    const { name, email, message, planType } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ error: "Kailangan ang pangalan, email, at mensahe." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;
        const planDisplayName = RENTAL_PLANS_BACKEND[planType?.toLowerCase()]?.displayName || planType || 'Eksklusibo / Custom';

        // Pagsasagawa ng email notification para sa admin
        await mailTransporter.sendMail({
            from: `"Paupahan System Notifications" <${adminEmail}>`,
            to: adminEmail, // Isinusugo sa sarili mong email galing sa .env
            subject: `[Paupahan Inquiry] Bagong Mensahe mula kay ${name} (${planDisplayName})`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px;">
                    <h2 style="color: #38BDF8; margin-top: 0;">May Bagong Custom Inquiry!</h2>
                    <p style="color: #94A3B8; font-size: 14px;">May nag-sumite ng katanungan mula sa landing/pricing page ng Paupahan System.</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0;"><strong>Pangalan:</strong> ${name}</p>
                        <p style="margin: 6px 0;"><strong>Email ng Nag-inquire:</strong> <a href="mailto:${email}" style="color: #38BDF8;">${email}</a></p>
                        <p style="margin: 6px 0;"><strong>Napiling Plano:</strong> ${planDisplayName}</p>
                    </div>

                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 0 0 8px 0; color: #94A3B8; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Mensahe:</p>
                        <p style="margin: 0; white-space: pre-wrap; line-height: 1.5;">${message}</p>
                    </div>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Maaari mong direktang i-reply ang email na ito para makipag-ugnayan sa kliyente.
                    </p>
                </div>
            `
        });

        console.log(`✅ Naipadala ang Custom Inquiry email kay ${adminEmail} mula kay ${name} (${email})`);

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang iyong katanungan. Makikipag-ugnayan kami sa iyo sa lalong madaling panahon."
        });

    } catch (error) {
        console.error('Custom Inquiry Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng katanungan. Subukan muli mamaya.'
        });
    }
};
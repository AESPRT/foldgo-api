const pool = require('../config/database');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const getAuthHeader = () => {
    const credentials = Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    return `Basic ${credentials}`;
};

const PLAN_LIMITS = {
    'plan-basic': { name: 'Standard Hub', monthlyPrice: 1499, annuallyPricePerMonth: 1199 },
    'plan-premium': { name: 'Enterprise Loop', monthlyPrice: 3499, annuallyPricePerMonth: 2799 }
};

exports.createCheckoutSession = async (req, res) => {
    const { userId, packageId, amount, smsQty, cusEmail, cusName, cusPhone, type, cycle, sessionToken, successUrl, cancelUrl } = req.body;
    const isSaaS = type === 'SAAS';

    let lineItemName = "";
    let amountInCents = 0;
    let referenceNumber = "";
    let metadataBlock = {};

    if (isSaaS) {
        const plan = PLAN_LIMITS[packageId];
        if (!plan) return res.status(400).json({ error: "Invalid packageId choice." });

        const isAnnual = cycle === 'ANNUAL';
        const rawPrice = isAnnual ? (plan.annuallyPricePerMonth * 12) : plan.monthlyPrice;

        amountInCents = Math.round(rawPrice * 100);
        referenceNumber = `TXN-SUB-${Date.now()}`;
        lineItemName = `FoldGo ${plan.name} Package (${cycle})`;

        metadataBlock = {
            user_id: userId || `GUEST-${Date.now()}`,
            type: "SAAS",
            package_id: packageId,
            billing_cycle: cycle || "MONTHLY",
            session_token: sessionToken || ""
        };
    } else {
        let finalSmsQty = smsQty ? parseInt(smsQty, 10) : 1000;
        amountInCents = amount ? Math.round(parseFloat(amount) * 100) : 50000;
        referenceNumber = `TXN-SMS-${Date.now()}`;
        lineItemName = `${finalSmsQty.toLocaleString()} SMS Credits Bundle`;

        metadataBlock = {
            user_id: userId,
            type: "SMS",
            sms_credit_qty: finalSmsQty.toString(),
            session_token: sessionToken || ""
        };
    }

    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    const payload = {
        data: {
            attributes: {
                billing: { email: cusEmail || "", name: cusName || "", phone: cusPhone || "" },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                cancel_url: `${baseUrl}/v1/payments/redirect/cancel?ref=${referenceNumber}`,
                success_url: `${baseUrl}/v1/payments/redirect/success?ref=${referenceNumber}`,
                description: isSaaS ? "Fold&Go Business Tier Activation" : "Fold&Go SMS Package Top-up",
                line_items: [{ amount: amountInCents, currency: "PHP", name: lineItemName, quantity: 1 }],
                payment_method_types: ["gcash", "paymaya", "card", "qrph"],
                reference_number: referenceNumber,
                metadata: metadataBlock
            }
        }
    };

    try {
        await pool.query(
            `INSERT INTO fold_and_go_transactions (reference_number, user_id, sms_credit_qty, amount, payment_status, package_id) 
             VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
            [referenceNumber, metadataBlock.user_id, isSaaS ? 0 : parseInt(metadataBlock.sms_credit_qty, 10), (amountInCents / 100), packageId]
        );

        const response = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
            method: 'POST',
            headers: { 'Authorization': getAuthHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorResult = await response.json().catch(() => ({}));
            throw new Error(errorResult.errors?.[0]?.detail || `Status ${response.status}`);
        }

        const result = await response.json();
        res.status(200).json({ checkoutUrl: result.data.attributes.checkout_url, referenceNumber });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

exports.handleWebhookFulfillment = async (req, res) => {
    const signature = req.headers['paymongo-signature'];
    if (!signature) return res.status(400).send('Missing signature');

    const parts = signature.split(',');
    const timestamp = parts[0].split('=')[1];
    const originalSignature = parts[1].split('=')[1];

    const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
    const dataToSign = `${timestamp}.${rawBody}`;

    const computedSignature = crypto.createHmac('sha256', process.env.PAYMONGO_WH_SECRET).update(dataToSign).digest('hex');
    if (computedSignature !== originalSignature) return res.status(401).send('Signature mismatch');

    const event = req.body.data;
    if (event.attributes.type === 'checkout_session.payment.paid') {
        const sessionObj = event.attributes.data.attributes;
        const referenceNumber = sessionObj.reference_number;
        const txType = sessionObj.metadata.type || "SMS";

        try {
            const checkRes = await pool.query(`SELECT payment_status FROM fold_and_go_transactions WHERE reference_number = $1`, [referenceNumber]);
            if (checkRes.rows.length > 0 && checkRes.rows[0].payment_status === 'SUCCESS') {
                return res.status(200).send({ status: 'already_fulfilled' });
            }

            await pool.query('BEGIN');
            await pool.query(`UPDATE fold_and_go_transactions SET payment_status = 'SUCCESS', updated_at = NOW() WHERE reference_number = $1`, [referenceNumber]);

            if (txType === 'SAAS') {
                const packageId = sessionObj.metadata.package_id;
                const billingCycle = sessionObj.metadata.billing_cycle;
                const clientEmail = sessionObj.billing?.email || "";
                const clientName = sessionObj.billing?.name || "FoldGo Partner";
                const clientPhone = sessionObj.billing?.phone || "";

                const generatedPassword = crypto.randomBytes(6).toString('hex') + '!Fg';
                const passwordHash = await bcrypt.hash(generatedPassword, 12);

                await pool.query(
                    `INSERT INTO fold_go_operators (reference_number, name, email, phone, password_hash, plan_id, billing_cycle)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
                    [referenceNumber, clientName, clientEmail, clientPhone, passwordHash, packageId, billingCycle]
                );

                const dashboardUrl = "https://fold-go.aesprt.com/ordering";
                const sessionToken = sessionObj.metadata.session_token || "";
                const downloadPageUrl = `https://fold-go.aesprt.com/download/apk/`;

                await mailTransporter.sendMail({
                    from: `"Fold&Go Operations" <${process.env.EMAIL_USER}>`,
                    to: clientEmail,
                    subject: `[Fold&Go] Your Admin Account Credentials`,
                    html: `<div style="font-family: sans-serif; max-width: 600px; padding: 20px; background: #0F172A; color: #F8FAFC; border-radius:16px;">
                            <h2>Welcome ${clientName}!</h2>
                            <p><strong>Username:</strong> ${clientEmail}</p>
                            <p><strong>Temporary Password:</strong> ${generatedPassword}</p>
                            <p><a href="${dashboardUrl}">Go to Dashboard</a> | <a href="${downloadPageUrl}">Download APK Build</a></p>
                           </div>`
                });
            }
            await pool.query('COMMIT');
            return res.status(200).send({ status: 'fulfilled' });
        } catch (dbError) {
            await pool.query('ROLLBACK');
            return res.status(500).send('Pipeline stalled');
        }
    }
    res.status(400).send('Unhandled Event');
};

exports.verifyOnboardingToken = async (req, res) => {
    const { referenceNumber } = req.query;
    try {
        const query = `
            SELECT o.email, o.plan_id, t.payment_status FROM fold_go_operators o
            JOIN fold_and_go_transactions t ON o.reference_number = t.reference_number WHERE o.reference_number = $1
        `;
        const result = await pool.query(query, [referenceNumber]);
        if (result.rows.length === 0) return res.status(444).json({ error: "Record missing." });

        const operator = result.rows[0];
        if (operator.payment_status !== 'SUCCESS') return res.status(402).json({ error: "Unpaid status." });

        const secureApkToken = crypto.createHash('md5').update(`${referenceNumber}_secret`).digest('hex');
        res.status(200).json({
            adminDashboardUrl: "https://fold-go.aesprt.com/admin-dashboard",
            adminUsername: operator.email,
            adminInitialPassword: "[Sent via Email]",
            planId: operator.plan_id,
            secureApkToken: `apk_delivery_${secureApkToken}`
        });
    } catch (err) {
        res.status(500).json({ error: 'Server read error.' });
    }
};

exports.renderSuccessPage = async (req, res) => {
    const { ref, successUrl } = req.query;
    if (ref && ref.startsWith('TXN-SUB-')) return res.redirect(`${successUrl}`);

    res.send(`<html><body style="background:#0F172A;color:white;text-align:center;padding:50px;"><h1>✓ Payment Successful</h1><p>Reference: ${ref}</p></body></html>`);
};

exports.renderCancelPage = async (req, res) => {
    const { ref, cancelUrl } = req.query;
    try { await pool.query(`UPDATE fold_and_go_transactions SET payment_status = 'CANCELLED' WHERE reference_number = $1 AND payment_status = 'PENDING'`, [ref]); } catch (e) { }
    if (ref && ref.startsWith('TXN-SUB-')) return res.redirect(`${cancelUrl}`);

    res.send(`<html><body style="background:#0F172A;color:white;text-align:center;padding:50px;"><h1>✕ Payment Cancelled</h1></body></html>`);
};
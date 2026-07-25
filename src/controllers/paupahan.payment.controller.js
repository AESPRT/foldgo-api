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

const getSmsGatewayEmail = (phoneNumber, carrier) => {
    // Linisin ang numero (siguraduhing nagsisimula sa 09 o +63)
    let cleanNumber = phoneNumber.replace(/\D/g, '');
    if (cleanNumber.startsWith('63')) {
        cleanNumber = '0' + cleanNumber.slice(2);
    }

    // Alisin ang '0' sa unahan para maging 10-digets (hal. 9171234567)
    if (cleanNumber.startsWith('0')) {
        cleanNumber = cleanNumber.slice(1);
    }

    // Mga sikat na Email-to-SMS domains ng mga telco sa Pilipinas at international gateways
    switch (carrier?.toLowerCase()) {
        case 'globe':
        case 'tm':
            return `${cleanNumber}@txt.globe.com.ph`; // O kaya ay gamitin ang SMS gateway provider domain kung meron
        case 'smart':
        case 'tnt':
            return `${cleanNumber}@sams.smart.com.ph`;
        case 'sun':
            return `${cleanNumber}@suntel.com.ph`;
        default:
            // Kung international o generic carrier gateway, maaari mong i-configure dito
            return `${cleanNumber}@sms.gateway.ph`;
    }
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

    // Mahalaga ang metadata na ito para mabasa ng webhook sa mga susunod na auto-renew
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
        const eventData = event?.data?.attributes?.data;

        // 1. UNANG BAYAD: Kapag natapos na ang initial checkout session
        if (eventType === 'checkout_session.payment.paid') {
            const attributes = eventData.attributes;
            const metadata = attributes.metadata || {};
            const referenceNumber = attributes.reference_number;
            const amountPaidInCents = attributes.amount_paid || attributes.payments?.[0]?.attributes?.amount || 0;
            const amountPaid = amountPaidInCents / 100;
            const { user_id, package_id, billing_cycle } = metadata;

            if (user_id) {
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
        }

        // 2. MGA SUSUNOD NA AUTO-RENEW PAYMENTS (Recurring Success)
        else if (eventType === 'payment.paid' || eventType === 'invoice.payment_succeeded') {
            const paymentAttributes = eventData.attributes;
            const metadata = paymentAttributes.metadata || {};
            const user_id = metadata.user_id;

            if (user_id) {
                const durationMonths = metadata.billing_cycle === 'ANNUAL' ? 12 : 1;

                // Dagdagan ang expires_at batay sa kasalukuyang expiry o ngayon kung nag-expire na
                await pool.query(
                    `UPDATE rental_subscriptions 
                     SET expires_at = CASE 
                            WHEN expires_at > CURRENT_TIMESTAMP THEN expires_at + INTERVAL '${durationMonths} month'
                            ELSE CURRENT_TIMESTAMP + INTERVAL '${durationMonths} month'
                         END,
                         status = 'ACTIVE',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = $1`,
                    [user_id]
                );
                console.log(`✅ Tagumpay na na-auto-renew ang subscription para sa user: ${user_id}`);
            }
        }

        // 3. KUNG NAG-FAIL ANG AUTO-RENEW PAYMENTS
        else if (eventType === 'payment.failed' || eventType === 'invoice.payment_failed') {
            const paymentAttributes = eventData.attributes;
            const metadata = paymentAttributes.metadata || {};
            const user_id = metadata.user_id;

            if (user_id) {
                await pool.query(
                    `UPDATE rental_subscriptions 
                     SET status = 'PAST_DUE', updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = $1`,
                    [user_id]
                );
                console.log(`❌ Nag-fail ang pagbabayad/auto-renew para sa user: ${user_id}`);
            }
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

        await mailTransporter.sendMail({
            from: `"Paupahan System Notifications" <${adminEmail}>`,
            to: adminEmail,
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

exports.sendInvoiceNotification = async (req, res) => {
    const { tenantName, tenantEmail, landlordName, dueDate, totalAmount, billItems, invoiceNumber } = req.body;

    if (!tenantName || !tenantEmail || !totalAmount) {
        return res.status(400).json({ error: "Kailangan ang pangalan ng tenant, email, at kabuuang halaga." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        // I-format ang halaga sa Philippine Peso
        const formattedAmount = new Intl.NumberFormat('fil-PH', {
            style: 'currency',
            currency: 'PHP',
        }).format(Number(totalAmount));

        // Buuin ang listahan ng mga bill items kung mayroon man
        let itemsHtml = '';
        if (billItems && Array.isArray(billItems) && billItems.length > 0) {
            itemsHtml = billItems.map(item => `
                <tr>
                    <td style="padding: 8px 12px; border-bottom: 1px solid #334155; color: #E2E8F0; font-size: 14px;">${item.type || 'Bayarin'}</td>
                    <td style="padding: 8px 12px; border-bottom: 1px solid #334155; color: #38BDF8; font-size: 14px; text-align: right;">₱${Number(item.amount || 0).toLocaleString()}</td>
                </tr>
            `).join('');
        }

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: tenantEmail,
            subject: `[Paupahan] Bagong Bill / Invoice mula kay ${landlordName || 'Landlord'}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px;">
                    <h2 style="color: #38BDF8; margin-top: 0;">May bago kang Bill / Invoice!</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${tenantName}</strong>, nagpadala ng bagong bill ang iyong landlord (${landlordName || 'Landlord'}).</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Invoice # / Bill ID: <strong style="color: #F8FAFC;">${invoiceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">DueDate (Hanggang kailan babayaran): <strong style="color: #F8FAFC;">${dueDate || 'N/A'}</strong></p>
                    </div>

                    ${itemsHtml ? `
                        <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                            <p style="margin: 0 0 8px 0; color: #94A3B8; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Detalye ng Babayaran:</p>
                            <table style="width: 100%; border-collapse: collapse;">
                                ${itemsHtml}
                            </table>
                        </div>
                    ` : ''}

                    <div style="background: #0284C7; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
                        <p style="margin: 0; font-size: 13px; color: #E0F2FE; text-transform: uppercase; letter-spacing: 0.05em;">Kabuuang Babayaran</p>
                        <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: bold; color: #FFFFFF;">${formattedAmount}</p>
                    </div>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Mangyaring mag-log in sa Paupahan System portal upang matingnan ang iba pang detalye at makapaghain ng patunay ng pagbabayad.
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang email notification sa tenant."
        });

    } catch (error) {
        console.error('Invoice Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng email notification.'
        });
    }
};

exports.sendBillReminder = async (req, res) => {
    const { tenantName, tenantEmail, landlordName, dueDate, totalAmount, invoiceNumber, reminderNote } = req.body;

    if (!tenantName || !tenantEmail || !totalAmount) {
        return res.status(400).json({ error: "Kailangan ang pangalan ng tenant, email, at kabuuang halaga." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        // I-format ang halaga sa Philippine Peso
        const formattedAmount = new Intl.NumberFormat('fil-PH', {
            style: 'currency',
            currency: 'PHP',
        }).format(Number(totalAmount));

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: tenantEmail,
            subject: `[Paupahan Reminder] Paalala sa iyong Bill / Invoice mula kay ${landlordName || 'Landlord'}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px;">
                    <h2 style="color: #F59E0B; margin-top: 0;">Paalala sa Pagbabayad (Payment Reminder)</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${tenantName}</strong>, ito ay isang magiliw na paalala mula sa iyong landlord (${landlordName || 'Landlord'}) tungkol sa iyong nakabinbing bayarin.</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Invoice # / Bill ID: <strong style="color: #F8FAFC;">${invoiceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">DueDate (Petsa ng Bayaran): <strong style="color: #F59E0B;">${dueDate || 'N/A'}</strong></p>
                    </div>

                    ${reminderNote ? `
                        <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0; border-left: 4px solid #F59E0B;">
                            <p style="margin: 0 0 4px 0; color: #F59E0B; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: bold;">Mensahe mula sa Landlord:</p>
                            <p style="margin: 0; color: #E2E8F0; font-size: 14px; white-space: pre-wrap; line-height: 1.5;">${reminderNote}</p>
                        </div>
                    ` : ''}

                    <div style="background: #D97706; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
                        <p style="margin: 0; font-size: 13px; color: #FEF3C7; text-transform: uppercase; letter-spacing: 0.05em;">Kabuuang Babayaran</p>
                        <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: bold; color: #FFFFFF;">${formattedAmount}</p>
                    </div>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Mangyaring mag-log in sa Paupahan System portal upang masuri ang detalye at i-upload ang patunay ng iyong pagbabayad. Maraming salamat!
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang payment reminder sa tenant."
        });

    } catch (error) {
        console.error('Reminder Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng reminder notification.'
        });
    }
};

exports.sendOverdueNotice = async (req, res) => {
    const { tenantName, tenantEmail, landlordName, dueDate, totalAmount, invoiceNumber, daysOverdue } = req.body;

    if (!tenantName || !tenantEmail || !totalAmount) {
        return res.status(400).json({ error: "Kailangan ang pangalan ng tenant, email, at kabuuang halaga." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        // I-format ang halaga sa Philippine Peso
        const formattedAmount = new Intl.NumberFormat('fil-PH', {
            style: 'currency',
            currency: 'PHP',
        }).format(Number(totalAmount));

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: tenantEmail,
            subject: `[OVERDUE ALERT] Lumampas na sa Due Date ang iyong Bill mula kay ${landlordName || 'Landlord'}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px; border: 1px solid #EF4444;">
                    <h2 style="color: #EF4444; margin-top: 0;">⚠️ Overdue Payment Notice</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${tenantName}</strong>, napansin namin na lumampas na sa itinakdang due date ang iyong bayarin para sa iyong paupahan kay (${landlordName || 'Landlord'}).</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0; border-left: 4px solid #EF4444;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Invoice # / Bill ID: <strong style="color: #F8FAFC;">${invoiceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Dapat Bayaran Noong: <strong style="color: #EF4444;">${dueDate || 'N/A'}</strong></p>
                        ${daysOverdue ? `<p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Bilang ng Araw na Lumipas (Overdue): <strong style="color: #EF4444;">${daysOverdue} araw na ang nakalipas</strong></p>` : ''}
                    </div>

                    <div style="background: #B91C1C; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
                        <p style="margin: 0; font-size: 13px; color: #FEE2E2; text-transform: uppercase; letter-spacing: 0.05em;">Kaukulang Babayaran (Overdue Amount)</p>
                        <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: bold; color: #FFFFFF;">${formattedAmount}</p>
                    </div>

                    <p style="font-size: 14px; color: #F87171; line-height: 1.5; text-align: center; margin: 20px 0;">
                        Mangyaring ayusin at bayaran ito sa lalong madaling panahon upang maiwasan ang iba pang kaparusahan o multa sa iyong paupahan.
                    </p>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Mag-log in kaagad sa Paupahan System portal para i-upload ang patunay ng pagbabayad kung naisumite mo na ito. Maraming salamat.
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang overdue notice sa tenant."
        });

    } catch (error) {
        console.error('Overdue Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng overdue notification.'
        });
    }
};

exports.sendPaymentConfirmation = async (req, res) => {
    const { tenantName, tenantEmail, landlordName, amountPaid, paymentDate, referenceNumber, invoiceNumber, notes } = req.body;

    if (!tenantName || !tenantEmail || !amountPaid) {
        return res.status(400).json({ error: "Kailangan ang pangalan ng tenant, email, at halagang binayaran." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        // I-format ang halaga sa Philippine Peso
        const formattedAmount = new Intl.NumberFormat('fil-PH', {
            style: 'currency',
            currency: 'PHP',
        }).format(Number(amountPaid));

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: tenantEmail,
            subject: `[Paupahan] Kumpirmasyon ng Pagbabayad - Maraming Salamat!`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px; border: 1px solid #10B981;">
                    <h2 style="color: #10B981; margin-top: 0;">✅ Matagumpay ang Pagbabayad!</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${tenantName}</strong>, natanggap at na-verify na ni (${landlordName || 'Landlord'}) ang iyong bayad para sa paupahan.</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Invoice / Bill ID: <strong style="color: #F8FAFC;">${invoiceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Reference / Receipt #: <strong style="color: #F8FAFC;">${referenceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Petsa ng Pagbabayad: <strong style="color: #F8FAFC;">${paymentDate || 'Ngayon'}</strong></p>
                    </div>

                    ${notes ? `
                        <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                            <p style="margin: 0 0 4px 0; color: #94A3B8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Tala mula sa Landlord:</p>
                            <p style="margin: 0; color: #E2E8F0; font-size: 14px; white-space: pre-wrap; line-height: 1.5;">${notes}</p>
                        </div>
                    ` : ''}

                    <div style="background: #047857; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
                        <p style="margin: 0; font-size: 13px; color: #D1FAE5; text-transform: uppercase; letter-spacing: 0.05em;">Halagang Natanggap (Paid Amount)</p>
                        <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: bold; color: #FFFFFF;">${formattedAmount}</p>
                    </div>

                    <p style="font-size: 14px; color: #34D399; line-height: 1.5; text-align: center; margin: 20px 0;">
                        Maraming salamat sa iyong maagap at tapat na pagbabayad! Nakatala na ito sa iyong account ledger.
                    </p>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Maaari mong tignan ang iyong kasaysayan ng transaksiyon sa pamamagitan ng pag-log in sa Paupahan System portal.
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang payment confirmation email sa tenant."
        });

    } catch (error) {
        console.error('Payment Confirmation Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng kumpirmasyon ng pagbabayad.'
        });
    }
};

exports.sendReadingRequestNotice = async (req, res) => {
    const { tenantName, tenantEmail, landlordName, invoiceNumber, dueDate, submissionDeadline, utilityType } = req.body;

    if (!tenantName || !tenantEmail) {
        return res.status(400).json({ error: "Kailangan ang pangalan at email ng tenant." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: tenantEmail,
            subject: `[Paupahan] Kailangan ng Meter Reading / Pagsumite ng Bill mula kay ${landlordName || 'Landlord'}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px; border: 1px solid #38BDF8;">
                    <h2 style="color: #38BDF8; margin-top: 0;">📊 Pagsumite ng Meter Reading</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${tenantName}</strong>, gumawa na ng draft invoice ang iyong landlord (${landlordName || 'Landlord'}). Kailangan na ngayong i-upload o i-input ang iyong bagong metro (${utilityType || 'Kuryente/Tubig'}) para makalkula ang pinal na halaga ng iyong bayarin.</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Invoice # / Bill ID: <strong style="color: #F8FAFC;">${invoiceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Uri ng Metro: <strong style="color: #38BDF8;">${utilityType || 'Utility Meter'}</strong></p>
                        ${submissionDeadline ? `<p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Mag-submit bago ang: <strong style="color: #F8FBFC;">${submissionDeadline}</strong></p>` : ''}
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">DueDate ng Bill: <strong style="color: #F8FAFC;">${dueDate || 'N/A'}</strong></p>
                    </div>

                    <div style="background: #0284C7; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
                        <p style="margin: 0; font-size: 13px; color: #E0F2FE; text-transform: uppercase; letter-spacing: 0.05em;">Aksyon ang Kailangan</p>
                        <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: bold; color: #FFFFFF;">Mag-log in na sa portal para i-input ang reading.</p>
                    </div>

                    <p style="font-size: 14px; color: #94A3B8; line-height: 1.5; text-align: center; margin: 20px 0;">
                        Mangyaring i-upload ang tamang litrato o numero ng iyong metro upang maiwasan ang pagkakaantala sa pag-isyu ng pinal na bill.
                    </p>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Maaari mong i-access ang iyong tenant portal sa pamamagitan ng pag-log in sa Paupahan System. Maraming salamat!
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang reading request notice sa tenant."
        });

    } catch (error) {
        console.error('Reading Request Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng reading request notification.'
        });
    }
};

exports.sendMaintenanceUpdate = async (req, res) => {
    const { tenantName, tenantEmail, landlordName, issueTitle, status, maintenanceNotes } = req.body;

    if (!tenantName || !tenantEmail || !issueTitle) {
        return res.status(400).json({ error: "Kailangan ang pangalan ng tenant, email, at detalye ng isyu." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        // I-set ang kulay at mensahe batay sa status ng maintenance
        let statusColor = "#38BDF8";
        let statusText = status || "In Progress";
        if (status === "Resolved" || status === "Completed") {
            statusColor = "#10B981";
            statusText = "Tapos Na / Naayos Na";
        } else if (status === "Rejected") {
            statusColor = "#EF4444";
            statusText = "Tinanggihan / Hindi Maaksyunan";
        }

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: tenantEmail,
            subject: `[Paupahan Maintenance] Update sa iyong Request: ${issueTitle}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px; border: 1px solid ${statusColor};">
                    <h2 style="color: ${statusColor}; margin-top: 0;">🔧 Maintenance Request Update</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${tenantName}</strong>, may pagbabago sa status ng iyong inirequest na ayusin kay (${landlordName || 'Landlord'}).</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Isyu / Sirang Parte: <strong style="color: #F8FAFC;">${issueTitle}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Kasalukuyang Status: <strong style="color: ${statusColor};">${statusText}</strong></p>
                    </div>

                    ${maintenanceNotes ? `
                        <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                            <p style="margin: 0 0 4px 0; color: #94A3B8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Tala ng Landlord / Maintenance:</p>
                            <p style="margin: 0; color: #E2E8F0; font-size: 14px; white-space: pre-wrap; line-height: 1.5;">${maintenanceNotes}</p>
                        </div>
                    ` : ''}

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Maaari mong tingnan ang iba pang detalye sa iyong portal. Maraming salamat!
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang maintenance update sa tenant."
        });

    } catch (error) {
        console.error('Maintenance Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng maintenance notification.'
        });
    }
};

exports.notifyLandlordPayment = async (req, res) => {
    const { landlordEmail, landlordName, tenantName, amountPaid, invoiceNumber, referenceNumber, paymentMethod } = req.body;

    if (!landlordEmail || !tenantName || !amountPaid) {
        return res.status(400).json({ error: "Kailangan ang email ng landlord, pangalan ng tenant, at halagang binayaran." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;

        // I-format ang halaga sa Philippine Peso
        const formattedAmount = new Intl.NumberFormat('fil-PH', {
            style: 'currency',
            currency: 'PHP',
        }).format(Number(amountPaid));

        await mailTransporter.sendMail({
            from: `"Paupahan System" <${adminEmail}>`,
            to: landlordEmail,
            subject: `[Paupahan Action Required] Bagong Bayad / Patunay mula kay ${tenantName}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; padding: 24px; background: #0F172A; color: #F8FAFC; border-radius: 16px; border: 1px solid #38BDF8;">
                    <h2 style="color: #38BDF8; margin-top: 0;">💰 May Nagbayad / Nag-upload ng Patunay!</h2>
                    <p style="color: #94A3B8; font-size: 14px;">Kumusta <strong>${landlordName || 'Landlord'}</strong>, nagsumite ng patunay ng pagbabayad ang iyong tenant na si <strong>${tenantName}</strong>.</p>
                    
                    <div style="background: #1E293B; padding: 16px; border-radius: 12px; margin: 16px 0;">
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Invoice # / Bill ID: <strong style="color: #F8FAFC;">${invoiceNumber || 'N/A'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Paraan ng Pagbabayad: <strong style="color: #F8FAFC;">${paymentMethod || 'Online / Bank Transfer'}</strong></p>
                        <p style="margin: 6px 0; font-size: 13px; color: #94A3B8;">Reference Number: <strong style="color: #38BDF8;">${referenceNumber || 'N/A'}</strong></p>
                    </div>

                    <div style="background: #0284C7; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
                        <p style="margin: 0; font-size: 13px; color: #E0F2FE; text-transform: uppercase; letter-spacing: 0.05em;">Halagang Isinumite</p>
                        <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: bold; color: #FFFFFF;">${formattedAmount}</p>
                    </div>

                    <p style="font-size: 14px; color: #38BDF8; line-height: 1.5; text-align: center; margin: 20px 0;">
                        Mag-log in na sa iyong portal upang i-verify ang detalye at i-marka bilang <strong>Paid</strong> ang kanilang bill.
                    </p>

                    <p style="font-size: 12px; color: #64748B; margin-top: 24px; text-align: center;">
                        Ito ay awtomatikong abiso mula sa Paupahan System.
                    </p>
                </div>
            `
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang abiso kay landlord."
        });

    } catch (error) {
        console.error('Landlord Notification Email Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng abiso kay landlord.'
        });
    }
};

exports.sendSmsNotification = async (req, res) => {
    const { phoneNumber, carrier, message } = req.body;

    if (!phoneNumber || !message) {
        return res.status(400).json({ error: "Kailangan ang mobile number at mensahe." });
    }

    try {
        const adminEmail = process.env.EMAIL_USER || process.env.MAIL_USER;
        const recipientSmsEmail = getSmsGatewayEmail(phoneNumber, carrier);

        // Ang haba ng SMS ay dapat maikli (kadalasang 160 characters max para sa isang text)
        const smsBody = message.length > 160 ? message.substring(0, 157) + '...' : message;

        await mailTransporter.sendMail({
            from: `"Paupahan SMS" <${adminEmail}>`,
            to: recipientSmsEmail,
            subject: '', // Kadalasang walang subject ang SMS
            text: smsBody // Plain text lamang para sa SMS
        });

        return res.status(200).json({
            success: true,
            message: "Matagumpay na naipadala ang SMS notification sa pamamagitan ng email gateway."
        });

    } catch (error) {
        console.error('SMS Gateway Error:', error.message);
        return res.status(500).json({
            error: 'May nangyaring error sa pagpapadala ng SMS.'
        });
    }
};
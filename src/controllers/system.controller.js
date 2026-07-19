const pool = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); // Recommended for generating a session token

exports.getSubscriptionState = async (req, res) => {
    const { userId } = req.params;

    try {
        const query = `
            SELECT sms_credit_qty, package_id as plan_name, updated_at as last_update
            FROM fold_and_go_transactions
            WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1
        `;
        const result = await pool.query(query, [userId]);

        if (result.rows.length > 0) {
            const row = result.rows[0];
            return res.status(200).json({
                remainingSms: row.sms_credit_qty || 0,
                planName: row.plan_name || "Starter Wash",
                expiryDate: row.last_update ? new Date(row.last_update).getTime() + (30 * 24 * 60 * 60 * 1000) : null
            });
        }
        return res.status(404).json({ error: "User profile record not found" });
    } catch (error) {
        console.error('Operations error:', error);
        return res.status(500).json({ error: 'Internal system engine query failure.' });
    }
};

// --- NEW OPERATOR LOGIN ENDPOINT ---
exports.loginOperator = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required fields." });
    }

    try {
        // REMOVED: "id" column extraction to match schema.sql structure
        const query = `
            SELECT reference_number, name, email, password_hash, plan_id, billing_cycle, sms_credit_balance 
            FROM fold_go_operators 
            WHERE email = $1
        `;
        const result = await pool.query(query, [email.trim().toLowerCase()]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        const operator = result.rows[0];

        console.log("=== API LOGIN ATTEMPT ===");
        console.log("Input Password:", password);
        console.log("Input Password Type:", typeof password);
        console.log("Stored Hash:", operator.password_hash);

        const isMatch = await bcrypt.compare(password, operator.password_hash);
        console.log("Bcrypt Match Result:", isMatch);

        if (!isMatch) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        // FIX: Mapping operatorId explicitly to email since it serves as the unique identity string
        const token = jwt.sign(
            { operatorId: operator.email, email: operator.email, planId: operator.plan_id },
            process.env.JWT_SECRET || 'fallback_secret_key',
            { expiresIn: '7d' }
        );

        return res.status(200).json({
            message: "Login successful",
            token,
            operator: {
                id: operator.email, // Satisfies frontend context signature structures using unique email string
                referenceNumber: operator.reference_number,
                name: operator.name,
                email: operator.email,
                planId: operator.plan_id,
                billingCycle: operator.billing_cycle,
                smsCreditBalance: parseInt(operator.sms_credit_balance, 10) || 0
            }
        });

    } catch (error) {
        console.error('Operator login engine failure:', error);
        return res.status(500).json({ error: 'Internal system authorization error.' });
    }
};
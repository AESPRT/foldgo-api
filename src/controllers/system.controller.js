const pool = require('../config/database');

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
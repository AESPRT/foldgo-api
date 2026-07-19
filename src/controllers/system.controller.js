const pool = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

exports.getSubscriptionState = async (req, res) => {
    const { userId } = req.params;

    try {
        const query = `
            SELECT sms_credit_qty, package_id as plan_name, updated_at as last_update
            FROM fold_and_go_transactions
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 1
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

// Create a new shop (admin/operator)
exports.createShop = async (req, res) => {
    const { shopId, name, address, mobileNumber, ownerId, pin, settings } = req.body;

    if (!name || !ownerId) {
        return res.status(400).json({ error: "`name` and `ownerId` are required." });
    }

    try {
        // verify operator exists
        const ownerCheck = await pool.query(`SELECT operator_id FROM fold_go_operators WHERE operator_id = $1`, [ownerId]);
        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ error: "Owner/operator not found." });
        }

        const id = shopId || `SHOP-${crypto.randomBytes(6).toString('hex')}`;

        await pool.query(
            `INSERT INTO shops (shop_id, name, address, mobile_number, owner_id, pin, settings, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [id, name, address || null, mobileNumber || null, ownerId, pin || null, settings ? JSON.stringify(settings) : null]
        );

        return res.status(201).json({ shopId: id, name, address, mobileNumber, ownerId, pin, settings });
    } catch (err) {
        console.error('Create shop error:', err.message || err);
        return res.status(500).json({ error: 'Failed to create shop.' });
    }
};

// Shop login using shop_id and pin
exports.shopLogin = async (req, res) => {
    const { shopId, pin } = req.body;
    if (!shopId || !pin) return res.status(400).json({ error: 'shopId and pin are required' });

    try {
        const result = await pool.query(`SELECT shop_id, name, owner_id, pin FROM shops WHERE shop_id = $1`, [shopId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Shop not found' });

        const shop = result.rows[0];
        if (!shop.pin || shop.pin !== String(pin)) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ shopId: shop.shop_id }, process.env.SHOP_JWT_SECRET || 'shop_fallback_secret', { expiresIn: '30d' });

        return res.status(200).json({ message: 'Login successful', token, shop: { id: shop.shop_id, name: shop.name, ownerId: shop.owner_id } });
    } catch (err) {
        console.error('Shop login error:', err.message || err);
        return res.status(500).json({ error: 'Failed to login shop' });
    }
};

// Sync endpoint for a shop: returns configuration + transaction data scoped to shop_id
exports.syncByShop = async (req, res) => {
    // Accept shopId from query or derive from bearer token
    let shopId = req.query.shopId;
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!shopId && authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, process.env.SHOP_JWT_SECRET || 'shop_fallback_secret');
            shopId = decoded.shopId;
        } catch (e) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    }

    if (!shopId) return res.status(400).json({ error: 'shopId required (query or bearer token)' });

    try {
        // Fetch configuration tables scoped by shop_id
        const [shopRes, staffRes, machinesRes, servicesRes, smsSubRes, ordersRes] = await Promise.all([
            pool.query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]),
            pool.query(`SELECT * FROM staff WHERE shop_id = $1`, [shopId]),
            pool.query(`SELECT * FROM machines WHERE shop_id = $1`, [shopId]),
            pool.query(`SELECT * FROM services WHERE shop_id = $1`, [shopId]),
            pool.query(`SELECT * FROM sms_subscriptions WHERE shop_id = $1`, [shopId]),
            pool.query(`SELECT * FROM orders WHERE shop_id = $1 ORDER BY created_at DESC`, [shopId])
        ]);

        const shop = shopRes.rows[0] || null;
        const staff = staffRes.rows;
        const machines = machinesRes.rows;
        const services = servicesRes.rows;
        const smsSubscriptions = smsSubRes.rows;
        const orders = ordersRes.rows;

        const orderIds = orders.map(r => r.order_id).filter(Boolean);
        const customerIds = orders.map(r => r.customer_id).filter(Boolean);

        // Fetch related order_batches, customers, sms logs
        const [batchesRes, customersRes, smsLogsRes] = await Promise.all([
            orderIds.length ? pool.query(`SELECT * FROM order_batches WHERE order_id = ANY($1::text[])`, [orderIds]) : { rows: [] },
            customerIds.length ? pool.query(`SELECT * FROM customers WHERE customer_id = ANY($1::text[])`, [customerIds]) : { rows: [] },
            orderIds.length ? pool.query(`SELECT * FROM sms_transaction_logs WHERE job_order_id = ANY($1::text[])`, [orderIds]) : { rows: [] }
        ]);

        return res.status(200).json({
            shop,
            staff,
            machines,
            services,
            smsSubscriptions,
            orders,
            orderBatches: batchesRes.rows,
            customers: customersRes.rows,
            smsTransactionLogs: smsLogsRes.rows
        });

    } catch (err) {
        console.error('Sync by shop error:', err.message || err);
        return res.status(500).json({ error: 'Failed to fetch sync data' });
    }
};

// Upsert multiple shop-scoped entities in a single transaction
exports.upsertShopData = async (req, res) => {
    // Accept shopId from body or derive from token
    let shopId = req.body.shopId || null;
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!shopId && authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const decoded = jwt.verify(authHeader.split(' ')[1], process.env.SHOP_JWT_SECRET || 'shop_fallback_secret');
            shopId = decoded.shopId;
        } catch (e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }
    if (!shopId) return res.status(400).json({ error: 'shopId required in body or bearer token' });

    const { staff = [], machines = [], services = [], sms_subscriptions = null, orders = [] } = req.body;

    try {
        await pool.query('BEGIN');

        // Upsert staff
        for (const s of staff) {
            const q = `INSERT INTO staff (staff_id, shop_id, name, role, is_active, created_at)
                       VALUES ($1,$2,$3,$4,$5,NOW())
                       ON CONFLICT (staff_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, is_active = EXCLUDED.is_active`;
            await pool.query(q, [s.staffId || s.staff_id, shopId, s.name || s.fullName || null, s.role || null, typeof s.is_active !== 'undefined' ? s.is_active : true]);
        }

        // Upsert machines
        for (const m of machines) {
            const q = `INSERT INTO machines (machine_id, shop_id, name, capacity_kg, status, last_maintenance_date, end_time, cycles_count, assigned_order_id)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                       ON CONFLICT (machine_id) DO UPDATE SET name = EXCLUDED.name, capacity_kg = EXCLUDED.capacity_kg, status = EXCLUDED.status, last_maintenance_date = EXCLUDED.last_maintenance_date, end_time = EXCLUDED.end_time, cycles_count = EXCLUDED.cycles_count, assigned_order_id = EXCLUDED.assigned_order_id`;
            await pool.query(q, [m.machineId || m.machine_id, shopId, m.name || null, m.capacityKg || m.capacity_kg || null, m.status || null, m.lastMaintenanceDate || m.last_maintenance_date || null, m.endTime || m.end_time || null, m.cyclesCount || m.cycles_count || 0, m.assignedOrderId || m.assigned_order_id || null]);
        }

        // Upsert services
        for (const sv of services) {
            const q = `INSERT INTO services (service_id, shop_id, name, default_quantity, unit, price_per_unit, type)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (service_id) DO UPDATE SET name = EXCLUDED.name, default_quantity = EXCLUDED.default_quantity, unit = EXCLUDED.unit, price_per_unit = EXCLUDED.price_per_unit, type = EXCLUDED.type`;
            await pool.query(q, [sv.serviceId || sv.service_id, shopId, sv.name || null, sv.defaultQuantity || sv.default_quantity || 0, sv.unit || null, sv.pricePerUnit || sv.price_per_unit || 0, sv.type || null]);
        }

        // Upsert sms_subscriptions (single per shop)
        if (sms_subscriptions) {
            const ss = sms_subscriptions;
            const q = `INSERT INTO sms_subscriptions (shop_id, plan_name, allocated_sms, used_sms, billing_cycle_start, billing_cycle_end, is_active)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (shop_id) DO UPDATE SET plan_name = EXCLUDED.plan_name, allocated_sms = EXCLUDED.allocated_sms, used_sms = EXCLUDED.used_sms, billing_cycle_start = EXCLUDED.billing_cycle_start, billing_cycle_end = EXCLUDED.billing_cycle_end, is_active = EXCLUDED.is_active`;
            await pool.query(q, [shopId, ss.planName || ss.plan_name || null, ss.allocatedSms || ss.allocated_sms || 0, ss.usedSms || ss.used_sms || 0, ss.billingCycleStart || ss.billing_cycle_start || null, ss.billingCycleEnd || ss.billing_cycle_end || null, typeof ss.isActive !== 'undefined' ? ss.isActive : true]);
        }

        // Upsert orders
        for (const o of orders) {
            const q = `INSERT INTO orders (order_id, shop_id, customer_id, customer_name, customer_phone, customer_address, order_number, items_json, total_amount, delivery_fee, paid_amount, change_due, status, delivery_method, payment_status, intake_photos_json, machine_id, staff_id, staff_name, created_at, updated_at, is_synced)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,COALESCE($20, NOW()), COALESCE($21, NOW()), COALESCE($22, FALSE))
                       ON CONFLICT (order_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name, customer_phone = EXCLUDED.customer_phone, customer_address = EXCLUDED.customer_address, order_number = EXCLUDED.order_number, items_json = EXCLUDED.items_json, total_amount = EXCLUDED.total_amount, delivery_fee = EXCLUDED.delivery_fee, paid_amount = EXCLUDED.paid_amount, change_due = EXCLUDED.change_due, status = EXCLUDED.status, delivery_method = EXCLUDED.delivery_method, payment_status = EXCLUDED.payment_status, intake_photos_json = EXCLUDED.intake_photos_json, machine_id = EXCLUDED.machine_id, staff_id = EXCLUDED.staff_id, staff_name = EXCLUDED.staff_name, updated_at = NOW(), is_synced = EXCLUDED.is_synced`;

            const createdAt = o.createdAt || o.created_at || null;
            const updatedAt = o.updatedAt || o.updated_at || null;
            await pool.query(q, [o.orderId || o.order_id, shopId, o.customerId || o.customer_id || null, o.customerName || o.customer_name || null, o.customerPhone || o.customer_phone || null, o.customerAddress || o.customer_address || null, o.orderNumber || o.order_number || null, o.itemsJson || o.items_json || null, o.totalAmount || o.total_amount || 0, o.deliveryFee || o.delivery_fee || 0, o.paidAmount || o.paid_amount || 0, o.changeDue || o.change_due || 0, o.status || null, o.deliveryMethod || o.delivery_method || null, o.paymentStatus || o.payment_status || null, o.intakePhotosJson || o.intake_photos_json || null, o.machineId || o.machine_id || null, o.staffId || o.staff_id || null, o.staffName || o.staff_name || null, createdAt, updatedAt, typeof o.isSynced !== 'undefined' ? o.isSynced : false]);
        }

        await pool.query('COMMIT');
        return res.status(200).json({ status: 'ok' });
    } catch (err) {
        try { await pool.query('ROLLBACK'); } catch (e) { }
        console.error('Upsert shop data error:', err.message || err);
        return res.status(500).json({ error: 'Failed to upsert shop data' });
    }
};

// --- OPERATOR LOGIN ENDPOINT ---
exports.loginOperator = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required fields." });
    }

    try {
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

        // Perform internal hash match checking
        const isMatch = await bcrypt.compare(password, operator.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        // Map operatorId explicitly to the unique email address string identity block
        const token = jwt.sign(
            { operatorId: operator.operator_id, email: operator.email, planId: operator.plan_id },
            process.env.JWT_SECRET || 'fallback_secret_key',
            { expiresIn: '7d' }
        );

        return res.status(200).json({
            message: "Login successful",
            token,
            operator: {
                id: operator.email, // Satisfies enterprise frontend context structures
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
-- Drop tables if they already exist (Useful for development clean slates)
DROP TABLE IF EXISTS fold_go_operators CASCADE;

DROP TABLE IF EXISTS fold_and_go_transactions CASCADE;

-- 1. Transactions Tracking Table
CREATE TABLE fold_and_go_transactions (
    reference_number VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    sms_credit_qty INT DEFAULT 0,
    amount DECIMAL(10, 2) NOT NULL,
    payment_status VARCHAR(50) DEFAULT 'PENDING',
    package_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. SaaS Operators / Accounts Provisioning Table
CREATE TABLE fold_go_operators (
    operator_id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    reference_number VARCHAR(255) REFERENCES fold_and_go_transactions (reference_number) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    password_hash VARCHAR(255) NOT NULL,
    plan_id VARCHAR(100) NOT NULL,
    billing_cycle VARCHAR(50) DEFAULT 'MONTHLY',
    sms_credit_balance INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Indexes for Faster Webhook & Token Lookups
CREATE INDEX idx_transactions_ref ON fold_and_go_transactions (reference_number);

CREATE INDEX idx_operators_ref ON fold_go_operators (reference_number);

-- ---------------------------------------------------------------------------
-- Configuration Tables (Sync-Down)
-- ---------------------------------------------------------------------------

-- 1. Shops
DROP TABLE IF EXISTS shops CASCADE;

CREATE TABLE shops (
    shop_id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    mobile_number VARCHAR(50),
    owner_id VARCHAR(255) REFERENCES fold_go_operators (operator_id) ON DELETE SET NULL,
    pin VARCHAR(10),
    settings JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Staff
DROP TABLE IF EXISTS staff CASCADE;

CREATE TABLE staff (
    staff_id VARCHAR(255) PRIMARY KEY,
    shop_id VARCHAR(255) NOT NULL REFERENCES shops (shop_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Machine Categories
DROP TABLE IF EXISTS machine_categories CASCADE;

CREATE TABLE machine_categories (
    category_id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    icon_name VARCHAR(255),
    color_hex VARCHAR(20)
);

-- 4. Machines
DROP TABLE IF EXISTS machines CASCADE;

CREATE TABLE machines (
    machine_id VARCHAR(255) PRIMARY KEY,
    shop_id VARCHAR(255) NOT NULL REFERENCES shops (shop_id) ON DELETE CASCADE,
    name VARCHAR(255),
    capacity_kg NUMERIC(10, 2),
    status VARCHAR(50),
    last_maintenance_date TIMESTAMP,
    end_time TIMESTAMP,
    cycles_count INT DEFAULT 0,
    assigned_order_id VARCHAR(255)
);

-- 5. Services
DROP TABLE IF EXISTS services CASCADE;

CREATE TABLE services (
    service_id VARCHAR(255) PRIMARY KEY,
    shop_id VARCHAR(255) NOT NULL REFERENCES shops (shop_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    default_quantity NUMERIC(10, 3) DEFAULT 0,
    unit VARCHAR(50),
    price_per_unit NUMERIC(12, 2) DEFAULT 0,
    type VARCHAR(50)
);

-- 6. SMS Subscriptions
DROP TABLE IF EXISTS sms_subscriptions CASCADE;

CREATE TABLE sms_subscriptions (
    shop_id VARCHAR(255) PRIMARY KEY REFERENCES shops (shop_id) ON DELETE CASCADE,
    plan_name VARCHAR(255),
    allocated_sms INT DEFAULT 0,
    used_sms INT DEFAULT 0,
    billing_cycle_start TIMESTAMP,
    billing_cycle_end TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- ---------------------------------------------------------------------------
-- Transaction Tables (Sync-Up)
-- ---------------------------------------------------------------------------

-- 7. Customers
DROP TABLE IF EXISTS customers CASCADE;

CREATE TABLE customers (
    customer_id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255),
    phone VARCHAR(50),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Orders
DROP TABLE IF EXISTS orders CASCADE;

CREATE TABLE orders (
    order_id VARCHAR(255) PRIMARY KEY,
    shop_id VARCHAR(255) NOT NULL REFERENCES shops (shop_id) ON DELETE CASCADE,
    customer_id VARCHAR(255) REFERENCES customers (customer_id),
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    customer_address TEXT,
    order_number VARCHAR(255),
    items_json JSONB,
    total_amount NUMERIC(12, 2) DEFAULT 0,
    delivery_fee NUMERIC(12, 2) DEFAULT 0,
    paid_amount NUMERIC(12, 2) DEFAULT 0,
    change_due NUMERIC(12, 2) DEFAULT 0,
    status VARCHAR(50),
    delivery_method VARCHAR(50),
    payment_status VARCHAR(50),
    intake_photos_json JSONB,
    machine_id VARCHAR(255),
    staff_id VARCHAR(255) REFERENCES staff (staff_id),
    staff_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_synced BOOLEAN DEFAULT FALSE
);

-- 9. Order Batches
DROP TABLE IF EXISTS order_batches CASCADE;

CREATE TABLE order_batches (
    batch_id VARCHAR(255) PRIMARY KEY,
    order_id VARCHAR(255) NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
    machine_id VARCHAR(255) REFERENCES machines (machine_id),
    weight_kg NUMERIC(10, 3) DEFAULT 0,
    status VARCHAR(50),
    service_type VARCHAR(50),
    start_time TIMESTAMP,
    end_time TIMESTAMP
);

-- 10. SMS Transaction Logs
DROP TABLE IF EXISTS sms_transaction_logs CASCADE;

CREATE TABLE sms_transaction_logs (
    log_id BIGSERIAL PRIMARY KEY,
    job_order_id VARCHAR(255),
    recipient_number VARCHAR(50),
    message_body TEXT,
    segments_charged INT DEFAULT 0,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    api_response_id VARCHAR(255)
);

-- 11. Sync Outbox (Mobile Only)
DROP TABLE IF EXISTS sync_outbox CASCADE;

CREATE TABLE sync_outbox (
    id BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(100),
    entity_id VARCHAR(255),
    operation VARCHAR(20),
    payload_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for new tables
CREATE INDEX idx_shops_owner ON shops (owner_id);

CREATE INDEX idx_staff_shop ON staff (shop_id);

CREATE INDEX idx_machines_shop ON machines (shop_id);

CREATE INDEX idx_services_shop ON services (shop_id);

CREATE INDEX idx_orders_shop ON orders (shop_id);

CREATE INDEX idx_orders_number ON orders (order_number);

CREATE INDEX idx_sync_outbox_entity ON sync_outbox (entity_type, entity_id);
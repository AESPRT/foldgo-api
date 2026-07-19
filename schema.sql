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
    email VARCHAR(255) PRIMARY KEY,
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
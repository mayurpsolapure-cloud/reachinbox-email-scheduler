
CREATE EXTENSION IF NOT EXISTS pgcrypto;


CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_id VARCHAR(255) UNIQUE,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    picture TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS email_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    provider VARCHAR(50) NOT NULL DEFAULT 'ethereal',
    smtp_host VARCHAR(255),
    smtp_port INTEGER,
    smtp_username TEXT,
    smtp_password_encrypted TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, email)
);

CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    body TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'processing', 'completed', 'paused', 'failed')),
    scheduled_at TIMESTAMPTZ,
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    minimum_delay_seconds INTEGER NOT NULL DEFAULT 2
        CHECK (minimum_delay_seconds >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(150),
    last_name VARCHAR(150),
    company VARCHAR(255),
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, email)
);


CREATE TABLE IF NOT EXISTS scheduled_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    email_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,

    recipient_email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    body TEXT NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'queued', 'processing', 'sent', 'failed', 'cancelled')),

    scheduled_for TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,

    -- Idempotency and BullMQ tracking
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    bull_job_id VARCHAR(255) UNIQUE,

    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(campaign_id, lead_id)
);


CREATE TABLE IF NOT EXISTS email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_email_id UUID NOT NULL
        REFERENCES scheduled_emails(id) ON DELETE CASCADE,

    event_type VARCHAR(50) NOT NULL
        CHECK (event_type IN ('queued', 'attempted', 'sent', 'failed', 'retry', 'cancelled')),

    attempt_number INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_campaigns_user
    ON campaigns(user_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_status
    ON campaigns(status);

CREATE INDEX IF NOT EXISTS idx_leads_user
    ON leads(user_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status_time
    ON scheduled_emails(status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_scheduled_emails_campaign
    ON scheduled_emails(campaign_id);

CREATE INDEX IF NOT EXISTS idx_email_logs_scheduled_email
    ON email_logs(scheduled_email_id);

CREATE INDEX IF NOT EXISTS idx_email_logs_created
    ON email_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS slack_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    team_id VARCHAR(255) NOT NULL,
    team_name VARCHAR(255),
    channel_id VARCHAR(255) NOT NULL,
    channel_name VARCHAR(255) NOT NULL,
    webhook_ciphertext TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connected', 'disconnected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (status = 'connected' AND webhook_ciphertext IS NOT NULL)
      OR (status = 'disconnected' AND webhook_ciphertext IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_slack_integrations_active_user
    ON slack_integrations(user_id)
    WHERE status = 'connected';

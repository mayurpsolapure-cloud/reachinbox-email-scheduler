CREATE TABLE IF NOT EXISTS gmail_authorizations (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    gmail_email VARCHAR(255) NOT NULL,
    google_sub VARCHAR(255) NOT NULL,
    refresh_token_ciphertext TEXT,
    refresh_token_nonce VARCHAR(24),
    refresh_token_tag VARCHAR(32),
    granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status VARCHAR(32) NOT NULL DEFAULT 'reauthorization_required'
        CHECK (status IN ('connected', 'reauthorization_required')),
    last_error_code VARCHAR(64),
    authorized_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (refresh_token_ciphertext IS NULL
       AND refresh_token_nonce IS NULL
       AND refresh_token_tag IS NULL)
      OR
      (refresh_token_ciphertext IS NOT NULL
       AND refresh_token_nonce IS NOT NULL
       AND refresh_token_tag IS NOT NULL)
    ),
    CHECK (
      status <> 'connected'
      OR refresh_token_ciphertext IS NOT NULL
    )
);

ALTER TABLE scheduled_emails
    ADD COLUMN IF NOT EXISTS gmail_send_attempted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gmail_message_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS gmail_api_response JSONB;

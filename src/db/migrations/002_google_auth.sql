ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255),
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

UPDATE users
SET google_sub = google_id
WHERE google_sub IS NULL
  AND google_id IS NOT NULL;

UPDATE users
SET avatar_url = picture
WHERE avatar_url IS NULL
  AND picture IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
  ON users (google_sub)
  WHERE google_sub IS NOT NULL;

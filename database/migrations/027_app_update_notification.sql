BEGIN;

-- ============================================================
-- 🇧🇩 NETPHONE APP UPDATE NOTIFICATION
--
-- কাজ:
-- - Android app-এর latest published version সংরক্ষণ করা
-- - Optional / Force Update control করা
-- - User app open করলে backend থেকে update information পাওয়া
--
-- Calling / Wallet / Payment / Billing-এর সাথে সম্পর্ক নেই।
-- ============================================================

CREATE TABLE IF NOT EXISTS app_update_notifications (
    id BIGSERIAL PRIMARY KEY,

    platform VARCHAR(20) NOT NULL DEFAULT 'android',

    version_name VARCHAR(50) NOT NULL,
    build_number INTEGER NOT NULL,

    minimum_supported_version_name VARCHAR(50),
    minimum_supported_build_number INTEGER,

    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,

    play_store_url TEXT,

    force_update BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_app_update_build_number
        CHECK (build_number > 0),

    CONSTRAINT chk_app_update_min_build_number
        CHECK (
            minimum_supported_build_number IS NULL
            OR minimum_supported_build_number > 0
        )
);

-- একটি platform-এর জন্য active release দ্রুত খুঁজতে
CREATE INDEX IF NOT EXISTS
    idx_app_update_notifications_active
ON app_update_notifications (
    platform,
    is_active,
    build_number DESC
);

-- একই platform + build number duplicate হওয়া ঠেকাতে
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_app_update_notifications_platform_build
ON app_update_notifications (
    platform,
    build_number
);

COMMIT;
-- 008_set_bangladesh_admin.sql
-- Purpose: Set Bangladesh number as NetPhone admin and remove admin role from old Kuwait admin number.
-- Safe to run multiple times.

BEGIN;

UPDATE users
SET role = 'admin', status = COALESCE(status, 'active')
WHERE phone_e164 = '+8801721763941';

UPDATE users
SET role = 'user'
WHERE phone_e164 = '+96598598703'
  AND phone_e164 <> '+8801721763941';

COMMIT;

-- Verify result after running:
-- SELECT id, phone, phone_e164, role, status FROM users WHERE phone_e164 IN ('+8801721763941', '+96598598703');

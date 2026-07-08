CREATE TABLE IF NOT EXISTS app_pages (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(80) NOT NULL,
  title VARCHAR(150) NOT NULL,
  content TEXT NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(slug, language)
);

INSERT INTO app_pages (slug, title, content, language, is_active)
VALUES
('about_app', 'About App', 'NetPhone is an international calling app for affordable app-to-mobile calls worldwide.', 'en', true),
('privacy_policy', 'Privacy Policy', 'NetPhone respects your privacy. We collect only necessary information such as phone number, wallet balance, recharge and call history for service operation.', 'en', true),
('terms_conditions', 'Terms & Conditions', 'By using NetPhone, you agree to use the service legally and responsibly. Rates may vary by country and provider.', 'en', true),
('refund_return', 'Refund & Return Policy', 'Recharge amounts are generally non-refundable once used for calls. If a payment issue occurs, contact customer support.', 'en', true),
('customer_support', 'Customer Support', 'For support, contact: bdraihan056@gmail.com', 'en', true),
('rates', 'International Rates', 'International call rates are dynamic and may vary by destination country and provider cost.', 'en', true)
ON CONFLICT (slug, language)
DO UPDATE SET
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
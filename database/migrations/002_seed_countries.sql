-- =========================================
-- 002_seed_countries.sql
-- কাজ: Phase-1 Active দেশের তালিকা ঢোকানো
-- =========================================

INSERT INTO countries (country_code, country_name, is_active, risk_level)
VALUES
  ('BD', 'Bangladesh', TRUE, 'medium'),
  ('IN', 'India', TRUE, 'medium'),
  ('PH', 'Philippines', TRUE, 'medium'),
  ('EG', 'Egypt', TRUE, 'medium'),
  ('SA', 'Saudi Arabia', TRUE, 'medium'),
  ('US', 'United States', TRUE, 'low'),
  ('IT', 'Italy', TRUE, 'low'),
  ('KW', 'Kuwait', TRUE, 'low')

ON CONFLICT (country_code) DO NOTHING;

INSERT INTO rates (country_code, telnyx_cost_per_min, sell_rate_per_min, margin_per_min, is_active)
VALUES
  ('BD', 0, 0, 0, TRUE),
  ('IN', 0, 0, 0, TRUE),
  ('PH', 0, 0, 0, TRUE),
  ('EG', 0, 0, 0, TRUE),
  ('SA', 0, 0, 0, TRUE),
  ('US', 0, 0, 0, TRUE),
  ('IT', 0, 0, 0, TRUE),
  ('KW', 0, 0, 0, TRUE)
ON CONFLICT (country_code) DO NOTHING;


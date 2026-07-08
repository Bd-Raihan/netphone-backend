const db = require("../../config/db");

async function getPageBySlug({ slug, language = "en" }) {
  const result = await db.query(
    `
    SELECT id, slug, title, content, language, updated_at
    FROM app_pages
    WHERE slug = $1
      AND language = $2
      AND is_active = true
    LIMIT 1
    `,
    [slug, language]
  );

  return result.rows[0] || null;
}

async function listPages({ language = "en" }) {
  const result = await db.query(
    `
    SELECT id, slug, title, language, updated_at
    FROM app_pages
    WHERE language = $1
      AND is_active = true
    ORDER BY id ASC
    `,
    [language]
  );

  return result.rows;
}

module.exports = {
  getPageBySlug,
  listPages,
};
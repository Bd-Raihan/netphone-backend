const db = require("../../config/db");

async function getAllPages() {
  const result = await db.query(`
    SELECT
      id,
      slug,
      title,
      content,
      language,
      is_active,
      created_at,
      updated_at
    FROM app_pages
    ORDER BY language ASC, id ASC
  `);

  return result.rows;
}

async function getPageById(id) {
  const result = await db.query(
    `
    SELECT
      id,
      slug,
      title,
      content,
      language,
      is_active,
      created_at,
      updated_at
    FROM app_pages
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function createPage({
  slug,
  title,
  content,
  language = "en",
  isActive = true,
}) {
  const result = await db.query(
    `
    INSERT INTO app_pages (
      slug,
      title,
      content,
      language,
      is_active,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    RETURNING
      id,
      slug,
      title,
      content,
      language,
      is_active,
      created_at,
      updated_at
    `,
    [slug, title, content, language, isActive]
  );

  return result.rows[0];
}

async function updatePage({
  id,
  slug,
  title,
  content,
  language,
  isActive,
}) {
  const result = await db.query(
    `
    UPDATE app_pages
    SET
      slug = $2,
      title = $3,
      content = $4,
      language = $5,
      is_active = $6,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      slug,
      title,
      content,
      language,
      is_active,
      created_at,
      updated_at
    `,
    [id, slug, title, content, language, isActive]
  );

  return result.rows[0] || null;
}

async function deletePage(id) {
  const result = await db.query(
    `
    DELETE FROM app_pages
    WHERE id = $1
    RETURNING id
    `,
    [id]
  );

  return result.rows[0] || null;
}

module.exports = {
  getAllPages,
  getPageById,
  createPage,
  updatePage,
  deletePage,
};
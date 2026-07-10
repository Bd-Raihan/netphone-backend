const service = require("./admin.content.service");

function normalizeBoolean(value, defaultValue = true) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === 1 || value === "1") {
    return true;
  }

  if (value === "false" || value === 0 || value === "0") {
    return false;
  }

  return defaultValue;
}

async function getAllPages(req, res, next) {
  try {
    const pages = await service.getAllPages();

    return res.status(200).json({
      ok: true,
      items: pages,
    });
  } catch (error) {
    next(error);
  }
}

async function getPageById(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Invalid page id",
      });
    }

    const page = await service.getPageById(id);

    if (!page) {
      return res.status(404).json({
        ok: false,
        message: "Page not found",
      });
    }

    return res.status(200).json({
      ok: true,
      page,
    });
  } catch (error) {
    next(error);
  }
}

async function createPage(req, res, next) {
  try {
    const {
      slug,
      title,
      content,
      language = "en",
      is_active = true,
    } = req.body;

    if (!slug || !title || !content) {
      return res.status(400).json({
        ok: false,
        message: "Slug, title and content are required",
      });
    }

    const cleanSlug = String(slug).trim().toLowerCase();
    const cleanTitle = String(title).trim();
    const cleanContent = String(content).trim();
    const cleanLanguage = String(language).trim().toLowerCase();

    if (!/^[a-z0-9_]+$/.test(cleanSlug)) {
      return res.status(400).json({
        ok: false,
        message:
          "Slug may contain only lowercase letters, numbers and underscore",
      });
    }

    const page = await service.createPage({
      slug: cleanSlug,
      title: cleanTitle,
      content: cleanContent,
      language: cleanLanguage || "en",
      isActive: normalizeBoolean(is_active, true),
    });

    return res.status(201).json({
      ok: true,
      message: "Page created successfully",
      page,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "This slug and language already exist",
      });
    }

    next(error);
  }
}

async function updatePage(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Invalid page id",
      });
    }

    const existingPage = await service.getPageById(id);

    if (!existingPage) {
      return res.status(404).json({
        ok: false,
        message: "Page not found",
      });
    }

    const {
      slug = existingPage.slug,
      title = existingPage.title,
      content = existingPage.content,
      language = existingPage.language,
      is_active = existingPage.is_active,
    } = req.body;

    const cleanSlug = String(slug).trim().toLowerCase();
    const cleanTitle = String(title).trim();
    const cleanContent = String(content).trim();
    const cleanLanguage = String(language).trim().toLowerCase();

    if (!cleanSlug || !cleanTitle || !cleanContent) {
      return res.status(400).json({
        ok: false,
        message: "Slug, title and content are required",
      });
    }

    if (!/^[a-z0-9_]+$/.test(cleanSlug)) {
      return res.status(400).json({
        ok: false,
        message:
          "Slug may contain only lowercase letters, numbers and underscore",
      });
    }

    const page = await service.updatePage({
      id,
      slug: cleanSlug,
      title: cleanTitle,
      content: cleanContent,
      language: cleanLanguage || "en",
      isActive: normalizeBoolean(is_active, existingPage.is_active),
    });

    return res.status(200).json({
      ok: true,
      message: "Page updated successfully",
      page,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "This slug and language already exist",
      });
    }

    next(error);
  }
}

async function deletePage(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Invalid page id",
      });
    }

    const deletedPage = await service.deletePage(id);

    if (!deletedPage) {
      return res.status(404).json({
        ok: false,
        message: "Page not found",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Page deleted successfully",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAllPages,
  getPageById,
  createPage,
  updatePage,
  deletePage,
};
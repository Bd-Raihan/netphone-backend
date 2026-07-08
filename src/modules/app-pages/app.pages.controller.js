const service = require("./app.pages.service");

async function getPage(req, res, next) {
  try {
    const slug = req.params.slug;
    const language = req.query.language || "en";

    const page = await service.getPageBySlug({ slug, language });

    if (!page) {
      return res.status(404).json({
        ok: false,
        message: "Page not found",
      });
    }

    return res.json({
      ok: true,
      page,
    });
  } catch (err) {
    next(err);
  }
}

async function listPages(req, res, next) {
  try {
    const language = req.query.language || "en";
    const pages = await service.listPages({ language });

    return res.json({
      ok: true,
      items: pages,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPage,
  listPages,
};
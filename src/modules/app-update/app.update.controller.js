const appUpdateService = require(
  "./app.update.service"
);

// ============================================================
// 🇧🇩 APP UPDATE CONTROLLER
//
// কাজ:
// - Public app update check
// - Admin update publish
// - Admin active update deactivate
//
// Calling / Wallet / Payment-এর সাথে সম্পর্ক নেই.
// ============================================================

async function getLatestUpdate(req, res, next) {
  try {
    const platform =
      req.query.platform || "android";

    const update =
      await appUpdateService.getLatestUpdate({
        platform,
      });

    return res.status(200).json({
      ok: true,
      update,
    });
  } catch (error) {
    next(error);
  }
}

async function publishUpdate(req, res, next) {
  try {
    const body = req.body || {};

    const update =
      await appUpdateService.publishUpdate({
        platform:
          body.platform || "android",

        versionName:
          body.version_name ??
          body.versionName,

        buildNumber:
          body.build_number ??
          body.buildNumber,

        minimumSupportedVersionName:
          body.minimum_supported_version_name ??
          body.minimumSupportedVersionName,

        minimumSupportedBuildNumber:
          body.minimum_supported_build_number ??
          body.minimumSupportedBuildNumber,

        title: body.title,

        message: body.message,

        playStoreUrl:
          body.play_store_url ??
          body.playStoreUrl,

        forceUpdate:
          body.force_update ??
          body.forceUpdate ??
          false,
      });

    return res.status(201).json({
      ok: true,
      message:
        "App update notice published successfully",
      update,
    });
  } catch (error) {
    next(error);
  }
}

async function deactivateUpdate(
  req,
  res,
  next,
) {
  try {
    const platform =
      req.body?.platform ||
      req.query?.platform ||
      "android";

    const result =
      await appUpdateService.deactivateUpdate({
        platform,
      });

    return res.status(200).json({
      ok: true,
      message:
        "Active app update notice deactivated",
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getLatestUpdate,
  publishUpdate,
  deactivateUpdate,
};
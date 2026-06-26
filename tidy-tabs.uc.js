// ==UserScript==
// @ignorecache
// @name          Ai tab sort and tab clearer
// @description   sorts tabs and arranges them into tab groups
// ==/UserScript==

(() => {
  // Bootstrap the modular runtime by loading the ordered module list.
  const MODULE_ROOT = "chrome://sine/content/better-tidy-tabs/modules/";
  const MODULE_FILES = [
    "00-config.js",
    "10-utils.js",
    "20-ai-common.js",
    "30-provider-gemini.js",
    "31-provider-local.js",
    "40-sorting.js",
    "50-ui.js",
  ];

  try {
    // Tear down the previous runtime before reloading modules so repeated
    // userscript injections do not stack listeners or patched methods.
    window.BetterTidyTabs?.cleanup?.();
  } catch (error) {
    console.error("[TabSort] Failed cleaning up previous runtime:", error);
  }

  window.BetterTidyTabs = {
    modId: "better-tidy-tabs",
    moduleRoot: MODULE_ROOT,
  };

  try {
    MODULE_FILES.forEach((fileName) => {
      Services.scriptloader.loadSubScript(
        `${MODULE_ROOT}${fileName}`,
        window,
        "UTF-8"
      );
    });

    window.BetterTidyTabs.start?.();
  } catch (error) {
    console.error("[TabSort] Failed loading modular runtime:", error);
  }
})();

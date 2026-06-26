(() => {
  // Define shared runtime state, constants, and the provider registry.
  const ns = window.BetterTidyTabs;

  ns.CONFIG = {
    SIMILARITY_THRESHOLD: 0.45,
    MIN_TABS_FOR_SORT: 6,
    DEBOUNCE_DELAY: 250,
    ANIMATION_DURATION: 800,
    MAX_INIT_CHECKS: 50,
    INIT_CHECK_INTERVAL: 100,
    EMBEDDING_BATCH_SIZE: 5,
    MAX_EMBEDDING_CACHE_SIZE: 250,
  };

  ns.PROVIDERS = {
    FIREFOX_LOCAL: "firefox-local",
    GEMINI: "gemini",
  };

  ns.PREFS = {
    PROVIDER: "extension.zen-tidy-tabs.provider",
    GEMINI_API_KEY: "extension.zen-tidy-tabs.gemini-api-key",
  };

  ns.GEMINI_CONFIG = {
    MODELS: ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
    MAX_TITLE_LENGTH: 120,
    MAX_PATH_HINT_LENGTH: 60,
    MAX_GROUP_SAMPLE_TITLES: 3,
    MAX_GROUP_NAME_LENGTH: 24,
    BASE_OUTPUT_TOKENS: 512,
    MAX_OUTPUT_TOKENS: 2048,
    OUTPUT_TOKENS_PER_TAB: 24,
    OUTPUT_TOKENS_PER_EXISTING_GROUP: 12,
    REQUEST_TIMEOUT_MS: 15000,
  };

  ns.ATG_ICON_CATALOG = {
    developer: {
      label: "Developer / coding",
      url: "chrome://global/skin/icons/developer.svg",
    },
    search: {
      label: "Search / research",
      url: "chrome://global/skin/icons/search-textbox.svg",
    },
    folder: {
      label: "Docs / files / organization",
      url: "chrome://global/skin/icons/folder.svg",
    },
    warning: {
      label: "Troubleshooting / warnings / bugs",
      url: "chrome://global/skin/icons/warning.svg",
    },
    error: {
      label: "Errors / failures / broken states",
      url: "chrome://global/skin/icons/error.svg",
    },
    security: {
      label: "Auth / security / accounts",
      url: "chrome://global/skin/icons/security.svg",
    },
    link: {
      label: "Links / web / references",
      url: "chrome://global/skin/icons/link.svg",
    },
    lightbulb: {
      label: "Ideas / planning / notes",
      url: "chrome://global/skin/icons/lightbulb.svg",
    },
    settings: {
      label: "Preferences / configuration",
      url: "chrome://global/skin/icons/settings.svg",
    },
    info: {
      label: "Info / reading / general reference",
      url: "chrome://global/skin/icons/info.svg",
    },
    trend: {
      label: "News / trends / discovery",
      url: "chrome://global/skin/icons/trending.svg",
    },
    plugin: {
      label: "Extensions / add-ons / integrations",
      url: "chrome://global/skin/icons/plugin.svg",
    },
    performance: {
      label: "Performance / profiling / benchmarking",
      url: "chrome://global/skin/icons/performance.svg",
    },
    reload: {
      label: "Refresh / iteration / retry",
      url: "chrome://global/skin/icons/reload.svg",
    },
    trophy: {
      label: "Goals / milestones / success",
      url: "chrome://global/skin/icons/trophy.svg",
    },
    heart: {
      label: "Favorites / saved / personal",
      url: "chrome://global/skin/icons/heart.svg",
    },
    downloads: {
      label: "Downloads / assets",
      url: "chrome://browser/skin/zen-icons/downloads.svg",
    },
    sidebar: {
      label: "Browser UI / sidebar / Zen",
      url: "chrome://browser/skin/zen-icons/sidebar.svg",
    },
    permissions: {
      label: "Permissions / browser controls",
      url: "chrome://browser/skin/zen-icons/permissions.svg",
    },
    translations: {
      label: "Translation / language",
      url: "chrome://browser/skin/zen-icons/translations.svg",
    },
  };

  ns.ATG_ICON_KEYWORDS = [
    { iconId: "warning", pattern: /\b(troubleshoot|troubleshooting|debug|bug|issue|fix|problem)\b/i },
    { iconId: "error", pattern: /\b(error|broken|failure|failing|crash)\b/i },
    { iconId: "security", pattern: /\b(auth|login|sign in|signin|account|security|permission)\b/i },
    { iconId: "developer", pattern: /\b(code|coding|dev|develop|repo|github|gitlab|pull request|pr|api)\b/i },
    { iconId: "search", pattern: /\b(search|research|lookup|google|find)\b/i },
    { iconId: "folder", pattern: /\b(doc|docs|documentation|readme|guide|file|files)\b/i },
    { iconId: "plugin", pattern: /\b(extension|plugin|addon|integration|mod)\b/i },
    { iconId: "settings", pattern: /\b(settings|preferences|config|configuration)\b/i },
    { iconId: "performance", pattern: /\b(performance|profiling|profile|benchmark|speed)\b/i },
    { iconId: "downloads", pattern: /\b(download|downloads|asset|assets)\b/i },
    { iconId: "translations", pattern: /\b(translate|translation|language|locale)\b/i },
    { iconId: "sidebar", pattern: /\b(zen|browser|sidebar|tabs|workspace)\b/i },
    { iconId: "trend", pattern: /\b(news|trend|trending|discover)\b/i },
    { iconId: "lightbulb", pattern: /\b(idea|ideas|plan|planning|note|notes)\b/i },
    { iconId: "reload", pattern: /\b(retry|refresh|reload|rerun|again)\b/i },
    { iconId: "trophy", pattern: /\b(goal|milestone|launch|release|done|success)\b/i },
    { iconId: "heart", pattern: /\b(favorite|saved|personal)\b/i },
  ];

  ns.state = {
    isSorting: false,
    sortButtonListenerAdded: false,
    isPlayingFailureAnimation: false,
    sortAnimationId: null,
    eventListenersAdded: false,
    embeddingCache: new Map(),
    commandHandler: null,
    tabEventHandler: null,
    workspaceSwitchHandler: null,
    loadHandler: null,
    unloadHandler: null,
    beforeUnloadHandler: null,
    workspaceHooksInstalled: false,
    workspaceHooksOriginals: null,
    clearPatchInstalled: false,
    clearButtonOriginal: null,
    initIntervalId: null,
    initialized: false,
  };

  ns.providerRegistry = new Map();

  // Register an AI provider that exposes a stable assignTopics contract.
  ns.registerProvider = (provider) => {
    if (provider?.id && typeof provider.assignTopics === "function") {
      ns.providerRegistry.set(provider.id, provider);
    }
  };

  // Look up a registered provider by its stable id.
  ns.getProvider = (providerId) => ns.providerRegistry.get(providerId) || null;

  ns.domCache = {
    separators: null,
    commandSet: null,

    // Cache the separator list until the UI layer invalidates it.
    getSeparators() {
      if (!this.separators || !this.separators.length) {
        this.separators = document.querySelectorAll(
          ".pinned-tabs-container-separator"
        );
      }
      return this.separators;
    },

    // Cache the Zen commandset used for the sort command binding.
    getCommandSet() {
      if (!this.commandSet) {
        this.commandSet = document.querySelector("commandset#zenCommandSet");
      }
      return this.commandSet;
    },

    // Clear cached DOM lookups after workspace/layout changes.
    invalidate() {
      this.separators = null;
      this.commandSet = null;
    },
  };
})();

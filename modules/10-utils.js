(() => {
  // Provide shared tab, text, icon, and grouping helpers used across modules.
  const ns = window.BetterTidyTabs;
  const { CLOUD_PROMPT_CONFIG, ATG_ICON_CATALOG, ATG_ICON_KEYWORDS } = ns;

  // Return tabs from the active workspace that match the requested filters.
  const getFilteredTabs = (workspaceId, options = {}) => {
    if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) {
      return [];
    }

    const {
      includeGrouped = false,
      includeSelected = true,
      includePinned = false,
      includeEmpty = false,
      includeGlance = false,
    } = options;

    return Array.from(gBrowser.tabs).filter((tab) => {
      if (!tab?.isConnected) return false;

      const isInCorrectWorkspace =
        tab.getAttribute("zen-workspace-id") === workspaceId;
      if (!isInCorrectWorkspace) return false;

      const groupParent = tab.closest("tab-group");
      const isInGroup = !!groupParent;

      return (
        (includePinned || !tab.pinned) &&
        (includeGrouped || !isInGroup) &&
        (includeSelected || !tab.selected) &&
        (includeEmpty || !tab.hasAttribute("zen-empty-tab")) &&
        (includeGlance || !tab.hasAttribute("zen-glance-tab"))
      );
    });
  };

  // Resolve the best human-readable title for a tab, with URL-based fallback.
  const getTabTitle = (tab) => {
    if (!tab?.isConnected) {
      return "Invalid Tab";
    }

    try {
      const originalTitle =
        tab.getAttribute("label") ||
        tab.querySelector(".tab-label, .tab-text")?.textContent ||
        "";

      if (
        !originalTitle ||
        originalTitle === "New Tab" ||
        originalTitle === "about:blank" ||
        originalTitle === "Loading..." ||
        originalTitle.startsWith("http:") ||
        originalTitle.startsWith("https:")
      ) {
        const browser =
          tab.linkedBrowser ||
          tab._linkedBrowser ||
          window.gBrowser?.getBrowserForTab?.(tab);

        if (
          browser?.currentURI?.spec &&
          !browser.currentURI.spec.startsWith("about:")
        ) {
          try {
            const currentURL = new URL(browser.currentURI.spec);
            const hostname = currentURL.hostname.replace(/^www\./, "");
            if (
              hostname &&
              hostname !== "localhost" &&
              hostname !== "127.0.0.1"
            ) {
              return hostname;
            }

            const pathSegment = currentURL.pathname.split("/")[1];
            if (pathSegment) return pathSegment;
          } catch {
            // Ignore URL parsing failures and fall back to a generic label.
          }
        }

        return "Untitled Page";
      }

      return originalTitle.trim() || "Untitled Page";
    } catch (error) {
      console.error("Error getting tab title for tab:", tab, error);
      return "Error Processing Tab";
    }
  };

  // Extract compact URL context that helps cloud models infer tab intent.
  const getTabNavigationInfo = (tab) => {
    if (!tab?.isConnected) {
      return { host: "", pathHint: "" };
    }

    try {
      const browser =
        tab.linkedBrowser ||
        tab._linkedBrowser ||
        window.gBrowser?.getBrowserForTab?.(tab);
      const spec = browser?.currentURI?.spec;
      if (!spec || spec.startsWith("about:")) {
        return { host: "", pathHint: "" };
      }

      const url = new URL(spec);
      const host = url.hostname.replace(/^www\./, "");
      const pathSegments = url.pathname.split("/").filter(Boolean).slice(0, 3);
      const searchHint =
        url.searchParams.get("q") ||
        url.searchParams.get("query") ||
        url.searchParams.get("search") ||
        "";

      return {
        host,
        pathHint: pathSegments.join("/") || searchHint,
      };
    } catch {
      return { host: "", pathHint: "" };
    }
  };

  // Limit long strings before sending them to models or using them in labels.
  const truncateText = (text, maxLength) => {
    if (!text || typeof text !== "string") return "";
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}...`;
  };

  // Normalize topic names for case-insensitive matching and map lookups.
  const normalizeTopicKey = (topic) => {
    if (!topic || typeof topic !== "string") return "";
    return topic.trim().toLowerCase();
  };

  // Normalize icon ids so provider output maps cleanly to the icon catalog.
  const normalizeIconId = (iconId) => {
    if (!iconId || typeof iconId !== "string") return "";
    return iconId.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  };

  // Clean model-generated group names before creating or reusing a tab group.
  const sanitizeTopicName = (topic, fallback = "Group") => {
    const safeFallback =
      typeof fallback === "string" && fallback.trim() ? fallback.trim() : "Group";
    if (!topic || typeof topic !== "string") {
      return safeFallback;
    }

    const cleaned = topic
      .trim()
      .replace(/^['"`]+|['"`]+$/g, "")
      .replace(/[.?!,:;]+$/g, "")
      .trim()
      .slice(0, CLOUD_PROMPT_CONFIG.MAX_GROUP_NAME_LENGTH);

    return cleaned || safeFallback;
  };

  // Remove duplicate or falsy values while preserving insertion order.
  const uniqueArray = (items) => Array.from(new Set(items.filter(Boolean)));

  // Check whether an icon id exists in the supported ATG icon catalog.
  const isValidIconId = (iconId) =>
    !!ATG_ICON_CATALOG[normalizeIconId(iconId)];

  // Convert an icon id into the chrome URL expected by Advanced Tab Groups.
  const getIconUrlForIconId = (iconId) =>
    ATG_ICON_CATALOG[normalizeIconId(iconId)]?.url || null;

  // Format the supported icon list as prompt text for cloud providers.
  const getIconCatalogPromptText = () =>
    Object.entries(ATG_ICON_CATALOG)
      .map(([iconId, { label }]) => `${iconId}: ${label}`)
      .join("\n");

  // Pick a reasonable icon from keywords when the provider does not supply one.
  const getFallbackIconIdForTopic = (topic) => {
    if (!topic || typeof topic !== "string") {
      return "folder";
    }

    const match = ATG_ICON_KEYWORDS.find(({ pattern }) => pattern.test(topic));
    return match?.iconId || "folder";
  };

  // Resolve an icon id and fall back to keyword-based matching when needed.
  const getResolvedIconId = (iconId, topic) =>
    isValidIconId(iconId) ? normalizeIconId(iconId) : getFallbackIconIdForTopic(topic);

  // Detect whether a tab group already has an Advanced Tab Groups icon set.
  const groupHasATGIcon = (group) => {
    if (!group?.isConnected) return false;

    try {
      if (globalThis.advancedTabGroups?.savedIcons?.[group.id]) {
        return true;
      }
    } catch {
      // Ignore ATG state read failures and fall through to DOM inspection.
    }

    return !!group.querySelector(
      ".tab-group-icon .group-icon, .tab-group-icon label"
    );
  };

  // Apply an ATG icon to a group without overwriting an existing custom icon.
  const applyATGGroupIconIfNeeded = async (group, iconId) => {
    const resolvedIconId = getResolvedIconId(
      iconId,
      group?.getAttribute("label") || ""
    );
    const iconUrl = getIconUrlForIconId(resolvedIconId);

    if (
      !group?.isConnected ||
      !iconUrl ||
      !globalThis.advancedTabGroups ||
      typeof globalThis.advancedTabGroups.applyGroupIcon !== "function" ||
      groupHasATGIcon(group)
    ) {
      return;
    }

    try {
      await globalThis.advancedTabGroups.applyGroupIcon(group, iconUrl);
    } catch (error) {
      console.error(
        `[TabSort] Failed applying ATG icon "${resolvedIconId}" to group "${group.getAttribute("label") || "Unknown"}":`,
        error
      );
    }
  };

  // Convert provider assignments into the final group structure used by sorting.
  const buildFinalGroupsFromAssignments = (
    assignments,
    existingGroupNameMap = new Map()
  ) => {
    const finalGroups = {};
    const seenTabs = new Set();

    assignments.forEach(({ tab, topic, iconId }) => {
      // Providers decide grouping. The UI layer only validates assignments and
      // reuses canonical existing group names so later DOM moves stay predictable.
      if (
        !tab?.isConnected ||
        seenTabs.has(tab) ||
        typeof topic !== "string" ||
        !topic.trim()
      ) {
        return;
      }

      const normalizedTopic = normalizeTopicKey(topic);
      const canonicalExistingGroup =
        existingGroupNameMap.get(normalizedTopic) || null;
      const finalTopic = canonicalExistingGroup
        ? canonicalExistingGroup
        : sanitizeTopicName(topic, "Group");

      if (!finalTopic) {
        return;
      }

      if (!finalGroups[finalTopic]) {
        finalGroups[finalTopic] = {
          tabs: [],
          iconId: getResolvedIconId(iconId, finalTopic),
        };
      }

      finalGroups[finalTopic].tabs.push(tab);
      if (!finalGroups[finalTopic].iconId && iconId) {
        finalGroups[finalTopic].iconId = getResolvedIconId(iconId, finalTopic);
      }
      seenTabs.add(tab);
    });

    Object.entries(finalGroups).forEach(([groupName, groupData]) => {
      groupData.tabs = uniqueArray(groupData.tabs);
      groupData.iconId = getResolvedIconId(groupData.iconId, groupName);
    });

    return finalGroups;
  };

  // Convert model-generated names into title case for cleaner group labels.
  const toTitleCase = (value) => {
    if (!value || typeof value !== "string") return "";
    return value
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  // Find the DOM element for a group by name inside a specific workspace.
  const findGroupElement = (topicName, workspaceId) => {
    if (!topicName || typeof topicName !== "string" || !workspaceId) {
      return null;
    }

    const sanitizedTopicName = topicName.trim();
    if (!sanitizedTopicName) return null;

    const safeSelectorTopicName = sanitizedTopicName
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    try {
      return document.querySelector(
        `tab-group[label="${safeSelectorTopicName}"][zen-workspace-id="${workspaceId}"]`
      );
    } catch (error) {
      console.error(
        `Error finding group selector for "${sanitizedTopicName}":`,
        error
      );
      return null;
    }
  };

  Object.assign(ns, {
    getFilteredTabs,
    getTabTitle,
    getTabNavigationInfo,
    truncateText,
    normalizeTopicKey,
    normalizeIconId,
    sanitizeTopicName,
    uniqueArray,
    isValidIconId,
    getIconUrlForIconId,
    getIconCatalogPromptText,
    getFallbackIconIdForTopic,
    getResolvedIconId,
    groupHasATGIcon,
    applyATGGroupIconIfNeeded,
    buildFinalGroupsFromAssignments,
    toTitleCase,
    findGroupElement,
  });
})();

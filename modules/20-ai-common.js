(() => {
  // Provide shared AI helpers such as embeddings, caching, prefs, and context building.
  const ns = window.BetterTidyTabs;
  const {
    CONFIG,
    PROVIDERS,
    PREFS,
    state,
    CLOUD_PROMPT_CONFIG,
    ATG_ICON_CATALOG,
  } = ns;
  const {
    getTabNavigationInfo,
    getTabTitle,
    getFilteredTabs,
    getIconCatalogPromptText,
    normalizeIconId,
    truncateText,
  } = ns;

  // Average token or chunk embeddings into one normalized vector.
  function averageEmbedding(arrays) {
    if (!Array.isArray(arrays) || arrays.length === 0) return [];
    if (typeof arrays[0] === "number") return arrays;

    const length = arrays[0].length;
    const average = new Array(length).fill(0);

    for (const array of arrays) {
      for (let index = 0; index < length; index++) {
        average[index] += array[index];
      }
    }

    for (let index = 0; index < length; index++) {
      average[index] /= arrays.length;
    }

    return average;
  }

  // Measure semantic similarity between two embedding vectors.
  function cosineSimilarity(a, b) {
    if (
      !Array.isArray(a) ||
      !Array.isArray(b) ||
      a.length !== b.length ||
      a.length === 0
    ) {
      return 0;
    }

    if (typeof a[0] !== "number" || typeof b[0] !== "number") {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < a.length; index++) {
      dot += a[index] * b[index];
      normA += a[index] * a[index];
      normB += b[index] * b[index];
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Build rough local clusters from embedding similarity scores.
  function clusterEmbeddings(vectors, threshold = CONFIG.SIMILARITY_THRESHOLD) {
    if (!Array.isArray(vectors) || vectors.length === 0) {
      return [];
    }

    const groups = [];
    const used = new Set();

    for (let index = 0; index < vectors.length; index++) {
      if (used.has(index)) continue;

      const group = [index];
      used.add(index);

      for (
        let compareIndex = index + 1;
        compareIndex < vectors.length;
        compareIndex++
      ) {
        if (used.has(compareIndex)) continue;

        const similarity = cosineSimilarity(
          vectors[index],
          vectors[compareIndex]
        );
        if (similarity >= threshold) {
          group.push(compareIndex);
          used.add(compareIndex);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  // Batch DOM mutations behind one helper to keep call sites simple.
  const batchDOMUpdates = (operations) => {
    if (!Array.isArray(operations) || operations.length === 0) return;

    const fragment = document.createDocumentFragment();

    try {
      operations.forEach((operation) => {
        if (typeof operation === "function") {
          operation(fragment);
        }
      });
    } catch (error) {
      console.error("Error in batch DOM operations:", error);
    }
  };

  // Process tabs in small batches so local embedding work does not spike too hard.
  const processTabsInBatches = async (
    tabs,
    batchSize = CONFIG.EMBEDDING_BATCH_SIZE
  ) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];

    const results = [];
    for (let index = 0; index < tabs.length; index += batchSize) {
      const batch = tabs.slice(index, index + batchSize);
      const batchResults = await Promise.all(
        batch.map((tab) => getCachedEmbeddingForTab(tab))
      );
      results.push(...batchResults);
    }

    return results;
  };

  // Build a stable cache key for embedding reuse across repeated sorts.
  const getEmbeddingCacheKey = (title) => {
    if (!title || typeof title !== "string") return null;
    const normalizedTitle = title.trim();
    return normalizedTitle || null;
  };

  // Store embeddings in a small LRU-style cache capped by config.
  const cacheEmbedding = (key, embedding) => {
    if (!key || !Array.isArray(embedding) || embedding.length === 0) return;

    if (state.embeddingCache.has(key)) {
      state.embeddingCache.delete(key);
    }

    state.embeddingCache.set(key, embedding);

    if (state.embeddingCache.size > CONFIG.MAX_EMBEDDING_CACHE_SIZE) {
      const oldestKey = state.embeddingCache.keys().next().value;
      if (oldestKey) {
        state.embeddingCache.delete(oldestKey);
      }
    }
  };

  // Reuse a cached embedding for a tab title or generate a fresh one.
  const getCachedEmbeddingForTab = async (tab) => {
    const title = getTabTitle(tab);
    const cacheKey = getEmbeddingCacheKey(title);

    if (cacheKey && state.embeddingCache.has(cacheKey)) {
      const cachedEmbedding = state.embeddingCache.get(cacheKey);
      state.embeddingCache.delete(cacheKey);
      state.embeddingCache.set(cacheKey, cachedEmbedding);
      return cachedEmbedding;
    }

    const embedding = await generateEmbedding(title);
    if (cacheKey && Array.isArray(embedding) && embedding.length > 0) {
      cacheEmbedding(cacheKey, embedding);
    }

    return embedding;
  };

  // Run Firefox local ML to generate a semantic embedding for a title.
  const generateEmbedding = async (title) => {
    if (!title || typeof title !== "string") return null;

    try {
      const { createEngine } = ChromeUtils.importESModule(
        "chrome://global/content/ml/EngineProcess.sys.mjs"
      );
      const engine = await createEngine({
        taskName: "feature-extraction",
        modelId: "Mozilla/smart-tab-embedding",
        modelHub: "huggingface",
        engineId: "embedding-engine",
      });

      const result = await engine.run({ args: [title] });
      let embedding;

      if (result?.[0]?.embedding && Array.isArray(result[0].embedding)) {
        embedding = result[0].embedding;
      } else if (result?.[0] && Array.isArray(result[0])) {
        embedding = result[0];
      } else if (Array.isArray(result)) {
        embedding = result;
      } else {
        return null;
      }

      const pooled = averageEmbedding(embedding);
      if (
        Array.isArray(pooled) &&
        pooled.length > 0 &&
        typeof pooled[0] === "number"
      ) {
        const norm = Math.sqrt(
          pooled.reduce((sum, value) => sum + value * value, 0)
        );
        return norm === 0 ? pooled : pooled.map((value) => value / norm);
      }

      return null;
    } catch (error) {
      console.error("[TabSort][AI] Error generating embedding:", error);
      return null;
    }
  };

  // Read the user's preferred AI provider from Firefox prefs.
  const getPreferredAIProvider = () => {
    try {
      return Services.prefs.getStringPref(
        PREFS.PROVIDER,
        PROVIDERS.FIREFOX_LOCAL
      );
    } catch {
      return PROVIDERS.FIREFOX_LOCAL;
    }
  };

  // Read and trim the Gemini API key from Firefox prefs.
  const getGeminiApiKey = () => {
    try {
      return Services.prefs.getStringPref(PREFS.GEMINI_API_KEY, "").trim();
    } catch {
      return "";
    }
  };

  // Read and trim the OpenRouter API key from Firefox prefs.
  const getOpenRouterApiKey = () => {
    try {
      return Services.prefs.getStringPref(PREFS.OPENROUTER_API_KEY, "").trim();
    } catch {
      return "";
    }
  };

  // Read and trim the user-selected OpenRouter model name from Firefox prefs.
  const getOpenRouterModel = () => {
    try {
      return Services.prefs.getStringPref(PREFS.OPENROUTER_MODEL, "").trim();
    } catch {
      return "";
    }
  };

  // Collect existing groups in the active workspace for provider reuse decisions.
  const getExistingWorkspaceGroups = (workspaceId) => {
    const existingWorkspaceGroups = new Map();
    if (!workspaceId) {
      return existingWorkspaceGroups;
    }

    const groupSelector = `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`;
    document.querySelectorAll(groupSelector).forEach((groupEl) => {
      const label = groupEl.getAttribute("label");
      if (!label) return;

      const groupTabs = Array.from(groupEl.querySelectorAll("tab")).filter(
        (tab) => tab.getAttribute("zen-workspace-id") === workspaceId
      );

      if (groupTabs.length > 0) {
        existingWorkspaceGroups.set(label, {
          element: groupEl,
          tabs: groupTabs,
          tabTitles: groupTabs.map((tab) => getTabTitle(tab)),
        });
      }
    });

    return existingWorkspaceGroups;
  };

  // Build the common provider context so all providers receive the same inputs.
  const buildProviderContext = (tabs) => {
    const validTabs = Array.isArray(tabs)
      ? tabs.filter((tab) => tab?.isConnected)
      : [];
    const workspaceId = window.gZenWorkspaces?.activeWorkspace || "";
    const existingWorkspaceGroups = getExistingWorkspaceGroups(workspaceId);
    const groupSelector = workspaceId
      ? `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
      : "";

    return {
      tabs: validTabs,
      workspaceId,
      groupSelector,
      existingWorkspaceGroups,
      allWorkspaceTabs: workspaceId
        ? getFilteredTabs(workspaceId, {
            includeGrouped: true,
            includeSelected: true,
            includePinned: false,
            includeEmpty: false,
            includeGlance: false,
          })
        : [],
    };
  };

  // Turn live tabs into the compact records used by cloud prompts and response mapping.
  const buildCloudTabRecords = (tabs) =>
    tabs.map((tab, index) => {
      const navigationInfo = getTabNavigationInfo(tab);
      return {
        id: `t${index + 1}`,
        tab,
        title: truncateText(
          getTabTitle(tab),
          CLOUD_PROMPT_CONFIG.MAX_TITLE_LENGTH
        ),
        host: navigationInfo.host,
        pathHint: truncateText(
          navigationInfo.pathHint,
          CLOUD_PROMPT_CONFIG.MAX_PATH_HINT_LENGTH
        ),
      };
    });

  // Turn existing groups into compact prompt records shared by cloud providers.
  const buildExistingGroupPromptRecords = (existingWorkspaceGroups) =>
    Array.from(existingWorkspaceGroups.entries()).map(([groupName, groupInfo]) => ({
      name: groupName,
      sampleTitles: groupInfo.tabTitles
        .slice(0, CLOUD_PROMPT_CONFIG.MAX_GROUP_SAMPLE_TITLES)
        .map((title) =>
          truncateText(title, CLOUD_PROMPT_CONFIG.MAX_TITLE_LENGTH)
        ),
    }));

  // Build the provider-agnostic grouping prompt used by cloud models.
  const buildCloudAssignmentsPrompt = (tabRecords, existingGroups) => {
    const existingGroupsText =
      existingGroups.length === 0
        ? "None"
        : existingGroups
            .map(
              (group) =>
                `${group.name}: ${group.sampleTitles.join(" | ") || "No samples"}`
            )
            .join("\n");

    const tabsText = tabRecords
      .map((tab) => {
        const parts = [`${tab.id}`, tab.title];
        if (tab.host) parts.push(`host=${tab.host}`);
        if (tab.pathHint) parts.push(`path=${tab.pathHint}`);
        return parts.join(" | ");
      })
      .join("\n");

    return [
      "Group browser tabs by browsing task or topic.",
      "Create as few groups as reasonably possible while still keeping them useful.",
      "Prefer broad task-oriented groups over narrow repo-name or page-name groups.",
      "You must decide the final grouping yourself from the provided tabs and existing groups.",
      "Reuse an existing group only when it is clearly the best fit, and use the exact existing group name when you do.",
      "Use concise title-case task names with at most 24 characters.",
      "Never create a new group for a single tab.",
      "Any tab that does not clearly belong with at least one other tab must be assigned to Others.",
      "Prefer Others over creating a narrow, speculative, or weakly supported group.",
      "Prefer merging closely related tabs into a broader topic instead of creating another small group.",
      "Favor useful work-context grouping over literal title similarity.",
      "Choose exactly one iconId for each assignment from the supported icon catalog below.",
      'Return only valid JSON with this exact shape: {"assignments":[{"tabId":"t1","topic":"Example","iconId":"folder"}]}.',
      "Do not include markdown fences, prose, explanations, or extra keys.",
      "",
      "Supported icons:",
      getIconCatalogPromptText(),
      "",
      "Existing groups:",
      existingGroupsText,
      "",
      "Tabs:",
      tabsText,
    ].join("\n");
  };

  // Remove markdown fences when a model wraps JSON in formatting.
  const stripCodeFences = (text) => {
    if (!text || typeof text !== "string") return "";
    return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  };

  // Extract the outer JSON object from model output that may include extra text.
  const extractJsonObjectText = (text) => {
    if (!text || typeof text !== "string") return "";

    const trimmed = text.trim();
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      return trimmed;
    }

    return trimmed.slice(firstBrace, lastBrace + 1);
  };

  // Parse a model text response into the expected assignments JSON payload.
  const parseAssignmentsPayloadText = (text) =>
    JSON.parse(extractJsonObjectText(stripCodeFences(text)));

  // Scale cloud output tokens with the number of tabs and existing groups in context.
  const getCloudMaxOutputTokens = (tabCount, existingGroupCount = 0) =>
    Math.min(
      CLOUD_PROMPT_CONFIG.MAX_OUTPUT_TOKENS,
      Math.max(
        CLOUD_PROMPT_CONFIG.BASE_OUTPUT_TOKENS,
        CLOUD_PROMPT_CONFIG.BASE_OUTPUT_TOKENS +
          tabCount * CLOUD_PROMPT_CONFIG.OUTPUT_TOKENS_PER_TAB +
          existingGroupCount *
            CLOUD_PROMPT_CONFIG.OUTPUT_TOKENS_PER_EXISTING_GROUP
      )
    );

  // Convert provider assignment payloads into live tab-topic records for sorting.
  const mapProviderAssignments = (assignments, tabRecords) => {
    const tabMap = new Map(tabRecords.map((record) => [record.id, record]));
    const seenTabIds = new Set();

    return assignments
      .map((assignment) => {
        if (
          !assignment ||
          typeof assignment.tabId !== "string" ||
          typeof assignment.topic !== "string"
        ) {
          return null;
        }

        const tabRecord = tabMap.get(assignment.tabId);
        if (!tabRecord || seenTabIds.has(assignment.tabId)) {
          return null;
        }

        seenTabIds.add(assignment.tabId);
        return {
          tab: tabRecord.tab,
          topic: assignment.topic,
          iconId:
            typeof assignment.iconId === "string"
              ? normalizeIconId(assignment.iconId)
              : "",
        };
      })
      .filter(Boolean);
  };

  // Store the last provider feedback so the sorting layer can show it once.
  const setProviderFeedback = (feedback) => {
    state.lastProviderFeedback = feedback || null;
  };

  // Consume the last provider feedback so it is not shown more than once.
  const consumeProviderFeedback = () => {
    const feedback = state.lastProviderFeedback;
    state.lastProviderFeedback = null;
    return feedback;
  };

  // Format provider ids into short user-facing labels for logs and toasts.
  const formatProviderLabel = (providerId) => {
    switch (providerId) {
      case PROVIDERS.GEMINI:
        return "Gemini";
      case PROVIDERS.OPENROUTER:
        return "OpenRouter";
      case PROVIDERS.FIREFOX_LOCAL:
        return "Firefox local AI";
      default:
        return providerId || "AI provider";
    }
  };

  // Create a provider error with both console detail and a user-facing message.
  const createProviderError = (
    providerId,
    userMessage,
    { cause = null, retryable = false, status = null, rawTextPreview = "" } = {}
  ) => {
    const error = new Error(userMessage);
    error.providerId = providerId;
    error.userMessage = userMessage;
    error.retryable = retryable;
    error.status = status;
    error.rawTextPreview = rawTextPreview;
    error.cause = cause;
    return error;
  };

  // Validate the generic assignments shape returned by a cloud provider.
  const hasValidAssignmentsPayload = (payload) =>
    Array.isArray(payload?.assignments);

  Object.assign(ns, {
    averageEmbedding,
    cosineSimilarity,
    clusterEmbeddings,
    batchDOMUpdates,
    processTabsInBatches,
    getEmbeddingCacheKey,
    cacheEmbedding,
    getCachedEmbeddingForTab,
    generateEmbedding,
    getPreferredAIProvider,
    getGeminiApiKey,
    getOpenRouterApiKey,
    getOpenRouterModel,
    getExistingWorkspaceGroups,
    buildProviderContext,
    buildCloudTabRecords,
    buildExistingGroupPromptRecords,
    buildCloudAssignmentsPrompt,
    stripCodeFences,
    extractJsonObjectText,
    parseAssignmentsPayloadText,
    getCloudMaxOutputTokens,
    mapProviderAssignments,
    setProviderFeedback,
    consumeProviderFeedback,
    formatProviderLabel,
    createProviderError,
    hasValidAssignmentsPayload,
  });
})();

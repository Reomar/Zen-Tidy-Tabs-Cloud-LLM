(() => {
  // Provide shared AI helpers such as embeddings, caching, prefs, and context building.
  const ns = window.BetterTidyTabs;
  const { CONFIG, PROVIDERS, PREFS, state } = ns;
  const { getTabTitle, getFilteredTabs } = ns;

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

      for (let compareIndex = index + 1; compareIndex < vectors.length; compareIndex++) {
        if (used.has(compareIndex)) continue;

        const similarity = cosineSimilarity(vectors[index], vectors[compareIndex]);
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
        const norm = Math.sqrt(pooled.reduce((sum, value) => sum + value * value, 0));
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
    getExistingWorkspaceGroups,
    buildProviderContext,
  });
})();

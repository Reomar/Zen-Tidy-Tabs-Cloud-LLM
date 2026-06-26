(() => {
  // Implement the Firefox local AI provider and register it with the runtime.
  const ns = window.BetterTidyTabs;
  const { PROVIDERS, CONFIG } = ns;
  const {
    processTabsInBatches,
    clusterEmbeddings,
    getTabTitle,
    toTitleCase,
    sanitizeTopicName,
    getFallbackIconIdForTopic,
  } = ns;

  // Pull repeated meaningful words from tab titles for local group naming.
  const extractKeywords = (titles) => {
    const allWords = titles
      .join(" ")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2);

    const wordCount = {};
    allWords.forEach((word) => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });

    const stopWords = new Set([
      "the",
      "and",
      "for",
      "are",
      "but",
      "not",
      "you",
      "all",
      "can",
      "had",
      "her",
      "was",
      "one",
      "our",
      "out",
      "day",
      "get",
      "has",
      "him",
      "his",
      "how",
      "man",
      "new",
      "now",
      "old",
      "see",
      "two",
      "way",
      "who",
      "boy",
      "did",
      "its",
      "let",
      "put",
      "say",
      "she",
      "too",
      "use",
    ]);

    return Object.entries(wordCount)
      .filter(([word]) => !stopWords.has(word))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  };

  // Ask Firefox local topic generation to produce a short group name.
  const nameGroupWithSmartTabTopic = async (titles) => {
    const keywords = extractKeywords(titles);
    const input = `Topic from keywords: ${keywords.join(", ")}. titles:\n${titles.join("\n")}`;

    try {
      const { createEngine } = ChromeUtils.importESModule(
        "chrome://global/content/ml/EngineProcess.sys.mjs"
      );
      const engine = await createEngine({
        taskName: "text2text-generation",
        modelId: "Mozilla/smart-tab-topic",
        modelHub: "huggingface",
        engineId: "group-namer",
      });

      const aiResult = await engine.run({
        args: [input],
        options: { max_new_tokens: 8, temperature: 0.7 },
      });

      let name = (aiResult[0]?.generated_text || "Group")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line);

      name = toTitleCase(name);
      if (!name || /none|adult content/i.test(name)) {
        name = titles[0].split("–")[0].trim().slice(0, 24);
      }

      return sanitizeTopicName(name, "Group");
    } catch (error) {
      console.error("[TabSort][AI] Error naming group:", error);
      return "Group";
    }
  };

  // Turn local embedding clusters into final tab-topic assignments.
  const assignTopicsWithLocalAI = async (context) => {
    if (!Array.isArray(context?.tabs) || context.tabs.length === 0) return [];

    const result = [];
    const embeddings = await processTabsInBatches(context.tabs);
    const validEmbeddings = embeddings.filter(
      (embedding) => Array.isArray(embedding) && embedding.length > 0
    );
    const validIndices = embeddings
      .map((embedding, index) =>
        Array.isArray(embedding) && embedding.length > 0 ? index : -1
      )
      .filter((index) => index !== -1);

    if (validEmbeddings.length <= 1) {
      return result;
    }

    const allGroups = clusterEmbeddings(
      validEmbeddings,
      CONFIG.SIMILARITY_THRESHOLD
    );
    const groups = allGroups.filter(
      (group) => Array.isArray(group) && group.length > 1
    );

    if (groups.length === 0) {
      return result;
    }

    for (const group of groups) {
      // The local provider owns grouping and naming end to end so the sort
      // layer can treat local and cloud results exactly the same way.
      const groupTabs = group.map((index) => context.tabs[validIndices[index]]);
      const groupTitles = groupTabs.map((tab) => getTabTitle(tab));
      const groupName = await nameGroupWithSmartTabTopic(groupTitles);
      const iconId = getFallbackIconIdForTopic(groupName);

      groupTabs.forEach((tab) => {
        result.push({ tab, topic: groupName, iconId });
      });

      console.log(
        `[TabSort] Created direct local AI group "${groupName}" with ${groupTabs.length} tabs`
      );
    }

    return result;
  };

  ns.registerProvider({
    id: PROVIDERS.FIREFOX_LOCAL,
    isCloud: false,
    assignTopics: assignTopicsWithLocalAI,
  });

  Object.assign(ns, {
    extractKeywords,
    nameGroupWithSmartTabTopic,
  });
})();

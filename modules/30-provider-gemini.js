(() => {
  // Implement the Gemini cloud provider and register it with the runtime.
  const ns = window.BetterTidyTabs;
  const { PROVIDERS, GEMINI_CONFIG } = ns;
  const {
    getGeminiApiKey,
    getTabNavigationInfo,
    getTabTitle,
    truncateText,
    getExistingWorkspaceGroups,
    getIconCatalogPromptText,
    normalizeIconId,
  } = ns;

  // Build the full Gemini prompt from tabs, existing groups, and icon choices.
  const buildGeminiPrompt = (tabRecords, existingGroups) => {
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
      "Prefer broad task-oriented groups over narrow repo-name or page-name groups.",
      "You must decide the final grouping yourself from the provided tabs and existing groups.",
      "Reuse an existing group only when it is clearly the best fit, and use the exact existing group name when you do.",
      "Use concise title-case task names with at most 24 characters.",
      "Do not create singleton niche groups unless a tab genuinely deserves its own group.",
      "Put weak, isolated, or miscellaneous tabs into Others.",
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

  // Flatten Gemini response parts into one plain text payload.
  const parseGeminiResponseText = (responseData) => {
    const parts = responseData?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  };

  // Remove markdown code fences when a model wraps JSON in formatting.
  const stripCodeFences = (text) => {
    if (!text || typeof text !== "string") return "";
    return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  };

  // Extract the outer JSON object from a noisy model response.
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

  // Scale output tokens with the number of tabs and existing groups in context.
  const getGeminiMaxOutputTokens = (tabCount, existingGroupCount = 0) =>
    Math.min(
      GEMINI_CONFIG.MAX_OUTPUT_TOKENS,
      Math.max(
        GEMINI_CONFIG.BASE_OUTPUT_TOKENS,
        GEMINI_CONFIG.BASE_OUTPUT_TOKENS +
          tabCount * GEMINI_CONFIG.OUTPUT_TOKENS_PER_TAB +
          existingGroupCount * GEMINI_CONFIG.OUTPUT_TOKENS_PER_EXISTING_GROUP
      )
    );

  // Mark HTTP statuses that should trigger a retry or fallback model.
  const isRetryableGeminiStatus = (status) =>
    [404, 408, 429, 500, 502, 503, 504].includes(status);

  const GEMINI_ASSIGNMENTS_SCHEMA = {
    type: "OBJECT",
    properties: {
      assignments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            tabId: { type: "STRING" },
            topic: { type: "STRING" },
            iconId: { type: "STRING" },
          },
          required: ["tabId", "topic"],
        },
      },
    },
    required: ["assignments"],
  };

  // Build Gemini generation config, optionally requesting structured JSON output.
  const buildGeminiGenerationConfig = (
    maxOutputTokens,
    useStructuredOutput = true
  ) => {
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens,
    };

    if (useStructuredOutput) {
      // Cloud providers should return machine-readable assignments so the sort
      // layer can stay provider-agnostic and avoid natural-language parsing.
      generationConfig.responseFormat = {
        text: {
          mimeType: "application/json",
          schema: GEMINI_ASSIGNMENTS_SCHEMA,
        },
      };
    }

    return generationConfig;
  };

  // Detect schema-related 400s that should retry without structured output.
  const shouldRetryGeminiWithoutStructuredOutput = (error) =>
    error?.status === 400 &&
    /responseformat|mime[_ ]?type|schema|invalid json payload|invalid value/i.test(
      error?.message || ""
    );

  // Send one Gemini request to one model and parse assignments from the response.
  const requestGeminiAssignmentsForModel = async (
    prompt,
    apiKey,
    modelName,
    maxOutputTokens,
    useStructuredOutput = true
  ) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      GEMINI_CONFIG.REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: buildGeminiGenerationConfig(
              maxOutputTokens,
              useStructuredOutput
            ),
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const error = new Error(
          `Gemini request failed for ${modelName} with status ${response.status}${
            errorText ? `: ${errorText}` : ""
          }`
        );
        error.status = response.status;
        error.retryable = isRetryableGeminiStatus(response.status);
        throw error;
      }

      const responseData = await response.json();
      const rawText = parseGeminiResponseText(responseData);
      if (!rawText) {
        const error = new Error(`Gemini returned an empty response for ${modelName}`);
        error.retryable = true;
        throw error;
      }

      const cleanedText = extractJsonObjectText(stripCodeFences(rawText));

      try {
        return JSON.parse(cleanedText);
      } catch (parseError) {
        const finishReason = responseData?.candidates?.[0]?.finishReason;
        const error = new SyntaxError(
          `Gemini returned invalid JSON for ${modelName}: ${parseError.message}`
        );
        error.retryable = true;
        error.finishReason = finishReason;
        error.rawTextPreview = cleanedText.slice(0, 300);
        throw error;
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(
          `Gemini request timed out for ${modelName} after ${GEMINI_CONFIG.REQUEST_TIMEOUT_MS}ms`
        );
        timeoutError.retryable = true;
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Retry Gemini across configured models until one returns valid assignments.
  const requestGeminiAssignments = async (
    prompt,
    apiKey,
    tabCount,
    existingGroupCount
  ) => {
    let lastError = null;
    const maxOutputTokens = getGeminiMaxOutputTokens(tabCount, existingGroupCount);

    for (let index = 0; index < GEMINI_CONFIG.MODELS.length; index++) {
      const modelName = GEMINI_CONFIG.MODELS[index];

      try {
        const result = await requestGeminiAssignmentsForModel(
          prompt,
          apiKey,
          modelName,
          maxOutputTokens,
          true
        );
        console.log(
          `[TabSort][Gemini] Grouping succeeded with ${modelName} (${maxOutputTokens} max output tokens).`
        );
        return result;
      } catch (error) {
        let effectiveError = error;

        if (shouldRetryGeminiWithoutStructuredOutput(error)) {
          console.warn(
            `[TabSort][Gemini] ${modelName} rejected structured output. Retrying without schema.`
          );

          try {
            const fallbackResult = await requestGeminiAssignmentsForModel(
              prompt,
              apiKey,
              modelName,
              maxOutputTokens,
              false
            );
            console.log(
              `[TabSort][Gemini] Grouping succeeded with ${modelName} without structured output.`
            );
            return fallbackResult;
          } catch (fallbackError) {
            effectiveError = fallbackError;
            console.warn(
              `[TabSort][Gemini] ${modelName} without structured output failed: ${
                fallbackError?.message || fallbackError
              }`
            );
          }
        }

        lastError = effectiveError;
        const hasMoreModels = index < GEMINI_CONFIG.MODELS.length - 1;

        console.warn(
          `[TabSort][Gemini] ${modelName} failed: ${
            effectiveError?.message || effectiveError
          }`
        );

        if (effectiveError?.rawTextPreview) {
          console.warn(
            `[TabSort][Gemini] ${modelName} raw response preview:`,
            effectiveError.rawTextPreview
          );
        }

        if (!hasMoreModels || !effectiveError?.retryable) {
          throw effectiveError;
        }

        console.warn(
          `[TabSort][Gemini] Retrying with fallback model ${GEMINI_CONFIG.MODELS[index + 1]}.`
        );
      }
    }

    throw lastError || new Error("Gemini request failed for all configured models");
  };

  // Turn the shared provider context into final tab-topic assignments via Gemini.
  const assignTopicsWithGemini = async (context) => {
    if (!Array.isArray(context?.tabs) || context.tabs.length === 0) return [];

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      console.warn("[TabSort][Gemini] Missing API key, provider unavailable.");
      return null;
    }

    const currentWorkspaceId = context.workspaceId;
    const existingWorkspaceGroups =
      context.existingWorkspaceGroups ||
      getExistingWorkspaceGroups(currentWorkspaceId);

    const tabRecords = context.tabs.map((tab, index) => {
      const navigationInfo = getTabNavigationInfo(tab);
      return {
        id: `t${index + 1}`,
        tab,
        title: truncateText(getTabTitle(tab), GEMINI_CONFIG.MAX_TITLE_LENGTH),
        host: navigationInfo.host,
        pathHint: truncateText(
          navigationInfo.pathHint,
          GEMINI_CONFIG.MAX_PATH_HINT_LENGTH
        ),
      };
    });

    const prompt = buildGeminiPrompt(
      tabRecords,
      Array.from(existingWorkspaceGroups.entries()).map(([groupName, groupInfo]) => ({
        name: groupName,
        sampleTitles: groupInfo.tabTitles
          .slice(0, GEMINI_CONFIG.MAX_GROUP_SAMPLE_TITLES)
          .map((title) => truncateText(title, GEMINI_CONFIG.MAX_TITLE_LENGTH)),
      }))
    );

    try {
      const responseData = await requestGeminiAssignments(
        prompt,
        apiKey,
        tabRecords.length,
        existingWorkspaceGroups.size
      );
      if (!Array.isArray(responseData?.assignments)) {
        throw new Error("Gemini returned an invalid assignments payload");
      }

      const tabMap = new Map(tabRecords.map((record) => [record.id, record]));
      const seenTabIds = new Set();

      return responseData.assignments
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
    } catch (error) {
      console.error("[TabSort][Gemini] Error grouping tabs:", error);
      return null;
    }
  };

  ns.registerProvider({
    id: PROVIDERS.GEMINI,
    isCloud: true,
    assignTopics: assignTopicsWithGemini,
  });

  Object.assign(ns, {
    buildGeminiPrompt,
    requestGeminiAssignmentsForModel,
    requestGeminiAssignments,
  });
})();

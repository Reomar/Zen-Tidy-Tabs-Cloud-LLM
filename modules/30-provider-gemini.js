(() => {
  // Implement the Gemini cloud provider and register it with the runtime.
  const ns = window.BetterTidyTabs;
  const { PROVIDERS, GEMINI_CONFIG } = ns;
  const {
    buildCloudAssignmentsPrompt,
    buildCloudTabRecords,
    buildExistingGroupPromptRecords,
    createProviderError,
    getCloudMaxOutputTokens,
    getExistingWorkspaceGroups,
    getGeminiApiKey,
    hasValidAssignmentsPayload,
    mapProviderAssignments,
    parseAssignmentsPayloadText,
  } = ns;

  // Build the full Gemini prompt from tabs, existing groups, and icon choices.
  const buildGeminiPrompt = (tabRecords, existingGroups) =>
    buildCloudAssignmentsPrompt(tabRecords, existingGroups);

  // Flatten Gemini response parts into one plain text payload.
  const parseGeminiResponseText = (responseData) => {
    const parts = responseData?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  };

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
      // Gemini can sometimes enforce JSON schema output directly, which reduces
      // parse failures when the model variant supports the field.
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
        const error = createProviderError(PROVIDERS.GEMINI, "", {
          status: response.status,
          retryable: isRetryableGeminiStatus(response.status),
          rawTextPreview: errorText.slice(0, 300),
        });
        error.message = `Gemini request failed for ${modelName} with status ${response.status}${
          errorText ? `: ${errorText}` : ""
        }`;
        throw error;
      }

      const responseData = await response.json();
      const rawText = parseGeminiResponseText(responseData);
      if (!rawText) {
        throw createProviderError(
          PROVIDERS.GEMINI,
          `Gemini returned an empty response for ${modelName}`,
          { retryable: true }
        );
      }

      try {
        return parseAssignmentsPayloadText(rawText);
      } catch (parseError) {
        const finishReason = responseData?.candidates?.[0]?.finishReason;
        const error = createProviderError(
          PROVIDERS.GEMINI,
          `Gemini returned invalid JSON for ${modelName}: ${parseError.message}`,
          {
            cause: parseError,
            retryable: true,
            rawTextPreview: rawText.slice(0, 300),
          }
        );
        error.finishReason = finishReason;
        throw error;
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw createProviderError(
          PROVIDERS.GEMINI,
          `Gemini request timed out for ${modelName} after ${GEMINI_CONFIG.REQUEST_TIMEOUT_MS}ms`,
          { retryable: true }
        );
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
    const maxOutputTokens = getCloudMaxOutputTokens(
      tabCount,
      existingGroupCount
    );

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
    const tabRecords = buildCloudTabRecords(context.tabs);
    const prompt = buildGeminiPrompt(
      tabRecords,
      buildExistingGroupPromptRecords(existingWorkspaceGroups)
    );

    const responseData = await requestGeminiAssignments(
      prompt,
      apiKey,
      tabRecords.length,
      existingWorkspaceGroups.size
    );

    if (!hasValidAssignmentsPayload(responseData)) {
      throw createProviderError(
        PROVIDERS.GEMINI,
        "Gemini returned an invalid assignments payload"
      );
    }

    return mapProviderAssignments(responseData.assignments, tabRecords);
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

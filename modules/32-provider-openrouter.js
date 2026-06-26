(() => {
  // Implement the OpenRouter cloud provider and register it with the runtime.
  const ns = window.BetterTidyTabs;
  const { PROVIDERS, OPENROUTER_CONFIG } = ns;
  const {
    buildCloudAssignmentsPrompt,
    buildCloudTabRecords,
    buildExistingGroupPromptRecords,
    createProviderError,
    formatProviderLabel,
    getExistingWorkspaceGroups,
    getOpenRouterApiKey,
    getOpenRouterModel,
    hasValidAssignmentsPayload,
    mapProviderAssignments,
    parseAssignmentsPayloadText,
    setProviderFeedback,
  } = ns;

  // Keep OpenRouter requests smaller than Gemini because free routed models
  // are more sensitive to cold starts and long completion budgets.
  const getOpenRouterMaxOutputTokens = (tabCount, existingGroupCount = 0) =>
    Math.min(
      OPENROUTER_CONFIG.MAX_OUTPUT_TOKENS,
      Math.max(
        OPENROUTER_CONFIG.BASE_OUTPUT_TOKENS,
        OPENROUTER_CONFIG.BASE_OUTPUT_TOKENS +
          tabCount * OPENROUTER_CONFIG.OUTPUT_TOKENS_PER_TAB +
          existingGroupCount *
            OPENROUTER_CONFIG.OUTPUT_TOKENS_PER_EXISTING_GROUP
      )
    );

  // Read the message content from an OpenRouter chat completions response.
  const parseOpenRouterResponseText = (responseData) => {
    const content = responseData?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();

    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part?.text === "string"
            ? part.text
            : typeof part === "string"
              ? part
              : ""
        )
        .join("")
        .trim();
    }

    return "";
  };

  // Mark HTTP statuses that should be described as transient failures.
  const isRetryableOpenRouterStatus = (status) =>
    [408, 429, 500, 502, 503, 504].includes(status);

  // Convert OpenRouter API failures into short user-facing feedback.
  const buildOpenRouterFailureFeedback = (
    message,
    status = null,
    errorCode = ""
  ) => {
    const normalizedMessage =
      typeof message === "string"
        ? message.toLowerCase()
        : String(message || "").toLowerCase();
    const normalizedCode =
      typeof errorCode === "string"
        ? errorCode.toLowerCase()
        : String(errorCode || "").toLowerCase();

    if (status === 401 || status === 403) {
      return "OpenRouter rejected the API key. Using Firefox local AI instead.";
    }

    if (status === 404) {
      return "OpenRouter model name is invalid or unavailable. Using Firefox local AI instead.";
    }

    if (status === 429 || normalizedCode === "rate_limit_exceeded") {
      return "OpenRouter rate limited the request. Using Firefox local AI instead.";
    }

    if (
      normalizedCode === "invalid_prompt" ||
      status === 400 ||
      normalizedMessage.includes("invalid") ||
      normalizedMessage.includes("missing required parameter")
    ) {
      return "OpenRouter rejected the request or model name. Using Firefox local AI instead.";
    }

    if (status >= 500 || normalizedCode === "server_error") {
      return "OpenRouter is temporarily unavailable. Using Firefox local AI instead.";
    }

    return "OpenRouter failed. Using Firefox local AI instead.";
  };

  // Parse an unsuccessful OpenRouter response into a structured provider error.
  const buildOpenRouterHttpError = async (response, modelName) => {
    let errorText = "";
    let errorCode = "";
    let errorMessage = "";

    try {
      const responseText = await response.text();
      errorText = responseText || "";
      const parsed = responseText ? JSON.parse(responseText) : null;
      errorCode = parsed?.error?.code || "";
      errorMessage = parsed?.error?.message || "";
    } catch {
      // Fall back to plain text if the response body is not valid JSON.
    }

    const userMessage = buildOpenRouterFailureFeedback(
      errorMessage || errorText,
      response.status,
      errorCode
    );
    const error = createProviderError(PROVIDERS.OPENROUTER, userMessage, {
      status: response.status,
      retryable: isRetryableOpenRouterStatus(response.status),
      rawTextPreview: (errorText || errorMessage).slice(0, 300),
    });

    error.message = `OpenRouter request failed for ${modelName} with status ${response.status}${
      errorMessage ? `: ${errorMessage}` : errorText ? `: ${errorText}` : ""
    }`;
    error.errorCode = errorCode;
    return error;
  };

  // Send one OpenRouter request and parse assignments from the response.
  const requestOpenRouterAssignments = async (
    prompt,
    apiKey,
    modelName,
    maxOutputTokens
  ) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OPENROUTER_CONFIG.REQUEST_TIMEOUT_MS
    );

    try {
      console.log(
        `[TabSort][OpenRouter] Sending request for ${modelName} with ${maxOutputTokens} max output tokens and ${prompt.length} prompt chars.`
      );

      const response = await fetch(OPENROUTER_CONFIG.API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": OPENROUTER_CONFIG.APP_URL,
          "X-OpenRouter-Title": OPENROUTER_CONFIG.APP_TITLE,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: "system",
              content:
                "You are a tab-grouping assistant. Return only valid JSON.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: maxOutputTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw await buildOpenRouterHttpError(response, modelName);
      }

      const responseData = await response.json();
      const rawText = parseOpenRouterResponseText(responseData);
      if (!rawText) {
        throw createProviderError(
          PROVIDERS.OPENROUTER,
          "OpenRouter returned an empty response. Using Firefox local AI instead.",
          { retryable: true }
        );
      }

      try {
        return parseAssignmentsPayloadText(rawText);
      } catch (parseError) {
        throw createProviderError(
          PROVIDERS.OPENROUTER,
          "OpenRouter returned an invalid response. Using Firefox local AI instead.",
          {
            cause: parseError,
            retryable: true,
            rawTextPreview: rawText.slice(0, 300),
          }
        );
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw createProviderError(
          PROVIDERS.OPENROUTER,
          `OpenRouter request timed out after ${
            OPENROUTER_CONFIG.REQUEST_TIMEOUT_MS / 1000
          }s. Using Firefox local AI instead.`,
          { retryable: true }
        );
      }

      if (error instanceof TypeError) {
        throw createProviderError(
          PROVIDERS.OPENROUTER,
          "OpenRouter network request failed. Using Firefox local AI instead.",
          { cause: error, retryable: true }
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Turn the shared provider context into final tab-topic assignments via OpenRouter.
  const assignTopicsWithOpenRouter = async (context) => {
    if (!Array.isArray(context?.tabs) || context.tabs.length === 0) return [];

    const providerLabel = formatProviderLabel(PROVIDERS.OPENROUTER);
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      setProviderFeedback({
        providerId: PROVIDERS.OPENROUTER,
        title: providerLabel,
        message: "OpenRouter API key is missing. Using Firefox local AI instead.",
      });
      return null;
    }

    const modelName = getOpenRouterModel();
    if (!modelName) {
      setProviderFeedback({
        providerId: PROVIDERS.OPENROUTER,
        title: providerLabel,
        message:
          "OpenRouter model name is missing. Using Firefox local AI instead.",
      });
      return null;
    }

    const currentWorkspaceId = context.workspaceId;
    const existingWorkspaceGroups =
      context.existingWorkspaceGroups ||
      getExistingWorkspaceGroups(currentWorkspaceId);
    const tabRecords = buildCloudTabRecords(context.tabs);
    const prompt = buildCloudAssignmentsPrompt(
      tabRecords,
      buildExistingGroupPromptRecords(existingWorkspaceGroups)
    );
    const responseData = await requestOpenRouterAssignments(
      prompt,
      apiKey,
      modelName,
      getOpenRouterMaxOutputTokens(
        tabRecords.length,
        existingWorkspaceGroups.size
      )
    );

    if (!hasValidAssignmentsPayload(responseData)) {
      throw createProviderError(
        PROVIDERS.OPENROUTER,
        "OpenRouter returned an invalid assignments payload. Using Firefox local AI instead."
      );
    }

    return mapProviderAssignments(responseData.assignments, tabRecords);
  };

  ns.registerProvider({
    id: PROVIDERS.OPENROUTER,
    isCloud: true,
    assignTopics: assignTopicsWithOpenRouter,
  });

  Object.assign(ns, {
    requestOpenRouterAssignments,
  });
})();

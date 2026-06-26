(() => {
  // Manage UI injection, commands, hooks, listeners, startup, and cleanup.
  const ns = window.BetterTidyTabs;
  const { CONFIG, state, domCache } = ns;
  const {
    batchDOMUpdates,
    cleanupAnimation,
    getFilteredTabs,
    sortTabsByTopic,
  } = ns;

  // Ensure the separator line and brush button exist for a workspace separator.
  function ensureSortButtonExists(separator) {
    if (!separator) {
      return;
    }

    try {
      if (!separator.querySelector("svg.separator-line-svg")) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("class", "separator-line-svg");
        svg.setAttribute("viewBox", "0 0 100 2");
        svg.setAttribute("preserveAspectRatio", "none");

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("id", "separator-path");
        path.setAttribute("class", "separator-path-segment");
        path.setAttribute("d", "M 0 1 L 100 1");
        path.style.fill = "none";
        path.style.opacity = "1";
        path.setAttribute("stroke-width", "1");
        path.setAttribute("stroke-linecap", "round");
        svg.appendChild(path);

        separator.insertBefore(svg, separator.firstChild);
      }

      if (!separator.querySelector("#sort-button")) {
        const nativeClearButton = separator.querySelector(
          ".zen-workspace-close-unpinned-tabs-button"
        );
        const buttonFragment = window.MozXULElement.parseXULToFragment(`
          <toolbarbutton
            id="sort-button"
            class="sort-button-with-icon"
            command="cmd_zenSortTabs"
            tooltiptext="Sort Tabs into Groups by Topic (AI)">
            <hbox class="toolbarbutton-box" align="center">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 28 28" class="broom-icon">
                <g>
                  <path d="M19.9132 21.3765C19.8875 21.0162 19.6455 20.7069 19.3007 20.5993L7.21755 16.8291C6.87269 16.7215 6.49768 16.8384 6.27165 17.1202C5.73893 17.7845 4.72031 19.025 3.78544 19.9965C2.4425 21.392 3.01177 22.4772 4.66526 22.9931C4.82548 23.0431 5.78822 21.7398 6.20045 21.7398C6.51906 21.8392 6.8758 23.6828 7.26122 23.8031C7.87402 23.9943 8.55929 24.2081 9.27891 24.4326C9.59033 24.5298 10.2101 23.0557 10.5313 23.1559C10.7774 23.2327 10.7236 24.8834 10.9723 24.961C11.8322 25.2293 12.699 25.4997 13.5152 25.7544C13.868 25.8645 14.8344 24.3299 15.1637 24.4326C15.496 24.5363 15.191 26.2773 15.4898 26.3705C16.7587 26.7664 17.6824 27.0546 17.895 27.1209C19.5487 27.6369 20.6333 27.068 20.3226 25.1563C20.1063 23.8255 19.9737 22.2258 19.9132 21.3765Z" stroke="none"/>
                  <path d="M16.719 1.7134C17.4929-0.767192 20.7999 0.264626 20.026 2.74523C19.2521 5.22583 18.1514 8.75696 17.9629 9.36C17.7045 10.1867 16.1569 15.1482 15.899 15.9749L19.2063 17.0068C20.8597 17.5227 20.205 19.974 18.4514 19.4268L8.52918 16.331C6.87208 15.8139 7.62682 13.3938 9.28426 13.911L12.5916 14.9429C12.8495 14.1163 14.3976 9.15491 14.6555 8.32807C14.9135 7.50122 15.9451 4.19399 16.719 1.7134Z" stroke="none"/>
                </g>
              </svg>
            </hbox>
          </toolbarbutton>
        `);
        const buttonNode = buttonFragment.firstChild.cloneNode(true);

        if (nativeClearButton) {
          separator.insertBefore(buttonNode, nativeClearButton);
        } else {
          separator.appendChild(buttonNode);
        }
      }
    } catch (error) {
      console.error("[TabSort] Failed to ensure sort button exists:", error);
    }
  }

  // Inject the sort button into every visible separator and refresh visibility.
  function addSortButtonToAllSeparators() {
    domCache.invalidate();

    const separators = Array.from(domCache.getSeparators());
    if (separators.length > 0) {
      separators.forEach(ensureSortButtonExists);
      updateButtonsVisibilityState();
    } else {
      const periphery = document.querySelector("#tabbrowser-arrowscrollbox-periphery");
      if (periphery && !periphery.querySelector("#sort-button")) {
        ensureSortButtonExists(periphery);
      }
    }

    updateButtonsVisibilityState();
  }

  // Start the normal sort-in-progress wave animation on the active separator.
  const startSortWaveAnimation = (separator) => {
    const pathElement = separator?.querySelector("#separator-path");
    if (!pathElement) {
      return;
    }

    const maxAmplitude = 3;
    const frequency = 8;
    const segments = 50;
    const growthDuration = 500;
    let t = 0;
    const startTime = performance.now();

    // Animate the separator line while sorting is in progress.
    function animateWaveLoop(timestamp) {
      if (state.sortAnimationId === null) return;

      const elapsedTime = timestamp - startTime;
      const growthProgress = Math.min(elapsedTime / growthDuration, 1);
      const currentAmplitude = maxAmplitude * growthProgress;

      t += 0.5;

      const points = [];
      for (let index = 0; index <= segments; index++) {
        const x = (index / segments) * 100;
        const y =
          1 +
          currentAmplitude *
            Math.sin((x / (100 / frequency)) * 2 * Math.PI + t * 0.1);
        points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }

      if (pathElement?.isConnected) {
        pathElement.setAttribute("d", "M" + points.join(" L"));
        state.sortAnimationId = requestAnimationFrame(animateWaveLoop);
      } else {
        state.sortAnimationId = null;
      }
    }

    state.sortAnimationId = requestAnimationFrame(animateWaveLoop);
  };

  // Create the command and bind the global sort button event listener once.
  function setupSortCommandAndListener() {
    const zenCommands = domCache.getCommandSet();
    if (!zenCommands) return;

    if (!zenCommands.querySelector("#cmd_zenSortTabs")) {
      try {
        const command = window.MozXULElement.parseXULToFragment(
          `<command id="cmd_zenSortTabs"/>`
        ).firstChild;
        zenCommands.appendChild(command);
      } catch (error) {
        console.error("[TabSort] Failed creating sort command:", error);
      }
    }

    if (!state.sortButtonListenerAdded) {
      state.commandHandler = (event) => {
        if (event.target.id !== "cmd_zenSortTabs") {
          return;
        }

        const activeWorkspace = window.gZenWorkspaces?.activeWorkspaceElement;
        const separator = activeWorkspace?.querySelector(
          ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
        );

        const sortButton = separator?.querySelector("#sort-button");
        if (sortButton) {
          sortButton.classList.add("brushing");
          setTimeout(() => {
            if (sortButton?.isConnected) {
              sortButton.classList.remove("brushing");
            }
          }, CONFIG.ANIMATION_DURATION);
        }

        if (state.sortAnimationId !== null) return;

        if (!separator) {
          sortTabsByTopic();
          return;
        }

        startSortWaveAnimation(separator);
        sortTabsByTopic();
      };

      zenCommands.addEventListener("command", state.commandHandler);
      state.sortButtonListenerAdded = true;
    }
  }

  // Patch Zen workspace lifecycle methods so injected UI survives workspace updates.
  function setupgZenWorkspacesHooks() {
    if (
      typeof window.gZenWorkspaces === "undefined" ||
      state.workspaceHooksInstalled
    ) {
      return;
    }

    state.workspaceHooksOriginals = {
      onTabBrowserInserted: window.gZenWorkspaces.onTabBrowserInserted,
      updateTabsContainers: window.gZenWorkspaces.updateTabsContainers,
    };

    window.gZenWorkspaces.onTabBrowserInserted = function (event) {
      const original = state.workspaceHooksOriginals?.onTabBrowserInserted;
      if (typeof original === "function") {
        try {
          original.call(window.gZenWorkspaces, event);
        } catch (error) {
          console.error(
            "SORT BTN HOOK: Error in original onTabBrowserInserted:",
            error
          );
        }
      }

      addSortButtonToAllSeparators();
      updateButtonsVisibilityState();
    };

    window.gZenWorkspaces.updateTabsContainers = function (...args) {
      const original = state.workspaceHooksOriginals?.updateTabsContainers;
      if (typeof original === "function") {
        try {
          original.apply(window.gZenWorkspaces, args);
        } catch (error) {
          console.error(
            "SORT BTN HOOK: Error in original updateTabsContainers:",
            error
          );
        }
      }

      addSortButtonToAllSeparators();
      updateButtonsVisibilityState();
    };

    state.workspaceHooksInstalled = true;
  }

  // Override Zen's clear action so grouped tabs are preserved.
  function patchClearButtonToPreserveGroups() {
    if (
      typeof window.gZenWorkspaces === "undefined" ||
      state.clearPatchInstalled
    ) {
      return;
    }

    const originalCloseAllUnpinnedTabs = window.gZenWorkspaces.closeAllUnpinnedTabs;
    if (typeof originalCloseAllUnpinnedTabs !== "function") {
      console.warn("[TidyTabs] closeAllUnpinnedTabs method not found");
      return;
    }

    state.clearButtonOriginal = originalCloseAllUnpinnedTabs;

    window.gZenWorkspaces.closeAllUnpinnedTabs = function () {
      try {
        const currentWorkspaceId = this.activeWorkspace;
        if (!currentWorkspaceId) {
          console.warn("[TidyTabs] No active workspace found");
          return;
        }

        const allTabs = Array.from(gBrowser.tabs).filter(
          (tab) => tab.getAttribute("zen-workspace-id") === currentWorkspaceId
        );

        const tabsToClose = allTabs.filter((tab) => {
          if (!tab || !tab.isConnected) return false;
          if (tab.selected || tab.pinned) return false;
          if (tab.hasAttribute("zen-essential")) return false;
          if (tab.hasAttribute("zen-empty-tab")) return false;
          if (tab.hasAttribute("zen-glance-tab")) return false;

          if (tab.group) {
            if (tab.group.isZenFolder || tab.group.tagName === "zen-folder") {
              return false;
            }
            if (
              tab.group.tagName === "tab-group" &&
              !tab.group.hasAttribute("split-view-group")
            ) {
              return false;
            }
          }

          return true;
        });

        if (tabsToClose.length > 0) {
          gBrowser.removeTabs(tabsToClose);

          if (typeof gZenUIManager !== "undefined" && gZenUIManager.showToast) {
            gZenUIManager.showToast(
              "zen-workspaces-close-all-unpinned-tabs-toast",
              {
                shortcut: "Ctrl+Shift+T",
              }
            );
          }
        }
      } catch (error) {
        console.error("[TidyTabs] Error in patched closeAllUnpinnedTabs:", error);
        if (typeof state.clearButtonOriginal === "function") {
          state.clearButtonOriginal.call(this);
        }
      }
    };

    state.clearPatchInstalled = true;
  }

  // Count grouped and ungrouped tabs to decide whether the sort button should show.
  const countTabsForButtonVisibility = () => {
    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;

    if (
      !currentWorkspaceId ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabs
    ) {
      return {
        ungroupedTotal: 0,
        ungroupedNonSelected: 0,
        hasGroupedTabs: false,
      };
    }

    let ungroupedTotal = 0;
    let ungroupedNonSelected = 0;
    let hasGroupedTabs = false;

    const allTabs = getFilteredTabs(currentWorkspaceId, {
      includeGrouped: true,
      includeSelected: true,
      includePinned: false,
      includeEmpty: false,
      includeGlance: false,
    });

    for (const tab of allTabs) {
      const isInGroup = !!tab.closest("tab-group");
      if (isInGroup) {
        hasGroupedTabs = true;
      } else {
        ungroupedTotal++;
        if (!tab.selected) {
          ungroupedNonSelected++;
        }
      }
    }

    return {
      ungroupedTotal,
      ungroupedNonSelected,
      hasGroupedTabs,
    };
  };

  // Update the sort button visibility and tooltip for each workspace separator.
  const updateButtonsVisibilityState = () => {
    const { ungroupedTotal, hasGroupedTabs } = countTabsForButtonVisibility();
    const separators = Array.from(domCache.getSeparators());

    batchDOMUpdates([
      () => {
        separators.forEach((separator) => {
          if (!separator?.isConnected) return;

          const tidyButton = separator.querySelector("#sort-button");
          if (tidyButton) {
            const shouldShowTidyButton = hasGroupedTabs
              ? ungroupedTotal > 0
              : ungroupedTotal >= CONFIG.MIN_TABS_FOR_SORT;

            if (shouldShowTidyButton) {
              tidyButton.classList.remove("hidden-button");
              if (hasGroupedTabs && ungroupedTotal > 0) {
                tidyButton.setAttribute(
                  "tooltiptext",
                  ungroupedTotal === 1
                    ? "Sort Tab into Existing Groups by Topic (AI)"
                    : "Sort Tabs into Groups by Topic (AI)"
                );
              } else {
                tidyButton.setAttribute(
                  "tooltiptext",
                  "Sort Tabs into Groups by Topic (AI)"
                );
              }
            } else {
              tidyButton.classList.add("hidden-button");
            }
          }

          separator.classList.remove("has-no-sortable-tabs");
        });
      },
    ]);
  };

  // Listen for tab and workspace changes that affect button visibility.
  function addTabEventListeners() {
    if (
      state.eventListenersAdded ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabContainer
    ) {
      return;
    }

    state.tabEventHandler = debounce(
      updateButtonsVisibilityState,
      CONFIG.DEBOUNCE_DELAY
    );
    state.workspaceSwitchHandler = state.tabEventHandler;

    const events = [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabPinned",
      "TabUnpinned",
      "TabGroupAdd",
      "TabGroupRemove",
      "TabGrouped",
      "TabUngrouped",
      "TabAttrModified",
    ];

    events.forEach((eventName) => {
      gBrowser.tabContainer.addEventListener(eventName, state.tabEventHandler);
    });

    if (typeof window.gZenWorkspaces !== "undefined") {
      window.addEventListener(
        "zen-workspace-switched",
        state.workspaceSwitchHandler
      );
    }

    state.eventListenersAdded = true;
  }

  // Debounce noisy UI events so visibility recalculations stay cheap.
  function debounce(func, wait) {
    if (typeof func !== "function" || typeof wait !== "number") {
      return () => {};
    }

    let timeout;
    return function executedFunction(...args) {
      // Run the debounced callback after the event burst settles.
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Remove listeners, restore hooks, and clear cached runtime state.
  const cleanup = () => {
    try {
      cleanupAnimation();

      if (state.initIntervalId !== null) {
        clearInterval(state.initIntervalId);
        state.initIntervalId = null;
      }

      if (state.sortButtonListenerAdded && state.commandHandler) {
        domCache.getCommandSet()?.removeEventListener("command", state.commandHandler);
      }

      if (
        state.eventListenersAdded &&
        typeof gBrowser !== "undefined" &&
        gBrowser.tabContainer &&
        state.tabEventHandler
      ) {
        [
          "TabOpen",
          "TabClose",
          "TabSelect",
          "TabPinned",
          "TabUnpinned",
          "TabGroupAdd",
          "TabGroupRemove",
          "TabGrouped",
          "TabUngrouped",
          "TabAttrModified",
        ].forEach((eventName) => {
          gBrowser.tabContainer.removeEventListener(eventName, state.tabEventHandler);
        });
      }

      if (state.workspaceSwitchHandler) {
        window.removeEventListener(
          "zen-workspace-switched",
          state.workspaceSwitchHandler
        );
      }

      if (state.workspaceHooksInstalled && window.gZenWorkspaces) {
        if (state.workspaceHooksOriginals?.onTabBrowserInserted) {
          window.gZenWorkspaces.onTabBrowserInserted =
            state.workspaceHooksOriginals.onTabBrowserInserted;
        }
        if (state.workspaceHooksOriginals?.updateTabsContainers) {
          window.gZenWorkspaces.updateTabsContainers =
            state.workspaceHooksOriginals.updateTabsContainers;
        }
      }

      if (state.clearPatchInstalled && window.gZenWorkspaces && state.clearButtonOriginal) {
        window.gZenWorkspaces.closeAllUnpinnedTabs = state.clearButtonOriginal;
      }

      if (state.loadHandler) {
        window.removeEventListener("load", state.loadHandler);
      }
      if (state.unloadHandler) {
        window.removeEventListener("unload", state.unloadHandler);
      }
      if (state.beforeUnloadHandler) {
        window.removeEventListener("beforeunload", state.beforeUnloadHandler);
      }

      domCache.invalidate();
      state.embeddingCache.clear();
      state.isSorting = false;
      state.sortButtonListenerAdded = false;
      state.eventListenersAdded = false;
      state.commandHandler = null;
      state.tabEventHandler = null;
      state.workspaceSwitchHandler = null;
      state.workspaceHooksInstalled = false;
      state.workspaceHooksOriginals = null;
      state.clearPatchInstalled = false;
      state.clearButtonOriginal = null;
      state.loadHandler = null;
      state.unloadHandler = null;
      state.beforeUnloadHandler = null;
      state.initialized = false;

      console.log("Tab sort script cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  };

  // Wait for Zen browser UI dependencies and then wire up the mod runtime.
  function initializeScript() {
    // Try to initialize immediately when the needed browser surfaces are ready.
    const tryInitialize = () => {
      try {
        if (state.initialized) {
          addSortButtonToAllSeparators();
          updateButtonsVisibilityState();
          return true;
        }

        const separatorExists = domCache.getSeparators().length > 0;
        const commandSetExists = !!domCache.getCommandSet();
        const gBrowserReady =
          typeof gBrowser !== "undefined" && gBrowser?.tabContainer;
        const gZenWorkspacesReady =
          typeof window.gZenWorkspaces !== "undefined";

        if (
          gBrowserReady &&
          commandSetExists &&
          separatorExists &&
          gZenWorkspacesReady
        ) {
          setupSortCommandAndListener();
          addSortButtonToAllSeparators();
          setupgZenWorkspacesHooks();
          patchClearButtonToPreserveGroups();
          updateButtonsVisibilityState();
          addTabEventListeners();
          state.initialized = true;
          return true;
        }
      } catch (error) {
        console.error("Error during initialization:", error);
      }

      return false;
    };

    if (tryInitialize()) {
      return;
    }

    let checkCount = 0;
    state.initIntervalId = setInterval(() => {
      checkCount++;

      if (tryInitialize()) {
        clearInterval(state.initIntervalId);
        state.initIntervalId = null;
      } else if (checkCount > CONFIG.MAX_INIT_CHECKS) {
        clearInterval(state.initIntervalId);
        state.initIntervalId = null;
        console.warn(
          `Tab sort initialization timed out after ${
            CONFIG.MAX_INIT_CHECKS * CONFIG.INIT_CHECK_INTERVAL
          }ms`
        );
      }
    }, CONFIG.INIT_CHECK_INTERVAL);
  }

  // Start the runtime and attach load/unload hooks for the current window.
  const start = () => {
    state.unloadHandler = cleanup;
    state.beforeUnloadHandler = cleanup;
    window.addEventListener("unload", state.unloadHandler, { once: true });
    window.addEventListener("beforeunload", state.beforeUnloadHandler, {
      once: true,
    });

    if (document.readyState === "complete") {
      initializeScript();
    } else {
      state.loadHandler = () => {
        state.loadHandler = null;
        initializeScript();
      };
      window.addEventListener("load", state.loadHandler, { once: true });
    }
  };

  Object.assign(ns, {
    ensureSortButtonExists,
    addSortButtonToAllSeparators,
    setupSortCommandAndListener,
    setupgZenWorkspacesHooks,
    patchClearButtonToPreserveGroups,
    countTabsForButtonVisibility,
    updateButtonsVisibilityState,
    addTabEventListeners,
    debounce,
    cleanup,
    initializeScript,
    start,
  });
})();

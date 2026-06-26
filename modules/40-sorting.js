(() => {
  // Coordinate provider selection, fallback behavior, tab grouping, and reordering.
  const ns = window.BetterTidyTabs;
  const { PROVIDERS, state, domCache } = ns;
  const {
    batchDOMUpdates,
    buildProviderContext,
    getPreferredAIProvider,
    getFilteredTabs,
    normalizeTopicKey,
    buildFinalGroupsFromAssignments,
    applyATGGroupIconIfNeeded,
    findGroupElement,
    getTabTitle,
  } = ns;

  // Route tab grouping through the selected provider and fall back to local AI.
  const askAIForMultipleTopics = async (tabs) => {
    const context = buildProviderContext(tabs);
    if (context.tabs.length === 0) {
      return [];
    }

    const localProvider = ns.getProvider(PROVIDERS.FIREFOX_LOCAL);
    if (!localProvider) {
      console.error("[TabSort] Local provider is not registered.");
      return [];
    }

    const preferredProviderId = getPreferredAIProvider();
    const preferredProvider = ns.getProvider(preferredProviderId) || localProvider;

    if (preferredProvider.id !== PROVIDERS.FIREFOX_LOCAL) {
      const cloudAssignments = await preferredProvider.assignTopics(context);
      if (Array.isArray(cloudAssignments)) {
        return cloudAssignments;
      }

      console.warn(
        `[TabSort] Falling back to Firefox local AI after ${preferredProvider.id} was unavailable.`
      );
    }

    return localProvider.assignTopics(context);
  };

  // Stop any running separator animation and reset the line to a resting state.
  const cleanupAnimation = () => {
    if (state.isPlayingFailureAnimation) {
      return;
    }

    if (state.sortAnimationId !== null) {
      cancelAnimationFrame(state.sortAnimationId);
      state.sortAnimationId = null;

      try {
        const activeWorkspace = window.gZenWorkspaces?.activeWorkspaceElement;
        const activeSeparator = activeWorkspace?.querySelector(
          ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
        );
        const pathElement = activeSeparator?.querySelector("#separator-path");
        if (pathElement) {
          pathElement.setAttribute("d", "M 0 1 L 100 1");
        }
      } catch (error) {
        console.error("Error resetting animation:", error);
      }
    }
  };

  // Play the failure animation when no useful assignments were produced.
  const startFailureAnimation = () => {
    if (state.sortAnimationId !== null) {
      cancelAnimationFrame(state.sortAnimationId);
    }

    state.isPlayingFailureAnimation = true;

    try {
      const activeWorkspace = window.gZenWorkspaces?.activeWorkspaceElement;
      const activeSeparator = activeWorkspace?.querySelector(
        ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
      );
      const pathElement = activeSeparator?.querySelector("#separator-path");

      if (pathElement) {
        const maxAmplitude = 8;
        const frequency = 20;
        const segments = 100;
        const pulseDuration = 400;
        const totalPulses = 3;
        let currentPulse = 0;
        let t = 0;
        let pulseStartTime = performance.now();

        // Animate the separator with sharp pulses to show a failed sort attempt.
        function animateFailureLoop(timestamp) {
          if (state.sortAnimationId === null) return;

          const elapsedSincePulseStart = timestamp - pulseStartTime;
          const pulseProgress = elapsedSincePulseStart / pulseDuration;

          if (pulseProgress >= 1) {
            currentPulse++;
            if (currentPulse >= totalPulses) {
              pathElement.setAttribute("d", "M 0 1 L 100 1");
              state.sortAnimationId = null;
              state.isPlayingFailureAnimation = false;
              return;
            }

            pulseStartTime = timestamp;
          }

          const envelope = Math.sin(Math.min(pulseProgress, 1) * Math.PI);
          t += 0.9;

          const points = [];
          for (let index = 0; index <= segments; index++) {
            const x = (index / segments) * 100;
            const y =
              1 +
              maxAmplitude *
                envelope *
                Math.sin((x / (100 / frequency)) * 2 * Math.PI + t * 0.15);
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
          }

          if (pathElement?.isConnected) {
            pathElement.setAttribute("d", "M" + points.join(" L"));
            state.sortAnimationId = requestAnimationFrame(animateFailureLoop);
          } else {
            state.sortAnimationId = null;
            state.isPlayingFailureAnimation = false;
          }
        }

        state.sortAnimationId = requestAnimationFrame(animateFailureLoop);
      } else {
        state.isPlayingFailureAnimation = false;
      }
    } catch (error) {
      console.error("Error starting failure animation:", error);
      state.isPlayingFailureAnimation = false;
      state.sortAnimationId = null;
    }
  };

  // Remove temporary sorting classes after a sort or failure animation completes.
  const clearSortingIndicators = (separatorsToSort) => {
    if (separatorsToSort.length > 0) {
      batchDOMUpdates([
        () =>
          separatorsToSort.forEach((separator) => {
            if (separator?.isConnected) {
              separator.classList.remove("separator-is-sorting");
            }
          }),
      ]);
    }

    setTimeout(() => {
      batchDOMUpdates([
        () => {
          if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
            Array.from(gBrowser.tabs).forEach((tab) => {
              if (tab?.isConnected) {
                tab.classList.remove("tab-is-sorting");
              }
            });
          }
        },
      ]);
      ns.updateButtonsVisibilityState?.();
    }, 500);
  };

  // Keep grouped tabs above loose tabs after sorting changes the workspace layout.
  const reorderWorkspaceChildren = (workspaceElement) => {
    if (!workspaceElement?.tabsContainer) {
      return;
    }

    const tabsContainer = workspaceElement.tabsContainer;
    const allChildren = Array.from(tabsContainer.children);
    const groups = [];
    const ungroupedTabs = [];

    for (const child of allChildren) {
      const tagName = child.tagName?.toLowerCase();
      if (tagName === "tab-group") {
        groups.push(child);
      } else if (
        tagName === "tab" &&
        !child.hasAttribute("zen-empty-tab") &&
        !child.hasAttribute("zen-glance-tab")
      ) {
        ungroupedTabs.push(child);
      }
    }

    if (groups.length === 0 || ungroupedTabs.length === 0) {
      return;
    }

    const lastGroup = groups[groups.length - 1];
    let insertAfterElement = lastGroup;

    ungroupedTabs.forEach((tab) => {
      if (tab.isConnected && insertAfterElement?.isConnected) {
        const nextSibling = insertAfterElement.nextSibling;
        if (nextSibling) {
          tabsContainer.insertBefore(tab, nextSibling);
        } else {
          tabsContainer.appendChild(tab);
        }
        insertAfterElement = tab;
      }
    });
  };

  // Run the end-to-end sort flow for the current workspace.
  const sortTabsByTopic = async () => {
    if (state.isSorting) return;
    state.isSorting = true;

    let separatorsToSort = [];

    try {
      separatorsToSort = Array.from(domCache.getSeparators());
      if (separatorsToSort.length > 0) {
        batchDOMUpdates([
          () =>
            separatorsToSort.forEach((separator) => {
              if (separator?.isConnected) {
                separator.classList.add("separator-is-sorting");
              }
            }),
        ]);
      }

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!currentWorkspaceId) {
        console.error("Cannot get current workspace ID.");
        return;
      }

      const existingGroupNameMap = new Map();
      const groupSelector = `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`;

      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          existingGroupNameMap.set(normalizeTopicKey(label), label);
        }
      });

      const initialTabsToSort = getFilteredTabs(currentWorkspaceId, {
        includeGrouped: false,
        includeSelected: true,
        includePinned: false,
        includeEmpty: false,
        includeGlance: false,
      }).filter((tab) => {
        const groupParent = tab.closest("tab-group");
        const isInGroupInCorrectWorkspace = groupParent
          ? groupParent.matches(groupSelector)
          : false;
        return !isInGroupInCorrectWorkspace;
      });

      if (initialTabsToSort.length === 0) {
        return;
      }

      const aiTabTopics = (await askAIForMultipleTopics(initialTabsToSort)) || [];
      const finalGroups = buildFinalGroupsFromAssignments(
        aiTabTopics,
        existingGroupNameMap
      );

      const assignedTabsCount = aiTabTopics.length;
      const sortingFailed =
        assignedTabsCount === 0 && initialTabsToSort.length > 1;

      if (sortingFailed) {
        startFailureAnimation();
        return;
      }

      if (Object.keys(finalGroups).length === 0) {
        return;
      }

      const existingGroupElementsMap = new Map();
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          existingGroupElementsMap.set(label, groupEl);
        }
      });

      for (const topic in finalGroups) {
        const groupData = finalGroups[topic];
        const tabsForThisTopic = groupData.tabs.filter((tab) => {
          const groupParent = tab.closest("tab-group");
          const isInGroupInCorrectWorkspace = groupParent
            ? groupParent.matches(groupSelector)
            : false;
          return tab && tab.isConnected && !isInGroupInCorrectWorkspace;
        });

        if (tabsForThisTopic.length === 0) {
          continue;
        }

        const existingGroupElement = existingGroupElementsMap.get(topic);

        if (existingGroupElement && existingGroupElement.isConnected) {
          try {
            if (existingGroupElement.getAttribute("collapsed") === "true") {
              existingGroupElement.setAttribute("collapsed", "false");
              const groupLabelElement =
                existingGroupElement.querySelector(".tab-group-label");
              if (groupLabelElement) {
                groupLabelElement.setAttribute("aria-expanded", "true");
              }
            }

            for (const tab of tabsForThisTopic) {
              const groupParent = tab.closest("tab-group");
              const isInGroupInCorrectWorkspace = groupParent
                ? groupParent.matches(groupSelector)
                : false;
              if (tab && tab.isConnected && !isInGroupInCorrectWorkspace) {
                gBrowser.moveTabToExistingGroup(tab, existingGroupElement);
              } else {
                console.warn(
                  ` -> Tab "${getTabTitle(tab) || "Unknown"}" skipped moving to "${topic}" (already grouped or invalid).`
                );
              }
            }

            await applyATGGroupIconIfNeeded(existingGroupElement, groupData.iconId);
          } catch (error) {
            console.error(
              `Error moving tabs to existing group "${topic}":`,
              error,
              existingGroupElement
            );
          }
          continue;
        }

        if (tabsForThisTopic.length === 0) {
          continue;
        }

        const firstValidTabForGroup = tabsForThisTopic[0];
        const groupOptions = {
          label: topic,
          insertBefore: firstValidTabForGroup,
        };

        try {
          const newGroup = gBrowser.addTabGroup(tabsForThisTopic, groupOptions);
          if (newGroup && newGroup.isConnected) {
            existingGroupElementsMap.set(topic, newGroup);

            try {
              if (typeof newGroup._useFaviconColor === "function") {
                setTimeout(() => newGroup._useFaviconColor(), 500);
              }
            } catch {
              // Ignore ATG-specific coloring failures.
            }

            await applyATGGroupIconIfNeeded(newGroup, groupData.iconId);
          } else {
            const newGroupElFallback = findGroupElement(topic, currentWorkspaceId);
            if (newGroupElFallback && newGroupElFallback.isConnected) {
              existingGroupElementsMap.set(topic, newGroupElFallback);

              try {
                if (typeof newGroupElFallback._useFaviconColor === "function") {
                  setTimeout(() => newGroupElFallback._useFaviconColor(), 500);
                }
              } catch {
                // Ignore ATG-specific coloring failures.
              }

              await applyATGGroupIconIfNeeded(
                newGroupElFallback,
                groupData.iconId
              );
            } else {
              console.error(
                ` -> Failed to find the newly created group element for "${topic}" even with fallback.`
              );
            }
          }
        } catch (error) {
          console.error(
            `Error calling gBrowser.addTabGroup for topic "${topic}":`,
            error
          );

          const groupAfterError = findGroupElement(topic, currentWorkspaceId);
          if (groupAfterError && groupAfterError.isConnected) {
            existingGroupElementsMap.set(topic, groupAfterError);

            try {
              if (typeof groupAfterError._useFaviconColor === "function") {
                setTimeout(() => groupAfterError._useFaviconColor(), 500);
              }
            } catch {
              // Ignore ATG-specific coloring failures.
            }

            await applyATGGroupIconIfNeeded(groupAfterError, groupData.iconId);
          } else {
            console.error(` -> Failed to find group "${topic}" after creation error.`);
          }
        }
      }

      try {
        reorderWorkspaceChildren(window.gZenWorkspaces?.activeWorkspaceElement);
      } catch (error) {
        console.error("Error reordering tabs (groups first):", error);
      }
    } catch (error) {
      console.error("Error during overall sorting process:", error);
    } finally {
      if (state.isPlayingFailureAnimation) {
        setTimeout(() => {
          state.isSorting = false;
          cleanupAnimation();
          clearSortingIndicators(separatorsToSort);
        }, 1500);
      } else {
        state.isSorting = false;
        cleanupAnimation();
        clearSortingIndicators(separatorsToSort);
      }
    }
  };

  Object.assign(ns, {
    askAIForMultipleTopics,
    cleanupAnimation,
    startFailureAnimation,
    sortTabsByTopic,
  });
})();

/**
 * YouTube Tab Saver - Popup controller (v1.10.1)
 *
 * Drives popup.html. All tab access and YouTube work happens in background.js; this file only
 * sends messages ('auditTabs', 'processSave', 'closeTabs') and renders the results.
 *
 * FLOW
 *   Scan  -> lists YouTube tabs (video / non-video / incognito) and, for each video tab, the videos in
 *            its "Add to queue" queue. An ordinary playlist open in a tab is not a queue and is ignored.
 *   Save  -> sends the scanned, non-incognito video tabs (with their queues) to be saved into the
 *            named playlist, showing "(done / total)" while it runs. Closing this popup during a save
 *            does not stop it; re-opening the popup shows the save still running, or its result.
 *            Videos that do not fit (YouTube's 5,000-video limit) go into "<name> [OVERFLOW]".
 *   Close -> the selection view. Only video tabs start checked; non-video and incognito tabs start
 *            unchecked, and so do tabs whose save FAILED and the tab playing sound (marked with a
 *            speaker). Each section header's checkbox mirrors its tabs (checked / empty / dash).
 *            The column beside the list, top to bottom: previous section, select all, duplicates
 *            (off -> extra copies -> every copy), non-video, incognito, this window, Shorts, invert,
 *            next section. The on/off buttons only add or remove their own tabs and are highlighted
 *            while all their tabs are selected. The buttons never select the tab playing sound.
 *            Closing is re-verified in the background (a tab that has navigated elsewhere is left open).
 */

document.addEventListener('DOMContentLoaded', () => {
  const mainView = document.getElementById('mainView');
  const closeModalView = document.getElementById('closeModalView');

  const scanBtn = document.getElementById('scanBtn');
  const saveBtn = document.getElementById('saveBtn');
  const closeBtn = document.getElementById('closeBtn');
  const confirmCloseBtn = document.getElementById('confirmCloseBtn');
  const cancelCloseBtn = document.getElementById('cancelCloseBtn');

  const playlistTitleInput = document.getElementById('playlistTitle');
  const statusDiv = document.getElementById('status');
  const modalStats = document.getElementById('modalStatsText') || document.getElementById('modalStats');
  const warnBtn = document.getElementById('warnBtn');
  const warnCount = document.getElementById('warnCount');
  const tabTree = document.getElementById('tabTree');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');

  const scrollUpBtn = document.getElementById('scrollUpBtn');
  const scrollDownBtn = document.getElementById('scrollDownBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const dupesBtn = document.getElementById('dupesBtn');
  const nonVideoBtn = document.getElementById('nonVideoBtn');
  const incognitoBtn = document.getElementById('incognitoBtn');
  const thisWindowBtn = document.getElementById('thisWindowBtn');
  const shortsBtn = document.getElementById('shortsBtn');
  const invertBtn = document.getElementById('invertBtn');

  // Set default title to current date
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const yyyy = today.getFullYear();
  playlistTitleInput.value = `Saved Tabs ${mm}-${dd}-${yyyy}`;

  let scannedTabs = [];
  // Tabs where something was not saved in the most recent save (failed, unavailable video, or a queue that
  // could not be loaded in full): tab id -> reason. The close view marks them with a warning icon and the
  // warning button selects / deselects them. Kept across scans (a re-scan does not make them safe to close).
  // byVideo is used when the browser gave a tab a new id since the save (Opera does when a tab sleeps).
  let warnTabs = { byTab: new Map(), byVideo: new Map() };

  /** Why something in this tab was not saved, or null. */
  function warningFor(tab) {
    if (!tab) return null;
    return warnTabs.byTab.get(tab.tabId) || (tab.videoId ? warnTabs.byVideo.get(tab.videoId) : null) || null;
  }

  /** Warnings from the save's per-tab reasons; tabs it lists as unsaved without a reason get the fallback text. */
  function warningsFrom(response, fallbackTabIds, fallbackText) {
    const out = { byTab: new Map(), byVideo: new Map() };
    const given = response && response.tabWarnings && typeof response.tabWarnings === 'object' ? response.tabWarnings : null;
    if (given && given.byTab) Object.entries(given.byTab).forEach(([id, text]) => { const n = Number(id); if (Number.isInteger(n)) out.byTab.set(n, String(text)); });
    if (given && given.byVideo) Object.entries(given.byVideo).forEach(([v, text]) => out.byVideo.set(v, String(text)));
    const unsaved = [...(response?.tabs?.failedTabIds || []), ...(response?.tabs?.unavailableTabIds || [])];
    const ids = unsaved.length > 0 ? unsaved : (fallbackTabIds || []);
    ids.forEach((id) => { if (!out.byTab.has(id)) out.byTab.set(id, fallbackText || 'Not saved.'); });
    return out;
  }
  let pollTimer = null;
  let progressTicker = null;
  let saving = false;

  /** Video tabs that are eligible to be saved. Incognito tabs are never saved to the user's account. */
  function getSavableVideoTabs() {
    return scannedTabs.filter(t => t.isVideo && !t.isIncognito);
  }

  // --- Section jump (up/down arrows next to the tab list) ---

  /** Top of a group inside the scrollable content, independent of any offsetParent quirks. */
  function groupContentTop(groupEl) {
    const treeRect = tabTree.getBoundingClientRect();
    const groupRect = groupEl.getBoundingClientRect();
    return groupRect.top - treeRect.top - tabTree.clientTop + tabTree.scrollTop;
  }

  /** direction: 'next' | 'prev'. steps: how many sections to move (1 = next/previous section). */
  function jumpToSection(direction, steps) {
    const groups = Array.from(tabTree.querySelectorAll('.window-group'));
    if (groups.length === 0) return;
    steps = Math.max(1, steps || 1);

    const currentScroll = tabTree.scrollTop;
    const buffer = 15; // Pixel tolerance buffer

    if (direction === 'next') {
      const ahead = groups.filter(g => groupContentTop(g) > (currentScroll + buffer));
      if (ahead.length > 0) {
        const target = ahead[Math.min(steps, ahead.length) - 1];
        tabTree.scrollTo({ top: groupContentTop(target), behavior: 'smooth' });
      } else {
        tabTree.scrollTo({ top: tabTree.scrollHeight, behavior: 'smooth' });
      }
    } else if (direction === 'prev') {
      const behind = groups.filter(g => groupContentTop(g) < (currentScroll - buffer));
      if (behind.length >= steps) {
        tabTree.scrollTo({ top: groupContentTop(behind[behind.length - steps]), behavior: 'smooth' });
      } else {
        tabTree.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }

  function bindNavButton(btn, direction) {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      jumpToSection(direction, 1);
    });
  }

  bindNavButton(scrollUpBtn, 'prev');
  bindNavButton(scrollDownBtn, 'next');

  // --- Scan open YouTube tabs ---

  function describeScan() {
    const videoTabs = getSavableVideoTabs();
    return `Found ${videoTabs.length} video tab(s) out of ${scannedTabs.length} total YouTube tab(s).`;
  }

  scanBtn.addEventListener('click', () => {
    statusDiv.textContent = "Scanning open tabs...";
    progressContainer.style.display = 'none';
    progressBar.style.width = '0%';

    chrome.runtime.sendMessage({ action: "auditTabs" }, (response) => {
      if (chrome.runtime.lastError) {
        statusDiv.textContent = "Error scanning tabs: " + chrome.runtime.lastError.message;
        scannedTabs = [];
        saveBtn.disabled = true;
        closeBtn.disabled = true;
        return;
      }

      if (!response || response.error || !Array.isArray(response.tabs)) {
        statusDiv.textContent = response?.error || "Error scanning tabs.";
        scannedTabs = [];
        saveBtn.disabled = true;
        closeBtn.disabled = true;
        return;
      }

      scannedTabs = response.tabs;
      const videoTabs = getSavableVideoTabs();

      if (scannedTabs.length > 0) {
        statusDiv.textContent = describeScan();
        saveBtn.disabled = videoTabs.length === 0;
        closeBtn.disabled = false;
      } else {
        statusDiv.textContent = "No open YouTube tabs found.";
        saveBtn.disabled = true;
        closeBtn.disabled = true;
      }
    });
  });

  // --- Save tabs to YouTube playlist ---

  /** Locks everything that could interfere while a save runs (closing tabs mid-save would lose them). */
  function updateProgressText(state) {
    if (!saving || !state || !state.inProgress) return;
    const p = state.progress;
    statusDiv.textContent = p && Number.isFinite(p.done) && Number.isFinite(p.total)
      ? `Saving to YouTube playlist... (${p.done} / ${p.total})` : "Saving to YouTube playlist...";
  }

  function stopProgressTicker() {
    if (progressTicker) { clearInterval(progressTicker); progressTicker = null; }
  }

  function startProgressTicker() {
    stopProgressTicker();
    progressTicker = setInterval(() => {
      chrome.runtime.sendMessage({ action: "getSaveState" }, (state) => {
        if (chrome.runtime.lastError) return;
        updateProgressText(state);
      });
    }, 1000);
  }

  function showSaving() {
    saving = true;
    saveBtn.disabled = true;
    scanBtn.disabled = true;
    closeBtn.disabled = true;
    statusDiv.textContent = "Saving to YouTube playlist...";
    progressContainer.style.display = 'block';
    progressBar.style.width = '20%';
  }

  /**
   * Shows the outcome of a save.
   * opts.sentTabIds - tabs that were sent (treated as unsaved when the save failed outright)
   * opts.restored   - the result of an earlier save, shown after the popup was re-opened
   */
  function showSaveResult(response, opts) {
    opts = opts || {};
    saving = false;
    stopProgressTicker();
    scanBtn.disabled = false;

    // A save can succeed completely, or only partly (some videos rejected by YouTube).
    const saved = response && (response.success || response.status === 'PARTIAL_SUCCESS');
    // A save that ran but added nothing still has per-video counts: show those, not just the first error.
    // Only a save that never got going (not signed in, playlist unreadable, ...) shows "Error: ...".
    const ran = saved || !!(response && response.summary && response.summary.videos);
    let msg = "";
    let canRetry = false;

    if (ran) {
      const summary = response.summary || {};
      // Count videos, not tabs (a video open in several tabs, or in several tabs' queues, counts once),
      // so the numbers add up to the "(done / total)" shown while saving.
      const perVideo = summary.videos;
      const added = perVideo ? perVideo.added : (summary.successfullyAddedCount ?? 0);
      const duplicates = perVideo ? perVideo.alreadyInPlaylist : (summary.alreadyExistedInPlaylistCount ?? 0) + (summary.duplicateInBatchCount ?? 0);
      const failed = perVideo ? perVideo.failed : (summary.failedCount ?? 0);
      const unavailable = perVideo ? (perVideo.unavailable ?? 0) : 0;
      const skipped = response.skippedTabCount ?? 0;

      if (added === 0 && duplicates > 0 && failed === 0 && unavailable === 0) {
        msg = `All video(s) are already in "${response.usedTitle}".`;
      } else if (added === 0) {
        msg = `No videos were added to "${response.usedTitle}".`;
        if (duplicates > 0) {
          msg += ` (${duplicates} duplicate(s) skipped).`;
        }
      } else {
        msg = `Saved ${added} video(s) to "${response.usedTitle}".`;
        if (duplicates > 0) {
          msg += ` (${duplicates} duplicate(s) skipped).`;
        }
      }

      // Videos that did not fit in the main playlist (YouTube's 5,000-video limit) went into overflow playlists.
      const playlists = Array.isArray(response.playlists) ? response.playlists : [];
      const overflow = playlists.filter(p => p.index > 1 && p.addedCount > 0);
      if (added > 0 && overflow.length > 0) {
        const base = playlists.find(p => p.index === 1);
        const moved = overflow.reduce((n, p) => n + p.addedCount, 0);
        msg = `Saved ${added} video(s). "${base ? base.title : response.usedTitle}" is full (5,000 videos), so ${moved} video(s) went into ${overflow.map(p => `"${p.title}"`).join(', ')}.`;
        if (duplicates > 0) msg += ` (${duplicates} duplicate(s) skipped).`;
      }

      if (unavailable > 0) {
        // Private / deleted, when the lookup could tell; "other" only shown next to a known kind.
        const kinds = summary.unavailableKinds || {};
        const parts = [];
        if (kinds.private > 0) parts.push(`${kinds.private} private`);
        if (kinds.deleted > 0) parts.push(`${kinds.deleted} deleted`);
        if (parts.length > 0 && kinds.other > 0) parts.push(`${kinds.other} other`);
        msg += ` ${unavailable} video(s) were unavailable${parts.length > 0 ? ` (${parts.join(', ')})` : ''}.`;
      }

      if (failed > 0) {
        msg += ` Failed to add ${failed} video(s).`;
        const firstReason = (response.errors || []).find(e => e && e.error);
        if (firstReason) msg += ` (${firstReason.error})`;
      }

      if (skipped > 0) {
        msg += ` ${skipped} tab(s) changed since the scan and were skipped.`;
      }
      const queueNotes = Array.isArray(response.queueNotes) ? response.queueNotes : [];
      if (queueNotes.length > 0) {
        msg += ` The full queue could not be loaded for ${queueNotes.length} tab(s).`;
      }

      warnTabs = warningsFrom(response, [], 'Not saved.');
      canRetry = failed > 0; // already-saved videos are detected and skipped on a retry
    } else {
      msg = `Error: ${response?.error || 'Failed to save tabs.'}`;
      warnTabs = warningsFrom(response, opts.sentTabIds, 'Not saved: ' + (response?.error || 'the save failed.'));
      canRetry = true;
    }

    statusDiv.textContent = (opts.prefix || '') + msg;

    if (opts.restored) {
      // Nothing was scanned in this popup yet, so only Scan is meaningful.
      progressContainer.style.display = 'none';
      saveBtn.disabled = getSavableVideoTabs().length === 0;
      closeBtn.disabled = scannedTabs.length === 0;
      return;
    }

    if (ran && !canRetry) {
      progressBar.style.width = '100%';
    } else {
      progressContainer.style.display = 'none';
    }
    saveBtn.disabled = !canRetry;
    closeBtn.disabled = false;
  }

  saveBtn.addEventListener('click', () => {
    const title = playlistTitleInput.value.trim() || `Saved Tabs ${mm}-${dd}-${yyyy}`;

    const videoTabsToSend = getSavableVideoTabs().map(t => {
      const entry = { tabId: t.tabId, videoId: t.videoId, queueVideoIds: Array.isArray(t.queueVideoIds) ? t.queueVideoIds : [] };
      if (t.queueListId) entry.queueListId = t.queueListId;   // queue in a tab that could not be read: loaded when saving
      if (t.queuePartial) entry.queuePartial = true;
      return entry;
    });

    if (videoTabsToSend.length === 0) {
      statusDiv.textContent = "No video tabs to save.";
      return;
    }

    showSaving();
    startProgressTicker();
    const sentTabIds = videoTabsToSend.map(t => t.tabId);

    // The save tab opens in this popup's window, next to the current tab.
    const send = (windowId) => chrome.runtime.sendMessage({
      action: "processSave",
      playlistTitle: title,
      windowId: windowId,
      videoTabs: videoTabsToSend
    }, (response) => {
      if (chrome.runtime.lastError) {
        saving = false;
        stopProgressTicker();
        scanBtn.disabled = false;
        statusDiv.textContent = "Error: " + chrome.runtime.lastError.message;
        warnTabs = warningsFrom(null, sentTabIds, 'Not saved: ' + chrome.runtime.lastError.message);
        saveBtn.disabled = false;
        closeBtn.disabled = false;
        progressContainer.style.display = 'none';
        return;
      }
      showSaveResult(response, { sentTabIds });
    });
    chrome.windows.getCurrent()
      .then((w) => send(w && Number.isInteger(w.id) ? w.id : undefined))
      .catch(() => send(undefined));
  });

  // --- Re-opened popup: show a save that is still running, or the result of the last one ---

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      chrome.runtime.sendMessage({ action: "getSaveState" }, (state) => {
        if (chrome.runtime.lastError || !state) return;
        if (state.inProgress) { updateProgressText(state); return; }
        stopPolling();
        if (state.last && state.last.result) {
          showSaveResult(state.last.result, { restored: true });
        } else {
          scanBtn.disabled = false;
          progressContainer.style.display = 'none';
          statusDiv.textContent = "";
        }
      });
    }, 1000);
  }

  function restoreSaveState() {
    chrome.runtime.sendMessage({ action: "getSaveState" }, (state) => {
      if (chrome.runtime.lastError || !state) return;
      if (state.inProgress) {
        showSaving();
        updateProgressText(state);
        startPolling();
      } else if (state.last && state.last.result) {
        showSaveResult(state.last.result, { restored: true, prefix: 'Last save: ' });
      } else if (state.warnings) {
        // An older save: its message is no longer shown, but its "not saved" marks still apply.
        warnTabs = warningsFrom({ tabWarnings: state.warnings }, [], 'Not saved.');
      }
    });
  }

  // --- Open modal view to select tabs to close ---

  closeBtn.addEventListener('click', async () => {
    if (scannedTabs.length === 0) return;

    const videoCount = scannedTabs.filter(t => t.isVideo && !t.isIncognito).length;
    const nonVideoCount = scannedTabs.filter(t => !t.isVideo && !t.isIncognito).length;
    const incognitoCount = scannedTabs.filter(t => t.isIncognito).length;

    modalStats.textContent = `Total: ${scannedTabs.length} tabs (${videoCount} Video, ${nonVideoCount} Non-Video, ${incognitoCount} Incognito).`;
    if (warnBtn) {
      const n = scannedTabs.filter(t => warningFor(t)).length;
      warnBtn.hidden = n === 0;
      if (warnCount) warnCount.textContent = String(n);
    }

    try {
      await renderTabTree();
    } catch (err) {
      statusDiv.textContent = "Error showing tabs: " + (err?.message || err);
      return;
    }

    mainView.style.display = 'none';
    closeModalView.style.display = 'block';
  });

  async function renderTabTree() {
    tabTree.innerHTML = '';

    currentWindowId = null;
    try {
      const currentWin = await chrome.windows.getCurrent();
      currentWindowId = currentWin ? currentWin.id : null;
    } catch (e) {
      currentWindowId = null;
    }

    playingTabIds = await getPlayingTabIds();
    tabInfo = new Map(scannedTabs.map(t => [t.tabId, t]));
    resetDupesMode();
    if (invertBtn) invertBtn.dataset.state = 'top';

    const incognitoTabs = scannedTabs.filter(t => t.isIncognito);
    const nonVideoTabs = scannedTabs.filter(t => !t.isVideo && !t.isIncognito);
    const videoTabs = scannedTabs.filter(t => t.isVideo && !t.isIncognito);

    // Video tabs start checked - including tabs where something was not saved (they are marked with a
    // warning icon instead; the warning button deselects them). Non-video and incognito tabs (never saved)
    // start unchecked, and so does the tab that is playing sound.
    const startsChecked = (tab) => tab.isVideo && !tab.isIncognito && !playingTabIds.has(tab.tabId);

    function createSection(groupTitle, tabs, headerColorClass, groupId) {
      if (tabs.length === 0) return;

      const groupEl = document.createElement('div');
      groupEl.className = 'window-group';

      const winHeader = document.createElement('div');
      winHeader.className = `window-header ${headerColorClass || ''}`;

      const winCheckbox = document.createElement('input');
      winCheckbox.type = 'checkbox';
      winCheckbox.className = 'group-checkbox';
      winCheckbox.dataset.groupId = groupId;
      winCheckbox.checked = tabs.every(startsChecked);

      const winTitle = document.createElement('span');
      winTitle.textContent = `${groupTitle} (${tabs.length})`;

      winHeader.appendChild(winCheckbox);
      winHeader.appendChild(winTitle);
      groupEl.appendChild(winHeader);

      tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab-item';

        const tabCheckbox = document.createElement('input');
        tabCheckbox.type = 'checkbox';
        tabCheckbox.className = 'tab-checkbox';
        tabCheckbox.dataset.tabId = tab.tabId;
        tabCheckbox.dataset.groupId = groupId;
        tabCheckbox.checked = startsChecked(tab);

        const titleEl = document.createElement('span');
        titleEl.className = 'tab-title';
        titleEl.textContent = tab.title;

        tabEl.appendChild(tabCheckbox);
        const hover = [];
        const warning = warningFor(tab);
        if (warning) {
          tabEl.appendChild(warningIcon());
          hover.push(warning);
        }
        if (playingTabIds.has(tab.tabId)) {
          tabEl.appendChild(speakerIcon());
          hover.push('Playing sound - left unchecked');
        }
        if (hover.length > 0) tabEl.title = hover.join('\n');
        tabEl.appendChild(titleEl);
        groupEl.appendChild(tabEl);
      });

      tabTree.appendChild(groupEl);
    }

    if (incognitoTabs.length > 0) {
      createSection("Incognito Tabs", incognitoTabs, "header-incognito", "group-incognito");
    }

    if (nonVideoTabs.length > 0) {
      createSection("Non-Video YouTube Tabs", nonVideoTabs, "header-nonvideo", "group-nonvideo");
    }

    const currentWinTabs = videoTabs.filter(t => t.windowId === currentWindowId);
    if (currentWinTabs.length > 0) {
      createSection("Current Window 1", currentWinTabs, "header-video", `group-win-${currentWindowId}`);
    }

    const windowGroups = {};
    videoTabs
      .filter(t => t.windowId !== currentWindowId)
      .forEach(t => {
        if (!windowGroups[t.windowId]) windowGroups[t.windowId] = [];
        windowGroups[t.windowId].push(t);
      });

    let windowIndex = 2;
    for (const [windowId, tabs] of Object.entries(windowGroups)) {
      createSection(`Window ${windowIndex}`, tabs, "header-video", `group-win-${windowId}`);
      windowIndex++;
    }

    attachCheckboxListeners();
    updateConfirmButtonText();
    updateToolTitles();
  }

  function attachCheckboxListeners() {
    document.querySelectorAll('.group-checkbox').forEach(groupCb => {
      groupCb.addEventListener('change', (e) => {
        const gId = e.target.dataset.groupId;
        const isChecked = e.target.checked;
        document.querySelectorAll(`.tab-checkbox[data-group-id="${gId}"]`).forEach(tabCb => {
          tabCb.checked = isChecked;
        });
        onSelectionChangedByHand();
      });
    });

    document.querySelectorAll('.tab-checkbox').forEach(tabCb => {
      tabCb.addEventListener('change', onSelectionChangedByHand);
    });
  }

  /** Each group header mirrors its tabs: checked = all, unchecked = none, dash = some. */
  function syncGroupHeaders() {
    document.querySelectorAll('.group-checkbox').forEach(groupCb => {
      const boxes = Array.from(document.querySelectorAll(`.tab-checkbox[data-group-id="${groupCb.dataset.groupId}"]`));
      const checkedCount = boxes.filter(b => b.checked).length;
      groupCb.checked = boxes.length > 0 && checkedCount === boxes.length;
      groupCb.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    });
  }

  function updateConfirmButtonText() {
    syncGroupHeaders();
    const selectedBoxes = document.querySelectorAll('.tab-checkbox:checked');
    confirmCloseBtn.textContent = `Confirm & Close Selected (${selectedBoxes.length})`;
    confirmCloseBtn.disabled = selectedBoxes.length === 0;
  }

  // --- Selection tools (the round buttons beside the tab list) ---
  //
  // All, Non-video, Incognito, This window and Shorts are on/off toggles: each selects every tab of its
  // kind, or deselects them if they are all selected already, and leaves every other tab as it is. The
  // button is highlighted while all of its tabs are selected. Invert flips every checkbox. None of the
  // buttons ever SELECTS the tab that is playing sound (you can still tick it by hand).
  // Duplicates cycles: off -> extra copies -> all copies -> off (its icon shows which).

  let currentWindowId = null;
  let playingTabIds = new Set();
  let tabInfo = new Map();
  let dupesMode = 'off';          // 'off' | 'extras' | 'all'
  let dupesSnapshot = null;       // checkbox states before the duplicates button was first used

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Small speaker icon for the tab that is playing sound. */
  function speakerIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'tab-playing');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12');
    svg.appendChild(path);
    return svg;
  }

  /** Warning icon (amber triangle) for a tab where something was not saved. */
  function warningIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'tab-warning');
    svg.setAttribute('aria-label', 'Not fully saved');
    const tri = document.createElementNS(SVG_NS, 'path');
    tri.setAttribute('class', 'warn-tri');
    tri.setAttribute('d', 'M12 3L2 21h20L12 3z');
    const bar = document.createElementNS(SVG_NS, 'path');
    bar.setAttribute('class', 'warn-mark');
    bar.setAttribute('d', 'M12 10v4.5M12 17.6v.1');
    svg.appendChild(tri);
    svg.appendChild(bar);
    return svg;
  }

  /** Tabs playing sound right now (falls back to what the scan saw). */
  async function getPlayingTabIds() {
    try {
      const audible = await chrome.tabs.query({ audible: true });
      return new Set((audible || []).map(t => t.id));
    } catch (e) {
      return new Set(scannedTabs.filter(t => t.audible).map(t => t.tabId));
    }
  }

  function allBoxes() {
    return Array.from(tabTree.querySelectorAll('.tab-checkbox'));
  }
  function tabOf(cb) {
    return tabInfo.get(Number(cb.dataset.tabId)) || {};
  }
  function isPlaying(cb) {
    return playingTabIds.has(Number(cb.dataset.tabId));
  }
  function isShorts(tab) {
    try { return /^\/shorts\//.test(new URL(tab.url).pathname); } catch (e) { return false; }
  }

  const KINDS = {
    all: () => true,
    nonVideo: (t) => !t.isVideo && !t.isIncognito,
    incognito: (t) => !!t.isIncognito,
    shorts: (t) => isShorts(t),
    thisWindow: (t) => !!t.isVideo && !t.isIncognito && t.windowId === currentWindowId,  // the "Current Window" section
    warned: (t) => !!warningFor(t)                                                       // the warning button
  };

  /** Are all the (not playing) tabs of this kind selected? */
  function kindFullySelected(pred) {
    const selectable = allBoxes().filter(cb => pred(tabOf(cb)) && !isPlaying(cb));
    return selectable.length > 0 && selectable.every(cb => cb.checked);
  }

  function toggleKind(pred) {
    const targets = allBoxes().filter(cb => pred(tabOf(cb)));
    const deselect = kindFullySelected(pred);
    targets.forEach(cb => {
      if (deselect) cb.checked = false;
      else if (!isPlaying(cb)) cb.checked = true;
    });
    afterToolChange();
  }

  function invertSelection() {
    allBoxes().forEach(cb => { if (!isPlaying(cb)) cb.checked = !cb.checked; });
    // The icon's yellow half (top or bottom arrow) swaps each time, showing that the selection flipped.
    if (invertBtn) invertBtn.dataset.state = invertBtn.dataset.state === 'bottom' ? 'top' : 'bottom';
    afterToolChange();
  }

  // --- Duplicates ---

  /**
   * Tabs showing the same thing: the same video (or, for non-video pages, the same address).
   * Incognito tabs are only compared with incognito tabs.
   */
  function duplicateGroups() {
    const byKey = new Map();
    allBoxes().forEach(cb => {
      const t = tabOf(cb);
      if (!t.url) return;
      const what = t.isVideo && t.videoId ? 'v:' + t.videoId : 'u:' + t.url;
      const key = (t.isIncognito ? 'i:' : 'n:') + what;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(cb);
    });
    return Array.from(byKey.values()).filter(g => g.length > 1);
  }

  /**
   * The copy that is kept: the one playing sound, else the one looked at most recently, else the one in
   * this window, else the first in the list.
   */
  function keeperOf(group) {
    const playing = group.find(isPlaying);
    if (playing) return playing;
    const withTime = group.filter(cb => Number.isFinite(tabOf(cb).lastAccessed));
    if (withTime.length > 0) {
      return withTime.reduce((best, cb) => (tabOf(cb).lastAccessed > tabOf(best).lastAccessed ? cb : best));
    }
    return group.find(cb => tabOf(cb).windowId === currentWindowId) || group[0];
  }

  const DUPES_TITLES = {
    off: 'Duplicates: select the extra copies (keeps one of each)',
    extras: 'Duplicates: extra copies selected - click to select every copy',
    all: 'Duplicates: every copy selected - click to undo'
  };

  function setDupesMode(mode) {
    dupesMode = mode;
    if (dupesBtn) {
      dupesBtn.dataset.state = mode;
      dupesBtn.title = DUPES_TITLES[mode];
    }
  }

  function resetDupesMode() {
    dupesSnapshot = null;
    setDupesMode('off');
  }

  function cycleDupes() {
    const groups = duplicateGroups();
    if (groups.length === 0) {
      resetDupesMode();
      if (dupesBtn) dupesBtn.title = 'No duplicate tabs';
      return;
    }
    if (dupesMode === 'off') {
      dupesSnapshot = new Map();
      groups.flat().forEach(cb => dupesSnapshot.set(cb, cb.checked));
      groups.forEach(group => {
        const keep = keeperOf(group);
        group.forEach(cb => {
          if (cb === keep) cb.checked = false;
          else if (!isPlaying(cb)) cb.checked = true;
        });
      });
      setDupesMode('extras');
    } else if (dupesMode === 'extras') {
      groups.flat().forEach(cb => { if (!isPlaying(cb)) cb.checked = true; });
      setDupesMode('all');
    } else {
      if (dupesSnapshot) dupesSnapshot.forEach((wasChecked, cb) => { cb.checked = wasChecked; });
      resetDupesMode();
    }
    updateConfirmButtonText();
    updateToolTitles();
  }

  // --- Keeping everything in step ---

  /** Tooltips say what a click will do; on/off buttons are highlighted while all their tabs are selected. */
  function updateToolTitles() {
    const show = (btn, on, onText, offText) => {
      if (!btn) return;
      const text = on ? onText : offText;
      btn.title = text;
      btn.setAttribute('aria-label', text);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    show(selectAllBtn, kindFullySelected(KINDS.all), 'Deselect all', 'Select all');
    show(nonVideoBtn, kindFullySelected(KINDS.nonVideo), 'Deselect non-video tabs', 'Select non-video tabs');
    show(incognitoBtn, kindFullySelected(KINDS.incognito), 'Deselect incognito tabs', 'Select incognito tabs');
    show(thisWindowBtn, kindFullySelected(KINDS.thisWindow), 'Deselect this window', 'Select this window');
    show(shortsBtn, kindFullySelected(KINDS.shorts), 'Deselect Shorts', 'Select Shorts');
    if (warnBtn && !warnBtn.hidden) {
      const n = warnCount ? warnCount.textContent : '';
      show(warnBtn, kindFullySelected(KINDS.warned),
        `Deselect the ${n} tab(s) where something was not saved`, `Select the ${n} tab(s) where something was not saved`);
    }
  }

  /** A button other than Duplicates changed the selection. */
  function afterToolChange() {
    resetDupesMode();
    updateConfirmButtonText();
    updateToolTitles();
  }

  /** A checkbox was clicked by hand. */
  function onSelectionChangedByHand() {
    resetDupesMode();
    updateConfirmButtonText();
    updateToolTitles();
  }

  function bindTool(btn, fn) {
    if (!btn) return;
    btn.addEventListener('click', (e) => { e.preventDefault(); fn(); });
  }
  bindTool(selectAllBtn, () => toggleKind(KINDS.all));
  bindTool(dupesBtn, cycleDupes);
  bindTool(nonVideoBtn, () => toggleKind(KINDS.nonVideo));
  bindTool(incognitoBtn, () => toggleKind(KINDS.incognito));
  bindTool(thisWindowBtn, () => toggleKind(KINDS.thisWindow));
  bindTool(shortsBtn, () => toggleKind(KINDS.shorts));
  bindTool(invertBtn, invertSelection);
  bindTool(warnBtn, () => toggleKind(KINDS.warned));

  // --- Close the selected tabs ---

  confirmCloseBtn.addEventListener('click', () => {
    const selectedBoxes = document.querySelectorAll('.tab-checkbox:checked');
    const tabIdsToClose = Array.from(selectedBoxes).map(cb => parseInt(cb.dataset.tabId, 10));

    if (tabIdsToClose.length === 0) return;

    // Tell the background what each tab was at scan time, so it can refuse to close a tab that
    // has since navigated to something else (e.g. a different, unsaved video). A tab whose queue was
    // saved may move on inside that queue; it may still be closed.
    const expectedVideoIds = {};
    tabIdsToClose.forEach(id => {
      const tab = scannedTabs.find(t => t.tabId === id);
      if (tab && tab.isVideo) {
        expectedVideoIds[id] = Array.from(new Set([tab.videoId, ...(Array.isArray(tab.queueVideoIds) ? tab.queueVideoIds : [])]));
      } else {
        expectedVideoIds[id] = null;
      }
    });

    confirmCloseBtn.disabled = true;
    cancelCloseBtn.disabled = true;

    chrome.runtime.sendMessage({ action: "closeTabs", tabIds: tabIdsToClose, expectedVideoIds }, (res) => {
      cancelCloseBtn.disabled = false;
      closeModalView.style.display = 'none';
      mainView.style.display = 'block';

      if (chrome.runtime.lastError) {
        statusDiv.textContent = "Error closing tabs: " + chrome.runtime.lastError.message;
        updateConfirmButtonText();
        return;
      }

      const closed = res?.closedCount ?? 0;
      const skipped = res?.skippedCount ?? 0;
      const failed = res?.failedCount ?? 0;

      if (closed > 0) {
        statusDiv.textContent = `Successfully closed ${closed} ${closed === 1 ? 'tab' : 'tabs'}.`;
      } else {
        statusDiv.textContent = res?.error ? `Error closing tabs: ${res.error}` : "No tabs were closed.";
      }
      if (skipped > 0) {
        statusDiv.textContent += ` ${skipped} tab(s) had changed or were already closed and were left alone.`;
      }
      if (failed > 0) {
        statusDiv.textContent += ` ${failed} tab(s) could not be closed.`;
      }

      // The scan is out of date once anything closed or changed; otherwise keep it so the user can retry.
      if (closed > 0 || skipped > 0) {
        saveBtn.disabled = true;
        closeBtn.disabled = true;
        scannedTabs = [];
        warnTabs = { byTab: new Map(), byVideo: new Map() };
      }
      updateConfirmButtonText();
    });
  });

  cancelCloseBtn.addEventListener('click', () => {
    closeModalView.style.display = 'none';
    mainView.style.display = 'block';
  });

  restoreSaveState();
});
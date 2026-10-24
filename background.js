/**
 * YouTube Tab Saver - Background Service Worker (v1.10.1)
 *
 * PURPOSE
 *   1. Audit every open tab and classify the YouTube ones (video / non-video / incognito).
 *   2. Save the video tabs into a YouTube playlist (found by name, or created), with
 *      duplicate protection and overflow protection (YouTube caps a playlist at 5,000 items,
 *      so extra videos roll into "<Title> [OVERFLOW]", "<Title> [OVERFLOW 2]", ...).
 *   3. Close tabs the user selects - only if they are still the pages that were scanned.
 *
 * MESSAGE PROTOCOL (popup -> this worker)
 *   { action: 'auditTabs' }
 *       -> { tabs: [{ tabId, windowId, title, url, isVideo, videoId, isIncognito, audible, lastAccessed, queue... }] }
 *          | { tabs: [], error }        (audible / lastAccessed are used by the close view's duplicate and
 *                                         playing-tab rules; they never affect saving)
 *   { action: 'processSave', playlistTitle, windowId?, videoTabs: [{ tabId, videoId, queueVideoIds?, queueListId?, queuePartial? }] }
 *       (windowId = the popup's window; the save tab opens there, next to the current tab)
 *       -> {
 *            success,        // true only when no tab failed
 *            status,         // 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NO_ADDITIONS_NEEDED' | 'FAILED'
 *            usedTitle,      // playlist title(s) videos went into (comma separated on overflow)
 *            summary: { totalCandidateTabs, successfullyAddedCount, alreadyExistedInPlaylistCount,
 *                       duplicateInBatchCount, failedCount,
 *                       videos: { total, added, alreadyInPlaylist, unavailable, failed },
 *                       unavailableKinds: { private, deleted, other } },
 *            tabs:    { addedTabIds, alreadyExistedInPlaylistTabIds, duplicateInBatchTabIds, failedTabIds,
 *                       unavailableTabIds },   // unavailable = YouTube accepted the video but did not keep it
 *            errors:  [{ videoId?, error }],
 *            playlists, queueNotes, scanState, skippedTabCount, error?
 *          }
 *   { action: 'closeTabs', tabIds: number[], expectedVideoIds: { [tabId]: videoId[] | null } }
 *       -> { closedCount, skippedCount, failedCount, error? }
 *   { action: 'getSaveState' }
 *       -> { inProgress, startedAt, progress: { done, total } | null, last: { finishedAt, result } | null }   (lets a re-opened popup show the last save)
 *
 *   Each tab in 'auditTabs' also carries its QUEUE - the list built with YouTube's "Add to queue":
 *   queueStatus ('none' | 'read' | 'unreadable'), queueVideoIds (in order), queueTitle, queueListId
 *   (the queue's id, sent back so a queue whose tab could not be read, or that the page showed only
 *   part of, is loaded in full from YouTube when saving) and queuePartial (the page showed only part).
 *   What counts as a queue: a queue panel with no playlist id, or with a temporary-list id ("TL...").
 *   An ordinary playlist that is open in a tab (PL..., Watch Later, Liked, Mix RD..., albums) is NOT a
 *   queue; only that tab's own video is saved.
 */

'use strict';

// --- 0. Configuration -------------------------------------------------------

const CONFIG = Object.freeze({
  // YouTube limits
  PLAYLIST_ITEM_LIMIT: 5000,      // max videos per playlist
  MAX_TITLE_LENGTH: 150,          // max playlist title length
  MAX_OVERFLOW_PLAYLISTS: 20,     // safety cap on the "<Title> [OVERFLOW N]" chain length

  // Privacy of playlists this tool creates: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'
  NEW_PLAYLIST_PRIVACY: 'PRIVATE',

  // Network behaviour (inside the YouTube tab)
  REQUEST_TIMEOUT_MS: 30000,
  REQUEST_MAX_RETRIES: 2,         // extra attempts for 429 / 5xx (and network errors on reads)
  ADD_DELAY_MS: 100,              // pause between add-video calls
  MAX_CONSECUTIVE_ADD_FAILURES: 5,
  MAX_SCAN_PAGES: 200,            // playlist scan pages (~100 items each)
  MAX_LISTING_PAGES: 25,          // playlist-list pages
  YTCFG_WAIT_MS: 10000,           // wait for YouTube's page config to appear

  // Worker behaviour
  PAGE_LOAD_TIMEOUT_MS: 15000,
  KEEPALIVE_INTERVAL_MS: 20000,   // stops Chrome from suspending the worker mid-save
  PLAYLIST_CACHE_MAX_ENTRIES: 200,

  // Queues (the playlist / "Queue" panel next to a playing video)
  MAX_QUEUE_VIDEOS_PER_TAB: 5000, // safety cap per queue (a playlist holds at most 5,000 anyway)
  MAX_QUEUE_PAGES: 60,            // requests used to load one long queue page by page
  // YouTube keeps "Add to queue" queues for only about a week (a 1-day-old one came back, a 7-day-old one
  // did not). A queue older than this (by the date in its id) is not asked of YouTube at all. Queues read
  // from an awake tab's own page are never affected. 0 = always ask.
  QUEUE_REQUEST_MAX_AGE_DAYS: 7,
  QUEUE_READ_TIMEOUT_MS: 4000,    // per tab, when reading its queue during a scan
  QUEUE_READ_CONCURRENCY: 8,      // tabs read at the same time


  // Remembering the last save so a re-opened popup can show it
  LAST_SAVE_MAX_AGE_MS: 30 * 60 * 1000,

  PROGRESS_POLL_MS: 1000          // how often the worker asks the save tab for its (done / total) count
});

// Subset of CONFIG handed to the injected engine (it cannot see this file's scope).
const ENGINE_CONFIG = Object.freeze({
  PLAYLIST_ITEM_LIMIT: CONFIG.PLAYLIST_ITEM_LIMIT,
  MAX_TITLE_LENGTH: CONFIG.MAX_TITLE_LENGTH,
  MAX_OVERFLOW_PLAYLISTS: CONFIG.MAX_OVERFLOW_PLAYLISTS,
  NEW_PLAYLIST_PRIVACY: CONFIG.NEW_PLAYLIST_PRIVACY,
  REQUEST_TIMEOUT_MS: CONFIG.REQUEST_TIMEOUT_MS,
  REQUEST_MAX_RETRIES: CONFIG.REQUEST_MAX_RETRIES,
  ADD_DELAY_MS: CONFIG.ADD_DELAY_MS,
  MAX_CONSECUTIVE_ADD_FAILURES: CONFIG.MAX_CONSECUTIVE_ADD_FAILURES,
  MAX_SCAN_PAGES: CONFIG.MAX_SCAN_PAGES,
  MAX_LISTING_PAGES: CONFIG.MAX_LISTING_PAGES,
  YTCFG_WAIT_MS: CONFIG.YTCFG_WAIT_MS,
  MAX_QUEUE_VIDEOS_PER_TAB: CONFIG.MAX_QUEUE_VIDEOS_PER_TAB,
  MAX_QUEUE_PAGES: CONFIG.MAX_QUEUE_PAGES,
  QUEUE_REQUEST_MAX_AGE_DAYS: CONFIG.QUEUE_REQUEST_MAX_AGE_DAYS,
  MEMBERSHIP_CONCURRENCY: 4,
  // Videos YouTube "added" without listing the edit (they never appear in the playlist) are looked up once
  // each, read-only, to tell private from deleted. At most this many lookups per save.
  VIDEO_STATUS_MAX_CHECKS: 200
});

// --- 1. Security & Validation Helpers ---------------------------------------

function isLegitimateYoutubeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase();
  return (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be' ||
    host.endsWith('.youtube.com')
  );
}

function normalizeVideoId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
}

function notYoutube() {
  return { isYT: false, isVideo: false, videoId: null };
}

/**
 * Classifies a URL.
 * @returns {{isYT: boolean, isVideo: boolean, videoId: (string|null)}}
 */
function categorizeYoutubeUrl(urlStr) {
  try {
    if (!urlStr || typeof urlStr !== 'string') return notYoutube();

    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return notYoutube();
    if (!isLegitimateYoutubeHost(url.hostname)) return notYoutube();

    let rawId = url.searchParams.get('v');

    if (!rawId) {
      if (url.hostname.toLowerCase() === 'youtu.be') {
        rawId = url.pathname.slice(1).split('/')[0];
      } else {
        const match = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
        if (match) rawId = match[1];
      }
    }

    const normalizedId = normalizeVideoId(rawId);
    return { isYT: true, isVideo: normalizedId !== null, videoId: normalizedId };
  } catch (e) {
    return notYoutube();
  }
}

/** Same title normalisation the engine uses, so cache keys always agree. */
function cleanPlaylistTitle(t) {
  return typeof t === 'string' ? t.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

// --- 2. Injected Native Save Engine -----------------------------------------
//
// IMPORTANT: this function is serialised by chrome.scripting.executeScript and run inside the
// youtube.com page. It must be completely self-contained: it cannot use anything from the rest
// of this file. Arguments and the return value must be JSON-compatible.

async function tabNativeSaveEngine(targetPlaylistTitle, rawVideoTabs, storedPlaylistCache, cfg, runToken) {
  // Mark this tab as having started this save (survives a reload of the tab), so the worker never starts the
  // same save a second time after an interruption.
  try { if (runToken) window.sessionStorage.setItem('ytsEngineRun', String(runToken)); } catch (e) { /* ignore */ }
  'use strict';

  // ---------- small utilities ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errorText = (e) => (e && e.message ? e.message : String(e));

  function normalizeVideoId(id) {
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    return /^[a-zA-Z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
  }

  function cleanTitle(t) {
    return typeof t === 'string' ? t.trim().replace(/\s+/g, ' ').toLowerCase() : '';
  }

  function stripVL(id) {
    return typeof id === 'string' ? id.replace(/^VL/, '') : '';
  }

  /** Reads YouTube's "text" shapes: string | {simpleText} | {runs:[{text}]} | {content}. */
  function textOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
    if (typeof t.content === 'string') return t.content;
    return '';
  }

  /** YouTube rejects '<' and '>' in titles and caps the length. */
  function sanitizeTitle(t) {
    const cleaned = typeof t === 'string' ? t.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim() : '';
    return cleaned || 'Saved Tabs';
  }

  /** index 1 -> "Title", index 2 -> "Title [OVERFLOW]", ... (always within the title length limit). */
  function makeTitle(base, index) {
    const suffix = index <= 1 ? '' : (index === 2 ? ' [OVERFLOW]' : ' [OVERFLOW ' + (index - 1) + ']');
    return base.slice(0, cfg.MAX_TITLE_LENGTH - suffix.length).trim() + suffix;
  }

  /** Depth-first walk over parsed JSON. visit() may return false to skip a node's children. */
  function walk(node, visit, skipKeys, depth) {
    if (!node || typeof node !== 'object' || depth > 200) return;
    if (visit(node) === false) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit, skipKeys, depth + 1);
    } else {
      for (const key of Object.keys(node)) {
        if (skipKeys && skipKeys.has(key)) continue;
        walk(node[key], visit, skipKeys, depth + 1);
      }
    }
  }

  /** Token of a "load more" row (continuationItemRenderer). */
  function continuationFromRenderer(r) {
    const ep = r && r.continuationEndpoint;
    const token =
      (ep && ep.continuationCommand && ep.continuationCommand.token) ||
      (ep && ep.playlistVideoListContinuationCommand && ep.playlistVideoListContinuationCommand.token) ||
      (ep && ep.genericContinuationEndpoint && ep.genericContinuationEndpoint.token) ||
      (ep && ep.appendContinuationItemsAction &&
        ep.appendContinuationItemsAction.continuationItems &&
        ep.appendContinuationItemsAction.continuationItems[0] &&
        ep.appendContinuationItemsAction.continuationItems[0].continuationItemRenderer &&
        continuationFromRenderer(ep.appendContinuationItemsAction.continuationItems[0].continuationItemRenderer)) ||
      (r && r.continuationToken) ||
      findContinuationCommand(ep) ||
      findContinuationCommand(r) ||
      null;
    return typeof token === 'string' && token ? token : null;
  }

  /**
   * Newer YouTube pages wrap the "next page" command, e.g.
   *   continuationEndpoint.commandExecutorCommand.commands[..].continuationCommand.token
   * so look for a continuationCommand anywhere inside the "load more" row (a few levels deep).
   */
  function findContinuationCommand(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (node.continuationCommand && typeof node.continuationCommand.token === 'string' && node.continuationCommand.token) {
      return node.continuationCommand.token;
    }
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const v of values) {
      const found = findContinuationCommand(v, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Keys whose subtrees never contain the playlist's own items.
  const SKIP_KEYS = new Set(['secondaryContents', 'watchNextFeed', 'related', 'header']);

  /**
   * The video id of one playlist ENTRY, or null. YouTube has used two shapes for the rows of a
   * playlist page: the classic playlistVideoRenderer, and the newer lockupViewModel whose only
   * id is `contentId`. Both are recognised; anything else is ignored.
   */
  function playlistEntryId(node) {
    const classic = node.playlistVideoRenderer;
    if (classic && typeof classic.videoId === 'string') return normalizeVideoId(classic.videoId);
    const lockup = node.lockupViewModel;
    if (lockup && typeof lockup.contentId === 'string' &&
        /^LOCKUP_CONTENT_TYPE_(VIDEO|SHORTS?)$/.test(String(lockup.contentType || ''))) {
      return normalizeVideoId(lockup.contentId);
    }
    return null;
  }

  /**
   * Parses one playlist page (first page or continuation).
   * rows      = the recognised entries in page order (a video may repeat)
   * looseIds  = every videoId found anywhere (a last-resort fallback, see scanPlaylist)
   * Only real "load more" rows are treated as continuations, so sort-menu tokens are ignored.
   */
  function extractPlaylistData(plData) {
    const rows = [];
    const looseIds = new Set();
    let continuationToken = null;

    walk(plData, (node) => {
      const entryId = playlistEntryId(node);
      if (entryId) rows.push(entryId);
      if (typeof node.videoId === 'string') {
        const norm = normalizeVideoId(node.videoId);
        if (norm) looseIds.add(norm);
      }
      if (node.continuationItemRenderer) {
        const tok = continuationFromRenderer(node.continuationItemRenderer);
        if (tok) continuationToken = tok;
      }
      // Legacy continuation shape
      if (node.nextContinuationData && typeof node.nextContinuationData.continuation === 'string') {
        continuationToken = node.nextContinuationData.continuation;
      }
    }, SKIP_KEYS, 0);

    const continuationCandidates = findContinuationCandidates(plData);
    // The marker in the same list as the videos is the playlist's own "load more"; others (side sections)
    // come after it, in page order, and are only tried if it leads nowhere.
    if (continuationCandidates.length > 0) continuationToken = continuationCandidates[0].token;
    return { rows, looseIds, continuationToken, continuationCandidates };
  }

  /**
   * Every "load more" marker on a playlist page: [{ token, nearRows, where }], the ones that sit in the
   * same list as video entries first. (A page can also carry markers for other sections.)
   */
  function findContinuationCandidates(data) {
    const near = [];
    const other = [];
    const seen = new Set();
    const add = (tok, nearRows, path) => {
      if (!tok || seen.has(tok)) return;
      seen.add(tok);
      (nearRows ? near : other).push({ token: tok, nearRows: nearRows, where: path.length > 160 ? '...' + path.slice(-160) : path });
    };
    (function visit(node, path, depth) {
      if (!node || typeof node !== 'object' || depth > 200) return;
      if (Array.isArray(node)) {
        const hasRows = node.some((el) => el && typeof el === 'object' && !Array.isArray(el) && playlistEntryId(el));
        node.forEach((el, i) => {
          if (el && typeof el === 'object' && el.continuationItemRenderer) {
            add(continuationFromRenderer(el.continuationItemRenderer), hasRows, path + '[' + i + ']');
          }
          visit(el, path + '[' + i + ']', depth + 1);
        });
        return;
      }
      if (node.nextContinuationData && typeof node.nextContinuationData.continuation === 'string') {
        add(node.nextContinuationData.continuation, false, path + '.nextContinuationData');
      }
      for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key)) continue;
        if (key === 'continuationItemRenderer') {
          add(continuationFromRenderer(node[key]), false, path + '.continuationItemRenderer');
          continue;
        }
        visit(node[key], path ? path + '.' + key : key, depth + 1);
      }
    })(data, '', 0);
    return near.concat(other);
  }

  /**
   * The video count YouTube states for a playlist (first page only), or null when it cannot be read.
   * Used to notice a scan that stopped short. Reads both the classic and the newer header shapes.
   */
  function declaredVideoCount(plData) {
    const texts = [];
    walk(plData, (node) => {
      const h = node.playlistHeaderRenderer;
      if (h) {
        texts.push(textOf(h.numVideosText));
        if (Array.isArray(h.stats)) h.stats.forEach((st) => texts.push(textOf(st)));
      }
      const side = node.playlistSidebarPrimaryInfoRenderer;
      if (side && Array.isArray(side.stats)) side.stats.forEach((st) => texts.push(textOf(st)));
      const meta = node.contentMetadataViewModel;
      if (meta && Array.isArray(meta.metadataRows)) {
        meta.metadataRows.forEach((row) => {
          (row && Array.isArray(row.metadataParts) ? row.metadataParts : []).forEach((part) => texts.push(textOf(part && part.text)));
        });
      }
    }, null, 0);

    for (const raw of texts) {
      const t = String(raw || '').replace(/[\u00a0\u202f]/g, ' ').trim();
      if (!/video|v\u00eddeo|vid\u00e9o|\u0432\u0438\u0434\u0435\u043e|\u89c6\u9891|\u5f71\u7247|\u52d5\u753b|\u064a\u0641\u064a\u062f\u064a\u0648|\ub3d9\uc601\uc0c1/i.test(t)) continue;
      if (/^no\s+video/i.test(t)) return 0;
      const m = t.match(/\d[\d.,\s]*/);
      if (m) {
        const n = parseInt(m[0].replace(/\D/g, ''), 10);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  /** Runs fn over items with at most `limit` in flight; results keep the input order. */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = [];
    for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w++) {
      workers.push((async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await fn(items[i], i);
        }
      })());
    }
    await Promise.all(workers);
    return results;
  }

  // ---------- result helpers (declared early so every exit path can use them) ----------

  const failure = (message) => ({ success: false, error: message });

  try {
    // ---------- session checks ----------

    if (/^consent\./i.test(window.location.hostname)) {
      return failure('YouTube is showing a cookie-consent page. Open youtube.com once, accept it, then try again.');
    }

    const getCookie = (name) => {
      if (!document || !document.cookie) return null;
      const value = '; ' + document.cookie;
      const parts = value.split('; ' + name + '=');
      if (parts.length === 2) return parts.pop().split(';').shift();
      return null;
    };

    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID') || getCookie('__Secure-1PAPISID');
    if (!sapisid) {
      return failure('Not signed into YouTube. Please log into YouTube in Chrome first.');
    }

    // ---------- input validation ----------

    const baseTitle = sanitizeTitle(targetPlaylistTitle);

    const validVideoTabs = [];
    if (Array.isArray(rawVideoTabs)) {
      for (const item of rawVideoTabs) {
        if (item && Number.isInteger(item.tabId) && item.tabId > 0) {
          const norm = normalizeVideoId(item.videoId);
          if (norm) {
            const entry = { tabId: item.tabId, videoId: norm };
            // An "Add to queue" queue (temporary TL... list) whose tab could not be read: load it from YouTube.
            if (typeof item.queueListId === 'string' && /^TL[A-Za-z0-9_-]{2,62}$/.test(item.queueListId)) {
              entry.queueListId = item.queueListId;
            }
            validVideoTabs.push(entry);
          }
        }
      }
    }
    if (validVideoTabs.length === 0) {
      return failure('No valid YouTube video tabs provided.');
    }

    // ---------- YouTube page config (API key, client version, context) ----------

    const cfgGet = (key) => {
      try {
        if (window.ytcfg && typeof window.ytcfg.get === 'function') {
          const v = window.ytcfg.get(key);
          if (v !== undefined && v !== null) return v;
        }
      } catch (e) { /* fall through to raw data */ }
      return window.ytcfg && window.ytcfg.data_ ? window.ytcfg.data_[key] : undefined;
    };

    // The tab may still be booting; wait for YouTube to publish its config.
    let apiKey = null;
    const waitStart = Date.now();
    while (!apiKey && Date.now() - waitStart < cfg.YTCFG_WAIT_MS) {
      apiKey = cfgGet('INNERTUBE_API_KEY') || null;
      if (!apiKey) await sleep(250);
    }
    if (!apiKey) {
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      const matchKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      apiKey = matchKey ? matchKey[1] : null;
    }
    if (!apiKey) {
      return failure('Failed to retrieve YouTube InnerTube API Key from page context.');
    }

    if (cfgGet('LOGGED_IN') === false) {
      return failure('Not signed into YouTube. Please log into YouTube in Chrome first.');
    }

    const clientVersion = cfgGet('INNERTUBE_CLIENT_VERSION') || '2.20260101.00.00';
    const clientName = String(cfgGet('INNERTUBE_CONTEXT_CLIENT_NAME') || '1');

    let context = { client: { clientName: 'WEB', clientVersion: clientVersion } };
    const pageContext = cfgGet('INNERTUBE_CONTEXT');
    if (pageContext) {
      try { context = JSON.parse(JSON.stringify(pageContext)); } catch (e) { /* keep default */ }
    }

    const origin = window.location.origin;

    // ---------- request helper ----------

    // Which signed-in account / channel the page is using (several Google accounts, or a brand channel).
    // YouTube's own requests carry these; without them the request goes to the first signed-in account.
    const accountHeaders = {};
    {
      const sessionIndex = cfgGet('SESSION_INDEX');
      if (sessionIndex !== undefined && sessionIndex !== null && /^\d+$/.test(String(sessionIndex))) accountHeaders['X-Goog-AuthUser'] = String(sessionIndex);
      const pageId = cfgGet('DELEGATED_SESSION_ID');
      if (typeof pageId === 'string' && /^\d+$/.test(pageId)) accountHeaders['X-Goog-PageId'] = pageId;
    }

    /** SAPISIDHASH is time-based, so it is recomputed for every request. */
    async function buildAuthHeader() {
      const time = Math.floor(Date.now() / 1000);
      const bytes = new TextEncoder().encode(time + ' ' + sapisid + ' ' + origin);
      const digest = await crypto.subtle.digest('SHA-1', bytes);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return 'SAPISIDHASH ' + time + '_' + hex;
    }

    /**
     * POST to an InnerTube endpoint. Never throws.
     * Reads (the default) are retried on 429, 5xx, network errors and timeouts, with backoff.
     * Writes (opts.retryNetwork === false) are retried only on 429 ("too many requests" - not carried out):
     * a 5xx or a timeout may come after the write was already done, and repeating it could add a video twice
     * or create a second playlist.
     * attempts and ms (time taken, all attempts together) are for the save report only.
     * @returns {Promise<{ok: boolean, status: number, data: any, error: (string|null), attempts: number, ms: number}>}
     */
    async function ytPost(path, payload, opts) {
      const retryNetwork = !opts || opts.retryNetwork !== false;
      const started = Date.now();
      let last = { ok: false, status: 0, data: null, error: 'Unknown error' };
      let attempts = 0;

      for (let attempt = 0; attempt <= cfg.REQUEST_MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.REQUEST_TIMEOUT_MS);
        let retryable = false;
        attempts++;
        try {
          const res = await fetch(path + '?key=' + encodeURIComponent(apiKey) + '&prettyPrint=false', {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': await buildAuthHeader(),
              'X-YouTube-Client-Name': clientName,
              'X-YouTube-Client-Version': clientVersion,
              'X-Origin': origin,
              ...accountHeaders
            },
            body: JSON.stringify(payload)
          });

          let data = null;
          try { data = await res.json(); } catch (e) { data = null; }

          if (res.ok) return { ok: true, status: res.status, data: data, error: null, attempts: attempts, ms: Date.now() - started };

          const apiMessage = data && data.error && data.error.message ? ': ' + data.error.message : '';
          last = { ok: false, status: res.status, data: data, error: 'HTTP ' + res.status + apiMessage };
          retryable = res.status === 429 || (retryNetwork && res.status >= 500);
        } catch (err) {
          const text = err && err.name === 'AbortError' ? 'Request timed out' : errorText(err);
          last = { ok: false, status: 0, data: null, error: text };
          retryable = retryNetwork;
        } finally {
          clearTimeout(timer);
        }

        if (!retryable || attempt === cfg.REQUEST_MAX_RETRIES) break;
        await sleep(500 * Math.pow(2, attempt));
      }
      return Object.assign({}, last, { attempts: attempts, ms: Date.now() - started });
    }

    // ---------- playlist discovery ----------

    /** cleanTitle -> [playlistId, ...] from what YouTube says the user really has. */
    const livePlaylists = new Map();
    function rememberLive(title, playlistId) {
      const key = cleanTitle(title);
      const id = stripVL(playlistId);
      if (!key || !id) return;
      const list = livePlaylists.get(key) || [];
      if (!list.includes(id)) list.push(id);
      livePlaylists.set(key, list);
    }

    /** cleanTitle -> playlistId remembered from earlier runs (only a hint; may be stale). */
    const cachedPlaylists = new Map();
    if (storedPlaylistCache && typeof storedPlaylistCache === 'object') {
      for (const [k, v] of Object.entries(storedPlaylistCache)) {
        if (typeof v === 'string' && v) cachedPlaylists.set(cleanTitle(k), stripVL(v));
      }
    }
    const cacheRemovals = [];

    // Whether the two playlist lists could be read in full (a playlist missing from a list that failed may
    // still exist; creating it again would make a second playlist with the same name).
    const listing = { dialogFailed: null, libraryFailed: null, libraryFound: 0 };

    let addDialogLoaded = false;
    async function loadAddToPlaylistListing(sampleVideoId) {
      if (addDialogLoaded) return;
      addDialogLoaded = true;
      let continuation = null;
      let pages = 0;
      const seen = new Set();
      do {
        const payload = continuation
          ? { context: context, continuation: continuation }
          : { context: context, videoIds: [sampleVideoId] };
        const r = await ytPost('/youtubei/v1/playlist/get_add_to_playlist', payload);
        if (!r.ok) { listing.dialogFailed = r.error || 'request failed'; break; }
        continuation = null;
        walk(r.data, (node) => {
          const renderer = node.playlistAddToOptionRenderer || node.playlistOptionRenderer ||
                           node.addToPlaylistOptionRenderer || node.compactPlaylistRenderer;
          if (renderer) {
            const title = textOf(renderer.title);
            const pid = renderer.playlistId || renderer.targetPlaylistId;
            if (title && pid) rememberLive(title, pid);
          }
          if (node.continuationItemRenderer) {
            const tok = continuationFromRenderer(node.continuationItemRenderer);
            if (tok && !seen.has(tok)) { continuation = tok; seen.add(tok); }
          }
        }, null, 0);
        pages++;
      } while (continuation && pages < cfg.MAX_LISTING_PAGES);
    }

    let libraryLoaded = false;
    async function loadLibraryListing() {
      if (libraryLoaded) return;
      libraryLoaded = true;
      let continuation = null;
      let pages = 0;
      const seen = new Set();
      do {
        const payload = continuation
          ? { context: context, continuation: continuation }
          : { context: context, browseId: 'FEplaylist_aggregation' };
        const r = await ytPost('/youtubei/v1/browse', payload);
        if (!r.ok) { listing.libraryFailed = r.error || 'request failed'; break; }
        continuation = null;
        walk(r.data, (node) => {
          const pr = node.gridPlaylistRenderer || node.playlistRenderer;
          if (pr) {
            const title = textOf(pr.title);
            if (title && pr.playlistId) { rememberLive(title, pr.playlistId); listing.libraryFound++; }
          }
          // Newer library layout
          const lockup = node.lockupViewModel;
          if (lockup && /PLAYLIST/.test(String(lockup.contentType || '')) && lockup.contentId) {
            const meta = lockup.metadata && lockup.metadata.lockupMetadataViewModel;
            const title = meta ? textOf(meta.title) : '';
            if (title) { rememberLive(title, lockup.contentId); listing.libraryFound++; }
          }
          if (node.continuationItemRenderer) {
            const tok = continuationFromRenderer(node.continuationItemRenderer);
            if (tok && !seen.has(tok)) { continuation = tok; seen.add(tok); }
          }
        }, null, 0);
        pages++;
      } while (continuation && pages < cfg.MAX_LISTING_PAGES);
    }

    /**
     * Finds a playlist by (cleaned) title. Live results win over the cache; the library page
     * is only fetched if the quick "save to playlist" list did not contain the title.
     */
    async function findPlaylist(clean) {
      await loadAddToPlaylistListing(validVideoTabs[0].videoId);
      let ids = livePlaylists.get(clean);
      let via = 'dialog';
      if (!ids || ids.length === 0) {
        await loadLibraryListing();
        ids = livePlaylists.get(clean);
        via = 'library';
      }
      const cachedId = cachedPlaylists.get(clean);
      if (ids && ids.length > 0) {
        return { id: cachedId && ids.includes(cachedId) ? cachedId : ids[0], fromCache: false, via: via };
      }
      if (cachedId) return { id: cachedId, fromCache: true, via: 'cache' };
      return null;
    }

    // ---------- playlist scan ----------

    /**
     * Reads the entries of a playlist page by page.
     * state: COMPLETE | INCOMPLETE (stopped part-way) | FAILED (could not read) | MISSING (does not exist)
     * Also returns: rows (entries in order), ids (distinct), itemCount, declared (the count YouTube
     * states, or null), usedLoose (no entries were recognised, so any videoId on the page was used).
     * opts.maxRows stops early once that many entries were read (used when expanding a queue).
     */
    /**
     * For troubleshooting the scan against YouTube's real pages: where the reply mentions
     * "continuation" (the "load more" marker), and what the last entry of the longest list is.
     */
    function continuationEvidence(data) {
      const hits = [];
      let biggest = 0;
      let lastRow = null;
      (function walk(node, path, depth) {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (Array.isArray(node)) {
          if (node.length > biggest) {
            biggest = node.length;
            try { lastRow = JSON.stringify(node[node.length - 1]).slice(0, 700); } catch (e) { lastRow = null; }
          }
          node.forEach((v, i) => walk(v, path + '[' + i + ']', depth + 1));
          return;
        }
        for (const k of Object.keys(node)) {
          const p = path ? path + '.' + k : k;
          if (/continuation/i.test(k) && hits.length < 25) {
            const v = node[k];
            hits.push({ path: p.length > 220 ? '...' + p.slice(-220) : p,
                        value: typeof v === 'string' ? v.slice(0, 16) + '...' : (v && typeof v === 'object' ? Object.keys(v).slice(0, 8) : v) });
          }
          walk(node[k], p, depth + 1);
        }
      })(data, '', 0);
      return { hits: hits, longestList: biggest, lastEntryOfLongestList: lastRow };
    }

    async function scanPlaylist(playlistId, opts) {
      const maxRows = opts && opts.maxRows ? opts.maxRows : 0;
      const browseId = 'VL' + stripVL(playlistId);
      const rows = [];
      const loose = new Set();
      let declared = null;
      let token = null;
      let pages = 0;
      let cappedByRows = false;
      let evidence = null;
      const seenTokens = new Set();
      let spare = [];                   // other markers from the last page that had videos
      let followingNear = true;         // is the marker being followed the one beside the videos?
      let offPathFrom = null;           // rows index from which rows came via a marker NOT beside the videos
      let firstPageMarkers = null;      // diagnostics
      const attempts = [];              // diagnostics

      const finish = (state, error) => {
        // Rows reached through a side-section marker are kept only if YouTube states a count and the total
        // stays within it; otherwise they may be some other list's videos and are dropped.
        if (offPathFrom !== null && (declared === null || rows.length > declared)) {
          rows.length = offPathFrom;
          if (state === 'COMPLETE') state = 'INCOMPLETE';
        }
        const usedLoose = rows.length === 0 && loose.size > 0;
        const ids = new Set(usedLoose ? loose : rows);
        return { state: state, rows: rows, ids: ids, itemCount: usedLoose ? loose.size : rows.length,
                 declared: declared, usedLoose: usedLoose, error: error || null, pages: pages, evidence: evidence,
                 markers: firstPageMarkers, attempts: attempts };
      };

      do {
        const payload = token ? { context: context, continuation: token } : { context: context, browseId: browseId };
        const r = await ytPost('/youtubei/v1/browse', payload);

        if (!r.ok) {
          if (pages === 0 && (r.status === 404 || r.status === 400)) return finish('MISSING', r.error);
          return finish(pages > 0 ? 'INCOMPLETE' : 'FAILED', r.error);
        }

        if (pages === 0) {
          const alerts = r.data && Array.isArray(r.data.alerts) ? r.data.alerts : [];
          if (alerts.some((a) => a && a.alertRenderer && a.alertRenderer.type === 'ERROR')) {
            return finish('MISSING', 'Playlist is unavailable.');
          }
          declared = declaredVideoCount(r.data);
        }

        const extracted = extractPlaylistData(r.data);
        try { evidence = continuationEvidence(r.data); } catch (e) { evidence = null; }   // kept for the last page read
        const markers = extracted.continuationCandidates || [];
        if (pages === 0) firstPageMarkers = markers.slice(0, 10).map((c) => ({ nearVideos: c.nearRows, where: c.where }));
        if (pages > 0 && attempts.length < 20) attempts.push({ nearVideos: followingNear, videos: extracted.rows.length, markersOnPage: markers.length });
        for (const id of extracted.rows) rows.push(id);
        extracted.looseIds.forEach((id) => loose.add(id));

        const fresh = markers.filter((c) => !seenTokens.has(c.token));
        let next = null;
        if (pages === 0 || extracted.rows.length > 0) {
          next = fresh.shift() || null;            // the one beside the videos comes first
          spare = fresh;
        } else if (fresh.length > 0) {
          next = fresh.shift();                     // an empty page that offers its own marker
          spare = fresh.concat(spare);
        } else if (spare.length > 0) {
          next = spare.shift();                     // dead end: try the next marker from the last page with videos
        }
        token = null;
        if (next) {
          token = next.token;
          seenTokens.add(token);
          followingNear = next.nearRows;
          if (!next.nearRows && offPathFrom === null) offPathFrom = rows.length;
        }
        pages++;
        if (maxRows && rows.length >= maxRows) { cappedByRows = true; break; }
      } while (token && pages < cfg.MAX_SCAN_PAGES);

      const out = finish(token && !cappedByRows ? 'INCOMPLETE' : 'COMPLETE', null);
      out.cappedByRows = cappedByRows;
      return out;
    }

    // ---------- "is this video already in that playlist?" (YouTube's own answer) ----------

    // videoId -> { map: Map(playlistId -> 'ALL'|'NONE'|'SOME'), exhausted: boolean, failure: string|null }
    const membershipCache = new Map();

    // Save report only: every "already in playlist?" check and, when YouTube gave no answer, why.
    // Nothing here changes what is saved.
    const checkLog = [];
    const checkStats = { total: 0, ALL: 0, NONE: 0, SOME: 0, noAnswer: 0, noAnswerWhy: {} };
    function logCheck(entry) {
      checkStats.total++;
      if (entry.result) checkStats[entry.result] = (checkStats[entry.result] || 0) + 1;
      else {
        checkStats.noAnswer++;
        const key = String(entry.why || 'unknown').slice(0, 80);
        checkStats.noAnswerWhy[key] = (checkStats.noAnswerWhy[key] || 0) + 1;
      }
      if (checkLog.length < 400) checkLog.push(entry);
    }

    /**
     * Asks the same "Save to..." dialog YouTube shows, for ONE video. It reports, per playlist,
     * whether the video is already in it. This does not depend on parsing the playlist page, so it
     * protects against duplicates even when the page scan is wrong or short.
     * Returns 'ALL' | 'NONE' | 'SOME', or null when YouTube did not say.
     */
    async function membershipState(videoId, playlistId) {
      let entry = membershipCache.get(videoId);
      if (entry && (entry.map.has(playlistId) || entry.exhausted)) {
        const known = entry.map.get(playlistId) || null;
        if (!known) logCheck({ videoId: videoId, playlistId: playlistId, result: null, asked: false,
          why: entry.failure ? 'not asked again: ' + entry.failure : 'not asked again: an earlier answer did not list this playlist' });
        return known;
      }

      if (!entry) { entry = { map: new Map(), exhausted: false, failure: null }; membershipCache.set(videoId, entry); }
      let continuation = null;
      let pages = 0;
      let requests = 0;
      let attempts = 0;
      let ms = 0;
      let failed = null;                // the failed request, if any
      let lastAnswer = null;            // the last answer that came back (for the report when it named no playlist)
      let optionsSeen = 0;
      const seen = new Set();
      do {
        const payload = continuation ? { context: context, continuation: continuation } : { context: context, videoIds: [videoId] };
        const r = await ytPost('/youtubei/v1/playlist/get_add_to_playlist', payload);
        requests++;
        attempts += r.attempts || 0;
        ms += r.ms || 0;
        if (!r.ok) { failed = r; entry.exhausted = true; break; }
        lastAnswer = r.data;
        continuation = null;
        walk(r.data, (node) => {
          const option = node.playlistAddToOptionRenderer;
          if (option && typeof option.playlistId === 'string' && typeof option.containsSelectedVideos === 'string') {
            entry.map.set(stripVL(option.playlistId), option.containsSelectedVideos);
            optionsSeen++;
          }
          if (node.continuationItemRenderer) {
            const tok = continuationFromRenderer(node.continuationItemRenderer);
            if (tok && !seen.has(tok)) { continuation = tok; seen.add(tok); }
          }
        }, null, 0);
        pages++;
        if (entry.map.has(playlistId)) break;
      } while (continuation && pages < cfg.MAX_LISTING_PAGES);
      if (!continuation) entry.exhausted = true;

      const result = entry.map.get(playlistId) || null;
      const log = { videoId: videoId, playlistId: playlistId, result: result, asked: true,
                    requests: requests, attempts: attempts, ms: ms, playlistsListed: optionsSeen };
      if (!result) {
        if (failed) {
          log.why = failed.error || 'request failed';
          log.http = failed.status;
          if (failed.data) { try { log.raw = JSON.stringify(failed.data).slice(0, 400); } catch (e) { /* ignore */ } }
        } else if (continuation) {
          log.why = 'playlist not listed in the first ' + pages + ' pages of the answer';
        } else if (optionsSeen === 0) {
          log.why = 'answer listed no playlists';
        } else {
          log.why = 'answer did not list this playlist';
        }
        if (!failed && lastAnswer) {
          try {
            log.keys = Object.keys(lastAnswer).slice(0, 12);
            log.raw = JSON.stringify(lastAnswer).slice(0, 600);
          } catch (e) { /* ignore */ }
        }
        entry.failure = failed ? (failed.error || 'request failed') : null;
      }
      logCheck(log);
      return result;
    }

    /**
     * Opens link N of the overflow chain ("Title", "Title [OVERFLOW]", ...).
     * Returns a segment; segment.scanFailure is set only when an existing playlist has vanished
     * (it was listed but cannot be opened). An incomplete or unreadable scan is NOT fatal any more:
     * the segment is marked untrusted and each video is then checked individually instead.
     */
    async function openSegment(index) {
      const title = makeTitle(baseTitle, index);
      const clean = cleanTitle(title);
      const empty = { index: index, title: title, playlistId: null, count: 0, ids: new Set(), exists: false, added: 0, created: false,
                      via: null, trusted: true, scan: null, existsByScan: 0, existsByDialog: 0, unverified: 0 };

      const found = await findPlaylist(clean);
      if (!found) {
        // Not found - but only trust that if YouTube's list of your playlists could actually be read.
        if (listing.dialogFailed && (listing.libraryFailed || listing.libraryFound === 0)) {
          return Object.assign({}, empty, {
            scanFailure: true, scanState: 'LISTING_FAILED',
            scanError: 'YouTube did not return your list of playlists (' + listing.dialogFailed +
              (listing.libraryFailed ? '; ' + listing.libraryFailed : '') + ').'
          });
        }
        return empty;
      }

      const scan = await scanPlaylist(found.id);

      // A remembered playlist that no longer exists (deleted on YouTube) must not block saving.
      if (scan.state === 'MISSING' && found.fromCache) {
        cacheRemovals.push(clean);
        return empty;
      }
      if (scan.state === 'MISSING') {
        return Object.assign({}, empty, {
          playlistId: found.id, scanFailure: true, scanState: scan.state, scanError: scan.error, via: found.via
        });
      }

      // The page scan is only trusted if it finished, recognised real entries, and found at least
      // as many as YouTube says the playlist holds.
      const trusted = scan.state === 'COMPLETE' && !scan.usedLoose &&
        (scan.declared === null || scan.itemCount >= scan.declared);

      return Object.assign({}, empty, {
        playlistId: found.id, count: Math.max(scan.itemCount, scan.declared || 0), ids: scan.ids, exists: true,
        via: found.via, trusted: trusted,
        scan: { state: scan.state, itemCount: scan.itemCount, declared: scan.declared, usedLoose: scan.usedLoose, error: scan.error,
                pages: scan.pages, markers: scan.markers, attempts: scan.attempts, lastPage: scan.evidence }
      });
    }

    // ---------- write operations ----------

    async function createPlaylist(title) {
      const r = await ytPost('/youtubei/v1/playlist/create',
        { context: context, title: title, privacyStatus: cfg.NEW_PLAYLIST_PRIVACY },
        { retryNetwork: false });
      if (!r.ok) return { ok: false, error: 'Failed to create playlist "' + title + '": ' + r.error };
      const id = r.data && r.data.playlistId;
      if (typeof id !== 'string' || !id) {
        return { ok: false, error: 'YouTube API did not return a valid playlist ID upon creation.' };
      }
      return { ok: true, playlistId: stripVL(id) };
    }

    /** Success only when YouTube explicitly confirms it (fail closed). */
    function evaluateEditResponse(data) {
      const status = data && data.status;
      if (status === 'STATUS_SUCCEEDED' || status === 'STATUS_SUCCESS') return { ok: true };
      if (status) return { ok: false, error: String(status) };
      if (data && data.error) return { ok: false, error: data.error.message || 'API error' };
      if (data && Array.isArray(data.playlistEditResults) && data.playlistEditResults.length > 0) return { ok: true };
      return { ok: false, error: 'Unrecognised response from YouTube (no confirmation received)' };
    }

    /**
     * Read-only: is this video private, deleted, or playable? Uses the request a watch page makes.
     * kind: 'private' | 'deleted' | 'other' (not playable for another reason) | 'playable' | 'unknown' (no answer)
     */
    async function videoStatus(videoId) {
      const r = await ytPost('/youtubei/v1/player', { context: context, videoId: videoId });
      if (!r.ok) return { kind: 'unknown', error: r.error, http: r.status };
      const ps = r.data && r.data.playabilityStatus ? r.data.playabilityStatus : {};
      const status = typeof ps.status === 'string' ? ps.status : '';
      const pem = ps.errorScreen && ps.errorScreen.playerErrorMessageRenderer;
      const reason = [textOf(ps.reason), pem ? textOf(pem.reason) : '', pem ? textOf(pem.subreason) : '']
        .filter(Boolean).join(' | ').slice(0, 200);
      let kind;
      if (status === 'OK') kind = 'playable';
      else if (/private/i.test(reason)) kind = 'private';
      else if (status === 'ERROR') kind = 'deleted';
      else if (status) kind = 'other';
      else kind = 'unknown';
      return { kind: kind, status: status || null, reason: reason || null };
    }

    async function addVideo(playlistId, videoId) {
      const body = {
        context: context,
        playlistId: playlistId,
        actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }]
      };
      let r = await ytPost('/youtubei/v1/browse/edit_playlist', body, { retryNetwork: false });

      // Legacy endpoint fallback, only for "not found". Keep the original error if it fails too.
      if (!r.ok && r.status === 404) {
        const legacy = await ytPost('/youtubei/v1/playlist/edit', body, { retryNetwork: false });
        if (legacy.ok) r = legacy;
      }

      const answer = {
        http: r.status,
        status: r.data && typeof r.data.status === 'string' ? r.data.status : null,
        keys: r.data && typeof r.data === 'object' ? Object.keys(r.data).slice(0, 12) : [],
        raw: r.data ? JSON.stringify(r.data).slice(0, 600) : null,
        actions: r.data && r.data.actions ? JSON.stringify(r.data.actions).slice(0, 1500) : null,
        // Report only: a normal add's reply lists the edit in playlistEditResults. In real saves the replies
        // without it were the videos that never showed up in the playlist.
        editResults: r.data && Array.isArray(r.data.playlistEditResults) ? r.data.playlistEditResults.length : null,
        ms: r.ms || 0
      };
      if (!r.ok) return { ok: false, error: r.error, fatal: r.status === 401 || r.status === 403, answer: answer };
      const verdict = evaluateEditResponse(r.data);
      return verdict.ok ? { ok: true, answer: answer } : { ok: false, error: verdict.error, fatal: false, answer: answer };
    }

    // ---------- load queues that could not be read in full from their tab ----------
    //
    // A tab's queue panel only shows part of a long queue (a slice around the current video), and a
    // sleeping tab shows nothing. For those tabs the worker sends the queue's id ("TL..."), and the whole
    // queue is loaded here, page by page, the same way the watch page does. Each queue is loaded once,
    // however many tabs share it.

    /**
     * Returns { ids (queue order), complete, error }.
     * complete = every position of the queue was read (or YouTube did not say how long it is).
     */
    const queueLoadLog = [];            // diagnostics: one entry per queue loaded
    async function loadQueueFromYouTube(videoId, listId) {
      const log = { listId: listId, fromVideo: videoId, requests: 0, total: null, read: 0, error: null, firstAnswer: null };
      queueLoadLog.push(log);
      const byIndex = new Map();        // queue position -> videoId
      const gone = new Set();           // positions of deleted / unavailable videos (read, nothing to save)
      const unindexed = [];             // entries that did not say their position (kept in the order seen)
      const requested = new Set();
      let total = null;
      let lastError = null;
      const cap = cfg.MAX_QUEUE_VIDEOS_PER_TAB;

      async function fetchWindow(payload) {
        const r = await ytPost('/youtubei/v1/next', payload);
        log.requests++;
        if (log.firstAnswer === null) {
          log.firstAnswer = { http: r.status, keys: r.data && typeof r.data === 'object' ? Object.keys(r.data).slice(0, 12) : [],
            raw: r.data ? JSON.stringify(r.data).slice(0, 800) : String(r.error) };
        }
        if (!r.ok) { lastError = r.error; return 0; }
        let added = 0;
        let found = false;
        walk(r.data, (node) => {
          if (found) return false;
          const panel = node.playlist;
          if (panel && typeof panel === 'object' && Array.isArray(panel.contents) &&
              (!panel.playlistId || stripVL(panel.playlistId) === listId)) {
            found = true;
            if (Number.isFinite(panel.totalVideos) && panel.totalVideos > 0) total = panel.totalVideos;
            for (const entry of panel.contents) {
              if (!entry) continue;
              const wrapper = entry.playlistPanelVideoWrapperRenderer;
              const renderer = entry.playlistPanelVideoRenderer ||
                (wrapper && wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer);
              if (!renderer) continue;
              const id = normalizeVideoId(renderer.videoId);
              const nav = renderer.navigationEndpoint && renderer.navigationEndpoint.watchEndpoint;
              const pos = nav && Number.isInteger(nav.index) && nav.index >= 0 ? nav.index : null;
              if (!id) {
                if (pos !== null && !gone.has(pos)) { gone.add(pos); added++; }
                continue;
              }
              if (pos !== null) {
                if (!byIndex.has(pos)) { byIndex.set(pos, id); added++; }
              } else if (!unindexed.includes(id)) {
                unindexed.push(id); added++;
              }
            }
            return false;
          }
        }, null, 0);
        if (!found && !lastError) lastError = 'YouTube did not return this queue (it may have expired).';
        return added;
      }

      await fetchWindow({ context: context, videoId: videoId, playlistId: listId });
      let pages = 1;
      // Page through the rest: ask for the first position not read yet (and not already asked for).
      const readCount = () => byIndex.size + gone.size;
      while (total !== null && readCount() < total && byIndex.size < cap && pages < cfg.MAX_QUEUE_PAGES) {
        let next = 0;
        while (next < total && (byIndex.has(next) || gone.has(next) || requested.has(next))) next++;
        if (next >= total) break;
        requested.add(next);
        await fetchWindow({ context: context, playlistId: listId, playlistIndex: next });
        pages++;
      }

      const ids = [];
      Array.from(byIndex.keys()).sort((x, y) => x - y).forEach((k) => { const id = byIndex.get(k); if (!ids.includes(id)) ids.push(id); });
      unindexed.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
      const complete = ids.length > 0 && (total === null || readCount() >= total || byIndex.size >= cap);
      let error = null;
      if (ids.length === 0) error = lastError || 'YouTube did not return this queue (it may have expired).';
      else if (!complete) error = 'Only ' + readCount() + ' of the ' + total + ' videos in this queue could be loaded.' + (lastError ? ' ' + lastError : '');
      log.total = total; log.read = readCount(); log.error = error;
      return { ids: ids.slice(0, cap), complete: complete, error: error };
    }

    // ---------- work through the tabs in order ----------
    //
    // Each video is handled in tab order: already in the playlist -> skipped, otherwise added.
    // A tab whose queue the scan could not read in full (a sleeping tab, or a long queue its page showed
    // only part of) is expanded when the save reaches it: the queue is loaded from YouTube and its videos
    // are handled right there, in the tab's place. (Sleeping tabs are never woken: a snoozed tab loses
    // its queue, so waking it cannot bring the queue back.)

    const queueNotes = [];
    const batchItems = [];              // every (tab, video) handled, in order
    const groupsByVideo = new Map();    // videoId -> candidate
    const candidates = [];              // distinct videos, in the order first met
    const outcome = new Map();          // videoId -> 'added' | 'exists' | 'failed'
    const errors = [];
    const loadedQueues = new Map();     // queue id -> YouTube load result (each queue loaded once)
    let skippedOldQueues = 0;           // queues too old to ask YouTube for
    const knownAtStart = new Set(validVideoTabs.map((t) => t.videoId));
    const allKnown = new Set(knownAtStart);   // every distinct video known so far (grows when a queue is read)

    // (done / total) for the popup: a video counts as done once added, found already present, or failed.
    // The total is every known video from the start; it grows only when a queue adds new ones.
    const reportProgress = () => {
      try {
        window.__ytsProgress = { done: outcome.size, total: allKnown.size };
        document.title = 'Saving tabs (' + outcome.size + ' / ' + allKnown.size + ') - YouTube Tab Saver';
      } catch (e) { /* ignore */ }
    };
    const failCandidate = (candidate, message) => {
      outcome.set(candidate.videoId, 'failed');
      errors.push({ videoId: candidate.videoId, error: message });
    };

    /** The day an "Add to queue" queue was made, from its id (TLPQ + base64 "DDMMYYYY" + ...): "YYYY-MM-DD" or null. */
    function queueMadeOn(listId) {
      try {
        if (typeof listId !== 'string' || !/^TLPQ/.test(listId) || listId.length < 15) return null;
        const m = /^(\d\d)(\d\d)(\d{4})$/.exec(atob(listId.slice(4, 15) + '='));
        return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
      } catch (e) { return null; }
    }

    /** The videos of a tab whose queue has to be loaded now: [videoId, ...] in queue order. */
    async function expandQueue(item, tabIds) {
      const listId = item.queueListId;
      const made = queueMadeOn(listId);
      if (made && cfg.QUEUE_REQUEST_MAX_AGE_DAYS > 0) {
        const p = made.split('-').map(Number);
        const ageDays = Math.floor((Date.now() - new Date(p[0], p[1] - 1, p[2]).getTime()) / 86400000);
        if (ageDays >= cfg.QUEUE_REQUEST_MAX_AGE_DAYS) {
          // Too old for YouTube to still have it: not asked; the tab's own video (and anything its page showed) is saved.
          skippedOldQueues++;
          queueNotes.push({ tabId: item.tabId, listId: listId,
            error: 'This queue is too old to load (made ' + made + ', ' + ageDays + ' days ago; YouTube keeps these queues for about a week), so it was not requested.' });
          return tabIds;
        }
      }
      if (!loadedQueues.has(listId)) loadedQueues.set(listId, await loadQueueFromYouTube(item.videoId, listId));
      const loaded = loadedQueues.get(listId);
      if (!loaded.complete) {
        const made = loaded.ids.length === 0 ? queueMadeOn(listId) : null;
        queueNotes.push({ tabId: item.tabId, listId: listId,
          error: loaded.error + (made ? ' (queue made ' + made + '; these queues expire after about a week)' : '') });
      }
      if (loaded.ids.length === 0) return tabIds;                // nothing from YouTube: keep what the tab had
      const ids = loaded.ids.slice(0, cfg.MAX_QUEUE_VIDEOS_PER_TAB);
      // The tab's own video first if the queue does not list it, then the queue in queue order,
      // then anything else the tab itself showed that the queue did not.
      const merged = ids.includes(item.videoId) ? ids.slice() : [item.videoId].concat(ids);
      tabIds.forEach((v) => { if (!merged.includes(v)) merged.push(v); });
      merged.forEach((v) => allKnown.add(v));
      reportProgress();
      return merged;
    }

    // ---------- the playlist chain ("Title", "Title [OVERFLOW]", ...) ----------

    const segments = [];                // every playlist in the chain that was opened
    let chainBroken = null;             // why no further overflow playlist can be used

    const first = await openSegment(1);
    // Fail closed: never add to a playlist we could not read completely (would risk duplicates).
    if (first.scanFailure) {
      const reason = first.scanState === 'LISTING_FAILED'
        ? 'Could not check whether "' + first.title + '" already exists, so nothing was added (to avoid making a second playlist with the same name). ' + first.scanError
        : 'Could not fully read the existing playlist "' + first.title + '" (' +
          String(first.scanState).toLowerCase() + '); nothing was added to avoid duplicates.' +
          (first.scanError ? ' ' + first.scanError : '');
      return {
        success: false,
        status: 'FAILED',
        scanState: first.scanState,
        playlistId: first.playlistId,
        usedTitle: first.title,
        error: reason,
        summary: {
          totalCandidateTabs: validVideoTabs.length,
          successfullyAddedCount: 0,
          alreadyExistedInPlaylistCount: 0,
          duplicateInBatchCount: 0,
          failedCount: validVideoTabs.length
        },
        tabs: {
          addedTabIds: [],
          alreadyExistedInPlaylistTabIds: [],
          duplicateInBatchTabIds: [],
          failedTabIds: validVideoTabs.map((t) => t.tabId)
        },
        errors: [{ error: reason }],
        playlists: [],
        cacheRemovals: cacheRemovals
      };
    }
    segments.push(first);
    let current = first;                // where new videos go

    async function openNextSegment() {
      const index = segments.length + 1;
      if (index > cfg.MAX_OVERFLOW_PLAYLISTS) {
        chainBroken = 'Too many overflow playlists for "' + baseTitle + '".';
        return null;
      }
      const seg = await openSegment(index);
      if (seg.scanFailure) {
        chainBroken = seg.scanState === 'LISTING_FAILED'
          ? 'Could not check whether "' + seg.title + '" already exists, so nothing more was added. ' + seg.scanError
          : 'Could not fully read the existing playlist "' + seg.title + '" (' +
            String(seg.scanState).toLowerCase() + '); nothing more was added to avoid duplicates.' +
            (seg.scanError ? ' ' + seg.scanError : '');
        return null;
      }
      segments.push(seg);
      return seg;
    }

    /**
     * Is the video already in this playlist? Two independent answers are combined: the page scan, and
     * YouTube's own per-video "Save to..." answer. Either saying "already there" is enough to skip it.
     * Returns 'exists' | 'add' | 'unsure' (cannot tell, and the scan cannot be trusted).
     */
    async function checkIn(seg, videoId) {
      if (!seg.exists) return 'add';
      if (seg.ids.has(videoId)) { seg.existsByScan++; return 'exists'; }
      const state = await membershipState(videoId, seg.playlistId);
      if (state === 'ALL' || state === 'SOME') { seg.existsByDialog++; return 'exists'; }
      if (state === 'NONE' || seg.trusted) return 'add';
      seg.unverified++;
      return 'unsure';
    }

    // Check the videos already known against the playlist up front (a few at a time), so the progress
    // count moves while this runs and the tab-by-tab pass below rarely has to wait. Videos found to be
    // already there are settled now; the pass still records them in tab order.
    const settled = new Map();          // videoId -> 'exists' | 'unsure' (decided before the pass)
    if (first.exists) {
      const initial = Array.from(knownAtStart);
      await mapLimit(initial, cfg.MEMBERSHIP_CONCURRENCY, async (v) => {
        const verdict = await checkIn(first, v);
        if (verdict === 'exists' || verdict === 'unsure') {
          settled.set(v, verdict);
          if (verdict === 'exists') { outcome.set(v, 'exists'); reportProgress(); }
        }
      });
    }

    // ---------- the pass ----------

    let abortReason = null;
    let consecutiveFailures = 0;
    const addLog = [];                  // diagnostics: every add and YouTube's answer
    const addsWithoutEditResults = [];  // "added" videos whose reply had no playlistEditResults
    const addedTo = new Map();          // videoId -> the segment it was added to

    async function handleVideo(item) {
      batchItems.push({ tabId: item.tabId, videoId: item.videoId });
      const known = groupsByVideo.get(item.videoId);
      if (known) { known.dupTabIds.push(item.tabId); return; }      // the same video in another tab
      const c = { videoId: item.videoId, tabId: item.tabId, dupTabIds: [] };
      groupsByVideo.set(c.videoId, c);
      candidates.push(c);
      allKnown.add(c.videoId);
      reportProgress();

      // Settled while checking up front?
      const early = settled.get(c.videoId);
      if (early === 'exists') return;
      if (early === 'unsure') {
        failCandidate(c, 'Could not confirm whether this video is already in "' + first.title + '", so it was not added (to avoid a duplicate).');
        reportProgress();
        return;
      }

      // Already in any playlist of the chain opened so far?
      for (const seg of segments) {
        if (seg === first && first.exists && knownAtStart.has(c.videoId)) continue;   // already checked up front
        const verdict = await checkIn(seg, c.videoId);
        if (verdict === 'exists') { outcome.set(c.videoId, 'exists'); reportProgress(); return; }
        if (verdict === 'unsure') {
          failCandidate(c, 'Could not confirm whether this video is already in "' + seg.title + '", so it was not added (to avoid a duplicate).');
          reportProgress();
          return;
        }
      }

      // Room for it? Otherwise continue into the next playlist of the chain (checking it too).
      while (current && current.count + current.added >= cfg.PLAYLIST_ITEM_LIMIT) {
        const next = segments[segments.indexOf(current) + 1] || await openNextSegment();
        current = next;
        if (!next) break;
        const verdict = await checkIn(next, c.videoId);
        if (verdict === 'exists') { outcome.set(c.videoId, 'exists'); reportProgress(); return; }
        if (verdict === 'unsure') {
          failCandidate(c, 'Could not confirm whether this video is already in "' + next.title + '", so it was not added (to avoid a duplicate).');
          reportProgress();
          return;
        }
      }
      if (!current) { failCandidate(c, chainBroken || 'No playlist available.'); reportProgress(); return; }

      if (!current.playlistId && !abortReason) {
        const created = await createPlaylist(current.title);
        if (created.ok) {
          current.playlistId = created.playlistId;
          current.created = true;
        } else {
          abortReason = created.error;
        }
      }
      if (abortReason || !current.playlistId) {
        failCandidate(c, abortReason || 'Playlist could not be created.');
        reportProgress();
        return;
      }

      const result = await addVideo(current.playlistId, c.videoId);
      if (addLog.length < 300) addLog.push({ videoId: c.videoId, playlistId: current.playlistId, ok: result.ok, error: result.error || null, answer: result.answer || null });
      if (result.ok && result.answer && result.answer.editResults === null && addsWithoutEditResults.length < 1000) {
        addsWithoutEditResults.push(c.videoId);
      }
      if (result.ok) {
        outcome.set(c.videoId, 'added');
        addedTo.set(c.videoId, current);
        current.added++;
        consecutiveFailures = 0;
      } else {
        failCandidate(c, result.error);
        consecutiveFailures++;
        if (result.fatal || consecutiveFailures >= cfg.MAX_CONSECUTIVE_ADD_FAILURES) {
          abortReason = 'Stopped after repeated errors (' + result.error + ').';
        }
      }
      reportProgress();
      await sleep(cfg.ADD_DELAY_MS);
    }

    reportProgress();
    const work = validVideoTabs.slice();
    const expandedTabs = new Set();
    for (let i = 0; i < work.length; i++) {
      const item = work[i];
      if (item.queueListId && !expandedTabs.has(item.tabId)) {
        expandedTabs.add(item.tabId);
        // This tab's entries (they are next to each other): replace them with its whole queue.
        let end = i;
        while (end + 1 < work.length && work[end + 1].tabId === item.tabId) end++;
        const tabIds = work.slice(i, end + 1).map((e) => e.videoId);
        const merged = await expandQueue(item, tabIds);
        work.splice(i, end - i + 1, ...merged.map((v) => ({ tabId: item.tabId, videoId: v })));
      }
      await handleVideo(work[i]);
    }

    reportProgress();

    // ---------- videos YouTube accepted but did not keep ----------
    //
    // A normal add's reply lists the edit in playlistEditResults. In real saves, the "added" videos whose
    // reply lacked it never appeared in the playlist and were not counted in it (private or deleted videos).
    // Each one is looked up once (read-only, the same request a watch page makes) to say which it is.
    // Safety: if YouTube's replies change so that many adds lack the field, nothing is reclassified; and a
    // video the lookup finds playable stays "added".
    const unavailableKind = new Map();  // videoId -> 'private' | 'deleted' | 'other'
    const statusLog = [];               // diagnostics
    let unavailableSkipped = null;      // diagnostics: why the check was not used
    const okAdds = Array.from(outcome.values()).filter((o) => o === 'added').length;
    if (addsWithoutEditResults.length > 0) {
      if (addsWithoutEditResults.length > Math.max(5, Math.floor(okAdds * 0.25))) {
        unavailableSkipped = addsWithoutEditResults.length + ' of ' + okAdds + ' add replies had no playlistEditResults - too many to be unavailable videos, so all were kept as added';
      } else {
        await mapLimit(addsWithoutEditResults.slice(0, cfg.VIDEO_STATUS_MAX_CHECKS), cfg.MEMBERSHIP_CONCURRENCY, async (v) => {
          const st = await videoStatus(v);
          statusLog.push(Object.assign({ videoId: v }, st));
          if (st.kind !== 'playable') unavailableKind.set(v, st.kind === 'unknown' ? 'other' : st.kind);
        });
        // Beyond the lookup cap: the missing edit result alone decides.
        addsWithoutEditResults.slice(cfg.VIDEO_STATUS_MAX_CHECKS).forEach((v) => unavailableKind.set(v, 'other'));
        for (const v of unavailableKind.keys()) {
          outcome.set(v, 'unavailable');
          const seg = addedTo.get(v);
          if (seg && seg.added > 0) seg.added--;
        }
      }
    }

    // ---------- build the result ----------

    /** Small, JSON-safe summary of how each playlist was found and checked (for troubleshooting). */
    const diagnostics = {
      segments: segments.map((sg) => ({
        title: sg.title, playlistId: sg.playlistId, foundVia: sg.via, existed: sg.exists,
        scan: sg.scan, scanTrusted: sg.trusted,
        alreadyThereByScan: sg.existsByScan, alreadyThereByYouTube: sg.existsByDialog, unverified: sg.unverified,
        added: sg.added
      })),
      queueNotes: queueNotes,
      queueLoads: queueLoadLog,
      checks: Object.assign({}, checkStats, { log: checkLog }),
      addsWithoutEditResults: addsWithoutEditResults,
      unavailable: { skipped: unavailableSkipped, lookups: statusLog },
      adds: addLog
    };


    const addedTabIds = [];
    const alreadyExistedInPlaylistTabIds = [];
    const duplicateInBatchTabIds = [];
    const failedTabIds = [];
    const unavailableTabIds = [];       // not saved: YouTube accepted the video but did not keep it
    // Per tab, why something in it was not saved (the close view marks these tabs and shows the reason).
    const tabProblems = [];
    const firstError = new Map();
    errors.forEach((e) => { if (e && e.videoId && !firstError.has(e.videoId)) firstError.set(e.videoId, e.error); });

    for (const c of candidates) {
      const state = outcome.get(c.videoId);
      if (state === 'unavailable' || (state !== 'added' && state !== 'exists')) {
        const detail = state === 'unavailable' ? (unavailableKind.get(c.videoId) || 'other') : (firstError.get(c.videoId) || 'Failed to save.');
        [c.tabId, ...c.dupTabIds].forEach((t) => tabProblems.push({ tabId: t, videoId: c.videoId, kind: state === 'unavailable' ? 'unavailable' : 'failed', detail: detail }));
      }
      if (state === 'unavailable') {
        unavailableTabIds.push(c.tabId, ...c.dupTabIds);
      } else if (state === 'added') {
        addedTabIds.push(c.tabId);
        duplicateInBatchTabIds.push(...c.dupTabIds);
      } else if (state === 'exists') {
        alreadyExistedInPlaylistTabIds.push(c.tabId);
        duplicateInBatchTabIds.push(...c.dupTabIds);
      } else {
        // A duplicate tab of an unsaved video is NOT saved either.
        failedTabIds.push(c.tabId, ...c.dupTabIds);
      }
    }

    const overallSuccess = failedTabIds.length === 0;
    let overallStatus;
    if (overallSuccess) overallStatus = addedTabIds.length > 0 ? 'SUCCESS' : 'NO_ADDITIONS_NEEDED';
    else overallStatus = addedTabIds.length > 0 ? 'PARTIAL_SUCCESS' : 'FAILED';

    const playlists = segments
      .filter((s) => s.playlistId)
      .map((s) => ({ index: s.index, title: s.title, playlistId: s.playlistId, addedCount: s.added, created: s.created }));

    const receiving = segments.filter((s) => s.added > 0);
    const usedTitle = receiving.length > 0
      ? receiving.map((s) => s.title).join(', ')
      : (segments[0] ? segments[0].title : baseTitle);

    const primary = receiving[0] || segments.find((s) => s.playlistId) || null;

    const result = {
      success: overallSuccess,
      status: overallStatus,
      scanState: !segments.some((s) => s.exists) ? 'NOT_REQUIRED'
        : (segments.every((s) => !s.exists || s.trusted) ? 'COMPLETE' : 'UNVERIFIED'),
      playlistId: primary ? primary.playlistId : null,
      usedTitle: usedTitle,
      summary: {
        totalCandidateTabs: batchItems.length,
        successfullyAddedCount: addedTabIds.length,
        alreadyExistedInPlaylistCount: alreadyExistedInPlaylistTabIds.length,
        duplicateInBatchCount: duplicateInBatchTabIds.length,
        failedCount: failedTabIds.length,
        // The same counts per VIDEO (a video open in several tabs counts once); they add up to the
        // "(done / total)" shown while saving.
        videos: {
          total: candidates.length,
          added: candidates.filter((c) => outcome.get(c.videoId) === 'added').length,
          alreadyInPlaylist: candidates.filter((c) => outcome.get(c.videoId) === 'exists').length,
          unavailable: candidates.filter((c) => outcome.get(c.videoId) === 'unavailable').length,
          failed: candidates.filter((c) => { const o = outcome.get(c.videoId); return o !== 'added' && o !== 'exists' && o !== 'unavailable'; }).length
        },
        // How the unavailable videos were told apart (private / deleted / other).
        unavailableKinds: {
          private: candidates.filter((c) => unavailableKind.get(c.videoId) === 'private').length,
          deleted: candidates.filter((c) => unavailableKind.get(c.videoId) === 'deleted').length,
          other: candidates.filter((c) => unavailableKind.get(c.videoId) === 'other').length
        }
      },
      tabs: { addedTabIds, alreadyExistedInPlaylistTabIds, duplicateInBatchTabIds, failedTabIds: Array.from(new Set(failedTabIds)),
              unavailableTabIds: Array.from(new Set(unavailableTabIds)) },
      tabProblems: tabProblems,
      errors: errors,
      playlists: playlists,
      cacheRemovals: cacheRemovals,
      queueNotes: queueNotes,
      skippedOldQueues: skippedOldQueues,
      diagnostics: diagnostics
    };
    if (overallStatus === 'FAILED') {
      result.error = errors[0] && errors[0].error ? errors[0].error : 'Failed to save tabs.';
    }
    return result;

  } catch (fatalInjectedError) {
    return failure('Injected engine execution error: ' + errorText(fatalInjectedError));
  }
}

// --- 3. Background Tab Management -------------------------------------------

/** Tabs this worker opened itself; hidden from audits so they are never offered for closing. */
const activeTempTabIds = new Set();
let saveInProgress = false;
let saveStartedAt = null;
let saveProgress = null;        // { done, total } while a save runs
let saveRunId = 0;              // which save the progress belongs to (a late answer from an ended save is ignored)

// --- 3a. Queues --------------------------------------------------------------

/** The playlist id in a YouTube URL (?list=...), or null. */
function listIdOf(urlStr) {
  try {
    const id = new URL(urlStr).searchParams.get('list');
    return id && /^[A-Za-z0-9_-]{2,64}$/.test(id) ? id : null;
  } catch (e) {
    return null;
  }
}

/**
 * Runs INSIDE a youtube.com tab (serialised by chrome.scripting.executeScript, so it must be
 * self-contained). Reads the queue / playlist panel next to the playing video.
 * Tries, in order: the page's playlist manager data, the panel element's data, then the panel's
 * links in the DOM. Returns JSON-compatible data only.
 */
function readQueueInPage(includeMix, maxItems) {
  'use strict';
  const ID = /^[a-zA-Z0-9_-]{11}$/;
  const result = { source: null, ids: [], title: '', playlistId: null, isMix: false, total: null };

  const textOf = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
    return '';
  };

  function fromData(data) {
    if (!data || !Array.isArray(data.contents)) return null;
    const ids = [];
    for (const entry of data.contents) {
      if (!entry) continue;
      const wrapper = entry.playlistPanelVideoWrapperRenderer;
      const renderer = entry.playlistPanelVideoRenderer ||
        (wrapper && wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer);
      const id = renderer && typeof renderer.videoId === 'string' ? renderer.videoId.trim() : '';
      if (ID.test(id)) ids.push(id);
    }
    if (ids.length === 0) return null;
    return {
      ids: ids,
      playlistId: typeof data.playlistId === 'string' ? data.playlistId : null,
      title: textOf(data.title),
      isInfinite: data.isInfinite === true,
      total: Number.isFinite(data.totalVideos) ? data.totalVideos : null
    };
  }

  function fromDom() {
    const nodes = document.querySelectorAll('ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer');
    const ids = [];
    let playlistId = null;
    nodes.forEach((node) => {
      let id = node.data && typeof node.data.videoId === 'string' ? node.data.videoId.trim() : '';
      if (!ID.test(id)) {
        const a = node.querySelector('a[href*="/watch"]');
        try {
          const u = a ? new URL(a.getAttribute('href') || '', 'https://www.youtube.com') : null;
          id = u ? (u.searchParams.get('v') || '') : '';
          if (u && !playlistId) playlistId = u.searchParams.get('list');
        } catch (e) { id = ''; }
      }
      if (ID.test(id)) ids.push(id);
    });
    if (ids.length === 0) return null;
    let title = '';
    try { const h = document.querySelector('ytd-playlist-panel-renderer #header-description a, ytd-playlist-panel-renderer .title'); title = h ? h.textContent.trim() : ''; } catch (e) { /* ignore */ }
    return { ids: ids, playlistId: playlistId, title: title, isInfinite: false, total: null };
  }

  try {
    let found = null;
    try {
      const mgr = document.querySelector('yt-playlist-manager');
      found = fromData(mgr && mgr.playlistComponent && mgr.playlistComponent.data);
      if (found) result.source = 'manager';
    } catch (e) { found = null; }
    if (!found) {
      try {
        const panel = document.querySelector('ytd-playlist-panel-renderer');
        found = fromData(panel && panel.data);
        if (found) result.source = 'panel';
      } catch (e) { found = null; }
    }
    if (!found) {
      try { found = fromDom(); if (found) result.source = 'dom'; } catch (e) { found = null; }
    }
    if (!found) return result;

    result.playlistId = found.playlistId;
    result.title = found.title;
    result.total = found.total;
    result.isMix = found.isInfinite || /^RD/.test(found.playlistId || '');
    if (result.isMix && !includeMix) return result;

    const seen = new Set();
    for (const id of found.ids) {
      if (!seen.has(id)) { seen.add(id); result.ids.push(id); }
      if (result.ids.length >= maxItems) break;
    }
    return result;
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
    return result;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs INSIDE the save tab: the engine's (done / total) count. */
function readSaveProgressInPage() {
  return window.__ytsProgress || null;
}

/** "Add to queue" queues use temporary-list ids that start with TL; ordinary playlists never do. */
function isQueueListId(id) {
  return typeof id === 'string' && /^TL[A-Za-z0-9_-]{2,62}$/.test(id);
}

/**
 * Reads the QUEUE of one video tab (the list built with "Add to queue").
 * A panel counts as a queue only when it has no playlist id or a temporary "TL..." id. Any other
 * playlist that happens to be open in the tab (PL..., WL, LL, Mix RD..., albums) is ignored.
 * @returns {{status: 'none'|'read'|'unreadable', ids: string[], title: string, queueListId: (string|null), partial: boolean}}
 */
async function readTabQueue(tab) {
  const none = (reason) => ({ status: 'none', ids: [], title: '', queueListId: null, partial: false, reason: reason });
  const urlListId = listIdOf(tab.url);
  const urlQueueId = isQueueListId(urlListId) ? urlListId : null;
  // The page cannot be read, but the address says a queue is playing: load it from YouTube when saving.
  const unreadable = (reason) => (urlQueueId
    ? { status: 'unreadable', ids: [], title: '', queueListId: urlQueueId, partial: false, reason: reason }
    : none(reason));

  if (tab.discarded || tab.status === 'unloaded') return unreadable('asleep');

  let q = null;
  try {
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: readQueueInPage,
      args: [false, CONFIG.MAX_QUEUE_VIDEOS_PER_TAB]
    }), CONFIG.QUEUE_READ_TIMEOUT_MS);
    q = results && results[0] ? results[0].result : null;
  } catch (e) {
    return unreadable(/timed out/.test(String(e && e.message)) ? 'timed out' : 'page refused script');
  }
  if (!q || typeof q !== 'object' || !Array.isArray(q.ids) || q.ids.length === 0) return unreadable('no queue panel');

  const panelId = typeof q.playlistId === 'string' && q.playlistId ? q.playlistId : null;
  if (urlQueueId && panelId && panelId !== urlQueueId) return unreadable('stale panel'); // panel not caught up with the page yet
  if (panelId && !isQueueListId(panelId)) return none('ordinary playlist');           // an ordinary playlist, not a queue

  const ids = Array.from(new Set(q.ids.map(normalizeVideoId).filter(Boolean))).slice(0, CONFIG.MAX_QUEUE_VIDEOS_PER_TAB);
  if (ids.length === 0) return unreadable('no valid ids');
  // The panel only shows part of a long queue: send its id so the whole queue is loaded when saving.
  const partial = Number.isFinite(q.total) && q.total > ids.length && ids.length < CONFIG.MAX_QUEUE_VIDEOS_PER_TAB;
  const queueId = isQueueListId(panelId) ? panelId : urlQueueId;
  return {
    status: 'read', ids: ids, title: typeof q.title === 'string' ? q.title : '',
    queueListId: partial && queueId ? queueId : null, partial: partial,
    reason: partial ? (queueId ? 'partly shown' : 'partly shown, no id') : 'read'
  };
}

/** Runs fn over items, at most `limit` at a time. */
async function mapLimitWorker(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const runners = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) {
    runners.push((async () => {
      while (next < items.length) { const idx = next++; results[idx] = await fn(items[idx]); }
    })());
  }
  await Promise.all(runners);
  return results;
}

/** Did the save engine with this token already start in that tab? (true / false / null = cannot tell) */
async function engineStartedInTab(tabId, runToken) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (t) => { try { return window.sessionStorage.getItem('ytsEngineRun') === t; } catch (e) { return null; } },
      args: [String(runToken)]
    });
    return r && r[0] ? r[0].result : null;
  } catch (e) { return null; }
}

/**
 * Runs the save engine in the tab. A failed injection is retried, but never once the engine has started:
 * a second run right after a playlist was created or videos were added could miss them (YouTube can take
 * a moment to list them) and make a second playlist or add videos twice.
 */
async function runEngineOnce(tabId, args, runToken, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Background tab was closed unexpectedly.');
    try {
      return await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: tabNativeSaveEngine, args: args });
    } catch (err) {
      const started = await engineStartedInTab(tabId, runToken);
      if (started === true) {
        const why = err && err.message ? err.message : String(err);
        throw new Error('The save was interrupted (the save tab closed or reloaded while saving). Run it again - videos already in the playlist are skipped. (' + why + ')');
      }
      // Cannot tell whether it started: do not risk a second run.
      if (started === null || attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/**
 * The helper tab must live in a regular (non-incognito) window: the playlist belongs to the
 * user's normal profile session, which an incognito window does not share.
 */
async function pickRegularWindowId(preferredWindowId) {
  try {
    const wins = await chrome.windows.getAll();
    const regular = wins.filter((w) => w.type === 'normal' && !w.incognito);
    const preferred = regular.find((w) => w.id === preferredWindowId);
    const focused = regular.find((w) => w.focused);
    return (preferred || focused || regular[0] || {}).id;
  } catch (e) {
    return undefined;
  }
}

/**
 * Opens the save tab in the window the popup belongs to, right after the tab you are on (with many
 * tabs open, a tab added at the far end of the strip is easy to miss). It stays open until the save
 * has finished, then the save closes it.
 */
async function createAndPrepareBackgroundTab(preferredWindowId) {
  const createProps = { url: 'https://www.youtube.com', active: false };
  const windowId = await pickRegularWindowId(preferredWindowId);
  if (Number.isInteger(windowId)) {
    createProps.windowId = windowId;
    try {
      const [activeTab] = await chrome.tabs.query({ windowId: windowId, active: true });
      if (activeTab && Number.isInteger(activeTab.index)) createProps.index = activeTab.index + 1;
    } catch (e) { /* no position: Chrome puts it at the end */ }
  }

  const tempTab = await chrome.tabs.create(createProps);
  activeTempTabIds.add(tempTab.id);
  // With many tabs open, Chrome's Memory Saver may unload background tabs; this one must stay loaded
  // until the save is finished (it is closed by the save itself, afterwards).
  try { await chrome.tabs.update(tempTab.id, { autoDiscardable: false }); } catch (e) { /* older Chrome: ignore */ }

  await new Promise((resolve) => {
    let resolved = false;

    const finish = () => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };

    const timer = setTimeout(finish, CONFIG.PAGE_LOAD_TIMEOUT_MS);

    const listener = (tabId, changeInfo) => {
      if (tabId === tempTab.id && changeInfo.status === 'complete') finish();
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tempTab.id).then((tab) => {
      if (tab && tab.status === 'complete') finish();
    }).catch(() => {});
  });

  return tempTab;
}

/**
 * Does this tab still show what was scanned? A tab counts as unchanged when it shows the scanned
 * video, or another video from the scanned queue (autoplay moved on inside the same queue).
 */
function tabStillMatches(tab, item) {
  if (!tab || !tab.url || tab.incognito) return false;
  const cat = categorizeYoutubeUrl(tab.url);
  if (!cat.isVideo) return false;
  if (cat.videoId === item.videoId) return true;
  if (Array.isArray(item.queueVideoIds) && item.queueVideoIds.includes(cat.videoId)) return true;
  return !!item.queueListId && listIdOf(tab.url) === item.queueListId;
}

/**
 * The popup sends tabId + videoId (+ queue) from scan time. Tabs may have been closed or navigated
 * since, so re-check each one; a tab that no longer shows that content is skipped rather than mis-saved.
 */
async function verifyVideoTabs(requested) {
  const checks = await Promise.all(requested.map(async (item) => {
    const tab = await chrome.tabs.get(item.tabId).catch(() => null);
    return tabStillMatches(tab, item);
  }));
  const verified = requested.filter((_, i) => checks[i]);
  return { verified, staleCount: requested.length - verified.length };
}

/** Turns verified tabs into the flat list the save engine takes: one entry per video, in tab order. */
/**
 * For the close view: why something in a tab was not saved (failed, unavailable, or its queue could not be
 * loaded in full), several reasons joined one per line. byTab: tab id -> text. byVideo: the tab's own video
 * id -> text, used when the browser has given the tab a new id since the save (Opera does when a tab sleeps).
 */
function buildTabWarnings(result, verified) {
  const own = new Map((verified || []).map((v) => [v.tabId, v.videoId]));
  const lines = new Map();
  const add = (tabId, text) => {
    if (!Number.isInteger(tabId)) return;
    const list = lines.get(tabId) || [];
    if (!list.includes(text) && list.length < 4) list.push(text);
    lines.set(tabId, list);
  };
  const UNAVAILABLE = { private: 'is private', deleted: 'was deleted', other: 'is unavailable' };
  for (const p of (Array.isArray(result.tabProblems) ? result.tabProblems : [])) {
    const whose = own.get(p.tabId) === p.videoId ? 'This video' : 'A video in this tab\'s queue';
    if (p.kind === 'unavailable') add(p.tabId, 'Not saved: ' + whose.toLowerCase() + ' ' + (UNAVAILABLE[p.detail] || UNAVAILABLE.other) + '.');
    else add(p.tabId, 'Not saved (' + whose.toLowerCase() + '): ' + p.detail);
  }
  for (const n of (Array.isArray(result.queueNotes) ? result.queueNotes : [])) {
    add(n.tabId, 'Queue not fully saved: ' + n.error);
  }
  const byTab = {};
  const byVideo = {};
  lines.forEach((list, tabId) => {
    const text = list.join('\n');
    byTab[tabId] = text;
    const v = own.get(tabId);
    if (v) byVideo[v] = byVideo[v] ? byVideo[v] : text;
  });
  return { byTab: byTab, byVideo: byVideo };
}

function flattenForEngine(verified) {
  const out = [];
  for (const item of verified) {
    const ids = Array.isArray(item.queueVideoIds) && item.queueVideoIds.length > 0 ? item.queueVideoIds.slice() : [];
    if (!ids.includes(item.videoId)) ids.unshift(item.videoId);
    ids.forEach((videoId, i) => {
      const entry = { tabId: item.tabId, videoId: videoId };
      if (i === 0 && item.queueListId) entry.queueListId = item.queueListId;
      out.push(entry);
    });
  }
  return out;
}

// --- 3c. Diagnostics -------------------------------------------------------------
//
// Every save leaves a report in chrome.storage.local ("lastDiagnostics") and in the service worker
// console. To copy it after a save: extensions page -> Developer mode -> this extension ->
// "service worker" -> Console, then run:
//   copy(JSON.stringify(await chrome.storage.local.get(['lastScanDiagnostics', 'lastDiagnostics']), null, 1))
// It contains playlist and video ids and YouTube's answers - no page contents, cookies or passwords.

async function saveDiagnostics(details, request) {
  const tabs = request && Array.isArray(request.videoTabs) ? request.videoTabs : [];
  const report = Object.assign({
    extensionVersion: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null,
    finishedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    request: {
      videoTabs: tabs.length,
      withQueueRead: tabs.filter((t) => t && Array.isArray(t.queueVideoIds) && t.queueVideoIds.length > 1).length,
      withQueueId: tabs.filter((t) => t && typeof t.queueListId === 'string').length,
      partlyShown: tabs.filter((t) => t && t.queuePartial === true).length,
      queueIds: Array.from(new Set(tabs.map((t) => t && t.queueListId).filter(Boolean))).slice(0, 50)
    }
  }, details || {});
  try { console.info('[YouTube Tab Saver] save diagnostics', JSON.stringify(report)); } catch (e) { /* ignore */ }
  try { await chrome.storage.local.set({ lastDiagnostics: report }); } catch (e) { /* ignore */ }
}

// --- 3b. Remembering the last save (so a re-opened popup can show it) ---------

/** Keeps only what the popup needs to show the outcome. */
function compactSaveResult(result, sentTabIds) {
  const r = result || {};
  // A save that failed outright reports no per-tab list; every tab that was sent is then unsaved.
  const reported = r.tabs && Array.isArray(r.tabs.failedTabIds) ? r.tabs.failedTabIds : [];
  const failedTabIds = reported.length > 0 ? reported : (r.success || r.status === 'NO_ADDITIONS_NEEDED' ? [] : (sentTabIds || []));
  return {
    success: !!r.success, status: r.status || (r.success ? 'SUCCESS' : 'FAILED'), usedTitle: r.usedTitle || '',
    summary: r.summary || null,
    tabs: { failedTabIds: failedTabIds, unavailableTabIds: r.tabs && Array.isArray(r.tabs.unavailableTabIds) ? r.tabs.unavailableTabIds : [] },
    tabWarnings: r.tabWarnings && typeof r.tabWarnings === 'object' ? r.tabWarnings : {},
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 5) : [], skippedTabCount: r.skippedTabCount || 0,
    playlists: Array.isArray(r.playlists) ? r.playlists.map((p) => ({ title: p.title, index: p.index, addedCount: p.addedCount })) : [],
    queueNotes: Array.isArray(r.queueNotes) ? r.queueNotes.slice(0, 50) : [],
    error: r.error || null
  };
}

async function rememberLastSave(result, sentTabIds) {
  try {
    await chrome.storage.session.set({ lastSave: { finishedAt: Date.now(), result: compactSaveResult(result, sentTabIds) } });
  } catch (e) { /* the popup simply will not be able to show it */ }
}

/** Persists title -> playlistId hints (used only as a fallback lookup by the engine). */
async function updatePlaylistCache(result) {
  const playlists = Array.isArray(result.playlists) ? result.playlists : [];
  const removals = Array.isArray(result.cacheRemovals) ? result.cacheRemovals : [];
  if (playlists.length === 0 && removals.length === 0) return;

  const stored = await chrome.storage.local.get(['playlistCache']);
  const cache = Object.assign({}, stored.playlistCache || {});

  for (const key of removals) delete cache[key];
  for (const p of playlists) {
    if (p && typeof p.playlistId === 'string' && typeof p.title === 'string') {
      const key = cleanPlaylistTitle(p.title);
      delete cache[key];                       // re-insert so the newest entries sit last
      cache[key] = p.playlistId.replace(/^VL/, '');
    }
  }

  const keys = Object.keys(cache);
  if (keys.length > CONFIG.PLAYLIST_CACHE_MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - CONFIG.PLAYLIST_CACHE_MAX_ENTRIES)) delete cache[key];
  }
  await chrome.storage.local.set({ playlistCache: cache });
}

// --- 4. Message Dispatcher --------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'Unauthorized request origin.' });
    return false;
  }

  if (!request || typeof request.action !== 'string') {
    sendResponse({ error: 'Invalid message structure.' });
    return false;
  }

  // ---- auditTabs ----
  if (request.action === 'auditTabs') {
    (async () => {
      const tabs = await chrome.tabs.query({});
      const audited = [];
      const sources = [];
      tabs.forEach((tab) => {
        if (!tab.url || activeTempTabIds.has(tab.id)) return;
        const cat = categorizeYoutubeUrl(tab.url);
        if (cat.isYT) {
          audited.push({
            tabId: tab.id, windowId: tab.windowId, title: tab.title || tab.url,
            url: tab.url, isVideo: cat.isVideo, videoId: cat.videoId, isIncognito: tab.incognito,
            audible: !!tab.audible,
            lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
            queueStatus: 'none', queueVideoIds: [], queueTitle: '', queueListId: null, queuePartial: false
          });
          sources.push(tab);
        }
      });

      // Read each (non-incognito) video tab's queue. Incognito tabs are never read or saved.
      const targets = audited.map((a, i) => i).filter((i) => audited[i].isVideo && !audited[i].isIncognito);
      const reasons = {};
      const listKinds = {};
      await mapLimitWorker(targets, CONFIG.QUEUE_READ_CONCURRENCY, async (i) => {
        try {
          const q = await readTabQueue(sources[i]);
          reasons[q.reason] = (reasons[q.reason] || 0) + 1;
          const lid = listIdOf(sources[i].url);
          const kind = lid ? (isQueueListId(lid) ? lid.slice(0, 4) : lid.slice(0, 2)) : 'none';
          listKinds[kind] = (listKinds[kind] || 0) + 1;
          audited[i].queueStatus = q.status;
          audited[i].queueVideoIds = q.ids;
          audited[i].queueListId = q.queueListId;
          audited[i].queuePartial = q.partial;
          audited[i].queueTitle = q.title;
        } catch (e) { /* leave as 'none' */ }
      });
      try {
        await chrome.storage.local.set({ lastScanDiagnostics: {
          finishedAt: new Date().toISOString(), youtubeTabs: audited.length, videoTabsRead: targets.length,
          asleep: sources.filter((t, i) => targets.includes(i) && (t.discarded || t.status === 'unloaded')).length,
          queueResult: reasons, addressListKinds: listKinds
        } });
      } catch (e) { /* ignore */ }
      sendResponse({ tabs: audited });
    })().catch((err) => sendResponse({ tabs: [], error: err.message }));
    return true;
  }

  // ---- getSaveState ----
  if (request.action === 'getSaveState') {
    (async () => {
      let last = null;
      let warnings = null;
      try {
        const stored = await chrome.storage.session.get(['lastSave']);
        const entry = stored && stored.lastSave;
        if (entry && Number.isFinite(entry.finishedAt) && Date.now() - entry.finishedAt < CONFIG.LAST_SAVE_MAX_AGE_MS) last = entry;
        // The close view's "not saved" marks stay until the next save (or until the browser closes),
        // even after the "Last save" message is no longer shown.
        if (entry && entry.result && entry.result.tabWarnings) warnings = entry.result.tabWarnings;
      } catch (e) { last = null; }
      sendResponse({ inProgress: saveInProgress, startedAt: saveStartedAt, progress: saveInProgress ? saveProgress : null, last: last, warnings: warnings });
    })();
    return true;
  }

  // ---- processSave ----
  if (request.action === 'processSave') {
    let responded = false;
    const safeResponse = (data) => {
      if (!responded) {
        responded = true;
        try { sendResponse(data); } catch (e) { /* popup was closed */ }
      }
    };

    (async () => {
      let tempTab = null;
      let ownsLock = false;
      let keepAliveTimer = null;
      let progressTimer = null;
      let sentTabIds = [];

      try {
        if (saveInProgress) {
          safeResponse({ success: false, error: 'A save is already in progress. Please wait for it to finish.' });
          return;
        }
        saveInProgress = true;
        saveProgress = null;                      // never show the previous save's count
        const myRun = ++saveRunId;
        saveStartedAt = Date.now();
        ownsLock = true;

        // Long saves would otherwise let Chrome suspend this worker; any extension API call resets the timer.
        keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, CONFIG.KEEPALIVE_INTERVAL_MS);

        // Validate what the popup sent (the popup is trusted, but tabs may be stale).
        const requested = [];
        if (Array.isArray(request.videoTabs)) {
          for (const item of request.videoTabs) {
            const videoId = item ? normalizeVideoId(item.videoId) : null;
            if (item && Number.isInteger(item.tabId) && item.tabId > 0 && videoId) {
              const entry = { tabId: item.tabId, videoId };
              if (Array.isArray(item.queueVideoIds)) {
                entry.queueVideoIds = Array.from(new Set(item.queueVideoIds.map(normalizeVideoId).filter(Boolean)))
                  .slice(0, CONFIG.MAX_QUEUE_VIDEOS_PER_TAB);
              }
              if (isQueueListId(item.queueListId)) entry.queueListId = item.queueListId;
              if (item.queuePartial === true) entry.queuePartial = true;
              requested.push(entry);
            }
          }
        }
        if (requested.length === 0) throw new Error('No valid YouTube video tabs found.');
        sentTabIds = requested.map((r) => r.tabId);

        const { verified, staleCount } = await verifyVideoTabs(requested);
        if (verified.length === 0) {
          throw new Error('None of the scanned tabs are still open on those videos. Please scan again.');
        }


        const title = typeof request.playlistTitle === 'string' ? request.playlistTitle : '';
        const storageData = await chrome.storage.local.get(['playlistCache']);
        const playlistCache = storageData.playlistCache || {};

        tempTab = await createAndPrepareBackgroundTab(Number.isInteger(request.windowId) ? request.windowId : undefined);

        // While the engine runs, ask the save tab how far it got (shown in the popup as "(done / total)").
        saveProgress = null;
        progressTimer = setInterval(async () => {
          try {
            const r = await chrome.scripting.executeScript({ target: { tabId: tempTab.id }, world: 'MAIN', func: readSaveProgressInPage });
            const p = r && r[0] ? r[0].result : null;
            // The answer may arrive after this save has ended: only the save still running may set the progress.
            if (myRun === saveRunId && saveInProgress && p && Number.isFinite(p.done) && Number.isFinite(p.total)) {
              saveProgress = { done: p.done, total: p.total };
            }
          } catch (e) { /* tab busy or gone; try again next tick */ }
        }, CONFIG.PROGRESS_POLL_MS);

        const runToken = Date.now() + '-' + Math.random().toString(36).slice(2);
        const executionResults = await runEngineOnce(tempTab.id,
          [title, flattenForEngine(verified), playlistCache, ENGINE_CONFIG, runToken], runToken);

        if (!executionResults || !executionResults[0] || executionResults[0].result === undefined) {
          throw new Error('Script execution failed to return a response from YouTube context.');
        }

        const result = executionResults[0].result;
        result.skippedTabCount = staleCount;
        // A partly shown queue with no id cannot be loaded from YouTube (it is completed there otherwise).
        const partialNotes = verified.filter((v) => v.queuePartial && !v.queueListId)
          .map((v) => ({ tabId: v.tabId, error: 'Only part of this queue was shown on the page, and it has no id to load the rest with.' }));
        result.queueNotes = (Array.isArray(result.queueNotes) ? result.queueNotes : []).concat(partialNotes);
        result.tabWarnings = buildTabWarnings(result, verified);

        // Troubleshooting aid (service worker console): how each playlist was found and checked, and why
        // any queue could not be loaded in full.
        await saveDiagnostics(Object.assign({}, result.diagnostics || {}, {
          status: result.status, error: result.error || null, usedTitle: result.usedTitle,
          videos: result.summary && result.summary.videos, queueNotes: result.queueNotes,
          skippedTabCount: result.skippedTabCount, skippedOldQueues: result.skippedOldQueues
        }), request);

        try {
          await updatePlaylistCache(result);
        } catch (cacheErr) {
          // The cache is only a lookup hint; never fail a completed save because of it.
        }


        await rememberLastSave(result, sentTabIds);
        safeResponse(result);
      } catch (err) {
        const failed = { success: false, error: err.message };
        await saveDiagnostics({ status: 'FAILED', error: err.message }, request);
        await rememberLastSave(failed, sentTabIds);
        safeResponse(failed);
      } finally {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        if (progressTimer) clearInterval(progressTimer);
        saveProgress = null;
        if (tempTab && tempTab.id) {
          activeTempTabIds.delete(tempTab.id);
          chrome.tabs.remove(tempTab.id).catch(() => {});
        }
        if (ownsLock) { saveInProgress = false; saveStartedAt = null; }
      }
    })();

    return true;
  }

  // ---- closeTabs ----
  if (request.action === 'closeTabs') {
    if (!Array.isArray(request.tabIds)) {
      sendResponse({ closedCount: 0, skippedCount: 0, failedCount: 0, error: 'Invalid tabIds parameter.' });
      return false;
    }

    const validTabIds = Array.from(new Set(request.tabIds.filter((id) => Number.isInteger(id) && id > 0)));
    if (validTabIds.length === 0) {
      sendResponse({ closedCount: 0, skippedCount: 0, failedCount: 0 });
      return false;
    }

    const expected = request.expectedVideoIds && typeof request.expectedVideoIds === 'object'
      ? request.expectedVideoIds : null;

    (async () => {
      let closedCount = 0;   // closed now
      let skippedCount = 0;  // changed since the scan (or already gone) - left alone
      let failedCount = 0;   // Chrome refused to close

      await Promise.all(validTabIds.map(async (tabId) => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !tab.url) { skippedCount++; return; }

        // Only close a tab that is still the kind of page the user saw in the list.
        const cat = categorizeYoutubeUrl(tab.url);
        let matches = cat.isYT;
        if (matches && expected && Object.prototype.hasOwnProperty.call(expected, String(tabId))) {
          const exp = expected[String(tabId)];
          const allowed = Array.isArray(exp) ? exp : (typeof exp === 'string' ? [exp] : []);
          if (allowed.length === 0) {
            matches = !cat.isVideo;                                   // was a non-video page; must still be one
          } else {
            matches = cat.isVideo && allowed.includes(cat.videoId);
          }
        }
        if (!matches) { skippedCount++; return; }

        try {
          await chrome.tabs.remove(tabId);
          closedCount++;
        } catch (e) {
          failedCount++;
        }
      }));

      sendResponse({ closedCount, skippedCount, failedCount });
    })().catch((err) => sendResponse({ closedCount: 0, skippedCount: 0, failedCount: 0, error: err.message }));

    return true;
  }

  sendResponse({ error: 'Unknown action.' });
  return false;
});
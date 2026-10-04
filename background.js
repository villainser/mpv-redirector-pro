'use strict';

// MPV Redirector Pro v3.4.8 — the service worker is the only Native Messaging
// boundary. Per-tab runtime state lives in storage.session so a worker restart
// cannot erase detection, diagnostics, or a pending auto-open decision.

const HOST_NAME = 'com.villains.mpv_redirector';
const PROTOCOL_VERSION = 2;
const REFRESH_HOST_MIN_VERSION = '3.4.7';
const STATE_SCHEMA_VERSION = 4;
const TAB_STATE_PREFIX = 'tabState_';
const SITE_AUTO_KEY = 'siteAutoLaunch';
const SITE_SOURCE_PREFERENCES_KEY = 'siteSourcePreferences';
const RESOLVER_COOKIE_SITES_KEY = 'resolverCookieSites';
const DEFAULT_MODE_KEY = 'defaultPlayMode';
const LEGACY_MIGRATION_KEY = 'legacyAutoLaunchMigrationPending';
const RECOMMENDED_CONTEXT_MENU_ID = 'open-recommended-in-mpv';
const RECOMMENDED_CONTEXT_MENU_TITLE = 'Otwórz polecany w MPV';
const MAX_EVENTS = 40;
const MAX_CANDIDATES = 80;
const MAX_PENDING_REQUESTS = 300;
const MAX_PAGE_MEDIA_ITEMS = 80;
const REQUEST_CONTEXT_TTL_MS = 30_000;
const REQUEST_CONTEXT_SESSION_PREFIX = 'requestContext_';
const PERSISTED_REQUEST_CONTEXT_TTL_MS = 120_000;
const MAX_PERSISTED_REQUEST_CONTEXTS = 32;
const AUTO_DEBOUNCE_MS = 800;
const GENERIC_PREROLL_GUARD_MS = 2_500;
const GENERIC_SHORT_MEDIA_MAX_SECONDS = 120;
const AUTO_COOLDOWN_MS = 30_000;
const AUTO_RETRY_COOLDOWN_MS = 5_000;
const MAX_AUTO_RETRIES_PER_STREAM = 1;
const PAGE_READY_RESOLVE_DEBOUNCE_MS = 1_000;
const MEDIA_EXPIRY_REFRESH_LEAD_MS = 30_000;
const MEDIA_EXPIRY_PLAY_GRACE_MS = 5_000;
const MEDIA_EXPIRY_AUTO_SUPPRESS_TAIL_MS = 5_000;
const MEDIA_EXPIRY_BUSY_RETRY_MS = 5_000;
const MAX_MEDIA_EXPIRY_BUSY_RETRIES = 6;
const MEDIA_EXPIRY_PENDING_TTL_MS = 35_000;
const PAGE_MEDIA_RESCAN_SETTLE_MS = 500;
const MEDIA_EXPIRY_ALARM_PREFIX = 'media-expiry-refresh:';
const PAGE_MEDIA_RESCAN_MESSAGE_TYPE = 'RESCAN_PAGE_MEDIA';
// The host has its own 20 s play deadline. Leave transport and state-persistence
// margin; the popup's dedicated PLAY deadline is longer again.
const PLAY_TIMEOUT_MS = 24_000;
const HEALTH_TIMEOUT_MS = 8_000;
const RESOLVE_TIMEOUT_MS = 28_000;
const PLATFORM_TARGET_TIMEOUT_MS = 2_000;
const MAX_RESOLVER_RESULTS = 24;
const MAX_RESOLVER_COOKIES = 64;
const MAX_RESOLVER_COOKIE_BYTES = 16 * 1024;
const MAX_PREFERRED_LANGUAGES = 8;
const MAX_LANGUAGE_TAG_BYTES = 35;
const MAX_SOURCE_PREFERENCE_SITES = 64;
const MAX_SOURCE_PRIORITY_RULES = 64;
const DEFAULT_QUALITY_ORDER = Object.freeze(['2160p', '1440p', '1080p', '720p', '480p']);
const QUALITY_ORDER_SET = new Set(DEFAULT_QUALITY_ORDER);
const CONCRETE_MEDIA_TYPES = new Set(['HLS', 'DASH', 'MP4', 'WEBM']);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_VARIANTS = 24;
const MAX_MANIFEST_SCANS_PER_NAVIGATION = 12;
const MAX_PENDING_MANIFEST_TABS = 128;
const MANIFEST_FETCH_TIMEOUT_MS = 6_000;
const MANIFEST_RESCAN_TTL_MS = 60_000;
const MAX_PLAYER_KEYS_PER_CANDIDATE = 16;
const ALLOWED_PLAY_MODES = new Set(['new', 'append', 'replace']);
const OBSERVED_REQUEST_HEADERS = new Set(['referer', 'origin', 'user-agent']);
const RELEVANT_REQUEST_TYPES = ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'other'];
const RELEVANT_REQUEST_TYPE_SET = new Set(RELEVANT_REQUEST_TYPES);
const AD_PATH_SEGMENTS = new Set([
    'ad',
    'ads',
    'reklama',
    'reklamy',
    'advert',
    'adverts',
    'advertisement',
    'advertisements',
    'preroll',
    'pre-roll',
    'midroll',
    'mid-roll',
    'postroll',
    'post-roll',
    'commercial',
    'commercials',
    'vast',
    'vmap',
    'ima'
]);
const AD_HOST_TOKENS = new Set([
    'ad',
    'ads',
    'adserver',
    'adservice',
    'adservices',
    'advert',
    'advertising',
    'doubleclick',
    'googlesyndication',
    'googleadservices',
    'imasdk'
]);
const AD_QUERY_IDENTIFIER_KEYS = new Set(['adid', 'adunit', 'creativeid']);
const AD_QUERY_KIND_KEYS = new Set(['adtype']);
const AD_QUERY_TRANSPORT_KEYS = new Set(['vast', 'vmap', 'ima']);
const AD_QUERY_SWITCH_KEYS = new Set(['ad', 'ads']);
const NON_AD_SWITCH_VALUES = new Set(['0', 'false', 'no', 'off', 'none', 'content']);
const UTILITY_MEDIA_BASENAMES = new Set(['silence.mp4', 'silent.mp4', 'blank.mp4']);
const MEDIA_URL_EXPIRY_QUERY_NAMES = new Set(['validto', 'exp', 'expires', 'expiry']);
const MIN_PLAUSIBLE_UNIX_EXPIRY_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_UNIX_EXPIRY_MS = Date.UTC(2200, 0, 1);
const VOLATILE_MEDIA_QUERY_NAMES = new Set([
    'access_token',
    'auth',
    'authorization',
    'expires',
    'expiry',
    'exp',
    'hash',
    'hmac',
    'hdnea',
    'hdntl',
    'hdnts',
    'jwt',
    'key-pair-id',
    'nonce',
    'policy',
    'session',
    'session_id',
    'sessionid',
    'sig',
    'signature',
    'token',
    'validfrom',
    'validto'
]);

const tabMutationQueues = new Map();
const tabPlayQueues = new Map();
const activePlayRequests = new Map();
const activeResolveRequests = new Map();
const activeManifestScans = new Map();
const recentManifestScans = new Map();
const manifestScanAttemptsByNavigation = new Map();
const pendingManifestScanTabs = new Map();
let manifestScanDrainRunning = false;
const PLATFORM_TARGETS_MESSAGE_TYPE = 'GET_PLATFORM_RESOLVER_TARGETS';
const autoTimers = new Map();
const pendingRequests = new Map();
const tabEpochs = new Map();
const removedTabs = new Set();
const navigationReservations = new Map();
const pageReadyResolveTimers = new Map();
const expiryRefreshKickTimers = new Map();
const activeTabByWindow = new Map();
let activePageReadyResolveTabId = null;
let activeExpiryRefreshTabId = null;
let settingsMutationQueue = Promise.resolve();
let requestContextStorageQueue = Promise.resolve();
let startupRecoveryReady = Promise.resolve();
let contextMenuRegistrationPending = false;

const RESOLVER_MEDIA_ROLES = new Set(['master', 'variant', 'audio', 'direct']);
const RESOLVER_MEDIA_KINDS = new Set(['adaptive', 'muxed', 'video-only', 'audio-only']);
const RESOLVER_PLAYBACK_KINDS = new Set(['yt-dlp-page']);
const CONTENT_PLAY_FAILURE_CODES = new Set([
    'STREAM_URL_EXPIRED',
    'MPV_LOAD_FAILED',
    'MPV_EXITED_EARLY',
    'MPV_DEMUXER_TIMEOUT'
]);
const MANUAL_PLAY_FALLBACK_ERRORS = new Set([
    'MPV_LOAD_FAILED',
    'MPV_EXITED_EARLY',
    'MPV_DEMUXER_TIMEOUT'
]);

class WorkerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WorkerError';
        this.code = normalizeErrorCode(code, 'WORKER_ERROR');
    }
}

// ─── Pure media helpers (also exported for Node tests) ──────────────────────

function parseHttpUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 32 * 1024) return null;
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (!parsed.hostname || parsed.username || parsed.password) return null;
        return parsed;
    } catch (_error) {
        return null;
    }
}

function parseMediaUrlExpiry(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return null;

    const expiriesByName = new Map();
    for (const [rawName, rawValue] of parsed.searchParams.entries()) {
        const name = rawName.toLowerCase();
        if (!MEDIA_URL_EXPIRY_QUERY_NAMES.has(name)) continue;

        let expiryMs = null;
        if (/^\d{10}$/.test(rawValue)) {
            expiryMs = Number(rawValue) * 1000;
        } else if (/^\d{13}$/.test(rawValue)) {
            expiryMs = Number(rawValue);
        }
        if (
            !Number.isSafeInteger(expiryMs) ||
            expiryMs < MIN_PLAUSIBLE_UNIX_EXPIRY_MS ||
            expiryMs > MAX_PLAUSIBLE_UNIX_EXPIRY_MS
        ) return null;
        const expiries = expiriesByName.get(name) || new Set();
        expiries.add(expiryMs);
        if (expiries.size > 1) return null;
        expiriesByName.set(name, expiries);
    }
    const deadlines = [...expiriesByName.values()].map((items) => [...items][0]);
    return deadlines.length ? Math.min(...deadlines) : null;
}

function candidateMediaExpiry(candidate) {
    if (candidate && typeof candidate === 'object' && candidate.playbackKind === 'yt-dlp-page') return null;
    return parseMediaUrlExpiry(typeof candidate === 'string' ? candidate : candidate?.url);
}

function isCandidateExpired(candidate, now = Date.now(), graceMs = 0) {
    const expiryMs = candidateMediaExpiry(candidate);
    return expiryMs !== null && Number.isFinite(now) && Number.isFinite(graceMs) &&
        expiryMs <= now + Math.max(0, graceMs);
}

function updateCandidateFreshness(candidate, now = Date.now()) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    const expiresAt = candidateMediaExpiry(candidate);
    if (expiresAt === null) {
        delete candidate.expiresAt;
        candidate.expired = false;
    } else {
        candidate.expiresAt = expiresAt;
        candidate.expired = expiresAt <= now;
    }
    return candidate;
}

function isSafeRemoteManifestUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (
        !hostname ||
        hostname === 'localhost' ||
        /(?:^|\.)(?:localhost|local|lan|internal|home\.arpa|test|invalid)$/.test(hostname)
    ) return false;
    if (hostname.includes(':')) {
        return !(
            hostname === '::' ||
            hostname === '::1' ||
            /^::(?:ffff(?::0{1,4})?:)?/i.test(hostname) ||
            /^f[cd][0-9a-f:]*$/i.test(hostname) ||
            /^fe[89a-f][0-9a-f:]*$/i.test(hostname) ||
            /^ff[0-9a-f:]*$/i.test(hostname)
        );
    }
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!ipv4Match) return true;
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return false;
    const [a, b] = octets;
    return !(
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100))) ||
        (a === 203 && b === 0 && octets[2] === 113)
    );
}

function isSafeManifestDerivedUrl(value) {
    const parsed = parseHttpUrl(value);
    return parsed?.protocol === 'https:' && isSafeRemoteManifestUrl(parsed.href);
}

function manifestChildRequestContext(parent, childUrl) {
    const parentUrl = parseHttpUrl(parent?.url || '');
    const child = parseHttpUrl(childUrl || '');
    const context = {};
    if (typeof parent?.userAgent === 'string' && parent.userAgent) {
        context.userAgent = parent.userAgent;
    }
    // Referer and Origin can contain page identity or signed query data. They
    // were observed for the parent request, so replay them only to a child on
    // that exact origin. A cross-origin rendition must earn its own headers via
    // webRequest instead of inheriting credentials from a manifest response.
    if (parentUrl && child && parentUrl.origin === child.origin) {
        if (typeof parent?.referer === 'string' && parent.referer) context.referer = parent.referer;
        if (typeof parent?.origin === 'string' && parent.origin) context.origin = parent.origin;
    }
    return context;
}

const PLATFORM_ADAPTERS = Object.freeze([
    Object.freeze({
        id: 'tvp',
        label: 'TVP',
        resolverOrder: Object.freeze(['streamlink', 'yt-dlp']),
        matches: (hostname) => hostname === 'tvp.pl' || hostname.endsWith('.tvp.pl')
    }),
    Object.freeze({
        id: 'youtube',
        label: 'YouTube',
        resolverOrder: Object.freeze(['yt-dlp', 'streamlink']),
        matches: (hostname) => hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com')
    }),
    Object.freeze({
        id: 'generic',
        label: 'Strona internetowa',
        resolverOrder: Object.freeze(['streamlink', 'yt-dlp']),
        matches: () => true
    })
]);

function platformAdapterForUrl(value) {
    const parsed = parseHttpUrl(value);
    const hostname = parsed?.hostname?.toLowerCase() || '';
    const adapter = PLATFORM_ADAPTERS.find((item) => item.matches(hostname)) || PLATFORM_ADAPTERS.at(-1);
    return {
        id: adapter.id,
        label: adapter.label,
        resolverOrder: [...adapter.resolverOrder]
    };
}

function normalizeLanguageTag(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/_/g, '-');
    if (!trimmed || trimmed.length > MAX_LANGUAGE_TAG_BYTES) return '';
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(trimmed)) return '';
    const parts = trimmed.split('-');
    return parts.map((part, index) => {
        if (index === 0) return part.toLowerCase();
        if (/^[A-Za-z]{4}$/.test(part)) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
        if (/^(?:[A-Za-z]{2}|\d{3})$/.test(part)) return part.toUpperCase();
        return part.toLowerCase();
    }).join('-');
}

function normalizePreferredLanguages(values) {
    if (!Array.isArray(values)) return [];
    const normalized = [];
    for (const value of values) {
        const language = normalizeLanguageTag(value);
        if (language && !normalized.includes(language)) normalized.push(language);
        if (normalized.length >= MAX_PREFERRED_LANGUAGES) break;
    }
    return normalized;
}

function materialScopeForUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return null;
    parsed.hash = '';
    const adapter = platformAdapterForUrl(parsed.href);
    const decodedParts = decodePathSafely(parsed.pathname).split('/').filter(Boolean);
    let kind = 'route';
    let materialId = '';

    if (adapter.id === 'youtube') {
        const candidate = parsed.hostname.toLowerCase() === 'youtu.be'
            ? decodedParts[0]
            : parsed.pathname === '/watch'
                ? parsed.searchParams.get('v')
                : ['shorts', 'live'].includes(decodedParts[0])
                    ? decodedParts[1]
                    : '';
        if (typeof candidate === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(candidate)) {
            materialId = candidate;
            kind = parsed.hostname.toLowerCase() === 'youtu.be' || parsed.pathname === '/watch'
                ? 'watch'
                : decodedParts[0];
        }
    } else if (adapter.id === 'tvp') {
        materialId = decodedParts.find((part) => /^\d{5,12}$/.test(part)) || '';
        if (materialId) kind = 'asset';
    }

    const routeIdentity = `${parsed.pathname}${parsed.search}`;
    const id = materialId
        ? `${adapter.id}:${kind}:${materialId}`
        : `${adapter.id}:route:${parsed.hostname.toLowerCase()}:${stableHash(routeIdentity)}`;
    return {
        id: id.slice(0, 160),
        platform: adapter.id,
        kind,
        materialId: materialId.slice(0, 64)
    };
}

function normalizeMaterialScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const platform = ['tvp', 'youtube', 'generic'].includes(value.platform) ? value.platform : '';
    const kind = ['watch', 'shorts', 'live', 'asset', 'route'].includes(value.kind) ? value.kind : '';
    const materialId = typeof value.materialId === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(value.materialId)
        ? value.materialId
        : '';
    const id = typeof value.id === 'string' && value.id.length <= 160 && /^[A-Za-z0-9:._-]+$/.test(value.id)
        ? value.id
        : '';
    if (!platform || !kind || !id) return null;
    return { id, platform, kind, materialId };
}

function isResolvableYouTubeScope(scope) {
    return Boolean(
        scope?.platform === 'youtube' &&
        ['watch', 'shorts', 'live'].includes(scope.kind) &&
        scope.materialId
    );
}

function isResolvableTvpScope(scope) {
    return Boolean(
        scope?.platform === 'tvp' &&
        scope.kind === 'asset' &&
        typeof scope.materialId === 'string' &&
        /^\d{5,12}$/.test(scope.materialId) &&
        scope.id === `tvp:asset:${scope.materialId}`
    );
}

function isResolvablePageReadyScope(scope) {
    return isResolvableYouTubeScope(scope) || isResolvableTvpScope(scope);
}

function applyTrustedPageContext(state, pageUrl) {
    const parsed = parseHttpUrl(pageUrl);
    const scope = materialScopeForUrl(pageUrl);
    if (!state || !parsed || !scope) return false;
    const adapter = platformAdapterForUrl(parsed.href);
    const nextHostname = parsed.hostname.toLowerCase();
    const previousScopeId = state.materialScope?.id || '';
    const changed = state.hostname !== nextHostname ||
        state.platform?.id !== adapter.id ||
        state.platform?.label !== adapter.label ||
        previousScopeId !== scope.id ||
        state.pageIdentity !== scope.id;
    state.hostname = nextHostname;
    state.platform = { id: adapter.id, label: adapter.label };
    state.materialScope = scope;
    state.pageIdentity = scope.id;
    if (Array.isArray(state.candidates) && adapter.id === 'youtube') {
        state.candidates.forEach((candidate) => {
            candidate.diagnosticOnly = !isYouTubePrimaryResolverCandidate(candidate, scope.id);
        });
    }
    if (previousScopeId && previousScopeId !== scope.id) {
        state.resolver = {
            ...state.resolver,
            state: 'idle',
            adapter: adapter.id,
            resolver: null,
            attempted: [],
            resultCount: 0,
            cookiesUsed: false,
            truncated: false,
            source: null,
            materialScope: scope.id,
            batchId: null,
            candidateIds: [],
            pageReadyScope: '',
            pageReadyState: 'idle',
            updatedAt: 0
        };
    }
    return changed;
}

function normalizePlatformResolverTarget(value, trustedPageUrl, adapterId) {
    const page = parseHttpUrl(trustedPageUrl);
    const target = parseHttpUrl(value);
    if (!page || !target || adapterId !== 'tvp') return '';
    if (target.origin !== page.origin || !(page.hostname === 'tvp.pl' || page.hostname.endsWith('.tvp.pl'))) return '';
    if (!/^\/\d{5,12}\/[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)*\/?$/.test(target.pathname)) return '';
    target.search = '';
    target.hash = '';
    page.search = '';
    page.hash = '';
    return target.href === page.href ? '' : target.href;
}

function readPlatformResolverTargets(tabId, trustedPageUrl, adapterId) {
    if (adapterId !== 'tvp' || !chrome.tabs?.sendMessage) return Promise.resolve([]);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (targets) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(targets);
        };
        const timer = setTimeout(() => finish([]), PLATFORM_TARGET_TIMEOUT_MS);
        try {
            chrome.tabs.sendMessage(
                tabId,
                { type: PLATFORM_TARGETS_MESSAGE_TYPE },
                { frameId: 0 },
                (response) => {
                const runtimeMessage = chrome.runtime.lastError?.message || '';
                if (runtimeMessage || response?.ok !== true || !Array.isArray(response.targets)) {
                    finish([]);
                    return;
                }
                const targets = [...new Set(response.targets.slice(0, 4).map((value) =>
                    normalizePlatformResolverTarget(value, trustedPageUrl, adapterId)
                ).filter(Boolean))];
                finish(targets);
                }
            );
        } catch (_error) {
            finish([]);
        }
    });
}

function candidateSourceMethod(source) {
    const normalized = String(source || '').toLowerCase();
    if (normalized === 'page_dom') return 'page';
    if (normalized === 'manifest_scan') return 'manifest';
    if (normalized === 'resolver_streamlink') return 'streamlink';
    if (normalized === 'resolver_ytdlp') return 'yt-dlp';
    return 'network';
}

function normalizeResolverRole(value) {
    return typeof value === 'string' && RESOLVER_MEDIA_ROLES.has(value) ? value : '';
}

function hasResolverProvenance(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    const sourceMethod = candidateSourceMethod(candidate.source);
    if (sourceMethod === 'streamlink' || sourceMethod === 'yt-dlp') return true;
    return Array.isArray(candidate.sources) && candidate.sources.some((source) => {
        const method = candidateSourceMethod(source);
        return method === 'streamlink' || method === 'yt-dlp';
    });
}

function normalizeResolverAttempt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resolver = value.resolver;
    const status = value.status;
    if (!['streamlink', 'yt-dlp'].includes(resolver)) return null;
    if (!['found', 'empty', 'unavailable', 'incompatible', 'timeout', 'failed', 'invalid_output', 'overflow'].includes(status)) {
        return null;
    }
    return {
        resolver,
        status,
        available: value.available === true,
        compatible: value.compatible === true,
        version: typeof value.version === 'string' ? sanitizePublicMessage(value.version, '').slice(0, 40) : null,
        count: Number.isInteger(value.count) && value.count >= 0 ? Math.min(value.count, MAX_RESOLVER_RESULTS) : 0
    };
}

function normalizeResolvedCandidate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowedKeys = new Set([
        'resolver', 'url', 'type', 'quality', 'title', 'width', 'height', 'bitrateKbps', 'bandwidth',
        'live', 'referer', 'origin', 'userAgent', 'formatId', 'role',
        'language', 'mediaKind', 'hasAudio', 'hasVideo', 'playbackKind'
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
    if (!['streamlink', 'yt-dlp'].includes(value.resolver)) return null;
    const parsed = parseHttpUrl(value.url);
    if (!parsed || isLikelySegmentUrl(parsed.href)) return null;
    const detectedType = detectMediaFromUrl(parsed.href);
    const requestedType = typeof value.type === 'string' ? value.type.toUpperCase() : '';
    const mediaType = ['HLS', 'DASH', 'MP4', 'WEBM', 'MEDIA'].includes(requestedType)
        ? requestedType
        : (detectedType || 'MEDIA');
    const candidate = {
        url: parsed.href,
        mediaType,
        source: value.resolver === 'streamlink' ? 'resolver_streamlink' : 'resolver_ytdlp',
        resourceType: 'resolver',
        title: typeof value.title === 'string' ? sanitizePublicMessage(value.title, '').slice(0, 120) : '',
        quality: typeof value.quality === 'string' ? sanitizePublicMessage(value.quality, '').slice(0, 32) : '',
        width: Number.isInteger(value.width) && value.width > 0 ? Math.min(value.width, 16_384) : undefined,
        height: Number.isInteger(value.height) && value.height > 0 ? Math.min(value.height, 16_384) : undefined,
        bitrateKbps: Number.isFinite(value.bitrateKbps) && value.bitrateKbps >= 16
            ? Math.min(Math.round(value.bitrateKbps), 250_000)
            : undefined,
        bandwidth: Number.isFinite(value.bandwidth) && value.bandwidth >= 16_000
            ? Math.min(Math.round(value.bandwidth), 250_000_000)
            : undefined,
        live: value.live === true,
        formatId: typeof value.formatId === 'string' ? sanitizePublicMessage(value.formatId, '').slice(0, 64) : ''
    };
    const resolverRole = normalizeResolverRole(value.role);
    if (resolverRole) {
        candidate.role = resolverRole;
        candidate.resolverRole = resolverRole;
    }
    const language = normalizeLanguageTag(value.language);
    const mediaKind = typeof value.mediaKind === 'string' && RESOLVER_MEDIA_KINDS.has(value.mediaKind)
        ? value.mediaKind
        : '';
    const playbackKind = typeof value.playbackKind === 'string' && RESOLVER_PLAYBACK_KINDS.has(value.playbackKind)
        ? value.playbackKind
        : '';
    if (value.playbackKind !== undefined && !playbackKind) return null;
    if (language) candidate.language = language;
    if (mediaKind) candidate.mediaKind = mediaKind;
    if (playbackKind) candidate.playbackKind = playbackKind;
    if (typeof value.hasAudio === 'boolean') candidate.hasAudio = value.hasAudio;
    if (typeof value.hasVideo === 'boolean') candidate.hasVideo = value.hasVideo;
    if (typeof value.referer === 'string' && parseHttpUrl(value.referer)) candidate.referer = value.referer;
    if (typeof value.origin === 'string') {
        const origin = parseHttpUrl(value.origin);
        if (value.origin === 'null' || (origin && origin.origin === value.origin && !origin.pathname.replace(/^\/$/, '') && !origin.search && !origin.hash)) {
            candidate.origin = value.origin;
        }
    }
    if (
        typeof value.userAgent === 'string' &&
        value.userAgent.length <= 1024 &&
        !/[\x00-\x1f\x7f-\uffff]/.test(value.userAgent)
    ) {
        candidate.userAgent = value.userAgent;
    }
    return candidate;
}

function canonicalizeMediaUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return '';

    // TVP signs playback URLs inside the path rather than the query string:
    // /token/video/{kind}/{asset}/{date}/{client}/{signature}/video.ism/file.
    // Keep the stable asset/container/file identity so a refreshed signature
    // updates the existing candidate instead of leaving a playable-looking,
    // expired duplicate ahead of the fresh request.
    if (parsed.hostname === 'tvp.pl' || parsed.hostname.endsWith('.tvp.pl')) {
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        const containerIndex = pathParts.findIndex((part, index) =>
            index >= 4 && decodePathSafely(part).toLowerCase().endsWith('.ism')
        );
        if (
            pathParts[0]?.toLowerCase() === 'token' &&
            pathParts[1]?.toLowerCase() === 'video' &&
            ['vod', 'live'].includes(pathParts[2]?.toLowerCase()) &&
            /^\d+$/.test(pathParts[3] || '') &&
            containerIndex >= 6
        ) {
            parsed.pathname = `/${[
                ...pathParts.slice(0, 4),
                ...pathParts.slice(containerIndex)
            ].join('/')}`;
        }
    }
    for (const name of Array.from(parsed.searchParams.keys())) {
        const normalizedName = name.toLowerCase();
        if (
            VOLATILE_MEDIA_QUERY_NAMES.has(normalizedName) ||
            normalizedName.startsWith('x-amz-') ||
            normalizedName.startsWith('x-goog-')
        ) {
            parsed.searchParams.delete(name);
        }
    }
    parsed.searchParams.sort();
    parsed.hash = '';
    // URL normalizes scheme/host and keeps stable identity parameters such as
    // media id or format. Only short-lived authorization/signature fields are
    // removed so token refreshes merge without collapsing distinct assets.
    return parsed.href;
}

function detectMediaFromUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return null;
    const path = parsed.pathname.toLowerCase();

    if (path.includes('.m3u8') || path.endsWith('.hls') || path.includes('.hls/')) return 'HLS';
    if (path.includes('.mpd')) return 'DASH';
    if (path.includes('.mp4')) return 'MP4';
    if (path.includes('.webm')) return 'WEBM';

    // Some providers expose an extensionless endpoint with an explicit format.
    for (const [name, rawValue] of parsed.searchParams.entries()) {
        if (!/^(format|type|ext|extension|mime|content[-_]?type)$/i.test(name)) continue;
        const parameter = rawValue.toLowerCase();
        if (parameter.includes('m3u8') || parameter.includes('mpegurl') || parameter === 'hls') return 'HLS';
        if (parameter.includes('dash') || parameter.includes('mpd')) return 'DASH';
        if (parameter.includes('mp4')) return 'MP4';
        if (parameter.includes('webm')) return 'WEBM';
    }
    return null;
}

function normalizeContentType(value) {
    if (typeof value !== 'string') return '';
    return value.split(';', 1)[0].trim().toLowerCase();
}

function detectMediaFromContentType(value) {
    const contentType = normalizeContentType(value);
    if (!contentType) return null;
    if (
        contentType === 'application/vnd.apple.mpegurl' ||
        contentType === 'application/mpegurl' ||
        contentType === 'application/x-mpegurl' ||
        contentType === 'audio/mpegurl' ||
        contentType === 'audio/x-mpegurl'
    ) return 'HLS';
    if (contentType === 'application/dash+xml') return 'DASH';
    if (contentType === 'video/mp4' || contentType === 'audio/mp4' || contentType === 'application/mp4') return 'MP4';
    if (contentType === 'video/webm' || contentType === 'audio/webm' || contentType === 'application/webm') return 'WEBM';
    return null;
}

function parseHlsAttributeList(value) {
    const attributes = {};
    const text = String(value || '').slice(0, 16 * 1024);
    let start = 0;
    let quoted = false;
    const parts = [];
    for (let index = 0; index <= text.length; index += 1) {
        const character = text[index];
        if (character === '"') quoted = !quoted;
        if (index === text.length || (character === ',' && !quoted)) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    for (const part of parts.slice(0, 64)) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        const name = part.slice(0, separator).trim().toUpperCase();
        let rawValue = part.slice(separator + 1).trim();
        if (!/^[A-Z0-9-]{1,48}$/.test(name) || rawValue.length > 2048) continue;
        if (rawValue.startsWith('"') && rawValue.endsWith('"')) rawValue = rawValue.slice(1, -1);
        attributes[name] = rawValue;
    }
    return attributes;
}

function mediaCodecSignals(value) {
    const tokens = String(value || '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 32);
    const isAudio = (token) => /^(?:mp4a|aac|ac-3|ec-3|ac-4|opus|vorbis|flac|alac|dts[chelp]?|mha1|mhm1|mp3)(?:[.-]|$)/.test(token);
    const isVideo = (token) => /^(?:avc1|avc3|hev1|hvc1|vp0?9|av01|theora|dvhe|dvh1)(?:[.-]|$)/.test(token);
    return {
        audio: tokens.some(isAudio),
        video: tokens.some(isVideo),
        unknown: tokens.some((token) => !isAudio(token) && !isVideo(token)),
        present: tokens.length > 0
    };
}

function rankManifestVariants(variants) {
    return Array.from(variants).sort((left, right) => {
        const leftRole = normalizeResolverRole(left?.role) || classifyMediaRole(left);
        const rightRole = normalizeResolverRole(right?.role) || classifyMediaRole(right);
        return (
            Number(leftRole === 'audio') - Number(rightRole === 'audio') ||
            Number(isExplicitlyIncompleteCandidate(left)) - Number(isExplicitlyIncompleteCandidate(right)) ||
            candidateMediaCompleteness(right) - candidateMediaCompleteness(left) ||
            inferCandidateHeight(right) - inferCandidateHeight(left) ||
            inferCandidateBitrateKbps(right) - inferCandidateBitrateKbps(left)
        );
    }).slice(0, MAX_MANIFEST_VARIANTS);
}

function parseHlsMasterPlaylist(value, masterUrl) {
    const parsedMaster = parseHttpUrl(masterUrl);
    if (!parsedMaster || typeof value !== 'string' || value.length > MAX_MANIFEST_BYTES) return [];
    const lines = value.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 20_000);
    if (!lines.some((line) => line.trim() === '#EXTM3U')) return [];
    const audioGroups = new Map();
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.toUpperCase().startsWith('#EXT-X-MEDIA:')) continue;
        const attributes = parseHlsAttributeList(line.slice(line.indexOf(':') + 1));
        if (String(attributes.TYPE || '').toUpperCase() !== 'AUDIO' || !attributes['GROUP-ID']) continue;
        const groupId = String(attributes['GROUP-ID']).slice(0, 256);
        const group = audioGroups.get(groupId) || { external: false, embedded: false };
        if (attributes.URI) group.external = true;
        else group.embedded = true;
        audioGroups.set(groupId, group);
    }
    const variants = new Map();
    let entriesSeen = 0;
    for (let index = 0; index < lines.length && entriesSeen < 256; index += 1) {
        const line = lines[index].trim();
        if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF:')) continue;
        entriesSeen += 1;
        const attributes = parseHlsAttributeList(line.slice(line.indexOf(':') + 1));
        let uri = '';
        for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 12); nextIndex += 1) {
            const nextLine = lines[nextIndex].trim();
            if (!nextLine) continue;
            if (nextLine.startsWith('#')) break;
            uri = nextLine;
            index = nextIndex;
            break;
        }
        if (!uri || uri.length > 16 * 1024) continue;
        let resolved;
        try {
            resolved = new URL(uri, parsedMaster.href).href;
        } catch (_error) {
            continue;
        }
        if (!isSafeManifestDerivedUrl(resolved) || isLikelySegmentUrl(resolved)) continue;
        const resolution = /^(\d{2,5})x(\d{2,5})$/i.exec(attributes.RESOLUTION || '');
        const width = resolution ? Number(resolution[1]) : 0;
        const height = resolution ? Number(resolution[2]) : qualityHeightFromText(attributes.NAME || '');
        const rawBandwidth = Number(attributes['AVERAGE-BANDWIDTH'] || attributes.BANDWIDTH || 0);
        const bandwidth = Number.isFinite(rawBandwidth) && rawBandwidth >= 16_000 && rawBandwidth <= 250_000_000
            ? Math.round(rawBandwidth)
            : 0;
        const audioGroupId = String(attributes.AUDIO || '').slice(0, 256);
        const audioGroup = audioGroups.get(audioGroupId);
        const externalAudio = Boolean(audioGroup?.external && !audioGroup?.embedded);
        const embeddedAudioGroup = Boolean(audioGroup?.embedded);
        const codecs = String(attributes.CODECS || '').toLowerCase();
        const codecSignals = mediaCodecSignals(codecs);
        const audioCodec = codecSignals.audio;
        const videoCodec = codecSignals.video;
        // AUDIO points at a separate rendition group. Opening the child URI by
        // itself therefore does not include that track, even when CODECS lists
        // the codecs needed by the complete variant advertised by the master.
        const videoSignal = videoCodec || Boolean(height);
        const audioOnly = audioCodec && !videoSignal;
        const embeddedAudio = !audioOnly && videoSignal && (
            embeddedAudioGroup || (!audioGroupId && audioCodec)
        );
        const videoOnly = videoSignal && (
            externalAudio || (
                codecSignals.present &&
                videoCodec &&
                !audioCodec &&
                !codecSignals.unknown &&
                !embeddedAudioGroup
            )
        );
        const frameRateValue = Number(attributes['FRAME-RATE'] || 0);
        const frameRate = Number.isFinite(frameRateValue) && frameRateValue > 0 && frameRateValue <= 240
            ? frameRateValue
            : 0;
        const videoRange = /^(?:SDR|HLG|PQ)$/i.test(attributes['VIDEO-RANGE'] || '')
            ? String(attributes['VIDEO-RANGE']).toUpperCase()
            : '';
        const variantName = String(attributes.NAME || '').slice(0, 128);
        const stableVariantId = String(attributes['STABLE-VARIANT-ID'] || '').slice(0, 128);
        const titleParts = [height ? `Wariant HLS ${height}p` : 'Wariant HLS z manifestu'];
        if (frameRate) titleParts.push(`${Number.isInteger(frameRate) ? frameRate : frameRate.toFixed(2)} fps`);
        if (videoRange && videoRange !== 'SDR') titleParts.push(videoRange === 'PQ' ? 'HDR PQ' : 'HDR HLG');
        const candidate = {
            url: resolved,
            mediaType: detectMediaFromUrl(resolved) || 'HLS',
            source: 'manifest_scan',
            resourceType: 'manifest',
            contentType: 'application/vnd.apple.mpegurl',
            role: audioOnly ? 'audio' : 'variant',
            quality: height ? `${height}p` : '',
            width: width || undefined,
            height: height || undefined,
            bandwidth: bandwidth || undefined,
            bitrateKbps: bandwidth ? Math.round(bandwidth / 1000) : undefined,
            mediaKind: audioOnly ? 'audio-only' : (embeddedAudio ? 'muxed' : (videoOnly ? 'video-only' : undefined)),
            hasAudio: audioOnly || embeddedAudio ? true : (videoOnly ? false : undefined),
            hasVideo: audioOnly ? false : (videoSignal ? true : undefined),
            autoEligible: false,
            title: titleParts.join(' · '),
            manifestIdentity: `${audioOnly ? 'audio' : 'variant'}|${height || 0}|${bandwidth || 0}|${audioGroupId}|${codecs}|${frameRate || 0}|${videoRange}|${stableVariantId}|${variantName}`
        };
        if (classifyMediaPurpose(candidate) !== 'content') continue;
        variants.set(
            `${canonicalizeMediaUrl(resolved)}|${candidate.manifestIdentity}`,
            candidate
        );
    }
    return rankManifestVariants(variants.values());
}

function decodeXmlText(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function xmlAttribute(value, name) {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']{0,2048})["']`, 'i');
    return pattern.exec(String(value || '').slice(0, 16 * 1024))?.[1] || '';
}

function enclosingXmlScope(value, lowerValue, tagName, position, firstChildTagName) {
    const openingToken = `<${tagName.toLowerCase()}`;
    let openingStart = lowerValue.lastIndexOf(openingToken, position);
    while (openingStart >= 0) {
        const boundary = lowerValue[openingStart + openingToken.length] || '';
        if (!boundary || /[\s/>]/.test(boundary)) break;
        openingStart = lowerValue.lastIndexOf(openingToken, openingStart - 1);
    }
    if (openingStart < 0) return null;
    const closingStart = lowerValue.lastIndexOf(`</${tagName.toLowerCase()}`, position);
    if (closingStart > openingStart) return null;
    const openingEnd = value.indexOf('>', openingStart + openingToken.length);
    if (openingEnd < 0 || openingEnd >= position) return null;
    const childToken = `<${firstChildTagName.toLowerCase()}`;
    const firstChildStart = lowerValue.indexOf(childToken, openingEnd + 1);
    const directPrefixEnd = firstChildStart >= 0 && firstChildStart < position
        ? firstChildStart
        : position;
    return {
        start: openingStart,
        attributes: value.slice(openingStart + openingToken.length, openingEnd),
        directPrefix: value.slice(openingEnd + 1, directPrefixEnd)
    };
}

function directXmlBaseUrl(value) {
    const match = /<BaseURL(?:\s[^>]*)?>([^<]{1,16384})<\/BaseURL\s*>/i.exec(String(value || ''));
    return match ? decodeXmlText(match[1].trim()) : '';
}

function parseDashManifestRepresentations(value, manifestUrl) {
    const parsedManifest = parseHttpUrl(manifestUrl);
    if (!parsedManifest || typeof value !== 'string' || value.length > MAX_MANIFEST_BYTES || !/<MPD\b/i.test(value)) return [];
    const variants = new Map();
    const lowerValue = value.toLowerCase();
    const openingName = '<representation';
    const closingName = '</representation';
    let cursor = 0;
    let representationsSeen = 0;
    while (cursor < value.length && representationsSeen < 256) {
        const openingStart = lowerValue.indexOf(openingName, cursor);
        if (openingStart < 0) break;
        const afterOpeningName = lowerValue[openingStart + openingName.length] || '';
        if (afterOpeningName && !/[\s/>]/.test(afterOpeningName)) {
            cursor = openingStart + openingName.length;
            continue;
        }
        const openingEnd = value.indexOf('>', openingStart + openingName.length);
        if (openingEnd < 0) break;
        if (/\/\s*$/.test(value.slice(openingStart + openingName.length, openingEnd))) {
            cursor = openingEnd + 1;
            continue;
        }
        const closingStart = lowerValue.indexOf(closingName, openingEnd + 1);
        if (closingStart < 0) break;
        const closingEnd = value.indexOf('>', closingStart + closingName.length);
        if (closingEnd < 0) break;
        representationsSeen += 1;
        cursor = closingEnd + 1;
        const attributesText = value.slice(openingStart + openingName.length, openingEnd);
        const body = value.slice(openingEnd + 1, closingStart);
        const baseMatch = /<BaseURL(?:\s[^>]*)?>([^<]{1,16384})<\/BaseURL\s*>/i.exec(body);
        if (!baseMatch) continue;
        let resolved;
        const adaptationScope = enclosingXmlScope(value, lowerValue, 'AdaptationSet', openingStart, 'Representation');
        const periodScope = enclosingXmlScope(value, lowerValue, 'Period', openingStart, 'AdaptationSet');
        const mpdScope = enclosingXmlScope(value, lowerValue, 'MPD', openingStart, 'Period');
        const adaptationAttributes = adaptationScope?.attributes || '';
        if (
            /<ContentProtection\b/i.test(mpdScope?.directPrefix || '') ||
            /<ContentProtection\b/i.test(periodScope?.directPrefix || '') ||
            /<ContentProtection\b/i.test(adaptationScope?.directPrefix || '') ||
            /<ContentProtection\b/i.test(body)
        ) continue;
        if ([
            mpdScope?.directPrefix || '',
            periodScope?.directPrefix || '',
            adaptationScope?.directPrefix || '',
            body
        ].some((scope) => /<Segment(?:Template|List)\b/i.test(scope))) continue;

        let inheritedBaseUrl = parsedManifest.href;
        let invalidBaseUrl = false;
        for (const scope of [mpdScope, periodScope, adaptationScope]) {
            const baseUrl = directXmlBaseUrl(scope?.directPrefix || '');
            if (!baseUrl) continue;
            try {
                inheritedBaseUrl = new URL(baseUrl, inheritedBaseUrl).href;
            } catch (_error) {
                invalidBaseUrl = true;
                break;
            }
        }
        if (invalidBaseUrl) continue;
        try {
            resolved = new URL(decodeXmlText(baseMatch[1].trim()), inheritedBaseUrl).href;
        } catch (_error) {
            continue;
        }
        const inheritedAttribute = (name) =>
            xmlAttribute(attributesText, name) || xmlAttribute(adaptationAttributes, name);
        const mimeType = inheritedAttribute('mimeType').toLowerCase();
        const contentType = inheritedAttribute('contentType').toLowerCase();
        const mediaType = detectMediaFromUrl(resolved) || detectMediaFromContentType(mimeType);
        if (!isSafeManifestDerivedUrl(resolved) || !['MP4', 'WEBM'].includes(mediaType) || isLikelySegmentUrl(resolved)) continue;
        const height = Number(inheritedAttribute('height'));
        const width = Number(inheritedAttribute('width'));
        const bandwidth = Number(xmlAttribute(attributesText, 'bandwidth'));
        const codecs = inheritedAttribute('codecs').toLowerCase();
        const representationId = xmlAttribute(attributesText, 'id').slice(0, 128);
        const frameRate = inheritedAttribute('frameRate').slice(0, 32);
        const scanType = inheritedAttribute('scanType').slice(0, 32);
        const sar = inheritedAttribute('sar').slice(0, 32);
        const audioSamplingRate = inheritedAttribute('audioSamplingRate').slice(0, 32);
        const codecSignals = mediaCodecSignals(codecs);
        const audioCodec = codecSignals.audio;
        const videoCodec = codecSignals.video;
        const audioSignal = contentType === 'audio' || mimeType.startsWith('audio/') || audioCodec;
        const videoSignal = contentType === 'video' || mimeType.startsWith('video/') || videoCodec || height > 0;
        const audioOnly = audioSignal && !videoSignal;
        const muxed = audioSignal && videoSignal;
        const videoOnly = videoSignal && !audioSignal;
        const language = normalizeLanguageTag(inheritedAttribute('lang'));
        const candidate = {
            url: resolved,
            mediaType,
            source: 'manifest_scan',
            resourceType: 'manifest',
            role: audioOnly ? 'audio' : 'variant',
            quality: Number.isInteger(height) && height > 0 ? `${height}p` : '',
            width: Number.isInteger(width) && width > 0 ? width : undefined,
            height: Number.isInteger(height) && height > 0 ? height : undefined,
            bandwidth: Number.isFinite(bandwidth) && bandwidth >= 16_000 ? bandwidth : undefined,
            bitrateKbps: Number.isFinite(bandwidth) && bandwidth >= 16_000 ? Math.round(bandwidth / 1000) : undefined,
            ...(mimeType ? { contentType: mimeType } : {}),
            mediaKind: audioOnly ? 'audio-only' : (muxed ? 'muxed' : (videoOnly ? 'video-only' : undefined)),
            hasAudio: audioSignal ? true : (videoOnly ? false : undefined),
            hasVideo: videoSignal ? true : (audioOnly ? false : undefined),
            ...(language ? { language } : {}),
            autoEligible: false,
            title: [
                Number.isInteger(height) && height > 0 ? `Wariant DASH ${height}p` : 'Wariant DASH z manifestu',
                frameRate ? `${frameRate} fps` : ''
            ].filter(Boolean).join(' · '),
            manifestIdentity: `${audioOnly ? 'audio' : 'variant'}|${Number.isInteger(height) ? height : 0}|${Number.isFinite(bandwidth) ? bandwidth : 0}|${language}|${mimeType}|${codecs}|${representationId}|${frameRate}|${scanType}|${sar}|${audioSamplingRate}`
        };
        if (classifyMediaPurpose(candidate) !== 'content') continue;
        variants.set(
            `${canonicalizeMediaUrl(resolved)}|${candidate.manifestIdentity}`,
            candidate
        );
    }
    return rankManifestVariants(variants.values());
}

function parseManifestVariants(value, manifestUrl, type = '') {
    const normalizedType = String(type || detectMediaFromUrl(manifestUrl) || '').toUpperCase();
    if (normalizedType === 'HLS') return parseHlsMasterPlaylist(value, manifestUrl);
    if (normalizedType === 'DASH') return parseDashManifestRepresentations(value, manifestUrl);
    return [];
}

function isLikelySegmentUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return false;
    const path = decodePathSafely(parsed.pathname).toLowerCase();
    return (
        /\.(?:m4s|cmfv|cmfa|ts|aac)$/.test(path) ||
        /(?:^|\/)(?:seg(?:ment)?|chunk|fragment|frag)[-_.]?\d+(?:[-_.\/]|$)/.test(path) ||
        /(?:^|\/)(?:init(?:ialization)?|nv-dash-init)(?:[-_.][^/]*)?\.mp4$/.test(path)
    );
}

function classifyMediaRole(candidate) {
    const parsed = parseHttpUrl(candidate?.url || '');
    const path = parsed ? decodePathSafely(parsed.pathname).toLowerCase() : '';
    const contentType = normalizeContentType(candidate?.contentType || '');
    const type = String(candidate?.type || '').toUpperCase();

    if (
        candidate?.elementKind === 'audio' ||
        contentType.startsWith('audio/') ||
        /(?:^|[/_.-])(audio|audioonly|audio_only|main_audio)(?:[/_.-]|$)/i.test(path) ||
        /nv-hlsfmp4-index-[^/]*-a\d+\.m3u8$/i.test(path)
    ) return 'audio';
    if (type === 'MP4' || type === 'WEBM' || type === 'MEDIA') return 'direct';
    if (
        /(?:chunklist|rendition|variant|nv-hlsfmp4-index-[^/]*-v\d+\.m3u8$|(?:^|[/_.-])index[-_]\d+|(?:^|[/_.-])(?:144|240|360|480|540|576|720|1080|1440|2160)p(?:[/_.-]|$)|(?:^|[/_.-])(?:video|media|bitrate)[-_]?\d+)/i.test(path)
    ) return 'variant';
    return 'master';
}

function adSignalTokens(value) {
    return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasAnchoredAdPathSignal(value) {
    const normalized = String(value || '').toLowerCase();
    if (!normalized) return false;
    if (AD_PATH_SEGMENTS.has(normalized)) return true;
    const tokens = adSignalTokens(normalized);
    if (tokens.some((token) =>
        AD_PATH_SEGMENTS.has(token) ||
        /^(?:ad|ads|advert|advertisement)\d+$/.test(token) ||
        /^(?:pre|mid|post)roll\d*$/.test(token)
    )) return true;
    return tokens.some((token, index) =>
        ['pre', 'mid', 'post'].includes(token) && tokens[index + 1] === 'roll'
    );
}

function hostnameHasHardAdSignal(hostname) {
    return String(hostname || '').toLowerCase().split('.').some((label) =>
        adSignalTokens(label).some((token) => AD_HOST_TOKENS.has(token))
    );
}

function queryHasHardAdSignal(searchParams) {
    for (const [rawName, rawValue] of searchParams.entries()) {
        const name = String(rawName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const value = String(rawValue || '').trim().toLowerCase();
        const compactValue = value.replace(/[^a-z0-9]+/g, '');
        if (AD_QUERY_IDENTIFIER_KEYS.has(name)) return true;
        if (AD_QUERY_TRANSPORT_KEYS.has(name) && !NON_AD_SWITCH_VALUES.has(compactValue)) return true;
        if (AD_QUERY_KIND_KEYS.has(name) && hasAnchoredAdPathSignal(value)) return true;
        if (AD_QUERY_SWITCH_KEYS.has(name) && !NON_AD_SWITCH_VALUES.has(compactValue)) return true;
    }
    return false;
}

function titleHasHardAdSignal(value) {
    if (typeof value !== 'string') return false;
    const title = value.trim().toLowerCase().slice(0, 256);
    if (!title) return false;
    if (/^(?:advert(?:isement)?|commercial|reklam(?:a|y)?|sponsored|pre[-_. ]?roll|mid[-_. ]?roll|post[-_. ]?roll)(?:$|[\s:|#()[\]_-])/i.test(title)) {
        return true;
    }
    if (/^(?:vast|vmap|ima)(?:$|[\s:|#()[\]_-]+(?:ad|ads|advert(?:isement)?|pre[-_. ]?roll|mid[-_. ]?roll|post[-_. ]?roll)(?:$|[\s:|#()[\]_-]))/i.test(title)) {
        return true;
    }
    return /^ads?(?:$|\s*(?::|#|\||-|\d))/i.test(title);
}

function classifyMediaPurpose(candidate) {
    const parsed = parseHttpUrl(candidate?.url || '');
    if (!parsed) return 'content';

    if (isLikelySegmentUrl(candidate.url)) return 'utility';

    const path = decodePathSafely(parsed.pathname).toLowerCase();
    const segments = path.split('/').filter(Boolean);
    if (
        hostnameHasHardAdSignal(parsed.hostname) ||
        segments.some(hasAnchoredAdPathSignal) ||
        queryHasHardAdSignal(parsed.searchParams) ||
        titleHasHardAdSignal(candidate?.title)
    ) return 'advertisement';

    const basename = segments.at(-1) || '';
    if (
        UTILITY_MEDIA_BASENAMES.has(basename) ||
        /^(?:silence|silent|blank)(?:[-_.][a-z0-9]+)*\.(?:mp4|webm)$/i.test(basename)
    ) return 'utility';
    return 'content';
}

function isBlockedCandidate(candidate) {
    const purpose = candidate?.purpose || classifyMediaPurpose(candidate);
    return purpose === 'advertisement' || purpose === 'utility';
}

const RECOGNIZED_QUALITY_HEIGHTS = new Set([
    144, 240, 360, 480, 540, 576, 720, 900, 1080, 1440, 2160, 4320
]);

function qualityHeightFromText(value, options = {}) {
    if (typeof value !== 'string' || !value.trim()) return 0;
    const text = value.toLowerCase().slice(0, 4096);
    const aliases = [
        [4320, /(?:^|[^a-z0-9])(?:8k)(?:[^a-z0-9]|$)/],
        [2160, /(?:^|[^a-z0-9])(?:4k|uhd|ultra[-_. ]?hd)(?:[^a-z0-9]|$)/],
        [1440, /(?:^|[^a-z0-9])(?:qhd|2k)(?:[^a-z0-9]|$)/],
        [1080, /(?:^|[^a-z0-9])(?:fhd|full[-_. ]?hd)(?:[^a-z0-9]|$)/]
    ];
    for (const [height, pattern] of aliases) {
        if (pattern.test(text)) return height;
    }

    const explicit = /(?:^|[^a-z0-9])(144|240|360|480|540|576|720|900|1080|1440|2160|4320)p(?:[^a-z0-9]|$)/.exec(text);
    if (explicit) return Number(explicit[1]);
    const dimensions = /(?:^|[^a-z0-9])(\d{3,5})\s*[x×]\s*(\d{3,5})(?:[^a-z0-9]|$)/.exec(text);
    if (dimensions) {
        const height = Number(dimensions[2]);
        if (height >= 100 && height <= 8640) return height;
    }
    if (options.allowBare === true && /^\s*(144|240|360|480|540|576|720|900|1080|1440|2160|4320)\s*$/.test(text)) {
        return Number(text.trim());
    }
    return 0;
}

function qualityHeightFromUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return 0;
    const path = decodePathSafely(parsed.pathname).toLowerCase().slice(0, 8192);
    const explicit = qualityHeightFromText(path);
    if (explicit) return explicit;

    const segments = path.split('/').filter(Boolean).slice(0, 96);
    for (let index = 1; index < segments.length; index += 1) {
        if (!/^(?:quality|qualities|resolution|resolutions|rendition|renditions|height|video|stream|level|variant)$/.test(segments[index - 1])) continue;
        const height = Number(segments[index]);
        if (RECOGNIZED_QUALITY_HEIGHTS.has(height)) return height;
    }
    for (const [rawName, rawValue] of parsed.searchParams.entries()) {
        if (!/^(?:quality|resolution|height|res|video[-_]?quality)$/i.test(rawName)) continue;
        const height = qualityHeightFromText(rawValue, { allowBare: true });
        if (height) return height;
    }
    return 0;
}

function inferCandidateHeight(candidate) {
    if (Number.isInteger(candidate?.height) && candidate.height >= 100 && candidate.height <= 8640) {
        return candidate.height;
    }
    const urlHeight = qualityHeightFromUrl(candidate?.url || '');
    if (urlHeight) return urlHeight;
    return qualityHeightFromText(candidate?.quality || '', { allowBare: true });
}

function inferCandidateBitrateKbps(candidate) {
    if (Number.isFinite(candidate?.bitrateKbps) && candidate.bitrateKbps >= 16 && candidate.bitrateKbps <= 250_000) {
        return Math.round(candidate.bitrateKbps);
    }
    if (Number.isFinite(candidate?.bandwidth) && candidate.bandwidth >= 16_000 && candidate.bandwidth <= 250_000_000) {
        return Math.round(candidate.bandwidth / 1000);
    }
    const parsed = parseHttpUrl(candidate?.url || '');
    if (!parsed) return 0;
    const path = decodePathSafely(parsed.pathname).toLowerCase().slice(0, 8192);
    const pathMatch = /(?:^|[/_.-])(\d{2,6})(?:k|kbps)(?:[/_.-]|$)/.exec(path);
    if (pathMatch) {
        const value = Number(pathMatch[1]);
        if (value >= 16 && value <= 250_000) return value;
    }
    for (const [rawName, rawValue] of parsed.searchParams.entries()) {
        if (!/^(?:bitrate|bandwidth|video[-_]?bitrate|br)$/i.test(rawName)) continue;
        const match = /^(\d{2,9})(?:k|kbps|bps)?$/i.exec(rawValue.trim());
        if (!match) continue;
        let value = Number(match[1]);
        if (value > 250_000) value = Math.round(value / 1000);
        if (value >= 16 && value <= 250_000) return value;
    }
    return 0;
}

function inferCandidateQuality(candidate) {
    const height = inferCandidateHeight(candidate);
    if (height) return `${height}p`;
    const role = candidate?.role || classifyMediaRole(candidate);
    const type = String(candidate?.type || '').toUpperCase();
    return role === 'master' && ['HLS', 'DASH'].includes(type) ? 'Auto' : '';
}

function normalizeQualityOrder(value) {
    if (!Array.isArray(value) || value.length !== DEFAULT_QUALITY_ORDER.length) {
        return [...DEFAULT_QUALITY_ORDER];
    }
    const order = value.map((item) => typeof item === 'string' ? item.toLowerCase() : '');
    if (new Set(order).size !== DEFAULT_QUALITY_ORDER.length || order.some((item) => !QUALITY_ORDER_SET.has(item))) {
        return [...DEFAULT_QUALITY_ORDER];
    }
    return order;
}

function candidateQualityBucket(candidate) {
    const height = inferCandidateHeight(candidate);
    if (height >= 2160) return '2160p';
    if (height >= 1440) return '1440p';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return '';
}

function candidateQualityRank(candidate, order = DEFAULT_QUALITY_ORDER) {
    const normalizedOrder = normalizeQualityOrder(order);
    const bucket = candidateQualityBucket(candidate);
    const index = bucket ? normalizedOrder.indexOf(bucket) : -1;
    return index >= 0 ? index : normalizedOrder.length;
}

function scoreCandidate(candidate) {
    const type = String(candidate?.type || '').toUpperCase();
    const role = candidate?.role || classifyMediaRole(candidate);
    if (isBlockedCandidate(candidate)) return 0;
    let score = type === 'HLS' || type === 'DASH' ? 45 : 30;

    if (role === 'master') score += 30;
    else if (role === 'direct') score += 20;
    else if (role === 'variant') score += 12;
    else if (role === 'audio') score -= 35;

    if (candidate?.contentType) score += 8;
    if (candidate?.resourceType === 'media') score += 5;
    if (candidate?.referer || candidate?.origin || candidate?.userAgent) score += 3;
    if (Number.isInteger(candidate?.statusCode)) {
        if (candidate.statusCode >= 200 && candidate.statusCode < 400) score += 7;
        else if (candidate.statusCode >= 400) score -= 100;
    }
    if (candidate?.networkError) score -= 120;
    if (isLikelySegmentUrl(candidate?.url)) score -= 150;
    return Math.max(0, Math.min(100, score));
}

function candidateMediaCompleteness(candidate) {
    const kind = typeof candidate?.mediaKind === 'string' ? candidate.mediaKind : '';
    const hasAudio = candidate?.hasAudio === true;
    const hasVideo = candidate?.hasVideo === true;
    if (kind === 'adaptive' && hasAudio && hasVideo) return 5;
    if (kind === 'muxed' && hasAudio && hasVideo) return 4;
    if (hasAudio && hasVideo) return 3;
    if (kind === 'video-only' || (hasVideo && candidate?.hasAudio === false)) return 1;
    if (kind === 'audio-only' || (hasAudio && candidate?.hasVideo === false)) return 0;
    const role = normalizeResolverRole(candidate?.resolverRole) || normalizeResolverRole(candidate?.role) || classifyMediaRole(candidate);
    if (role === 'master') return 3;
    if (role === 'direct') return 2;
    if (role === 'variant') return 1;
    return 0;
}

function isExplicitlyIncompleteCandidate(candidate) {
    return ['video-only', 'audio-only'].includes(candidate?.mediaKind) ||
        candidate?.hasAudio === false ||
        candidate?.hasVideo === false;
}

function isYouTubePrimaryResolverCandidate(candidate, materialScopeId) {
    if (!candidate || !materialScopeId || !hasResolverProvenance(candidate)) return false;
    const explicitlyIncomplete =
        ['video-only', 'audio-only'].includes(candidate.mediaKind) ||
        normalizeResolverRole(candidate.resolverRole || candidate.role) === 'audio' ||
        candidate.hasAudio === false ||
        candidate.hasVideo === false;
    const reliablePlayback = candidate.playbackKind === 'yt-dlp-page' ||
        candidate.mediaKind === 'muxed';
    return candidate.resolverCurrent === true &&
        candidate.materialScope === materialScopeId &&
        reliablePlayback &&
        !explicitlyIncomplete;
}

function redactMediaMetadata(value, type, role) {
    const url = typeof value === 'object' && value !== null ? value.url : value;
    const candidateType = typeof value === 'object' && value !== null ? value.type : type;
    const candidateRole = typeof value === 'object' && value !== null ? value.role : role;
    const parsed = parseHttpUrl(url || '');
    if (!parsed) return { type: candidateType || 'unknown', role: candidateRole || 'unknown' };

    const lowerPath = parsed.pathname.toLowerCase();
    const knownExtension = ['.m3u8', '.mpd', '.mp4', '.webm'].find((extension) => lowerPath.includes(extension));
    return {
        host: parsed.hostname,
        scheme: parsed.protocol.slice(0, -1),
        extension: knownExtension || '',
        hasQuery: Boolean(parsed.search),
        pathDepth: parsed.pathname.split('/').filter(Boolean).length,
        type: candidateType || detectMediaFromUrl(url) || 'unknown',
        role: candidateRole || 'unknown',
        purpose: typeof value === 'object' && value !== null
            ? (value.purpose || classifyMediaPurpose(value))
            : 'content'
    };
}

function sanitizePublicMessage(value, fallback = 'Nieznany błąd.') {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return value
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240) || fallback;
}

function normalizeErrorCode(value, fallback = 'UNKNOWN_ERROR') {
    if (typeof value !== 'string') return fallback;
    const code = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 64);
    return code || fallback;
}

function normalizeHostname(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const withScheme = value.includes('://') ? value : `https://${value}`;
        return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, '');
    } catch (_error) {
        return '';
    }
}

function normalizePlayMode(value, fallback = 'new') {
    const aliases = { queue: 'append', enqueue: 'append', fresh: 'new' };
    const normalized = aliases[value] || value;
    return ALLOWED_PLAY_MODES.has(normalized) ? normalized : fallback;
}

function isLegacyLocalKey(key) {
    return typeof key === 'string' && (
        key.startsWith('streams_') ||
        key.startsWith('logs_') ||
        key === 'autoLaunchMpv' ||
        key === 'queueToExistingMpv'
    );
}

function decodePathSafely(path) {
    try {
        return decodeURIComponent(path);
    } catch (_error) {
        return path;
    }
}

function stableHash(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function expiryRefreshFingerprint(value) {
    const text = String(value || '');
    const reversed = [...text].reverse().join('');
    return [
        stableHash(`expiry:a:${text}`),
        stableHash(`expiry:b:${reversed}`),
        stableHash(`expiry:c:${text.length}:${text}`)
    ].join('_');
}

function sourcePreferenceFingerprint(value) {
    const groupKey = typeof value === 'string'
        ? canonicalizeMediaUrl(value)
        : (typeof value?.groupKey === 'string' && value.groupKey
            ? value.groupKey
            : canonicalizeMediaUrl(value?.url || ''));
    if (!groupKey) return '';
    const reversed = [...groupKey].reverse().join('');
    return [
        stableHash(`source-v1:a:${groupKey}`),
        stableHash(`source-v1:b:${reversed}`),
        stableHash(`source-v1:c:${groupKey.length}:${groupKey}`),
        stableHash(`source-v1:d:${reversed.length}:${reversed}`)
    ].join('_');
}

function normalizeSourceFamilyPathSegment(rawSegment, previousSegment = '') {
    let segment = decodePathSafely(String(rawSegment || '')).toLowerCase().slice(0, 256);
    if (!segment) return '';
    if (/^\d+$/.test(segment)) {
        const numeric = Number(segment);
        if (/^(?:quality|resolution|rendition|height|video|stream|level|variant)$/.test(previousSegment) && RECOGNIZED_QUALITY_HEIGHTS.has(numeric)) {
            return segment;
        }
        return '{n}';
    }
    if (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(segment)) return '{uuid}';
    if (/^[a-z0-9_-]{24,}$/i.test(segment) && /[a-z]/i.test(segment) && /\d/.test(segment)) return '{id}';

    segment = segment.replace(/\b[a-f0-9]{24,}\b/gi, '{id}');
    segment = segment.replace(/\d{4,}/g, (digits, offset, input) => {
        const suffix = input.slice(offset + digits.length).toLowerCase();
        const number = Number(digits);
        if (suffix.startsWith('p') && RECOGNIZED_QUALITY_HEIGHTS.has(number)) return digits;
        if (/^(?:k|kbps)(?:[^a-z0-9]|$)/.test(suffix) && number >= 16 && number <= 250_000) return digits;
        return '{id}';
    });
    return segment || '{part}';
}

function sourceFamilySignature(value) {
    const candidate = typeof value === 'object' && value !== null ? value : { url: value };
    const parsed = parseHttpUrl(candidate.url || '');
    if (!parsed) return '';
    const segments = parsed.pathname.split('/').filter(Boolean).slice(0, 64);
    const normalizedSegments = [];
    for (const segment of segments) {
        normalizedSegments.push(normalizeSourceFamilyPathSegment(segment, normalizedSegments.at(-1) || ''));
    }
    const type = String(candidate.type || detectMediaFromUrl(parsed.href) || 'MEDIA').toUpperCase();
    const role = normalizeResolverRole(candidate.resolverRole) ||
        normalizeResolverRole(candidate.role) ||
        classifyMediaRole({ ...candidate, url: parsed.href, type });
    const height = inferCandidateHeight(candidate);
    const bitrateKbps = inferCandidateBitrateKbps(candidate);
    const language = normalizeLanguageTag(candidate.language);
    const stableQueryHints = [];
    for (const [rawName, rawValue] of parsed.searchParams.entries()) {
        const name = rawName.toLowerCase();
        if (!/^(?:format|type|ext|extension|quality|resolution|height|bitrate|bandwidth|video[-_]?(?:bitrate|quality)|br|lang|language|audio[-_]?lang)$/.test(name)) continue;
        const cleanValue = rawValue.toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 48);
        if (cleanValue) stableQueryHints.push(`${name}=${cleanValue}`);
    }
    stableQueryHints.sort();
    return [
        'source-family-v2',
        parsed.protocol,
        parsed.hostname,
        type,
        role,
        height || 0,
        bitrateKbps || 0,
        language,
        `/${normalizedSegments.join('/')}`,
        stableQueryHints.join('&')
    ].join('|');
}

function sourceFamilyFingerprint(value) {
    const signature = sourceFamilySignature(value);
    if (!signature) return '';
    const reversed = [...signature].reverse().join('');
    return [
        stableHash(`family-v2:a:${signature}`),
        stableHash(`family-v2:b:${reversed}`),
        stableHash(`family-v2:c:${signature.length}:${signature}`),
        stableHash(`family-v2:d:${reversed.length}:${reversed}`)
    ].join('_');
}

function sourceFamilyLabel(candidate) {
    const parsed = parseHttpUrl(candidate?.url || '');
    if (!parsed) return '';
    const parts = [String(candidate?.type || detectMediaFromUrl(parsed.href) || 'MEDIA').toUpperCase()];
    const quality = inferCandidateQuality(candidate);
    const bitrateKbps = inferCandidateBitrateKbps(candidate);
    const language = normalizeLanguageTag(candidate?.language);
    if (quality && quality !== 'Auto') parts.push(quality);
    if (bitrateKbps) {
        const mbps = bitrateKbps / 1000;
        parts.push(`${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mb/s`);
    }
    if (language) parts.push(language);
    parts.push(parsed.hostname);
    return parts.join(' · ').slice(0, 160);
}

function normalizeSourcePriority(value) {
    if (value === 1 || value === 'preferred') return 1;
    if (value === -1 || value === 'deprioritized') return -1;
    return 0;
}

function normalizePlayerKeyList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((key) =>
        typeof key === 'string' &&
        key.length <= 96 &&
        /^\d+:[a-z0-9]+:[A-Za-z0-9_-]+$/.test(key)
    ))].slice(0, MAX_PLAYER_KEYS_PER_CANDIDATE);
}

function mergePlayerKeyLists(...values) {
    return normalizePlayerKeyList(values.flatMap((value) => Array.isArray(value) ? value : []));
}

function hasCurrentPlayerEvidence(candidate) {
    return normalizePlayerKeyList(candidate?.currentPlayerKeys).length > 0;
}

function isGenericPrerollProvisional(candidate, now = Date.now()) {
    if (!candidate || !Number.isFinite(candidate.genericPrerollGuardUntil)) return false;
    if (candidate.superseded === true || candidate.diagnosticOnly === true || hasResolverProvenance(candidate)) return false;
    if (candidate.live === true) return false;
    if (candidate.manifestParentShortCurrent === true) return true;
    const duration = Number(candidate.duration);
    if (
        hasCurrentPlayerEvidence(candidate) &&
        Number.isFinite(duration) &&
        duration > 0 &&
        duration <= GENERIC_SHORT_MEDIA_MAX_SECONDS
    ) return true;
    return candidate.genericPrerollGuardUntil > now;
}

function candidatePageEvidence(candidate) {
    if (hasCurrentPlayerEvidence(candidate)) return 3;
    if (normalizePlayerKeyList(candidate?.playerKeys).length) return 2;
    if (Array.isArray(candidate?.pageSnapshotKeys) && candidate.pageSnapshotKeys.length) return 1;
    return 0;
}

function candidatePlaybackFitnessTier(candidate) {
    const role = normalizeResolverRole(candidate?.resolverRole) ||
        normalizeResolverRole(candidate?.role) ||
        classifyMediaRole(candidate);
    if (role === 'audio' || isExplicitlyIncompleteCandidate(candidate)) return 2;
    if (
        candidate?.mediaKind === 'adaptive' ||
        candidate?.mediaKind === 'muxed' ||
        (candidate?.hasAudio === true && candidate?.hasVideo === true) ||
        role === 'master' ||
        role === 'direct'
    ) return 0;
    // A bare rendition can be playable, but without mux/audio metadata it is a
    // weaker default than a complete master or direct file. It stays available
    // for manual use and can still be promoted by later network evidence.
    return 1;
}

function candidateTransportTier(candidate) {
    if (candidate?.playbackKind === 'yt-dlp-page') return 6;

    const sourceMethod = candidateSourceMethod(candidate?.source);
    const confirmedNetwork = (
        candidate?.networkObserved === true &&
        !candidate?.networkError &&
        Number.isInteger(candidate?.statusCode) &&
        candidate.statusCode >= 200 &&
        candidate.statusCode < 400
    );
    if (confirmedNetwork) return 0;
    if (sourceMethod === 'streamlink' || sourceMethod === 'yt-dlp') return 1;
    if (candidate?.manifestDerived === true || sourceMethod === 'manifest') return 2;
    if (candidate?.networkObserved === true || sourceMethod === 'network') return 3;

    const type = String(candidate?.type || detectMediaFromUrl(candidate?.url || '') || '').toUpperCase();
    if (sourceMethod === 'page' && ['MP4', 'WEBM', 'HLS', 'DASH'].includes(type)) return 4;
    if (sourceMethod === 'page') return 5;
    return 5;
}

function candidateMediaTransportRank(candidate) {
    if (candidate?.playbackKind === 'yt-dlp-page') return 3;
    const type = String(candidate?.type || detectMediaFromUrl(candidate?.url || '') || '').toUpperCase();
    if (type === 'MP4' || type === 'WEBM') return 0;
    if (type === 'HLS' || type === 'DASH') return 1;
    return 2;
}

function candidatePlaylistTier(candidate) {
    if (candidate?.playbackKind === 'yt-dlp-page') return 2;

    const declaredType = String(candidate?.type || '').toUpperCase();
    const detectedType = detectMediaFromUrl(candidate?.url || '');
    if (CONCRETE_MEDIA_TYPES.has(declaredType) || CONCRETE_MEDIA_TYPES.has(detectedType)) return 0;

    const sourceMethod = typeof candidate?.source === 'string' && candidate.source
        ? candidateSourceMethod(candidate.source)
        : candidate?.sourceMethod;
    return sourceMethod === 'page' ? 2 : 1;
}

function candidateRecommendationTransportTier(candidate) {
    const resolverBacked = hasResolverProvenance(candidate);
    if (
        resolverBacked &&
        (
            candidate?.playbackKind === 'yt-dlp-page' ||
            candidateMediaCompleteness(candidate) >= 3
        )
    ) return 0;

    const browserOnlyConfirmed = !resolverBacked &&
        candidate?.networkObserved === true &&
        !candidate?.networkError &&
        Number.isInteger(candidate?.statusCode) &&
        candidate.statusCode >= 200 &&
        candidate.statusCode < 400;
    if (browserOnlyConfirmed) return 1;
    return 2;
}

function isSameObservedRequest(candidate, observation) {
    return Boolean(
        candidate?.requestId &&
        observation?.requestId &&
        candidate.requestId === observation.requestId &&
        Number.isFinite(candidate.requestStartedAt) &&
        Number.isFinite(observation.requestStartedAt) &&
        candidate.requestStartedAt === observation.requestStartedAt
    );
}

function pageSnapshotIdentity(message, sender) {
    const frameId = Number.isInteger(sender?.frameId) && sender.frameId >= 0 ? sender.frameId : 0;
    const documentIdentity = typeof sender?.documentId === 'string' && sender.documentId
        ? sender.documentId
        : (typeof message?.page?.url === 'string' && message.page.url ? message.page.url : 'unknown-document');
    return {
        frameId,
        key: `${frameId}:${stableHash(documentIdentity)}`,
        framePrefix: `${frameId}:`
    };
}

function scopedPagePlayerKeys(value, snapshot) {
    if (!Array.isArray(value) || !snapshot?.key) return [];
    return [...new Set(value.filter((key) =>
        typeof key === 'string' &&
        key.length <= 48 &&
        /^[A-Za-z0-9_-]+$/.test(key)
    ).map((key) => `${snapshot.key}:${key}`))].slice(0, MAX_PLAYER_KEYS_PER_CANDIDATE);
}

function isExplicitlyFailedCandidate(candidate, now = Date.now()) {
    const playFailureCode = normalizeErrorCode(candidate?.lastPlayErrorCode || '', '');
    const playFailureMatchesUrl = !candidate?.lastPlayErrorUrlHash ||
        candidate.lastPlayErrorUrlHash === stableHash(candidate?.url || '');
    const contentPlayFailure = candidate?.playState === 'error' &&
        playFailureMatchesUrl &&
        (!playFailureCode || CONTENT_PLAY_FAILURE_CODES.has(playFailureCode));
    return Boolean(
        candidate?.networkError ||
        (Number.isInteger(candidate?.statusCode) && candidate.statusCode >= 400) ||
        contentPlayFailure ||
        isCandidateExpired(candidate, now)
    );
}

function currentTabEpoch(tabId) {
    return tabEpochs.get(tabId) || 0;
}

function bumpTabEpoch(tabId) {
    pendingManifestScanTabs.delete(tabId);
    for (const key of manifestScanAttemptsByNavigation.keys()) {
        if (key.startsWith(`${tabId}:`)) manifestScanAttemptsByNavigation.delete(key);
    }
    const next = currentTabEpoch(tabId) + 1;
    tabEpochs.set(tabId, next);
    return next;
}

// ─── State and diagnostics ──────────────────────────────────────────────────

function tabStateKey(tabId) {
    return `${TAB_STATE_PREFIX}${tabId}`;
}

function statusRecord(state, code, message, extra = {}) {
    return {
        state,
        code: normalizeErrorCode(code, 'STATUS'),
        message: sanitizePublicMessage(message, 'Brak szczegółów.'),
        updatedAt: Date.now(),
        ...extra
    };
}

function scanningStatus() {
    return statusRecord('scanning', 'SCANNING', 'Skanuję ruch tej karty w poszukiwaniu multimediów.');
}

function createTabState(tabId, hostname = '', navigationEpoch = currentTabEpoch(tabId), pageUrl = '') {
    const now = Date.now();
    const state = {
        schemaVersion: STATE_SCHEMA_VERSION,
        tabId,
        hostname: normalizeHostname(hostname),
        platform: { id: 'generic', label: 'Strona internetowa' },
        materialScope: null,
        pageIdentity: '',
        navigationEpoch: Number.isInteger(navigationEpoch) && navigationEpoch >= 0 ? navigationEpoch : 0,
        candidates: [],
        events: [],
        status: scanningStatus(),
        resolver: {
            state: 'idle',
            adapter: 'generic',
            attempted: [],
            resultCount: 0,
            cookiesUsed: false,
            source: null,
            materialScope: '',
            batchId: null,
            candidateIds: [],
            pageReadyScope: '',
            pageReadyState: 'idle',
            updatedAt: 0
        },
        sourcePreferences: {
            showFullUrls: false,
            ruleCount: 0,
            qualityOrder: [...DEFAULT_QUALITY_ORDER]
        },
        auto: {
            enabled: false,
            pendingDueAt: null,
            cooldownUntil: 0,
            suppressUntil: 0,
            lastCandidateId: null,
            lastFingerprint: null,
            lastAttemptAt: 0,
            retryFingerprint: null,
            retryCount: 0
        },
        expiryRefresh: {
            fingerprint: '',
            attemptedAt: 0,
            attemptedFingerprints: [],
            inFlightFingerprint: '',
            inFlightUntil: 0,
            retryNotBefore: 0,
            pendingCandidateId: '',
            pendingUrlHash: '',
            pendingReason: '',
            pendingSince: 0,
            pendingRetryCount: 0
        },
        createdAt: now,
        updatedAt: now
    };
    if (pageUrl) applyTrustedPageContext(state, pageUrl);
    return state;
}

function normalizeTabState(value, tabId, hostname = '') {
    if (!value || value.schemaVersion !== STATE_SCHEMA_VERSION || value.tabId !== tabId) {
        return createTabState(tabId, hostname);
    }
    const state = value;
    state.hostname = normalizeHostname(state.hostname || hostname);
    state.platform = state.platform && typeof state.platform === 'object'
        ? {
            id: ['tvp', 'youtube', 'generic'].includes(state.platform.id) ? state.platform.id : 'generic',
            label: sanitizePublicMessage(state.platform.label, 'Strona internetowa').slice(0, 40)
        }
        : { id: 'generic', label: 'Strona internetowa' };
    state.materialScope = normalizeMaterialScope(state.materialScope);
    state.pageIdentity = typeof state.pageIdentity === 'string' ? state.pageIdentity.slice(0, 160) : '';
    state.navigationEpoch = Number.isInteger(state.navigationEpoch) && state.navigationEpoch >= 0
        ? state.navigationEpoch
        : currentTabEpoch(tabId);
    state.candidates = Array.isArray(state.candidates)
        ? state.candidates.slice(0, MAX_CANDIDATES).map((candidate) => {
            if (!candidate || typeof candidate !== 'object') return null;
            candidate.sources = Array.isArray(candidate.sources)
                ? [...new Set(candidate.sources.filter((source) => typeof source === 'string').slice(-8))]
                : (typeof candidate.source === 'string' ? [candidate.source] : []);
            candidate.sourceMethod = candidateSourceMethod(candidate.source);
            candidate.networkObserved = candidate.networkObserved === true || candidate.sourceMethod === 'network';
            candidate.manifestDerived = candidate.sourceMethod === 'manifest' || candidate.manifestDerived === true;
            candidate.pageDerived = candidate.pageDerived === true;
            if (candidate.manifestDerived) {
                candidate.manifestRole = normalizeResolverRole(candidate.manifestRole || candidate.role) || 'variant';
                candidate.manifestCanonicalKey = canonicalizeMediaUrl(candidate.url);
                const manifestParentCanonicalKey = canonicalizeMediaUrl(candidate.manifestParentCanonicalKey || '');
                if (manifestParentCanonicalKey) candidate.manifestParentCanonicalKey = manifestParentCanonicalKey;
                else delete candidate.manifestParentCanonicalKey;
            } else {
                delete candidate.manifestRole;
                delete candidate.manifestCanonicalKey;
                delete candidate.manifestParentCanonicalKey;
            }
            if (candidate.pageDerived) {
                candidate.pageCanonicalKey = canonicalizeMediaUrl(candidate.url);
            } else {
                delete candidate.pageCanonicalKey;
            }
            const storedResolverRole = hasResolverProvenance(candidate)
                ? normalizeResolverRole(candidate.resolverRole)
                : '';
            const legacyResolverRole = (
                !storedResolverRole &&
                ['streamlink', 'yt-dlp'].includes(candidate.sourceMethod)
            ) ? normalizeResolverRole(candidate.role) : '';
            const resolverRole = storedResolverRole || legacyResolverRole;
            if (resolverRole) candidate.resolverRole = resolverRole;
            else delete candidate.resolverRole;
            if (resolverRole) {
                const language = normalizeLanguageTag(candidate.language);
                const mediaKind = typeof candidate.mediaKind === 'string' && RESOLVER_MEDIA_KINDS.has(candidate.mediaKind)
                    ? candidate.mediaKind
                    : '';
                if (language) candidate.language = language;
                else delete candidate.language;
                if (mediaKind) candidate.mediaKind = mediaKind;
                else delete candidate.mediaKind;
                if (typeof candidate.hasAudio !== 'boolean') delete candidate.hasAudio;
                if (typeof candidate.hasVideo !== 'boolean') delete candidate.hasVideo;
                if (typeof candidate.formatId !== 'string') delete candidate.formatId;
                else candidate.formatId = sanitizePublicMessage(candidate.formatId, '').slice(0, 64);
                if (!RESOLVER_PLAYBACK_KINDS.has(candidate.playbackKind)) delete candidate.playbackKind;
                candidate.resolverBatch = typeof candidate.resolverBatch === 'string'
                    ? candidate.resolverBatch.slice(0, 160)
                    : '';
                candidate.resolverCurrent = candidate.resolverCurrent === true;
                candidate.materialScope = typeof candidate.materialScope === 'string'
                    ? candidate.materialScope.slice(0, 160)
                    : '';
                candidate.preferredLanguageRank = Number.isInteger(candidate.preferredLanguageRank) && candidate.preferredLanguageRank >= 0
                    ? Math.min(candidate.preferredLanguageRank, MAX_PREFERRED_LANGUAGES)
                    : MAX_PREFERRED_LANGUAGES;
            } else {
                if (candidate.manifestDerived) {
                    const language = normalizeLanguageTag(candidate.language);
                    if (language) candidate.language = language;
                    else delete candidate.language;
                    candidate.mediaKind = RESOLVER_MEDIA_KINDS.has(candidate.mediaKind) ? candidate.mediaKind : '';
                    if (!candidate.mediaKind) delete candidate.mediaKind;
                    if (typeof candidate.hasAudio !== 'boolean') delete candidate.hasAudio;
                    if (typeof candidate.hasVideo !== 'boolean') delete candidate.hasVideo;
                    if (candidate.sourceMethod === 'manifest') candidate.autoEligible = false;
                    else delete candidate.autoEligible;
                } else {
                    delete candidate.language;
                    delete candidate.mediaKind;
                    delete candidate.hasAudio;
                    delete candidate.hasVideo;
                    delete candidate.autoEligible;
                }
                delete candidate.formatId;
                delete candidate.playbackKind;
                delete candidate.resolverBatch;
                delete candidate.resolverCurrent;
                delete candidate.materialScope;
                delete candidate.preferredLanguageRank;
            }
            candidate.superseded = candidate.superseded === true;
            candidate.supersededAt = Number.isFinite(candidate.supersededAt) ? candidate.supersededAt : 0;
            candidate.diagnosticReason = candidate.superseded
                ? 'PLAYER_SOURCE_REPLACED'
                : (typeof candidate.diagnosticReason === 'string' ? candidate.diagnosticReason.slice(0, 64) : '');
            candidate.diagnosticOnly = state.platform.id === 'youtube'
                ? !isYouTubePrimaryResolverCandidate(candidate, state.materialScope?.id || '')
                : candidate.superseded || candidate.diagnosticOnly === true;
            const manifestRole = candidate.manifestDerived
                ? normalizeResolverRole(candidate.manifestRole || candidate.role)
                : '';
            candidate.role = resolverRole || manifestRole || classifyMediaRole(candidate);
            candidate.isMaster = candidate.role === 'master';
            candidate.qualityHeight = inferCandidateHeight(candidate);
            candidate.bitrateKbps = inferCandidateBitrateKbps(candidate);
            candidate.quality = inferCandidateQuality(candidate);
            candidate.qualityBucket = candidateQualityBucket(candidate);
            candidate.qualityPreferenceRank = candidateQualityRank(
                candidate,
                state.sourcePreferences?.qualityOrder
            );
            candidate.sourceFamilyId = sourceFamilyFingerprint(candidate);
            candidate.sourceFamilyLabel = sourceFamilyLabel(candidate);
            candidate.purpose = classifyMediaPurpose(candidate);
            candidate.blocked = isBlockedCandidate(candidate);
            candidate.pageSnapshotKeys = Array.isArray(candidate.pageSnapshotKeys)
                ? candidate.pageSnapshotKeys.filter((key) => typeof key === 'string').slice(0, 16)
                : [];
            candidate.playerKeys = normalizePlayerKeyList(candidate.playerKeys);
            candidate.currentPlayerKeys = normalizePlayerKeyList(candidate.currentPlayerKeys)
                .filter((key) => candidate.playerKeys.includes(key));
            candidate.genericPrerollGuardUntil = Number.isFinite(candidate.genericPrerollGuardUntil)
                ? candidate.genericPrerollGuardUntil
                : 0;
            candidate.manifestParentShortCurrent = candidate.manifestDerived === true &&
                candidate.manifestParentShortCurrent === true;
            candidate.userPriority = normalizeSourcePriority(candidate.userPriority);
            candidate.elementKind = ['video', 'audio'].includes(candidate.elementKind)
                ? candidate.elementKind
                : '';
            candidate.playState = ['opening', 'playing', 'error'].includes(candidate.playState)
                ? candidate.playState
                : '';
            candidate.lastPlayErrorCode = candidate.playState === 'error' && typeof candidate.lastPlayErrorCode === 'string'
                ? normalizeErrorCode(candidate.lastPlayErrorCode, '')
                : '';
            candidate.lastPlayErrorAt = candidate.playState === 'error' && Number.isFinite(candidate.lastPlayErrorAt)
                ? candidate.lastPlayErrorAt
                : 0;
            candidate.lastPlayErrorUrlHash = candidate.playState === 'error' && typeof candidate.lastPlayErrorUrlHash === 'string'
                ? candidate.lastPlayErrorUrlHash.slice(0, 16)
                : '';
            updateCandidateFreshness(candidate);
            candidate.prerollProvisional = isGenericPrerollProvisional(candidate);
            candidate.score = scoreCandidate(candidate);
            if (candidate.purpose === 'advertisement') {
                candidate.blockedReason = 'Odrzucono reklamę wykrytą w odtwarzaczu strony.';
            } else if (candidate.purpose === 'utility') {
                candidate.blockedReason = 'Odrzucono techniczny plik pomocniczy odtwarzacza.';
            } else {
                delete candidate.blockedReason;
            }
            return candidate;
        }).filter(Boolean)
        : [];
    state.events = Array.isArray(state.events) ? state.events.slice(0, MAX_EVENTS) : [];
    state.status = state.status && typeof state.status === 'object' ? state.status : scanningStatus();
    const sourcePreferences = state.sourcePreferences && typeof state.sourcePreferences === 'object'
        ? state.sourcePreferences
        : {};
    state.sourcePreferences = {
        showFullUrls: sourcePreferences.showFullUrls === true,
        ruleCount: Number.isInteger(sourcePreferences.ruleCount) && sourcePreferences.ruleCount >= 0
            ? Math.min(sourcePreferences.ruleCount, MAX_SOURCE_PRIORITY_RULES)
            : 0,
        qualityOrder: normalizeQualityOrder(sourcePreferences.qualityOrder)
    };
    const resolver = state.resolver && typeof state.resolver === 'object' ? state.resolver : {};
    state.resolver = {
        state: ['idle', 'scheduled', 'resolving', 'found', 'empty', 'unavailable', 'failed'].includes(resolver.state)
            ? resolver.state
            : 'idle',
        adapter: ['tvp', 'youtube', 'generic'].includes(resolver.adapter) ? resolver.adapter : 'generic',
        resolver: ['streamlink', 'yt-dlp'].includes(resolver.resolver) ? resolver.resolver : null,
        attempted: Array.isArray(resolver.attempted)
            ? resolver.attempted.slice(0, 2).map(normalizeResolverAttempt).filter(Boolean)
            : [],
        resultCount: Number.isInteger(resolver.resultCount) && resolver.resultCount >= 0 ? resolver.resultCount : 0,
        cookiesUsed: resolver.cookiesUsed === true,
        truncated: resolver.truncated === true,
        source: ['manual', 'page_ready', 'refresh'].includes(resolver.source) ? resolver.source : null,
        materialScope: typeof resolver.materialScope === 'string' ? resolver.materialScope.slice(0, 160) : '',
        batchId: typeof resolver.batchId === 'string' ? resolver.batchId.slice(0, 160) : null,
        candidateIds: Array.isArray(resolver.candidateIds)
            ? resolver.candidateIds.filter((id) => typeof id === 'string').slice(0, MAX_RESOLVER_RESULTS)
            : [],
        pageReadyScope: typeof resolver.pageReadyScope === 'string' ? resolver.pageReadyScope.slice(0, 160) : '',
        pageReadyState: ['idle', 'scheduled', 'resolving', 'done'].includes(resolver.pageReadyState)
            ? resolver.pageReadyState
            : 'idle',
        errorCode: typeof resolver.errorCode === 'string' ? normalizeErrorCode(resolver.errorCode) : undefined,
        updatedAt: Number.isFinite(resolver.updatedAt) ? resolver.updatedAt : 0
    };
    state.auto = state.auto && typeof state.auto === 'object' ? state.auto : {};
    state.auto = {
        enabled: state.auto.enabled === true,
        pendingDueAt: Number.isFinite(state.auto.pendingDueAt) ? state.auto.pendingDueAt : null,
        cooldownUntil: Number.isFinite(state.auto.cooldownUntil) ? state.auto.cooldownUntil : 0,
        suppressUntil: Number.isFinite(state.auto.suppressUntil) ? state.auto.suppressUntil : 0,
        lastCandidateId: typeof state.auto.lastCandidateId === 'string' ? state.auto.lastCandidateId : null,
        lastFingerprint: typeof state.auto.lastFingerprint === 'string' ? state.auto.lastFingerprint : null,
        lastAttemptAt: Number.isFinite(state.auto.lastAttemptAt) ? state.auto.lastAttemptAt : 0,
        retryFingerprint: typeof state.auto.retryFingerprint === 'string' ? state.auto.retryFingerprint : null,
        retryCount: Number.isInteger(state.auto.retryCount) && state.auto.retryCount >= 0 ? state.auto.retryCount : 0
    };
    const expiryRefresh = state.expiryRefresh && typeof state.expiryRefresh === 'object'
        ? state.expiryRefresh
        : {};
    state.expiryRefresh = {
        fingerprint: typeof expiryRefresh.fingerprint === 'string'
            ? expiryRefresh.fingerprint.slice(0, 64)
            : '',
        attemptedAt: Number.isFinite(expiryRefresh.attemptedAt) ? expiryRefresh.attemptedAt : 0,
        attemptedFingerprints: Array.isArray(expiryRefresh.attemptedFingerprints)
            ? [...new Set(expiryRefresh.attemptedFingerprints.filter((item) =>
                typeof item === 'string' && /^[a-z0-9_]{1,64}$/i.test(item)
            ))].slice(-MAX_CANDIDATES)
            : (
                typeof expiryRefresh.fingerprint === 'string' &&
                expiryRefresh.fingerprint &&
                Number.isFinite(expiryRefresh.attemptedAt) && expiryRefresh.attemptedAt > 0
                    ? [expiryRefresh.fingerprint.slice(0, 64)]
                    : []
            ),
        inFlightFingerprint: typeof expiryRefresh.inFlightFingerprint === 'string'
            ? expiryRefresh.inFlightFingerprint.slice(0, 64)
            : '',
        inFlightUntil: Number.isFinite(expiryRefresh.inFlightUntil) ? expiryRefresh.inFlightUntil : 0,
        retryNotBefore: Number.isFinite(expiryRefresh.retryNotBefore) ? expiryRefresh.retryNotBefore : 0,
        pendingCandidateId: typeof expiryRefresh.pendingCandidateId === 'string'
            ? expiryRefresh.pendingCandidateId.slice(0, 160)
            : '',
        pendingUrlHash: typeof expiryRefresh.pendingUrlHash === 'string' && /^[a-z0-9]{1,16}$/i.test(expiryRefresh.pendingUrlHash)
            ? expiryRefresh.pendingUrlHash
            : '',
        pendingReason: typeof expiryRefresh.pendingReason === 'string'
            ? normalizeErrorCode(expiryRefresh.pendingReason, '')
            : '',
        pendingSince: Number.isFinite(expiryRefresh.pendingSince) ? expiryRefresh.pendingSince : 0,
        pendingRetryCount: Number.isInteger(expiryRefresh.pendingRetryCount) && expiryRefresh.pendingRetryCount >= 0
            ? expiryRefresh.pendingRetryCount
            : 0
    };
    return state;
}

function addEvent(state, kind, code, message, candidate = null, extra = {}) {
    const now = Date.now();
    const normalizedCode = normalizeErrorCode(code, 'EVENT');
    if (normalizedCode === 'MEDIA_DETECTED' && Array.isArray(state.events)) {
        const recentIndex = state.events.findIndex((item) =>
            item?.code === normalizedCode && Number.isFinite(item?.at) && now - item.at <= 1_500
        );
        if (recentIndex >= 0) {
            const recent = state.events.splice(recentIndex, 1)[0];
            const count = Math.min(999, (Number.isInteger(recent.count) ? recent.count : 1) + 1);
            recent.at = now;
            recent.count = count;
            recent.message = `Wykryto ${count} kandydatów do odtworzenia.`;
            delete recent.candidateId;
            delete recent.media;
            state.events.unshift(recent);
            return;
        }
    }
    const event = {
        id: `evt_${now.toString(36)}_${stableHash(`${kind}:${Math.random()}`)}`,
        at: now,
        kind,
        code: normalizedCode,
        message: sanitizePublicMessage(message, 'Zdarzenie bez opisu.')
    };
    if (normalizedCode === 'MEDIA_DETECTED') event.count = 1;
    if (candidate) {
        event.candidateId = candidate.id;
        event.media = redactMediaMetadata(candidate);
    }
    if (Number.isInteger(extra.statusCode)) event.statusCode = extra.statusCode;
    state.events.unshift(event);
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

function setStateStatus(state, nextState, code, message, candidate = null, extra = {}) {
    const nextCode = normalizeErrorCode(code, 'STATUS');
    const nextMessage = sanitizePublicMessage(message, 'Brak szczegółów.');
    const previous = state.status || {};
    state.status = statusRecord(nextState, nextCode, nextMessage, {
        ...(candidate ? { candidateId: candidate.id } : {}),
        ...extra
    });
    if (
        previous.state !== nextState ||
        previous.code !== nextCode ||
        previous.message !== nextMessage ||
        previous.candidateId !== state.status.candidateId
    ) {
        addEvent(state, 'status', nextCode, nextMessage, candidate);
    }
}

function compareCandidatesForRecommendation(left, right) {
    const blockedOrder = Number(isBlockedCandidate(left)) - Number(isBlockedCandidate(right));
    const diagnosticOrder = Number(left?.diagnosticOnly === true) - Number(right?.diagnosticOnly === true);
    const failedOrder = Number(isExplicitlyFailedCandidate(left)) - Number(isExplicitlyFailedCandidate(right));
    const leftRole = normalizeResolverRole(left?.resolverRole) || normalizeResolverRole(left?.role) || classifyMediaRole(left);
    const rightRole = normalizeResolverRole(right?.resolverRole) || normalizeResolverRole(right?.role) || classifyMediaRole(right);
    const audioOrder = Number(leftRole === 'audio') - Number(rightRole === 'audio');
    const incompleteOrder = Number(isExplicitlyIncompleteCandidate(left)) -
        Number(isExplicitlyIncompleteCandidate(right));
    const userPriorityOrder = normalizeSourcePriority(right?.userPriority) - normalizeSourcePriority(left?.userPriority);
    const provisionalOrder = Number(left?.prerollProvisional === true) - Number(right?.prerollProvisional === true);
    const fitnessOrder = candidatePlaybackFitnessTier(left) - candidatePlaybackFitnessTier(right);
    const recommendationTransportOrder = candidateRecommendationTransportTier(left) -
        candidateRecommendationTransportTier(right);
    const playlistTierOrder = candidatePlaylistTier(left) - candidatePlaylistTier(right);
    const qualityOrder = (
        Number.isInteger(left?.qualityPreferenceRank)
            ? left.qualityPreferenceRank
            : candidateQualityRank(left)
    ) - (
        Number.isInteger(right?.qualityPreferenceRank)
            ? right.qualityPreferenceRank
            : candidateQualityRank(right)
    );
    const heightOrder = inferCandidateHeight(right) - inferCandidateHeight(left);
    const mediaTransportOrder = candidateMediaTransportRank(left) - candidateMediaTransportRank(right);
    const languageOrder = (Number.isInteger(left?.preferredLanguageRank) ? left.preferredLanguageRank : MAX_PREFERRED_LANGUAGES) -
        (Number.isInteger(right?.preferredLanguageRank) ? right.preferredLanguageRank : MAX_PREFERRED_LANGUAGES);
    const pageEvidenceOrder = candidatePageEvidence(right) - candidatePageEvidence(left);
    const completenessOrder = candidateMediaCompleteness(right) - candidateMediaCompleteness(left);
    const bitrateOrder = inferCandidateBitrateKbps(right) - inferCandidateBitrateKbps(left);
    const masterOrder = Number(rightRole === 'master') - Number(leftRole === 'master');
    return blockedOrder ||
        diagnosticOrder ||
        failedOrder ||
        audioOrder ||
        incompleteOrder ||
        provisionalOrder ||
        fitnessOrder ||
        recommendationTransportOrder ||
        playlistTierOrder ||
        userPriorityOrder ||
        qualityOrder ||
        heightOrder ||
        (candidateTransportTier(left) - candidateTransportTier(right)) ||
        mediaTransportOrder ||
        languageOrder ||
        pageEvidenceOrder ||
        completenessOrder ||
        bitrateOrder ||
        masterOrder ||
        ((Number.isFinite(right?.score) ? right.score : 0) - (Number.isFinite(left?.score) ? left.score : 0)) ||
        ((Number.isFinite(right?.lastSeenAt) ? right.lastSeenAt : 0) - (Number.isFinite(left?.lastSeenAt) ? left.lastSeenAt : 0)) ||
        left.id.localeCompare(right.id);
}

function compareCandidates(left, right) {
    const blockedOrder = Number(isBlockedCandidate(left)) - Number(isBlockedCandidate(right));
    const diagnosticOrder = Number(left?.diagnosticOnly === true) - Number(right?.diagnosticOnly === true);
    const failedOrder = Number(isExplicitlyFailedCandidate(left)) - Number(isExplicitlyFailedCandidate(right));
    const leftRole = normalizeResolverRole(left?.resolverRole) || normalizeResolverRole(left?.role) || classifyMediaRole(left);
    const rightRole = normalizeResolverRole(right?.resolverRole) || normalizeResolverRole(right?.role) || classifyMediaRole(right);
    const audioOrder = Number(leftRole === 'audio') - Number(rightRole === 'audio');
    const incompleteOrder = Number(isExplicitlyIncompleteCandidate(left)) -
        Number(isExplicitlyIncompleteCandidate(right));
    const provisionalOrder = Number(left?.prerollProvisional === true) - Number(right?.prerollProvisional === true);
    const playlistTierOrder = candidatePlaylistTier(left) - candidatePlaylistTier(right);
    const userPriorityOrder = normalizeSourcePriority(right?.userPriority) - normalizeSourcePriority(left?.userPriority);
    const qualityOrder = (
        Number.isInteger(left?.qualityPreferenceRank)
            ? left.qualityPreferenceRank
            : candidateQualityRank(left)
    ) - (
        Number.isInteger(right?.qualityPreferenceRank)
            ? right.qualityPreferenceRank
            : candidateQualityRank(right)
    );
    const heightOrder = inferCandidateHeight(right) - inferCandidateHeight(left);
    const fitnessOrder = candidatePlaybackFitnessTier(left) - candidatePlaybackFitnessTier(right);
    const transportOrder = candidateTransportTier(left) - candidateTransportTier(right);
    const mediaTransportOrder = candidateMediaTransportRank(left) - candidateMediaTransportRank(right);
    const languageOrder = (Number.isInteger(left?.preferredLanguageRank) ? left.preferredLanguageRank : MAX_PREFERRED_LANGUAGES) -
        (Number.isInteger(right?.preferredLanguageRank) ? right.preferredLanguageRank : MAX_PREFERRED_LANGUAGES);
    const pageEvidenceOrder = candidatePageEvidence(right) - candidatePageEvidence(left);
    const completenessOrder = candidateMediaCompleteness(right) - candidateMediaCompleteness(left);
    const bitrateOrder = inferCandidateBitrateKbps(right) - inferCandidateBitrateKbps(left);
    const masterOrder = Number(rightRole === 'master') - Number(leftRole === 'master');
    return blockedOrder ||
        diagnosticOrder ||
        failedOrder ||
        audioOrder ||
        incompleteOrder ||
        provisionalOrder ||
        playlistTierOrder ||
        userPriorityOrder ||
        qualityOrder ||
        heightOrder ||
        fitnessOrder ||
        transportOrder ||
        mediaTransportOrder ||
        languageOrder ||
        pageEvidenceOrder ||
        completenessOrder ||
        bitrateOrder ||
        masterOrder ||
        ((Number.isFinite(right?.score) ? right.score : 0) - (Number.isFinite(left?.score) ? left.score : 0)) ||
        ((Number.isFinite(right?.lastSeenAt) ? right.lastSeenAt : 0) - (Number.isFinite(left?.lastSeenAt) ? left.lastSeenAt : 0)) ||
        left.id.localeCompare(right.id);
}

function compareCandidatesForRetention(left, right) {
    const blockedOrder = Number(isBlockedCandidate(left)) - Number(isBlockedCandidate(right));
    const diagnosticOrder = Number(left?.diagnosticOnly === true) - Number(right?.diagnosticOnly === true);
    const failedOrder = Number(isExplicitlyFailedCandidate(left)) - Number(isExplicitlyFailedCandidate(right));
    const leftRole = normalizeResolverRole(left?.resolverRole) || normalizeResolverRole(left?.role) || classifyMediaRole(left);
    const rightRole = normalizeResolverRole(right?.resolverRole) || normalizeResolverRole(right?.role) || classifyMediaRole(right);
    const audioOrder = Number(leftRole === 'audio') - Number(rightRole === 'audio');
    const incompleteOrder = Number(isExplicitlyIncompleteCandidate(left)) -
        Number(isExplicitlyIncompleteCandidate(right));
    // A page recipe is intentionally last in the visible playlist, but it can
    // be the only durable fallback after signed transports expire. Preserve it
    // when the bounded candidate set has to evict lower-value observations.
    const pageFallbackOrder = Number(right?.playbackKind === 'yt-dlp-page') -
        Number(left?.playbackKind === 'yt-dlp-page');
    const provisionalOrder = Number(left?.prerollProvisional === true) - Number(right?.prerollProvisional === true);
    const userPriorityOrder = normalizeSourcePriority(right?.userPriority) - normalizeSourcePriority(left?.userPriority);
    const pageEvidenceOrder = candidatePageEvidence(right) - candidatePageEvidence(left);
    const fitnessOrder = candidatePlaybackFitnessTier(left) - candidatePlaybackFitnessTier(right);
    const transportOrder = candidateTransportTier(left) - candidateTransportTier(right);
    const qualityOrder = (
        Number.isInteger(left?.qualityPreferenceRank)
            ? left.qualityPreferenceRank
            : candidateQualityRank(left)
    ) - (
        Number.isInteger(right?.qualityPreferenceRank)
            ? right.qualityPreferenceRank
            : candidateQualityRank(right)
    );
    const heightOrder = inferCandidateHeight(right) - inferCandidateHeight(left);
    return blockedOrder ||
        diagnosticOrder ||
        failedOrder ||
        audioOrder ||
        incompleteOrder ||
        pageFallbackOrder ||
        provisionalOrder ||
        userPriorityOrder ||
        fitnessOrder ||
        transportOrder ||
        qualityOrder ||
        heightOrder ||
        pageEvidenceOrder ||
        ((Number.isFinite(right?.lastSeenAt) ? right.lastSeenAt : 0) - (Number.isFinite(left?.lastSeenAt) ? left.lastSeenAt : 0)) ||
        ((Number.isFinite(right?.score) ? right.score : 0) - (Number.isFinite(left?.score) ? left.score : 0)) ||
        left.id.localeCompare(right.id);
}

function selectRecommendedCandidate(candidates) {
    if (!Array.isArray(candidates)) return null;
    return candidates
        .filter((candidate) => {
            const role = normalizeResolverRole(candidate?.resolverRole) ||
                normalizeResolverRole(candidate?.role) ||
                classifyMediaRole(candidate);
            return candidate &&
                candidate.diagnosticOnly !== true &&
                candidate.prerollProvisional !== true &&
                role !== 'audio' &&
                !isExplicitlyIncompleteCandidate(candidate) &&
                !isBlockedCandidate(candidate) &&
                !isExplicitlyFailedCandidate(candidate);
        })
        .sort(compareCandidatesForRecommendation)[0] || null;
}

function isSafeAlternativeCandidate(candidate, primary, now = Date.now()) {
    if (!candidate || !primary || !candidate.id || candidate.id === primary.id) return false;
    if (!candidate.groupKey || !primary.groupKey || candidate.groupKey === primary.groupKey) return false;
    const role = normalizeResolverRole(candidate.resolverRole) ||
        normalizeResolverRole(candidate.role) ||
        classifyMediaRole(candidate);
    return candidate.diagnosticOnly !== true &&
        candidate.prerollProvisional !== true &&
        candidate.superseded !== true &&
        candidate.drmProtected !== true &&
        role !== 'audio' &&
        !isExplicitlyIncompleteCandidate(candidate) &&
        candidatePlaybackFitnessTier(candidate) === 0 &&
        !isBlockedCandidate(candidate) &&
        !isExplicitlyFailedCandidate(candidate, now) &&
        !isCandidateExpired(candidate, now, MEDIA_EXPIRY_PLAY_GRACE_MS) &&
        candidate.playState !== 'error';
}

function selectAlternativeCandidate(candidates, primary, now = Date.now()) {
    if (!Array.isArray(candidates) || !primary) return null;
    return candidates
        .filter((candidate) => isSafeAlternativeCandidate(candidate, primary, now))
        .sort(compareCandidatesForRecommendation)[0] || null;
}

function trimCandidates(state) {
    const now = Date.now();
    state.candidates.forEach((candidate) => {
        updateCandidateFreshness(candidate, now);
        candidate.prerollProvisional = isGenericPrerollProvisional(candidate, now);
    });
    if (state.candidates.length > MAX_CANDIDATES) {
        const handledCandidate = (
            state.status?.state === 'playing' &&
            state.status?.confirmed === true
        ) ? state.candidates.find((candidate) =>
            candidate &&
            candidate.diagnosticOnly !== true &&
            !isBlockedCandidate(candidate) &&
            !isExplicitlyFailedCandidate(candidate) &&
            (
                (state.auto?.lastCandidateId && candidate.id === state.auto.lastCandidateId) ||
                (state.auto?.lastFingerprint && candidate.groupKey === state.auto.lastFingerprint)
            )
        ) || null : null;
        state.candidates.sort(compareCandidatesForRetention);
        if (handledCandidate && !state.candidates.slice(0, MAX_CANDIDATES).includes(handledCandidate)) {
            state.candidates = [
                ...state.candidates.slice(0, MAX_CANDIDATES - 1),
                handledCandidate
            ];
        } else {
            state.candidates.length = MAX_CANDIDATES;
        }
    }
    state.candidates.sort(compareCandidates);
    const recommended = selectRecommendedCandidate(state.candidates);
    state.candidates.forEach((candidate) => {
        candidate.recommended = candidate === recommended;
    });
}

function enqueueTabMutation(tabId, operation) {
    const previous = tabMutationQueues.get(tabId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    tabMutationQueues.set(tabId, current);
    return current.finally(() => {
        if (tabMutationQueues.get(tabId) === current) tabMutationQueues.delete(tabId);
    });
}

function enqueueTabPlay(tabId, operation) {
    const previous = tabPlayQueues.get(tabId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    tabPlayQueues.set(tabId, current);
    return current.finally(() => {
        if (tabPlayQueues.get(tabId) === current) tabPlayQueues.delete(tabId);
    });
}

function enqueueSettingsMutation(operation) {
    const current = settingsMutationQueue.catch(() => undefined).then(operation);
    settingsMutationQueue = current;
    return current;
}

async function loadTabState(tabId, hostname = '') {
    const key = tabStateKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const state = normalizeTabState(stored[key], tabId, hostname);
    if (state.navigationEpoch > currentTabEpoch(tabId)) tabEpochs.set(tabId, state.navigationEpoch);
    return state;
}

async function mutateTabState(tabId, hostname, mutator) {
    return enqueueTabMutation(tabId, async () => {
        if (removedTabs.has(tabId)) throw new WorkerError('TAB_CLOSED', 'Karta została zamknięta.');
        const state = await loadTabState(tabId, hostname);
        const result = await mutator(state);
        if (removedTabs.has(tabId)) throw new WorkerError('TAB_CLOSED', 'Karta została zamknięta.');
        state.updatedAt = Date.now();
        trimCandidates(state);
        await chrome.storage.session.set({ [tabStateKey(tabId)]: state });
        await updateBadge(state);
        syncExpiryRefreshAlarm(state);
        return { state, result };
    });
}

async function updateBadge(state) {
    try {
        const count = state.candidates.filter((candidate) =>
            candidate.diagnosticOnly !== true &&
            !isBlockedCandidate(candidate) &&
            !isExplicitlyFailedCandidate(candidate)
        ).length;
        await chrome.action.setBadgeText({ text: count ? String(count) : '', tabId: state.tabId });
        if (count) await chrome.action.setBadgeBackgroundColor({ color: '#ff8c00', tabId: state.tabId });
    } catch (_error) {
        // A tab can disappear between the state write and the badge update.
    }
}

async function resolveTabUrl(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        return typeof tab?.url === 'string' ? tab.url : '';
    } catch (_error) {
        return '';
    }
}

async function resolveTabHostname(tabId) {
    return normalizeHostname(await resolveTabUrl(tabId));
}

async function getCanonicalTabState(tabId) {
    const reservation = navigationReservations.get(tabId);
    const reservedPageUrl = typeof reservation?.url === 'string' ? reservation.url : '';
    const pageUrl = reservedPageUrl || await resolveTabUrl(tabId);
    const hostname = normalizeHostname(pageUrl);
    const trustedScope = materialScopeForUrl(pageUrl);
    return enqueueTabMutation(tabId, async () => {
        const state = await loadTabState(tabId, hostname);
        if (!hostname) {
            syncExpiryRefreshAlarm(state);
            return state;
        }
        const scopeMismatch = Boolean(
            trustedScope?.id &&
            state.materialScope?.id &&
            trustedScope.id !== state.materialScope.id
        );
        if ((state.hostname && state.hostname !== hostname) || scopeMismatch) {
            const resetEpoch = bumpTabEpoch(tabId);
            clearAutoTimer(tabId);
            clearPageReadyResolveTimer(tabId);
            clearPendingRequestsForTab(tabId);
            const [policy, sourcePreferences] = await Promise.all([
                readSiteAuto(hostname),
                readSiteSourcePreferences(hostname)
            ]);
            const reset = createTabState(tabId, hostname, resetEpoch, pageUrl);
            reset.auto.enabled = policy.enabled;
            applySourcePreferencesToState(reset, sourcePreferences);
            await chrome.storage.session.set({ [tabStateKey(tabId)]: reset });
            await updateBadge(reset);
            syncExpiryRefreshAlarm(reset);
            return reset;
        }
        const contextChanged = applyTrustedPageContext(state, pageUrl);
        const sourcePreferences = await readSiteSourcePreferences(hostname);
        const sourcePreferencesChanged = !stateMatchesSourcePreferences(state, sourcePreferences);
        if (sourcePreferencesChanged) applySourcePreferencesToState(state, sourcePreferences);
        // The generic preroll guard is time-based. Recompute the recommendation
        // even when no persisted setting or page identity changed, so a popup
        // opened after the guard expires does not keep a stale provisional rank.
        trimCandidates(state);
        syncExpiryRefreshAlarm(state);
        if (!contextChanged && !sourcePreferencesChanged) return state;
        if (contextChanged) {
            const policy = await readSiteAuto(hostname);
            state.auto.enabled = policy.enabled;
        }
        state.updatedAt = Date.now();
        trimCandidates(state);
        await chrome.storage.session.set({ [tabStateKey(tabId)]: state });
        await updateBadge(state);
        syncExpiryRefreshAlarm(state);
        return state;
    });
}

// ─── Local settings and privacy migration ──────────────────────────────────

function normalizeSiteSourcePreferenceRecord(value, hostname = '') {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawPriorities = record.priorities && typeof record.priorities === 'object' && !Array.isArray(record.priorities)
        ? record.priorities
        : {};
    const priorities = Object.fromEntries(Object.entries(rawPriorities)
        .filter(([fingerprint, priority]) =>
            /^(?:[a-z0-9]{1,8}_){3}[a-z0-9]{1,8}$/.test(fingerprint) && normalizeSourcePriority(priority) !== 0
        )
        .slice(-MAX_SOURCE_PRIORITY_RULES)
        .map(([fingerprint, priority]) => [fingerprint, normalizeSourcePriority(priority)]));
    return {
        hostname: normalizeHostname(hostname),
        showFullUrls: record.showFullUrls === true,
        priorities,
        ruleCount: Object.keys(priorities).length,
        qualityOrder: normalizeQualityOrder(record.qualityOrder),
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    };
}

function normalizeSiteSourcePreferenceMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value)
        .map(([hostname, record]) => {
            const normalizedHostname = normalizeHostname(hostname);
            if (!normalizedHostname || normalizedHostname !== hostname.toLowerCase()) return null;
            return [normalizedHostname, normalizeSiteSourcePreferenceRecord(record, normalizedHostname)];
        })
        .filter(Boolean)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, MAX_SOURCE_PREFERENCE_SITES);
    return Object.fromEntries(entries);
}

function publicSourcePreferences(policy) {
    return {
        hostname: normalizeHostname(policy?.hostname || ''),
        showFullUrls: policy?.showFullUrls === true,
        ruleCount: Number.isInteger(policy?.ruleCount) ? policy.ruleCount : 0,
        qualityOrder: normalizeQualityOrder(policy?.qualityOrder)
    };
}

function applySourcePreferencesToState(state, policy) {
    const stateHostname = normalizeHostname(state?.hostname || '');
    const policyHostname = normalizeHostname(policy?.hostname || '');
    if (policyHostname && stateHostname !== policyHostname) {
        return state?.sourcePreferences || publicSourcePreferences({});
    }
    const normalized = normalizeSiteSourcePreferenceRecord(policy, policyHostname || stateHostname);
    state.sourcePreferences = publicSourcePreferences(normalized);
    state.candidates.forEach((candidate) => {
        const familyFingerprint = sourceFamilyFingerprint(candidate);
        const legacyFingerprint = sourcePreferenceFingerprint(candidate);
        candidate.sourceFamilyId = familyFingerprint;
        candidate.sourceFamilyLabel = sourceFamilyLabel(candidate);
        candidate.userPriority = normalizeSourcePriority(
            (familyFingerprint && normalized.priorities[familyFingerprint]) ||
            (legacyFingerprint && normalized.priorities[legacyFingerprint])
        );
        candidate.qualityHeight = inferCandidateHeight(candidate);
        candidate.bitrateKbps = inferCandidateBitrateKbps(candidate);
        candidate.quality = inferCandidateQuality(candidate);
        candidate.qualityBucket = candidateQualityBucket(candidate);
        candidate.qualityPreferenceRank = candidateQualityRank(candidate, normalized.qualityOrder);
    });
    return state.sourcePreferences;
}

function stateMatchesSourcePreferences(state, policy) {
    const stateHostname = normalizeHostname(state?.hostname || '');
    const policyHostname = normalizeHostname(policy?.hostname || '');
    if (policyHostname && stateHostname !== policyHostname) return false;
    const normalized = normalizeSiteSourcePreferenceRecord(policy, policyHostname || stateHostname);
    const current = state?.sourcePreferences || {};
    if (
        current.showFullUrls !== normalized.showFullUrls ||
        current.ruleCount !== normalized.ruleCount ||
        JSON.stringify(normalizeQualityOrder(current.qualityOrder)) !== JSON.stringify(normalized.qualityOrder)
    ) return false;
    return (state?.candidates || []).every((candidate) => {
        const familyFingerprint = sourceFamilyFingerprint(candidate);
        const legacyFingerprint = sourcePreferenceFingerprint(candidate);
        const expected = normalizeSourcePriority(
            (familyFingerprint && normalized.priorities[familyFingerprint]) ||
            (legacyFingerprint && normalized.priorities[legacyFingerprint])
        );
        return normalizeSourcePriority(candidate.userPriority) === expected &&
            candidateQualityRank(candidate, normalized.qualityOrder) === candidate.qualityPreferenceRank;
    });
}

async function readSiteSourcePreferences(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return normalizeSiteSourcePreferenceRecord({}, '');
    const stored = await chrome.storage.local.get({ [SITE_SOURCE_PREFERENCES_KEY]: {} });
    const siteMap = normalizeSiteSourcePreferenceMap(stored[SITE_SOURCE_PREFERENCES_KEY]);
    return normalizeSiteSourcePreferenceRecord(siteMap[normalized], normalized);
}

async function mutateSiteSourcePreferences(hostname, updater) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) throw new WorkerError('INVALID_HOSTNAME', 'Nie podano poprawnej domeny witryny.');
    return enqueueSettingsMutation(async () => {
        const stored = await chrome.storage.local.get({ [SITE_SOURCE_PREFERENCES_KEY]: {} });
        const siteMap = normalizeSiteSourcePreferenceMap(stored[SITE_SOURCE_PREFERENCES_KEY]);
        const current = normalizeSiteSourcePreferenceRecord(siteMap[normalized], normalized);
        const updated = normalizeSiteSourcePreferenceRecord(await updater(current), normalized);
        updated.updatedAt = Date.now();
        const usesDefaultQualityOrder = JSON.stringify(updated.qualityOrder) === JSON.stringify(DEFAULT_QUALITY_ORDER);
        if (!updated.showFullUrls && updated.ruleCount === 0 && usesDefaultQualityOrder) delete siteMap[normalized];
        else Object.defineProperty(siteMap, normalized, {
            value: updated,
            enumerable: true,
            configurable: true,
            writable: true
        });
        const boundedMap = normalizeSiteSourcePreferenceMap(siteMap);
        const affectedHostnames = [...new Set([
            normalized,
            ...Object.keys(siteMap).filter((siteHostname) =>
                !Object.prototype.hasOwnProperty.call(boundedMap, siteHostname)
            )
        ])];
        await chrome.storage.local.set({ [SITE_SOURCE_PREFERENCES_KEY]: boundedMap });
        return {
            policy: normalizeSiteSourcePreferenceRecord(boundedMap[normalized], normalized),
            affectedHostnames
        };
    });
}

async function syncSourcePreferencesForOpenTabs(hostnames) {
    const targetHostnames = [...new Set((Array.isArray(hostnames) ? hostnames : [hostnames])
        .map((hostname) => normalizeHostname(hostname))
        .filter(Boolean))];
    if (!targetHostnames.length) return new Map();
    const local = await chrome.storage.local.get({ [SITE_SOURCE_PREFERENCES_KEY]: {} });
    const siteMap = normalizeSiteSourcePreferenceMap(local[SITE_SOURCE_PREFERENCES_KEY]);
    const policies = new Map(targetHostnames.map((hostname) => [
        hostname,
        normalizeSiteSourcePreferenceRecord(siteMap[hostname], hostname)
    ]));
    const stored = await chrome.storage.session.get(null);
    const entries = Object.entries(stored).filter(([key, value]) =>
        key.startsWith(TAB_STATE_PREFIX) && policies.has(value?.hostname) && Number.isInteger(value?.tabId)
    );
    const states = new Map();
    await Promise.allSettled(entries.map(async ([, value]) => {
        const expectedHostname = value.hostname;
        const mutation = await mutateTabState(value.tabId, expectedHostname, async (state) => {
            const currentHostname = await resolveTabHostname(value.tabId);
            if (state.hostname !== expectedHostname || currentHostname !== expectedHostname) {
                return { applied: false };
            }
            const policy = policies.get(expectedHostname);
            applySourcePreferencesToState(state, policy);
            return { applied: true };
        });
        if (mutation.result?.applied) states.set(value.tabId, mutation.state);
    }));
    return states;
}

async function setCandidatePriority(tabId, candidateId, priorityName) {
    const priority = normalizeSourcePriority(priorityName);
    if (!['preferred', 'normal', 'deprioritized'].includes(priorityName)) {
        throw new WorkerError('INVALID_SETTING', 'Wybrano niepoprawny poziom priorytetu źródła.');
    }
    const state = await getCanonicalTabState(tabId);
    const candidate = state.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new WorkerError('CANDIDATE_NOT_FOUND', 'Wybrane źródło nie jest już dostępne. Odśwież listę.');
    if (candidate.diagnosticOnly === true || isBlockedCandidate(candidate)) {
        throw new WorkerError('SOURCE_PREFERENCE_BLOCKED', 'Nie można preferować reklamy ani technicznego źródła diagnostycznego.');
    }
    const familyFingerprint = sourceFamilyFingerprint(candidate);
    const legacyFingerprint = sourcePreferenceFingerprint(candidate);
    if (!familyFingerprint) throw new WorkerError('INVALID_MEDIA_URL', 'Źródło nie ma poprawnego adresu HTTP lub HTTPS.');
    const preferenceMutation = await mutateSiteSourcePreferences(state.hostname, (current) => {
        const priorities = { ...current.priorities };
        delete priorities[familyFingerprint];
        if (legacyFingerprint) delete priorities[legacyFingerprint];
        if (priority !== 0) priorities[familyFingerprint] = priority;
        return { ...current, priorities };
    });
    await syncSourcePreferencesForOpenTabs(preferenceMutation.affectedHostnames);
    const updatedState = await getCanonicalTabState(tabId);
    const responsePolicy = updatedState.hostname === preferenceMutation.policy.hostname
        ? preferenceMutation.policy
        : await readSiteSourcePreferences(updatedState.hostname);
    return { policy: publicSourcePreferences(responsePolicy), state: updatedState };
}

async function setQualityOrder(tabId, requestedOrder) {
    if (!Array.isArray(requestedOrder) ||
        requestedOrder.length !== DEFAULT_QUALITY_ORDER.length ||
        requestedOrder.some((item) => typeof item !== 'string') ||
        new Set(requestedOrder.map((item) => item.toLowerCase())).size !== DEFAULT_QUALITY_ORDER.length ||
        requestedOrder.some((item) => !QUALITY_ORDER_SET.has(item.toLowerCase()))) {
        throw new WorkerError('INVALID_SETTING', 'Kolejność jakości musi zawierać każdy obsługiwany poziom dokładnie raz.');
    }
    const state = await getCanonicalTabState(tabId);
    if (!state.hostname) throw new WorkerError('INVALID_HOSTNAME', 'Bieżąca karta nie ma zwykłej domeny HTTP lub HTTPS.');
    const qualityOrder = normalizeQualityOrder(requestedOrder);
    const preferenceMutation = await mutateSiteSourcePreferences(state.hostname, (current) => ({
        ...current,
        qualityOrder
    }));
    await syncSourcePreferencesForOpenTabs(preferenceMutation.affectedHostnames);
    const updatedState = await getCanonicalTabState(tabId);
    const responsePolicy = updatedState.hostname === preferenceMutation.policy.hostname
        ? preferenceMutation.policy
        : await readSiteSourcePreferences(updatedState.hostname);
    return { policy: publicSourcePreferences(responsePolicy), state: updatedState };
}

async function setSourceUrlVisibility(tabId, visible) {
    const pageUrl = await resolveTabUrl(tabId);
    const hostname = normalizeHostname(pageUrl);
    if (!hostname) throw new WorkerError('INVALID_HOSTNAME', 'Bieżąca karta nie ma zwykłej domeny HTTP lub HTTPS.');
    const preferenceMutation = await mutateSiteSourcePreferences(hostname, (current) => ({
        ...current,
        showFullUrls: visible === true
    }));
    await syncSourcePreferencesForOpenTabs(preferenceMutation.affectedHostnames);
    const updatedState = await getCanonicalTabState(tabId);
    const responsePolicy = updatedState.hostname === preferenceMutation.policy.hostname
        ? preferenceMutation.policy
        : await readSiteSourcePreferences(updatedState.hostname);
    return { policy: publicSourcePreferences(responsePolicy), state: updatedState };
}

async function migrateLegacyLocalStorage() {
    return enqueueSettingsMutation(async () => {
        const all = await chrome.storage.local.get(null);
        const updates = {};
        const siteMap = all[SITE_AUTO_KEY];
        if (!siteMap || typeof siteMap !== 'object' || Array.isArray(siteMap)) updates[SITE_AUTO_KEY] = {};
        const resolverCookieSites = all[RESOLVER_COOKIE_SITES_KEY];
        if (!resolverCookieSites || typeof resolverCookieSites !== 'object' || Array.isArray(resolverCookieSites)) {
            updates[RESOLVER_COOKIE_SITES_KEY] = {};
        }
        const sourcePreferences = all[SITE_SOURCE_PREFERENCES_KEY];
        if (!sourcePreferences || typeof sourcePreferences !== 'object' || Array.isArray(sourcePreferences)) {
            updates[SITE_SOURCE_PREFERENCES_KEY] = {};
        } else {
            const normalizedSourcePreferences = normalizeSiteSourcePreferenceMap(sourcePreferences);
            if (JSON.stringify(sourcePreferences) !== JSON.stringify(normalizedSourcePreferences)) {
                updates[SITE_SOURCE_PREFERENCES_KEY] = normalizedSourcePreferences;
            }
        }

        if (!ALLOWED_PLAY_MODES.has(all[DEFAULT_MODE_KEY])) {
            updates[DEFAULT_MODE_KEY] = all.queueToExistingMpv === true ? 'append' : 'new';
        }
        if (all.autoLaunchMpv === true) updates[LEGACY_MIGRATION_KEY] = true;
        if (typeof all[LEGACY_MIGRATION_KEY] !== 'boolean' && all.autoLaunchMpv !== true) {
            updates[LEGACY_MIGRATION_KEY] = false;
        }

        if (Object.keys(updates).length) await chrome.storage.local.set(updates);
        const legacyKeys = Object.keys(all).filter(isLegacyLocalKey);
        if (legacyKeys.length) await chrome.storage.local.remove(legacyKeys);
    });
}

async function readSettings() {
    const stored = await chrome.storage.local.get({
        [SITE_AUTO_KEY]: {},
        [SITE_SOURCE_PREFERENCES_KEY]: {},
        [RESOLVER_COOKIE_SITES_KEY]: {},
        [DEFAULT_MODE_KEY]: 'new',
        [LEGACY_MIGRATION_KEY]: false
    });
    const siteAutoLaunch = stored[SITE_AUTO_KEY] && typeof stored[SITE_AUTO_KEY] === 'object' && !Array.isArray(stored[SITE_AUTO_KEY])
        ? stored[SITE_AUTO_KEY]
        : {};
    const resolverCookieSites = stored[RESOLVER_COOKIE_SITES_KEY] && typeof stored[RESOLVER_COOKIE_SITES_KEY] === 'object' && !Array.isArray(stored[RESOLVER_COOKIE_SITES_KEY])
        ? stored[RESOLVER_COOKIE_SITES_KEY]
        : {};
    const siteSourcePreferences = normalizeSiteSourcePreferenceMap(stored[SITE_SOURCE_PREFERENCES_KEY]);
    return {
        siteAutoLaunch,
        siteSourcePreferences,
        resolverCookieSites,
        defaultPlayMode: normalizePlayMode(stored[DEFAULT_MODE_KEY]),
        migrationPending: stored[LEGACY_MIGRATION_KEY] === true
    };
}

async function readSiteAuto(hostname) {
    const normalized = normalizeHostname(hostname);
    const settings = await readSettings();
    const explicit = Boolean(normalized) && Object.prototype.hasOwnProperty.call(settings.siteAutoLaunch, normalized);
    return {
        hostname: normalized,
        enabled: explicit && settings.siteAutoLaunch[normalized] === true,
        explicit,
        migrationAvailable: settings.migrationPending && !explicit,
        defaultPlayMode: settings.defaultPlayMode
    };
}

async function writeSiteAuto(hostname, enabled) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) throw new WorkerError('INVALID_HOSTNAME', 'Nie podano poprawnej domeny witryny.');
    return enqueueSettingsMutation(async () => {
        const stored = await chrome.storage.local.get({ [SITE_AUTO_KEY]: {} });
        const current = stored[SITE_AUTO_KEY];
        const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
        next[normalized] = enabled === true;
        await chrome.storage.local.set({
            [SITE_AUTO_KEY]: next,
            [LEGACY_MIGRATION_KEY]: false
        });
        return readSiteAuto(normalized);
    });
}

async function readResolverCookiePolicy(pageUrl) {
    const parsed = parseHttpUrl(pageUrl);
    const hostname = parsed?.hostname?.toLowerCase() || '';
    const settings = await readSettings();
    return {
        hostname,
        enabled: Boolean(hostname) && parsed?.protocol === 'https:' && settings.resolverCookieSites[hostname] === true,
        httpsEligible: parsed?.protocol === 'https:',
        enabledSiteCount: Object.values(settings.resolverCookieSites).filter((value) => value === true).length
    };
}

async function writeResolverCookiePolicy(pageUrl, enabled) {
    const parsed = parseHttpUrl(pageUrl);
    if (!parsed) throw new WorkerError('INVALID_PAGE_URL', 'Bieżąca karta nie ma poprawnego adresu HTTP lub HTTPS.');
    if (enabled && parsed.protocol !== 'https:') {
        throw new WorkerError('COOKIES_REQUIRE_HTTPS', 'Cookies resolvera można włączyć tylko dla strony HTTPS.');
    }
    const hostname = parsed.hostname.toLowerCase();
    return enqueueSettingsMutation(async () => {
        const stored = await chrome.storage.local.get({ [RESOLVER_COOKIE_SITES_KEY]: {} });
        const current = stored[RESOLVER_COOKIE_SITES_KEY];
        const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
        if (enabled === true) next[hostname] = true;
        else delete next[hostname];
        await chrome.storage.local.set({ [RESOLVER_COOKIE_SITES_KEY]: next });
        return {
            hostname,
            enabled: next[hostname] === true,
            httpsEligible: parsed.protocol === 'https:',
            enabledSiteCount: Object.values(next).filter((value) => value === true).length
        };
    });
}

function resolverCookieRecord(rawCookie) {
    if (!rawCookie || typeof rawCookie !== 'object') {
        throw new WorkerError('COOKIE_DATA_INVALID', 'Chrome zwrócił niepoprawny rekord cookie.');
    }
    const name = typeof rawCookie.name === 'string' ? rawCookie.name : '';
    const value = typeof rawCookie.value === 'string' ? rawCookie.value : '';
    const domain = typeof rawCookie.domain === 'string' ? rawCookie.domain : '';
    const path = typeof rawCookie.path === 'string' ? rawCookie.path : '';
    if (
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(name) ||
        value.length > 4096 || /[\t\r\n\0]/.test(value) ||
        !domain || domain.length > 254 || /[\t\r\n\0]/.test(domain) ||
        !path.startsWith('/') || path.length > 2048 || /[\x00-\x1f\x7f]/.test(path)
    ) {
        throw new WorkerError('COOKIE_DATA_INVALID', 'Cookie domeny nie spełnia bezpiecznego formatu resolvera.');
    }
    return {
        name,
        value,
        domain,
        path,
        secure: rawCookie.secure === true,
        httpOnly: rawCookie.httpOnly === true,
        hostOnly: rawCookie.hostOnly === true,
        expires: Number.isFinite(rawCookie.expirationDate) && rawCookie.expirationDate > 0
            ? Math.floor(rawCookie.expirationDate)
            : 0
    };
}

function getChromeCookiesForUrl(pageUrl) {
    return new Promise((resolve, reject) => {
        if (!chrome.cookies?.getAll) {
            reject(new WorkerError('COOKIE_PERMISSION_MISSING', 'Chrome nie udostępnił uprawnienia cookies dla resolvera.'));
            return;
        }
        chrome.cookies.getAll({ url: pageUrl }, (cookies) => {
            const runtimeMessage = chrome.runtime.lastError?.message || '';
            if (runtimeMessage) {
                reject(new WorkerError('COOKIE_PERMISSION_MISSING', 'Chrome nie udostępnił cookies bieżącej domeny. Włącz zgodę ponownie.'));
                return;
            }
            resolve(Array.isArray(cookies) ? cookies : []);
        });
    });
}

async function collectResolverCookies(tabId, pageUrl, navigationEpoch, cookieUrl = pageUrl) {
    const policy = await readResolverCookiePolicy(pageUrl);
    if (!policy.enabled) return [];
    const policyPage = parseHttpUrl(pageUrl);
    const cookiePage = parseHttpUrl(cookieUrl);
    if (!policyPage || !cookiePage || policyPage.hostname !== cookiePage.hostname || cookiePage.protocol !== 'https:') {
        throw new WorkerError('COOKIE_DATA_INVALID', 'Docelowy materiał nie należy do domeny objętej zgodą cookies.');
    }
    const records = (await getChromeCookiesForUrl(cookiePage.href)).map(resolverCookieRecord);
    if (records.length > MAX_RESOLVER_COOKIES) {
        throw new WorkerError('COOKIE_BUDGET_EXCEEDED', `Domena ma więcej niż ${MAX_RESOLVER_COOKIES} pasujących cookies.`);
    }
    const encodedBytes = new TextEncoder().encode(JSON.stringify(records)).byteLength;
    if (encodedBytes > MAX_RESOLVER_COOKIE_BYTES) {
        throw new WorkerError('COOKIE_BUDGET_EXCEEDED', 'Cookies bieżącej domeny przekraczają bezpieczny limit 16 KiB.');
    }
    const currentUrl = await resolveTabUrl(tabId);
    if (
        navigationEpoch !== currentTabEpoch(tabId) ||
        pageNavigationIdentity(currentUrl) !== pageNavigationIdentity(pageUrl)
    ) {
        throw new WorkerError('STALE_TAB_SESSION', 'Karta zmieniła stronę podczas odczytu cookies.');
    }
    return records;
}

function readPreferredLanguages() {
    return new Promise((resolve) => {
        if (!chrome.i18n?.getAcceptLanguages) {
            resolve([]);
            return;
        }
        let settled = false;
        const finish = (values) => {
            if (settled) return;
            settled = true;
            resolve(normalizePreferredLanguages(values));
        };
        const timer = setTimeout(() => finish([]), 1_000);
        try {
            chrome.i18n.getAcceptLanguages((languages) => {
                clearTimeout(timer);
                if (chrome.runtime.lastError) finish([]);
                else finish(languages);
            });
        } catch (_error) {
            clearTimeout(timer);
            finish([]);
        }
    });
}

// ─── Network correlation and candidate updates ──────────────────────────────

function extractObservedHeaders(headers) {
    const result = {};
    if (!Array.isArray(headers)) return result;
    for (const header of headers) {
        const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
        if (!OBSERVED_REQUEST_HEADERS.has(name) || typeof header.value !== 'string' || !header.value) continue;
        if (name === 'referer') result.referer = header.value;
        else if (name === 'origin') result.origin = header.value;
        else if (name === 'user-agent') result.userAgent = header.value;
    }
    return result;
}

function responseContentType(headers) {
    if (!Array.isArray(headers)) return '';
    const header = headers.find((item) => typeof item?.name === 'string' && item.name.toLowerCase() === 'content-type');
    return normalizeContentType(header?.value || '');
}

function prunePendingRequests(now = Date.now()) {
    for (const [requestId, request] of pendingRequests) {
        if (request.expiresAt <= now) pendingRequests.delete(requestId);
    }
    while (pendingRequests.size > MAX_PENDING_REQUESTS) {
        const oldest = pendingRequests.keys().next().value;
        if (oldest === undefined) break;
        pendingRequests.delete(oldest);
    }
}

function rememberRequest(details, patch = {}, resetStart = false) {
    if (!details || details.tabId < 0 || typeof details.requestId !== 'string') return null;
    const now = Date.now();
    prunePendingRequests(now);
    const previous = resetStart ? {} : (pendingRequests.get(details.requestId) || {});
    const reservedHostname = navigationReservations.get(details.tabId)?.hostname || '';
    const next = {
        ...previous,
        tabId: details.tabId,
        url: details.url || previous.url || '',
        resourceType: details.type || previous.resourceType || '',
        requestStartedAt: Number.isFinite(previous.requestStartedAt)
            ? previous.requestStartedAt
            : (Number.isFinite(details.timeStamp) ? details.timeStamp : now),
        tabEpoch: Number.isInteger(previous.tabEpoch) ? previous.tabEpoch : currentTabEpoch(details.tabId),
        pageHostname: normalizeHostname(previous.pageHostname || reservedHostname || (details.type === 'main_frame' ? details.url : '')),
        expiresAt: now + REQUEST_CONTEXT_TTL_MS,
        ...patch
    };
    pendingRequests.delete(details.requestId);
    pendingRequests.set(details.requestId, next);
    prunePendingRequests(now);
    return next;
}

function persistedRequestContextKey(tabId, requestId) {
    return `${REQUEST_CONTEXT_SESSION_PREFIX}${tabId}_${stableHash(requestId)}_${stableHash(`v2:${requestId}`)}`;
}

function enqueueRequestContextStorage(operation) {
    const current = requestContextStorageQueue.catch(() => undefined).then(operation);
    requestContextStorageQueue = current;
    return current;
}

function shouldPersistRequestContext(details, context) {
    if (!details || !context) return false;
    if (!context.referer && !context.origin && !context.userAgent) return false;
    if (['main_frame', 'sub_frame', 'media'].includes(details.type)) return true;
    const parsed = parseHttpUrl(details.url);
    if (!parsed) return false;
    return /(?:stream|video|media|manifest|playlist|playback|source|live|hls|dash|master|index)/i.test(parsed.pathname);
}

function persistedRequestContextPayload(context, now = Date.now()) {
    const payload = {
        tabId: context.tabId,
        tabEpoch: Number.isInteger(context.tabEpoch) ? context.tabEpoch : 0,
        pageHostname: normalizeHostname(context.pageHostname || ''),
        requestStartedAt: Number.isFinite(context.requestStartedAt) ? context.requestStartedAt : now,
        observedAt: now,
        expiresAt: now + PERSISTED_REQUEST_CONTEXT_TTL_MS
    };
    if (typeof context.referer === 'string' && context.referer) payload.referer = context.referer;
    if (typeof context.origin === 'string' && context.origin) payload.origin = context.origin;
    if (typeof context.userAgent === 'string' && context.userAgent) payload.userAgent = context.userAgent;
    return payload;
}

function validPersistedRequestContext(value, tabId, now = Date.now()) {
    return Boolean(
        value &&
        value.tabId === tabId &&
        Number.isInteger(value.tabEpoch) &&
        Number.isFinite(value.requestStartedAt) &&
        Number.isFinite(value.observedAt) &&
        Number.isFinite(value.expiresAt) &&
        value.expiresAt > now
    );
}

async function prunePersistedRequestContextsUnlocked(now = Date.now()) {
    const stored = await chrome.storage.session.get(null);
    const entries = Object.entries(stored)
        .filter(([key]) => key.startsWith(REQUEST_CONTEXT_SESSION_PREFIX))
        .sort((left, right) => (right[1]?.observedAt || 0) - (left[1]?.observedAt || 0));
    const staleKeys = entries
        .filter(([, value], index) =>
            index >= MAX_PERSISTED_REQUEST_CONTEXTS ||
            !Number.isFinite(value?.expiresAt) ||
            value.expiresAt <= now
        )
        .map(([key]) => key);
    if (staleKeys.length) await chrome.storage.session.remove(staleKeys);
}

function persistRequestContext(details, context) {
    if (!shouldPersistRequestContext(details, context)) return Promise.resolve();
    const key = persistedRequestContextKey(details.tabId, details.requestId);
    const payload = persistedRequestContextPayload(context);
    return enqueueRequestContextStorage(async () => {
        await chrome.storage.session.set({ [key]: payload });
        await prunePersistedRequestContextsUnlocked();
    });
}

function loadPersistedRequestContext(details) {
    if (!details || details.tabId < 0 || typeof details.requestId !== 'string') return Promise.resolve(null);
    const key = persistedRequestContextKey(details.tabId, details.requestId);
    return enqueueRequestContextStorage(async () => {
        const now = Date.now();
        const stored = await chrome.storage.session.get(null);
        const value = stored[key];
        const contexts = Object.entries(stored).filter(([storedKey, context]) =>
            storedKey.startsWith(REQUEST_CONTEXT_SESSION_PREFIX) &&
            context?.tabId === details.tabId
        );
        const validContexts = contexts.filter(([, context]) =>
            validPersistedRequestContext(context, details.tabId, now)
        );
        const stateEpoch = Number.isInteger(stored[tabStateKey(details.tabId)]?.navigationEpoch)
            ? stored[tabStateKey(details.tabId)].navigationEpoch
            : 0;
        const contextEpoch = validContexts.reduce(
            (maximum, [, context]) => Math.max(maximum, context.tabEpoch),
            0
        );
        const authoritativeEpoch = Math.max(currentTabEpoch(details.tabId), stateEpoch, contextEpoch);
        if (authoritativeEpoch > currentTabEpoch(details.tabId)) {
            tabEpochs.set(details.tabId, authoritativeEpoch);
        }

        const staleKeys = contexts
            .filter(([, context]) =>
                !validPersistedRequestContext(context, details.tabId, now) ||
                context.tabEpoch < authoritativeEpoch
            )
            .map(([storedKey]) => storedKey);
        if (staleKeys.length) await chrome.storage.session.remove(staleKeys);

        if (!validPersistedRequestContext(value, details.tabId, now)) return null;
        if (value.tabEpoch !== authoritativeEpoch) return { ...value, stale: true };
        return value;
    });
}

function forgetPersistedRequestContext(details) {
    if (!details || details.tabId < 0 || typeof details.requestId !== 'string') return Promise.resolve();
    const key = persistedRequestContextKey(details.tabId, details.requestId);
    return enqueueRequestContextStorage(() => chrome.storage.session.remove(key));
}

function removePersistedRequestContextsForTab(tabId) {
    return enqueueRequestContextStorage(async () => {
        const stored = await chrome.storage.session.get(null);
        const keys = Object.entries(stored)
            .filter(([key, value]) => key.startsWith(REQUEST_CONTEXT_SESSION_PREFIX) && value?.tabId === tabId)
            .map(([key]) => key);
        if (keys.length) await chrome.storage.session.remove(keys);
    });
}

function prunePersistedRequestContexts() {
    return enqueueRequestContextStorage(() => prunePersistedRequestContextsUnlocked());
}

function mergePersistedRequestContext(context, persisted) {
    if (!persisted || context.headersObserved) return context;
    return {
        ...context,
        tabEpoch: persisted.tabEpoch,
        pageHostname: persisted.pageHostname || context.pageHostname,
        requestStartedAt: persisted.requestStartedAt,
        referer: persisted.referer,
        origin: persisted.origin,
        userAgent: persisted.userAgent
    };
}

function mediaObservationFrom(details, mediaType, source, context = {}, extra = {}) {
    return {
        url: details.url || context.url || '',
        mediaType,
        source,
        resourceType: details.type || context.resourceType || '',
        requestId: details.requestId || '',
        requestStartedAt: Number.isFinite(context.requestStartedAt)
            ? context.requestStartedAt
            : (Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now()),
        tabEpoch: Number.isInteger(context.tabEpoch) ? context.tabEpoch : currentTabEpoch(details.tabId),
        contentType: extra.contentType || '',
        statusCode: Number.isInteger(details.statusCode) ? details.statusCode : undefined,
        referer: context.referer,
        origin: context.origin,
        userAgent: context.userAgent,
        clearHeaders: extra.clearHeaders === true,
        networkError: extra.networkError || '',
        pageHostname: details.type === 'main_frame'
            ? normalizeHostname(details.url)
            : normalizeHostname(context.pageHostname || '')
    };
}

function pageRenditionIdentity(observation) {
    if (!observation || candidateSourceMethod(observation.source) !== 'page') return '';
    const explicitHeight = (
        Number.isInteger(observation.height) && observation.height >= 100 && observation.height <= 8640
    ) ? observation.height : qualityHeightFromText(observation.quality || '', { allowBare: true });
    const explicitBitrate = Number.isFinite(observation.bitrateKbps) && observation.bitrateKbps >= 16
        ? Math.min(Math.round(observation.bitrateKbps), 250_000)
        : (Number.isFinite(observation.bandwidth) && observation.bandwidth >= 16_000
            ? Math.min(Math.round(observation.bandwidth / 1000), 250_000)
            : 0);
    const language = normalizeLanguageTag(observation.language);
    if (!explicitHeight && !explicitBitrate && !language) return '';
    const width = Number.isInteger(observation.width) && observation.width > 0
        ? Math.min(observation.width, 32_768)
        : 0;
    const kind = ['video', 'audio'].includes(observation.elementKind) ? observation.elementKind : '';
    return `${kind || 'media'}:${width}:${explicitHeight || 0}:${explicitBitrate}:${language}`;
}

function mediaObservationGroupKey(observation) {
    const canonicalGroupKey = canonicalizeMediaUrl(observation?.url || '');
    if (!canonicalGroupKey) return '';
    const sourceMethod = candidateSourceMethod(observation?.source);
    if (sourceMethod === 'manifest') {
        const role = normalizeResolverRole(observation.role) || 'variant';
        const height = inferCandidateHeight(observation);
        const bitrate = inferCandidateBitrateKbps(observation);
        const identity = typeof observation.manifestIdentity === 'string'
            ? stableHash(observation.manifestIdentity.slice(0, 1024))
            : '';
        return `${canonicalGroupKey}|manifest:${role}:${height || 0}:${bitrate || 0}:${identity}`;
    }
    const pageIdentity = pageRenditionIdentity(observation);
    return pageIdentity
        ? `${canonicalGroupKey}|page:${stableHash(pageIdentity)}`
        : canonicalGroupKey;
}

function mergeMediaObservationIntoState(state, observation, now = Date.now()) {
    const sourceMethod = candidateSourceMethod(observation.source);
    const resolverObservation = sourceMethod === 'streamlink' || sourceMethod === 'yt-dlp';
    const manifestObservation = sourceMethod === 'manifest';
    const canonicalGroupKey = canonicalizeMediaUrl(observation.url);
    if (!canonicalGroupKey || !observation.mediaType) return null;
    const manifestRoleForIdentity = manifestObservation ? normalizeResolverRole(observation.role) : '';
    const groupKey = mediaObservationGroupKey(observation);
    const pageIdentity = sourceMethod === 'page' ? pageRenditionIdentity(observation) : '';
    const youtubeState = state.platform?.id === 'youtube';
    const resolverRole = resolverObservation
        ? normalizeResolverRole(observation.resolverRole || observation.role)
        : '';
    let candidate = state.candidates.find((item) => item.groupKey === groupKey);
    if (sourceMethod === 'page') {
        const exactMatches = state.candidates.filter((item) =>
            item.url === observation.url &&
            (item.manifestCanonicalKey || item.pageCanonicalKey || canonicalizeMediaUrl(item.url)) === canonicalGroupKey &&
            !isExplicitlyFailedCandidate(item)
        );
        if (
            exactMatches.length === 1 &&
            (!candidate || candidate.url !== observation.url)
        ) candidate = exactMatches[0];
    }
    if (manifestObservation && !candidate) {
        const exactMatches = state.candidates.filter((item) =>
            item?.manifestDerived !== true &&
            item.url === observation.url &&
            !isExplicitlyFailedCandidate(item)
        );
        if (exactMatches.length === 1) candidate = exactMatches[0];
    }
    if (sourceMethod === 'network') {
        const manifestMatches = state.candidates.filter((item) =>
            item?.manifestDerived === true &&
            (item.manifestCanonicalKey || canonicalizeMediaUrl(item.url)) === canonicalGroupKey
        );
        const exactManifestMatch = manifestMatches.find((item) => item.url === observation.url);
        const pageMatches = state.candidates.filter((item) =>
            item?.pageDerived === true &&
            (item.pageCanonicalKey || canonicalizeMediaUrl(item.url)) === canonicalGroupKey
        );
        const exactPageMatch = pageMatches.find((item) => item.url === observation.url);
        const exactDerivedMatch = exactManifestMatch || exactPageMatch;
        const derivedMatches = [...new Set([...manifestMatches, ...pageMatches])];
        const soleDerivedMatch = derivedMatches.length === 1 ? derivedMatches[0] : null;
        if (candidate?.url !== observation.url && exactDerivedMatch) {
            candidate = exactDerivedMatch;
        } else if (!candidate && soleDerivedMatch) {
            candidate = soleDerivedMatch;
        }

        // Enrich only an exact transport match. Signed query parameters may be
        // the sole distinction between 1080p and 720p renditions, so a shared
        // canonical URL is never enough to merge two derived candidates.
        if (candidate && exactManifestMatch && candidate !== exactManifestMatch && candidate.url === observation.url) {
            candidate.manifestDerived = true;
            candidate.manifestRole = exactManifestMatch.manifestRole || exactManifestMatch.role || 'variant';
            candidate.manifestCanonicalKey = canonicalGroupKey;
            for (const field of [
                'quality', 'width', 'height', 'bitrateKbps', 'bandwidth', 'language',
                'mediaKind', 'hasAudio', 'hasVideo', 'manifestParentShortCurrent',
                'manifestParentCanonicalKey'
            ]) {
                if (exactManifestMatch[field] !== undefined) candidate[field] = exactManifestMatch[field];
            }
            candidate.genericPrerollGuardUntil = Math.max(
                Number(candidate.genericPrerollGuardUntil) || 0,
                Number(exactManifestMatch.genericPrerollGuardUntil) || 0
            );
            candidate.pageSnapshotKeys = [...new Set([
                ...(Array.isArray(candidate.pageSnapshotKeys) ? candidate.pageSnapshotKeys : []),
                ...(Array.isArray(exactManifestMatch.pageSnapshotKeys) ? exactManifestMatch.pageSnapshotKeys : [])
            ])].slice(-16);
            candidate.currentPlayerKeys = mergePlayerKeyLists(
                candidate.currentPlayerKeys,
                exactManifestMatch.currentPlayerKeys
            );
            candidate.playerKeys = mergePlayerKeyLists(
                candidate.currentPlayerKeys,
                candidate.playerKeys,
                exactManifestMatch.playerKeys
            );
            candidate.sources = [...new Set([
                ...(Array.isArray(candidate.sources) ? candidate.sources : []),
                ...(Array.isArray(exactManifestMatch.sources) ? exactManifestMatch.sources : ['manifest_scan'])
            ])].slice(-8);
            state.candidates = state.candidates.filter((item) => item !== exactManifestMatch);
        } else if (!exactDerivedMatch && manifestMatches.length > 1 && candidate) {
            // An opaque refreshed token no longer identifies which synthetic
            // rendition it belongs to. Retire only an unconfirmed duplicate of
            // the same explicit rendition; unrelated 1080p/720p siblings and
            // previously confirmed transports must remain available.
            const candidateHeight = inferCandidateHeight(candidate);
            const candidateBitrate = inferCandidateBitrateKbps(candidate);
            for (const item of manifestMatches) {
                if (
                    item === candidate ||
                    item.networkObserved === true ||
                    !candidateHeight ||
                    inferCandidateHeight(item) !== candidateHeight ||
                    (candidateBitrate && inferCandidateBitrateKbps(item) !== candidateBitrate)
                ) continue;
                item.superseded = true;
                item.supersededAt = now;
                item.diagnosticOnly = true;
                item.diagnosticReason = 'MANIFEST_TRANSPORT_REPLACED';
            }
        }
    }
    const created = !candidate;
    if (!candidate) {
        candidate = {
            id: `media_${stableHash(groupKey)}`,
            groupKey,
            url: observation.url,
            type: observation.mediaType,
            role: 'master',
            isMaster: true,
            score: 0,
            source: observation.source,
            resourceType: observation.resourceType || '',
            firstSeenAt: now,
            lastSeenAt: now,
            seenCount: 0,
            requestStartedAt: 0,
            networkObserved: sourceMethod === 'network',
            diagnosticOnly: youtubeState && !resolverObservation,
            sourceMethod,
            sources: [observation.source],
            pageSnapshotKeys: [],
            playerKeys: [],
            currentPlayerKeys: [],
            genericPrerollGuardUntil: state.platform?.id === 'generic' && !resolverObservation && !manifestObservation
                ? now + GENERIC_PREROLL_GUARD_MS
                : 0,
            userPriority: 0
        };
        if (manifestObservation) {
            candidate.manifestDerived = true;
            candidate.manifestRole = manifestRoleForIdentity || 'variant';
            candidate.manifestCanonicalKey = canonicalGroupKey;
        }
        if (sourceMethod === 'page' && pageIdentity) {
            candidate.pageDerived = true;
            candidate.pageCanonicalKey = canonicalGroupKey;
        }
        state.candidates.push(candidate);
    }

    if (!Array.isArray(candidate.sources)) candidate.sources = [];
    if (typeof observation.source === 'string' && !candidate.sources.includes(observation.source)) {
        candidate.sources.push(observation.source);
        candidate.sources = candidate.sources.slice(-8);
    }
    if (sourceMethod === 'network') candidate.networkObserved = true;
    if (typeof observation.pageSnapshotKey === 'string' && observation.pageSnapshotKey) {
        const pageSnapshotKeys = Array.isArray(candidate.pageSnapshotKeys) ? candidate.pageSnapshotKeys : [];
        if (!pageSnapshotKeys.includes(observation.pageSnapshotKey)) pageSnapshotKeys.push(observation.pageSnapshotKey);
        candidate.pageSnapshotKeys = pageSnapshotKeys.slice(-16);
    }
    candidate.currentPlayerKeys = mergePlayerKeyLists(candidate.currentPlayerKeys, observation.currentPlayerKeys);
    candidate.playerKeys = mergePlayerKeyLists(
        candidate.currentPlayerKeys,
        candidate.playerKeys,
        observation.playerKeys
    );

    const observationStartedAt = Number.isFinite(observation.requestStartedAt) ? observation.requestStartedAt : now;
    const isFresh = observationStartedAt >= (candidate.requestStartedAt || 0);
    const sameRequest = isSameObservedRequest(candidate, observation);
    const previousUrl = candidate.url;

    const protectedYouTubeResolver = youtubeState &&
        !resolverObservation &&
        candidate.resolverCurrent === true &&
        hasResolverProvenance(candidate);
    const manifestEnrichmentOfNetwork = manifestObservation && candidate.networkObserved === true;
    const mayReplaceTransport = isFresh && !protectedYouTubeResolver && !manifestEnrichmentOfNetwork && !(
        resolverObservation &&
        candidate.networkObserved === true &&
        !youtubeState &&
        observation.refreshTransport !== true
    );
    if (mayReplaceTransport) {
        candidate.url = observation.url;
        candidate.type = observation.mediaType;
        candidate.source = observation.source;
        candidate.sourceMethod = sourceMethod;
        candidate.resourceType = observation.resourceType || candidate.resourceType || '';
        candidate.requestId = observation.requestId || candidate.requestId || '';
        candidate.requestStartedAt = observationStartedAt;
        if (observation.clearHeaders && !sameRequest) {
            delete candidate.referer;
            delete candidate.origin;
            delete candidate.userAgent;
            delete candidate.contentType;
            delete candidate.statusCode;
            delete candidate.networkError;
        }
        for (const headerName of ['referer', 'origin', 'userAgent']) {
            if (typeof observation[headerName] === 'string' && observation[headerName]) {
                candidate[headerName] = observation[headerName];
            }
        }
        if (observation.contentType) candidate.contentType = normalizeContentType(observation.contentType);
        if (Number.isInteger(observation.statusCode)) candidate.statusCode = observation.statusCode;
        if (observation.networkError) candidate.networkError = sanitizePublicMessage(observation.networkError, 'Błąd sieci.');
        else if (Number.isInteger(observation.statusCode) && observation.statusCode < 400) delete candidate.networkError;
    }
    const urlChanged = isFresh && candidate.url !== previousUrl;
    if (urlChanged) {
        // A play failure belongs to one exact signed URL. Once the page or
        // resolver supplies a refreshed token, the logical rendition becomes
        // healthy again without losing its place in the playlist.
        candidate.playState = '';
        candidate.lastPlayErrorCode = '';
        candidate.lastPlayErrorAt = 0;
        candidate.lastPlayErrorUrlHash = '';
    }

    // DOM snapshots carry no authoritative request time. They enrich a network
    // candidate without replacing its current URL, response or observed headers.
    if (typeof observation.title === 'string' && observation.title) {
        candidate.title = sanitizePublicMessage(observation.title, '').slice(0, 120);
    }
    if (typeof observation.quality === 'string' && observation.quality) {
        candidate.quality = sanitizePublicMessage(observation.quality, '').slice(0, 32);
    }
    if (Number.isFinite(observation.duration) && observation.duration >= 0) {
        candidate.duration = Math.min(observation.duration, 86_400);
    }
    if (Number.isInteger(observation.width) && observation.width > 0) candidate.width = observation.width;
    if (Number.isInteger(observation.height) && observation.height > 0) candidate.height = observation.height;
    if (Number.isFinite(observation.bitrateKbps) && observation.bitrateKbps >= 16) {
        candidate.bitrateKbps = Math.min(Math.round(observation.bitrateKbps), 250_000);
    } else if (Number.isFinite(observation.bandwidth) && observation.bandwidth >= 16_000) {
        candidate.bandwidth = Math.min(Math.round(observation.bandwidth), 250_000_000);
    }
    if (['video', 'audio'].includes(observation.elementKind)) candidate.elementKind = observation.elementKind;
    if (typeof observation.live === 'boolean') candidate.live = observation.live;
    if (typeof observation.formatId === 'string' && observation.formatId) {
        if (resolverObservation) candidate.formatId = sanitizePublicMessage(observation.formatId, '').slice(0, 64);
    }
    if (manifestObservation) {
        const mediaKind = typeof observation.mediaKind === 'string' && RESOLVER_MEDIA_KINDS.has(observation.mediaKind)
            ? observation.mediaKind
            : '';
        const language = normalizeLanguageTag(observation.language);
        candidate.manifestDerived = true;
        candidate.manifestRole = normalizeResolverRole(observation.role) || candidate.manifestRole || 'variant';
        candidate.manifestCanonicalKey = canonicalGroupKey;
        candidate.manifestParentShortCurrent = observation.manifestParentShortCurrent === true;
        if (mediaKind) candidate.mediaKind = mediaKind;
        if (language) candidate.language = language;
        if (typeof observation.hasAudio === 'boolean') candidate.hasAudio = observation.hasAudio;
        if (typeof observation.hasVideo === 'boolean') candidate.hasVideo = observation.hasVideo;
        if (candidate.networkObserved === true) delete candidate.autoEligible;
        else candidate.autoEligible = false;
        candidate.diagnosticOnly = candidate.superseded === true;
    }
    if (sourceMethod === 'page' && pageIdentity) {
        candidate.pageDerived = true;
        candidate.pageCanonicalKey = canonicalGroupKey;
    }
    if (sourceMethod === 'network' && candidate.manifestDerived === true) {
        delete candidate.autoEligible;
    }
    if (resolverObservation) {
        if (resolverRole) candidate.resolverRole = resolverRole;
        const language = normalizeLanguageTag(observation.language);
        const mediaKind = typeof observation.mediaKind === 'string' && RESOLVER_MEDIA_KINDS.has(observation.mediaKind)
            ? observation.mediaKind
            : '';
        if (language) candidate.language = language;
        else delete candidate.language;
        if (mediaKind) candidate.mediaKind = mediaKind;
        else delete candidate.mediaKind;
        if (RESOLVER_PLAYBACK_KINDS.has(observation.playbackKind)) {
            candidate.playbackKind = observation.playbackKind;
        } else {
            delete candidate.playbackKind;
        }
        if (typeof observation.hasAudio === 'boolean') candidate.hasAudio = observation.hasAudio;
        else delete candidate.hasAudio;
        if (typeof observation.hasVideo === 'boolean') candidate.hasVideo = observation.hasVideo;
        else delete candidate.hasVideo;
        candidate.resolverBatch = typeof observation.resolverBatch === 'string'
            ? observation.resolverBatch.slice(0, 160)
            : '';
        candidate.resolverCurrent = observation.resolverCurrent === true;
        candidate.materialScope = typeof observation.materialScope === 'string'
            ? observation.materialScope.slice(0, 160)
            : '';
        candidate.preferredLanguageRank = Number.isInteger(observation.preferredLanguageRank)
            ? Math.min(Math.max(observation.preferredLanguageRank, 0), MAX_PREFERRED_LANGUAGES)
            : MAX_PREFERRED_LANGUAGES;
        if (observation.autoEligible === false) candidate.autoEligible = false;
        else delete candidate.autoEligible;
        if (youtubeState) candidate.diagnosticOnly = !isYouTubePrimaryResolverCandidate(candidate, state.materialScope?.id || '');
        else candidate.diagnosticOnly = candidate.superseded === true;
    } else if (youtubeState && candidate.resolverCurrent !== true) {
        candidate.diagnosticOnly = true;
    }

    candidate.lastSeenAt = now;
    candidate.seenCount = (candidate.seenCount || 0) + 1;
    const manifestRole = manifestObservation
        ? normalizeResolverRole(observation.role)
        : (candidate.manifestDerived ? normalizeResolverRole(candidate.manifestRole) : '');
    candidate.role = normalizeResolverRole(candidate.resolverRole) || manifestRole || classifyMediaRole(candidate);
    candidate.isMaster = candidate.role === 'master';
    candidate.qualityHeight = inferCandidateHeight(candidate);
    candidate.bitrateKbps = inferCandidateBitrateKbps(candidate);
    candidate.quality = inferCandidateQuality(candidate);
    candidate.qualityBucket = candidateQualityBucket(candidate);
    candidate.qualityPreferenceRank = candidateQualityRank(
        candidate,
        state.sourcePreferences?.qualityOrder
    );
    updateCandidateFreshness(candidate, now);
    if (
        urlChanged &&
        candidate.expired !== true &&
        ['EXPIRED_SOURCE_REPLACED', 'EXPIRED_REFRESH_FAILED'].includes(candidate.diagnosticReason)
    ) {
        candidate.diagnosticOnly = false;
        delete candidate.diagnosticReason;
    }
    if (activeExpiryRefreshTabId === state.tabId) candidate.autoEligible = false;
    candidate.sourceFamilyId = sourceFamilyFingerprint(candidate);
    candidate.sourceFamilyLabel = sourceFamilyLabel(candidate);
    candidate.purpose = classifyMediaPurpose(candidate);
    candidate.blocked = isBlockedCandidate(candidate);
    if (candidate.purpose === 'advertisement') {
        candidate.blockedReason = 'Odrzucono reklamę wykrytą w odtwarzaczu strony.';
    } else if (candidate.purpose === 'utility') {
        candidate.blockedReason = 'Odrzucono techniczny plik pomocniczy odtwarzacza.';
    } else {
        delete candidate.blockedReason;
    }
    candidate.score = scoreCandidate(candidate);

    if (created && candidate.purpose === 'advertisement') {
        addEvent(state, 'filtered', 'ADVERTISEMENT_FILTERED', 'Pominięto reklamę; czekam na właściwy materiał.', candidate);
    } else if (created && candidate.purpose === 'utility') {
        addEvent(state, 'filtered', 'UTILITY_MEDIA_FILTERED', 'Pominięto techniczny plik odtwarzacza.', candidate);
    } else if (created) {
        addEvent(state, 'media', 'MEDIA_DETECTED', 'Wykryto kandydata do odtworzenia.', candidate);
    } else if (urlChanged) {
        if (state.auto.retryFingerprint === candidate.groupKey) {
            state.auto.retryFingerprint = null;
            state.auto.retryCount = 0;
        }
        addEvent(state, 'media', 'MEDIA_URL_REFRESHED', 'Odświeżono bieżący adres i token kandydata.', candidate);
    }
    if (isFresh && observation.networkError) {
        addEvent(state, 'media_error', 'NETWORK_REQUEST_FAILED', 'Żądanie kandydata zakończyło się błędem sieci.', candidate);
    } else if (isFresh && Number.isInteger(observation.statusCode) && observation.statusCode >= 400) {
        addEvent(
            state,
            'media_error',
            `HTTP_${observation.statusCode}`,
            `Serwer kandydata odpowiedział kodem HTTP ${observation.statusCode}.`,
            candidate,
            { statusCode: observation.statusCode }
        );
    }
    return candidate;
}

function genericPrerollGuardDueAt(candidate, now = Date.now()) {
    if (!isGenericPrerollProvisional(candidate, now)) return null;
    const duration = Number(candidate?.duration);
    if (
        hasCurrentPlayerEvidence(candidate) &&
        Number.isFinite(duration) &&
        duration > 0 &&
        duration <= GENERIC_SHORT_MEDIA_MAX_SECONDS
    ) return null;
    return candidate.genericPrerollGuardUntil > now ? candidate.genericPrerollGuardUntil : null;
}

function isConfirmedAutoTransport(candidate) {
    return candidate &&
        candidate.diagnosticOnly !== true &&
        candidate.autoEligible !== false &&
        !isBlockedCandidate(candidate) &&
        !isExplicitlyIncompleteCandidate(candidate) &&
        candidatePlaybackFitnessTier(candidate) === 0 &&
        candidate.role !== 'audio' &&
        !isLikelySegmentUrl(candidate.url) &&
        candidate.score >= 60 &&
        !candidate.networkError &&
        !isCandidateExpired(candidate) &&
        Number.isInteger(candidate.statusCode) &&
        candidate.statusCode >= 200 &&
        candidate.statusCode < 400;
}

function refreshDetectionState(state, sitePolicy, now = Date.now()) {
    if (
        activeExpiryRefreshTabId === state.tabId ||
        (Number.isFinite(state.auto?.suppressUntil) && state.auto.suppressUntil > now)
    ) {
        state.auto.pendingDueAt = null;
        return null;
    }
    const retryExhausted = (candidate) =>
        state.auto.retryFingerprint === candidate.groupKey &&
        state.auto.retryCount > MAX_AUTO_RETRIES_PER_STREAM;
    const primaryCandidates = state.candidates.filter((candidate) => candidate.diagnosticOnly !== true);
    primaryCandidates.forEach((candidate) => {
        candidate.prerollProvisional = isGenericPrerollProvisional(candidate, now);
    });
    const confirmedCandidates = primaryCandidates.filter((candidate) =>
        isAutoPlayable(candidate, now) && !retryExhausted(candidate)
    ).sort(compareCandidates);
    const guardedCandidates = primaryCandidates.filter((candidate) =>
        isConfirmedAutoTransport(candidate) &&
        isGenericPrerollProvisional(candidate, now) &&
        !retryExhausted(candidate)
    ).sort(compareCandidates);
    const activeGuardedCandidates = confirmedCandidates.some(hasCurrentPlayerEvidence)
        ? []
        : guardedCandidates.filter(hasCurrentPlayerEvidence);
    const pendingCandidates = primaryCandidates.filter((item) =>
        item.autoEligible !== false &&
        !isBlockedCandidate(item) &&
        item.role !== 'audio' &&
        !isLikelySegmentUrl(item.url) &&
        item.score >= 60 &&
        !isExplicitlyFailedCandidate(item) &&
        !Number.isInteger(item.statusCode)
    ).sort(compareCandidates);
    const failedCandidates = primaryCandidates.filter((item) =>
        !isBlockedCandidate(item) && isExplicitlyFailedCandidate(item)
    ).sort(compareCandidates);
    const visibleCandidates = primaryCandidates.filter((item) => !isBlockedCandidate(item)).sort(compareCandidates);
    const healthyVisibleCandidates = visibleCandidates.filter((item) => !isExplicitlyFailedCandidate(item));
    const filteredCandidates = primaryCandidates.filter(isBlockedCandidate);
    const bestVisible = confirmedCandidates[0] || pendingCandidates[0] || healthyVisibleCandidates[0] || failedCandidates[0] || null;
    const preservePendingDueAt = (proposedDueAt) => Number.isFinite(state.auto.pendingDueAt)
        ? Math.min(state.auto.pendingDueAt, proposedDueAt)
        : proposedDueAt;

    state.auto.enabled = sitePolicy.enabled;
    if (shouldPreserveConfirmedPlaying(state)) {
        state.auto.pendingDueAt = null;
    } else if (!primaryCandidates.length) {
        state.auto.pendingDueAt = null;
        if (!['scheduled', 'resolving', 'found'].includes(state.resolver?.state)) {
            setStateStatus(
                state,
                'scanning',
                state.candidates.length ? 'DIAGNOSTIC_MEDIA_OBSERVED' : 'PAGE_MEDIA_REMOVED',
                state.candidates.length
                    ? 'Zaobserwowano techniczny ruch karty; czekam na rozpoznanie bieżącego materiału.'
                    : 'Źródła zniknęły ze strony. Czekam na nowe media.'
            );
        }
    } else if (!confirmedCandidates.length && !pendingCandidates.length && !healthyVisibleCandidates.length && failedCandidates.length) {
        state.auto.pendingDueAt = null;
        const failed = failedCandidates[0];
        if (failed.networkError) {
            setStateStatus(state, 'error', 'NETWORK_REQUEST_FAILED', `Żądanie multimediów nie powiodło się: ${failed.networkError}`, failed);
        } else {
            setStateStatus(state, 'error', `HTTP_${failed.statusCode}`, `Serwer multimediów odpowiedział kodem HTTP ${failed.statusCode}.`, failed);
        }
    } else if (filteredCandidates.length && visibleCandidates.length === 0) {
        state.auto.pendingDueAt = null;
        setStateStatus(
            state,
            'filtered',
            'ADS_FILTERED',
            'Pominięto reklamę lub plik techniczny. Czekam na właściwy materiał.',
            null,
            { filteredCount: filteredCandidates.length }
        );
    } else if (!sitePolicy.enabled) {
        state.auto.pendingDueAt = null;
        setStateStatus(
            state,
            'auto_disabled',
            sitePolicy.migrationAvailable ? 'LEGACY_AUTO_REQUIRES_CONFIRMATION' : 'SITE_AUTO_DISABLED',
            sitePolicy.migrationAvailable
                ? 'Stare ustawienie auto-otwierania wymaga jawnego włączenia dla tej witryny.'
                : 'Wykryto media, ale auto-otwieranie jest wyłączone dla tej witryny.',
            bestVisible
        );
    } else if (activeGuardedCandidates.length || (!confirmedCandidates.length && guardedCandidates.length)) {
        const waitingCandidates = activeGuardedCandidates.length ? activeGuardedCandidates : guardedCandidates;
        const guardDueAt = waitingCandidates
            .map((candidate) => genericPrerollGuardDueAt(candidate, now))
            .filter(Number.isFinite)
            .sort((left, right) => left - right)[0] || null;
        state.auto.pendingDueAt = guardDueAt;
        setStateStatus(
            state,
            'detected',
            'AWAITING_CONTENT_PHASE',
            'Odtwarzacz jest w fazie początkowej. Czekam na właściwy materiał zamiast otwierać możliwy preroll.',
            waitingCandidates[0]
        );
    } else if (confirmedCandidates.length) {
        state.auto.pendingDueAt = preservePendingDueAt(now + AUTO_DEBOUNCE_MS);
        setStateStatus(state, 'detected', 'MEDIA_CONFIRMED', 'Potwierdzono media. Wybieram najlepszy kandydat do auto-otwarcia.', confirmedCandidates[0]);
    } else if (pendingCandidates.length) {
        state.auto.pendingDueAt = preservePendingDueAt(now + AUTO_DEBOUNCE_MS);
        setStateStatus(state, 'detected', 'AWAITING_MEDIA_RESPONSE', 'Wykryto adres mediów. Czekam na odpowiedź serwera przed auto-otwarciem.', pendingCandidates[0]);
    } else {
        state.auto.pendingDueAt = null;
        setStateStatus(state, 'detected', 'NO_SAFE_AUTO_CANDIDATE', 'Wykryto media, ale brak bezpiecznego kandydata do auto-otwarcia.', bestVisible);
    }
    return state.auto.pendingDueAt;
}

async function observeMedia(tabId, observation) {
    if (!canonicalizeMediaUrl(observation.url) || !observation.mediaType) return null;
    if (removedTabs.has(tabId) || observation.tabEpoch !== currentTabEpoch(tabId)) return null;
    const hostname = observation.pageHostname || await resolveTabHostname(tabId);
    const now = Date.now();

    const mutation = await mutateTabState(tabId, hostname, async (state) => {
        const [sitePolicy, sourcePreferences] = await Promise.all([
            readSiteAuto(hostname || state.hostname),
            readSiteSourcePreferences(hostname || state.hostname)
        ]);
        if (observation.tabEpoch !== currentTabEpoch(tabId)) return { ignored: true };
        if (hostname && state.hostname && state.hostname !== hostname) {
            Object.assign(state, createTabState(tabId, hostname, observation.tabEpoch));
        } else if (hostname && !state.hostname) {
            state.hostname = hostname;
        }

        const candidate = mergeMediaObservationIntoState(state, observation, now);
        applySourcePreferencesToState(state, sourcePreferences);
        const pendingDueAt = refreshDetectionState(state, sitePolicy, now);
        return { candidateId: candidate?.id || null, pendingDueAt };
    });

    if (mutation.result?.ignored) return mutation.state;
    if (mutation.result?.pendingDueAt) armAutoTimer(tabId, mutation.result.pendingDueAt);
    else clearAutoTimer(tabId);
    scheduleManifestScansForState(tabId, mutation.state);
    return mutation.state;
}

async function readBoundedResponseText(response, maxBytes = MAX_MANIFEST_BYTES) {
    const declaredLength = Number(response?.headers?.get?.('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new WorkerError('MANIFEST_TOO_LARGE', 'Manifest przekracza bezpieczny limit rozmiaru.');
    }
    if (!response?.body || typeof response.body.getReader !== 'function') {
        const text = await response.text();
        const byteLength = typeof TextEncoder === 'function'
            ? new TextEncoder().encode(text).byteLength
            : text.length;
        if (byteLength > maxBytes) throw new WorkerError('MANIFEST_TOO_LARGE', 'Manifest przekracza bezpieczny limit rozmiaru.');
        return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new WorkerError('MANIFEST_TOO_LARGE', 'Manifest przekracza bezpieczny limit rozmiaru.');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function isManifestScanCandidate(candidate) {
    if (!candidate || candidate.sourceMethod === 'manifest' || candidate.diagnosticOnly === true) return false;
    if (isBlockedCandidate(candidate) || isExplicitlyFailedCandidate(candidate)) return false;
    const type = String(candidate.type || detectMediaFromUrl(candidate.url) || '').toUpperCase();
    const role = normalizeResolverRole(candidate.resolverRole) || normalizeResolverRole(candidate.role) || classifyMediaRole(candidate);
    const parsed = parseHttpUrl(candidate.url || '');
    // Proactive reads are stricter than passive detection/opening: HTTPS keeps a
    // hostile page from using DNS rebinding to turn a public-looking hostname
    // into a readable request to a plain-HTTP service on the local network.
    return ['HLS', 'DASH'].includes(type) && role === 'master' && parsed?.protocol === 'https:' &&
        isSafeRemoteManifestUrl(parsed.href);
}

function pruneRecentManifestScans(now = Date.now()) {
    for (const [key, scannedAt] of recentManifestScans) {
        if (!Number.isFinite(scannedAt) || now - scannedAt > MANIFEST_RESCAN_TTL_MS) recentManifestScans.delete(key);
    }
    while (recentManifestScans.size > 128) recentManifestScans.delete(recentManifestScans.keys().next().value);
}

function queuePendingManifestScan(tabId, navigationEpoch) {
    if (!Number.isInteger(tabId) || !Number.isInteger(navigationEpoch) || removedTabs.has(tabId)) return;
    pendingManifestScanTabs.delete(tabId);
    pendingManifestScanTabs.set(tabId, navigationEpoch);
    while (pendingManifestScanTabs.size > MAX_PENDING_MANIFEST_TABS) {
        pendingManifestScanTabs.delete(pendingManifestScanTabs.keys().next().value);
    }
}

function drainPendingManifestScans() {
    if (manifestScanDrainRunning || activeManifestScans.size >= 8 || !pendingManifestScanTabs.size) return;
    manifestScanDrainRunning = true;
    void (async () => {
        while (activeManifestScans.size < 8 && pendingManifestScanTabs.size) {
            const [tabId, navigationEpoch] = pendingManifestScanTabs.entries().next().value;
            pendingManifestScanTabs.delete(tabId);
            if (removedTabs.has(tabId) || currentTabEpoch(tabId) !== navigationEpoch) continue;
            let currentState;
            try {
                currentState = await loadTabState(tabId);
            } catch (_error) {
                continue;
            }
            if (
                removedTabs.has(tabId) ||
                currentTabEpoch(tabId) !== navigationEpoch ||
                currentState.navigationEpoch !== navigationEpoch
            ) continue;
            scheduleManifestScansForState(tabId, currentState);
        }
    })().finally(() => {
        manifestScanDrainRunning = false;
        if (activeManifestScans.size < 8 && pendingManifestScanTabs.size) {
            drainPendingManifestScans();
        }
    });
}

function scheduleManifestScansForState(tabId, state) {
    if (typeof fetch !== 'function' || !Number.isInteger(tabId) || !state) return;
    const now = Date.now();
    pruneRecentManifestScans(now);
    const navigationEpoch = Number.isInteger(state.navigationEpoch) ? state.navigationEpoch : currentTabEpoch(tabId);
    const navigationKey = `${tabId}:${navigationEpoch}`;
    const attempted = manifestScanAttemptsByNavigation.get(navigationKey) || new Set();
    manifestScanAttemptsByNavigation.set(navigationKey, attempted);
    const keyForCandidate = (candidate) => {
        const canonicalUrl = canonicalizeMediaUrl(candidate?.url || '');
        return canonicalUrl
            ? `${tabId}:${navigationEpoch}:${canonicalUrl}:${stableHash(candidate.url)}`
            : '';
    };
    const remainingBudget = Math.max(0, MAX_MANIFEST_SCANS_PER_NAVIGATION - attempted.size);
    const eligibleCandidates = (state.candidates || []).filter((candidate) => {
        if (!isManifestScanCandidate(candidate)) return false;
        const key = keyForCandidate(candidate);
        return Boolean(key) && !attempted.has(key) && !activeManifestScans.has(key) &&
            now - (recentManifestScans.get(key) || 0) >= MANIFEST_RESCAN_TTL_MS;
    }).slice(0, remainingBudget);
    if (!eligibleCandidates.length) {
        if (pendingManifestScanTabs.get(tabId) === navigationEpoch) pendingManifestScanTabs.delete(tabId);
        return;
    }
    const activeForState = [...activeManifestScans.keys()].filter((key) =>
        key.startsWith(`${tabId}:${navigationEpoch}:`)
    ).length;
    const availableSlots = Math.max(0, Math.min(4 - activeForState, 8 - activeManifestScans.size));
    if (!availableSlots) {
        queuePendingManifestScan(tabId, navigationEpoch);
        return;
    }
    const candidates = eligibleCandidates.slice(0, availableSlots);
    for (const candidate of candidates) {
        void scanManifestCandidate(tabId, state, candidate)
            .catch(() => undefined)
            .finally(() => {
                queuePendingManifestScan(tabId, navigationEpoch);
                drainPendingManifestScans();
            });
    }
}

async function fetchManifestWithoutUnsafeRedirects(initialUrl, options = {}) {
    if (!isSafeRemoteManifestUrl(initialUrl) || parseHttpUrl(initialUrl)?.protocol !== 'https:') return null;
    // Fetch exposes cross-origin manual redirects as opaque responses, so their
    // Location header cannot be validated. Reject redirects at the network
    // layer; a page that follows one normally will expose the final URL through
    // webRequest/Resource Timing as a separate candidate.
    const response = await fetch(initialUrl, {
        ...options,
        redirect: 'error',
        referrerPolicy: 'no-referrer'
    });
    if (options.signal?.aborted) return null;
    const finalUrl = response?.url || initialUrl;
    if (!isSafeRemoteManifestUrl(finalUrl) || parseHttpUrl(finalUrl)?.protocol !== 'https:') return null;
    return { response, finalUrl };
}

async function scanManifestCandidate(tabId, state, candidate) {
    const canonicalUrl = canonicalizeMediaUrl(candidate?.url || '');
    if (!canonicalUrl) return 0;
    const navigationEpoch = Number.isInteger(state?.navigationEpoch) ? state.navigationEpoch : currentTabEpoch(tabId);
    // Include the current signed URL in the in-memory scan identity. A refreshed
    // token must be allowed to start a new scan while an older response is still
    // in flight; the canonical URL alone intentionally collapses those tokens.
    const key = `${tabId}:${navigationEpoch}:${canonicalUrl}:${stableHash(candidate.url)}`;
    const navigationKey = `${tabId}:${navigationEpoch}`;
    const attempted = manifestScanAttemptsByNavigation.get(navigationKey) || new Set();
    const now = Date.now();
    pruneRecentManifestScans(now);
    if (
        attempted.has(key) ||
        attempted.size >= MAX_MANIFEST_SCANS_PER_NAVIGATION ||
        activeManifestScans.has(key) ||
        now - (recentManifestScans.get(key) || 0) < MANIFEST_RESCAN_TTL_MS
    ) return 0;
    attempted.add(key);
    manifestScanAttemptsByNavigation.set(navigationKey, attempted);
    recentManifestScans.set(key, now);

    const operation = (async () => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timer = null;
        let timedOut = false;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                controller?.abort();
                reject(new WorkerError('MANIFEST_TIMEOUT', 'Przekroczono bezpieczny czas odczytu manifestu.'));
            }, MANIFEST_FETCH_TIMEOUT_MS);
        });
        const work = (async () => {
            const fetched = await fetchManifestWithoutUnsafeRedirects(candidate.url, {
                method: 'GET',
                credentials: 'omit',
                cache: 'no-store',
                headers: { Accept: 'application/vnd.apple.mpegurl, application/dash+xml, application/xml, text/plain;q=0.8' },
                ...(controller ? { signal: controller.signal } : {})
            });
            if (timedOut || controller?.signal.aborted || !fetched?.response?.ok) return 0;
            const { response, finalUrl } = fetched;
            const text = await readBoundedResponseText(response);
            if (timedOut || controller?.signal.aborted) return 0;
            const variants = parseManifestVariants(text, finalUrl, candidate.type);
            if (!variants.length || navigationEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) return 0;

            const sourcePreferences = await readSiteSourcePreferences(state.hostname);
            if (timedOut || controller?.signal.aborted) return 0;
            const mutation = await mutateTabState(tabId, state.hostname, (current) => {
                if (timedOut || controller?.signal.aborted) return { added: 0 };
                if (
                    current.navigationEpoch !== navigationEpoch ||
                    current.hostname !== state.hostname ||
                    (state.pageIdentity && current.pageIdentity !== state.pageIdentity)
                ) return { added: 0 };
                const currentParent = current.candidates.find((item) =>
                    item.id === candidate.id && item.url === candidate.url
                );
                if (!currentParent || !isManifestScanCandidate(currentParent)) return { added: 0 };
                const beforeIds = new Set(current.candidates.map((item) => item.id));
                for (let index = 0; index < variants.length; index += 1) {
                    const variant = variants[index];
                    const inheritedRequestContext = manifestChildRequestContext(currentParent, variant.url);
                    const child = mergeMediaObservationIntoState(current, {
                        ...variant,
                        ...inheritedRequestContext,
                        requestId: `manifest:${stableHash(`${canonicalUrl}:${variant.url}`)}`,
                        requestStartedAt: now + index,
                        tabEpoch: navigationEpoch,
                        pageHostname: current.hostname,
                        duration: candidate.duration,
                        live: candidate.live,
                        manifestParentShortCurrent: hasCurrentPlayerEvidence(currentParent) &&
                            Number.isFinite(Number(currentParent.duration)) &&
                            Number(currentParent.duration) > 0 &&
                            Number(currentParent.duration) <= GENERIC_SHORT_MEDIA_MAX_SECONDS
                    }, now + index);
                    if (child) {
                        child.genericPrerollGuardUntil = Number.isFinite(currentParent.genericPrerollGuardUntil)
                            ? currentParent.genericPrerollGuardUntil
                            : 0;
                        child.manifestParentCanonicalKey = canonicalUrl;
                        child.pageSnapshotKeys = [...new Set([
                            ...(Array.isArray(child.pageSnapshotKeys) ? child.pageSnapshotKeys : []),
                            ...(Array.isArray(currentParent.pageSnapshotKeys) ? currentParent.pageSnapshotKeys : [])
                        ])].slice(-16);
                    }
                }
                applySourcePreferencesToState(current, sourcePreferences);
                const added = current.candidates.filter((item) => !beforeIds.has(item.id)).length;
                if (added > 0) {
                    addEvent(
                        current,
                        'media',
                        'MANIFEST_VARIANTS_FOUND',
                        `Automatycznie odczytano ${added} wariantów jakości z manifestu.`
                    );
                }
                return { added };
            });
            return mutation.result?.added || 0;
        })();
        try {
            return await Promise.race([work, timeout]);
        } finally {
            clearTimeout(timer);
        }
    })();
    activeManifestScans.set(key, operation);
    try {
        return await operation;
    } finally {
        if (activeManifestScans.get(key) === operation) activeManifestScans.delete(key);
    }
}

function clearAutoTimer(tabId) {
    const timer = autoTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    autoTimers.delete(tabId);
}

function armAutoTimer(tabId, dueAt) {
    clearAutoTimer(tabId);
    const delay = Math.max(0, Math.min(dueAt - Date.now(), 2_147_000_000));
    const timer = setTimeout(() => {
        autoTimers.delete(tabId);
        void attemptAutoLaunch(tabId).catch(() => undefined);
    }, delay);
    autoTimers.set(tabId, timer);
}

function clearPageReadyResolveTimer(tabId) {
    const timer = pageReadyResolveTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    pageReadyResolveTimers.delete(tabId);
}

function expiryRefreshAlarmName(tabId) {
    return `${MEDIA_EXPIRY_ALARM_PREFIX}${tabId}`;
}

function clearExpiryRefreshAlarm(tabId) {
    if (
        !Number.isInteger(tabId) || tabId < 0 ||
        typeof chrome === 'undefined' || !chrome.alarms?.clear
    ) return;
    try {
        const pending = chrome.alarms.clear(expiryRefreshAlarmName(tabId), () => {
            void chrome.runtime.lastError;
        });
        pending?.catch?.(() => undefined);
    } catch (_error) {
        // Alarms are best-effort. PLAY still performs an exact expiry preflight.
    }
}

function clearExpiryRefreshKick(tabId) {
    const timer = expiryRefreshKickTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    expiryRefreshKickTimers.delete(tabId);
}

function kickDueExpiryRefresh(tabId, delayMs = 0) {
    if (expiryRefreshKickTimers.has(tabId)) return;
    const timer = setTimeout(() => {
        expiryRefreshKickTimers.delete(tabId);
        void refreshMediaSources(tabId).catch(() => undefined);
    }, Math.max(0, Math.min(Number(delayMs) || 0, MEDIA_EXPIRY_BUSY_RETRY_MS)));
    expiryRefreshKickTimers.set(tabId, timer);
}

function forcedExpiryRefreshFingerprint(state, candidate, reason) {
    return expiryRefreshFingerprint([
        state?.materialScope?.id || state?.pageIdentity || state?.hostname || '',
        normalizeErrorCode(reason || 'PLAY_FAILURE', 'PLAY_FAILURE'),
        candidate?.id || '',
        stableHash(candidate?.url || ''),
        candidateMediaExpiry(candidate) || 0
    ].join('|'));
}

function markExpiryRefreshTargetsFailed(state, refreshTargets) {
    if (!state || !Array.isArray(state.candidates) || !Array.isArray(refreshTargets)) return;
    const targets = new Map(refreshTargets.filter((target) =>
        typeof target?.id === 'string' &&
        typeof target?.urlHash === 'string'
    ).map((target) => [target.id, target.urlHash]));
    if (!targets.size) return;
    state.candidates.forEach((candidate) => {
        const expectedUrlHash = targets.get(candidate.id);
        if (!expectedUrlHash || stableHash(candidate.url || '') !== expectedUrlHash) return;
        candidate.diagnosticOnly = true;
        candidate.diagnosticReason = 'EXPIRED_REFRESH_FAILED';
    });
}

function failedExpiryRefreshTargets(state) {
    if (
        state?.status?.code !== 'STREAM_REFRESH_FAILED' ||
        !Number.isFinite(state?.expiryRefresh?.attemptedAt) ||
        state.expiryRefresh.attemptedAt <= 0 ||
        !Array.isArray(state?.candidates)
    ) return [];
    return state.candidates.filter((candidate) =>
        candidate?.diagnosticReason === 'EXPIRED_REFRESH_FAILED'
    ).map((candidate) => ({
        id: candidate.id,
        urlHash: stableHash(candidate.url || ''),
        sourceFamilyId: candidate.sourceFamilyId || sourceFamilyFingerprint(candidate)
    }));
}

function reconcileLatePageExpiryRefresh(state, acceptedCandidates, failedTargets, now = Date.now()) {
    if (
        state?.status?.code !== 'STREAM_REFRESH_FAILED' ||
        !Array.isArray(failedTargets) ||
        !failedTargets.length ||
        !(acceptedCandidates instanceof Set)
    ) return false;
    const attemptedAt = Number(state.expiryRefresh?.attemptedAt) || 0;
    if (attemptedAt <= 0) return false;

    const healthyFresh = [...acceptedCandidates].filter((candidate) => {
        if (
            !candidate ||
            Number(candidate.lastSeenAt) < attemptedAt ||
            candidate.diagnosticOnly === true ||
            isBlockedCandidate(candidate) ||
            isExplicitlyIncompleteCandidate(candidate) ||
            isExplicitlyFailedCandidate(candidate, now) ||
            isCandidateExpired(candidate, now, MEDIA_EXPIRY_PLAY_GRACE_MS) ||
            isLikelySegmentUrl(candidate.url)
        ) return false;
        const role = normalizeResolverRole(candidate.resolverRole) ||
            normalizeResolverRole(candidate.role) || classifyMediaRole(candidate);
        if (role === 'audio' || candidatePlaybackFitnessTier(candidate) >= 2) return false;
        const candidateUrlHash = stableHash(candidate.url || '');
        const candidateFamily = candidate.sourceFamilyId || sourceFamilyFingerprint(candidate);
        return failedTargets.some((target) =>
            candidateUrlHash !== target.urlHash &&
            (
                candidate.id === target.id ||
                (candidateFamily && target.sourceFamilyId && candidateFamily === target.sourceFamilyId)
            )
        );
    });
    if (!healthyFresh.length) return false;

    const targetById = new Map(failedTargets.map((target) => [target.id, target]));
    state.candidates.forEach((candidate) => {
        const target = targetById.get(candidate.id);
        if (!target || stableHash(candidate.url || '') !== target.urlHash) return;
        candidate.diagnosticOnly = true;
        candidate.diagnosticReason = 'EXPIRED_SOURCE_REPLACED';
    });
    healthyFresh.forEach((candidate) => {
        candidate.autoEligible = false;
    });
    const recommended = selectRecommendedCandidate(healthyFresh);
    if (!recommended) return false;
    markAutoHandled(state, recommended, now);
    state.auto.suppressUntil = Math.max(
        state.auto.suppressUntil || 0,
        now + MEDIA_EXPIRY_AUTO_SUPPRESS_TAIL_MS
    );
    state.expiryRefresh = {
        ...(state.expiryRefresh || {}),
        fingerprint: '',
        inFlightFingerprint: '',
        inFlightUntil: 0,
        retryNotBefore: 0,
        pendingCandidateId: '',
        pendingUrlHash: '',
        pendingReason: '',
        pendingSince: 0,
        pendingRetryCount: 0
    };
    setBackgroundRefreshStatus(
        state,
        'detected',
        'STREAM_REFRESHED',
        'Znaleziono świeże źródło i zaktualizowano playlistę.',
        recommended
    );
    return true;
}

function forcedExpiryRefreshRetryContext(state, candidate, reason, now = Date.now()) {
    const expiryRefresh = state?.expiryRefresh || {};
    const normalizedReason = normalizeErrorCode(reason || 'PLAY_FAILURE', 'PLAY_FAILURE');
    const pendingSince = Number.isFinite(expiryRefresh.pendingSince) ? expiryRefresh.pendingSince : 0;
    const retryCount = Number.isInteger(expiryRefresh.pendingRetryCount) && expiryRefresh.pendingRetryCount >= 0
        ? expiryRefresh.pendingRetryCount
        : 0;
    const matches = Boolean(
        candidate &&
        expiryRefresh.pendingCandidateId === candidate.id &&
        expiryRefresh.pendingUrlHash === stableHash(candidate.url || '') &&
        normalizeErrorCode(expiryRefresh.pendingReason || 'PLAY_FAILURE', 'PLAY_FAILURE') === normalizedReason
    );
    const expired = matches && (
        pendingSince <= 0 ||
        pendingSince > now ||
        now - pendingSince >= MEDIA_EXPIRY_PENDING_TTL_MS
    );
    return {
        matches,
        expired,
        normalizedReason,
        pendingSince: matches && pendingSince > 0 ? pendingSince : now,
        retryCount: matches ? retryCount : 0
    };
}

function expiryRefreshPlan(state, now = Date.now()) {
    if (!state || !Number.isInteger(state.tabId) || !Array.isArray(state.candidates)) return null;
    const pendingCandidateId = typeof state.expiryRefresh?.pendingCandidateId === 'string'
        ? state.expiryRefresh.pendingCandidateId
        : '';
    const pendingCandidate = pendingCandidateId
        ? state.candidates.find((candidate) => candidate.id === pendingCandidateId) || null
        : null;
    const pendingRetry = pendingCandidate
        ? forcedExpiryRefreshRetryContext(state, pendingCandidate, state.expiryRefresh?.pendingReason, now)
        : null;
    if (
        pendingCandidate &&
        pendingRetry?.matches === true &&
        stableHash(pendingCandidate.url || '') === state.expiryRefresh?.pendingUrlHash &&
        candidateMediaExpiry(pendingCandidate) !== null &&
        pendingCandidate.diagnosticOnly !== true &&
        !isBlockedCandidate(pendingCandidate) &&
        !isExplicitlyIncompleteCandidate(pendingCandidate)
    ) {
        const reason = normalizeErrorCode(state.expiryRefresh?.pendingReason || 'PLAY_FAILURE', 'PLAY_FAILURE');
        const fingerprint = forcedExpiryRefreshFingerprint(state, pendingCandidate, reason);
        const inFlight = state.expiryRefresh?.inFlightFingerprint === fingerprint &&
            Number.isFinite(state.expiryRefresh?.inFlightUntil) && state.expiryRefresh.inFlightUntil > now;
        return {
            fingerprint,
            expiresAt: candidateMediaExpiry(pendingCandidate),
            candidateIds: [pendingCandidate.id],
            candidateId: pendingCandidate.id,
            reason,
            dueAt: pendingRetry.expired || pendingRetry.retryCount > MAX_MEDIA_EXPIRY_BUSY_RETRIES
                ? now + 250
                : Math.max(
                    Number.isFinite(state.expiryRefresh?.retryNotBefore) ? state.expiryRefresh.retryNotBefore : 0,
                    inFlight ? state.expiryRefresh.inFlightUntil + 250 : now + 250
                ),
            attempted: false,
            inFlight,
            forced: true,
            retryStopped: pendingRetry.expired || pendingRetry.retryCount > MAX_MEDIA_EXPIRY_BUSY_RETRIES
        };
    }
    const entries = state.candidates.map((candidate) => {
        const role = normalizeResolverRole(candidate?.resolverRole) ||
            normalizeResolverRole(candidate?.role) || classifyMediaRole(candidate);
        const expiresAt = candidateMediaExpiry(candidate);
        if (
            expiresAt === null ||
            candidate?.diagnosticOnly === true ||
            candidate?.playbackKind === 'yt-dlp-page' ||
            role === 'audio' ||
            isExplicitlyFailedCandidate(candidate) ||
            isExplicitlyIncompleteCandidate(candidate) ||
            isBlockedCandidate(candidate)
        ) return null;
        const identity = candidate?.sourceFamilyId || candidate?.groupKey || candidate?.id || 'media';
        return { expiresAt, identity: stableHash(String(identity)), candidateId: candidate.id };
    }).filter(Boolean).sort((left, right) =>
        left.expiresAt - right.expiresAt || left.identity.localeCompare(right.identity)
    );
    if (!entries.length) return null;

    const attempted = new Set(Array.isArray(state.expiryRefresh?.attemptedFingerprints)
        ? state.expiryRefresh.attemptedFingerprints
        : []);
    for (let index = 0; index < entries.length;) {
        const expiresAt = entries[index].expiresAt;
        const group = [];
        while (index < entries.length && entries[index].expiresAt === expiresAt) {
            group.push(entries[index]);
            index += 1;
        }
        const fingerprint = expiryRefreshFingerprint(
            group.map((entry) => `${entry.identity}:${entry.expiresAt}`).join('|')
        );
        if (attempted.has(fingerprint)) continue;
        const inFlight = state.expiryRefresh?.inFlightFingerprint === fingerprint &&
            Number.isFinite(state.expiryRefresh?.inFlightUntil) && state.expiryRefresh.inFlightUntil > now;
        const retryNotBefore = Number.isFinite(state.expiryRefresh?.retryNotBefore)
            ? state.expiryRefresh.retryNotBefore
            : 0;
        return {
            fingerprint,
            expiresAt,
            candidateIds: group.map((entry) => entry.candidateId),
            dueAt: Math.max(
                retryNotBefore,
                inFlight ? state.expiryRefresh.inFlightUntil + 250 : now + 250,
                expiresAt - MEDIA_EXPIRY_REFRESH_LEAD_MS
            ),
            attempted: false,
            inFlight
        };
    }
    return null;
}

function syncExpiryRefreshAlarm(state, now = Date.now()) {
    if (
        !Number.isInteger(state?.tabId) || state.tabId < 0 ||
        typeof chrome === 'undefined' || !chrome.alarms?.create
    ) return;
    const plan = expiryRefreshPlan(state, now);
    if (!plan || plan.attempted) {
        clearExpiryRefreshAlarm(state.tabId);
        clearExpiryRefreshKick(state.tabId);
        return;
    }
    if (plan.inFlight) {
        clearExpiryRefreshKick(state.tabId);
    } else if (plan.dueAt <= now + MEDIA_EXPIRY_BUSY_RETRY_MS) {
        kickDueExpiryRefresh(state.tabId, plan.dueAt - now);
    }
    try {
        // Packed extensions clamp alarms to at least 30 seconds. A zero-delay
        // kick handles a deadline that is already due while this worker is
        // alive; the alarm remains a crash/suspension fallback.
        const pending = chrome.alarms.create(expiryRefreshAlarmName(state.tabId), {
            when: Math.max(plan.dueAt, now + MEDIA_EXPIRY_REFRESH_LEAD_MS)
        });
        pending?.catch?.(() => undefined);
    } catch (_error) {
        // The exact PLAY preflight remains the final protection if Chrome cannot
        // schedule a background wake-up.
    }
}

function rescheduleExpiryRefresh(tabId, delayMs = 5_000) {
    if (
        !Number.isInteger(tabId) || tabId < 0 ||
        typeof chrome === 'undefined' || !chrome.alarms?.create
    ) return;
    try {
        const pending = chrome.alarms.create(expiryRefreshAlarmName(tabId), {
            when: Date.now() + Math.max(1_000, delayMs)
        });
        pending?.catch?.(() => undefined);
    } catch (_error) {
        // Best-effort retry; a later observation or manual PLAY can try again.
    }
}

function requestPageMediaRescan(tabId) {
    return new Promise((resolve) => {
        if (!chrome.tabs?.sendMessage) {
            resolve(false);
            return;
        }
        let settled = false;
        let settleTimer = null;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (settleTimer !== null) clearTimeout(settleTimer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(false), 1_500);
        try {
            // No frameId means every injected frame receives the rescan. Many
            // players keep the real <video> and Resource Timing entries inside
            // a cross-origin iframe rather than the top document.
            chrome.tabs.sendMessage(
                tabId,
                { type: PAGE_MEDIA_RESCAN_MESSAGE_TYPE, reason: 'stream-expiry' },
                (response) => {
                    const failed = Boolean(chrome.runtime.lastError);
                    if (failed || response?.ok !== true) {
                        finish(false);
                        return;
                    }
                    // tabs.sendMessage broadcasts to every frame but exposes
                    // only one response. Keep a bounded settlement window so a
                    // slower player iframe can commit its snapshot too.
                    settleTimer = setTimeout(() => finish(true), PAGE_MEDIA_RESCAN_SETTLE_MS);
                }
            );
        } catch (_error) {
            finish(false);
        }
    });
}

async function deferForcedExpiryRefresh(tabId, hostname, candidateId, reason) {
    if (typeof candidateId !== 'string' || !candidateId) return false;
    const queued = await mutateTabState(tabId, hostname, (current) => {
        const candidate = current.candidates.find((item) => item.id === candidateId);
        if (!candidate || candidateMediaExpiry(candidate) === null) return { queued: false };
        const now = Date.now();
        const retry = forcedExpiryRefreshRetryContext(current, candidate, reason, now);
        if (retry.expired || retry.retryCount >= MAX_MEDIA_EXPIRY_BUSY_RETRIES) {
            current.expiryRefresh = {
                ...(current.expiryRefresh || {}),
                fingerprint: '',
                attemptedAt: now,
                inFlightFingerprint: '',
                inFlightUntil: 0,
                retryNotBefore: 0,
                pendingCandidateId: '',
                pendingUrlHash: '',
                pendingReason: '',
                pendingSince: 0,
                pendingRetryCount: 0
            };
            current.auto.pendingDueAt = null;
            setBackgroundRefreshStatus(
                current,
                'error',
                'STREAM_REFRESH_FAILED',
                'Resolver pozostaje zajęty; automatyczne odświeżanie zatrzymano. Spróbuj ponownie ręcznie.',
                candidate
            );
            return { queued: false, exhausted: true };
        }
        const retryAt = now + MEDIA_EXPIRY_BUSY_RETRY_MS;
        current.expiryRefresh = {
            ...(current.expiryRefresh || {}),
            fingerprint: '',
            attemptedAt: 0,
            inFlightFingerprint: '',
            inFlightUntil: 0,
            retryNotBefore: retryAt,
            pendingCandidateId: candidate.id,
            pendingUrlHash: stableHash(candidate.url || ''),
            pendingReason: retry.normalizedReason,
            pendingSince: retry.pendingSince,
            pendingRetryCount: retry.retryCount + 1
        };
        current.auto.pendingDueAt = null;
        current.auto.suppressUntil = Math.max(current.auto.suppressUntil || 0, retryAt);
        setBackgroundRefreshStatus(
            current,
            'resolving',
            'STREAM_REFRESH_REQUESTED',
            'Inne rozpoznawanie jest w toku; dokładne źródło spróbuje odświeżyć się ponownie za chwilę.',
            candidate
        );
        return { queued: true };
    });
    if (queued.result?.queued) rescheduleExpiryRefresh(tabId, MEDIA_EXPIRY_BUSY_RETRY_MS);
    return queued.result?.queued === true;
}

async function stopExhaustedForcedExpiryRefresh(tabId, hostname, candidateId, reason) {
    const stopped = await mutateTabState(tabId, hostname, (current) => {
        const candidate = current.candidates.find((item) => item.id === candidateId) || null;
        if (!candidate) return { stopped: false };
        const retry = forcedExpiryRefreshRetryContext(current, candidate, reason);
        if (!retry.matches || (!retry.expired && retry.retryCount <= MAX_MEDIA_EXPIRY_BUSY_RETRIES)) {
            return { stopped: false };
        }
        current.expiryRefresh = {
            ...(current.expiryRefresh || {}),
            fingerprint: '',
            attemptedAt: Date.now(),
            inFlightFingerprint: '',
            inFlightUntil: 0,
            retryNotBefore: 0,
            pendingCandidateId: '',
            pendingUrlHash: '',
            pendingReason: '',
            pendingSince: 0,
            pendingRetryCount: 0
        };
        current.auto.pendingDueAt = null;
        setBackgroundRefreshStatus(
            current,
            'error',
            'STREAM_REFRESH_FAILED',
            'Resolver pozostaje zajęty; automatyczne odświeżanie zatrzymano. Spróbuj ponownie ręcznie.',
            candidate
        );
        return { stopped: true };
    });
    return stopped.result?.stopped === true;
}

async function deferScheduledExpiryRefresh(
    tabId,
    hostname,
    expectedFingerprint,
    expectedCandidateId,
    expectedUrlHash
) {
    const queued = await mutateTabState(tabId, hostname, (current) => {
        const now = Date.now();
        const livePlan = expiryRefreshPlan(current, now);
        const candidate = current.candidates.find((item) =>
            item.id === expectedCandidateId && stableHash(item.url || '') === expectedUrlHash
        ) || null;
        const candidateStillEligible = Boolean(
            candidate &&
            candidateMediaExpiry(candidate) !== null &&
            candidate.diagnosticOnly !== true &&
            !isBlockedCandidate(candidate) &&
            !isExplicitlyIncompleteCandidate(candidate)
        );
        const livePlanMatches = Boolean(
            livePlan &&
            !livePlan.forced &&
            livePlan.fingerprint === expectedFingerprint &&
            livePlan.candidateIds.includes(candidate?.id)
        );
        const expiredSincePlan = candidateStillEligible && candidateMediaExpiry(candidate) <= now;
        if (
            !candidateStillEligible ||
            (!livePlanMatches && !expiredSincePlan)
        ) {
            current.expiryRefresh = {
                ...(current.expiryRefresh || {}),
                fingerprint: '',
                attemptedAt: now,
                inFlightFingerprint: '',
                inFlightUntil: 0,
                retryNotBefore: 0,
                pendingCandidateId: '',
                pendingUrlHash: '',
                pendingReason: '',
                pendingSince: 0,
                pendingRetryCount: 0
            };
            current.auto.pendingDueAt = null;
            setBackgroundRefreshStatus(
                current,
                'error',
                'STREAM_REFRESH_FAILED',
                'Źródło zmieniło się przed ponowieniem odświeżania. Spróbuj ponownie ręcznie.',
                candidate
            );
            return { queued: false, stopped: true };
        }
        const retry = forcedExpiryRefreshRetryContext(current, candidate, 'STREAM_URL_EXPIRED', now);
        const retryAt = now + MEDIA_EXPIRY_BUSY_RETRY_MS;
        current.expiryRefresh = {
            ...(current.expiryRefresh || {}),
            fingerprint: livePlan.fingerprint,
            attemptedAt: 0,
            inFlightFingerprint: '',
            inFlightUntil: 0,
            retryNotBefore: retryAt,
            pendingCandidateId: candidate.id,
            pendingUrlHash: stableHash(candidate.url || ''),
            pendingReason: retry.normalizedReason,
            pendingSince: retry.pendingSince,
            pendingRetryCount: retry.retryCount + 1
        };
        current.auto.pendingDueAt = null;
        current.auto.suppressUntil = Math.max(current.auto.suppressUntil || 0, retryAt);
        setBackgroundRefreshStatus(
            current,
            'resolving',
            'STREAM_REFRESH_REQUESTED',
            'Inne rozpoznawanie jest w toku; dokładne źródło spróbuje odświeżyć się ponownie za chwilę.',
            candidate
        );
        return { queued: true };
    });
    if (queued.result?.queued) rescheduleExpiryRefresh(tabId, MEDIA_EXPIRY_BUSY_RETRY_MS);
    return queued.result?.queued === true;
}

async function refreshMediaSources(tabId, options = {}) {
    let force = options.force === true;
    let forcedCandidateId = typeof options.candidateId === 'string' ? options.candidateId : '';
    let forceReason = normalizeErrorCode(options.reason || 'PLAY_FAILURE', 'PLAY_FAILURE');
    if (!Number.isInteger(tabId) || tabId < 0 || removedTabs.has(tabId)) return false;
    if (!force && !await isTabCurrentlyActive(tabId)) return false;

    const state = await getCanonicalTabState(tabId);
    const initialNow = Date.now();
    const initialPlan = expiryRefreshPlan(state, initialNow);
    if (!force && initialPlan?.forced === true && initialPlan.retryStopped === true) {
        clearExpiryRefreshKick(tabId);
        await stopExhaustedForcedExpiryRefresh(
            tabId,
            state.hostname,
            initialPlan.candidateId,
            initialPlan.reason
        );
        return false;
    }
    if (!force && initialPlan?.forced === true && initialPlan.inFlight === true) {
        syncExpiryRefreshAlarm(state, initialNow);
        return false;
    }
    if (!force && initialPlan?.forced === true) {
        force = true;
        forcedCandidateId = initialPlan.candidateId;
        forceReason = initialPlan.reason;
    }
    if (
        !force &&
        (
            !initialPlan ||
            initialPlan.attempted ||
            initialPlan.inFlight ||
            initialPlan.dueAt > initialNow + 1_000
        )
    ) {
        syncExpiryRefreshAlarm(state, initialNow);
        return false;
    }
    if (
        activeExpiryRefreshTabId !== null ||
        activeResolveRequests.size > 0 ||
        activePageReadyResolveTabId !== null ||
        (!force && activePlayRequests.has(tabId))
    ) {
        clearExpiryRefreshKick(tabId);
        if (force && forcedCandidateId) {
            await deferForcedExpiryRefresh(tabId, state.hostname, forcedCandidateId, forceReason);
        } else if (initialPlan) {
            const firstTarget = state.candidates.find((candidate) =>
                initialPlan.candidateIds.includes(candidate.id)
            ) || null;
            await deferScheduledExpiryRefresh(
                tabId,
                state.hostname,
                initialPlan.fingerprint,
                firstTarget?.id || '',
                firstTarget ? stableHash(firstTarget.url || '') : ''
            );
        }
        return false;
    }

    activeExpiryRefreshTabId = tabId;
    clearAutoTimer(tabId);
    const navigationEpoch = currentTabEpoch(tabId);
    let marked = null;
    try {
        marked = await mutateTabState(tabId, state.hostname, (current) => {
            if (navigationEpoch !== currentTabEpoch(tabId)) return { proceed: false };
            const liveNow = Date.now();
            const livePlan = expiryRefreshPlan(current, liveNow);
            if (
                !force &&
                (
                    !livePlan ||
                    livePlan.attempted ||
                    livePlan.inFlight ||
                    livePlan.dueAt > liveNow + 1_000
                )
            ) return { proceed: false };
            const forcedTarget = force && forcedCandidateId
                ? current.candidates.find((candidate) => candidate.id === forcedCandidateId) || null
                : null;
            if (force && !forcedTarget) {
                current.expiryRefresh.pendingCandidateId = '';
                current.expiryRefresh.pendingUrlHash = '';
                current.expiryRefresh.pendingReason = '';
                current.expiryRefresh.pendingSince = 0;
                current.expiryRefresh.pendingRetryCount = 0;
                current.expiryRefresh.retryNotBefore = 0;
                return { proceed: false };
            }
            const targetIds = forcedTarget
                ? [forcedTarget.id]
                : (livePlan?.candidateIds || current.candidates
                    .filter((candidate) => isCandidateExpired(candidate))
                    .map((candidate) => candidate.id));
            const targets = targetIds
                .map((candidateId) => current.candidates.find((candidate) => candidate.id === candidateId))
                .filter(Boolean)
                .map((candidate) => ({
                    id: candidate.id,
                    urlHash: stableHash(candidate.url || ''),
                    expiresAt: candidateMediaExpiry(candidate),
                    sourceFamilyId: candidate.sourceFamilyId || sourceFamilyFingerprint(candidate)
                }));
            const fingerprint = forcedTarget
                ? forcedExpiryRefreshFingerprint(current, forcedTarget, forceReason)
                : (livePlan?.fingerprint || expiryRefreshFingerprint([
                    current.materialScope?.id || current.pageIdentity || current.hostname,
                    forceReason
                ].join('|')));
            const pendingRetry = forcedTarget
                ? forcedExpiryRefreshRetryContext(current, forcedTarget, forceReason, liveNow)
                : null;
            current.expiryRefresh = {
                fingerprint,
                attemptedAt: 0,
                attemptedFingerprints: current.expiryRefresh?.attemptedFingerprints || [],
                inFlightFingerprint: fingerprint,
                inFlightUntil: Date.now() + RESOLVE_TIMEOUT_MS + MEDIA_EXPIRY_AUTO_SUPPRESS_TAIL_MS,
                retryNotBefore: 0,
                pendingCandidateId: forcedTarget?.id || '',
                pendingUrlHash: forcedTarget ? stableHash(forcedTarget.url || '') : '',
                pendingReason: forcedTarget ? forceReason : '',
                pendingSince: forcedTarget
                    ? pendingRetry.pendingSince
                    : 0,
                pendingRetryCount: forcedTarget ? pendingRetry.retryCount : 0
            };
            current.auto.pendingDueAt = null;
            current.auto.suppressUntil = Math.max(
                current.auto.suppressUntil || 0,
                Date.now() + RESOLVE_TIMEOUT_MS + MEDIA_EXPIRY_AUTO_SUPPRESS_TAIL_MS
            );
            setBackgroundRefreshStatus(
                current,
                'resolving',
                'STREAM_REFRESH_RUNNING',
                'Odświeżam źródła materiału w tle; MPV nie zostanie uruchomiony automatycznie.'
            );
            return {
                proceed: true,
                fingerprint,
                materialScope: current.materialScope?.id || '',
                startedAt: Date.now(),
                refreshTargets: targets
            };
        });
        if (!marked.result?.proceed) return false;

        await requestPageMediaRescan(tabId);
        if (navigationEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) return false;
        if (
            activeResolveRequests.size > 0 ||
            activePageReadyResolveTabId !== null ||
            activePlayRequests.has(tabId)
        ) {
            throw new WorkerError(
                activePlayRequests.has(tabId) ? 'PLAY_IN_PROGRESS' : 'RESOLVE_IN_PROGRESS',
                'Inna operacja odtwarzania lub rozpoznawania jest już w toku.'
            );
        }
        const resolved = await resolvePage(tabId, {
            includeFreshCandidateIds: true,
            source: 'refresh',
            expectedMaterialScope: marked.result.materialScope
        });
        const finalized = await mutateTabState(tabId, state.hostname, (current) => {
            if (navigationEpoch !== currentTabEpoch(tabId)) return { refreshed: false };
            const freshIds = new Set(resolved.freshCandidateIds || []);
            const targets = new Map(marked.result.refreshTargets.map((target) => [target.id, target]));
            const targetFamilies = new Set(marked.result.refreshTargets
                .map((target) => target.sourceFamilyId)
                .filter(Boolean));
            const refreshedOriginalIds = new Set(current.candidates.filter((candidate) => {
                const target = targets.get(candidate.id);
                return target &&
                    stableHash(candidate.url || '') !== target.urlHash &&
                    !isExplicitlyFailedCandidate(candidate);
            }).map((candidate) => candidate.id));
            const healthyFresh = current.candidates.filter((candidate) =>
                (
                    refreshedOriginalIds.has(candidate.id) ||
                    (freshIds.has(candidate.id) && !targets.has(candidate.id)) ||
                    (
                        !targets.has(candidate.id) &&
                        targetFamilies.has(candidate.sourceFamilyId || sourceFamilyFingerprint(candidate)) &&
                        Number(candidate.lastSeenAt) >= Number(marked.result.startedAt)
                    )
                ) &&
                candidate.diagnosticOnly !== true &&
                !isBlockedCandidate(candidate) &&
                !isExplicitlyFailedCandidate(candidate)
            );
            // The page rescan may have replaced a signed transport before the
            // external resolver finishes. A healthy, scoped replacement is the
            // success signal even when Streamlink/yt-dlp subsequently reports
            // an empty result.
            const refreshed = healthyFresh.length > 0;
            current.auto.pendingDueAt = null;
            current.auto.suppressUntil = Math.max(
                current.auto.suppressUntil || 0,
                Date.now() + MEDIA_EXPIRY_AUTO_SUPPRESS_TAIL_MS
            );
            current.expiryRefresh = {
                fingerprint: '',
                attemptedAt: Date.now(),
                attemptedFingerprints: [...new Set([
                    ...(current.expiryRefresh?.attemptedFingerprints || []),
                    marked.result.fingerprint
                ])].slice(-MAX_CANDIDATES),
                inFlightFingerprint: '',
                inFlightUntil: 0,
                retryNotBefore: 0,
                pendingCandidateId: '',
                pendingUrlHash: '',
                pendingReason: '',
                pendingSince: 0,
                pendingRetryCount: 0
            };
            if (refreshed) {
                const targetIds = new Set(targets.keys());
                current.candidates.forEach((candidate) => {
                    if (!targetIds.has(candidate.id) || refreshedOriginalIds.has(candidate.id)) return;
                    candidate.diagnosticOnly = true;
                    candidate.diagnosticReason = 'EXPIRED_SOURCE_REPLACED';
                });
                const recommended = selectRecommendedCandidate(healthyFresh);
                setBackgroundRefreshStatus(
                    current,
                    'detected',
                    'STREAM_REFRESHED',
                    'Znaleziono świeże źródło i zaktualizowano playlistę.',
                    recommended
                );
            } else {
                markExpiryRefreshTargetsFailed(current, marked.result.refreshTargets);
                setBackgroundRefreshStatus(
                    current,
                    'error',
                    'STREAM_REFRESH_FAILED',
                    'Nie znaleziono jeszcze świeżego źródła. Wygasły wpis pozostaje ukryty.'
                );
            }
            return { refreshed };
        });
        return finalized.result?.refreshed === true;
    } catch (rawError) {
        const error = toWorkerError(rawError);
        const transientBusy = ['PLAY_IN_PROGRESS', 'RESOLVE_IN_PROGRESS', 'RESOLVER_BUSY'].includes(error.code);
        let retryQueued = false;
        if (marked?.result?.proceed && navigationEpoch === currentTabEpoch(tabId) && !removedTabs.has(tabId)) {
            const recovered = await mutateTabState(tabId, state.hostname, (current) => {
                const now = Date.now();
                let shouldRetry = false;
                let retryStopped = false;
                current.auto.pendingDueAt = null;
                current.auto.suppressUntil = Math.max(
                    current.auto.suppressUntil || 0,
                    now + MEDIA_EXPIRY_AUTO_SUPPRESS_TAIL_MS
                );
                if (
                    current.expiryRefresh?.inFlightFingerprint === marked.result.fingerprint ||
                    current.expiryRefresh?.fingerprint === marked.result.fingerprint
                ) {
                    const retryTarget = Array.isArray(marked.result.refreshTargets)
                        ? marked.result.refreshTargets[0] || null
                        : null;
                    const pendingCandidate = transientBusy && retryTarget
                        ? current.candidates.find((candidate) =>
                            candidate.id === retryTarget.id &&
                            stableHash(candidate.url || '') === retryTarget.urlHash
                        ) || null
                        : null;
                    const pendingReason = force ? forceReason : 'STREAM_URL_EXPIRED';
                    const pendingRetry = pendingCandidate
                        ? forcedExpiryRefreshRetryContext(current, pendingCandidate, pendingReason, now)
                        : null;
                    retryStopped = transientBusy && (
                        !pendingCandidate ||
                        pendingRetry.expired ||
                        pendingRetry.retryCount >= MAX_MEDIA_EXPIRY_BUSY_RETRIES
                    );
                    shouldRetry = transientBusy && !retryStopped;
                    current.expiryRefresh = {
                        fingerprint: shouldRetry ? marked.result.fingerprint : '',
                        attemptedAt: shouldRetry ? 0 : now,
                        attemptedFingerprints: shouldRetry
                            ? (current.expiryRefresh.attemptedFingerprints || [])
                            : [...new Set([
                                ...(current.expiryRefresh.attemptedFingerprints || []),
                                marked.result.fingerprint
                        ])].slice(-MAX_CANDIDATES),
                        inFlightFingerprint: '',
                        inFlightUntil: 0,
                        retryNotBefore: shouldRetry ? now + MEDIA_EXPIRY_BUSY_RETRY_MS : 0,
                        pendingCandidateId: shouldRetry && pendingCandidate ? pendingCandidate.id : '',
                        pendingUrlHash: shouldRetry && pendingCandidate ? stableHash(pendingCandidate.url || '') : '',
                        pendingReason: shouldRetry && pendingRetry ? pendingRetry.normalizedReason : '',
                        pendingSince: shouldRetry && pendingRetry ? pendingRetry.pendingSince : 0,
                        pendingRetryCount: shouldRetry && pendingRetry ? pendingRetry.retryCount + 1 : 0
                    };
                    if (!shouldRetry && error.code !== 'HOST_TOO_OLD') {
                        markExpiryRefreshTargetsFailed(current, marked.result.refreshTargets);
                    }
                }
                setBackgroundRefreshStatus(
                    current,
                    shouldRetry ? 'resolving' : 'error',
                    shouldRetry
                        ? 'STREAM_REFRESH_REQUESTED'
                        : error.code === 'HOST_TOO_OLD' ? 'HOST_TOO_OLD' : 'STREAM_REFRESH_FAILED',
                    shouldRetry
                        ? 'Resolver jest zajęty; odświeżenie źródła spróbuje ponownie za chwilę.'
                        : retryStopped
                            ? 'Resolver pozostaje zajęty; automatyczne odświeżanie zatrzymano. Spróbuj ponownie ręcznie.'
                        : error.code === 'HOST_TOO_OLD'
                            ? error.message
                        : 'Nie udało się odświeżyć źródła. Wygasły wpis pozostaje ukryty.'
                );
                return { retryQueued: shouldRetry };
            }).catch(() => null);
            retryQueued = recovered?.result?.retryQueued === true;
        }
        if (retryQueued) rescheduleExpiryRefresh(tabId, MEDIA_EXPIRY_BUSY_RETRY_MS);
        return false;
    } finally {
        if (activeExpiryRefreshTabId === tabId) activeExpiryRefreshTabId = null;
    }
}

function processExpiryRefreshAlarm(alarm) {
    const match = new RegExp(`^${MEDIA_EXPIRY_ALARM_PREFIX}(\\d+)$`).exec(alarm?.name || '');
    if (!match) return;
    const tabId = Number(match[1]);
    runAfterStartupRecovery(() => refreshMediaSources(tabId).catch(() => undefined));
}

function rememberActiveTab(tabId, windowId) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const key = Number.isInteger(windowId) ? windowId : 0;
    activeTabByWindow.set(key, tabId);
}

function queryActiveChromeTabs() {
    return new Promise((resolve) => {
        if (!chrome.tabs?.query) {
            resolve([]);
            return;
        }
        let settled = false;
        const finish = (tabs) => {
            if (settled) return;
            settled = true;
            resolve(Array.isArray(tabs) ? tabs : []);
        };
        const timer = setTimeout(() => finish([]), 1_000);
        try {
            chrome.tabs.query({ active: true }, (tabs) => {
                clearTimeout(timer);
                if (chrome.runtime.lastError) finish([]);
                else finish(tabs);
            });
        } catch (_error) {
            clearTimeout(timer);
            finish([]);
        }
    });
}

async function isTabCurrentlyActive(tabId) {
    const activeTabs = await queryActiveChromeTabs();
    if (activeTabs.length) return activeTabs.some((tab) => tab?.id === tabId);
    return [...activeTabByWindow.values()].includes(tabId);
}

async function schedulePageReadyResolve(tabId, pageUrl = '') {
    const trustedPageUrl = pageUrl || await resolveTabUrl(tabId);
    const scope = materialScopeForUrl(trustedPageUrl);
    if (!isResolvablePageReadyScope(scope) || !await isTabCurrentlyActive(tabId)) return false;

    const state = await getCanonicalTabState(tabId);
    if (state.materialScope?.id !== scope.id) return false;
    const currentResolverReady = state.resolver?.materialScope === scope.id &&
        state.resolver?.state === 'found' &&
        state.candidates.some((candidate) =>
            candidate.resolverCurrent === true &&
            candidate.materialScope === scope.id &&
            candidate.diagnosticOnly !== true
        );
    if (currentResolverReady || (
        state.resolver?.pageReadyScope === scope.id &&
        state.resolver?.pageReadyState === 'done'
    )) return false;
    if (pageReadyResolveTimers.has(tabId) || activeResolveRequests.has(tabId)) return false;

    await mutateTabState(tabId, state.hostname, (current) => {
        if (current.materialScope?.id !== scope.id) return;
        current.resolver = {
            ...(current.resolver || {}),
            state: 'scheduled',
            adapter: scope.platform,
            source: 'page_ready',
            materialScope: scope.id,
            pageReadyScope: scope.id,
            pageReadyState: 'scheduled',
            updatedAt: Date.now()
        };
        setStateStatus(
            current,
            'resolving',
            'PAGE_READY_SCHEDULED',
            `Przygotowuję rozpoznanie bieżącego materiału ${scope.platform === 'tvp' ? 'TVP' : 'YouTube'}; niczego nie uruchomię automatycznie.`
        );
    });

    const timer = setTimeout(() => {
        pageReadyResolveTimers.delete(tabId);
        void (async () => {
            if (!await isTabCurrentlyActive(tabId)) return;
            const currentUrl = await resolveTabUrl(tabId);
            if (pageNavigationIdentity(currentUrl) !== scope.id) return;
            const currentState = await loadTabState(tabId, normalizeHostname(currentUrl));
            if (
                currentState.resolver?.pageReadyScope === scope.id &&
                currentState.resolver?.pageReadyState === 'done'
            ) return;
            if (activePageReadyResolveTabId !== null || activeResolveRequests.size > 0) {
                await schedulePageReadyResolve(tabId, currentUrl);
                return;
            }
            activePageReadyResolveTabId = tabId;
            try {
                await resolvePage(tabId, {
                    source: 'page_ready',
                    expectedMaterialScope: scope.id
                });
            } catch (_error) {
                // resolvePage records a bounded, actionable state for the popup.
            } finally {
                if (activePageReadyResolveTabId === tabId) activePageReadyResolveTabId = null;
            }
        })().catch(() => undefined);
    }, PAGE_READY_RESOLVE_DEBOUNCE_MS);
    pageReadyResolveTimers.set(tabId, timer);
    return true;
}

function isAutoPlayable(candidate, now = Date.now()) {
    return isConfirmedAutoTransport(candidate) && !isGenericPrerollProvisional(candidate, now);
}

function markAutoHandled(state, candidate, now = Date.now()) {
    state.auto.pendingDueAt = null;
    state.auto.lastFingerprint = candidate.groupKey;
    state.auto.lastCandidateId = candidate.id;
    state.auto.lastAttemptAt = now;
    state.auto.cooldownUntil = Math.max(state.auto.cooldownUntil || 0, now + AUTO_COOLDOWN_MS);
    state.auto.retryFingerprint = null;
    state.auto.retryCount = 0;
}

function shouldPreserveConfirmedPlaying(state) {
    if (state.status?.state !== 'playing' || state.status?.confirmed !== true) return false;
    const fingerprint = state.auto?.lastFingerprint;
    if (!fingerprint) return false;
    const handledCandidate = state.candidates.find((item) => item.groupKey === fingerprint);
    if (!handledCandidate) return false;
    if (
        handledCandidate.networkError ||
        (Number.isInteger(handledCandidate.statusCode) && handledCandidate.statusCode >= 400)
    ) return false;
    // A player commonly requests variants, alternate formats and late ad
    // assets after the master has already opened. Treat auto-launch as a
    // once-per-page-session action; a navigation or explicit clear creates a
    // fresh session, while another manual choice remains available in popup.
    return true;
}

function setBackgroundRefreshStatus(state, nextState, code, message, candidate = null, extra = {}) {
    if (shouldPreserveConfirmedPlaying(state)) {
        addEvent(state, 'status', code, message, candidate, extra);
        return;
    }
    setStateStatus(state, nextState, code, message, candidate, extra);
}

function setResolverOperationStatus(state, source, nextState, code, message, candidate = null, extra = {}) {
    if (source === 'refresh') {
        setBackgroundRefreshStatus(state, nextState, code, message, candidate, extra);
        return;
    }
    setStateStatus(state, nextState, code, message, candidate, extra);
}

async function attemptAutoLaunch(tabId) {
    if (activeExpiryRefreshTabId === tabId) {
        clearAutoTimer(tabId);
        return false;
    }
    const stateBefore = await getCanonicalTabState(tabId);
    const selection = await mutateTabState(tabId, stateBefore.hostname, async (state) => {
        const [policy, sourcePreferences] = await Promise.all([
            readSiteAuto(state.hostname),
            readSiteSourcePreferences(state.hostname)
        ]);
        const now = Date.now();
        state.auto.enabled = policy.enabled;
        applySourcePreferencesToState(state, sourcePreferences);
        if (
            activeExpiryRefreshTabId === tabId ||
            (Number.isFinite(state.auto.suppressUntil) && state.auto.suppressUntil > now)
        ) {
            state.auto.pendingDueAt = null;
            return { action: 'none' };
        }
        if (!policy.enabled) {
            state.auto.pendingDueAt = null;
            const candidate = state.candidates.find((item) =>
                item.diagnosticOnly !== true && !isBlockedCandidate(item)
            ) || null;
            if (candidate) setStateStatus(state, 'auto_disabled', 'SITE_AUTO_DISABLED', 'Auto-otwieranie jest wyłączone dla tej witryny.', candidate);
            return { action: 'none' };
        }
        const activePlay = activePlayRequests.get(tabId);
        if (activePlay?.source === 'manual') {
            const manualCandidate = state.candidates.find((item) => item.id === activePlay.candidateId);
            if (manualCandidate) markAutoHandled(state, manualCandidate, now);
            else state.auto.pendingDueAt = null;
            return { action: 'none' };
        }
        if (activePlay) {
            state.auto.pendingDueAt = now + 1_000;
            return { action: 'reschedule', dueAt: state.auto.pendingDueAt };
        }
        if (state.auto.pendingDueAt && state.auto.pendingDueAt > now) {
            return { action: 'reschedule', dueAt: state.auto.pendingDueAt };
        }
        if (state.auto.cooldownUntil > now) {
            state.auto.pendingDueAt = state.auto.cooldownUntil;
            return { action: 'reschedule', dueAt: state.auto.cooldownUntil };
        }

        state.candidates.forEach((candidate) => {
            candidate.prerollProvisional = isGenericPrerollProvisional(candidate, now);
        });
        const hasSafeCurrentCandidate = state.candidates.some((candidate) =>
            isAutoPlayable(candidate, now) && hasCurrentPlayerEvidence(candidate)
        );
        const activeGuardedCandidates = hasSafeCurrentCandidate
            ? []
            : state.candidates.filter((candidate) =>
                isConfirmedAutoTransport(candidate) &&
                isGenericPrerollProvisional(candidate, now) &&
                hasCurrentPlayerEvidence(candidate)
            ).sort(compareCandidates);
        if (activeGuardedCandidates.length) {
            const guardDueAt = activeGuardedCandidates
                .map((candidate) => genericPrerollGuardDueAt(candidate, now))
                .filter(Number.isFinite)
                .sort((left, right) => left - right)[0] || null;
            state.auto.pendingDueAt = guardDueAt;
            setStateStatus(
                state,
                'detected',
                'AWAITING_CONTENT_PHASE',
                'Odtwarzacz jest w fazie początkowej. Czekam na właściwy materiał zamiast otwierać możliwy preroll.',
                activeGuardedCandidates[0]
            );
            return guardDueAt
                ? { action: 'reschedule', dueAt: guardDueAt }
                : { action: 'none' };
        }
        const playableCandidates = state.candidates.filter((candidate) =>
            isAutoPlayable(candidate, now) && !(
                state.auto.retryFingerprint === candidate.groupKey &&
                state.auto.retryCount > MAX_AUTO_RETRIES_PER_STREAM
            )
        ).sort(compareCandidates);
        let candidate = playableCandidates[0];
        if (candidate && state.auto.lastFingerprint === candidate.groupKey) {
            candidate = playableCandidates.find((item) =>
                item.groupKey !== state.auto.lastFingerprint &&
                item.firstSeenAt > state.auto.lastAttemptAt
            );
        }
        state.auto.pendingDueAt = null;
        if (!candidate) {
            const guardedCandidates = state.candidates.filter((item) =>
                isConfirmedAutoTransport(item) && isGenericPrerollProvisional(item, now)
            ).sort(compareCandidates);
            if (guardedCandidates.length) {
                const guardDueAt = guardedCandidates
                    .map((item) => genericPrerollGuardDueAt(item, now))
                    .filter(Number.isFinite)
                    .sort((left, right) => left - right)[0] || null;
                state.auto.pendingDueAt = guardDueAt;
                setStateStatus(
                    state,
                    'detected',
                    'AWAITING_CONTENT_PHASE',
                    'Odtwarzacz jest w fazie początkowej. Czekam na właściwy materiał zamiast otwierać możliwy preroll.',
                    guardedCandidates[0]
                );
                return guardDueAt
                    ? { action: 'reschedule', dueAt: guardDueAt }
                    : { action: 'none' };
            }
            const visibleCandidate = state.candidates.find((item) =>
                item.diagnosticOnly !== true && !isBlockedCandidate(item)
            ) || null;
            setStateStatus(
                state,
                'detected',
                'NO_SAFE_AUTO_CANDIDATE',
                'Wykryto media, ale żaden kandydat nie jest jeszcze bezpieczny do auto-otwarcia.',
                visibleCandidate
            );
            return { action: 'none' };
        }

        const fingerprint = candidate.groupKey;

        state.auto.lastFingerprint = fingerprint;
        state.auto.lastCandidateId = candidate.id;
        state.auto.lastAttemptAt = now;
        state.auto.cooldownUntil = now + AUTO_COOLDOWN_MS;
        return { action: 'play', candidateId: candidate.id, mode: policy.defaultPlayMode };
    });

    if (selection.result?.action === 'reschedule') armAutoTimer(tabId, selection.result.dueAt);
    if (selection.result?.action === 'play') {
        try {
            await playCandidate(tabId, selection.result.candidateId, selection.result.mode, 'auto');
        } catch (_error) {
            // playCandidate writes the actionable error into canonical tab state.
        }
    }
}

// ─── Native Messaging protocol v2 ───────────────────────────────────────────

function nextRequestId(action) {
    return `${action}-${Date.now().toString(36)}-${stableHash(`${Math.random()}:${Date.now()}`)}`;
}

function mapRuntimeError(message) {
    const normalized = String(message || '').toLowerCase();
    if (normalized.includes('native messaging host') && normalized.includes('not found')) {
        return new WorkerError('NATIVE_HOST_NOT_FOUND', 'Nie znaleziono hosta MPV. Uruchom instalator integracji natywnej.');
    }
    if (normalized.includes('forbidden') || normalized.includes('not allowed')) {
        return new WorkerError('NATIVE_HOST_FORBIDDEN', 'Chrome odmówił rozszerzeniu dostępu do hosta MPV.');
    }
    if (normalized.includes('disconnected') || normalized.includes('closed')) {
        return new WorkerError('NATIVE_HOST_DISCONNECTED', 'Host MPV zakończył połączenie przed odpowiedzią.');
    }
    return new WorkerError('NATIVE_MESSAGING_ERROR', 'Nie udało się połączyć z hostem MPV.');
}

function localizedHostError(code) {
    const messages = {
        INVALID_MESSAGE: 'Host otrzymał uszkodzoną wiadomość.',
        MESSAGE_TOO_LARGE: 'Wiadomość do hosta MPV przekroczyła dozwolony rozmiar.',
        INVALID_REQUEST: 'Żądanie nie pasuje do protokołu hosta MPV.',
        UNSUPPORTED_PROTOCOL: 'Host MPV używa nieobsługiwanej wersji protokołu.',
        UNSUPPORTED_ACTION: 'Host MPV nie obsługuje tej operacji.',
        INVALID_URL: 'Adres strumienia nie jest poprawnym adresem HTTP lub HTTPS.',
        INVALID_HEADER: 'Wykryty nagłówek strumienia jest niepoprawny.',
        MPV_NOT_FOUND: 'Nie znaleziono programu mpv w systemie.',
        MPV_EXEC_FAILED: 'Nie udało się uruchomić programu mpv.',
        MPV_EXITED_EARLY: 'MPV zakończył działanie przed potwierdzeniem strumienia.',
        MPV_IPC_TIMEOUT: 'MPV nie udostępnił sterowania IPC przed upływem limitu czasu.',
        MPV_CONFIRM_TIMEOUT: 'MPV nie potwierdził strumienia przed upływem limitu czasu.',
        MPV_DEMUXER_TIMEOUT: 'MPV przyjął adres, ale nie zdołał otworzyć manifestu ani strumienia przed upływem limitu czasu.',
        MPV_LOAD_FAILED: 'MPV zgłosił błąd ładowania strumienia.',
        STREAM_URL_EXPIRED: 'Podpisany adres strumienia wygasł. Rozszerzenie odświeża źródła w tle.',
        MPV_IPC_REJECTED: 'MPV odrzucił polecenie sterujące.',
        MPV_IPC_PROTOCOL: 'MPV zwrócił niepoprawną odpowiedź IPC.',
        QUEUE_BUSY: 'Kolejka MPV jest zajęta. Spróbuj ponownie za chwilę.',
        QUEUE_UNRESPONSIVE: 'Bieżąca kolejka MPV nie odpowiada.',
        QUEUE_SOCKET_UNSAFE: 'Gniazdo kolejki MPV nie spełnia wymagań bezpieczeństwa.',
        RUNTIME_UNAVAILABLE: 'Nie jest dostępny prywatny katalog roboczy dla MPV.',
        RUNTIME_INSECURE: 'Katalog roboczy MPV ma niebezpieczne uprawnienia.',
        RESOLVER_BUSY: 'Inne rozpoznawanie strumieni jest już w toku.',
        RESOLVER_UNAVAILABLE: 'Nie znaleziono zgodnego Streamlink ani yt-dlp.',
        RESOLVER_TOO_OLD: 'Zainstalowany resolver wymaga aktualizacji.',
        RESOLVER_EXEC_FAILED: 'Nie udało się bezpiecznie uruchomić resolvera.',
        RESOLVER_INVALID_OUTPUT: 'Resolver zwrócił niepoprawną odpowiedź.',
        RESOLVER_EXITED: 'Resolver zakończył pracę bez poprawnej listy strumieni.',
        RESOLVER_TIMEOUT: 'Resolver przekroczył bezpieczny limit czasu.',
        RESOLVER_OUTPUT_TOO_LARGE: 'Resolver zwrócił zbyt dużo danych.',
        RESOLVER_URL_FORBIDDEN: 'Resolver nie obsługuje lokalnego ani prywatnego adresu strony.',
        INVALID_COOKIE: 'Host odrzucił niepoprawny rekord cookie.',
        COOKIE_BUDGET_EXCEEDED: 'Cookies domeny przekraczają bezpieczny limit resolvera.',
        INTERNAL_ERROR: 'Host MPV napotkał wewnętrzny błąd.'
    };
    return messages[code] || `Host MPV odrzucił żądanie (kod ${code}).`;
}

function hostVersionAtLeast(value, minimum) {
    const parse = (input) => {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(input || '').trim());
        return match ? match.slice(1).map(Number) : null;
    };
    const actual = parse(value);
    const required = parse(minimum);
    if (!actual || !required) return false;
    for (let index = 0; index < required.length; index += 1) {
        if (actual[index] !== required[index]) return actual[index] > required[index];
    }
    return true;
}

function validateNativeResponse(response, action, requestId, requirements = {}) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host MPV zwrócił niepoprawną odpowiedź.');
    }
    if (response.protocolVersion !== PROTOCOL_VERSION) {
        throw new WorkerError('HOST_PROTOCOL_MISMATCH', 'Wersja protokołu hosta MPV nie pasuje do rozszerzenia.');
    }
    if (response.requestId !== requestId || response.action !== action) {
        throw new WorkerError('HOST_RESPONSE_MISMATCH', 'Odpowiedź hosta MPV nie pasuje do wysłanego żądania.');
    }
    if (typeof response.hostVersion !== 'string' || !response.hostVersion) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host MPV nie podał swojej wersji.');
    }
    if (
        typeof requirements.minimumHostVersion === 'string' &&
        !hostVersionAtLeast(response.hostVersion, requirements.minimumHostVersion)
    ) {
        throw new WorkerError(
            'HOST_TOO_OLD',
            `Host MPV jest starszy niż wymagana wersja ${requirements.minimumHostVersion}. Uruchom instalator bieżącego wydania.`
        );
    }
    if (response.ok !== true) {
        const errorCode = normalizeErrorCode(response.errorCode, 'HOST_REJECTED');
        throw new WorkerError(
            errorCode,
            localizedHostError(errorCode)
        );
    }
    if (action === 'play' && response.confirmed !== true) {
        throw new WorkerError('PLAY_NOT_CONFIRMED', 'Host MPV nie potwierdził rozpoczęcia odtwarzania.');
    }
    if (action === 'resolve') validateResolveNativeResponse(response);
    return response;
}

function validateResolveNativeResponse(response) {
    if (!['found', 'empty', 'unavailable', 'failed'].includes(response.status)) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host zwrócił nieznany stan resolvera.');
    }
    if (!Array.isArray(response.candidates) || response.candidates.length > MAX_RESOLVER_RESULTS) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host zwrócił niepoprawną liczbę źródeł resolvera.');
    }
    const candidates = response.candidates.map(normalizeResolvedCandidate);
    if (candidates.some((candidate) => candidate === null)) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host zwrócił niepoprawne źródło resolvera.');
    }
    if (response.status === 'found' && candidates.length === 0) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host oznaczył pustą odpowiedź jako znalezioną.');
    }
    if (!Array.isArray(response.attempted) || response.attempted.length > 2) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host zwrócił niepoprawną historię resolverów.');
    }
    if (response.attempted.some((attempt) => normalizeResolverAttempt(attempt) === null)) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host zwrócił niepoprawny wynik próby resolvera.');
    }
    if (response.resolver !== null && response.resolver !== undefined && !['streamlink', 'yt-dlp'].includes(response.resolver)) {
        throw new WorkerError('INVALID_HOST_RESPONSE', 'Host zwrócił nieznaną nazwę resolvera.');
    }
}

function sendNativeRequest(action, payload, timeoutMs, suppliedRequestId = '') {
    const requestId = suppliedRequestId || nextRequestId(action);
    const request = {
        protocolVersion: PROTOCOL_VERSION,
        action,
        requestId,
        ...payload
    };

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new WorkerError('NATIVE_TIMEOUT', `Host MPV nie odpowiedział w ciągu ${Math.ceil(timeoutMs / 1000)} s.`));
        }, timeoutMs);

        chrome.runtime.sendNativeMessage(HOST_NAME, request, (response) => {
            const runtimeMessage = chrome.runtime.lastError?.message || '';
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try {
                if (runtimeMessage) throw mapRuntimeError(runtimeMessage);
                const requirements = action === 'resolve' && payload?.source === 'refresh'
                    ? { minimumHostVersion: REFRESH_HOST_MIN_VERSION }
                    : {};
                resolve(validateNativeResponse(response, action, requestId, requirements));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function buildStreamPayload(candidate) {
    if (isCandidateExpired(candidate, Date.now(), MEDIA_EXPIRY_PLAY_GRACE_MS)) {
        throw new WorkerError(
            'STREAM_URL_EXPIRED',
            'Podpisany adres strumienia wygasł. Rozszerzenie odświeża źródła w tle.'
        );
    }
    if (candidate?.manifestDerived === true && !isSafeManifestDerivedUrl(candidate.url)) {
        throw new WorkerError(
            'MANIFEST_CHILD_FORBIDDEN',
            'Wariant z manifestu prowadzi do niedozwolonego lub niezabezpieczonego adresu.'
        );
    }
    const stream = { url: candidate.url };
    // These are copied only when webRequest actually observed them. No tab URL,
    // cookies, Authorization header, or fabricated origin is ever inserted.
    if (candidate.referer) stream.referer = candidate.referer;
    if (candidate.origin) stream.origin = candidate.origin;
    if (candidate.userAgent) stream.userAgent = candidate.userAgent;
    const language = normalizeLanguageTag(candidate.language);
    if (language && (hasResolverProvenance(candidate) || candidate.manifestDerived === true)) {
        stream.language = language;
    }
    if (
        candidate.playbackKind === 'yt-dlp-page' &&
        hasResolverProvenance(candidate)
    ) {
        stream.playbackKind = candidate.playbackKind;
    }
    return stream;
}

function publicPlayResult(response, mode) {
    return {
        protocolVersion: response.protocolVersion,
        hostVersion: response.hostVersion,
        action: response.action,
        requestId: response.requestId,
        confirmed: response.confirmed === true,
        mode: response.mode || mode,
        confirmation: typeof response.confirmation === 'string' ? response.confirmation : undefined,
        disposition: typeof response.disposition === 'string' ? response.disposition : undefined
    };
}

async function playCandidate(tabId, candidateId, requestedMode, source = 'manual', options = {}) {
    const fallbackAttempt = options?.fallbackAttempt === true;
    const fallbackPrimary = fallbackAttempt && options?.primaryCandidate && typeof options.primaryCandidate === 'object'
        ? options.primaryCandidate
        : null;
    const initialErrorCode = fallbackAttempt
        ? normalizeErrorCode(options?.initialErrorCode || '', '')
        : '';
    if (
        fallbackAttempt &&
        (!fallbackPrimary || !MANUAL_PLAY_FALLBACK_ERRORS.has(initialErrorCode))
    ) {
        throw new WorkerError('PLAY_FALLBACK_UNAVAILABLE', 'Nie można bezpiecznie rozpocząć próby ze źródłem zapasowym.');
    }
    if (activePlayRequests.has(tabId)) {
        throw new WorkerError('PLAY_IN_PROGRESS', 'Inne żądanie MPV dla tej karty nadal oczekuje na odpowiedź.');
    }
    const activeToken = { source, candidateId };
    activePlayRequests.set(tabId, activeToken);
    if (source === 'manual') clearAutoTimer(tabId);
    const playEpoch = currentTabEpoch(tabId);
    try {
        return await enqueueTabPlay(tabId, async () => {
        if (playEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) {
            throw new WorkerError('STALE_TAB_SESSION', 'Sesja karty zmieniła się przed uruchomieniem MPV.');
        }
        const mode = normalizePlayMode(requestedMode, '');
        if (!mode) throw new WorkerError('INVALID_MODE', 'Wybrano nieobsługiwany tryb otwarcia MPV.');
        if (!['manual', 'auto'].includes(source)) throw new WorkerError('INVALID_SOURCE', 'Niepoprawne źródło żądania odtwarzania.');

        const stateBefore = await loadTabState(tabId);
        const prepared = await mutateTabState(tabId, stateBefore.hostname, (state) => {
            if (playEpoch !== currentTabEpoch(tabId)) {
                throw new WorkerError('STALE_TAB_SESSION', 'Sesja karty zmieniła się przed uruchomieniem MPV.');
            }
            const candidate = state.candidates.find((item) => item.id === candidateId);
            if (!candidate) throw new WorkerError('CANDIDATE_NOT_FOUND', 'Wybrany strumień nie jest już dostępny. Odśwież listę.');
            if (fallbackAttempt && !isSafeAlternativeCandidate(candidate, fallbackPrimary, Date.now())) {
                throw new WorkerError(
                    'PLAY_FALLBACK_UNAVAILABLE',
                    'Wykryte źródło zapasowe nie jest już bezpiecznym, kompletnym materiałem.'
                );
            }
            if (candidate.diagnosticOnly === true) {
                throw new WorkerError(
                    'DIAGNOSTIC_SOURCE_BLOCKED',
                    'To techniczna obserwacja karty, a nie potwierdzone źródło bieżącego materiału.'
                );
            }
            if (isBlockedCandidate(candidate)) {
                throw new WorkerError(
                    candidate.purpose === 'advertisement' ? 'ADVERTISEMENT_BLOCKED' : 'UTILITY_MEDIA_BLOCKED',
                    candidate.purpose === 'advertisement'
                        ? 'Rozszerzenie rozpoznało ten plik jako reklamę i nie przekaże go do MPV.'
                        : 'Rozszerzenie rozpoznało ten plik jako techniczny element odtwarzacza.'
                );
            }
            if (candidate.manifestDerived === true && !isSafeManifestDerivedUrl(candidate.url)) {
                throw new WorkerError(
                    'MANIFEST_CHILD_FORBIDDEN',
                    'Wariant z manifestu prowadzi do niedozwolonego lub niezabezpieczonego adresu.'
                );
            }
            if (source === 'auto' && state.auto.enabled !== true) {
                throw new WorkerError('AUTO_DISABLED', 'Auto-otwieranie zostało wyłączone przed uruchomieniem MPV.');
            }
            if (
                source === 'auto' &&
                (
                    activeExpiryRefreshTabId === tabId ||
                    (Number.isFinite(state.auto.suppressUntil) && state.auto.suppressUntil > Date.now())
                )
            ) {
                throw new WorkerError('AUTO_REFRESH_SUPPRESSED', 'Odświeżanie źródła w tle wstrzymało auto-otwieranie.');
            }
            updateCandidateFreshness(candidate);
            if (isCandidateExpired(candidate, Date.now(), MEDIA_EXPIRY_PLAY_GRACE_MS)) {
                candidate.playState = 'error';
                candidate.lastPlayErrorCode = 'STREAM_URL_EXPIRED';
                candidate.lastPlayErrorAt = Date.now();
                candidate.lastPlayErrorUrlHash = stableHash(candidate.url || '');
                setStateStatus(
                    state,
                    'error',
                    'STREAM_URL_EXPIRED',
                    'Podpisany adres strumienia wygasł. Odświeżam źródła w tle.',
                    candidate,
                    { source, mode, confirmed: false }
                );
                return { candidate: { ...candidate }, requestId: '', expired: true };
            }
            if (source === 'manual') markAutoHandled(state, candidate);
            const requestId = nextRequestId('play');
            candidate.playState = 'opening';
            setStateStatus(
                state,
                'opening',
                fallbackAttempt ? 'PLAY_FALLBACK_OPENING' : 'OPENING_MPV',
                fallbackAttempt
                    ? 'Pierwsze źródło nie zadziałało. Próbuję raz z bezpiecznym źródłem zapasowym…'
                    : 'Przekazuję wybrany strumień do MPV…',
                candidate,
                {
                    requestId,
                    source,
                    mode,
                    ...(fallbackAttempt ? { fallbackUsed: true, initialErrorCode } : {})
                }
            );
            return { candidate: { ...candidate }, requestId };
        });

        const candidate = prepared.result.candidate;
        if (prepared.result.expired === true) {
            const error = new WorkerError(
                'STREAM_URL_EXPIRED',
                'Podpisany adres strumienia wygasł. Rozszerzenie odświeża źródła w tle.'
            );
            error.tabState = prepared.state;
            void refreshMediaSources(tabId, { force: true, reason: error.code, candidateId });
            throw error;
        }
        try {
            const response = await sendNativeRequest('play', {
                source,
                mode,
                stream: buildStreamPayload(candidate)
            }, PLAY_TIMEOUT_MS, prepared.result.requestId);
            if (playEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) {
                throw new WorkerError('STALE_TAB_SESSION', 'Sesja karty zmieniła się podczas uruchamiania MPV.');
            }
            const finalized = await mutateTabState(tabId, prepared.state.hostname, (state) => {
                const current = state.candidates.find((item) => item.id === candidateId) || null;
                if (current) {
                    current.playState = 'playing';
                    current.lastPlayedAt = Date.now();
                    current.lastPlayErrorCode = '';
                    current.lastPlayErrorAt = 0;
                    current.lastPlayErrorUrlHash = '';
                }
                state.auto.retryFingerprint = null;
                state.auto.retryCount = 0;
                if (source === 'manual' && current) markAutoHandled(state, current);
                setStateStatus(state, 'playing', 'PLAY_CONFIRMED', 'MPV potwierdził rozpoczęcie odtwarzania.', current, {
                    requestId: response.requestId,
                    source,
                    mode: response.mode || mode,
                    confirmed: true,
                    hostVersion: response.hostVersion,
                    ...(fallbackAttempt ? { fallbackUsed: true, initialErrorCode } : {})
                });
            });
            if (source === 'manual') clearAutoTimer(tabId);
            return { tabState: finalized.state, result: publicPlayResult(response, mode) };
        } catch (rawError) {
            const error = toWorkerError(rawError);
            if (playEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) throw error;
            const finalized = await mutateTabState(tabId, prepared.state.hostname, (state) => {
                const current = state.candidates.find((item) => item.id === candidateId) || null;
                const contentFailure = CONTENT_PLAY_FAILURE_CODES.has(error.code);
                if (current && contentFailure) {
                    current.playState = 'error';
                    current.lastPlayErrorCode = error.code;
                    current.lastPlayErrorAt = Date.now();
                    current.lastPlayErrorUrlHash = stableHash(current.url || '');
                } else if (current) {
                    current.playState = '';
                    current.lastPlayErrorCode = '';
                    current.lastPlayErrorAt = 0;
                    current.lastPlayErrorUrlHash = '';
                }
                if (source === 'auto') {
                    const fingerprint = current?.groupKey || candidate.groupKey;
                    const retryCount = state.auto.retryFingerprint === fingerprint
                        ? state.auto.retryCount + 1
                        : 1;
                    state.auto.retryFingerprint = fingerprint;
                    state.auto.retryCount = retryCount;
                    state.auto.lastFingerprint = null;
                    if (retryCount <= MAX_AUTO_RETRIES_PER_STREAM) {
                        const retryDueAt = Date.now() + AUTO_RETRY_COOLDOWN_MS;
                        state.auto.cooldownUntil = retryDueAt;
                        state.auto.pendingDueAt = retryDueAt;
                    } else {
                        state.auto.cooldownUntil = 0;
                        state.auto.pendingDueAt = null;
                    }
                } else if (current) {
                    markAutoHandled(state, current);
                }
                setStateStatus(state, 'error', error.code, error.message, current, {
                    source,
                    mode,
                    confirmed: false
                });
                return { retryDueAt: source === 'auto' ? state.auto.pendingDueAt : null };
            });
            if (source === 'manual') clearAutoTimer(tabId);
            else if (finalized.result?.retryDueAt) armAutoTimer(tabId, finalized.result.retryDueAt);
            const failedCandidate = finalized.state.candidates.find((item) => item.id === candidateId) || candidate;
            if (
                CONTENT_PLAY_FAILURE_CODES.has(error.code) &&
                (error.code === 'STREAM_URL_EXPIRED' || candidateMediaExpiry(failedCandidate) !== null)
            ) {
                void refreshMediaSources(tabId, { force: true, reason: error.code, candidateId });
            }
            error.tabState = finalized.state;
            throw error;
        }
        });
    } finally {
        if (activePlayRequests.get(tabId) === activeToken) activePlayRequests.delete(tabId);
    }
}

async function playCandidateWithFallbackOnce(tabId, candidateId, requestedMode) {
    try {
        const played = await playCandidate(tabId, candidateId, requestedMode, 'manual');
        return {
            ...played,
            result: {
                ...played.result,
                fallbackUsed: false
            }
        };
    } catch (rawError) {
        const error = toWorkerError(rawError);
        if (!MANUAL_PLAY_FALLBACK_ERRORS.has(error.code)) throw error;
        const retryState = error.tabState || await getCanonicalTabState(tabId);
        const primary = retryState.candidates.find((candidate) => candidate.id === candidateId) || null;
        const alternate = selectAlternativeCandidate(retryState.candidates, primary);
        if (!alternate) throw error;
        const played = await playCandidate(tabId, alternate.id, requestedMode, 'manual', {
            fallbackAttempt: true,
            primaryCandidate: primary,
            initialErrorCode: error.code
        });
        return {
            ...played,
            result: {
                ...played.result,
                fallbackUsed: true,
                initialErrorCode: error.code
            }
        };
    }
}

function toWorkerError(error) {
    if (error instanceof WorkerError) return error;
    return new WorkerError('WORKER_ERROR', sanitizePublicMessage(error?.message, 'Wewnętrzny błąd rozszerzenia.'));
}

async function healthCheck() {
    const response = await sendNativeRequest('health', {}, HEALTH_TIMEOUT_MS);
    const queueResponsive = response.queue?.responsive === true;
    return {
        protocolVersion: response.protocolVersion,
        hostVersion: response.hostVersion,
        action: response.action,
        requestId: response.requestId,
        hostAvailable: true,
        mpvRunning: queueResponsive,
        mpv: {
            available: response.mpv?.available === true,
            version: typeof response.mpv?.version === 'string' ? response.mpv.version : null
        },
        queue: {
            state: typeof response.queue?.state === 'string' ? response.queue.state : 'unknown',
            socketPresent: response.queue?.socketPresent === true,
            responsive: queueResponsive,
            errorCode: typeof response.queue?.errorCode === 'string' ? normalizeErrorCode(response.queue.errorCode) : undefined
        },
        capabilities: Array.isArray(response.capabilities)
            ? response.capabilities.filter((capability) => ['health', 'play', 'resolve'].includes(capability))
            : ['health', 'play'],
        resolvers: normalizeResolverHealth(response.resolvers)
    };
}

function normalizeResolverHealth(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalizeEntry = (entry) => ({
        installed: entry?.installed === true,
        available: entry?.available === true,
        compatible: entry?.compatible === true,
        version: typeof entry?.version === 'string' ? sanitizePublicMessage(entry.version, '').slice(0, 40) : null
    });
    return {
        order: Array.isArray(source.order)
            ? source.order.filter((resolver) => ['streamlink', 'yt-dlp'].includes(resolver)).slice(0, 2)
            : ['streamlink', 'yt-dlp'],
        streamlink: normalizeEntry(source.streamlink),
        ytDlp: normalizeEntry(source.ytDlp || source['yt-dlp'])
    };
}

function resolverResultMessage(status, resultCount, attempted) {
    if (status === 'found') {
        return resultCount === 1
            ? 'Resolver rozpoznał jedno źródło i połączył je z playlistą.'
            : `Resolver rozpoznał ${resultCount} źródeł i połączył je z playlistą.`;
    }
    if (status === 'unavailable') {
        return 'Nie znaleziono zgodnego Streamlink ani yt-dlp w systemie.';
    }
    if (status === 'failed') {
        const timedOut = attempted.some((attempt) => attempt.status === 'timeout');
        return timedOut
            ? 'Resolver przekroczył limit czasu; proces został bezpiecznie zatrzymany.'
            : 'Zewnętrzne resolvery nie zwróciły poprawnego wyniku.';
    }
    return 'Streamlink i yt-dlp nie rozpoznały źródła na tej stronie.';
}

function preferredLanguageRank(language, preferredLanguages) {
    const normalized = normalizeLanguageTag(language);
    if (!normalized) return MAX_PREFERRED_LANGUAGES;
    const exactIndex = preferredLanguages.indexOf(normalized);
    if (exactIndex >= 0) return exactIndex;
    const base = normalized.split('-', 1)[0];
    const baseIndex = preferredLanguages.findIndex((item) => item.split('-', 1)[0] === base);
    return baseIndex >= 0 ? baseIndex : MAX_PREFERRED_LANGUAGES;
}

function retireCurrentResolverBatch(state) {
    const currentBatchId = state.resolver?.batchId || '';
    state.candidates = state.candidates.filter((candidate) => {
        const belongsToCurrentBatch = candidate.resolverCurrent === true ||
            (currentBatchId && candidate.resolverBatch === currentBatchId);
        if (!belongsToCurrentBatch) return true;
        if (candidate.networkObserved === true && state.platform?.id !== 'youtube') {
            candidate.sources = Array.isArray(candidate.sources)
                ? candidate.sources.filter((source) => !['streamlink', 'yt-dlp'].includes(candidateSourceMethod(source)))
                : [];
            delete candidate.resolverRole;
            delete candidate.resolverBatch;
            delete candidate.resolverCurrent;
            delete candidate.materialScope;
            delete candidate.language;
            delete candidate.mediaKind;
            delete candidate.hasAudio;
            delete candidate.hasVideo;
            delete candidate.formatId;
            delete candidate.playbackKind;
            delete candidate.preferredLanguageRank;
            delete candidate.autoEligible;
            candidate.role = classifyMediaRole(candidate);
            candidate.isMaster = candidate.role === 'master';
            candidate.score = scoreCandidate(candidate);
            return true;
        }
        return false;
    });
}

function resolveOptions(value) {
    if (typeof value === 'boolean') return { includeFreshCandidateIds: value, source: 'manual', expectedMaterialScope: '' };
    const source = ['page_ready', 'refresh'].includes(value?.source) ? value.source : 'manual';
    return {
        includeFreshCandidateIds: value?.includeFreshCandidateIds === true,
        source,
        expectedMaterialScope: typeof value?.expectedMaterialScope === 'string'
            ? value.expectedMaterialScope.slice(0, 160)
            : ''
    };
}

async function resolvePage(tabId, rawOptions = false) {
    const options = resolveOptions(rawOptions);
    const resolveSource = options.source;
    const existingResolve = activeResolveRequests.get(tabId);
    if (existingResolve) {
        if (
            resolveSource === 'manual' &&
            ['page_ready', 'refresh'].includes(existingResolve.source) &&
            existingResolve.completion
        ) {
            const completed = await existingResolve.completion;
            if (!completed.ok) throw completed.error;
            const shared = { ...completed.resolved };
            if (options.includeFreshCandidateIds) {
                shared.freshCandidateIds = [...completed.freshCandidateIds];
            }
            return shared;
        }
        throw new WorkerError('RESOLVE_IN_PROGRESS', 'Rozpoznawanie tej karty już trwa.');
    }
    if (resolveSource === 'manual') clearPageReadyResolveTimer(tabId);
    let settleCompletion;
    const completion = new Promise((resolve) => {
        settleCompletion = resolve;
    });
    const resolveToken = { source: resolveSource, completion };
    activeResolveRequests.set(tabId, resolveToken);
    const navigationEpoch = currentTabEpoch(tabId);
    let hostname = '';
    let materialScope = null;
    let completionOutcome = null;
    try {
        const rawPageUrl = await resolveTabUrl(tabId);
        const parsedPageUrl = parseHttpUrl(rawPageUrl);
        if (!parsedPageUrl) {
            throw new WorkerError('INVALID_PAGE_URL', 'Resolver działa tylko na zwykłych stronach HTTP lub HTTPS.');
        }
        parsedPageUrl.hash = '';
        const pageUrl = parsedPageUrl.href;
        hostname = parsedPageUrl.hostname.toLowerCase();
        const adapter = platformAdapterForUrl(pageUrl);
        materialScope = materialScopeForUrl(pageUrl);
        if (!materialScope) throw new WorkerError('INVALID_PAGE_URL', 'Nie udało się ustalić bieżącego materiału.');
        if (options.expectedMaterialScope && materialScope.id !== options.expectedMaterialScope) {
            throw new WorkerError('STALE_TAB_SESSION', 'Karta zmieniła materiał przed uruchomieniem rozpoznawania.');
        }
        if (resolveSource === 'page_ready' && !isResolvablePageReadyScope(materialScope)) {
            throw new WorkerError('PAGE_READY_UNSUPPORTED', 'Automatyczne przygotowanie działa tylko dla otwartego materiału YouTube lub TVP z numerycznym identyfikatorem.');
        }
        const [platformTargets, preferredLanguages, sourcePreferences] = await Promise.all([
            readPlatformResolverTargets(tabId, pageUrl, adapter.id),
            readPreferredLanguages(),
            readSiteSourcePreferences(hostname)
        ]);
        if (navigationEpoch !== currentTabEpoch(tabId)) {
            throw new WorkerError('STALE_TAB_SESSION', 'Karta zmieniła stronę podczas odczytu danych platformy.');
        }
        const resolverUrl = platformTargets[0] || pageUrl;
        const cookies = resolveSource === 'manual'
            ? await collectResolverCookies(tabId, pageUrl, navigationEpoch, resolverUrl)
            : [];
        const startedAt = Date.now();

        await mutateTabState(tabId, hostname, (state) => {
            if (navigationEpoch !== currentTabEpoch(tabId)) {
                throw new WorkerError('STALE_TAB_SESSION', 'Karta zmieniła stronę przed uruchomieniem resolvera.');
            }
            applyTrustedPageContext(state, pageUrl);
            applySourcePreferencesToState(state, sourcePreferences);
            state.resolver = {
                state: 'resolving',
                adapter: adapter.id,
                resolver: null,
                attempted: [],
                resultCount: 0,
                cookiesUsed: cookies.length > 0,
                truncated: false,
                source: resolveSource,
                materialScope: materialScope.id,
                batchId: state.resolver?.batchId || null,
                candidateIds: state.resolver?.candidateIds || [],
                pageReadyScope: materialScope.id,
                pageReadyState: 'resolving',
                updatedAt: startedAt
            };
            setResolverOperationStatus(
                state,
                resolveSource,
                'resolving',
                'RESOLVER_RUNNING',
                resolveSource === 'page_ready'
                    ? `Przygotowuję źródła bieżącego materiału przez ${adapter.resolverOrder.join(' → ')}.`
                    : resolveSource === 'refresh'
                        ? `Odświeżam źródła bieżącego materiału przez ${adapter.resolverOrder.join(' → ')}.`
                        : `Rozpoznaję stronę przez ${adapter.resolverOrder.join(' → ')}.`
            );
        });

        const response = await sendNativeRequest('resolve', {
            source: resolveSource,
            pageUrl: resolverUrl,
            adapter: adapter.id,
            resolverOrder: adapter.resolverOrder,
            cookies,
            preferredLanguages
        }, RESOLVE_TIMEOUT_MS);

        const currentUrl = await resolveTabUrl(tabId);
        if (
            navigationEpoch !== currentTabEpoch(tabId) ||
            pageNavigationIdentity(currentUrl) !== materialScope.id
        ) {
            throw new WorkerError('STALE_TAB_SESSION', 'Karta zmieniła stronę podczas rozpoznawania; spóźniony wynik został odrzucony.');
        }

        const normalizedCandidates = response.candidates.map(normalizeResolvedCandidate);
        const attempted = response.attempted.map(normalizeResolverAttempt);
        const resultCount = normalizedCandidates.length;
        const batchId = `batch_${stableHash(`${materialScope.id}:${response.requestId}`)}`;
        const mutation = await mutateTabState(tabId, hostname, (state) => {
            if (
                navigationEpoch !== currentTabEpoch(tabId) ||
                state.materialScope?.id !== materialScope.id
            ) {
                throw new WorkerError('STALE_TAB_SESSION', 'Sesja karty zmieniła się przed zapisaniem wyniku resolvera.');
            }
            if (response.status === 'found') retireCurrentResolverBatch(state);
            const freshCandidateIds = [];
            normalizedCandidates.forEach((observation, index) => {
                const merged = mergeMediaObservationIntoState(state, {
                    ...observation,
                    requestId: `resolver:${response.requestId}:${index}`,
                    requestStartedAt: startedAt + index,
                    tabEpoch: navigationEpoch,
                    pageHostname: hostname,
                    resolverBatch: batchId,
                    resolverCurrent: true,
                    materialScope: materialScope.id,
                    preferredLanguageRank: preferredLanguageRank(observation.language, preferredLanguages),
                    autoEligible: resolveSource === 'manual',
                    refreshTransport: resolveSource === 'refresh'
                }, startedAt + index);
                if (merged && !freshCandidateIds.includes(merged.id)) freshCandidateIds.push(merged.id);
            });
            applySourcePreferencesToState(state, sourcePreferences);
            state.resolver = {
                state: response.status,
                adapter: adapter.id,
                resolver: response.resolver || null,
                attempted,
                resultCount,
                cookiesUsed: cookies.length > 0,
                truncated: response.truncated === true,
                source: resolveSource,
                materialScope: materialScope.id,
                batchId: response.status === 'found' ? batchId : (state.resolver?.batchId || null),
                candidateIds: response.status === 'found' ? freshCandidateIds : (state.resolver?.candidateIds || []),
                pageReadyScope: materialScope.id,
                pageReadyState: 'done',
                updatedAt: Date.now()
            };
            const message = resolverResultMessage(response.status, resultCount, attempted);
            const statusMap = {
                found: ['detected', 'RESOLVER_FOUND'],
                empty: ['resolver_empty', 'RESOLVER_EMPTY'],
                unavailable: ['resolver_unavailable', 'RESOLVER_UNAVAILABLE'],
                failed: ['error', 'RESOLVER_FAILED']
            };
            const [stateName, code] = statusMap[response.status];
            const freshCandidate = selectRecommendedCandidate(
                state.candidates.filter((candidate) => freshCandidateIds.includes(candidate.id))
            );
            setResolverOperationStatus(state, resolveSource, stateName, code, message, freshCandidate, {
                resolver: response.resolver || undefined,
                resultCount,
                truncated: response.truncated === true,
                source: resolveSource
            });
            return { freshCandidateIds };
        });
        const resolved = {
            tabState: mutation.state,
            result: {
                status: response.status,
                resolver: response.resolver || null,
                attempted,
                resultCount,
                cookiesUsed: cookies.length > 0,
                truncated: response.truncated === true,
                source: resolveSource
            }
        };
        if (options.includeFreshCandidateIds) {
            resolved.freshCandidateIds = mutation.result?.freshCandidateIds || [];
        }
        completionOutcome = {
            ok: true,
            resolved,
            freshCandidateIds: mutation.result?.freshCandidateIds || []
        };
        return resolved;
    } catch (rawError) {
        const error = toWorkerError(rawError);
        if (hostname && navigationEpoch === currentTabEpoch(tabId) && !removedTabs.has(tabId)) {
            const finalized = await mutateTabState(tabId, hostname, (state) => {
                state.resolver = {
                    ...(state.resolver || {}),
                    state: 'failed',
                    source: resolveSource,
                    materialScope: materialScope?.id || state.materialScope?.id || '',
                    pageReadyScope: materialScope?.id || state.materialScope?.id || '',
                    pageReadyState: 'done',
                    errorCode: error.code,
                    updatedAt: Date.now()
                };
                setResolverOperationStatus(
                    state,
                    resolveSource,
                    'error',
                    error.code,
                    error.message,
                    null,
                    { source: resolveSource }
                );
            }).catch(() => null);
            if (finalized?.state) error.tabState = finalized.state;
        }
        completionOutcome = { ok: false, error };
        throw error;
    } finally {
        if (activeResolveRequests.get(tabId) === resolveToken) activeResolveRequests.delete(tabId);
        settleCompletion(completionOutcome || {
            ok: false,
            error: new WorkerError('WORKER_ERROR', 'Rozpoznawanie zakończyło się bez wyniku.')
        });
    }
}

async function openRecommendedFromContextMenu(tabId) {
    const pageUrl = await resolveTabUrl(tabId);
    if (!parseHttpUrl(pageUrl)) {
        throw new WorkerError('INVALID_PAGE_URL', 'Polecenie MPV działa tylko na zwykłych stronach HTTP lub HTTPS.');
    }

    const adapter = platformAdapterForUrl(pageUrl);
    let state = await getCanonicalTabState(tabId);
    let candidate = selectRecommendedCandidate(state.candidates);
    if (adapter.id === 'youtube') {
        const existingCandidate = candidate
            ? { id: candidate.id, groupKey: candidate.groupKey }
            : null;
        const resolved = await resolvePage(tabId, true);
        state = resolved.tabState;
        if (resolved.result.status === 'found') {
            const freshCandidateIds = new Set(resolved.freshCandidateIds);
            candidate = selectRecommendedCandidate(state.candidates.filter((item) => freshCandidateIds.has(item.id)));
        } else if (['empty', 'unavailable'].includes(resolved.result.status) && existingCandidate) {
            candidate = selectRecommendedCandidate(state.candidates.filter((item) =>
                item.id === existingCandidate.id &&
                item.groupKey === existingCandidate.groupKey
            ));
        } else {
            candidate = null;
        }
    } else if (!candidate) {
        const resolved = await resolvePage(tabId);
        state = resolved.tabState;
        candidate = selectRecommendedCandidate(state.candidates);
    }
    if (!candidate) {
        throw new WorkerError(
            'NO_PLAYABLE_SOURCE',
            'Nie znaleziono bezpiecznego, nie-reklamowego źródła do otwarcia w MPV.'
        );
    }

    const settings = await readSettings();
    return playCandidateWithFallbackOnce(tabId, candidate.id, settings.defaultPlayMode);
}

async function recordContextMenuFailure(tabId, rawError) {
    const error = toWorkerError(rawError);
    if (!Number.isInteger(tabId) || tabId < 0 || removedTabs.has(tabId)) return error;
    const hostname = await resolveTabHostname(tabId).catch(() => '');
    if (!hostname) return error;
    await mutateTabState(tabId, hostname, (state) => {
        const candidate = selectRecommendedCandidate(state.candidates);
        setStateStatus(state, 'error', error.code, error.message, candidate, {
            source: 'context_menu',
            confirmed: false
        });
    }).catch(() => undefined);
    return error;
}

async function handleRecommendedContextMenuClick(info, tab) {
    if (info?.menuItemId !== RECOMMENDED_CONTEXT_MENU_ID) return;
    const tabId = Number.isInteger(tab?.id) && tab.id >= 0 ? tab.id : null;
    if (tabId === null) return;
    try {
        await openRecommendedFromContextMenu(tabId);
    } catch (error) {
        await recordContextMenuFailure(tabId, error).catch(() => undefined);
    }
}

// ─── Runtime message contract ────────────────────────────────────────────────

function messageAction(message) {
    return typeof message?.type === 'string' ? message.type : message?.action;
}

function requireTabId(message, sender) {
    const value = message?.tabId ?? sender?.tab?.id;
    if (!Number.isInteger(value) || value < 0) throw new WorkerError('INVALID_TAB_ID', 'Nie podano poprawnego identyfikatora karty.');
    return value;
}

function requirePopupSender(sender) {
    const extensionId = typeof chrome.runtime?.id === 'string' ? chrome.runtime.id : '';
    let senderUrl;
    try {
        senderUrl = new URL(sender?.url || '');
    } catch (_error) {
        senderUrl = null;
    }
    if (
        !extensionId ||
        sender?.id !== extensionId ||
        senderUrl?.protocol !== 'chrome-extension:' ||
        senderUrl.hostname !== extensionId ||
        senderUrl.pathname !== '/popup.html'
    ) {
        throw new WorkerError('POPUP_GESTURE_REQUIRED', 'Ta operacja wymaga jawnego działania w popupie rozszerzenia.');
    }
}

function clearPendingRequestsForTab(tabId) {
    pendingRequests.forEach((request, requestId) => {
        if (request.tabId === tabId) pendingRequests.delete(requestId);
    });
}

async function observePageMedia(message, sender) {
    const tabId = requireTabId(message, sender);
    const rawItems = Array.isArray(message?.media) ? message.media : [];
    const items = rawItems.slice(0, MAX_PAGE_MEDIA_ITEMS);
    const isTopFrame = !Number.isInteger(sender?.frameId) || sender.frameId === 0;
    const publicPageUrl = isTopFrame && typeof message?.page?.url === 'string' ? message.page.url : '';
    const currentTabUrl = isTopFrame ? await resolveTabUrl(tabId) : '';
    const senderPageUrl = isTopFrame && typeof sender?.url === 'string' ? sender.url : '';
    const reservation = isTopFrame ? navigationReservations.get(tabId) : null;
    const reservedPageUrl = reservation && Date.now() - reservation.at <= 30_000
        ? reservation.url
        : '';
    const trustedPageUrl = reservedPageUrl || currentTabUrl || senderPageUrl;

    const trustedPathIdentity = pagePathIdentity(trustedPageUrl);
    const publicPathIdentity = pagePathIdentity(publicPageUrl);
    const senderPageIdentity = pageNavigationIdentity(senderPageUrl);
    const currentPageIdentity = pageNavigationIdentity(currentTabUrl);
    const reservedPageIdentity = pageNavigationIdentity(reservedPageUrl);
    if (
        (trustedPathIdentity && publicPathIdentity && trustedPathIdentity !== publicPathIdentity) ||
        (
            senderPageIdentity &&
            (reservedPageIdentity || currentPageIdentity) &&
            senderPageIdentity !== (reservedPageIdentity || currentPageIdentity)
        )
    ) {
        return { accepted: 0, rejected: rawItems.length, removed: 0, stale: true };
    }

    let incomingPageIdentity = pageNavigationIdentity(trustedPageUrl || publicPageUrl);
    if (incomingPageIdentity) {
        const existingState = await loadTabState(tabId);
        if (existingState.pageIdentity && existingState.pageIdentity !== incomingPageIdentity) {
            if (trustedPageUrl) {
                await resetTabState(tabId, normalizeHostname(trustedPageUrl), 'navigation', trustedPageUrl);
            } else {
                // The public payload intentionally omits query parameters. It
                // may seed an empty state, but must never roll a trusted query
                // identity backwards or erase a confirmed network candidate.
                incomingPageIdentity = existingState.pageIdentity;
            }
        }
    }
    const hostname = normalizeHostname(trustedPageUrl) || await resolveTabHostname(tabId);
    const tabEpoch = currentTabEpoch(tabId);
    const now = Date.now();
    const snapshot = pageSnapshotIdentity(message, sender);
    const observations = [];
    let accepted = 0;
    let rejected = Math.max(0, rawItems.length - items.length);

    for (const item of items) {
        const url = typeof item?.url === 'string' ? item.url : '';
        const parsed = parseHttpUrl(url);
        const declaredType = typeof item?.type === 'string' ? item.type.toUpperCase() : '';
        const mediaType = detectMediaFromUrl(url) ||
            detectMediaFromContentType(item?.mimeType || item?.type || '') ||
            (['HLS', 'DASH', 'MP4', 'WEBM', 'MEDIA'].includes(declaredType) ? declaredType : null);
        if (!parsed || !mediaType || isLikelySegmentUrl(url)) {
            rejected += 1;
            continue;
        }

        const currentPlayerKeys = scopedPagePlayerKeys(item?.currentPlayerKeys, snapshot);
        const playerKeys = mergePlayerKeyLists(
            currentPlayerKeys,
            scopedPagePlayerKeys(item?.playerKeys, snapshot)
        );

        observations.push({
            url,
            mediaType,
            source: 'page_dom',
            resourceType: 'page',
            requestId: `page-${stableHash(`${tabId}:${canonicalizeMediaUrl(url)}`)}`,
            // A DOM snapshot is descriptive, not a network request clock. Zero
            // lets a later webRequest response remain authoritative even when
            // the content-script debounce flushed first.
            requestStartedAt: 0,
            tabEpoch,
            pageSnapshotKey: snapshot.key,
            contentType: typeof item?.mimeType === 'string' ? item.mimeType : '',
            pageHostname: hostname,
            title: typeof item?.title === 'string' ? item.title : '',
            quality: typeof item?.quality === 'string' ? item.quality : '',
            duration: Number(item?.duration),
            width: Number.isInteger(item?.width) ? item.width : undefined,
            height: Number.isInteger(item?.height) ? item.height : undefined,
            bitrateKbps: Number.isFinite(item?.bitrateKbps) ? item.bitrateKbps : undefined,
            bandwidth: Number.isFinite(item?.bandwidth) ? item.bandwidth : undefined,
            elementKind: ['video', 'audio'].includes(item?.kind) ? item.kind : '',
            playerKeys,
            currentPlayerKeys: currentPlayerKeys.filter((key) => playerKeys.includes(key))
        });
        accepted += 1;
    }

    const acceptedCanonicalKeys = new Set(observations.map((observation) =>
        canonicalizeMediaUrl(observation.url)
    ).filter(Boolean));
    const mutation = await mutateTabState(tabId, hostname, async (state) => {
        if (tabEpoch !== currentTabEpoch(tabId)) return { ignored: true, removed: 0 };
        const [sitePolicy, sourcePreferences] = await Promise.all([
            readSiteAuto(hostname || state.hostname),
            readSiteSourcePreferences(hostname || state.hostname)
        ]);
        if (hostname && state.hostname && state.hostname !== hostname) {
            Object.assign(state, createTabState(tabId, hostname, tabEpoch, trustedPageUrl));
        } else if (hostname && !state.hostname) {
            state.hostname = hostname;
        }
        if (trustedPageUrl) applyTrustedPageContext(state, trustedPageUrl);
        else if (incomingPageIdentity) state.pageIdentity = incomingPageIdentity;

        // A broadcast rescan can receive its first acknowledgement from an
        // empty top frame while the real player iframe commits slightly later.
        // Capture only the exact failed refresh targets before this snapshot
        // can replace or remove them.
        const failedRefreshTargets = failedExpiryRefreshTargets(state);

        const previousCurrentKeys = new Map(state.candidates.map((candidate) => [
            candidate,
            normalizePlayerKeyList(candidate.currentPlayerKeys).filter((key) => key.startsWith(snapshot.framePrefix))
        ]));

        const acceptedCandidates = new Set();
        const incomingPlayerKeys = new Map();
        const incomingCurrentPlayerKeys = new Map();
        for (const observation of observations) {
            const merged = mergeMediaObservationIntoState(state, observation, now);
            if (!merged) continue;
            acceptedCandidates.add(merged);
            incomingPlayerKeys.set(merged, new Set([
                ...(incomingPlayerKeys.get(merged) || []),
                ...observation.playerKeys
            ]));
            incomingCurrentPlayerKeys.set(merged, new Set([
                ...(incomingCurrentPlayerKeys.get(merged) || []),
                ...observation.currentPlayerKeys
            ]));
        }

        const beforeCount = state.candidates.length;
        let supersededCount = 0;
        state.candidates = state.candidates.filter((candidate) => {
            const keys = Array.isArray(candidate.pageSnapshotKeys) ? candidate.pageSnapshotKeys : [];
            const presentInSnapshot = acceptedCandidates.has(candidate) ||
                (
                    candidate.manifestDerived === true &&
                    candidate.manifestParentCanonicalKey &&
                    acceptedCanonicalKeys.has(candidate.manifestParentCanonicalKey)
                );
            candidate.pageSnapshotKeys = keys.filter((key) =>
                !key.startsWith(snapshot.framePrefix) ||
                (key === snapshot.key && presentInSnapshot)
            );
            const acceptedPlayerKeys = incomingPlayerKeys.get(candidate) || new Set();
            const acceptedCurrentKeys = incomingCurrentPlayerKeys.get(candidate) || new Set();
            candidate.playerKeys = normalizePlayerKeyList(candidate.playerKeys).filter((key) =>
                !key.startsWith(snapshot.framePrefix) || acceptedPlayerKeys.has(key)
            );
            candidate.currentPlayerKeys = normalizePlayerKeyList(candidate.currentPlayerKeys).filter((key) =>
                !key.startsWith(snapshot.framePrefix) || acceptedCurrentKeys.has(key)
            );
            candidate.playerKeys = mergePlayerKeyLists(candidate.currentPlayerKeys, candidate.playerKeys);

            if (state.platform?.id !== 'youtube') {
                const hadCurrentSource = (previousCurrentKeys.get(candidate) || []).length > 0;
                const isCurrentSource = candidate.currentPlayerKeys.length > 0;
                if (hadCurrentSource && !isCurrentSource) {
                    candidate.superseded = true;
                    candidate.supersededAt = now;
                    candidate.diagnosticOnly = true;
                    candidate.diagnosticReason = 'PLAYER_SOURCE_REPLACED';
                    supersededCount += 1;
                } else if (isCurrentSource && candidate.diagnosticReason === 'PLAYER_SOURCE_REPLACED') {
                    candidate.superseded = false;
                    candidate.supersededAt = 0;
                    candidate.diagnosticOnly = false;
                    delete candidate.diagnosticReason;
                }
            }
            return candidate.networkObserved === true ||
                candidate.source !== 'page_dom' ||
                candidate.pageSnapshotKeys.length > 0;
        });
        applySourcePreferencesToState(state, sourcePreferences);
        const removed = beforeCount - state.candidates.length;
        if (removed > 0) {
            addEvent(state, 'media', 'PAGE_MEDIA_RECONCILED', 'Usunięto nieaktualne źródła, których nie ma już na stronie.');
        }
        if (supersededCount > 0) {
            addEvent(
                state,
                'media',
                'PLAYER_SOURCE_REPLACED',
                'Odtwarzacz przełączył źródło; poprzedni strumień pozostaje wyłącznie w diagnostyce.'
            );
        }
        const lateRefreshReconciled = reconcileLatePageExpiryRefresh(
            state,
            acceptedCandidates,
            failedRefreshTargets,
            now
        );
        const pendingDueAt = lateRefreshReconciled
            ? null
            : refreshDetectionState(state, sitePolicy, now);
        return { removed, pendingDueAt, lateRefreshReconciled };
    });

    if (mutation.result?.pendingDueAt) armAutoTimer(tabId, mutation.result.pendingDueAt);
    else clearAutoTimer(tabId);
    if (!mutation.result?.ignored) scheduleManifestScansForState(tabId, mutation.state);
    return {
        accepted: mutation.result?.ignored ? 0 : accepted,
        rejected,
        removed: mutation.result?.removed || 0
    };
}

function resetTabState(tabId, hostnameHint = '', reason = 'manual', pageUrlHint = '') {
    // Bump the epoch and reserve the tab queue before the first await. Network
    // callbacks from the new document will therefore line up behind this reset;
    // callbacks from the old document carry the previous epoch and are ignored.
    const resetEpoch = bumpTabEpoch(tabId);
    clearAutoTimer(tabId);
    clearPageReadyResolveTimer(tabId);
    clearExpiryRefreshAlarm(tabId);
    clearExpiryRefreshKick(tabId);
    clearPendingRequestsForTab(tabId);
    return enqueueTabMutation(tabId, async () => {
        if (resetEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) {
            return loadTabState(tabId, hostnameHint);
        }
        const hostname = normalizeHostname(hostnameHint) || await resolveTabHostname(tabId);
        const [policy, sourcePreferences] = await Promise.all([
            readSiteAuto(hostname),
            readSiteSourcePreferences(hostname)
        ]);
        const state = createTabState(tabId, hostname, resetEpoch, pageUrlHint);
        state.auto.enabled = policy.enabled;
        applySourcePreferencesToState(state, sourcePreferences);
        if (reason === 'manual') {
            addEvent(state, 'status', 'TAB_CLEARED', 'Wyczyszczono wykryte media tej karty.');
        }
        if (resetEpoch !== currentTabEpoch(tabId) || removedTabs.has(tabId)) {
            return loadTabState(tabId, hostname);
        }
        state.updatedAt = Date.now();
        await chrome.storage.session.set({ [tabStateKey(tabId)]: state });
        await updateBadge(state);
        syncExpiryRefreshAlarm(state);
        await chrome.storage.local.remove([`streams_${tabId}`, `logs_${tabId}`]);
        return state;
    });
}

function clearTabState(tabId) {
    return resetTabState(tabId, '', 'manual');
}

async function updateStatesForSitePolicy(policy) {
    let stored;
    try {
        stored = await chrome.storage.session.get(null);
    } catch (_error) {
        return { matchedTabs: 0, updatedTabs: 0, staleTabsRemoved: 0, failedTabs: 1 };
    }
    const entries = Object.entries(stored).filter(([key, value]) =>
        key.startsWith(TAB_STATE_PREFIX) && value?.hostname === policy.hostname && Number.isInteger(value?.tabId)
    );
    const operations = entries.map(async ([, value]) => {
        const tabId = value.tabId;
        if (removedTabs.has(tabId)) throw new WorkerError('TAB_CLOSED', 'Karta została zamknięta.');
        try {
            await chrome.tabs.get(tabId);
        } catch (_error) {
            throw new WorkerError('TAB_CLOSED', 'Karta została zamknięta.');
        }
        const mutation = await mutateTabState(tabId, policy.hostname, async (state) => {
            const currentPolicy = await readSiteAuto(policy.hostname);
            const dueAt = refreshDetectionState(state, currentPolicy, Date.now());
            return { dueAt };
        });
        if (mutation.result?.dueAt) armAutoTimer(tabId, mutation.result.dueAt);
        else clearAutoTimer(tabId);
    });

    const results = await Promise.allSettled(operations);
    const staleEntries = [];
    let updatedTabs = 0;
    let failedTabs = 0;
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            updatedTabs += 1;
            return;
        }
        const error = toWorkerError(result.reason);
        if (error.code === 'TAB_CLOSED') staleEntries.push(entries[index]);
        else failedTabs += 1;
    });

    const removals = await Promise.allSettled(staleEntries.map(async ([key, value]) => {
        const tabId = value.tabId;
        removedTabs.add(tabId);
        clearAutoTimer(tabId);
        clearPendingRequestsForTab(tabId);
        const cleanup = await Promise.allSettled([
            chrome.storage.session.remove(key),
            removePersistedRequestContextsForTab(tabId)
        ]);
        if (cleanup[0].status === 'rejected') throw cleanup[0].reason;
    }));
    const staleTabsRemoved = removals.filter((result) => result.status === 'fulfilled').length;
    failedTabs += removals.length - staleTabsRemoved;
    return {
        matchedTabs: entries.length,
        updatedTabs,
        staleTabsRemoved,
        failedTabs
    };
}

async function handleRuntimeMessage(message, sender) {
    await startupRecoveryReady;
    const action = messageAction(message);
    switch (action) {
        case 'PAGE_MEDIA_DISCOVERED': {
            const discovery = await observePageMedia(message, sender);
            return { ok: true, action, ...discovery };
        }
        case 'GET_TAB_STATE': {
            const tabId = requireTabId(message, sender);
            const state = await getCanonicalTabState(tabId);
            return { ok: true, action, state, tabState: state };
        }
        case 'HEALTH':
            return { ok: true, action, health: await healthCheck() };
        case 'RESOLVE_PAGE': {
            requirePopupSender(sender);
            const tabId = requireTabId(message, sender);
            const resolved = await resolvePage(tabId);
            return { ok: true, action, ...resolved, state: resolved.tabState };
        }
        case 'PLAY': {
            requirePopupSender(sender);
            const tabId = requireTabId(message, sender);
            if (typeof message.candidateId !== 'string' || !message.candidateId) {
                throw new WorkerError('INVALID_CANDIDATE_ID', 'Nie wskazano strumienia do otwarcia.');
            }
            const settings = await readSettings();
            const mode = message.mode === undefined
                ? settings.defaultPlayMode
                : normalizePlayMode(message.mode, '');
            if (!mode) throw new WorkerError('INVALID_MODE', 'Wybrano nieobsługiwany tryb otwarcia MPV.');
            const played = await playCandidateWithFallbackOnce(tabId, message.candidateId, mode);
            return { ok: true, action, ...played, state: played.tabState };
        }
        case 'CLEAR_TAB': {
            const tabId = requireTabId(message, sender);
            const state = await clearTabState(tabId);
            return { ok: true, action, state, tabState: state };
        }
        case 'GET_SITE_AUTO': {
            const policy = await readSiteAuto(message?.hostname || '');
            if (!policy.hostname) throw new WorkerError('INVALID_HOSTNAME', 'Nie podano poprawnej domeny witryny.');
            return { ok: true, action, ...policy };
        }
        case 'SET_SITE_AUTO': {
            if (typeof message?.enabled !== 'boolean') {
                throw new WorkerError('INVALID_SETTING', 'Wartość auto-otwierania musi być logiczna.');
            }
            const policy = await writeSiteAuto(message?.hostname || '', message.enabled);
            const stateSync = await updateStatesForSitePolicy(policy);
            return { ok: true, action, ...policy, stateSync };
        }
        case 'SET_CANDIDATE_PRIORITY': {
            requirePopupSender(sender);
            const tabId = requireTabId(message, sender);
            if (typeof message?.candidateId !== 'string' || !message.candidateId) {
                throw new WorkerError('INVALID_CANDIDATE_ID', 'Nie wskazano źródła, którego priorytet ma zostać zmieniony.');
            }
            const updated = await setCandidatePriority(tabId, message.candidateId, message?.priority);
            return {
                ok: true,
                action,
                ...updated.policy,
                state: updated.state,
                tabState: updated.state
            };
        }
        case 'SET_QUALITY_ORDER': {
            requirePopupSender(sender);
            const tabId = requireTabId(message, sender);
            const updated = await setQualityOrder(tabId, message?.qualityOrder);
            return {
                ok: true,
                action,
                ...updated.policy,
                state: updated.state,
                tabState: updated.state
            };
        }
        case 'SET_SOURCE_URL_VISIBILITY': {
            requirePopupSender(sender);
            if (typeof message?.visible !== 'boolean') {
                throw new WorkerError('INVALID_SETTING', 'Widoczność pełnych adresów musi być wartością logiczną.');
            }
            const tabId = requireTabId(message, sender);
            const updated = await setSourceUrlVisibility(tabId, message.visible);
            return {
                ok: true,
                action,
                ...updated.policy,
                state: updated.state,
                tabState: updated.state
            };
        }
        case 'GET_RESOLVER_COOKIE_POLICY': {
            requirePopupSender(sender);
            const tabId = requireTabId(message, sender);
            const pageUrl = await resolveTabUrl(tabId);
            return { ok: true, action, ...(await readResolverCookiePolicy(pageUrl)) };
        }
        case 'SET_RESOLVER_COOKIE_POLICY': {
            requirePopupSender(sender);
            if (typeof message?.enabled !== 'boolean') {
                throw new WorkerError('INVALID_SETTING', 'Wartość zgody na cookies musi być logiczna.');
            }
            const tabId = requireTabId(message, sender);
            const pageUrl = await resolveTabUrl(tabId);
            const policy = await writeResolverCookiePolicy(pageUrl, message.enabled);
            return { ok: true, action, ...policy };
        }
        default:
            throw new WorkerError('UNSUPPORTED_ACTION', 'Rozszerzenie nie obsługuje tej operacji.');
    }
}

function runtimeErrorResponse(action, rawError) {
    const error = toWorkerError(rawError);
    return {
        ok: false,
        action: typeof action === 'string' ? action : 'UNKNOWN',
        errorCode: error.code,
        error: sanitizePublicMessage(error.message),
        ...(error.tabState ? { state: error.tabState, tabState: error.tabState } : {})
    };
}

// ─── Chrome event handlers ──────────────────────────────────────────────────

function isRelevantRequest(details) {
    return details && details.tabId >= 0 && RELEVANT_REQUEST_TYPE_SET.has(details.type);
}

function navigationUrlKey(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return '';
    parsed.hash = '';
    return parsed.href;
}

function pageNavigationIdentity(value) {
    return materialScopeForUrl(value)?.id || '';
}

function pagePathIdentity(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return '';
    return `${parsed.hostname}:${stableHash(parsed.pathname)}`;
}

function reserveMainFrameNavigation(details) {
    navigationReservations.set(details.tabId, {
        url: navigationUrlKey(details.url),
        hostname: normalizeHostname(details.url),
        requestId: details.requestId,
        at: Date.now()
    });
    void resetTabState(details.tabId, normalizeHostname(details.url), 'navigation', details.url).catch(() => undefined);
}

function runAfterStartupRecovery(operation) {
    void startupRecoveryReady.then(operation).catch(() => undefined);
}

function hasMatchingNavigationReservation(tabId, url = '') {
    const reservation = navigationReservations.get(tabId);
    if (!reservation || Date.now() - reservation.at > 30_000) {
        navigationReservations.delete(tabId);
        return false;
    }
    const key = navigationUrlKey(url);
    return !key || !reservation.url || key === reservation.url;
}

function processBeforeRequest(details) {
    if (!isRelevantRequest(details)) return;
    if (details.type === 'main_frame') reserveMainFrameNavigation(details);
    const context = rememberRequest(details, {}, true);
    const mediaType = detectMediaFromUrl(details.url);
    if (!mediaType || isLikelySegmentUrl(details.url)) return;
    const observation = mediaObservationFrom(details, mediaType, 'url', context, { clearHeaders: true });
    void observeMedia(details.tabId, observation).catch(() => undefined);
}

function onBeforeRequest(details) {
    if (!isRelevantRequest(details)) return;
    runAfterStartupRecovery(() => processBeforeRequest(details));
}

function processSendHeaders(details) {
    if (!isRelevantRequest(details)) return;
    const observedHeaders = extractObservedHeaders(details.requestHeaders);
    const context = rememberRequest(details, { ...observedHeaders, headersObserved: true });
    void persistRequestContext(details, context).catch(() => undefined);
    const mediaType = detectMediaFromUrl(details.url);
    if (!mediaType || isLikelySegmentUrl(details.url)) return;
    const observation = mediaObservationFrom(details, mediaType, 'request_headers', context, { clearHeaders: true });
    void observeMedia(details.tabId, observation).catch(() => undefined);
}

function onSendHeaders(details) {
    if (!isRelevantRequest(details)) return;
    runAfterStartupRecovery(() => processSendHeaders(details));
}

function processHeadersReceived(details) {
    if (!isRelevantRequest(details)) return;
    const pendingContext = typeof details?.requestId === 'string'
        ? pendingRequests.get(details.requestId) || null
        : null;
    const contentType = responseContentType(details.responseHeaders);
    const mediaType = detectMediaFromContentType(contentType) || detectMediaFromUrl(details.url);
    if (!mediaType || isLikelySegmentUrl(details.url)) {
        void forgetPersistedRequestContext(details).catch(() => undefined);
        return;
    }
    const persistedContext = loadPersistedRequestContext(details);
    void (async () => {
        try {
            const restored = await persistedContext;
            if (restored?.stale === true) return;
            if (!pendingContext && !restored) return;
            const mergedContext = pendingContext
                ? mergePersistedRequestContext(pendingContext, restored)
                : restored;
            const observation = mediaObservationFrom(details, mediaType, 'response_headers', mergedContext, {
                contentType,
                clearHeaders: true
            });
            await observeMedia(details.tabId, observation);
        } finally {
            await forgetPersistedRequestContext(details).catch(() => undefined);
        }
    })().catch(() => undefined);
}

function onHeadersReceived(details) {
    if (!isRelevantRequest(details)) return;
    runAfterStartupRecovery(() => processHeadersReceived(details));
}

function processRequestCompleted(details) {
    if (typeof details?.requestId === 'string') pendingRequests.delete(details.requestId);
    void forgetPersistedRequestContext(details).catch(() => undefined);
}

function onRequestCompleted(details) {
    runAfterStartupRecovery(() => processRequestCompleted(details));
}

function processRequestError(details) {
    const pendingContext = typeof details?.requestId === 'string' ? pendingRequests.get(details.requestId) || null : null;
    if (typeof details?.requestId === 'string') pendingRequests.delete(details.requestId);
    if (!isRelevantRequest(details)) return;
    const mediaType = detectMediaFromUrl(details.url);
    if (!mediaType || isLikelySegmentUrl(details.url)) {
        void forgetPersistedRequestContext(details).catch(() => undefined);
        return;
    }
    void (async () => {
        try {
            const restored = await loadPersistedRequestContext(details);
            if (restored?.stale === true || (!pendingContext && !restored)) return;
            const context = pendingContext
                ? mergePersistedRequestContext(pendingContext, restored)
                : restored;
            const observation = mediaObservationFrom(details, mediaType, 'network_error', context, {
                networkError: details.error || 'Błąd sieci.',
                clearHeaders: true
            });
            await observeMedia(details.tabId, observation);
        } finally {
            await forgetPersistedRequestContext(details).catch(() => undefined);
        }
    })().catch(() => undefined);
}

function onRequestError(details) {
    runAfterStartupRecovery(() => processRequestError(details));
}

function processTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
        navigationReservations.delete(tabId);
        if (tab?.active === true) {
            rememberActiveTab(tabId, tab.windowId);
            void schedulePageReadyResolve(tabId, tab.url || '').catch(() => undefined);
        }
        return;
    }
    const url = changeInfo.url || tab?.url || '';
    if (changeInfo.status === 'loading') {
        if (hasMatchingNavigationReservation(tabId, changeInfo.url || '')) return;
        navigationReservations.set(tabId, { url: navigationUrlKey(url), hostname: normalizeHostname(url), requestId: '', at: Date.now() });
        void resetTabState(tabId, normalizeHostname(url), 'navigation', url).catch(() => undefined);
        return;
    }
    if (!changeInfo.url) return;
    // A same-document route/search change is a new media session (SPA); a
    // fragment-only change keeps the current candidates.
    const hostname = normalizeHostname(changeInfo.url);
    const nextPageIdentity = pageNavigationIdentity(changeInfo.url);
    void loadTabState(tabId, hostname).then((state) => {
        if (
            (hostname && state.hostname && hostname !== state.hostname) ||
            (nextPageIdentity && state.pageIdentity && nextPageIdentity !== state.pageIdentity)
        ) {
            navigationReservations.set(tabId, { url: navigationUrlKey(url), hostname, requestId: '', at: Date.now() });
            return resetTabState(tabId, hostname, 'navigation', changeInfo.url);
        }
        if (nextPageIdentity && !state.pageIdentity) {
            return mutateTabState(tabId, hostname, (current) => {
                if (!current.pageIdentity) current.pageIdentity = nextPageIdentity;
            });
        }
        return undefined;
    }).then(() => {
        if (tab?.active === true || [...activeTabByWindow.values()].includes(tabId)) {
            if (tab?.active === true) rememberActiveTab(tabId, tab.windowId);
            return schedulePageReadyResolve(tabId, changeInfo.url);
        }
        return undefined;
    }).catch(() => undefined);
}

function onTabUpdated(tabId, changeInfo, tab) {
    runAfterStartupRecovery(() => processTabUpdated(tabId, changeInfo, tab));
}

async function processTabActivated(activeInfo) {
    rememberActiveTab(activeInfo.tabId, activeInfo.windowId);
    const pageUrl = await resolveTabUrl(activeInfo.tabId);
    await getCanonicalTabState(activeInfo.tabId);
    await schedulePageReadyResolve(activeInfo.tabId, pageUrl);
}

function onTabActivated(activeInfo) {
    runAfterStartupRecovery(() => processTabActivated(activeInfo).catch(() => undefined));
}

function processTabCreated(tab) {
    if (!Number.isInteger(tab?.id)) return;
    removedTabs.delete(tab.id);
    bumpTabEpoch(tab.id);
    if (tab.active === true) rememberActiveTab(tab.id, tab.windowId);
}

function onTabCreated(tab) {
    runAfterStartupRecovery(() => processTabCreated(tab));
}

function processTabRemoved(tabId) {
    bumpTabEpoch(tabId);
    clearAutoTimer(tabId);
    clearPageReadyResolveTimer(tabId);
    clearExpiryRefreshAlarm(tabId);
    clearExpiryRefreshKick(tabId);
    navigationReservations.delete(tabId);
    clearPendingRequestsForTab(tabId);
    void removePersistedRequestContextsForTab(tabId).catch(() => undefined);
    void chrome.storage.session.remove(tabStateKey(tabId)).catch(() => undefined);
    void chrome.storage.local.remove([`streams_${tabId}`, `logs_${tabId}`]).catch(() => undefined);
    for (const [windowId, activeTabId] of activeTabByWindow) {
        if (activeTabId === tabId) activeTabByWindow.delete(windowId);
    }
}

function onTabRemoved(tabId) {
    // Mark synchronously so recovery cannot treat a just-closed tab as live.
    removedTabs.add(tabId);
    pendingManifestScanTabs.delete(tabId);
    clearAutoTimer(tabId);
    clearExpiryRefreshAlarm(tabId);
    clearExpiryRefreshKick(tabId);
    runAfterStartupRecovery(() => processTabRemoved(tabId));
}

async function recoverSessionState() {
    const stored = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(stored)) {
        if (!key.startsWith(TAB_STATE_PREFIX) || !Number.isInteger(value?.tabId)) continue;
        const state = normalizeTabState(value, value.tabId, value.hostname || '');
        if (removedTabs.has(state.tabId)) continue;
        if (state.navigationEpoch > currentTabEpoch(state.tabId)) {
            tabEpochs.set(state.tabId, state.navigationEpoch);
        }
        const liveHostname = await resolveTabHostname(state.tabId);
        if (!liveHostname) continue;
        const recovered = await getCanonicalTabState(state.tabId).catch(() => null);
        if (recovered?.auto.enabled && Number.isFinite(recovered.auto.pendingDueAt)) {
            armAutoTimer(recovered.tabId, recovered.auto.pendingDueAt);
        }
    }
    const activeTabs = await queryActiveChromeTabs();
    for (const tab of activeTabs) {
        if (!Number.isInteger(tab?.id)) continue;
        rememberActiveTab(tab.id, tab.windowId);
        await getCanonicalTabState(tab.id).catch(() => undefined);
        await schedulePageReadyResolve(tab.id, tab.url || '').catch(() => undefined);
    }
}

function registerRecommendedContextMenu() {
    if (!chrome.contextMenus || contextMenuRegistrationPending) return;
    contextMenuRegistrationPending = true;
    const createMenu = () => {
        try {
            chrome.contextMenus.create({
                id: RECOMMENDED_CONTEXT_MENU_ID,
                title: RECOMMENDED_CONTEXT_MENU_TITLE,
                contexts: ['page'],
                documentUrlPatterns: ['http://*/*', 'https://*/*']
            }, () => {
                void chrome.runtime.lastError;
                contextMenuRegistrationPending = false;
            });
        } catch (_error) {
            contextMenuRegistrationPending = false;
        }
    };
    try {
        chrome.contextMenus.remove(RECOMMENDED_CONTEXT_MENU_ID, () => {
            void chrome.runtime.lastError;
            createMenu();
        });
    } catch (_error) {
        createMenu();
    }
}

function onRecommendedContextMenuClicked(info, tab) {
    if (info?.menuItemId !== RECOMMENDED_CONTEXT_MENU_ID) return;
    runAfterStartupRecovery(() => handleRecommendedContextMenuClick(info, tab));
}

function registerListeners() {
    // Registration itself is synchronous/top-level; async work stays inside the
    // callbacks so MV3 can reliably wake this worker for every event.
    chrome.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        { urls: ['http://*/*', 'https://*/*'], types: RELEVANT_REQUEST_TYPES }
    );
    chrome.webRequest.onSendHeaders.addListener(
        onSendHeaders,
        { urls: ['http://*/*', 'https://*/*'], types: RELEVANT_REQUEST_TYPES },
        ['requestHeaders', 'extraHeaders']
    );
    chrome.webRequest.onHeadersReceived.addListener(
        onHeadersReceived,
        { urls: ['http://*/*', 'https://*/*'], types: RELEVANT_REQUEST_TYPES },
        ['responseHeaders', 'extraHeaders']
    );
    chrome.webRequest.onCompleted.addListener(
        onRequestCompleted,
        { urls: ['http://*/*', 'https://*/*'], types: RELEVANT_REQUEST_TYPES }
    );
    chrome.webRequest.onErrorOccurred.addListener(
        onRequestError,
        { urls: ['http://*/*', 'https://*/*'], types: RELEVANT_REQUEST_TYPES }
    );

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onCreated.addListener(onTabCreated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.contextMenus.onClicked.addListener(onRecommendedContextMenuClicked);
    chrome.alarms?.onAlarm?.addListener(processExpiryRefreshAlarm);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const action = messageAction(message);
        handleRuntimeMessage(message, sender)
            .then(sendResponse)
            .catch((error) => sendResponse(runtimeErrorResponse(action, error)));
        return true;
    });

    chrome.runtime.onInstalled.addListener(() => {
        registerRecommendedContextMenu();
        void migrateLegacyLocalStorage().catch(() => undefined);
    });
    chrome.runtime.onStartup.addListener(registerRecommendedContextMenu);

    registerRecommendedContextMenu();

    startupRecoveryReady = migrateLegacyLocalStorage()
        .catch(() => undefined)
        .then(prunePersistedRequestContexts)
        .then(recoverSessionState)
        .catch(() => undefined);
}

if (typeof chrome !== 'undefined') registerListeners();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        canonicalizeMediaUrl,
        parseMediaUrlExpiry,
        isCandidateExpired,
        expiryRefreshPlan,
        isSafeRemoteManifestUrl,
        isSafeManifestDerivedUrl,
        manifestChildRequestContext,
        platformAdapterForUrl,
        materialScopeForUrl,
        normalizeLanguageTag,
        normalizePreferredLanguages,
        normalizePlatformResolverTarget,
        candidateSourceMethod,
        createTabState,
        normalizeTabState,
        normalizeResolvedCandidate,
        resolverCookieRecord,
        detectMediaFromUrl,
        detectMediaFromContentType,
        parseHlsAttributeList,
        parseHlsMasterPlaylist,
        parseDashManifestRepresentations,
        parseManifestVariants,
        isLikelySegmentUrl,
        normalizeContentType,
        classifyMediaRole,
        classifyMediaPurpose,
        isBlockedCandidate,
        isExplicitlyFailedCandidate,
        selectRecommendedCandidate,
        inferCandidateQuality,
        inferCandidateHeight,
        inferCandidateBitrateKbps,
        normalizeQualityOrder,
        candidateQualityBucket,
        candidateQualityRank,
        DEFAULT_QUALITY_ORDER,
        scoreCandidate,
        candidateMediaCompleteness,
        candidatePlaybackFitnessTier,
        candidateTransportTier,
        candidateMediaTransportRank,
        candidatePlaylistTier,
        compareCandidates,
        compareCandidatesForRecommendation,
        compareCandidatesForRetention,
        isConfirmedAutoTransport,
        buildStreamPayload,
        PLAY_TIMEOUT_MS,
        STATE_SCHEMA_VERSION,
        redactMediaMetadata,
        sanitizePublicMessage,
        normalizeErrorCode,
        normalizeHostname,
        normalizePlayMode,
        isLegacyLocalKey,
        stableHash,
        sourcePreferenceFingerprint,
        sourceFamilySignature,
        sourceFamilyFingerprint,
        sourceFamilyLabel,
        normalizeSourcePriority,
        isGenericPrerollProvisional,
        GENERIC_PREROLL_GUARD_MS,
        GENERIC_SHORT_MEDIA_MAX_SECONDS,
        isSameObservedRequest
    };
}

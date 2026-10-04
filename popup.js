'use strict';

const REQUEST_TIMEOUT_MS = 14000;
const PLAY_REQUEST_TIMEOUT_MS = 28000;
const RESOLVE_REQUEST_TIMEOUT_MS = 32000;
const RESOLVER_STALE_MS = 35000;
const TAB_QUERY_TIMEOUT_MS = 8000;
const PERMISSION_TIMEOUT_MS = 10000;
const SESSION_KEY_PREFIX = 'tabState_';
const POPUP_VIEW_STATE_KEY_PREFIX = 'mpvRedirectorPopupView_';
const POPUP_VIEW_STATE_WRITE_DEBOUNCE_MS = 100;
const VALID_PLAY_MODES = new Set(['new', 'append', 'replace']);
const DEFAULT_SOURCE_QUALITY_ORDER = Object.freeze(['2160p', '1440p', '1080p', '720p', '480p']);
const SOURCE_QUALITY_LABELS = Object.freeze({
    '2160p': '4K / 2160p',
    '1440p': '1440p',
    '1080p': 'Full HD / 1080p',
    '720p': '720p',
    '480p': '480p'
});
const TRANSIENT_NATIVE_HOST_ERROR_CODES = new Set([
    'NATIVE_HOST_FORBIDDEN',
    'NATIVE_HOST_NOT_FOUND',
    'NATIVE_HOST_DISCONNECTED',
    'NATIVE_MESSAGING_ERROR',
    'NATIVE_TIMEOUT'
]);

function normalizeHostRecoveryStatusCode(status) {
    const values = [status?.code, status?.state, status?.name, status?.stage];
    const raw = values.find((value) => typeof value === 'string' && value.trim()) || 'IDLE';
    return raw.trim().replace(/[\s.-]+/g, '_').toUpperCase();
}

function isSupersededTransientNativeHostError(status, health) {
    const statusUpdatedAt = status?.updatedAt;
    const healthCheckedAt = health?.checkedAt;
    return health?.probeSucceeded === true &&
        health?.hostAvailable === true &&
        Number.isFinite(statusUpdatedAt) &&
        Number.isFinite(healthCheckedAt) &&
        healthCheckedAt > statusUpdatedAt &&
        TRANSIENT_NATIVE_HOST_ERROR_CODES.has(normalizeHostRecoveryStatusCode(status));
}

function createRecoveredNativeHostView(status, health, candidateCount = 0) {
    if (!isSupersededTransientNativeHostError(status, health)) return null;
    return {
        stage: 'Połączenie przywrócone',
        title: 'Host lokalny odpowiada',
        message: 'Nowsza kontrola hosta zakończyła się powodzeniem.',
        reason: candidateCount > 0
            ? 'Poprzedni błąd transportu jest historyczny. Spróbuj ponownie otworzyć wybrane źródło.'
            : 'Poprzedni błąd transportu jest historyczny. Uruchom wideo, aby wykryć nowe źródło.',
        tone: 'success',
        resultLabel: 'Co dalej:'
    };
}

function resolverMethodLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'streamlink' || normalized === 'resolver_streamlink') return 'Streamlink';
    if (normalized === 'yt-dlp' || normalized === 'ytdlp' || normalized === 'resolver_ytdlp') return 'yt-dlp';
    if (normalized === 'manifest' || normalized === 'manifest_scan') return 'Manifest';
    if (normalized === 'page' || normalized === 'page_dom') return 'Strona';
    return 'Sieć';
}

function resolverPlatformId(platformId, hostname = '') {
    const normalizedHostname = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (platformId === 'youtube' ||
        normalizedHostname === 'youtu.be' ||
        normalizedHostname === 'youtube.com' ||
        normalizedHostname.endsWith('.youtube.com')) return 'youtube';
    if (platformId === 'tvp' ||
        normalizedHostname === 'sport.tvp.pl' ||
        normalizedHostname.endsWith('.sport.tvp.pl')) return 'tvp';
    return 'generic';
}

function resolverPlatformLabel(platform, hostname = '') {
    const platformId = resolverPlatformId(platform?.id, hostname);
    if (platformId === 'youtube') return 'YouTube';
    if (platformId === 'tvp') return 'TVP';
    const label = typeof platform?.label === 'string' ? platform.label.trim().slice(0, 40) : '';
    return label || 'Strona internetowa';
}

function resolverOrderCopy(platformId, hostname = '') {
    if (resolverPlatformId(platformId, hostname) === 'youtube') {
        return Object.freeze({
            label: 'yt-dlp → Streamlink',
            running: 'Analiza trwa: yt-dlp, a potem w razie potrzeby Streamlink. Wynik pojawi się na liście.',
            action: 'Najpierw uruchamiam yt-dlp, a jeśli nie znajdzie wyniku — Streamlink.'
        });
    }
    return Object.freeze({
        label: 'Streamlink → yt-dlp',
        running: 'Analiza trwa: Streamlink, a potem w razie potrzeby yt-dlp. Wynik pojawi się na liście.',
        action: 'Najpierw uruchamiam Streamlink, a jeśli nie znajdzie wyniku — yt-dlp.'
    });
}

function usesPolishFewForm(count) {
    const normalized = Math.abs(Number(count));
    const lastDigit = normalized % 10;
    const lastTwoDigits = normalized % 100;
    return Number.isInteger(normalized) &&
        lastDigit >= 2 && lastDigit <= 4 &&
        !(lastTwoDigits >= 12 && lastTwoDigits <= 14);
}

function candidateOriginLabels(sourceMethod, sources = []) {
    const values = [sourceMethod, ...(Array.isArray(sources) ? sources : [])]
        .filter((value) => typeof value === 'string' && value.trim())
        .map(resolverMethodLabel);
    return [...new Set(values.length ? values : ['Sieć'])];
}

function resolverAttemptSummary(attempted) {
    if (!Array.isArray(attempted) || attempted.length === 0) return 'Brak bezpiecznych szczegółów próby.';
    const labels = {
        found: 'znaleziono',
        empty: 'bez wyniku',
        unavailable: 'brak programu',
        incompatible: 'wymaga aktualizacji',
        timeout: 'limit czasu',
        failed: 'błąd wykonania',
        invalid_output: 'niepoprawna odpowiedź',
        overflow: 'za dużo danych'
    };
    return attempted.slice(0, 2).map((attempt) => {
        const resolver = resolverMethodLabel(attempt?.resolver);
        const status = labels[String(attempt?.status || '').toLowerCase()] || 'nieznany wynik';
        return `${resolver}: ${status}`;
    }).join('; ');
}

function candidateMediaKindLabel(mediaKind, role = 'unknown', live = false) {
    const labels = {
        adaptive: 'Adaptacyjne audio + wideo',
        muxed: 'Audio + wideo',
        'video-only': 'Tylko obraz',
        'audio-only': 'Tylko dźwięk'
    };
    if (labels[mediaKind]) return labels[mediaKind];
    if (role === 'audio') return 'Tylko dźwięk';
    if (live) return 'Transmisja na żywo';
    return 'Materiał wideo';
}

function candidateLanguageLabel(language) {
    const normalized = typeof language === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
        ? language
        : '';
    return normalized ? `Język: ${normalized}` : '';
}

function mpvAlangValue(language) {
    const normalized = typeof language === 'string' && language.length <= 35 &&
        /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
        ? language
        : '';
    if (!normalized) return '';
    const primary = normalized.split('-', 1)[0].toLowerCase();
    return normalized.toLowerCase() === primary ? primary : `${normalized},${primary}`;
}

function ytdlFormatValue(language) {
    const normalized = typeof language === 'string' && language.length <= 35 &&
        /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
        ? language
        : '';
    const video = 'bv[height<=1080]';
    const muxed = 'b[height<=1080]';
    const fallback = `${video}+ba/${muxed}`;
    if (!normalized) return fallback;
    const primary = normalized.split('-', 1)[0].toLowerCase();
    const choices = [];
    if (normalized.toLowerCase() !== primary) choices.push(`${video}+ba[language=${normalized}]`);
    choices.push(`${video}+ba[language^=${primary}]`);
    if (normalized.toLowerCase() !== primary) choices.push(`${muxed}[language=${normalized}]`);
    choices.push(`${muxed}[language^=${primary}]`, fallback);
    return choices.join('/');
}

function diagnosticSourceCountLabel(count) {
    if (count === 1) return '1 techniczna obserwacja karty jest ukryta przed odtwarzaniem.';
    return `${count} technicznych obserwacji karty jest ukrytych przed odtwarzaniem.`;
}

const VALID_USER_PRIORITIES = new Set([-1, 0, 1]);

function normalizeUserPriority(value) {
    return Number.isInteger(value) && VALID_USER_PRIORITIES.has(value) ? value : 0;
}

function candidatePriorityMode(value) {
    const normalized = normalizeUserPriority(value);
    if (normalized === 1) return 'preferred';
    if (normalized === -1) return 'deprioritized';
    return 'normal';
}

function normalizeSourcePreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { showFullUrls: source.showFullUrls === true };
}

function normalizeQualityOrder(value) {
    if (!Array.isArray(value) || value.length !== DEFAULT_SOURCE_QUALITY_ORDER.length) {
        return [...DEFAULT_SOURCE_QUALITY_ORDER];
    }
    const normalized = value.map((quality) => typeof quality === 'string' ? quality.toLowerCase() : '');
    if (new Set(normalized).size !== DEFAULT_SOURCE_QUALITY_ORDER.length ||
        normalized.some((quality) => !DEFAULT_SOURCE_QUALITY_ORDER.includes(quality))) {
        return [...DEFAULT_SOURCE_QUALITY_ORDER];
    }
    return normalized;
}

function resolveCandidateUrlVisibility(globalVisible, temporaryOverride) {
    return typeof temporaryOverride === 'boolean' ? temporaryOverride : globalVisible === true;
}

function buildCandidatePriorityRequest(tabId, candidateId, value) {
    return {
        tabId,
        candidateId: String(candidateId ?? ''),
        priority: candidatePriorityMode(value)
    };
}

function buildSourceUrlVisibilityRequest(tabId, visible) {
    return { tabId, visible: visible === true };
}

function buildQualityOrderRequest(tabId, qualityOrder) {
    return { tabId, qualityOrder: normalizeQualityOrder(qualityOrder) };
}

function normalizeCandidateExpiry(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric >= 1_000_000_000 && numeric < 1_000_000_000_000) return numeric * 1000;
    if (numeric >= 1_000_000_000_000 && numeric <= 253_402_300_799_000) return numeric;
    return null;
}

function isExpiredCandidate(candidate, now = Date.now()) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (candidate.expired === true || candidate.raw?.expired === true) return true;
    const expiry = normalizeCandidateExpiry(
        candidate.expiry ?? candidate.expiresAt ?? candidate.raw?.expiry ?? candidate.raw?.expiresAt
    );
    return expiry !== null && expiry <= now;
}

function isRejectedCandidate(candidate, now = Date.now()) {
    const playState = String(candidate?.playState ?? candidate?.raw?.playState ?? '').trim().toLowerCase();
    return candidate?.failed === true || playState === 'error' || isExpiredCandidate(candidate, now);
}

function isReadyCandidate(candidate) {
    return Boolean(
        candidate &&
        candidate.id &&
        candidate.url &&
        candidate.diagnosticOnly !== true &&
        candidate.blocked !== true &&
        !isRejectedCandidate(candidate) &&
        candidate.drmProtected !== true &&
        !['advertisement', 'utility'].includes(candidate.purpose)
    );
}

function isRecommendationEligibleCandidate(candidate) {
    return Boolean(
        candidate &&
        candidate.prerollProvisional !== true &&
        candidate.diagnosticOnly !== true &&
        candidate.blocked !== true &&
        !isRejectedCandidate(candidate) &&
        candidate.drmProtected !== true &&
        !['advertisement', 'utility'].includes(candidate.purpose) &&
        !['video-only', 'audio-only'].includes(candidate.mediaKind) &&
        candidate.hasAudio !== false &&
        candidate.hasVideo !== false &&
        candidate.role !== 'audio'
    );
}

function chooseRecommendedCandidate(candidates, status) {
    const eligible = Array.isArray(candidates)
        ? candidates.filter(isRecommendationEligibleCandidate)
        : [];
    if (eligible.length === 0) return null;

    const preferredId = status?.recommendedCandidateId ?? '';
    const explicit = eligible.find((candidate) => candidate.recommended) ||
        eligible.find((candidate) => preferredId && candidate.id === String(preferredId));
    if (explicit) return explicit;

    // The worker returns one canonical, safety-aware playlist order. Preserve
    // it here instead of recreating a weaker score-only ranking in the popup.
    return eligible[0] || null;
}

const MODE_COPY = Object.freeze({
    new: 'Uruchomi nowe okno MPV.',
    append: 'Doda strumień do playlisty działającego MPV.',
    replace: 'Zastąpi aktualnie odtwarzaną pozycję.'
});

const STATUS_COPY = Object.freeze({
    INIT: { stage: 'Uruchamianie', title: 'Przygotowuję wykrywanie', tone: 'loading' },
    LOADING: { stage: 'Wczytywanie', title: 'Pobieram stan karty', tone: 'loading' },
    IDLE: { stage: 'Nasłuchiwanie', title: 'Czekam na odtwarzanie', tone: 'loading' },
    SCANNING: { stage: 'Nasłuchiwanie', title: 'Skanuję ruch tej karty', tone: 'loading' },
    WAITING: { stage: 'Nasłuchiwanie', title: 'Czekam na strumień wideo', tone: 'loading' },
    LISTENING: { stage: 'Nasłuchiwanie', title: 'Obserwuję ruch wideo', tone: 'loading' },
    DETECTING: { stage: 'Wykrywanie', title: 'Analizuję znalezione źródła', tone: 'loading' },
    ANALYZING: { stage: 'Analiza', title: 'Oceniam kandydatów', tone: 'loading' },
    RESOLVER_RUNNING: { stage: 'Rozpoznawanie', title: 'Pytam Streamlink i yt-dlp', tone: 'loading' },
    RESOLVER_FOUND: { stage: 'Gotowe', title: 'Resolver rozpoznał źródła', tone: 'success' },
    RESOLVER_EMPTY: { stage: 'Brak wyniku', title: 'Resolvery nie znalazły strumienia', tone: 'warning' },
    RESOLVER_UNAVAILABLE: { stage: 'Brak narzędzi', title: 'Streamlink i yt-dlp są niedostępne', tone: 'warning' },
    RESOLVER_FAILED: { stage: 'Błąd resolvera', title: 'Nie udało się rozpoznać strony', tone: 'error' },
    STREAM_URL_EXPIRED: { stage: 'Odświeżanie', title: 'Źródło wygasło', tone: 'warning' },
    STREAM_REFRESH_REQUESTED: { stage: 'Odświeżanie', title: 'Szukam świeżego źródła', tone: 'loading' },
    STREAM_REFRESHING: { stage: 'Odświeżanie', title: 'Szukam świeżego źródła', tone: 'loading' },
    STREAM_REFRESHED: { stage: 'Gotowe', title: 'Źródło zostało odświeżone', tone: 'success' },
    STREAM_REFRESH_FAILED: { stage: 'Odświeżanie', title: 'Nie znaleziono jeszcze świeżego źródła', tone: 'warning' },
    CANDIDATE_FOUND: { stage: 'Gotowe', title: 'Znaleziono źródło do odtworzenia', tone: 'ready' },
    MEDIA_DETECTED: { stage: 'Wykryto', title: 'Znaleziono media do odtworzenia', tone: 'ready' },
    READY: { stage: 'Gotowe', title: 'Możesz otworzyć strumień', tone: 'ready' },
    AUTO_DISABLED: { stage: 'Czeka na decyzję', title: 'Auto-otwieranie jest wyłączone', tone: 'warning' },
    SITE_AUTO_DISABLED: { stage: 'Czeka na decyzję', title: 'Auto-otwieranie jest wyłączone', tone: 'warning' },
    LEGACY_AUTO_REQUIRES_CONFIRMATION: { stage: 'Wymaga decyzji', title: 'Potwierdź auto-otwieranie dla tej strony', tone: 'warning' },
    AUTO_ENABLED: { stage: 'Wybieranie', title: 'Wybieram bezpieczny strumień', tone: 'loading' },
    NO_SAFE_AUTO_CANDIDATE: { stage: 'Weryfikacja', title: 'Czekam na bezpieczne źródło', tone: 'warning' },
    AUTO_ALREADY_ATTEMPTED: { stage: 'Obsłużono', title: 'Ten strumień był już uruchamiany', tone: 'warning' },
    AUTO_SKIPPED: { stage: 'Czeka na decyzję', title: 'Nie uruchomiono automatycznie', tone: 'warning' },
    ADS_FILTERED: { stage: 'Filtrowanie', title: 'Pominięto reklamę', tone: 'warning' },
    ADVERTISEMENT_FILTERED: { stage: 'Filtrowanie', title: 'Pominięto reklamę', tone: 'warning' },
    UTILITY_MEDIA_FILTERED: { stage: 'Filtrowanie', title: 'Pominięto plik techniczny', tone: 'warning' },
    OPENING: { stage: 'Przekazywanie', title: 'Uruchamiam MPV', tone: 'loading' },
    OPENING_MPV: { stage: 'Przekazywanie', title: 'Uruchamiam MPV', tone: 'loading' },
    PLAY_FALLBACK_OPENING: { stage: 'Próba zapasowa', title: 'Próbuję innego źródła', tone: 'loading' },
    PLAYING: { stage: 'Zakończono', title: 'Przekazano strumień do MPV', tone: 'success' },
    PLAY_CONFIRMED: { stage: 'Zakończono', title: 'MPV rozpoczął odtwarzanie', tone: 'success' },
    OPENED: { stage: 'Zakończono', title: 'MPV otrzymał strumień', tone: 'success' },
    SUCCESS: { stage: 'Zakończono', title: 'Operacja zakończona powodzeniem', tone: 'success' },
    NO_CANDIDATE: { stage: 'Nasłuchiwanie', title: 'Nie znaleziono jeszcze źródła', tone: 'warning' },
    UNSUPPORTED: { stage: 'Zatrzymano', title: 'Nieobsługiwany typ materiału', tone: 'warning' },
    DRM: { stage: 'Zatrzymano', title: 'Wykryto chroniony materiał', tone: 'warning' },
    PERMISSION: { stage: 'Brak dostępu', title: 'Chrome nie udostępnia tej strony', tone: 'permission' },
    PERMISSION_DENIED: { stage: 'Brak dostępu', title: 'Rozszerzenie nie ma dostępu', tone: 'permission' },
    HOST_MISSING: { stage: 'Brak połączenia', title: 'Host lokalny jest niedostępny', tone: 'host' },
    HOST_ERROR: { stage: 'Brak połączenia', title: 'Host lokalny zgłosił błąd', tone: 'host' },
    NETWORK_REQUEST_FAILED: { stage: 'Błąd sieci', title: 'Żądanie multimediów nie powiodło się', tone: 'error' },
    TIMEOUT: { stage: 'Przekroczono czas', title: 'Worker nie odpowiedział', tone: 'error' },
    FAILED: { stage: 'Błąd', title: 'Nie udało się wykonać operacji', tone: 'error' },
    ERROR: { stage: 'Błąd', title: 'Wykrywanie napotkało problem', tone: 'error' }
});

class PopupRequestError extends Error {
    constructor(message, code = 'UNKNOWN_ERROR') {
        super(message);
        this.name = 'PopupRequestError';
        this.code = code;
    }
}

function commandHeaderValue(source, wantedName) {
    const directNames = wantedName === 'user-agent'
        ? ['userAgent', 'user-agent']
        : [wantedName];
    for (const name of directNames) {
        const direct = source?.[name];
        if (typeof direct === 'string' && direct) return direct;
    }

    const containers = [source?.headers, source?.requestHeaders];
    for (const container of containers) {
        if (Array.isArray(container)) {
            const match = container.find((header) => String(header?.name || '').toLowerCase() === wantedName);
            if (typeof match?.value === 'string') return match.value;
        } else if (container && typeof container === 'object') {
            const key = Object.keys(container).find((name) => name.toLowerCase() === wantedName);
            if (key && typeof container[key] === 'string') return container[key];
        }
    }
    return '';
}

function shellQuote(value) {
    const cleanValue = String(value ?? '').replace(/[\0\r\n]/g, '');
    return `'${cleanValue.replace(/'/g, `'\\''`)}'`;
}

function buildMpvCommand(candidate) {
    if (!candidate?.url) throw new PopupRequestError('Kandydat nie zawiera adresu strumienia.', 'MISSING_URL');
    const raw = candidate.raw && typeof candidate.raw === 'object' ? candidate.raw : {};
    const source = raw.stream && typeof raw.stream === 'object' ? raw.stream : raw;
    const referer = commandHeaderValue(source, 'referer');
    const origin = commandHeaderValue(source, 'origin');
    const userAgent = commandHeaderValue(source, 'user-agent');
    const parts = ['mpv', '--tls-verify=yes', '--load-unsafe-playlists=no'];

    if (referer) parts.push(`--referrer=${shellQuote(referer)}`);
    if (userAgent) parts.push(`--user-agent=${shellQuote(userAgent)}`);
    if (origin) parts.push(`--http-header-fields=${shellQuote(`Origin: ${origin}`)}`);
    if (candidate.playbackKind === 'yt-dlp-page') {
        parts.push('"--script-opts-append=ytdl_hook-ytdl_path=$HOME/.local/share/mpv-redirector/resolvers/bin/yt-dlp"');
        for (const option of [
            'ytdl_hook-try_ytdl_first=yes',
            'ytdl_hook-use_manifests=no',
            'ytdl_hook-all_formats=no',
            'ytdl_hook-force_all_formats=no',
            'ytdl_hook-thumbnails=none',
            'ytdl_hook-exclude='
        ]) parts.push(`--script-opts-append=${option}`);
        parts.push('--ytdl=yes');
        parts.push(`--ytdl-format=${shellQuote(ytdlFormatValue(candidate.language))}`);
        for (const option of [
            'ignore-config=', 'no-plugin-dirs=', 'no-remote-components=', 'no-update=',
            'no-cache-dir=', 'no-cookies-from-browser=', 'no-cookies=', 'no-playlist=',
            'playlist-items=1', 'no-wait-for-video=', 'no-mark-watched=',
            'socket-timeout=5', 'extractor-retries=1', 'retries=0', 'fragment-retries=0'
        ]) parts.push(`--ytdl-raw-options-append=${option}`);
    }
    const alang = mpvAlangValue(candidate.language);
    if (alang) parts.push(`--alang=${shellQuote(alang)}`);
    parts.push('--', shellQuote(candidate.url));
    return parts.join(' ');
}

function buildLaunchScript(candidate) {
    return `#!/usr/bin/env bash\nset -euo pipefail\n\n${buildMpvCommand(candidate)}\n`;
}

function sendRuntimeRequest(
    chromeApi,
    type,
    payload = {},
    timeoutMs = type === 'PLAY' ? PLAY_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    clock = globalThis
) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            clock.clearTimeout(timer);
            callback();
        };
        const timer = clock.setTimeout(() => {
            finish(() => reject(new PopupRequestError(
                `Worker nie odpowiedział na ${type} w ciągu ${Math.ceil(timeoutMs / 1000)} sekund.`,
                'REQUEST_TIMEOUT'
            )));
        }, timeoutMs);

        try {
            chromeApi.runtime.sendMessage({
                type,
                action: type,
                ...payload
            }, (response) => {
                const runtimeError = chromeApi.runtime.lastError;
                if (runtimeError) {
                    finish(() => reject(new PopupRequestError(runtimeError.message, 'RUNTIME_MESSAGE_FAILED')));
                    return;
                }
                if (response === undefined) {
                    finish(() => reject(new PopupRequestError('Worker nie zwrócił odpowiedzi.', 'EMPTY_RESPONSE')));
                    return;
                }
                finish(() => resolve(response));
            });
        } catch (error) {
            finish(() => reject(error));
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const ui = {
        version: document.getElementById('app-version'),
        hostHealth: document.getElementById('host-health'),
        hostHealthText: document.getElementById('host-health-text'),
        mpvHealth: document.getElementById('mpv-health'),
        mpvHealthText: document.getElementById('mpv-health-text'),
        refreshButton: document.getElementById('refresh-button'),
        siteHostname: document.getElementById('site-hostname'),
        siteAutoToggle: document.getElementById('site-auto-toggle'),
        siteAutoNote: document.getElementById('site-auto-note'),
        resolverHealth: document.getElementById('resolver-health'),
        resolverNote: document.getElementById('resolver-note'),
        resolvePageButton: document.getElementById('resolve-page-button'),
        resolverCookieToggle: document.getElementById('resolver-cookie-toggle'),
        resolverCookieHost: document.getElementById('resolver-cookie-host'),
        resolverCookieNote: document.getElementById('resolver-cookie-note'),
        permissionNotice: document.getElementById('permission-notice'),
        permissionMessage: document.getElementById('permission-message'),
        hostNotice: document.getElementById('host-notice'),
        hostNoticeTitle: document.getElementById('host-notice-title'),
        hostNoticeMessage: document.getElementById('host-notice-message'),
        progressCard: document.getElementById('progress-card'),
        stageIcon: document.getElementById('stage-icon'),
        stageLabel: document.getElementById('stage-label'),
        statusTitle: document.getElementById('status-title'),
        statusMessage: document.getElementById('status-message'),
        reasonLabel: document.getElementById('reason-label'),
        statusReason: document.getElementById('status-reason'),
        playOptions: document.getElementById('play-options'),
        modeHelp: document.getElementById('mode-help'),
        candidateCount: document.getElementById('candidate-count'),
        diagnosticSourceNote: document.getElementById('diagnostic-source-note'),
        playlistTools: document.getElementById('playlist-tools'),
        playlistSummary: document.getElementById('playlist-summary'),
        quickPlayButton: document.getElementById('quick-play-button'),
        exportM3uButton: document.getElementById('export-m3u-button'),
        sourcePreferences: document.getElementById('source-preferences'),
        showFullUrlsToggle: document.getElementById('show-full-urls-toggle'),
        qualityOrderPanel: document.getElementById('quality-order-panel'),
        qualityOrderSummary: document.getElementById('quality-order-summary'),
        qualityOrderList: document.getElementById('quality-order-list'),
        qualityOrderFeedback: document.getElementById('quality-order-feedback'),
        candidateContent: document.getElementById('candidate-content'),
        scrollRoot: document.scrollingElement || document.documentElement,
        diagnosticsPanel: document.getElementById('diagnostics-panel'),
        eventCount: document.getElementById('event-count'),
        eventList: document.getElementById('event-list'),
        globalFeedback: document.getElementById('global-feedback'),
        clearButton: document.getElementById('clear-button')
    };

    let activeTab = null;
    let currentHostname = '';
    let restrictedContext = null;
    let currentState = createEmptyState('');
    let stateLoaded = false;
    let stateLoadError = null;
    let siteAutoEnabled = null;
    let siteAutoBusy = false;
    let resolverBusy = false;
    let resolverCookieEnabled = null;
    let resolverCookieHttpsEligible = false;
    let resolverCookiePermissionGranted = false;
    let resolverCookieEnabledSiteCount = 0;
    let resolverCookieBusy = false;
    let healthState = {
        hostAvailable: null,
        mpvAvailable: null,
        mpvRunning: null,
        message: '',
        capabilities: [],
        resolvers: createEmptyResolverHealth(),
        probeSucceeded: false,
        checkedAt: 0
    };
    let actionView = null;
    let localEvents = [];
    let feedbackTimer = null;
    let sourceUrlVisibilityBusy = false;
    let pendingSourceUrlVisibility = null;
    let qualityOrderBusy = false;
    let pendingQualityOrder = null;
    let exportM3uBusy = false;
    let candidateControlSerial = 0;
    let renderedCandidateScopeKey = '';
    let candidateViewState = null;
    let viewStatePersistTimer = null;
    const candidatePriorityBusyIds = new Set();
    const candidatePlayBusyIds = new Set();
    const candidateUrlVisibilityOverrides = new Map();

    ensureQualityOrderUi();
    setVersion();
    bindStaticEvents();
    renderAll();
    void initialize().catch((error) => {
        handleStateError(error);
        setGlobalFeedback(friendlyError(error), 'error', true);
    });

    async function initialize() {
        const tabs = await queryActiveTabs();
        activeTab = tabs[0] || null;

        if (!activeTab || !Number.isInteger(activeTab.id)) {
            throw new PopupRequestError('Nie udało się ustalić aktywnej karty Chrome.', 'NO_ACTIVE_TAB');
        }

        const tabContext = readTabContext(activeTab.url || '');
        currentHostname = tabContext.hostname;
        restrictedContext = tabContext.restricted;
        currentState = createEmptyState(currentHostname);
        renderSiteContext();

        chrome.storage.onChanged.addListener(handleStorageChange);
        window.addEventListener('unload', () => {
            captureCandidateViewState(renderedCandidateScopeKey);
            persistCandidateViewStateNow();
            chrome.storage.onChanged.removeListener(handleStorageChange);
        }, { once: true });

        const tasks = [
            refreshState().catch((error) => {
                handleStateError(error);
                throw error;
            }),
            refreshHealth().catch((error) => {
                handleHealthError(error);
                throw error;
            }),
            refreshDefaultPlayMode().catch((error) => {
                handlePlayModeStorageError(error, 'Nie odczytano zapisanego trybu otwarcia.');
                throw error;
            })
        ];

        if (currentHostname) {
            tasks.push(refreshSiteAuto().catch((error) => {
                handleSiteAutoError(error);
                throw error;
            }));
            tasks.push(refreshResolverCookiePolicy().catch((error) => {
                handleResolverCookieError(error);
                throw error;
            }));
        } else {
            siteAutoEnabled = false;
            resolverCookieEnabled = false;
            renderSiteAuto();
            renderResolverControl();
        }

        const results = await Promise.allSettled(tasks);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) {
            setGlobalFeedback('Część kontroli nie odpowiedziała. Szczegóły są widoczne wyżej.', 'error', true);
        }
    }

    function setVersion() {
        try {
            const version = chrome.runtime.getManifest().version;
            ui.version.textContent = version ? `v${version}` : 'v—';
            ui.version.setAttribute('aria-label', version ? `Wersja rozszerzenia ${version}` : 'Wersja rozszerzenia nieznana');
        } catch (error) {
            ui.version.textContent = 'v—';
        }
    }

    function bindStaticEvents() {
        ui.refreshButton.addEventListener('click', handleRefreshClick);
        ui.clearButton.addEventListener('click', handleClearClick);
        ui.siteAutoToggle.addEventListener('change', handleSiteAutoChange);
        ui.resolvePageButton.addEventListener('click', () => {
            void handleResolveClick();
        });
        ui.resolverCookieToggle.addEventListener('change', () => {
            void handleResolverCookieChange();
        });
        ui.showFullUrlsToggle.addEventListener('change', () => {
            void handleSourceUrlVisibilityChange();
        });
        ui.quickPlayButton.addEventListener('click', () => {
            const candidates = currentState.candidates.filter(isReadyCandidate);
            const recommended = candidates.length ? chooseRecommendedCandidate(candidates, currentState.status) : null;
            if (recommended) void playCandidate(recommended, ui.quickPlayButton);
        });
        ui.exportM3uButton.addEventListener('click', () => {
            void handleExportM3u();
        });
        ui.candidateContent.addEventListener('toggle', handleCandidateViewInteraction, true);
        ui.candidateContent.addEventListener('focusin', handleCandidateViewInteraction);
        ui.candidateContent.addEventListener('scroll', handleCandidateViewInteraction);
        document.addEventListener('scroll', handleCandidateViewInteraction);

        document.querySelectorAll('input[name="play-mode"]').forEach((input) => {
            input.addEventListener('change', () => {
                const mode = getPlayMode();
                ui.modeHelp.textContent = MODE_COPY[mode] || MODE_COPY.new;
                void persistDefaultPlayMode(mode);
            });
        });
    }

    function ensureQualityOrderUi() {
        if (ui.qualityOrderPanel && ui.qualityOrderList && ui.qualityOrderSummary && ui.qualityOrderFeedback) return;

        const panel = document.createElement('details');
        panel.className = 'quality-order-panel';
        panel.id = 'quality-order-panel';

        const summary = document.createElement('summary');
        const summaryCopy = document.createElement('span');
        summaryCopy.appendChild(createTextElement('strong', '', 'Kolejność jakości dla domeny'));
        const summaryValue = createTextElement('small', '', 'Najpierw 4K / 2160p');
        summaryCopy.appendChild(summaryValue);
        summary.appendChild(summaryCopy);

        const body = document.createElement('div');
        body.className = 'quality-order-body';
        const help = createTextElement(
            'p',
            'quality-order-help',
            'Źródła wyżej na liście mają pierwszeństwo. Ustawienie jest zapisywane tylko dla tej domeny.'
        );
        help.id = 'quality-order-help';
        const list = document.createElement('ol');
        list.className = 'quality-order-list';
        list.setAttribute('aria-describedby', help.id);
        const feedback = document.createElement('p');
        feedback.className = 'quality-order-feedback';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        body.append(help, list, feedback);
        panel.append(summary, body);

        const parent = ui.sourcePreferences?.parentElement || ui.candidateContent?.parentElement;
        parent?.appendChild(panel);
        ui.qualityOrderPanel = panel;
        ui.qualityOrderSummary = summaryValue;
        ui.qualityOrderList = list;
        ui.qualityOrderFeedback = feedback;
    }

    async function handleExportM3u() {
        if (exportM3uBusy) return;
        const readyCandidates = currentState.candidates.filter(isM3uExportableCandidate);
        if (!readyCandidates.length) {
            setGlobalFeedback('Polecany wpis yt-dlp wymaga hosta MPV. Użyj przycisku MPV albo zapisz skrypt uruchamiający.', 'error', true);
            return;
        }

        exportM3uBusy = true;
        ui.exportM3uButton.disabled = true;
        ui.exportM3uButton.textContent = 'Tworzę M3U…';
        ui.exportM3uButton.setAttribute('aria-busy', 'true');
        try {
            await downloadM3uPlaylist(readyCandidates);
            addLocalEvent('success', 'M3U_EXPORTED', `Zapisano playlistę z ${readyCandidates.length} źródłami.`);
            renderDiagnostics();
            setGlobalFeedback('Zapisano świeże adresy M3U. Źródła wymagające nagłówków otwieraj przyciskiem MPV.', 'success');
        } catch (error) {
            const message = friendlyError(error);
            addLocalEvent('error', error.code || 'M3U_EXPORT_FAILED', message);
            renderDiagnostics();
            setGlobalFeedback(message, 'error', true);
        } finally {
            exportM3uBusy = false;
            syncPlaylistActionBusyState();
        }
    }

    async function handleRefreshClick() {
        const originalText = ui.refreshButton.textContent;
        ui.refreshButton.disabled = true;
        ui.refreshButton.textContent = '…';
        setGlobalFeedback('Odświeżam stan workera i hosta.', '');

        try {
            const tasks = [
                refreshState().catch((error) => {
                    handleStateError(error);
                    throw error;
                }),
                refreshHealth().catch((error) => {
                    handleHealthError(error);
                    throw error;
                })
            ];
            if (currentHostname) {
                tasks.push(refreshSiteAuto().catch((error) => {
                    handleSiteAutoError(error);
                    throw error;
                }));
                tasks.push(refreshResolverCookiePolicy().catch((error) => {
                    handleResolverCookieError(error);
                    throw error;
                }));
            }
            const results = await Promise.allSettled(tasks);
            const rejected = results.filter((result) => result.status === 'rejected');

            if (rejected.length > 0) {
                rejected.forEach((result) => addLocalEvent('error', 'REFRESH_FAILED', friendlyError(result.reason)));
                setGlobalFeedback('Nie wszystkie kontrole odpowiedziały. Sprawdź komunikaty wyżej.', 'error', true);
            } else {
                setGlobalFeedback('Stan został odświeżony.', 'success');
            }
        } finally {
            ui.refreshButton.disabled = false;
            ui.refreshButton.textContent = originalText;
        }
    }

    async function handleClearClick() {
        if (!activeTab) return;

        const originalText = ui.clearButton.textContent;
        ui.clearButton.disabled = true;
        ui.clearButton.textContent = 'Czyszczę…';
        setGlobalFeedback('Czyszczę dane tylko dla bieżącej karty.', '');

        try {
            const response = await sendWorkerRequest('CLEAR_TAB', { tabId: activeTab.id });
            assertWorkerResponse(response, 'Nie udało się wyczyścić sesji tej karty.');

            currentState = createEmptyState(currentHostname);
            candidateUrlVisibilityOverrides.clear();
            resetCandidateViewState();
            stateLoaded = true;
            stateLoadError = null;
            actionView = {
                stage: 'Wyczyszczono',
                title: 'Sesja tej karty jest pusta',
                message: 'Poprzedni stan wykrywania został usunięty.',
                reason: 'Nowe źródła pojawią się po ponownym uruchomieniu wideo.',
                tone: 'success',
                resultLabel: 'Co dalej:'
            };
            addLocalEvent('success', 'TAB_CLEARED', 'Wyczyszczono sesję bieżącej karty.');
            renderAll();
            setGlobalFeedback('Sesja tej karty została wyczyszczona.', 'success');
        } catch (error) {
            const message = friendlyError(error);
            actionView = createErrorView('Nie udało się wyczyścić sesji', message);
            addLocalEvent('error', error.code || 'CLEAR_FAILED', message);
            renderAll();
            setGlobalFeedback(message, 'error', true);
        } finally {
            ui.clearButton.disabled = false;
            ui.clearButton.textContent = originalText;
        }
    }

    async function handleSiteAutoChange() {
        if (!currentHostname || siteAutoBusy) return;

        const previousValue = siteAutoEnabled === true;
        const requestedValue = ui.siteAutoToggle.checked;
        siteAutoBusy = true;
        renderSiteAuto();

        try {
            const response = await sendWorkerRequest('SET_SITE_AUTO', {
                hostname: currentHostname,
                enabled: requestedValue
            });
            assertWorkerResponse(response, 'Nie udało się zapisać ustawienia domeny.');
            siteAutoEnabled = readEnabledValue(response, requestedValue);
            actionView = null;
            addLocalEvent('success', 'SITE_AUTO_CHANGED', siteAutoEnabled
                ? 'Włączono auto-otwieranie dla bieżącej domeny.'
                : 'Wyłączono auto-otwieranie dla bieżącej domeny.');
            setGlobalFeedback(siteAutoEnabled
                ? 'Auto-otwieranie jest aktywne dla tej domeny.'
                : 'Auto-otwieranie jest wyłączone dla tej domeny.', 'success');
        } catch (error) {
            siteAutoEnabled = previousValue;
            const message = friendlyError(error);
            addLocalEvent('error', error.code || 'SITE_AUTO_FAILED', message);
            setGlobalFeedback(message, 'error', true);
        } finally {
            siteAutoBusy = false;
            renderSiteAuto();
            renderStatus();
            renderDiagnostics();
        }
    }

    async function handleSourceUrlVisibilityChange() {
        if (!activeTab || sourceUrlVisibilityBusy) return;

        const requestedValue = ui.showFullUrlsToggle.checked;
        sourceUrlVisibilityBusy = true;
        pendingSourceUrlVisibility = requestedValue;
        renderSourcePreferences();
        setGlobalFeedback(requestedValue
            ? 'Włączam pełne adresy dla tej witryny.'
            : 'Ukrywam pełne adresy dla tej witryny.', '');

        try {
            const response = await sendWorkerRequest(
                'SET_SOURCE_URL_VISIBILITY',
                buildSourceUrlVisibilityRequest(activeTab.id, requestedValue)
            );
            applyWorkerStateResponse(response, 'Nie udało się zapisać widoczności adresów dla tej witryny.');
            candidateUrlVisibilityOverrides.clear();
            const savedValue = currentState.sourcePreferences.showFullUrls === true;
            addLocalEvent('success', 'SOURCE_URL_VISIBILITY_CHANGED', savedValue
                ? 'Włączono pełne adresy źródeł dla bieżącej witryny.'
                : 'Ukryto pełne adresy źródeł dla bieżącej witryny.');
            setGlobalFeedback(savedValue
                ? 'Pełne URL są widoczne. Pamiętaj, że mogą zawierać tokeny dostępu.'
                : 'Pełne URL są ponownie ukryte.', 'success');
        } catch (error) {
            const message = friendlyError(error);
            addLocalEvent('error', error.code || 'SOURCE_URL_VISIBILITY_FAILED', message);
            setGlobalFeedback(message, 'error', true);
        } finally {
            sourceUrlVisibilityBusy = false;
            pendingSourceUrlVisibility = null;
            renderAll();
        }
    }

    async function handleQualityOrderMove(quality, direction) {
        if (!activeTab || qualityOrderBusy || !currentHostname) return;
        const currentOrder = normalizeQualityOrder(
            pendingQualityOrder || currentState.sourcePreferences?.qualityOrder
        );
        const currentIndex = currentOrder.indexOf(quality);
        const nextIndex = currentIndex + direction;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) return;

        const requestedOrder = [...currentOrder];
        [requestedOrder[currentIndex], requestedOrder[nextIndex]] = [
            requestedOrder[nextIndex],
            requestedOrder[currentIndex]
        ];
        qualityOrderBusy = true;
        pendingQualityOrder = requestedOrder;
        renderSourcePreferences();
        setGlobalFeedback('Zapisuję kolejność jakości dla tej domeny.', '');

        try {
            const response = await sendWorkerRequest(
                'SET_QUALITY_ORDER',
                buildQualityOrderRequest(activeTab.id, requestedOrder)
            );
            applyWorkerStateResponse(response, 'Nie udało się zapisać kolejności jakości.');
            const savedOrder = normalizeQualityOrder(currentState.sourcePreferences?.qualityOrder);
            addLocalEvent('success', 'QUALITY_ORDER_CHANGED', `Najwyższy priorytet jakości: ${SOURCE_QUALITY_LABELS[savedOrder[0]]}.`);
            setGlobalFeedback(`Najpierw wybieram ${SOURCE_QUALITY_LABELS[savedOrder[0]]}.`, 'success');
        } catch (error) {
            const message = friendlyError(error);
            addLocalEvent('error', error.code || 'QUALITY_ORDER_FAILED', message);
            setGlobalFeedback(message, 'error', true);
        } finally {
            qualityOrderBusy = false;
            pendingQualityOrder = null;
            renderAll();
            focusQualityOrderControl(quality, direction);
        }
    }

    async function handleResolveClick() {
        if (!activeTab || resolverBusy || restrictedContext) return;

        const resolverOrder = resolverOrderCopy(currentState.platform?.id, currentHostname);
        resolverBusy = true;
        actionView = {
            stage: 'Rozpoznawanie',
            title: 'Analizuję załadowaną stronę',
            message: resolverOrder.action,
            reason: 'Nowy wynik zastąpi poprzedni zestaw resolvera dla bieżącego materiału.',
            tone: 'loading'
        };
        addLocalEvent('info', 'RESOLVER_RUNNING', 'Uruchomiono ręczne rozpoznawanie bieżącej strony.');
        renderAll();
        setGlobalFeedback('Rozpoznaję stronę. Może to potrwać kilkanaście sekund.', '');

        try {
            const response = await sendWorkerRequest(
                'RESOLVE_PAGE',
                { tabId: activeTab.id },
                RESOLVE_REQUEST_TIMEOUT_MS
            );
            if (response?.state || response?.tabState) {
                currentState = normalizeState(response.state || response.tabState, currentHostname);
                stateLoaded = true;
                stateLoadError = null;
            }
            assertWorkerResponse(response, 'Resolver nie zwrócił wyniku dla tej strony.');

            const result = response.result && typeof response.result === 'object' ? response.result : {};
            const resultCount = Number.isInteger(result.resultCount) ? result.resultCount : 0;
            const resolverName = resolverMethodLabel(result.resolver);
            if (result.status === 'found') {
                actionView = {
                    stage: 'Gotowe',
                    title: resultCount === 1 ? 'Rozpoznano jedno źródło' : `Rozpoznano ${resultCount} źródeł`,
                    message: `${resolverName} rozpoznał materiał; playlista pokazuje bieżący zestaw resolvera.`,
                    reason: result.truncated === true
                        ? 'Lista została ograniczona do bezpiecznego limitu. Wybierz najlepszy wariant poniżej.'
                        : 'Resolver niczego nie uruchomił automatycznie. Wybierz źródło poniżej.',
                    tone: 'success',
                    resultLabel: 'Rezultat:'
                };
                addLocalEvent('success', 'RESOLVER_FOUND', `Rozpoznano ${resultCount} źródeł przez ${resolverName}.`);
                setGlobalFeedback('Playlista została uzupełniona.', 'success');
            } else if (result.status === 'unavailable') {
                actionView = {
                    stage: 'Brak narzędzi',
                    title: 'Resolvery nie są zainstalowane',
                    message: 'Host działa, ale nie znalazł zgodnego Streamlink ani yt-dlp.',
                    reason: 'Uruchom instalator 3.4.8 z obsługą resolverów, a potem odśwież stan.',
                    tone: 'warning'
                };
                addLocalEvent('warning', 'RESOLVER_UNAVAILABLE', 'Brak zgodnego Streamlink i yt-dlp.');
                setGlobalFeedback('Brakuje narzędzi Streamlink/yt-dlp.', 'error', true);
            } else if (result.status === 'empty') {
                actionView = {
                    stage: 'Brak wyniku',
                    title: 'Nie znaleziono dodatkowego strumienia',
                    message: 'Streamlink i yt-dlp zakończyły analizę bez gotowego adresu.',
                    reason: 'Uruchom materiał na stronie, zaczekaj na jego załadowanie i ponów rozpoznawanie.',
                    tone: 'warning'
                };
                addLocalEvent('warning', 'RESOLVER_EMPTY', 'Resolvery nie znalazły dodatkowego źródła.');
                setGlobalFeedback('Nie znaleziono dodatkowych adresów.', 'error', true);
            } else if (result.status === 'failed') {
                actionView = {
                    stage: 'Błąd resolvera',
                    title: 'Nie udało się rozpoznać strony',
                    message: 'Narzędzia zakończyły analizę bez poprawnej listy strumieni.',
                    reason: resolverAttemptSummary(result.attempted),
                    tone: 'error'
                };
                addLocalEvent('error', 'RESOLVER_FAILED', resolverAttemptSummary(result.attempted));
                setGlobalFeedback('Rozpoznawanie nie powiodło się. Zobacz etapy prób w diagnostyce.', 'error', true);
            } else {
                throw new PopupRequestError('Resolvery nie zwróciły poprawnego wyniku.', 'RESOLVER_FAILED');
            }
        } catch (error) {
            const message = friendlyError(error);
            actionView = createErrorView('Nie udało się rozpoznać strony', message);
            addLocalEvent('error', error.code || 'RESOLVER_FAILED', message);
            setGlobalFeedback(message, 'error', true);
        } finally {
            resolverBusy = false;
            renderAll();
        }
    }

    async function handleResolverCookieChange() {
        if (!activeTab || resolverCookieBusy || !resolverCookieHttpsEligible) return;

        const previousValue = resolverCookieEnabled === true;
        const requestedValue = ui.resolverCookieToggle.checked;
        const previousSiteCount = resolverCookieEnabledSiteCount;
        let permissionAcquiredNow = false;
        resolverCookieBusy = true;
        renderResolverControl();

        try {
            if (requestedValue && !resolverCookiePermissionGranted) {
                const granted = await requestCookiePermission();
                if (!granted) {
                    throw new PopupRequestError(
                        'Chrome nie przyznał opcjonalnego dostępu do cookies. Resolver nadal działa bez sesji strony.',
                        'COOKIE_PERMISSION_DENIED'
                    );
                }
                permissionAcquiredNow = true;
                resolverCookiePermissionGranted = true;
            }

            const response = await sendWorkerRequest('SET_RESOLVER_COOKIE_POLICY', {
                tabId: activeTab.id,
                enabled: requestedValue
            });
            assertWorkerResponse(response, 'Nie udało się zapisać zgody na cookies dla tej domeny.');
            resolverCookieEnabled = readEnabledValue(response, requestedValue);
            resolverCookieHttpsEligible = response.httpsEligible === true;
            resolverCookieEnabledSiteCount = Number.isInteger(response.enabledSiteCount)
                ? response.enabledSiteCount
                : previousSiteCount;

            let permissionRemoved = true;
            if (!resolverCookieEnabled && resolverCookieEnabledSiteCount === 0 && resolverCookiePermissionGranted) {
                permissionRemoved = await removeCookiePermission();
                if (permissionRemoved) resolverCookiePermissionGranted = false;
            }

            addLocalEvent(
                permissionRemoved ? 'success' : 'warning',
                resolverCookieEnabled ? 'RESOLVER_COOKIES_ENABLED' : 'RESOLVER_COOKIES_DISABLED',
                resolverCookieEnabled
                    ? `Resolver może jednorazowo odczytać cookies pasujące do ${currentHostname}.`
                    : permissionRemoved
                        ? `Wyłączono cookies resolvera dla ${currentHostname}.`
                        : 'Wyłączono domenę, ale Chrome nie usunął jeszcze technicznego uprawnienia cookies.'
            );
            setGlobalFeedback(
                resolverCookieEnabled
                    ? 'Sesja strony będzie użyta tylko podczas ręcznego rozpoznawania tej domeny.'
                    : permissionRemoved
                        ? 'Wyłączono dostęp do sesji dla tej domeny.'
                        : 'Domena jest wyłączona; techniczne uprawnienie Chrome pozostało aktywne.',
                permissionRemoved ? 'success' : 'error',
                !permissionRemoved
            );
        } catch (error) {
            resolverCookieEnabled = previousValue;
            resolverCookieEnabledSiteCount = previousSiteCount;
            if (permissionAcquiredNow && previousSiteCount === 0) {
                const removed = await removeCookiePermission().catch(() => false);
                if (removed) resolverCookiePermissionGranted = false;
            }
            const message = friendlyError(error);
            addLocalEvent('error', error.code || 'RESOLVER_COOKIE_FAILED', message);
            setGlobalFeedback(message, 'error', true);
        } finally {
            resolverCookieBusy = false;
            renderResolverControl();
            renderDiagnostics();
        }
    }

    function handleStorageChange(changes, areaName) {
        if (areaName === 'local') {
            if (changes.defaultPlayMode) setPlayMode(changes.defaultPlayMode.newValue);
            if (changes.resolverCookieSites && activeTab) {
                void refreshResolverCookiePolicy().catch(handleResolverCookieError);
            }
            return;
        }
        if (areaName !== 'session' || !activeTab) return;
        const key = `${SESSION_KEY_PREFIX}${activeTab.id}`;
        const change = changes[key];
        if (!change) return;

        if (!change.newValue) resetCandidateViewState();
        currentState = normalizeState(change.newValue, currentHostname);
        stateLoaded = true;
        stateLoadError = null;
        actionView = null;
        renderAll();
    }

    async function refreshState(options = {}) {
        if (!activeTab) return;
        const response = await sendWorkerRequest('GET_TAB_STATE', { tabId: activeTab.id });
        assertWorkerResponse(response, 'Worker nie zwrócił stanu bieżącej karty.');

        currentState = normalizeState(response.state || response.tabState, currentHostname);
        stateLoaded = true;
        stateLoadError = null;
        if (!options.preserveAction) actionView = null;
        renderAll();
    }

    function applyWorkerStateResponse(response, fallbackMessage) {
        assertWorkerResponse(response, fallbackMessage);
        const returnedState = response?.state || response?.tabState;
        if (!returnedState || typeof returnedState !== 'object') {
            throw new PopupRequestError('Worker nie zwrócił odświeżonego stanu karty.', 'STATE_MISSING');
        }
        currentState = normalizeState(returnedState, currentHostname);
        stateLoaded = true;
        stateLoadError = null;
        actionView = null;
    }

    async function refreshHealth() {
        setHealthChecking();
        const response = await sendWorkerRequest('HEALTH');
        assertWorkerResponse(response, 'Nie udało się sprawdzić hosta lokalnego.');
        healthState = {
            ...normalizeHealth(response),
            probeSucceeded: true,
            checkedAt: Date.now()
        };
        renderHealth();
        renderHostNotice();
        renderResolverControl();
        renderStatus();
    }

    async function refreshSiteAuto() {
        if (!currentHostname) return;
        const response = await sendWorkerRequest('GET_SITE_AUTO', { hostname: currentHostname });
        assertWorkerResponse(response, 'Nie udało się odczytać ustawienia domeny.');
        siteAutoEnabled = readEnabledValue(response, false);
        renderSiteAuto();
        renderStatus();
    }

    async function refreshResolverCookiePolicy() {
        if (!activeTab || !currentHostname) return;
        const [response, permissionGranted] = await Promise.all([
            sendWorkerRequest('GET_RESOLVER_COOKIE_POLICY', { tabId: activeTab.id }),
            containsCookiePermission()
        ]);
        assertWorkerResponse(response, 'Nie udało się odczytać zgody na cookies dla tej domeny.');
        resolverCookieEnabled = readEnabledValue(response, false);
        resolverCookieHttpsEligible = response.httpsEligible === true;
        resolverCookieEnabledSiteCount = Number.isInteger(response.enabledSiteCount)
            ? response.enabledSiteCount
            : 0;
        resolverCookiePermissionGranted = permissionGranted === true;
        renderResolverControl();
    }

    async function refreshDefaultPlayMode() {
        const settings = await getLocalSettings({ defaultPlayMode: 'new' });
        setPlayMode(settings.defaultPlayMode);
    }

    async function persistDefaultPlayMode(mode) {
        if (!VALID_PLAY_MODES.has(mode)) return;
        try {
            await setLocalSettings({ defaultPlayMode: mode });
        } catch (error) {
            handlePlayModeStorageError(error, 'Nie zapisano domyślnego trybu otwarcia.');
        }
    }

    function handlePlayModeStorageError(error, fallbackMessage) {
        const message = friendlyError(error) || fallbackMessage;
        addLocalEvent('error', error.code || 'PLAY_MODE_STORAGE_FAILED', message);
        renderDiagnostics();
        setGlobalFeedback(`${fallbackMessage} ${message}`, 'error', true);
    }

    function handleStateError(error) {
        stateLoaded = true;
        stateLoadError = error;
        currentState = createEmptyState(currentHostname);
        candidateUrlVisibilityOverrides.clear();
        resetCandidateViewState();
        actionView = createErrorView('Worker rozszerzenia nie odpowiada', friendlyError(error));
        addLocalEvent('error', error.code || 'STATE_FAILED', friendlyError(error));
        renderAll();
    }

    function handleHealthError(error) {
        const missingHost = isHostError(error);
        const missingMpv = isMpvMissingError(error);
        healthState = {
            hostAvailable: missingHost ? false : (missingMpv ? true : null),
            mpvAvailable: missingMpv ? false : null,
            mpvRunning: null,
            message: friendlyError(error),
            capabilities: [],
            resolvers: createEmptyResolverHealth(),
            probeSucceeded: false,
            checkedAt: Date.now()
        };
        addLocalEvent('error', error.code || 'HEALTH_FAILED', friendlyError(error));
        renderHealth();
        renderHostNotice();
        renderResolverControl();
        renderStatus();
    }

    function handleSiteAutoError(error) {
        siteAutoEnabled = null;
        addLocalEvent('error', error.code || 'SITE_AUTO_READ_FAILED', friendlyError(error));
        renderSiteAuto(error);
        renderStatus();
        renderDiagnostics();
    }

    function handleResolverCookieError(error) {
        resolverCookieEnabled = null;
        addLocalEvent('error', error.code || 'RESOLVER_COOKIE_READ_FAILED', friendlyError(error));
        renderResolverControl(error);
        renderDiagnostics();
    }

    function renderAll() {
        // Capture before any section can change the layout or replace focus.
        const viewScopeKey = beginCandidateRender();
        try {
            renderSiteContext();
            renderSiteAuto();
            renderHealth();
            renderHostNotice();
            renderResolverControl();
            renderStatus();
            renderSourcePreferences();
            renderCandidates();
            renderDiagnostics();
        } finally {
            finishCandidateRender(viewScopeKey);
        }
    }

    function renderSiteContext() {
        ui.siteHostname.textContent = currentHostname || (activeTab ? 'Strona systemowa lub lokalna' : 'Ustalam domenę…');
        ui.permissionNotice.hidden = !restrictedContext;
        if (restrictedContext) ui.permissionMessage.textContent = restrictedContext;
    }

    function renderSourcePreferences() {
        const storedValue = currentState.sourcePreferences?.showFullUrls === true;
        const visibleValue = typeof pendingSourceUrlVisibility === 'boolean'
            ? pendingSourceUrlVisibility
            : storedValue;
        ui.showFullUrlsToggle.checked = visibleValue;
        ui.showFullUrlsToggle.disabled = sourceUrlVisibilityBusy ||
            !activeTab ||
            !currentHostname ||
            !stateLoaded ||
            !currentState.candidates.some(isReadyCandidate);
        ui.sourcePreferences.setAttribute('aria-busy', sourceUrlVisibilityBusy ? 'true' : 'false');
        renderQualityOrder();
    }

    function renderQualityOrder() {
        if (!ui.qualityOrderPanel || !ui.qualityOrderList) return;
        const order = normalizeQualityOrder(
            pendingQualityOrder || currentState.sourcePreferences?.qualityOrder
        );
        const focusedControl = captureFocusedQualityControl();
        const controlsEnabled = Boolean(
            activeTab && currentHostname && stateLoaded && !stateLoadError && !restrictedContext && !qualityOrderBusy
        );
        ui.qualityOrderPanel.hidden = !activeTab || Boolean(restrictedContext);
        ui.qualityOrderPanel.setAttribute('aria-busy', qualityOrderBusy ? 'true' : 'false');
        ui.qualityOrderSummary.textContent = `Najpierw ${SOURCE_QUALITY_LABELS[order[0]]}`;
        ui.qualityOrderFeedback.textContent = qualityOrderBusy
            ? 'Zapisuję kolejność…'
            : '';
        ui.qualityOrderFeedback.dataset.tone = '';

        const fragment = document.createDocumentFragment();
        order.forEach((quality, index) => {
            fragment.appendChild(createQualityOrderItem(quality, index, order.length, controlsEnabled));
        });
        fragment.appendChild(createFixedQualityOrderItem('Niższe jakości', 'Pozostałe rozdzielczości'));
        fragment.appendChild(createFixedQualityOrderItem('Nieznana jakość', 'Gdy strona nie podaje rozdzielczości'));
        ui.qualityOrderList.replaceChildren(fragment);
        restoreFocusedQualityControl(focusedControl);
    }

    function createQualityOrderItem(quality, index, count, controlsEnabled) {
        const item = document.createElement('li');
        item.className = 'quality-order-item';
        item.dataset.qualityValue = quality;

        const rank = createTextElement('span', 'quality-order-rank', String(index + 1));
        rank.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span');
        copy.className = 'quality-order-copy';
        copy.appendChild(createTextElement('strong', '', SOURCE_QUALITY_LABELS[quality]));
        copy.appendChild(createTextElement('small', '', index === 0 ? 'Najwyższy priorytet' : `Pozycja ${index + 1}`));

        const actions = document.createElement('span');
        actions.className = 'quality-order-actions';
        const upButton = createQualityMoveButton(quality, -1, index === 0, controlsEnabled);
        const downButton = createQualityMoveButton(quality, 1, index === count - 1, controlsEnabled);
        actions.append(upButton, downButton);
        item.append(rank, copy, actions);
        return item;
    }

    function createQualityMoveButton(quality, direction, atBoundary, controlsEnabled) {
        const movingUp = direction < 0;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quality-order-button';
        button.textContent = movingUp ? '↑' : '↓';
        button.dataset.qualityValue = quality;
        button.dataset.viewAction = movingUp ? 'quality-up' : 'quality-down';
        button.setAttribute(
            'aria-label',
            `${movingUp ? 'Przenieś wyżej' : 'Przenieś niżej'}: ${SOURCE_QUALITY_LABELS[quality]}`
        );
        button.title = movingUp ? 'Przenieś wyżej' : 'Przenieś niżej';
        button.disabled = !controlsEnabled || atBoundary;
        button.addEventListener('click', () => {
            void handleQualityOrderMove(quality, direction);
        });
        return button;
    }

    function createFixedQualityOrderItem(label, description) {
        const item = document.createElement('li');
        item.className = 'quality-order-item is-fixed';
        const rank = createTextElement('span', 'quality-order-rank', '•');
        rank.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span');
        copy.className = 'quality-order-copy';
        copy.appendChild(createTextElement('strong', '', label));
        copy.appendChild(createTextElement('small', '', description));
        item.append(rank, copy, createTextElement('span', 'quality-order-fixed', 'Zawsze na końcu'));
        return item;
    }

    function captureFocusedQualityControl() {
        const activeElement = document.activeElement;
        if (!activeElement || !ui.qualityOrderList.contains(activeElement)) return null;
        return {
            quality: activeElement.dataset?.qualityValue || '',
            action: activeElement.dataset?.viewAction || ''
        };
    }

    function restoreFocusedQualityControl(focusedControl) {
        if (!focusedControl?.quality || !focusedControl.action) return;
        const target = [...ui.qualityOrderList.querySelectorAll('[data-view-action]')].find((control) =>
            control.dataset.qualityValue === focusedControl.quality &&
            control.dataset.viewAction === focusedControl.action
        );
        target?.focus({ preventScroll: true });
    }

    function focusQualityOrderControl(quality, direction) {
        if (ui.qualityOrderPanel) ui.qualityOrderPanel.open = true;
        const preferredAction = direction < 0 ? 'quality-up' : 'quality-down';
        const controls = [...ui.qualityOrderList.querySelectorAll('[data-view-action]')].filter((control) =>
            control.dataset.qualityValue === quality
        );
        const target = controls.find((control) => control.dataset.viewAction === preferredAction && !control.disabled) ||
            controls.find((control) => !control.disabled) || controls[0];
        target?.focus();
    }

    function renderSiteAuto(readError = null) {
        if (!activeTab) {
            ui.siteAutoToggle.checked = false;
            ui.siteAutoToggle.disabled = true;
            ui.siteAutoNote.textContent = 'Ustalam bieżącą kartę.';
            ui.siteAutoNote.dataset.tone = '';
            return;
        }

        if (!currentHostname) {
            ui.siteAutoToggle.checked = false;
            ui.siteAutoToggle.disabled = true;
            ui.siteAutoNote.textContent = 'Niedostępne na stronach systemowych i lokalnych bez uprawnienia.';
            ui.siteAutoNote.dataset.tone = 'error';
            return;
        }

        ui.siteAutoToggle.checked = siteAutoEnabled === true;
        ui.siteAutoToggle.disabled = siteAutoBusy || siteAutoEnabled === null;

        if (siteAutoBusy) {
            ui.siteAutoNote.textContent = 'Zapisuję ustawienie tylko dla tej domeny…';
            ui.siteAutoNote.dataset.tone = '';
        } else if (readError || siteAutoEnabled === null) {
            ui.siteAutoNote.textContent = readError
                ? `Nie odczytano ustawienia: ${friendlyError(readError)}`
                : 'Nie udało się odczytać ustawienia domeny.';
            ui.siteAutoNote.dataset.tone = 'error';
        } else if (siteAutoEnabled) {
            ui.siteAutoNote.textContent = 'Pierwszy bezpieczny polecany strumień może otworzyć się automatycznie.';
            ui.siteAutoNote.dataset.tone = 'success';
        } else {
            ui.siteAutoNote.textContent = 'Wykrywanie działa, ale uruchomienie wymaga kliknięcia.';
            ui.siteAutoNote.dataset.tone = '';
        }
    }

    function renderResolverControl(readError = null) {
        const resolverState = currentState.resolver || createEmptyResolverState();
        const scheduledResolve = resolverState.state === 'scheduled';
        const storedResolveIsFresh = resolverState.state === 'resolving' &&
            Number.isFinite(resolverState.updatedAt) &&
            resolverState.updatedAt > 0 &&
            Date.now() - resolverState.updatedAt <= RESOLVER_STALE_MS;
        const staleResolve = resolverState.state === 'resolving' && !storedResolveIsFresh;
        const running = resolverBusy || scheduledResolve || storedResolveIsFresh;
        const resolverHealth = healthState.resolvers || createEmptyResolverHealth();
        const streamlinkReady = resolverHealth.streamlink.available === true &&
            resolverHealth.streamlink.compatible !== false;
        const ytDlpReady = resolverHealth.ytDlp.available === true &&
            resolverHealth.ytDlp.compatible !== false;
        const readyNames = [streamlinkReady ? 'Streamlink' : '', ytDlpReady ? 'yt-dlp' : ''].filter(Boolean);
        const outdatedNames = [
            resolverHealth.streamlink.installed === true && resolverHealth.streamlink.compatible === false ? 'Streamlink' : '',
            resolverHealth.ytDlp.installed === true && resolverHealth.ytDlp.compatible === false ? 'yt-dlp' : ''
        ].filter(Boolean);
        const supportsResolve = healthState.capabilities.includes('resolve');

        if (!activeTab) {
            ui.resolverHealth.dataset.state = 'checking';
            ui.resolverHealth.textContent = 'Sprawdzam…';
        } else if (healthState.hostAvailable === false) {
            ui.resolverHealth.dataset.state = 'error';
            ui.resolverHealth.textContent = 'Brak hosta';
        } else if (healthState.hostAvailable === null) {
            ui.resolverHealth.dataset.state = 'checking';
            ui.resolverHealth.textContent = 'Nie sprawdzono';
        } else if (!supportsResolve) {
            ui.resolverHealth.dataset.state = 'error';
            ui.resolverHealth.textContent = 'Zaktualizuj host';
        } else if (readyNames.length === 0 && outdatedNames.length > 0) {
            ui.resolverHealth.dataset.state = 'warning';
            ui.resolverHealth.textContent = 'Wymaga aktualizacji';
        } else if (readyNames.length === 0) {
            ui.resolverHealth.dataset.state = 'warning';
            ui.resolverHealth.textContent = 'Brak narzędzi';
        } else {
            ui.resolverHealth.dataset.state = 'ok';
            ui.resolverHealth.textContent = readyNames.length === 2 ? '2 resolvery gotowe' : `${readyNames[0]} gotowy`;
        }

        if (running) {
            ui.resolverNote.textContent = resolverState.source === 'page_ready' && !resolverBusy
                ? 'Przygotowuję źródła bieżącego materiału YouTube. Analiza nie uruchomi MPV i nie użyje cookies.'
                : resolverState.source === 'refresh'
                    ? 'Odświeżam wygasające źródła w tle. Analiza nie uruchomi MPV i nie użyje cookies.'
                    : resolverOrderCopy(currentState.platform?.id, currentHostname).running;
        } else if (staleResolve) {
            ui.resolverNote.textContent = 'Poprzednia analiza została przerwana przed zapisaniem wyniku. Możesz bezpiecznie uruchomić ją ponownie.';
        } else if (resolverState.state === 'found') {
            const count = resolverState.resultCount || 0;
            const method = resolverMethodLabel(resolverState.resolver);
            ui.resolverNote.textContent = `${method} rozpoznał ${candidateCountLabel(count)} dla bieżącego materiału. Możesz rozpoznać go ponownie.`;
        } else if (resolverState.state === 'empty') {
            ui.resolverNote.textContent = 'Ostatnia analiza nie znalazła dodatkowych adresów. Najpierw uruchom materiał na stronie.';
        } else if (resolverState.state === 'failed') {
            ui.resolverNote.textContent = `Ostatnia analiza nie powiodła się. ${resolverAttemptSummary(resolverState.attempted)}.`;
        } else {
            const platform = resolverPlatformLabel(currentState.platform, currentHostname);
            const resolverOrder = resolverOrderCopy(currentState.platform?.id, currentHostname);
            ui.resolverNote.textContent = `Tryb dla: ${platform}. Kolejność: ${resolverOrder.label}. Wyniki dołączą do playlisty.`;
        }

        ui.resolvePageButton.disabled = Boolean(
            !activeTab || restrictedContext || running || healthState.hostAvailable === false ||
            resolverCookieBusy || (healthState.hostAvailable === true && !supportsResolve)
        );
        const youtubeMaterial = resolverPlatformId(currentState.platform?.id, currentHostname) === 'youtube' &&
            ['watch', 'shorts', 'live'].includes(currentState.materialScope?.kind);
        ui.resolvePageButton.textContent = running
            ? resolverState.source === 'page_ready' && !resolverBusy
                ? 'Przygotowuję źródła…'
                : resolverState.source === 'refresh'
                    ? 'Odświeżam źródła…'
                    : 'Rozpoznaję stronę…'
            : youtubeMaterial && resolverState.pageReadyState === 'done'
                ? 'Rozpoznaj ponownie'
                : youtubeMaterial
                    ? 'Rozpoznaj teraz'
                    : 'Rozpoznaj stronę';
        ui.resolvePageButton.setAttribute('aria-busy', running ? 'true' : 'false');

        ui.resolverCookieHost.textContent = currentHostname || 'Brak zwykłej domeny';
        ui.resolverCookieToggle.checked = resolverCookieEnabled === true;
        ui.resolverCookieToggle.disabled = Boolean(
            !activeTab || !currentHostname || restrictedContext || !resolverCookieHttpsEligible ||
            resolverCookieBusy || running || resolverCookieEnabled === null
        );

        if (!activeTab) {
            ui.resolverCookieNote.textContent = 'Ustalam bieżącą kartę.';
            ui.resolverCookieNote.dataset.tone = '';
        } else if (!resolverCookieHttpsEligible) {
            ui.resolverCookieNote.textContent = 'Sesja strony jest dostępna wyłącznie dla bezpiecznych stron HTTPS.';
            ui.resolverCookieNote.dataset.tone = 'error';
        } else if (resolverCookieBusy) {
            ui.resolverCookieNote.textContent = 'Aktualizuję zgodę dla tej domeny…';
            ui.resolverCookieNote.dataset.tone = '';
        } else if (readError || resolverCookieEnabled === null) {
            ui.resolverCookieNote.textContent = readError
                ? `Nie odczytano zgody: ${friendlyError(readError)}`
                : 'Nie udało się odczytać zgody dla tej domeny.';
            ui.resolverCookieNote.dataset.tone = 'error';
        } else if (resolverCookieEnabled && resolverCookiePermissionGranted) {
            ui.resolverCookieNote.textContent = `Przy ręcznym rozpoznawaniu odczytam najwyżej 64 cookies pasujące do ${currentHostname}; nie zapisuję ich.`;
            ui.resolverCookieNote.dataset.tone = 'success';
        } else if (resolverCookieEnabled) {
            ui.resolverCookieNote.textContent = 'Domena jest włączona, ale brakuje zgody Chrome. Wyłącz i włącz przełącznik ponownie.';
            ui.resolverCookieNote.dataset.tone = 'error';
        } else {
            ui.resolverCookieNote.textContent = `Zgoda Chrome jest technicznie globalna; kod użyje jej tylko dla cookies pasujących do ${currentHostname} i usunie po wyłączeniu ostatniej domeny.`;
            ui.resolverCookieNote.dataset.tone = '';
        }
    }

    function setHealthChecking() {
        ui.hostHealth.dataset.state = 'checking';
        ui.hostHealthText.textContent = 'Sprawdzam…';
        ui.mpvHealth.dataset.state = 'checking';
        ui.mpvHealthText.textContent = 'Sprawdzam…';
        ui.resolverHealth.dataset.state = 'checking';
        ui.resolverHealth.textContent = 'Sprawdzam…';
    }

    function renderHealth() {
        if (healthState.hostAvailable === true) {
            ui.hostHealth.dataset.state = 'ok';
            ui.hostHealthText.textContent = 'Gotowy';
        } else if (healthState.hostAvailable === false) {
            ui.hostHealth.dataset.state = 'error';
            ui.hostHealthText.textContent = 'Niedostępny';
        } else {
            ui.hostHealth.dataset.state = activeTab ? 'idle' : 'checking';
            ui.hostHealthText.textContent = activeTab ? 'Nie sprawdzono' : 'Sprawdzam…';
        }

        if (healthState.mpvAvailable === false) {
            ui.mpvHealth.dataset.state = 'error';
            ui.mpvHealthText.textContent = 'Nie znaleziono';
        } else if (healthState.mpvRunning === true) {
            ui.mpvHealth.dataset.state = 'ok';
            ui.mpvHealthText.textContent = 'Uruchomiony';
        } else if (healthState.mpvAvailable === true && healthState.hostAvailable === true) {
            ui.mpvHealth.dataset.state = 'idle';
            ui.mpvHealthText.textContent = 'Gotowy / nieaktywny';
        } else if (healthState.mpvRunning === false && healthState.hostAvailable === true) {
            ui.mpvHealth.dataset.state = 'idle';
            ui.mpvHealthText.textContent = 'Nieaktywny';
        } else if (healthState.hostAvailable === false) {
            ui.mpvHealth.dataset.state = 'error';
            ui.mpvHealthText.textContent = 'Brak połączenia';
        } else {
            ui.mpvHealth.dataset.state = activeTab ? 'idle' : 'checking';
            ui.mpvHealthText.textContent = activeTab ? 'Nieznany' : 'Sprawdzam…';
        }
    }

    function renderHostNotice() {
        const hostMissing = healthState.hostAvailable === false;
        const mpvMissing = healthState.mpvAvailable === false;
        ui.hostNotice.hidden = !hostMissing && !mpvMissing;
        if (hostMissing) {
            ui.hostNoticeTitle.textContent = 'Host lokalny nie odpowiada';
            ui.hostNoticeMessage.textContent = healthState.message
                ? safeDiagnosticText(healthState.message)
                : 'Sprawdź instalację hosta Native Messaging, a następnie odśwież stan.';
        } else if (mpvMissing) {
            ui.hostNoticeTitle.textContent = 'Nie znaleziono programu MPV';
            ui.hostNoticeMessage.textContent = healthState.message
                ? safeDiagnosticText(healthState.message)
                : 'Zainstaluj MPV lub popraw środowisko PATH widoczne dla hosta lokalnego.';
        }
    }

    function renderStatus() {
        const view = deriveStatusView();
        ui.progressCard.dataset.tone = view.tone;
        ui.stageIcon.textContent = iconForTone(view.tone);
        ui.stageLabel.textContent = view.stage;
        ui.statusTitle.textContent = view.title;
        ui.statusMessage.textContent = view.message;
        ui.reasonLabel.textContent = view.resultLabel || 'Dlaczego nie otwarto:';
        ui.statusReason.textContent = view.reason;
    }

    function deriveStatusView() {
        if (actionView) return sanitizeStatusView(actionView);

        if (!activeTab) {
            return {
                stage: 'Uruchamianie',
                title: 'Sprawdzam bieżącą kartę',
                message: 'Pobieram kontekst aktywnej strony.',
                reason: 'Analiza jeszcze trwa.',
                tone: 'loading'
            };
        }

        if (restrictedContext) {
            return {
                stage: 'Brak dostępu',
                title: 'Chrome chroni tę stronę',
                message: restrictedContext,
                reason: 'Rozszerzenia nie mogą monitorować ruchu na tej karcie.',
                tone: 'permission'
            };
        }

        if (stateLoadError) {
            return createErrorView('Worker rozszerzenia nie odpowiada', friendlyError(stateLoadError));
        }

        if (!stateLoaded) {
            return {
                stage: 'Wczytywanie',
                title: 'Pobieram stan wykrywania',
                message: 'Łączę się z workerem rozszerzenia.',
                reason: 'Nie ma jeszcze wyniku analizy.',
                tone: 'loading'
            };
        }

        const status = currentState.status;
        const code = normalizeStatusCode(status);
        const preset = STATUS_COPY[code] || inferStatusPreset(code);
        const candidateCount = currentState.candidates.filter(isReadyCandidate).length;
        const statusMessage = firstSafeText(status.message, status.detail, status.description);
        const explicitReason = firstSafeText(
            status.reason,
            status.why,
            status.whyNotOpened,
            status.notOpenedReason,
            status.blocker,
            status.lastError
        );

        const view = createRecoveredNativeHostView(status, healthState, candidateCount) || {
            stage: firstSafeText(status.stageLabel, preset.stage) || 'Nasłuchiwanie',
            title: firstSafeText(status.title, preset.title) || 'Obserwuję bieżącą kartę',
            message: statusMessage || defaultStatusMessage(code, candidateCount),
            reason: explicitReason || deriveReason(code, candidateCount),
            tone: preset.tone || 'loading'
        };

        if ((healthState.hostAvailable === false || healthState.mpvAvailable === false) && !isSuccessCode(code)) {
            view.stage = 'Brak połączenia';
            view.title = healthState.mpvAvailable === false
                ? 'Nie znaleziono programu MPV'
                : 'Host lokalny nie odpowiada';
            view.message = 'Wykrywanie może działać, ale Chrome nie może przekazać źródła do MPV.';
            view.reason = healthState.message || (healthState.mpvAvailable === false
                ? 'Program MPV jest niedostępny w środowisku hosta.'
                : 'Host Native Messaging jest niedostępny.');
            view.tone = 'host';
        }

        if (isSuccessCode(code)) view.resultLabel = 'Rezultat:';
        return sanitizeStatusView(view);
    }

    function createCandidateViewScope(state = currentState) {
        const scope = {
            hostname: safeHostname(state?.hostname) || currentHostname,
            navigationEpoch: Number.isInteger(state?.navigationEpoch) && state.navigationEpoch >= 0
                ? state.navigationEpoch
                : 0,
            materialScopeId: normalizeViewIdentity(state?.materialScope?.id),
            pageIdentity: normalizeViewIdentity(state?.pageIdentity)
        };
        return {
            ...scope,
            key: JSON.stringify([
                scope.hostname,
                scope.navigationEpoch,
                scope.materialScopeId,
                scope.pageIdentity
            ])
        };
    }

    function createEmptyCandidateViewState(scopeKey) {
        return {
            scopeKey,
            otherCandidatesOpen: false,
            actionsMenuCandidateIds: [],
            focus: null,
            appScrollTop: 0,
            candidateScrollTop: 0,
            anchor: null
        };
    }

    function beginCandidateRender() {
        const nextScopeKey = createCandidateViewScope().key;
        if (!activeTab || !stateLoaded) {
            renderedCandidateScopeKey = '';
            candidateViewState = createEmptyCandidateViewState(nextScopeKey);
            return '';
        }
        if (renderedCandidateScopeKey && renderedCandidateScopeKey === nextScopeKey) {
            captureCandidateViewState(nextScopeKey);
        } else {
            if (renderedCandidateScopeKey && renderedCandidateScopeKey !== nextScopeKey) {
                candidateUrlVisibilityOverrides.clear();
                clearPersistedCandidateViewState();
            }
            candidateViewState = readPersistedCandidateViewState(nextScopeKey) ||
                createEmptyCandidateViewState(nextScopeKey);
        }
        renderedCandidateScopeKey = nextScopeKey;
        return nextScopeKey;
    }

    function finishCandidateRender(scopeKey) {
        if (!scopeKey || renderedCandidateScopeKey !== scopeKey || candidateViewState?.scopeKey !== scopeKey) return;
        restoreCandidateViewState(candidateViewState);
    }

    function handleCandidateViewInteraction() {
        captureCandidateViewState(renderedCandidateScopeKey);
    }

    function captureCandidateViewState(scopeKey) {
        if (!scopeKey || renderedCandidateScopeKey !== scopeKey || !ui.candidateContent) return;
        const cards = [...ui.candidateContent.querySelectorAll('.candidate-card')];
        const previous = candidateViewState?.scopeKey === scopeKey
            ? candidateViewState
            : createEmptyCandidateViewState(scopeKey);
        const next = {
            ...previous,
            scopeKey,
            appScrollTop: finiteScrollValue(ui.scrollRoot?.scrollTop),
            candidateScrollTop: finiteScrollValue(ui.candidateContent.scrollTop)
        };

        if (cards.length > 0) {
            const otherCandidates = ui.candidateContent.querySelector('.other-candidates');
            next.otherCandidatesOpen = otherCandidates?.open === true;
            next.actionsMenuCandidateIds = [...ui.candidateContent.querySelectorAll('.actions-menu')]
                .filter((details) => details.open === true && details.dataset.candidateId)
                .map((details) => details.dataset.candidateId)
                .slice(0, 24);
            next.anchor = captureCandidateScrollAnchor(cards);

            const activeElement = document.activeElement;
            if (activeElement && ui.candidateContent.contains(activeElement)) {
                const card = activeElement.closest?.('.candidate-card');
                const candidateId = activeElement.dataset?.candidateId || card?.dataset?.candidateId || '';
                const action = activeElement.dataset?.viewAction || '';
                next.focus = candidateId && action ? { candidateId, action } : null;
            } else {
                next.focus = null;
            }
        }

        candidateViewState = next;
        scheduleCandidateViewStatePersist();
    }

    function captureCandidateScrollAnchor(cards) {
        if (!ui.scrollRoot) return null;
        const viewportHeight = window.innerHeight;
        let nearest = null;
        cards.forEach((card) => {
            if (!card.dataset.candidateId || typeof card.getBoundingClientRect !== 'function') return;
            if (card.closest('.other-candidates')?.open === false) return;
            const rect = card.getBoundingClientRect();
            // Chromium can retain nonzero geometry inside closed details.
            // Only a card visible in this viewport may anchor the reader.
            if (rect.height <= 0 || rect.bottom <= 0 || rect.top >= viewportHeight) return;
            const distance = Math.abs(rect.top);
            if (!nearest || distance < nearest.distance) {
                nearest = {
                    candidateId: card.dataset.candidateId,
                    offsetTop: rect.top,
                    distance
                };
            }
        });
        return nearest
            ? {
                candidateId: nearest.candidateId,
                offsetTop: nearest.offsetTop,
                candidateOrder: cards.map((card) => card.dataset.candidateId).filter(Boolean)
            }
            : null;
    }

    function restoreCandidateViewState(viewState) {
        if (!viewState || viewState.scopeKey !== renderedCandidateScopeKey) return;
        const otherCandidates = ui.candidateContent.querySelector('.other-candidates');
        if (otherCandidates) otherCandidates.open = viewState.otherCandidatesOpen === true;

        const openMenus = new Set(viewState.actionsMenuCandidateIds || []);
        [...ui.candidateContent.querySelectorAll('.actions-menu')].forEach((details) => {
            details.open = openMenus.has(details.dataset.candidateId);
        });

        const focus = viewState.focus;
        if (focus?.candidateId && focus.action) {
            const focusTarget = [...ui.candidateContent.querySelectorAll('[data-view-action]')].find((element) =>
                element.dataset.candidateId === focus.candidateId &&
                element.dataset.viewAction === focus.action
            ) || null;
            const containingOtherCandidates = focusTarget?.closest?.('.other-candidates');
            const containingActionsMenu = focusTarget?.closest?.('.actions-menu');
            if (containingOtherCandidates) containingOtherCandidates.open = true;
            if (containingActionsMenu) containingActionsMenu.open = true;
            focusTarget?.focus({ preventScroll: true });
        }

        // Restore in this render, before new wheel/scroll/focus input can arrive.
        // A deferred frame would overwrite that input with this old snapshot.
        if (ui.scrollRoot) ui.scrollRoot.scrollTop = finiteScrollValue(viewState.appScrollTop);
        ui.candidateContent.scrollTop = finiteScrollValue(viewState.candidateScrollTop);
        restoreCandidateScrollAnchor(viewState.anchor);
    }

    function restoreCandidateScrollAnchor(anchor) {
        if (!anchor?.candidateId || !ui.scrollRoot) return;
        const cards = [...ui.candidateContent.querySelectorAll('.candidate-card')];
        const currentOrder = cards.map((card) => card.dataset.candidateId).filter(Boolean);
        if (!Array.isArray(anchor.candidateOrder) || !anchor.candidateOrder.includes(anchor.candidateId)) return;
        const previousIds = new Set(anchor.candidateOrder);
        const currentIds = new Set(currentOrder);
        const survivingPrevious = anchor.candidateOrder.filter((id) => currentIds.has(id));
        const survivingCurrent = currentOrder.filter((id) => previousIds.has(id));
        // Compensate for inserted/removed cards, but never follow a card that
        // the live ranking moved to the top while the reader was scrolling.
        if (survivingPrevious.some((id, index) => id !== survivingCurrent[index])) return;
        const card = cards.find((candidateCard) => candidateCard.dataset.candidateId === anchor.candidateId);
        if (!card || typeof card.getBoundingClientRect !== 'function') return;
        if (card.closest('.other-candidates')?.open === false) return;
        const rect = card.getBoundingClientRect();
        if (rect.height <= 0) return;
        const offsetNow = rect.top;
        if (!Number.isFinite(offsetNow) || !Number.isFinite(anchor.offsetTop)) return;
        ui.scrollRoot.scrollTop += offsetNow - anchor.offsetTop;
    }

    function finiteScrollValue(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric >= 0 ? Math.min(numeric, 1_000_000) : 0;
    }

    function candidateViewStorage() {
        try {
            return window.sessionStorage || null;
        } catch (error) {
            return null;
        }
    }

    function candidateViewStorageKey() {
        return activeTab && Number.isInteger(activeTab.id)
            ? `${POPUP_VIEW_STATE_KEY_PREFIX}${activeTab.id}`
            : '';
    }

    function readPersistedCandidateViewState(scopeKey) {
        const storage = candidateViewStorage();
        const storageKey = candidateViewStorageKey();
        if (!storage || !storageKey) return null;
        try {
            const parsed = JSON.parse(storage.getItem(storageKey) || 'null');
            if (!parsed || parsed.scopeKey !== scopeKey) return null;
            const actionIds = Array.isArray(parsed.actionsMenuCandidateIds)
                ? parsed.actionsMenuCandidateIds
                    .filter((value) => typeof value === 'string' && value.length <= 220)
                    .slice(0, 24)
                : [];
            const focus = parsed.focus &&
                typeof parsed.focus.candidateId === 'string' && parsed.focus.candidateId.length <= 220 &&
                typeof parsed.focus.action === 'string' && parsed.focus.action.length <= 48
                ? { candidateId: parsed.focus.candidateId, action: parsed.focus.action }
                : null;
            const anchor = parsed.anchor &&
                typeof parsed.anchor.candidateId === 'string' && parsed.anchor.candidateId.length <= 220 &&
                Number.isFinite(parsed.anchor.offsetTop)
                ? {
                    candidateId: parsed.anchor.candidateId,
                    offsetTop: parsed.anchor.offsetTop,
                    candidateOrder: Array.isArray(parsed.anchor.candidateOrder)
                        ? parsed.anchor.candidateOrder
                            .filter((id) => typeof id === 'string' && id.length <= 220)
                            .slice(0, 80)
                        : []
                }
                : null;
            return {
                scopeKey,
                otherCandidatesOpen: parsed.otherCandidatesOpen === true,
                actionsMenuCandidateIds: actionIds,
                focus,
                appScrollTop: finiteScrollValue(parsed.appScrollTop),
                candidateScrollTop: finiteScrollValue(parsed.candidateScrollTop),
                anchor
            };
        } catch (error) {
            return null;
        }
    }

    function scheduleCandidateViewStatePersist() {
        if (!candidateViewStorage() || !candidateViewStorageKey()) return;
        if (viewStatePersistTimer) clearTimeout(viewStatePersistTimer);
        viewStatePersistTimer = setTimeout(() => {
            viewStatePersistTimer = null;
            persistCandidateViewStateNow();
        }, POPUP_VIEW_STATE_WRITE_DEBOUNCE_MS);
    }

    function persistCandidateViewStateNow() {
        if (viewStatePersistTimer) {
            clearTimeout(viewStatePersistTimer);
            viewStatePersistTimer = null;
        }
        const storage = candidateViewStorage();
        const storageKey = candidateViewStorageKey();
        if (!storage || !storageKey || !candidateViewState?.scopeKey) return;
        try {
            storage.setItem(storageKey, JSON.stringify(candidateViewState));
        } catch (error) {
            // sessionStorage can be unavailable under restrictive extension policies.
        }
    }

    function clearPersistedCandidateViewState() {
        if (viewStatePersistTimer) {
            clearTimeout(viewStatePersistTimer);
            viewStatePersistTimer = null;
        }
        const storage = candidateViewStorage();
        const storageKey = candidateViewStorageKey();
        if (!storage || !storageKey) return;
        try {
            storage.removeItem(storageKey);
        } catch (error) {
            // Best-effort UI state only.
        }
    }

    function resetCandidateViewState() {
        clearPersistedCandidateViewState();
        candidateViewState = createEmptyCandidateViewState(createCandidateViewScope().key);
        renderedCandidateScopeKey = '';
    }

    function renderCandidates() {
        const allCandidates = currentState.candidates;
        for (const [candidateId, override] of candidateUrlVisibilityOverrides) {
            const stillCurrent = allCandidates.some((candidate) =>
                candidate.id === candidateId && candidate.url === override?.url
            );
            if (!stillCurrent) candidateUrlVisibilityOverrides.delete(candidateId);
        }
        const diagnosticCount = allCandidates.filter((candidate) => candidate.diagnosticOnly === true).length;
        const primaryCandidates = allCandidates.filter((candidate) => candidate.diagnosticOnly !== true);
        const candidates = primaryCandidates.filter(isReadyCandidate);
        const blockedCount = primaryCandidates.filter((candidate) => candidate.blocked === true).length;
        const failedCount = primaryCandidates.filter((candidate) =>
            candidate.blocked !== true && isRejectedCandidate(candidate)
        ).length;
        const protectedCount = primaryCandidates.filter((candidate) =>
            candidate.blocked !== true && !isRejectedCandidate(candidate) && candidate.drmProtected === true
        ).length;
        const recommended = chooseRecommendedCandidate(candidates, currentState.status);
        const waitingForContent = candidates.length > 0 && recommended === null;
        const ignoredParts = [];
        if (blockedCount) ignoredParts.push(filteredMediaLabel(blockedCount));
        if (failedCount) ignoredParts.push(failedMediaLabel(failedCount));
        if (protectedCount) ignoredParts.push(protectedMediaLabel(protectedCount));
        ui.candidateCount.textContent = String(candidates.length);
        ui.candidateCount.setAttribute('aria-label', candidateCountLabel(candidates.length));
        ui.candidateContent.setAttribute('aria-busy', stateLoaded ? 'false' : 'true');
        ui.playOptions.hidden = candidates.length === 0;
        ui.playlistTools.hidden = candidates.length === 0;
        ui.quickPlayButton.dataset.candidateId = recommended?.id || '';
        ui.quickPlayButton.dataset.viewAction = 'quick-play';
        ui.quickPlayButton.disabled = recommended === null || candidatePlayBusyIds.size > 0;
        ui.quickPlayButton.textContent = candidatePlayBusyIds.size > 0
            ? 'Wysyłam do MPV…'
            : waitingForContent
            ? 'Czekam na właściwy materiał'
            : 'Otwórz polecany w MPV';
        ui.quickPlayButton.setAttribute(
            'aria-busy',
            recommended && candidatePlayBusyIds.has(recommended.id) ? 'true' : 'false'
        );
        if (waitingForContent) {
            ui.quickPlayButton.title = 'Wykryte źródła są jeszcze prowizoryczne. Każde możesz otworzyć ręcznie.';
        } else {
            ui.quickPlayButton.removeAttribute('title');
        }
        ui.exportM3uButton.disabled = exportM3uBusy || !candidates.some(isM3uExportableCandidate);
        ui.exportM3uButton.textContent = exportM3uBusy ? 'Tworzę M3U…' : 'Pobierz adresy M3U';
        ui.exportM3uButton.setAttribute('aria-busy', exportM3uBusy ? 'true' : 'false');
        ui.diagnosticSourceNote.hidden = diagnosticCount === 0;
        ui.diagnosticSourceNote.textContent = diagnosticCount ? diagnosticSourceCountLabel(diagnosticCount) : '';
        const originSummary = [...new Set(candidates.flatMap((candidate) => candidate.methods || ['Sieć']))].join(' + ');
        ui.playlistSummary.textContent = [
            `${candidateCountLabel(candidates.length)} gotowych do otwarcia.`,
            candidates.length ? `Pochodzenie: ${originSummary}.` : '',
            waitingForContent
                ? 'Wykryte źródła są jeszcze prowizoryczne — czekam na właściwy materiał. Każde możesz otworzyć ręcznie.'
                : '',
            ...ignoredParts,
            recommended?.playbackKind === 'yt-dlp-page'
                ? 'Polecany wpis yt-dlp odświeża adresy przy kliknięciu; eksportuj go jako skrypt MPV, nie M3U.'
                : candidates.some((candidate) => candidate.playbackKind === 'yt-dlp-page')
                    ? 'Wpis yt-dlp odświeża adresy przy kliknięciu; eksportuj go jako skrypt MPV, nie M3U.'
                : 'Przycisk MPV przekazuje wymagane nagłówki; plik M3U zawiera świeże adresy.'
        ].filter(Boolean).join(' ');

        if (!stateLoaded) {
            ui.candidateContent.replaceChildren(createEmptyPanel(
                'loading',
                'Nasłuchuję ruchu wideo',
                'Za chwilę pokażę najlepszy bezpieczny kandydat.'
            ));
            return;
        }

        if (restrictedContext) {
            ui.candidateContent.replaceChildren(createEmptyPanel(
                'permission',
                'Wykrywanie jest niedostępne',
                'Przejdź do zwykłej strony internetowej i uruchom odtwarzanie.'
            ));
            return;
        }

        if (stateLoadError) {
            ui.candidateContent.replaceChildren(createEmptyPanel(
                'error',
                'Nie pobrano kandydatów',
                friendlyError(stateLoadError)
            ));
            return;
        }

        if (candidates.length === 0) {
            const code = normalizeStatusCode(currentState.status);
            const preparingYouTube = resolverPlatformId(currentState.platform?.id, currentHostname) === 'youtube' &&
                ['scheduled', 'resolving'].includes(currentState.resolver?.state);
            const protectedContent = code.includes('DRM');
            const onlyFailedMedia = failedCount > 0 && blockedCount === 0 && protectedCount === 0;
            const onlyFilteredMedia = blockedCount > 0 && failedCount === 0 && protectedCount === 0;
            ui.candidateContent.replaceChildren(createEmptyPanel(
                preparingYouTube ? 'loading' : protectedContent || onlyFailedMedia ? 'error' : onlyFilteredMedia ? 'filtered' : 'empty',
                preparingYouTube
                    ? 'Przygotowuję źródła materiału'
                    : protectedContent
                    ? 'Treść jest chroniona'
                    : onlyFailedMedia
                        ? 'Źródła wygasły lub zostały odrzucone'
                    : onlyFilteredMedia
                        ? 'Reklamy zostały pominięte'
                        : 'Jeszcze nic do otwarcia',
                preparingYouTube
                    ? 'yt-dlp analizuje bieżący film w tle. Nic nie zostanie uruchomione bez Twojej decyzji.'
                    : protectedContent
                    ? 'MPV Redirector nie omija zabezpieczeń DRM.'
                    : onlyFailedMedia
                        ? 'Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle. Jeśli lista się nie uzupełni, uruchom materiał na stronie ponownie.'
                    : onlyFilteredMedia
                        ? 'Czekam na właściwy HLS, DASH lub plik wideo z załadowanej strony.'
                        : 'Uruchom wideo lub odśwież stronę. Lista uzupełni się automatycznie.'
            ));
            return;
        }

        const fragment = document.createDocumentFragment();
        if (recommended) {
            const otherCandidates = candidates.filter((candidate) => candidate !== recommended);
            fragment.appendChild(createCandidateCard(recommended, { recommended: true, compact: false }));

            if (otherCandidates.length > 0) {
                const details = document.createElement('details');
                details.className = 'other-candidates';
                details.dataset.viewAction = 'other-candidates';

                const summary = document.createElement('summary');
                summary.className = 'other-summary';
                summary.dataset.viewAction = 'other-candidates-summary';
                const label = document.createElement('span');
                label.textContent = `Inne źródła (${otherCandidates.length})`;
                summary.appendChild(label);
                details.appendChild(summary);

                const list = document.createElement('div');
                list.className = 'other-list';
                otherCandidates.forEach((candidate) => {
                    list.appendChild(createCandidateCard(candidate, { recommended: false, compact: true }));
                });
                details.appendChild(list);
                fragment.appendChild(details);
            }
        } else {
            candidates.forEach((candidate) => {
                fragment.appendChild(createCandidateCard(candidate, { recommended: false, compact: false }));
            });
        }

        ui.candidateContent.replaceChildren(fragment);
    }

    function createCandidateCard(candidate, options) {
        const viewOptions = {
            recommended: options?.recommended === true,
            compact: options?.compact === true
        };
        const card = document.createElement('article');
        card.className = `candidate-card${viewOptions.recommended ? ' recommended' : ''}${viewOptions.compact ? ' compact' : ''}`;
        card.dataset.candidateId = candidate.id;

        const top = document.createElement('div');
        top.className = 'candidate-top';

        const heading = document.createElement('div');
        heading.className = 'candidate-heading';
        const tags = document.createElement('div');
        tags.className = 'candidate-tags';

        if (viewOptions.recommended) {
            tags.appendChild(createTextElement('span', 'candidate-badge', 'Polecany'));
        }
        if (candidate.userPriority !== 0) {
            const priorityBadge = createTextElement(
                'span',
                'candidate-priority-badge',
                candidate.userPriority === 1 ? 'Własny: preferowany' : 'Własny: obniżony'
            );
            priorityBadge.dataset.priority = candidatePriorityMode(candidate.userPriority);
            tags.appendChild(priorityBadge);
        }
        if (candidate.prerollProvisional) {
            tags.appendChild(createTextElement('span', 'candidate-provisional-chip', 'Źródło wstępne'));
        }
        tags.appendChild(createTextElement('span', 'candidate-chip', candidate.type));
        if (candidate.quality) tags.appendChild(createTextElement('span', 'candidate-chip', candidate.quality));
        if (candidate.bitrateKbps !== null) {
            const bitrateChip = createTextElement('span', 'candidate-chip candidate-bitrate-chip', `${candidate.bitrateKbps} kb/s`);
            bitrateChip.title = 'Przepływność źródła';
            tags.appendChild(bitrateChip);
        }
        if (candidate.language) tags.appendChild(createTextElement('span', 'candidate-chip', candidate.language));
        candidate.methods.forEach((method) => {
            tags.appendChild(createTextElement('span', 'candidate-origin-chip', method));
        });
        heading.appendChild(tags);

        const title = createTextElement('h3', 'candidate-title', candidate.title);
        heading.appendChild(title);
        heading.appendChild(createTextElement('p', 'candidate-source', `Host strumienia: ${candidate.source}`));
        if (candidate.sourceFamilyLabel) {
            heading.appendChild(createTextElement('p', 'candidate-family-label', `Wzorzec źródła: ${candidate.sourceFamilyLabel}`));
        }
        top.appendChild(heading);

        if (candidate.score !== null) {
            top.appendChild(createTextElement('span', 'candidate-score', `${formatScore(candidate.score)}/100`));
        }
        card.appendChild(top);

        const meta = document.createElement('div');
        meta.className = 'candidate-meta';
        if (candidate.live) meta.appendChild(createTextElement('span', '', 'Transmisja na żywo'));
        meta.appendChild(createTextElement('span', '', candidateMediaKindLabel(candidate.mediaKind, candidate.role, false)));
        const languageLabel = candidateLanguageLabel(candidate.language);
        if (languageLabel) meta.appendChild(createTextElement('span', '', languageLabel));
        meta.appendChild(createTextElement('span', '', candidate.hasHeaders ? 'Nagłówki gotowe' : 'Bez dodatkowych nagłówków'));
        card.appendChild(meta);

        if (candidate.reason) {
            card.appendChild(createTextElement('p', 'recommendation-note', candidate.reason));
        } else if (viewOptions.recommended) {
            card.appendChild(createTextElement('p', 'recommendation-note', 'Najwyżej ocenione źródło spośród aktualnie wykrytych.'));
        }

        let disabledReason = '';
        if (!candidate.id) disabledReason = 'Brak identyfikatora kandydata. Odśwież stan wykrywania.';
        if (candidate.drmProtected) disabledReason = 'To źródło jest chronione DRM i nie może zostać przekazane.';

        if (disabledReason) {
            card.appendChild(createTextElement('p', 'candidate-warning', disabledReason));
        }

        card.appendChild(createCandidateControls(candidate));

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = viewOptions.recommended ? 'play-button' : 'secondary-play-button';
        playButton.dataset.candidateId = candidate.id;
        playButton.dataset.viewAction = 'play';
        playButton.dataset.idleLabel = viewOptions.recommended ? 'Otwórz polecany w MPV' : 'Otwórz ten strumień';
        playButton.dataset.unavailable = disabledReason ? 'true' : 'false';
        playButton.textContent = candidatePlayBusyIds.size > 0 ? 'Wysyłam do MPV…' : playButton.dataset.idleLabel;
        playButton.disabled = Boolean(disabledReason) || candidatePlayBusyIds.size > 0;
        playButton.setAttribute('aria-busy', candidatePlayBusyIds.has(candidate.id) ? 'true' : 'false');
        if (healthState.hostAvailable === false) {
            playButton.title = 'Host jest niedostępny. Kliknięcie ponowi próbę i pokaże dokładny błąd.';
        }
        playButton.addEventListener('click', () => {
            void playCandidate(candidate, playButton);
        });
        card.appendChild(playButton);
        card.appendChild(createActionsMenu(candidate));

        return card;
    }

    function createCandidateControls(candidate) {
        const panel = document.createElement('div');
        panel.className = 'candidate-preference-panel';

        const controls = document.createElement('div');
        controls.className = 'candidate-controls';

        const priorityControl = document.createElement('div');
        priorityControl.className = 'candidate-priority-control';
        priorityControl.appendChild(createTextElement('span', 'candidate-control-label', 'Priorytet wzorca'));

        const priorityButtons = document.createElement('div');
        priorityButtons.className = 'candidate-priority-buttons';
        priorityButtons.setAttribute('role', 'group');
        priorityButtons.setAttribute('aria-label', `Priorytet wzorca źródła: ${candidate.title}`);
        priorityButtons.setAttribute('aria-busy', candidatePriorityBusyIds.has(candidate.id) ? 'true' : 'false');

        const priorityOptions = [
            { value: 1, label: 'Preferuj' },
            { value: 0, label: 'Normalnie' },
            { value: -1, label: 'Obniż' }
        ];
        priorityOptions.forEach(({ value, label }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'candidate-priority-button';
            button.textContent = label;
            button.dataset.priority = candidatePriorityMode(value);
            button.dataset.candidateId = candidate.id;
            button.dataset.viewAction = `priority-${candidatePriorityMode(value)}`;
            button.setAttribute('aria-label', `${label} priorytet wzorca źródła: ${candidate.title}`);
            button.setAttribute('aria-pressed', candidate.userPriority === value ? 'true' : 'false');
            button.disabled = !candidate.id || candidatePriorityBusyIds.has(candidate.id);
            button.addEventListener('click', () => {
                if (candidate.userPriority === value) return;
                void handleCandidatePriorityChange(candidate, value, priorityButtons);
            });
            priorityButtons.appendChild(button);
        });
        priorityControl.appendChild(priorityButtons);

        const storedOverride = candidateUrlVisibilityOverrides.get(candidate.id);
        const temporaryOverride = storedOverride?.url === candidate.url ? storedOverride.visible : undefined;
        let urlVisible = resolveCandidateUrlVisibility(
            currentState.sourcePreferences?.showFullUrls === true,
            temporaryOverride
        );
        const urlToggle = document.createElement('button');
        urlToggle.type = 'button';
        urlToggle.className = 'candidate-url-toggle';
        urlToggle.dataset.candidateId = candidate.id;
        urlToggle.dataset.viewAction = 'toggle-url';
        urlToggle.disabled = !candidate.url;

        const fullUrl = document.createElement('code');
        fullUrl.className = 'candidate-full-url';
        fullUrl.id = `candidate-full-url-${++candidateControlSerial}`;
        fullUrl.textContent = candidate.url;
        fullUrl.setAttribute('aria-label', `Pełny URL źródła: ${candidate.title}`);
        urlToggle.setAttribute('aria-controls', fullUrl.id);

        const renderLocalUrlVisibility = () => {
            fullUrl.hidden = !urlVisible;
            urlToggle.textContent = urlVisible ? 'Ukryj URL' : 'Pokaż URL';
            urlToggle.setAttribute('aria-expanded', urlVisible ? 'true' : 'false');
            urlToggle.setAttribute('aria-label', `${urlVisible ? 'Ukryj' : 'Pokaż'} pełny URL źródła: ${candidate.title}`);
        };
        renderLocalUrlVisibility();
        urlToggle.addEventListener('click', () => {
            const globalVisible = currentState.sourcePreferences?.showFullUrls === true;
            urlVisible = !urlVisible;
            if (urlVisible === globalVisible) candidateUrlVisibilityOverrides.delete(candidate.id);
            else candidateUrlVisibilityOverrides.set(candidate.id, { url: candidate.url, visible: urlVisible });
            renderLocalUrlVisibility();
        });

        controls.append(priorityControl, urlToggle);
        panel.append(controls, fullUrl);
        return panel;
    }

    async function handleCandidatePriorityChange(candidate, value, priorityButtons) {
        if (!activeTab || !candidate.id || candidatePriorityBusyIds.has(candidate.id)) return;

        const normalizedValue = normalizeUserPriority(value);
        let focusPriorityValue = normalizedValue;
        candidatePriorityBusyIds.add(candidate.id);
        priorityButtons.setAttribute('aria-busy', 'true');
        priorityButtons.querySelectorAll('button').forEach((button) => {
            button.disabled = true;
            button.setAttribute('aria-pressed', button.dataset.priority === candidatePriorityMode(normalizedValue)
                ? 'true'
                : 'false');
        });
        setGlobalFeedback('Zapisuję priorytet źródła dla tej witryny.', '');

        try {
            const response = await sendWorkerRequest(
                'SET_CANDIDATE_PRIORITY',
                buildCandidatePriorityRequest(activeTab.id, candidate.id, normalizedValue)
            );
            applyWorkerStateResponse(response, 'Nie udało się zapisać priorytetu źródła.');
            const updatedCandidate = currentState.candidates.find((entry) => entry.id === candidate.id);
            const appliedValue = updatedCandidate ? updatedCandidate.userPriority : normalizedValue;
            focusPriorityValue = appliedValue;
            const label = appliedValue === 1
                ? 'preferowany'
                : appliedValue === -1 ? 'obniżony' : 'normalny';
            addLocalEvent('success', 'CANDIDATE_PRIORITY_CHANGED', `Ustawiono ${label} priorytet źródła.`);
            setGlobalFeedback(`Priorytet źródła: ${label}.`, 'success');
        } catch (error) {
            const message = friendlyError(error);
            addLocalEvent('error', error.code || 'CANDIDATE_PRIORITY_FAILED', message);
            setGlobalFeedback(message, 'error', true);
        } finally {
            candidatePriorityBusyIds.delete(candidate.id);
            renderAll();
            const appliedMode = candidatePriorityMode(focusPriorityValue);
            const focusTarget = [...document.querySelectorAll('.candidate-priority-button')]
                .find((button) => button.dataset.candidateId === candidate.id && button.dataset.priority === appliedMode);
            const containingDetails = focusTarget?.closest('details');
            if (containingDetails) containingDetails.open = true;
            focusTarget?.focus();
        }
    }

    function createActionsMenu(candidate) {
        const details = document.createElement('details');
        details.className = 'actions-menu';
        details.dataset.candidateId = candidate.id;
        const summary = document.createElement('summary');
        summary.textContent = 'Więcej opcji';
        summary.dataset.candidateId = candidate.id;
        summary.dataset.viewAction = 'actions-summary';
        details.appendChild(summary);

        const grid = document.createElement('div');
        grid.className = 'actions-grid';
        const feedback = document.createElement('p');
        feedback.className = 'action-feedback';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');

        const copyUrlButton = createActionButton('Kopiuj URL');
        setCandidateViewAction(copyUrlButton, candidate.id, 'copy-url');
        copyUrlButton.disabled = !candidate.url;
        copyUrlButton.addEventListener('click', () => {
            void runSecondaryAction(copyUrlButton, feedback, async () => {
                const liveCandidate = currentCandidateForSecondaryAction(candidate);
                await copyText(liveCandidate.url);
                return 'Skopiowano pełny URL.';
            });
        });

        const copyCommandButton = createActionButton('Kopiuj komendę');
        setCandidateViewAction(copyCommandButton, candidate.id, 'copy-command');
        copyCommandButton.disabled = !candidate.url;
        copyCommandButton.addEventListener('click', () => {
            void runSecondaryAction(copyCommandButton, feedback, async () => {
                const liveCandidate = currentCandidateForSecondaryAction(candidate);
                await copyText(buildMpvCommand(liveCandidate));
                return 'Skopiowano komendę MPV.';
            });
        });

        const saveScriptButton = createActionButton('Zapisz skrypt');
        setCandidateViewAction(saveScriptButton, candidate.id, 'save-script');
        saveScriptButton.disabled = !candidate.url;
        saveScriptButton.addEventListener('click', () => {
            void runSecondaryAction(saveScriptButton, feedback, async () => {
                const liveCandidate = currentCandidateForSecondaryAction(candidate);
                await downloadLaunchScript(liveCandidate);
                return 'Zapisano skrypt uruchamiający.';
            });
        });

        grid.append(copyUrlButton, copyCommandButton, saveScriptButton);
        details.append(grid, feedback);
        return details;
    }

    function currentCandidateForSecondaryAction(renderedCandidate) {
        const liveCandidate = currentState.candidates.find((candidate) =>
            candidate.id === renderedCandidate?.id
        );
        if (
            !liveCandidate?.url ||
            liveCandidate.diagnosticOnly === true ||
            liveCandidate.blocked === true ||
            liveCandidate.drmProtected === true ||
            ['advertisement', 'utility'].includes(liveCandidate.purpose) ||
            isRejectedCandidate(liveCandidate, Date.now())
        ) {
            throw new PopupRequestError(
                'Wybrane źródło wygasło lub zostało zastąpione. Wtyczka szuka świeżego adresu w tle.',
                'STREAM_URL_EXPIRED'
            );
        }
        return liveCandidate;
    }

    async function runSecondaryAction(button, feedback, task) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Pracuję…';
        feedback.textContent = '';
        feedback.dataset.tone = '';

        try {
            const message = await task();
            feedback.textContent = message;
            feedback.dataset.tone = 'success';
        } catch (error) {
            feedback.textContent = friendlyError(error);
            feedback.dataset.tone = 'error';
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    async function playCandidate(candidate, button) {
        if (!activeTab || !candidate.id || candidatePlayBusyIds.size > 0) return;

        const mode = getPlayMode();
        candidatePlayBusyIds.add(candidate.id);
        syncCandidatePlayBusyState();
        actionView = {
            stage: 'Przekazywanie',
            title: 'Uruchamiam MPV',
            message: 'Worker sprawdza host lokalny i przekazuje wybrane źródło.',
            reason: 'Oczekuję na potwierdzenie z hosta.',
            tone: 'loading'
        };
        renderStatus();
        setGlobalFeedback('Czekam na odpowiedź hosta lokalnego.', '');

        try {
            const response = await sendWorkerRequest('PLAY', {
                tabId: activeTab.id,
                candidateId: candidate.id,
                mode
            }, PLAY_REQUEST_TIMEOUT_MS);
            assertWorkerResponse(response, 'MPV nie potwierdził otwarcia strumienia.');

            const resultText = playResultText(response, mode);
            actionView = {
                stage: 'Zakończono',
                title: resultText.title,
                message: resultText.message,
                reason: 'Host lokalny potwierdził wykonanie polecenia.',
                tone: 'success',
                resultLabel: 'Rezultat:'
            };
            addLocalEvent('success', 'PLAY_CONFIRMED', resultText.message);
            renderStatus();
            renderDiagnostics();
            setGlobalFeedback(resultText.message, 'success');
            void refreshHealth().catch(handleHealthError);
        } catch (error) {
            const message = friendlyError(error);
            actionView = createErrorView('Nie udało się otworzyć w MPV', message);
            addLocalEvent('error', error.code || 'PLAY_FAILED', message);
            renderStatus();
            renderDiagnostics();
            setGlobalFeedback(message, 'error', true);
        } finally {
            candidatePlayBusyIds.delete(candidate.id);
            syncCandidatePlayBusyState();
        }
    }

    function renderDiagnostics() {
        const stateEvents = Array.isArray(currentState.events) ? [...currentState.events].reverse() : [];
        const events = [...localEvents, ...stateEvents].slice(0, 12);
        ui.eventCount.textContent = eventCountLabel(events.length);
        ui.eventList.replaceChildren();

        if (events.length === 0) {
            const item = document.createElement('li');
            item.className = 'event-item';
            item.appendChild(createTextElement('p', 'event-message', 'Brak zdarzeń diagnostycznych dla tej sesji.'));
            ui.eventList.appendChild(item);
            return;
        }

        const fragment = document.createDocumentFragment();
        events.forEach((event) => fragment.appendChild(createEventItem(event)));
        ui.eventList.appendChild(fragment);
    }

    function createEventItem(rawEvent) {
        const event = rawEvent && typeof rawEvent === 'object' ? rawEvent : { message: rawEvent };
        const item = document.createElement('li');
        item.className = 'event-item';
        const tone = eventTone(event);
        if (tone) item.dataset.tone = tone;

        const heading = document.createElement('div');
        heading.className = 'event-heading';
        const code = safeCode(event.code || event.stage || event.type || event.level || 'ZDARZENIE');
        heading.appendChild(createTextElement('span', '', eventHeading(code)));
        const time = formatEventTime(event.time || event.timestamp || event.at);
        if (time) heading.appendChild(createTextElement('span', 'event-time', time));
        item.appendChild(heading);

        const message = firstSafeText(event.message, event.reason, event.description) || 'Zdarzenie zostało zarejestrowane.';
        item.appendChild(createTextElement('p', 'event-message', message));
        return item;
    }

    function createEmptyPanel(state, title, message) {
        const wrapper = document.createElement('div');
        wrapper.className = 'empty-state';
        wrapper.dataset.state = state;
        const orbit = document.createElement('span');
        orbit.className = 'empty-orbit';
        orbit.setAttribute('aria-hidden', 'true');
        wrapper.append(orbit, createTextElement('h3', '', title), createTextElement('p', '', message));
        return wrapper;
    }

    function createActionButton(label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button';
        button.textContent = label;
        return button;
    }

    function setCandidateViewAction(element, candidateId, action) {
        element.dataset.candidateId = candidateId;
        element.dataset.viewAction = action;
        return element;
    }

    function syncCandidatePlayBusyState() {
        const busy = candidatePlayBusyIds.size > 0;
        [...ui.candidateContent.querySelectorAll('[data-view-action="play"]')].forEach((button) => {
            const ownRequest = candidatePlayBusyIds.has(button.dataset.candidateId);
            button.disabled = busy || button.dataset.unavailable === 'true';
            button.textContent = busy ? 'Wysyłam do MPV…' : button.dataset.idleLabel;
            button.setAttribute('aria-busy', ownRequest ? 'true' : 'false');
        });
        const recommended = chooseRecommendedCandidate(
            currentState.candidates.filter(isReadyCandidate),
            currentState.status
        );
        ui.quickPlayButton.disabled = busy || recommended === null;
        ui.quickPlayButton.textContent = busy ? 'Wysyłam do MPV…' : 'Otwórz polecany w MPV';
        ui.quickPlayButton.setAttribute(
            'aria-busy',
            recommended && candidatePlayBusyIds.has(recommended.id) ? 'true' : 'false'
        );
    }

    function syncPlaylistActionBusyState() {
        const exportable = currentState.candidates.some((candidate) =>
            isReadyCandidate(candidate) && isM3uExportableCandidate(candidate)
        );
        ui.exportM3uButton.disabled = exportM3uBusy || !exportable;
        ui.exportM3uButton.textContent = exportM3uBusy ? 'Tworzę M3U…' : 'Pobierz adresy M3U';
        ui.exportM3uButton.setAttribute('aria-busy', exportM3uBusy ? 'true' : 'false');
    }

    function createTextElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = String(text ?? '');
        return element;
    }

    function addLocalEvent(level, code, message) {
        localEvents.unshift({
            level,
            code,
            message: safeDiagnosticText(message),
            timestamp: Date.now()
        });
        localEvents = localEvents.slice(0, 8);
    }

    function setGlobalFeedback(message, tone = '', sticky = false) {
        if (feedbackTimer) {
            clearTimeout(feedbackTimer);
            feedbackTimer = null;
        }

        ui.globalFeedback.textContent = safeDiagnosticText(message || '');
        ui.globalFeedback.dataset.tone = tone;
        if (message && !sticky && tone === 'success') {
            feedbackTimer = setTimeout(() => {
                ui.globalFeedback.textContent = '';
                ui.globalFeedback.dataset.tone = '';
                feedbackTimer = null;
            }, 4500);
        }
    }

    function getPlayMode() {
        const value = document.querySelector('input[name="play-mode"]:checked')?.value;
        return VALID_PLAY_MODES.has(value) ? value : 'new';
    }

    function setPlayMode(value) {
        const mode = VALID_PLAY_MODES.has(value) ? value : 'new';
        const input = document.querySelector(`input[name="play-mode"][value="${mode}"]`);
        if (input) input.checked = true;
        ui.modeHelp.textContent = MODE_COPY[mode];
    }

    function createEmptyState(hostname) {
        return {
            hostname,
            platform: { id: 'generic', label: 'Strona internetowa' },
            materialScope: null,
            pageIdentity: '',
            navigationEpoch: 0,
            sourcePreferences: {
                ...normalizeSourcePreferences(null),
                qualityOrder: [...DEFAULT_SOURCE_QUALITY_ORDER]
            },
            candidates: [],
            events: [],
            resolver: createEmptyResolverState(),
            status: { code: 'IDLE' }
        };
    }

    function createEmptyResolverState() {
        return {
            state: 'idle',
            adapter: 'generic',
            resolver: null,
            attempted: [],
            resultCount: 0,
            cookiesUsed: false,
            truncated: false,
            source: null,
            materialScope: '',
            batchId: null,
            candidateIds: [],
            pageReadyScope: '',
            pageReadyState: 'idle',
            updatedAt: 0
        };
    }

    function createEmptyResolverHealth() {
        return {
            order: ['streamlink', 'yt-dlp'],
            streamlink: { installed: false, available: false, compatible: false, version: null },
            ytDlp: { installed: false, available: false, compatible: false, version: null }
        };
    }

    function normalizeResolverState(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const allowedStates = new Set(['idle', 'scheduled', 'resolving', 'found', 'empty', 'unavailable', 'failed']);
        const attempted = Array.isArray(source.attempted)
            ? source.attempted.slice(0, 2).map((attempt) => ({
                resolver: ['streamlink', 'yt-dlp'].includes(attempt?.resolver) ? attempt.resolver : '',
                status: safeShortText(attempt?.status, 'failed').toLowerCase(),
                count: Number.isInteger(attempt?.count) && attempt.count >= 0 ? Math.min(attempt.count, 24) : 0,
                available: attempt?.available === true,
                compatible: attempt?.compatible === true,
                version: firstSafeText(attempt?.version).slice(0, 40) || null
            })).filter((attempt) => attempt.resolver)
            : [];
        return {
            state: allowedStates.has(source.state) ? source.state : 'idle',
            adapter: ['tvp', 'youtube', 'generic'].includes(source.adapter) ? source.adapter : 'generic',
            resolver: ['streamlink', 'yt-dlp'].includes(source.resolver) ? source.resolver : null,
            attempted,
            resultCount: Number.isInteger(source.resultCount) && source.resultCount >= 0
                ? Math.min(source.resultCount, 24)
                : 0,
            cookiesUsed: source.cookiesUsed === true,
            truncated: source.truncated === true,
            source: ['manual', 'page_ready', 'refresh'].includes(source.source) ? source.source : null,
            materialScope: firstSafeText(source.materialScope).slice(0, 160),
            batchId: firstSafeText(source.batchId).slice(0, 160) || null,
            candidateIds: Array.isArray(source.candidateIds)
                ? source.candidateIds.filter((id) => typeof id === 'string').slice(0, 24)
                : [],
            pageReadyScope: firstSafeText(source.pageReadyScope).slice(0, 160),
            pageReadyState: ['idle', 'scheduled', 'resolving', 'done'].includes(source.pageReadyState)
                ? source.pageReadyState
                : 'idle',
            errorCode: safeShortText(source.errorCode).toUpperCase(),
            updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0
        };
    }

    function normalizeState(rawState, fallbackHostname) {
        const source = rawState && typeof rawState === 'object' ? rawState : {};
        const rawCandidates = Array.isArray(source.candidates) ? source.candidates : [];
        const rawEvents = Array.isArray(source.events) ? source.events : [];
        const status = source.status && typeof source.status === 'object'
            ? source.status
            : { code: source.status || 'IDLE' };

        return {
            hostname: safeHostname(source.hostname) || fallbackHostname,
            platform: source.platform && typeof source.platform === 'object'
                ? {
                    id: ['tvp', 'youtube', 'generic'].includes(source.platform.id) ? source.platform.id : 'generic',
                    label: firstSafeText(source.platform.label).slice(0, 40) || 'Strona internetowa'
                }
                : { id: 'generic', label: 'Strona internetowa' },
            materialScope: source.materialScope && typeof source.materialScope === 'object'
                ? {
                    id: normalizeViewIdentity(source.materialScope.id),
                    platform: safeShortText(source.materialScope.platform),
                    kind: safeShortText(source.materialScope.kind),
                    materialId: safeShortText(source.materialScope.materialId)
                }
                : null,
            pageIdentity: normalizeViewIdentity(source.pageIdentity),
            navigationEpoch: Number.isInteger(source.navigationEpoch) && source.navigationEpoch >= 0
                ? source.navigationEpoch
                : 0,
            sourcePreferences: {
                ...normalizeSourcePreferences(source.sourcePreferences),
                qualityOrder: normalizeQualityOrder(source.sourcePreferences?.qualityOrder)
            },
            candidates: rawCandidates.map(normalizeCandidate),
            events: rawEvents,
            resolver: normalizeResolverState(source.resolver),
            status
        };
    }

    function normalizeCandidate(rawCandidate, index) {
        const raw = rawCandidate && typeof rawCandidate === 'object' ? rawCandidate : {};
        const stream = raw.stream && typeof raw.stream === 'object' ? raw.stream : raw;
        const url = firstString(raw.url, stream.url);
        const type = safeShortText(firstString(raw.type, raw.format, raw.kind, stream.type, 'STRUMIEŃ'), 'STRUMIEŃ');
        const quality = normalizeQuality(raw.quality || raw.resolution || raw.height || stream.quality);
        const scoreNumber = Number(raw.score ?? raw.rankScore ?? raw.confidence);
        const bitrateNumber = Number(raw.bitrateKbps ?? stream.bitrateKbps);
        const idValue = raw.candidateId ?? raw.id ?? raw.key ?? raw.fingerprint ?? '';
        const titleValue = firstString(raw.label, raw.name, raw.title);
        const purpose = safeShortText(firstString(raw.purpose, raw.classification, 'content'), 'content').toLowerCase();
        const role = safeShortText(firstString(raw.role, raw.mediaRole, 'unknown'), 'unknown').toLowerCase();
        const mediaKind = ['adaptive', 'muxed', 'video-only', 'audio-only'].includes(raw.mediaKind)
            ? raw.mediaKind
            : '';
        const playbackKind = raw.playbackKind === 'yt-dlp-page' ? raw.playbackKind : '';
        const prerollProvisional = raw.prerollProvisional === true;
        const language = typeof raw.language === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(raw.language)
            ? raw.language.slice(0, 35)
            : '';
        const statusNumber = Number(raw.statusCode ?? stream.statusCode);
        const statusCode = Number.isInteger(statusNumber) ? statusNumber : null;
        const networkError = firstSafeText(raw.networkError, stream.networkError);
        const expiry = normalizeCandidateExpiry(
            raw.expiry ?? raw.expiresAt ?? stream.expiry ?? stream.expiresAt
        );
        const expired = raw.expired === true || stream.expired === true ||
            (expiry !== null && expiry <= Date.now());
        const rawPlayState = safeShortText(firstString(raw.playState, stream.playState)).toLowerCase();
        const playState = ['idle', 'opening', 'playing', 'error'].includes(rawPlayState)
            ? rawPlayState
            : '';
        const hasHeaders = Boolean(
            raw.hasHeaders || stream.hasHeaders || stream.referer || stream.origin || stream.userAgent ||
            raw.headers || stream.headers || raw.requestHeaders || stream.requestHeaders
        );
        const drmProtected = Boolean(
            raw.drm === true || raw.isDrm === true || raw.drmProtected === true || raw.protected === true ||
            raw.playable === false || stream.drm === true
        );
        const blocked = raw.blocked === true ||
            raw.filtered === true ||
            ['advertisement', 'utility'].includes(purpose);
        const failed = raw.failed === true || stream.failed === true || Boolean(networkError) ||
            (statusCode !== null && statusCode >= 400) || expired || playState === 'error';
        const inferredQuality = quality || normalizeQuality(raw.height || stream.height || raw.width || stream.width);
        const sources = Array.isArray(raw.sources)
            ? raw.sources.filter((source) => typeof source === 'string').slice(0, 8)
            : [];
        const methods = candidateOriginLabels(raw.sourceMethod, sources);
        const safeRaw = {
            url,
            referer: firstString(raw.referer, stream.referer),
            origin: firstString(raw.origin, stream.origin),
            userAgent: firstString(raw.userAgent, stream.userAgent),
            playbackKind
        };
        const recommendationReason = firstSafeText(
            raw.recommendationReason,
            raw.reason,
            raw.summary,
            playbackKind === 'yt-dlp-page'
                ? 'Polecany — yt-dlp dobierze przy kliknięciu świeże wideo i preferowane audio.'
                : role === 'master' ? 'Master adaptacyjny — MPV sam dobierze najlepszą jakość.' : ''
        );
        const sourceFamilyLabel = firstSafeText(raw.sourceFamilyLabel, stream.sourceFamilyLabel).slice(0, 90);

        return {
            raw: safeRaw,
            id: idValue === null || idValue === undefined ? '' : String(idValue),
            url,
            type: type.toUpperCase(),
            quality: inferredQuality,
            bitrateKbps: Number.isFinite(bitrateNumber) && bitrateNumber > 0
                ? Math.min(10_000_000, Math.round(bitrateNumber))
                : null,
            sourceFamilyLabel,
            score: Number.isFinite(scoreNumber) ? scoreNumber : null,
            recommended: raw.recommended === true || raw.isRecommended === true,
            userPriority: normalizeUserPriority(raw.userPriority),
            prerollProvisional,
            title: safeCandidateTitle(titleValue, type, index, role),
            source: sourceLabel(url),
            methods,
            sourceMethod: methods[0],
            reason: prerollProvisional && /polecan/i.test(recommendationReason)
                ? 'Źródło wstępne — szybki start poczeka na właściwy materiał.'
                : recommendationReason,
            hasHeaders,
            drmProtected,
            blocked,
            failed,
            expired,
            expiry,
            playState,
            statusCode,
            networkError,
            purpose,
            role,
            mediaKind,
            playbackKind,
            language,
            hasAudio: typeof raw.hasAudio === 'boolean' ? raw.hasAudio : null,
            hasVideo: typeof raw.hasVideo === 'boolean' ? raw.hasVideo : null,
            diagnosticOnly: raw.diagnosticOnly === true,
            resolverCurrent: raw.resolverCurrent === true,
            live: raw.live === true || raw.isLive === true || stream.live === true
        };
    }

    function normalizeHealth(response) {
        const source = response.health && typeof response.health === 'object'
            ? response.health
            : response.data && typeof response.data === 'object'
                ? response.data
                : response;
        const hostObject = source.host && typeof source.host === 'object' ? source.host : {};
        const mpvObject = source.mpv && typeof source.mpv === 'object' ? source.mpv : {};
        const queueObject = source.queue && typeof source.queue === 'object' ? source.queue : {};
        const resolverObject = source.resolvers && typeof source.resolvers === 'object' && !Array.isArray(source.resolvers)
            ? source.resolvers
            : {};

        let hostAvailable = firstBoolean(
            source.hostAvailable,
            source.nativeHostAvailable,
            source.hostReady,
            typeof source.host === 'boolean' ? source.host : undefined,
            hostObject.available,
            hostObject.ready,
            hostObject.ok
        );
        if (hostAvailable === null && response.ok === true) hostAvailable = true;

        const mpvAvailable = firstBoolean(
            source.mpvAvailable,
            source.playerAvailable,
            mpvObject.available,
            mpvObject.installed,
            mpvObject.found,
            mpvObject.ok
        );
        const mpvRunning = firstBoolean(
            source.mpvRunning,
            source.playerRunning,
            typeof source.mpv === 'boolean' ? source.mpv : undefined,
            mpvObject.running,
            mpvObject.active,
            queueObject.responsive
        );

        const normalizeResolverTool = (value) => ({
            installed: value?.installed === true,
            available: value?.available === true,
            compatible: value?.compatible === true,
            version: firstSafeText(value?.version).slice(0, 40) || null
        });
        const capabilities = Array.isArray(source.capabilities)
            ? source.capabilities.filter((value) => ['health', 'play', 'resolve'].includes(value))
            : [];

        return {
            hostAvailable,
            mpvAvailable,
            mpvRunning,
            message: firstSafeText(source.message, hostObject.message, source.error),
            capabilities,
            resolvers: {
                order: Array.isArray(resolverObject.order)
                    ? resolverObject.order.filter((value) => ['streamlink', 'yt-dlp'].includes(value)).slice(0, 2)
                    : ['streamlink', 'yt-dlp'],
                streamlink: normalizeResolverTool(resolverObject.streamlink),
                ytDlp: normalizeResolverTool(resolverObject.ytDlp || resolverObject['yt-dlp'])
            }
        };
    }

    function isM3uExportableCandidate(candidate) {
        return isReadyCandidate(candidate) && candidate.playbackKind !== 'yt-dlp-page';
    }

    function normalizeStatusCode(status) {
        return normalizeHostRecoveryStatusCode(status);
    }

    function inferStatusPreset(code) {
        if (code === 'STREAM_URL_EXPIRED' || /STREAM_REFRESH.*FAIL/.test(code)) return STATUS_COPY.STREAM_URL_EXPIRED;
        if (/STREAM_REFRESHED|STREAM_REFRESH.*SUCCESS/.test(code)) return STATUS_COPY.STREAM_REFRESHED;
        if (/^STREAM_REFRESH/.test(code)) return STATUS_COPY.STREAM_REFRESHING;
        if (/SUCCESS|OPENED|PLAYING|PLAYED|LAUNCHED/.test(code)) return STATUS_COPY.SUCCESS;
        if (/MPV_|HOST|NATIVE/.test(code)) return STATUS_COPY.HOST_ERROR;
        if (/^HTTP_/.test(code)) return STATUS_COPY.ERROR;
        if (/PERMISSION|FORBIDDEN|RESTRICTED/.test(code)) return STATUS_COPY.PERMISSION;
        if (/ERROR|FAIL|TIMEOUT/.test(code)) return STATUS_COPY.ERROR;
        if (/READY|CANDIDATE|FOUND/.test(code)) return STATUS_COPY.READY;
        if (/DETECT|ANALYZ|SCAN/.test(code)) return STATUS_COPY.DETECTING;
        if (/WAIT|LISTEN|IDLE/.test(code)) return STATUS_COPY.LISTENING;
        return STATUS_COPY.IDLE;
    }

    function defaultStatusMessage(code, candidateCount) {
        if (code === 'STREAM_URL_EXPIRED') {
            return 'Wygasłe źródło zostało ukryte. Wtyczka szuka świeżego adresu w tle.';
        }
        if (/STREAM_REFRESHED|STREAM_REFRESH.*SUCCESS/.test(code)) {
            return 'Znaleziono świeże źródło i zaktualizowano listę.';
        }
        if (/^STREAM_REFRESH/.test(code)) {
            return 'Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle.';
        }
        if (isSuccessCode(code)) return 'Worker potwierdził przekazanie źródła do odtwarzacza.';
        if (/ADS_FILTERED|ADVERTISEMENT_FILTERED|UTILITY_MEDIA_FILTERED/.test(code)) {
            return 'Reklama lub techniczny plik odtwarzacza nie trafi do MPV.';
        }
        if (candidateCount > 0) return candidateCount === 1
            ? 'Jeden kandydat jest gotowy do ręcznego otwarcia.'
            : `${candidateCount} kandydatów jest gotowych do wyboru.`;
        if (code.includes('DRM')) return 'Strona korzysta z ochrony, której rozszerzenie nie omija.';
        return 'Uruchom wideo na stronie. Wynik pojawi się tutaj bez ponownego otwierania popupu.';
    }

    function deriveReason(code, candidateCount) {
        if (code === 'STREAM_URL_EXPIRED' || /^STREAM_REFRESH/.test(code)) {
            return 'Nie wybieraj starego adresu. Jeśli nowy nie pojawi się automatycznie, uruchom materiał na stronie ponownie.';
        }
        if (isSuccessCode(code)) return 'Host lokalny potwierdził wykonanie polecenia.';
        if (healthState.hostAvailable === false) return 'Host Native Messaging jest niedostępny.';
        if (/ADS_FILTERED|ADVERTISEMENT_FILTERED|UTILITY_MEDIA_FILTERED/.test(code)) {
            return 'Lista czeka na właściwy HLS, DASH lub bezpośredni materiał wideo.';
        }
        if (candidateCount > 0 && siteAutoEnabled === false) {
            return 'Auto-otwieranie jest wyłączone dla tej domeny. Użyj przycisku poniżej.';
        }
        if (candidateCount > 0 && siteAutoEnabled === true) {
            return 'Worker czeka na spełnienie warunków bezpiecznego auto-otwarcia.';
        }
        if (siteAutoEnabled === null && currentHostname) return 'Nie odczytano ustawienia auto-otwierania dla domeny.';
        if (code.includes('DRM')) return 'Rozszerzenie nie próbuje omijać zabezpieczeń DRM.';
        return 'Nie wykryto jeszcze obsługiwanego źródła HLS, DASH ani bezpośredniego wideo.';
    }

    function sanitizeStatusView(view) {
        return {
            stage: firstSafeText(view.stage) || 'Stan',
            title: firstSafeText(view.title) || 'Brak szczegółów',
            message: firstSafeText(view.message) || 'Brak dodatkowego komunikatu.',
            reason: firstSafeText(view.reason) || 'Worker nie podał przyczyny.',
            tone: ['loading', 'ready', 'success', 'warning', 'permission', 'error', 'host'].includes(view.tone)
                ? view.tone
                : 'loading',
            resultLabel: firstSafeText(view.resultLabel)
        };
    }

    function createErrorView(title, message) {
        return {
            stage: 'Błąd',
            title,
            message,
            reason: recoveryHint(message),
            tone: isHostError({ message }) ? 'host' : 'error'
        };
    }

    function recoveryHint(message) {
        const lower = String(message || '').toLowerCase();
        if (lower.includes('wygas') || lower.includes('odrzucon') || lower.includes('śwież') || lower.includes('odświeżan')) {
            return 'Wygasłe lub odrzucone źródło pozostaje ukryte. Wtyczka skanuje stronę w tle; jeśli nie znajdzie nowego adresu, uruchom materiał na stronie ponownie.';
        }
        if (lower.includes('manifest') || lower.includes('demukser')) {
            return 'Odśwież rozpoznanie strony. Polecany wpis yt-dlp ominie ciężki master wielojęzyczny.';
        }
        if (lower.includes('host') || lower.includes('native')) {
            return 'Sprawdź instalację hosta lokalnego i użyj przycisku odświeżania.';
        }
        if (lower.includes('worker') || lower.includes('odbior')) {
            return 'Przeładuj rozszerzenie na chrome://extensions i odśwież stronę.';
        }
        if (lower.includes('czas') || lower.includes('timeout')) {
            return 'Żądanie ma ograniczony czas i zostało bezpiecznie przerwane, aby popup nie pozostał zawieszony.';
        }
        return 'Otwórz diagnostykę, odśwież stan i spróbuj ponownie.';
    }

    function playResultText(response, requestedMode) {
        const mode = firstString(response.mode, response.result?.mode, requestedMode);
        const fallbackUsed = response?.result?.fallbackUsed === true;
        const fallbackMessage = fallbackUsed
            ? ' Pierwsze źródło nie zadziałało, więc użyto bezpiecznego źródła zapasowego.'
            : '';
        if (/append|queue|queued/i.test(mode)) {
            return { title: 'Dodano do MPV', message: `Strumień został dodany do playlisty MPV.${fallbackMessage}` };
        }
        if (/replace|replaced/i.test(mode)) {
            return { title: 'Zastąpiono pozycję w MPV', message: `MPV przełączył się na wybrany strumień.${fallbackMessage}` };
        }
        return { title: 'Otwarto w MPV', message: `Host lokalny uruchomił nowe odtwarzanie.${fallbackMessage}` };
    }

    function iconForTone(tone) {
        if (tone === 'success') return '✓';
        if (tone === 'ready') return '→';
        if (tone === 'error' || tone === 'host') return '×';
        if (tone === 'warning' || tone === 'permission') return '!';
        return '…';
    }

    function isSuccessCode(code) {
        return /SUCCESS|OPENED|PLAYING|PLAYED|LAUNCHED/.test(code);
    }

    function buildM3uPlaylist(candidates) {
        const lines = [
            '#EXTM3U',
            '# MPV Redirector Pro — świeże adresy z załadowanej strony',
            '# Źródła wymagające Referer/Origin/User-Agent otwieraj przyciskiem MPV w rozszerzeniu.'
        ];
        for (const candidate of candidates) {
            if (!isM3uExportableCandidate(candidate)) continue;
            const label = sanitizeM3uText([
                candidate.methods.join(' + '),
                candidate.type,
                candidate.quality,
                candidateMediaKindLabel(candidate.mediaKind, candidate.role, candidate.live),
                candidateLanguageLabel(candidate.language),
                candidate.title
            ].filter(Boolean).join(' · '));

            lines.push(`#EXTINF:-1,${label}`);
            lines.push(candidate.url);
        }
        return `${lines.join('\n')}\n`;
    }

    function sanitizeM3uText(value) {
        return String(value ?? '').replace(/[\0\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
    }

    async function copyText(text) {
        if (!text) throw new PopupRequestError('Nie ma danych do skopiowania.', 'NOTHING_TO_COPY');

        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new PopupRequestError(
                'Schowek jest niedostępny w tym kontekście Chrome. Otwórz popup ponownie i kliknij „Kopiuj” jeszcze raz.',
                'CLIPBOARD_UNAVAILABLE'
            );
        }

        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            throw new PopupRequestError(
                'Chrome nie pozwolił skopiować danych. Pozostaw popup otwarty, upewnij się, że ma fokus, i kliknij „Kopiuj” ponownie.',
                'CLIPBOARD_FAILED'
            );
        }
    }

    function downloadM3uPlaylist(candidates) {
        const hostname = (currentHostname || 'strona').replace(/[^a-z0-9.-]+/gi, '_').slice(0, 80);
        return downloadTextFile(
            buildM3uPlaylist(candidates),
            'audio/x-mpegurl;charset=utf-8',
            `mpv_redirector_${hostname}_${Date.now()}.m3u`
        );
    }

    function downloadLaunchScript(candidate) {
        return downloadTextFile(
            buildLaunchScript(candidate),
            'text/x-shellscript;charset=utf-8',
            `mpv_redirector_${Date.now()}.sh`
        );
    }

    function downloadTextFile(content, mimeType, filename) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([content], { type: mimeType });
            const blobUrl = URL.createObjectURL(blob);
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Zapisywanie skryptu przekroczyło limit czasu.', 'DOWNLOAD_TIMEOUT')));
            }, REQUEST_TIMEOUT_MS);

            try {
                chrome.downloads.download({
                    url: blobUrl,
                    filename,
                    saveAs: true
                }, (downloadId) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'DOWNLOAD_FAILED')));
                        return;
                    }
                    if (downloadId === undefined) {
                        finish(() => reject(new PopupRequestError('Chrome nie rozpoczął pobierania.', 'DOWNLOAD_FAILED')));
                        return;
                    }
                    finish(resolve);
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function sendWorkerRequest(
        type,
        payload = {},
        timeoutMs = type === 'PLAY' ? PLAY_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    ) {
        return sendRuntimeRequest(chrome, type, payload, timeoutMs);
    }

    function queryActiveTabs() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Chrome nie zwrócił aktywnej karty.', 'TAB_QUERY_TIMEOUT')));
            }, TAB_QUERY_TIMEOUT_MS);

            try {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'TAB_QUERY_FAILED')));
                        return;
                    }
                    finish(() => resolve(Array.isArray(tabs) ? tabs : []));
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function containsCookiePermission() {
        return new Promise((resolve, reject) => {
            if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') {
                resolve(false);
                return;
            }
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Kontrola uprawnienia cookies przekroczyła limit czasu.', 'PERMISSION_TIMEOUT')));
            }, PERMISSION_TIMEOUT_MS);
            try {
                chrome.permissions.contains({ permissions: ['cookies'] }, (granted) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'PERMISSION_CHECK_FAILED')));
                        return;
                    }
                    finish(() => resolve(granted === true));
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function requestCookiePermission() {
        return new Promise((resolve, reject) => {
            if (!chrome.permissions || typeof chrome.permissions.request !== 'function') {
                reject(new PopupRequestError('Ta wersja Chrome nie udostępnia opcjonalnej zgody cookies.', 'PERMISSION_API_UNAVAILABLE'));
                return;
            }
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Chrome nie zakończył pytania o zgodę cookies.', 'PERMISSION_TIMEOUT')));
            }, PERMISSION_TIMEOUT_MS);
            try {
                // This API call happens synchronously inside the toggle's user gesture.
                chrome.permissions.request({ permissions: ['cookies'] }, (granted) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'PERMISSION_REQUEST_FAILED')));
                        return;
                    }
                    finish(() => resolve(granted === true));
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function removeCookiePermission() {
        return new Promise((resolve, reject) => {
            if (!chrome.permissions || typeof chrome.permissions.remove !== 'function') {
                resolve(false);
                return;
            }
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Usuwanie zgody cookies przekroczyło limit czasu.', 'PERMISSION_TIMEOUT')));
            }, PERMISSION_TIMEOUT_MS);
            try {
                chrome.permissions.remove({ permissions: ['cookies'] }, (removed) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'PERMISSION_REMOVE_FAILED')));
                        return;
                    }
                    finish(() => resolve(removed === true));
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function getLocalSettings(defaults) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Odczyt ustawień przekroczył limit czasu.', 'STORAGE_TIMEOUT')));
            }, REQUEST_TIMEOUT_MS);

            try {
                chrome.storage.local.get(defaults, (result) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'STORAGE_READ_FAILED')));
                        return;
                    }
                    finish(() => resolve(result || defaults));
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function setLocalSettings(values) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                finish(() => reject(new PopupRequestError('Zapis ustawień przekroczył limit czasu.', 'STORAGE_TIMEOUT')));
            }, REQUEST_TIMEOUT_MS);

            try {
                chrome.storage.local.set(values, () => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(() => reject(new PopupRequestError(runtimeError.message, 'STORAGE_WRITE_FAILED')));
                        return;
                    }
                    finish(resolve);
                });
            } catch (error) {
                finish(() => reject(error));
            }
        });
    }

    function assertWorkerResponse(response, fallbackMessage) {
        if (response && response.ok !== false) return;
        const rawError = response?.error;
        const code = firstString(response?.errorCode, response?.code, rawError?.code, 'WORKER_REJECTED');
        const message = firstString(
            rawError?.message,
            rawError,
            response?.errorMessage,
            response?.message,
            fallbackMessage
        );
        throw new PopupRequestError(message || fallbackMessage, code);
    }

    function readEnabledValue(response, fallback) {
        const value = firstBoolean(
            response?.enabled,
            response?.autoOpen,
            response?.siteAuto,
            response?.setting?.enabled,
            response?.data?.enabled
        );
        return value === null ? fallback : value;
    }

    function readTabContext(rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return { hostname: parsed.hostname.toLowerCase(), restricted: null };
            }
            if (parsed.protocol === 'file:') {
                return {
                    hostname: '',
                    restricted: 'Pliki lokalne nie są obsługiwane. MPV Redirector działa wyłącznie na stronach HTTP i HTTPS.'
                };
            }
            return {
                hostname: '',
                restricted: 'Chrome nie pozwala rozszerzeniom monitorować stron systemowych, sklepu ani nowej karty.'
            };
        } catch (error) {
            return { hostname: '', restricted: 'Ta karta nie udostępnia prawidłowego adresu strony.' };
        }
    }

    function safeHostname(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text || text.length > 253) return '';
        return /^[a-z0-9.-]+$/.test(text) ? text : '';
    }

    function normalizeViewIdentity(value) {
        return String(value ?? '').replace(/[\0\r\n]+/g, '').trim().slice(0, 160);
    }

    function sourceLabel(url) {
        if (!url) return 'nieujawnione';
        try {
            const hostname = new URL(url).hostname;
            return safeHostname(hostname) || 'nieujawnione';
        } catch (error) {
            return 'nieujawnione';
        }
    }

    function safeCandidateTitle(value, type, index, role = 'unknown') {
        const text = String(value || '').trim();
        if (!text || /^(?:https?|blob):/i.test(text)) {
            if (role === 'master') return `Master ${type} — automatyczna jakość`;
            if (role === 'variant') return `Wariant ${type} ${index + 1}`;
            if (role === 'audio') return `Ścieżka audio ${type}`;
            if (role === 'direct') return `Plik ${type} ${index + 1}`;
            return `Strumień ${type} ${index + 1}`;
        }
        return safeDiagnosticText(text).slice(0, 90) || `Strumień ${type} ${index + 1}`;
    }

    function safeShortText(value, fallback = '') {
        const text = safeDiagnosticText(value).trim();
        return text ? text.slice(0, 32) : fallback;
    }

    function safeDiagnosticText(value) {
        return String(value ?? '')
            .replace(/\b(?:https?|blob):\/\/[^\s]+/gi, '[adres ukryty]')
            .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s]*/gi, '[adres ukryty]')
            .replace(/([?&][A-Za-z0-9_.~-]+=)[^&\s]+/g, '$1[ukryto]')
            .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [ukryto]')
            .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[wartość ukryta]')
            .replace(/[\0\r\n]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .slice(0, 280);
    }

    function firstSafeText(...values) {
        for (const value of values) {
            if (typeof value === 'string' || typeof value === 'number') {
                const safe = safeDiagnosticText(value);
                if (safe) return safe;
            }
        }
        return '';
    }

    function firstString(...values) {
        for (const value of values) {
            if (typeof value === 'string' && value.trim()) return value;
            if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        }
        return '';
    }

    function firstBoolean(...values) {
        for (const value of values) {
            if (typeof value === 'boolean') return value;
        }
        return null;
    }

    function normalizeQuality(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 0 ? `${Math.round(value)}p` : '';
        }
        if (typeof value === 'string') return safeShortText(value);
        if (value && typeof value === 'object') {
            const width = Number(value.width);
            const height = Number(value.height);
            if (Number.isFinite(width) && Number.isFinite(height)) return `${width}×${height}`;
        }
        return '';
    }

    function formatScore(score) {
        const normalized = score >= 0 && score <= 1 ? score * 100 : score;
        return Math.max(0, Math.min(100, Math.round(normalized)));
    }

    function candidateCountLabel(count) {
        if (count === 1) return '1 źródło';
        if (usesPolishFewForm(count)) return `${count} źródła`;
        return `${count} źródeł`;
    }

    function filteredMediaLabel(count) {
        if (count === 1) return 'Pominięto 1 reklamę lub plik techniczny.';
        if (usesPolishFewForm(count)) return `Pominięto ${count} reklamy lub pliki techniczne.`;
        return `Pominięto ${count} reklam lub plików technicznych.`;
    }

    function failedMediaLabel(count) {
        const noun = usesPolishFewForm(count) ? 'wpisy' : 'wpisów';
        const countLabel = count === 1 ? 'Ukryto 1 wpis.' : `Ukryto ${count} ${noun}.`;
        return `Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle. ${countLabel}`;
    }

    function protectedMediaLabel(count) {
        if (count === 1) return 'Pominięto 1 chronione źródło.';
        if (count >= 2 && count <= 4) return `Pominięto ${count} chronione źródła.`;
        return `Pominięto ${count} chronionych źródeł.`;
    }

    function eventCountLabel(count) {
        if (count === 1) return '1 zdarzenie';
        if (count >= 2 && count <= 4) return `${count} zdarzenia`;
        return `${count} zdarzeń`;
    }

    function safeCode(value) {
        const code = String(value || 'ZDARZENIE').toUpperCase().replace(/[^A-Z0-9_.:-]+/g, '_');
        return code.slice(0, 44) || 'ZDARZENIE';
    }

    function eventHeading(code) {
        const preset = STATUS_COPY[code];
        if (preset) return preset.stage;
        const labels = {
            PLAY_CONFIRMED: 'MPV potwierdził',
            PLAY_FAILED: 'Otwarcie nieudane',
            SITE_AUTO_CHANGED: 'Zmieniono autostart',
            SITE_AUTO_FAILED: 'Błąd autostartu',
            QUALITY_ORDER_CHANGED: 'Zmieniono kolejność jakości',
            QUALITY_ORDER_FAILED: 'Błąd kolejności jakości',
            TAB_CLEARED: 'Wyczyszczono sesję',
            HEALTH_FAILED: 'Kontrola hosta',
            REFRESH_FAILED: 'Odświeżanie',
            RESOLVER_RUNNING: 'Rozpoznawanie strony',
            RESOLVER_FOUND: 'Resolver znalazł źródła',
            RESOLVER_EMPTY: 'Resolver bez wyniku',
            RESOLVER_UNAVAILABLE: 'Brak resolverów',
            RESOLVER_FAILED: 'Błąd resolvera',
            RESOLVER_COOKIES_ENABLED: 'Włączono sesję strony',
            RESOLVER_COOKIES_DISABLED: 'Wyłączono sesję strony'
        };
        return labels[code] || code.replace(/_/g, ' ').toLocaleLowerCase('pl-PL');
    }

    function eventTone(event) {
        const value = firstString(event?.level, event?.tone, event?.status, event?.code).toLowerCase();
        if (/error|fail|fatal|timeout/.test(value)) return 'error';
        if (/success|ok|opened|playing|confirmed|cleared/.test(value)) return 'success';
        return '';
    }

    function formatEventTime(value) {
        if (!value) return '';
        if (typeof value === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim())) return value.trim();
        const numeric = Number(value);
        const timestamp = Number.isFinite(numeric) && numeric > 0 && numeric < 1e12 ? numeric * 1000 : value;
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function friendlyError(error) {
        const code = String(error?.code || '').toUpperCase();
        const raw = firstString(error?.message, error, 'Nieznany błąd.');
        const lower = raw.toLowerCase();
        const hostCodeMessages = {
            MPV_NOT_FOUND: 'Nie znaleziono programu MPV w środowisku hosta lokalnego.',
            MPV_EXEC_FAILED: 'Host lokalny nie zdołał uruchomić procesu MPV.',
            EXEC_FAILED: 'Host lokalny nie zdołał uruchomić procesu MPV.',
            MPV_EXITED_EARLY: 'MPV zakończył działanie przed potwierdzeniem załadowania strumienia.',
            EXITED_EARLY: 'MPV zakończył działanie przed potwierdzeniem załadowania strumienia.',
            MPV_IPC_TIMEOUT: 'MPV nie odpowiedział przez kanał sterowania IPC w wymaganym czasie.',
            IPC_TIMEOUT: 'MPV nie odpowiedział przez kanał sterowania IPC w wymaganym czasie.',
            MPV_CONFIRM_TIMEOUT: 'Nie otrzymano potwierdzenia odtwarzania przed upływem limitu czasu.',
            CONFIRM_TIMEOUT: 'Nie otrzymano potwierdzenia odtwarzania przed upływem limitu czasu.',
            MPV_DEMUXER_TIMEOUT: 'MPV przyjął adres, ale nie zdołał otworzyć manifestu ani strumienia przed upływem limitu czasu.',
            MPV_LOAD_FAILED: 'MPV nie wczytał wybranego strumienia.',
            LOAD_FAILED: 'MPV nie wczytał wybranego strumienia.',
            MPV_IPC_REJECTED: 'MPV odrzucił polecenie przesłane przez kanał IPC.',
            IPC_REJECTED: 'MPV odrzucił polecenie przesłane przez kanał IPC.',
            MPV_IPC_PROTOCOL: 'MPV zwrócił nieprawidłową odpowiedź protokołu IPC.',
            MPV_QUEUE_BUSY: 'Kolejka MPV jest zajęta. Spróbuj ponownie za chwilę albo wybierz tryb „Nowe”.',
            QUEUE_BUSY: 'Kolejka MPV jest zajęta. Spróbuj ponownie za chwilę albo wybierz tryb „Nowe”.',
            MPV_QUEUE_UNRESPONSIVE: 'Działająca instancja MPV nie odpowiada. Wybierz tryb „Nowe” lub uruchom MPV ponownie.',
            QUEUE_UNRESPONSIVE: 'Działająca instancja MPV nie odpowiada. Wybierz tryb „Nowe” lub uruchom MPV ponownie.',
            MPV_UNRESPONSIVE: 'Działająca instancja MPV nie odpowiada. Wybierz tryb „Nowe” lub uruchom MPV ponownie.',
            UNRESPONSIVE: 'Działająca instancja MPV nie odpowiada. Wybierz tryb „Nowe” lub uruchom MPV ponownie.',
            RUNTIME_UNAVAILABLE: 'Środowisko uruchomieniowe hosta lokalnego jest niedostępne.',
            RUNTIME_INSECURE: 'Host lokalny odrzucił niebezpieczną konfigurację środowiska.',
            INSECURE: 'Host lokalny odrzucił niebezpieczną konfigurację środowiska.',
            INVALID_URL: 'Adres kandydata jest nieprawidłowy lub używa niedozwolonego protokołu.',
            INVALID_HEADER: 'Nagłówki kandydata są nieprawidłowe i nie zostały przekazane do MPV.',
            HOST_TOO_OLD: 'Host MPV jest nieaktualny. Uruchom instalator 3.4.8, a potem przeładuj rozszerzenie.',
            RESOLVER_BUSY: 'Inne rozpoznawanie strumieni jest już w toku.',
            RESOLVE_IN_PROGRESS: 'Rozpoznawanie tej karty już trwa.',
            RESOLVER_UNAVAILABLE: 'Nie znaleziono zgodnego Streamlink ani yt-dlp. Uruchom instalator z obsługą resolverów.',
            RESOLVER_TOO_OLD: 'Zainstalowany Streamlink lub yt-dlp wymaga aktualizacji do bezpiecznej wersji.',
            RESOLVER_EXEC_FAILED: 'Nie udało się bezpiecznie uruchomić resolvera.',
            RESOLVER_INVALID_OUTPUT: 'Resolver zwrócił niepoprawną odpowiedź; wynik został odrzucony.',
            RESOLVER_EXITED: 'Resolver zakończył pracę bez poprawnej listy strumieni.',
            RESOLVER_TIMEOUT: 'Resolver przekroczył bezpieczny limit czasu i został zatrzymany.',
            RESOLVER_OUTPUT_TOO_LARGE: 'Resolver zwrócił zbyt dużo danych; wynik został odrzucony.',
            RESOLVER_URL_FORBIDDEN: 'Ze względów bezpieczeństwa resolver nie analizuje lokalnych ani prywatnych adresów.',
            STREAM_URL_EXPIRED: 'Wybrane źródło wygasło i zostało ukryte. Wtyczka szuka świeżego adresu w tle.',
            STREAM_REFRESH_REQUESTED: 'Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle.',
            STREAM_REFRESHING: 'Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle.',
            STREAM_REFRESHED: 'Znaleziono świeże źródło i zaktualizowano listę.',
            STREAM_REFRESH_FAILED: 'Nie znaleziono jeszcze świeżego źródła. Wygasły lub odrzucony wpis pozostaje ukryty.',
            COOKIE_BUDGET_EXCEEDED: 'Cookies tej domeny przekraczają bezpieczny limit 64 rekordów lub 16 KiB.',
            COOKIE_PERMISSION_DENIED: 'Chrome nie przyznał opcjonalnego dostępu do cookies. Resolver może nadal działać bez sesji.',
            COOKIES_REQUIRE_HTTPS: 'Cookies resolvera można włączyć wyłącznie dla strony HTTPS.',
            STALE_TAB_SESSION: 'Karta zmieniła stronę podczas analizy. Spóźniony wynik został bezpiecznie odrzucony.',
            CLIPBOARD_UNAVAILABLE: 'Schowek jest niedostępny w tym kontekście Chrome. Otwórz popup ponownie i kliknij „Kopiuj” jeszcze raz.',
            CLIPBOARD_FAILED: 'Chrome nie pozwolił skopiować danych. Pozostaw popup otwarty, upewnij się, że ma fokus, i kliknij „Kopiuj” ponownie.'
        };

        if (hostCodeMessages[code]) return hostCodeMessages[code];
        if (/^STREAM_REFRESH/.test(code)) {
            return /FAIL|ERROR|REJECT/.test(code)
                ? 'Nie znaleziono jeszcze świeżego źródła. Wygasły lub odrzucony wpis pozostaje ukryty.'
                : 'Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle.';
        }

        if (code === 'REQUEST_TIMEOUT') return safeDiagnosticText(raw);
        if (code.includes('TIMEOUT') || lower.includes('timed out') || lower.includes('przekroczył')) {
            return 'Brak odpowiedzi przed upływem bezpiecznego limitu czasu. Żądanie przerwano, aby popup się nie zawiesił.';
        }
        if (lower.includes('receiving end does not exist') || lower.includes('could not establish connection')) {
            return 'Worker rozszerzenia nie odpowiada. Przeładuj rozszerzenie i odśwież stronę.';
        }
        if (lower.includes('native messaging host') && (lower.includes('not found') || lower.includes('specified'))) {
            return 'Nie znaleziono hosta Native Messaging. Sprawdź jego instalację dla tego profilu Chrome.';
        }
        if (lower.includes('forbidden') || lower.includes('not allowed')) {
            return 'Chrome odmówił dostępu do hosta lokalnego lub bieżącej strony.';
        }
        if (lower.includes('native host has exited') || lower.includes('host has exited')) {
            return 'Host lokalny zakończył pracę przed wysłaniem odpowiedzi.';
        }
        if (code.includes('CANDIDATE') || lower.includes('candidate')) {
            return 'Wybrane źródło wygasło lub nie jest już dostępne. Uruchom wideo ponownie.';
        }
        if (code.includes('PERMISSION') || lower.includes('permission')) {
            return 'Rozszerzenie nie ma uprawnienia do wykonania tej operacji.';
        }
        return safeDiagnosticText(raw) || 'Wystąpił nieznany błąd.';
    }

    function isHostError(error) {
        const value = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
        return /native|host_missing|host not found|host has exited|host niedost/.test(value);
    }

    function isMpvMissingError(error) {
        const value = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
        return /mpv_not_found|mpv not found|nie znaleziono programu mpv/.test(value);
    }
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TRANSIENT_NATIVE_HOST_ERROR_CODES,
        normalizeHostRecoveryStatusCode,
        isSupersededTransientNativeHostError,
        createRecoveredNativeHostView,
        resolverMethodLabel,
        resolverPlatformId,
        resolverPlatformLabel,
        resolverOrderCopy,
        usesPolishFewForm,
        candidateOriginLabels,
        resolverAttemptSummary,
        candidateMediaKindLabel,
        candidateLanguageLabel,
        mpvAlangValue,
        ytdlFormatValue,
        diagnosticSourceCountLabel,
        normalizeUserPriority,
        candidatePriorityMode,
        normalizeSourcePreferences,
        normalizeQualityOrder,
        resolveCandidateUrlVisibility,
        buildCandidatePriorityRequest,
        buildSourceUrlVisibilityRequest,
        buildQualityOrderRequest,
        normalizeCandidateExpiry,
        isExpiredCandidate,
        isRejectedCandidate,
        isReadyCandidate,
        chooseRecommendedCandidate,
        buildMpvCommand,
        buildLaunchScript,
        sendRuntimeRequest,
        DEFAULT_SOURCE_QUALITY_ORDER,
        REQUEST_TIMEOUT_MS,
        PLAY_REQUEST_TIMEOUT_MS
    };
}

(function pageMediaReaderScope() {
    'use strict';

    const MESSAGE_TYPE = 'PAGE_MEDIA_DISCOVERED';
    const PLATFORM_TARGETS_MESSAGE_TYPE = 'GET_PLATFORM_RESOLVER_TARGETS';
    const RESCAN_PAGE_MEDIA_MESSAGE_TYPE = 'RESCAN_PAGE_MEDIA';
    const MAX_MEDIA_ITEMS = 80;
    const MAX_URL_LENGTH = 16 * 1024;
    const MAX_JSON_LD_LENGTH = 1024 * 1024;
    const MAX_JSON_LD_NODES = 2_048;
    const MAX_JSON_LD_SOURCES = 64;
    const MAX_JSON_LD_TOTAL_LENGTH = 2 * 1024 * 1024;
    const MAX_PLATFORM_SCRIPT_BYTES = 1024 * 1024;
    const MAX_PLATFORM_SCRIPT_TOTAL_BYTES = 2 * 1024 * 1024;
    const MAX_PLATFORM_TARGETS = 4;
    const MAX_PLAYER_KEYS = 8;
    const MAX_PLAYER_KEY_INPUTS = 32;
    const MAX_PLAYER_KEY_LENGTH = 48;
    const MAX_TVP_VIDEO_OBJECT_CHARS = 128 * 1024;
    const MAX_TVP_VIDEO_JSON_DEPTH = 16;
    const MAX_TVP_VIDEO_ITEMS = 16;
    const MAX_TVP_VIDEO_OBJECTS_PER_SCRIPT = 16;
    const MAX_DOM_ELEMENTS_PER_SELECTOR = 2_048;
    const MAX_EMBEDDED_SOURCE_BYTES = 1024 * 1024;
    const MAX_EMBEDDED_TOTAL_BYTES = 2 * 1024 * 1024;
    const MAX_EMBEDDED_SOURCES = 96;
    const MAX_EMBEDDED_NODES = 4_096;
    const MAX_EMBEDDED_PROPERTIES_PER_OBJECT = 512;
    const MAX_EMBEDDED_LITERALS = 4_096;
    const MAX_EMBEDDED_RESULTS_PER_SOURCE = 64;
    const MAX_PERFORMANCE_ENTRIES = 512;
    const MAX_PERFORMANCE_TOTAL_URL_BYTES = 512 * 1024;
    const DEBOUNCE_MS = 300;
    const SNAPSHOT_RETRY_BASE_MS = 1_000;
    const MAX_SNAPSHOT_RETRIES = 5;
    const PAGE_READY_RESCAN_DELAYS_MS = [750, 2_500, 6_000];

    const DATA_ATTRIBUTE_NAMES = [
        'data-src',
        'data-url',
        'data-file',
        'data-source',
        'data-source-url',
        'data-hls',
        'data-hls-url',
        'data-dash',
        'data-dash-url',
        'data-stream',
        'data-stream-url',
        'data-video',
        'data-video-src',
        'data-video-url',
        'data-audio',
        'data-audio-src',
        'data-audio-url',
        'data-media',
        'data-media-src',
        'data-media-url',
        'data-playback-url',
        'data-manifest',
        'data-manifest-url',
        'data-playlist',
        'data-content-url',
        'data-m3u8',
        'data-mpd',
        'data-mp4',
        'data-webm'
    ];
    const STRONG_MEDIA_DATA_ATTRIBUTES = new Set([
        'data-hls',
        'data-hls-url',
        'data-dash',
        'data-dash-url',
        'data-stream',
        'data-stream-url',
        'data-video',
        'data-video-src',
        'data-video-url',
        'data-audio',
        'data-audio-src',
        'data-audio-url',
        'data-media',
        'data-media-src',
        'data-media-url',
        'data-playback-url',
        'data-manifest',
        'data-manifest-url',
        'data-playlist',
        'data-content-url',
        'data-source',
        'data-source-url',
        'data-m3u8',
        'data-mpd',
        'data-mp4',
        'data-webm'
    ]);
    const CONFIG_DATA_ATTRIBUTE_NAMES = [
        'data-config',
        'data-player-config',
        'data-video-config',
        'data-media-config',
        'data-setup',
        'data-options',
        'data-sources'
    ];
    const EMBEDDED_MEDIA_CONTAINER_KEYS = new Set([
        'audio',
        'dash',
        'files',
        'hls',
        'level',
        'levels',
        'media',
        'player',
        'playlist',
        'playlists',
        'progressive',
        'rendition',
        'renditions',
        'source',
        'sources',
        'stream',
        'streams',
        'urls',
        'variant',
        'variants',
        'video'
    ]);
    const EMBEDDED_STRONG_URL_KEYS = new Set([
        'audiourl',
        'audiouri',
        'contenturl',
        'dash',
        'dashmanifest',
        'dashurl',
        'hls',
        'hlsmanifest',
        'hlsurl',
        'manifest',
        'manifesturi',
        'manifesturl',
        'masterurl',
        'mediaurl',
        'mediauri',
        'playbackuri',
        'playbackurl',
        'playlisturl',
        'progressiveurl',
        'sourceurl',
        'stream',
        'streamuri',
        'streamurl',
        'videourl',
        'videouri'
    ]);
    const EMBEDDED_GENERIC_URL_KEYS = new Set(['file', 'src', 'source', 'uri', 'url']);
    const DATA_SELECTOR = DATA_ATTRIBUTE_NAMES.map((name) => `[${name}]`).join(',');
    const CONFIG_DATA_SELECTOR = CONFIG_DATA_ATTRIBUTE_NAMES.map((name) => `[${name}]`).join(',');
    const INLINE_SCRIPT_SELECTOR = 'script:not([src]):not([type="application/ld+json"])';
    const EXPLICIT_MEDIA_SELECTOR = [
        'meta[content]',
        'link[href]',
        'a[href*=".m3u8" i]',
        'a[href*=".mpd" i]',
        'a[href*=".mp4" i]',
        'a[href*=".webm" i]',
        'a[href*=".m4v" i]',
        'a[href*=".mov" i]',
        'a[href*=".ogg" i]',
        'a[href*=".mp3" i]',
        'a[href*=".m4a" i]',
        'a[href*=".aac" i]',
        'a[href*=".flac" i]',
        'a[href*=".wav" i]'
    ].join(',');
    const RELEVANT_SELECTOR = [
        'video,audio,source',
        'script[type="application/ld+json"]',
        INLINE_SCRIPT_SELECTOR,
        DATA_SELECTOR,
        CONFIG_DATA_SELECTOR,
        EXPLICIT_MEDIA_SELECTOR
    ].join(',');
    const OBSERVED_ATTRIBUTES = [
        'src',
        'href',
        'content',
        'type',
        'rel',
        'as',
        'property',
        'name',
        'itemprop',
        'label',
        'title',
        'aria-label',
        'data-quality',
        'data-resolution',
        ...DATA_ATTRIBUTE_NAMES,
        ...CONFIG_DATA_ATTRIBUTE_NAMES
    ];

    function normalizeHttpUrl(value, baseUrl) {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > MAX_URL_LENGTH) return '';

        try {
            const parsed = new URL(trimmed, baseUrl || undefined);
            if (!['http:', 'https:'].includes(parsed.protocol)) return '';
            if (!parsed.hostname || parsed.username || parsed.password) return '';
            return parsed.href;
        } catch (_error) {
            return '';
        }
    }

    function safePageUrl(value) {
        const normalized = normalizeHttpUrl(value);
        if (!normalized) return '';
        const parsed = new URL(normalized);
        parsed.search = '';
        parsed.hash = '';
        return parsed.href;
    }

    function normalizeTvpResolverTarget(value, pageUrl) {
        const normalizedPage = normalizeHttpUrl(pageUrl);
        const normalizedTarget = normalizeHttpUrl(value, normalizedPage);
        if (!normalizedPage || !normalizedTarget) return '';
        try {
            const page = new URL(normalizedPage);
            const target = new URL(normalizedTarget);
            const tvpHost = page.hostname === 'tvp.pl' || page.hostname.endsWith('.tvp.pl');
            if (!tvpHost || target.origin !== page.origin) return '';
            if (!/^\/\d{5,12}\/[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)*\/?$/.test(target.pathname)) return '';
            target.search = '';
            target.hash = '';
            if (target.href === safePageUrl(normalizedPage)) return '';
            return target.href;
        } catch (_error) {
            return '';
        }
    }

    function extractBoundedJsonObject(source, objectStart) {
        if (typeof source !== 'string' || source[objectStart] !== '{') return null;
        const stack = [];
        let inString = false;
        let escaped = false;
        const limit = Math.min(source.length, objectStart + MAX_TVP_VIDEO_OBJECT_CHARS);
        for (let index = objectStart; index < limit; index += 1) {
            const character = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === '"') {
                    inString = false;
                } else if (character.charCodeAt(0) < 0x20) {
                    return null;
                }
                continue;
            }
            if (character === '"') {
                inString = true;
                continue;
            }
            if (character === '{' || character === '[') {
                stack.push(character === '{' ? '}' : ']');
                if (stack.length > MAX_TVP_VIDEO_JSON_DEPTH) return null;
                continue;
            }
            if (character !== '}' && character !== ']') continue;
            if (!stack.length || stack.pop() !== character) return null;
            if (!stack.length) {
                return {
                    json: source.slice(objectStart, index + 1),
                    end: index + 1
                };
            }
        }
        return null;
    }

    function quotedStringEnd(source, stringStart, quote) {
        let escaped = false;
        for (let index = stringStart + 1; index < source.length; index += 1) {
            const character = source[index];
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === quote) {
                return index + 1;
            } else if (quote !== '`' && (character === '\n' || character === '\r')) {
                return -1;
            }
        }
        return -1;
    }

    function findNextTvpVideoObject(source, fromIndex) {
        let index = Math.max(0, fromIndex);
        while (index < source.length) {
            const character = source[index];
            if (character === '/' && source[index + 1] === '/') {
                const newline = source.indexOf('\n', index + 2);
                index = newline < 0 ? source.length : newline + 1;
                continue;
            }
            if (character === '/' && source[index + 1] === '*') {
                const commentEnd = source.indexOf('*/', index + 2);
                if (commentEnd < 0) return null;
                index = commentEnd + 2;
                continue;
            }
            if (character !== '"' && character !== "'" && character !== '`') {
                index += 1;
                continue;
            }
            const stringEnd = quotedStringEnd(source, index, character);
            if (stringEnd < 0) return null;
            if (character === '"' && source.slice(index, stringEnd) === '"video"') {
                let previous = index - 1;
                while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
                if (previous >= 0 && source[previous] !== '{' && source[previous] !== ',') {
                    index = stringEnd;
                    continue;
                }
                let cursor = stringEnd;
                while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
                if (source[cursor] !== ':') {
                    index = stringEnd;
                    continue;
                }
                cursor += 1;
                while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
                if (source[cursor] === '{') return { objectStart: cursor };
            }
            index = stringEnd;
        }
        return null;
    }

    function parseTvpVideoIds(source) {
        if (typeof source !== 'string' || !source) return [];
        const ids = [];
        let objectsSeen = 0;
        let cursor = 0;
        while (cursor < source.length) {
            if (objectsSeen >= MAX_TVP_VIDEO_OBJECTS_PER_SCRIPT) break;
            const located = findNextTvpVideoObject(source, cursor);
            if (!located) break;
            const { objectStart } = located;
            objectsSeen += 1;
            const extracted = extractBoundedJsonObject(source, objectStart);
            if (!extracted) break;
            cursor = extracted.end;
            let video;
            try {
                video = JSON.parse(extracted.json);
            } catch (_error) {
                continue;
            }
            if (!video || typeof video !== 'object' || Array.isArray(video) || !Array.isArray(video.items)) {
                continue;
            }
            for (const item of video.items.slice(0, MAX_TVP_VIDEO_ITEMS)) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
                const id = item._id;
                if (
                    !Number.isSafeInteger(id) ||
                    !/^\d{5,12}$/.test(String(id)) ||
                    item.type !== 'video' ||
                    item.playable !== true
                ) continue;
                ids.push(String(id));
                if (ids.length >= MAX_PLATFORM_TARGETS) return ids;
            }
        }
        return ids;
    }

    function extractTvpResolverTargets(rawScripts, pageUrl) {
        if (!Array.isArray(rawScripts) || !normalizeHttpUrl(pageUrl)) return [];
        const linkedTargets = new Set();
        const idTargets = new Set();
        let totalBytes = 0;
        for (const rawScript of rawScripts.slice(0, 128)) {
            if (typeof rawScript !== 'string' || !rawScript) continue;
            const scriptLength = rawScript.length;
            if (scriptLength > MAX_PLATFORM_SCRIPT_BYTES) continue;
            totalBytes += scriptLength;
            if (totalBytes > MAX_PLATFORM_SCRIPT_TOTAL_BYTES) break;
            const videoLinkPattern = /"video"\s*:\s*"((?:\\\/|\/)\d{5,12}(?:(?:\\\/|\/)[A-Za-z0-9._~%+-]+)+)"/g;
            for (const match of rawScript.matchAll(videoLinkPattern)) {
                const target = normalizeTvpResolverTarget(match[1].replaceAll('\\/', '/'), pageUrl);
                if (target) linkedTargets.add(target);
            }
            for (const id of parseTvpVideoIds(rawScript)) {
                const target = normalizeTvpResolverTarget(`/${id}/mpv-redirector`, pageUrl);
                if (target) idTargets.add(target);
            }
        }
        return [...linkedTargets, ...idTargets].slice(0, MAX_PLATFORM_TARGETS);
    }

    function readPlatformResolverTargets(documentRef) {
        const pageUrl = documentRef?.location?.href || documentRef?.baseURI || '';
        const scripts = queryElements(documentRef, 'script:not([src])').map((element) => {
            try {
                return typeof element?.textContent === 'string' ? element.textContent : '';
            } catch (_error) {
                return '';
            }
        });
        return extractTvpResolverTargets(scripts, pageUrl);
    }

    function sanitizeText(value, maxLength = 180) {
        if (typeof value !== 'string') return '';
        return value
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength);
    }

    function normalizeMimeType(value) {
        const normalized = sanitizeText(value, 120).toLowerCase();
        return normalized.split(';', 1)[0].trim();
    }

    function inferMediaType(url, mimeType = '') {
        const mime = normalizeMimeType(mimeType);
        if (mime.includes('mpegurl')) return 'HLS';
        if (mime === 'application/dash+xml') return 'DASH';
        if (mime === 'video/mp4' || mime === 'audio/mp4' || mime === 'application/mp4') return 'MP4';
        if (mime === 'video/webm' || mime === 'audio/webm' || mime === 'application/webm') return 'WEBM';

        const normalized = normalizeHttpUrl(url);
        if (!normalized) return 'MEDIA';
        const parsed = new URL(normalized);
        const pathname = parsed.pathname.toLowerCase();
        if (pathname.includes('.m3u8') || pathname.endsWith('.hls') || pathname.includes('.hls/')) return 'HLS';
        if (pathname.includes('.mpd')) return 'DASH';
        if (pathname.includes('.mp4')) return 'MP4';
        if (pathname.includes('.webm')) return 'WEBM';

        for (const [name, rawValue] of parsed.searchParams.entries()) {
            if (!/^(?:format|type|ext|extension|mime|content[-_]?type)$/i.test(name)) continue;
            const value = rawValue.toLowerCase();
            if (value.includes('m3u8') || value.includes('mpegurl') || value === 'hls') return 'HLS';
            if (value.includes('dash') || value.includes('mpd')) return 'DASH';
            if (value.includes('mp4')) return 'MP4';
            if (value.includes('webm')) return 'WEBM';
        }
        return 'MEDIA';
    }

    function looksLikeMediaUrl(value, baseUrl) {
        const normalized = normalizeHttpUrl(value, baseUrl);
        if (!normalized) return false;
        if (inferMediaType(normalized) !== 'MEDIA') return true;
        const pathname = new URL(normalized).pathname.toLowerCase();
        return /\.(?:m4v|mov|ogv|ogg|mp3|m4a|aac|flac|wav)(?:$|\/)/.test(pathname);
    }

    function looksLikeUrlReference(value) {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
        return /^(?:https?:)?\/\//i.test(trimmed) ||
            /^\.{0,2}\//.test(trimmed) ||
            /[/?#]/.test(trimmed) ||
            /\.(?:m3u8|mpd|mp4|webm|m4v|mov|ogv|ogg|mp3|m4a|aac|flac|wav)(?:[?#]|$)/i.test(trimmed);
    }

    function normalizeEmbeddedKey(value) {
        return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    }

    function isBlockedDiscoveryKey(value) {
        const key = normalizeEmbeddedKey(value);
        if (!key) return false;
        return /^(?:ad(?:s|breaks?|config|source|tag|url)?|advert(?:ising|isement|source|url)?|ima|preroll|midroll|postroll|vast|vpaid)(?:config|source|sources|url)?$/.test(key) ||
            /(?:analytics|beacon|drm|fairplay|license|playready|poster|telemetry|thumbnail|tracking|widevine)/.test(key) ||
            /^(?:(?:access|auth|refresh|session)?token(?:url)?|image|images|key|keyurl|logo|pixel)$/.test(key);
    }

    function isBlockedDiscoveryUrl(value, baseUrl) {
        const normalized = normalizeHttpUrl(value, baseUrl);
        if (!normalized) return true;
        try {
            const parsed = new URL(normalized);
            return /(?:^|[.-])(?:ads?|adserver|adservice|analytics|telemetry|tracking)(?:[.-]|$)/i.test(parsed.hostname) ||
                /(?:^|\/)(?:ads?|advert(?:ising|isement)?|analytics|beacon|drm|fairplay|license|midroll|playready|postroll|preroll|telemetry|tracking|vast|vpaid|widevine)(?:[\/._-]|$)/i.test(parsed.pathname) ||
                Array.from(parsed.searchParams.keys()).some((key) =>
                    /^(?:ad|ads|adtag|adurl|drm|license|midroll|postroll|preroll|tracking|vast|widevine)$/i.test(key)
                );
        } catch (_error) {
            return true;
        }
    }

    function isLikelyMediaSegmentUrl(value, baseUrl) {
        const normalized = normalizeHttpUrl(value, baseUrl);
        if (!normalized) return false;
        const pathname = new URL(normalized).pathname.toLowerCase();
        return /\.(?:cmfa|cmfv|m4s|ts)(?:$|\/)/.test(pathname) ||
            /(?:^|\/)(?:segment|segments|chunk|chunks|fragment|fragments)[\/_-]?\d+(?:\.[a-z0-9]+)?$/i.test(pathname);
    }

    function looksLikeOpaqueMediaEndpoint(value, baseUrl) {
        const normalized = normalizeHttpUrl(value, baseUrl);
        if (!normalized || isBlockedDiscoveryUrl(normalized)) return false;
        const parsed = new URL(normalized);
        const pathAndQueryNames = `${parsed.pathname} ${Array.from(parsed.searchParams.keys()).join(' ')}`;
        return /(?:^|[\/_.-])(?:dash|hls|manifest|master|media|playback|playlist|stream|video)(?:$|[\/_.-])/i.test(pathAndQueryNames);
    }

    function finitePositiveNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0 || number > maximum) return undefined;
        return number;
    }

    function parseIsoDuration(value) {
        if (typeof value !== 'string') return undefined;
        const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
        if (!match) return undefined;
        const seconds = (Number(match[1] || 0) * 86_400) +
            (Number(match[2] || 0) * 3_600) +
            (Number(match[3] || 0) * 60) +
            Number(match[4] || 0);
        return finitePositiveNumber(seconds, 31_536_000);
    }

    function readAttribute(element, name) {
        try {
            return typeof element?.getAttribute === 'function' ? element.getAttribute(name) || '' : '';
        } catch (_error) {
            return '';
        }
    }

    function readProperty(element, name) {
        try {
            const value = element?.[name];
            return typeof value === 'string' || typeof value === 'number' ? value : '';
        } catch (_error) {
            return '';
        }
    }

    function closestMediaElement(element) {
        const tagName = String(element?.tagName || '').toLowerCase();
        if (tagName === 'video' || tagName === 'audio') return element;
        try {
            return typeof element?.closest === 'function' ? element.closest('video,audio') : null;
        } catch (_error) {
            return null;
        }
    }

    function elementMetadata(element, documentRef) {
        const owner = closestMediaElement(element) || element;
        const ownerTag = String(owner?.tagName || '').toLowerCase();
        const width = finitePositiveNumber(readProperty(owner, 'videoWidth') || readAttribute(owner, 'width'), 32_768);
        const height = finitePositiveNumber(readProperty(owner, 'videoHeight') || readAttribute(owner, 'height'), 32_768);
        const duration = finitePositiveNumber(readProperty(owner, 'duration'), 31_536_000);
        const quality = sanitizeText(
            readAttribute(element, 'data-quality') ||
            readAttribute(element, 'data-resolution') ||
            readAttribute(element, 'label') ||
            readAttribute(element, 'res') ||
            (height ? `${Math.round(height)}p` : ''),
            80
        );
        const title = sanitizeText(
            readAttribute(element, 'title') ||
            readAttribute(element, 'aria-label') ||
            readAttribute(owner, 'title') ||
            readAttribute(owner, 'aria-label') ||
            readAttribute(owner, 'data-title') ||
            documentRef?.title || '',
            180
        );

        return {
            ...(title ? { title } : {}),
            ...(quality ? { quality } : {}),
            ...(duration ? { duration } : {}),
            ...(width ? { width: Math.round(width) } : {}),
            ...(height ? { height: Math.round(height) } : {}),
            ...(ownerTag === 'video' || ownerTag === 'audio' ? { kind: ownerTag } : {})
        };
    }

    function sourcePriority(source) {
        if (source === 'dom-current-src') return 7;
        if (source === 'dom-src' || source === 'performance-resource') return 6;
        if (source?.startsWith('data-') || source === 'inline-json' || source === 'inline-script') return 5;
        if (source === 'json-ld-content-url' || source === 'meta-content' || source === 'link-preload') return 4;
        return 3;
    }

    function mediaRecordRetentionScore(record) {
        const type = String(record?.type || '').toUpperCase();
        let score = sourcePriority(record?.source) * 100;
        if (type === 'HLS' || type === 'DASH') score += 30;
        else if (type && type !== 'MEDIA') score += 20;
        if (Array.isArray(record?.currentPlayerKeys) && record.currentPlayerKeys.length) score += 50;
        if (Number.isFinite(record?.height) || record?.quality) score += 10;
        return score;
    }

    function mergePlayerKeys(...values) {
        const keys = [];
        let inputsSeen = 0;
        for (const value of values) {
            if (!Array.isArray(value)) continue;
            for (const rawKey of value) {
                inputsSeen += 1;
                if (inputsSeen > MAX_PLAYER_KEY_INPUTS) return keys;
                if (typeof rawKey !== 'string') continue;
                const key = rawKey.trim();
                if (
                    !key ||
                    key.length > MAX_PLAYER_KEY_LENGTH ||
                    !/^[A-Za-z0-9_-]+$/.test(key) ||
                    keys.includes(key)
                ) continue;
                keys.push(key);
                if (keys.length >= MAX_PLAYER_KEYS) return keys;
            }
        }
        return keys;
    }

    function buildMediaRecord(rawRecord, baseUrl) {
        const url = normalizeHttpUrl(rawRecord?.url, baseUrl);
        if (!url) return null;
        const mimeType = normalizeMimeType(rawRecord?.mimeType || '');
        const source = sanitizeText(rawRecord?.source || 'page', 64);
        const inferredType = inferMediaType(url, mimeType);
        const type = inferredType !== 'MEDIA'
            ? inferredType
            : (/^data-(?:hls|hls-url|m3u8)$/.test(source)
                ? 'HLS'
                : (/^data-(?:dash|dash-url|mpd)$/.test(source) ? 'DASH' : 'MEDIA'));
        const title = sanitizeText(rawRecord?.title || '', 180);
        const quality = sanitizeText(rawRecord?.quality || '', 80);
        const kind = ['video', 'audio'].includes(rawRecord?.kind) ? rawRecord.kind : '';
        const duration = finitePositiveNumber(rawRecord?.duration, 31_536_000);
        const width = finitePositiveNumber(rawRecord?.width, 32_768);
        const height = finitePositiveNumber(rawRecord?.height, 32_768);
        const currentPlayerKeys = mergePlayerKeys(rawRecord?.currentPlayerKeys);
        const playerKeys = mergePlayerKeys(currentPlayerKeys, rawRecord?.playerKeys);

        return {
            url,
            type,
            source,
            ...(title ? { title } : {}),
            ...(quality ? { quality } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(kind ? { kind } : {}),
            ...(duration ? { duration } : {}),
            ...(width ? { width: Math.round(width) } : {}),
            ...(height ? { height: Math.round(height) } : {}),
            ...(playerKeys.length ? { playerKeys } : {}),
            ...(currentPlayerKeys.length ? { currentPlayerKeys } : {})
        };
    }

    function mergeMediaRecord(mediaByUrl, rawRecord, baseUrl) {
        const record = buildMediaRecord(rawRecord, baseUrl);
        if (!record) return false;
        const current = mediaByUrl.get(record.url);
        if (!current) {
            if (mediaByUrl.size >= MAX_MEDIA_ITEMS) {
                let weakestUrl = '';
                let weakestScore = Number.POSITIVE_INFINITY;
                for (const [existingUrl, existing] of mediaByUrl) {
                    const score = mediaRecordRetentionScore(existing);
                    if (score < weakestScore) {
                        weakestUrl = existingUrl;
                        weakestScore = score;
                    }
                }
                if (!weakestUrl || mediaRecordRetentionScore(record) <= weakestScore) return false;
                mediaByUrl.delete(weakestUrl);
            }
            mediaByUrl.set(record.url, record);
            return true;
        }

        const merged = { ...current };
        for (const key of ['title', 'quality', 'mimeType', 'kind', 'duration', 'width', 'height']) {
            if ((merged[key] === undefined || merged[key] === '') && record[key] !== undefined) merged[key] = record[key];
        }
        const currentPlayerKeys = mergePlayerKeys(record.currentPlayerKeys, current.currentPlayerKeys);
        const playerKeys = mergePlayerKeys(currentPlayerKeys, record.playerKeys, current.playerKeys);
        if (playerKeys.length) merged.playerKeys = playerKeys;
        else delete merged.playerKeys;
        if (currentPlayerKeys.length) merged.currentPlayerKeys = currentPlayerKeys;
        else delete merged.currentPlayerKeys;
        if (sourcePriority(record.source) > sourcePriority(current.source)) merged.source = record.source;
        if (current.type === 'MEDIA' && record.type !== 'MEDIA') merged.type = record.type;

        const changed = JSON.stringify(merged) !== JSON.stringify(current);
        if (changed) mediaByUrl.set(record.url, merged);
        return changed;
    }

    function embeddedObjectMetadata(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const mimeType = normalizeMimeType(
            typeof value.mimeType === 'string' ? value.mimeType :
                (typeof value.contentType === 'string' ? value.contentType :
                    (typeof value.encodingFormat === 'string' ? value.encodingFormat :
                        (typeof value.type === 'string' && value.type.includes('/') ? value.type : '')))
        );
        const quality = sanitizeText(value.quality || value.label || value.resolution || value.videoQuality || '', 80);
        const title = sanitizeText(value.title || value.name || '', 180);
        const width = finitePositiveNumber(value.width, 32_768);
        const height = finitePositiveNumber(value.height, 32_768);
        const duration = typeof value.duration === 'string'
            ? parseIsoDuration(value.duration)
            : finitePositiveNumber(value.duration, 31_536_000);
        const kindValue = sanitizeText(value.kind || value.mediaType || '', 24).toLowerCase();
        const kind = kindValue.includes('audio') ? 'audio' : (kindValue.includes('video') ? 'video' : '');
        return {
            ...(title ? { title } : {}),
            ...(quality ? { quality } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(kind ? { kind } : {}),
            ...(duration ? { duration } : {}),
            ...(width ? { width: Math.round(width) } : {}),
            ...(height ? { height: Math.round(height) } : {})
        };
    }

    function boundedOwnEntries(value, maximum = MAX_EMBEDDED_PROPERTIES_PER_OBJECT) {
        const entries = [];
        if (!value || typeof value !== 'object') return entries;
        let relevantOverflow = 0;
        for (const key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            if (entries.length < maximum) {
                entries.push([key, value[key]]);
                continue;
            }
            const normalizedKey = normalizeEmbeddedKey(key);
            const relevant = EMBEDDED_MEDIA_CONTAINER_KEYS.has(normalizedKey) ||
                EMBEDDED_STRONG_URL_KEYS.has(normalizedKey) ||
                EMBEDDED_GENERIC_URL_KEYS.has(normalizedKey) ||
                isBlockedDiscoveryKey(normalizedKey);
            if (relevant && relevantOverflow < 128) {
                entries.push([key, value[key]]);
                relevantOverflow += 1;
            }
        }
        return entries;
    }

    function objectSuggestsMedia(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const metadata = embeddedObjectMetadata(value);
        if (metadata.mimeType && /(?:audio|video|mpegurl|dash|mp4|webm)/i.test(metadata.mimeType)) return true;
        return boundedOwnEntries(value).some(([key, child]) =>
            EMBEDDED_MEDIA_CONTAINER_KEYS.has(normalizeEmbeddedKey(key)) &&
            (typeof child === 'string' || (child !== null && typeof child === 'object'))
        );
    }

    function objectIsBlockedMediaEntry(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (value.isAd === true || value.ad === true || value.advertisement === true) return true;
        return ['kind', 'mediaRole', 'role', 'type'].some((key) =>
            typeof value[key] === 'string' &&
            /^(?:ad|advert|advertisement|midroll|postroll|preroll|promo|vast|vpaid)$/i.test(value[key].trim())
        );
    }

    function addEmbeddedMediaRecord(results, rawRecord, baseUrl) {
        if (results.size >= MAX_EMBEDDED_RESULTS_PER_SOURCE) return false;
        const normalized = normalizeHttpUrl(rawRecord?.url, baseUrl);
        if (
            !normalized ||
            isBlockedDiscoveryUrl(normalized) ||
            isLikelyMediaSegmentUrl(normalized)
        ) return false;
        return mergeMediaRecord(results, { ...rawRecord, url: normalized }, baseUrl);
    }

    function extractStructuredEmbeddedMedia(root, baseUrl, source, assumeMediaContext = false) {
        const results = new Map();
        const stack = [{
            value: root,
            mediaContext: Boolean(assumeMediaContext),
            blocked: false,
            depth: 0
        }];
        let visited = 0;

        while (stack.length && visited < MAX_EMBEDDED_NODES && results.size < MAX_EMBEDDED_RESULTS_PER_SOURCE) {
            const item = stack.pop();
            visited += 1;
            if (!item || item.blocked || item.depth > 24 || item.value === null) continue;

            if (typeof item.value === 'string') {
                if (
                    (looksLikeMediaUrl(item.value, baseUrl) || (item.mediaContext && looksLikeUrlReference(item.value))) &&
                    !isBlockedDiscoveryUrl(item.value, baseUrl)
                ) {
                    addEmbeddedMediaRecord(results, { url: item.value, source }, baseUrl);
                }
                continue;
            }
            if (typeof item.value !== 'object') continue;

            if (Array.isArray(item.value)) {
                for (let index = Math.min(item.value.length, 256) - 1; index >= 0; index -= 1) {
                    stack.push({
                        value: item.value[index],
                        mediaContext: item.mediaContext,
                        blocked: item.blocked,
                        depth: item.depth + 1
                    });
                }
                continue;
            }

            const node = item.value;
            if (objectIsBlockedMediaEntry(node)) continue;
            const nodeMediaContext = item.mediaContext || objectSuggestsMedia(node);
            const metadata = embeddedObjectMetadata(node);
            const childItems = [];
            for (const [rawKey, child] of boundedOwnEntries(node)) {
                if (results.size >= MAX_EMBEDDED_RESULTS_PER_SOURCE) break;
                const key = normalizeEmbeddedKey(rawKey);
                const blocked = item.blocked || isBlockedDiscoveryKey(key);
                if (blocked || child === null) continue;
                const childMediaContext = item.mediaContext || EMBEDDED_MEDIA_CONTAINER_KEYS.has(key);

                if (typeof child === 'string') {
                    const directlyMedia = looksLikeMediaUrl(child, baseUrl);
                    const stronglyNamed = EMBEDDED_STRONG_URL_KEYS.has(key);
                    const genericallyNamed = EMBEDDED_GENERIC_URL_KEYS.has(key);
                    if (
                        !directlyMedia &&
                        !(looksLikeUrlReference(child) && (stronglyNamed || (genericallyNamed && nodeMediaContext)))
                    ) continue;
                    addEmbeddedMediaRecord(results, {
                        url: child,
                        source,
                        ...metadata,
                        ...(/^audio/.test(key) ? { kind: 'audio' } : {}),
                        ...(/^video/.test(key) ? { kind: 'video' } : {})
                    }, baseUrl);
                    continue;
                }

                if (typeof child === 'object') {
                    childItems.push({
                        value: child,
                        mediaContext: childMediaContext,
                        blocked,
                        depth: item.depth + 1,
                        priority: childMediaContext || objectSuggestsMedia(child) ? 1 : 0
                    });
                }
            }
            childItems.sort((left, right) => left.priority - right.priority);
            for (const childItem of childItems) {
                delete childItem.priority;
                stack.push(childItem);
            }
        }
        return Array.from(results.values());
    }

    function decodeEmbeddedLiteral(value) {
        if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH * 2) return '';
        if (/\$\{|<%|\{\{/.test(value) || /\\(?:b|f|n|r|t|v|0)/.test(value)) return '';
        return value
            .replace(/\\u003a/gi, ':')
            .replace(/\\x3a/gi, ':')
            .replace(/\\u003f/gi, '?')
            .replace(/\\x3f/gi, '?')
            .replace(/\\u003d/gi, '=')
            .replace(/\\x3d/gi, '=')
            .replace(/\\u002f/gi, '/')
            .replace(/\\x2f/gi, '/')
            .replace(/\\u0023/gi, '#')
            .replace(/\\x23/gi, '#')
            .replace(/\\u0026/gi, '&')
            .replace(/\\x26/gi, '&')
            .replace(/\\u0025/gi, '%')
            .replace(/\\x25/gi, '%')
            .replace(/\\\//g, '/')
            .replace(/\\(["'`\\])/g, '$1')
            .replace(/&amp;/gi, '&')
            .trim();
    }

    function precedingEmbeddedKey(source, valueStart) {
        const prefix = source.slice(Math.max(0, valueStart - 120), valueStart);
        const match = /(?:["']([A-Za-z0-9_$.-]{1,64})["']|([A-Za-z_$][A-Za-z0-9_$.-]{0,63}))\s*[:=]\s*$/.exec(prefix);
        return normalizeEmbeddedKey(match?.[1] || match?.[2] || '');
    }

    function lexicalContextSuggestsMedia(source, valueStart, assumeMediaContext) {
        if (assumeMediaContext) return true;
        const prefix = source.slice(Math.max(0, valueStart - 240), valueStart);
        return /(?:^|[^a-z0-9])(?:audio|dash|file|hls|level|manifest|media|playback|player|playlist|progressive|rendition|source|stream|url|variant|video)s?(?:[^a-z0-9]|$)/i.test(prefix);
    }

    function lexicalContextIsBlocked(source, valueStart, key) {
        if (isBlockedDiscoveryKey(key)) return true;
        const prefix = source.slice(Math.max(0, valueStart - 420), valueStart);
        return /(?:^|[^a-z0-9])(?:ad(?:s|breaks?|config|source|tag|url)?|advert(?:ising|isement)?|ima|preroll|midroll|postroll|vast|vpaid|drm|fairplay|license|playready|tracking|widevine)(?:[^a-z0-9]|$)\s*[:=]\s*[\[{][^}\]]{0,360}$/i.test(prefix) ||
            /(?:^|[^a-z0-9])(?:ad|advertisement|isad)\s*[:=]\s*true(?:[^a-z0-9]|$)[^{}]{0,180}$/i.test(prefix) ||
            /(?:^|[^a-z0-9])(?:kind|mediarole|role|type)\s*[:=]\s*["'](?:ad|advert|advertisement|midroll|postroll|preroll|promo|vast|vpaid)["'][^{}]{0,180}$/i.test(prefix);
    }

    function lexicalLiteralMetadata(source, valueStart, valueEnd) {
        let contextStart = source.lastIndexOf('{', valueStart);
        let contextEnd = source.indexOf('}', valueEnd);
        if (contextStart < 0 || valueStart - contextStart > 240) contextStart = Math.max(0, valueStart - 80);
        if (contextEnd < 0 || contextEnd - valueEnd > 240) contextEnd = Math.min(source.length, valueEnd + 80);
        const context = source.slice(contextStart, contextEnd + 1);
        const sameObjectMatch = (pattern) => {
            const match = pattern.exec(context);
            if (!match) return null;
            const absoluteMatchStart = contextStart + match.index;
            const between = absoluteMatchStart < valueStart
                ? source.slice(absoluteMatchStart + match[0].length, valueStart)
                : source.slice(valueEnd, absoluteMatchStart);
            return /[{}]/.test(between) ? null : match;
        };
        const qualityMatch = sameObjectMatch(/(?:label|quality|resolution)\s*[:=]\s*["']([^"'\r\n]{1,40})["']/i);
        const heightMatch = sameObjectMatch(/(?:height)\s*[:=]\s*(\d{3,5})(?!\d)/i);
        const widthMatch = sameObjectMatch(/(?:width)\s*[:=]\s*(\d{3,5})(?!\d)/i);
        const height = finitePositiveNumber(heightMatch?.[1], 32_768);
        const width = finitePositiveNumber(widthMatch?.[1], 32_768);
        return {
            ...(qualityMatch?.[1] ? { quality: sanitizeText(qualityMatch[1], 80) } : {}),
            ...(height ? { height: Math.round(height) } : {}),
            ...(width ? { width: Math.round(width) } : {})
        };
    }

    function extractLexicalEmbeddedMedia(rawSource, baseUrl, source, assumeMediaContext = false) {
        const results = new Map();
        let index = 0;
        let literalsSeen = 0;
        while (index < rawSource.length && results.size < MAX_EMBEDDED_RESULTS_PER_SOURCE) {
            const character = rawSource[index];
            if (character === '/' && rawSource[index + 1] === '/') {
                const newline = rawSource.indexOf('\n', index + 2);
                index = newline < 0 ? rawSource.length : newline + 1;
                continue;
            }
            if (character === '/' && rawSource[index + 1] === '*') {
                const commentEnd = rawSource.indexOf('*/', index + 2);
                index = commentEnd < 0 ? rawSource.length : commentEnd + 2;
                continue;
            }
            if (character !== '"' && character !== "'" && character !== '`') {
                index += 1;
                continue;
            }

            literalsSeen += 1;
            if (literalsSeen > MAX_EMBEDDED_LITERALS) break;

            const stringEnd = quotedStringEnd(rawSource, index, character);
            if (stringEnd < 0) break;
            const decoded = decodeEmbeddedLiteral(rawSource.slice(index + 1, stringEnd - 1));
            const key = precedingEmbeddedKey(rawSource, index);
            const contextSuggestsMedia = lexicalContextSuggestsMedia(rawSource, index, assumeMediaContext);
            const acceptable = looksLikeMediaUrl(decoded, baseUrl) || (
                looksLikeUrlReference(decoded) && (
                    EMBEDDED_STRONG_URL_KEYS.has(key) ||
                    (
                        EMBEDDED_GENERIC_URL_KEYS.has(key) &&
                        contextSuggestsMedia &&
                        looksLikeOpaqueMediaEndpoint(decoded, baseUrl)
                    )
                )
            );
            if (
                acceptable &&
                !lexicalContextIsBlocked(rawSource, index, key) &&
                !isBlockedDiscoveryUrl(decoded, baseUrl)
            ) {
                addEmbeddedMediaRecord(results, {
                    url: decoded,
                    source,
                    ...lexicalLiteralMetadata(rawSource, index, stringEnd),
                    ...(/^audio/.test(key) ? { kind: 'audio' } : {}),
                    ...(/^video/.test(key) ? { kind: 'video' } : {})
                }, baseUrl);
            }
            index = stringEnd;
        }
        return Array.from(results.values());
    }

    function extractEmbeddedMedia(rawSource, baseUrl, source = 'inline-script', assumeMediaContext = false) {
        if (
            typeof rawSource !== 'string' ||
            !rawSource.trim() ||
            rawSource.length > MAX_EMBEDDED_SOURCE_BYTES
        ) return [];
        try {
            const parsed = JSON.parse(rawSource);
            return extractStructuredEmbeddedMedia(parsed, baseUrl, source, assumeMediaContext);
        } catch (_error) {
            return extractLexicalEmbeddedMedia(rawSource, baseUrl, source, assumeMediaContext);
        }
    }

    function scanMediaElement(element, mediaByUrl, documentRef, baseUrl, playerKeyFor) {
        const tagName = String(element?.tagName || '').toLowerCase();
        const owner = closestMediaElement(element);
        if (tagName === 'source' && !owner) {
            const sourceType = normalizeMimeType(readAttribute(element, 'type'));
            const sourceValue = readProperty(element, 'src') || readAttribute(element, 'src');
            if (!sourceType.startsWith('video/') && !sourceType.startsWith('audio/') && !looksLikeMediaUrl(sourceValue, baseUrl)) return;
        }

        const mimeType = readAttribute(element, 'type') || readAttribute(owner, 'type');
        const metadata = elementMetadata(element, documentRef);
        const playerKey = typeof playerKeyFor === 'function' && owner ? playerKeyFor(owner) : '';
        const currentSrc = readProperty(element, 'currentSrc') || readProperty(owner, 'currentSrc');
        if (normalizeHttpUrl(currentSrc, baseUrl)) {
            mergeMediaRecord(mediaByUrl, {
                url: currentSrc,
                mimeType,
                source: 'dom-current-src',
                ...(playerKey ? { playerKeys: [playerKey], currentPlayerKeys: [playerKey] } : {}),
                ...metadata
            }, baseUrl);
        }

        const src = readProperty(element, 'src') || readAttribute(element, 'src');
        if (src) {
            mergeMediaRecord(mediaByUrl, {
                url: src,
                mimeType,
                source: 'dom-src',
                ...(playerKey ? { playerKeys: [playerKey] } : {}),
                ...metadata
            }, baseUrl);
        }
    }

    function isMediaDataAttribute(name) {
        return typeof name === 'string' && DATA_ATTRIBUTE_NAMES.includes(name.toLowerCase());
    }

    function scanDataAttributes(element, mediaByUrl, documentRef, baseUrl, playerKeyFor) {
        const tagName = String(element?.tagName || '').toLowerCase();
        const owner = closestMediaElement(element);
        const mediaContext = tagName === 'video' || tagName === 'audio' || tagName === 'source' || Boolean(owner);
        const metadata = elementMetadata(element, documentRef);
        const playerKey = typeof playerKeyFor === 'function' && owner ? playerKeyFor(owner) : '';

        for (const attributeName of DATA_ATTRIBUTE_NAMES) {
            const value = readAttribute(element, attributeName);
            if (!value) continue;
            if (!mediaContext && !STRONG_MEDIA_DATA_ATTRIBUTES.has(attributeName) && !looksLikeMediaUrl(value, baseUrl)) continue;
            if (
                STRONG_MEDIA_DATA_ATTRIBUTES.has(attributeName) &&
                !looksLikeUrlReference(value)
            ) continue;
            mergeMediaRecord(mediaByUrl, {
                url: value,
                mimeType: readAttribute(element, 'type'),
                source: attributeName,
                ...metadata,
                kind: /^data-video(?:-src|-url)?$/.test(attributeName)
                    ? 'video'
                    : (/^data-audio(?:-src|-url)?$/.test(attributeName) ? 'audio' : metadata.kind),
                ...(playerKey ? { playerKeys: [playerKey] } : {})
            }, baseUrl);
        }
    }

    function scanConfigDataAttributes(element, mediaByUrl, baseUrl, maxBytes = MAX_EMBEDDED_TOTAL_BYTES) {
        let consumedBytes = 0;
        for (const attributeName of CONFIG_DATA_ATTRIBUTE_NAMES) {
            const rawConfig = readAttribute(element, attributeName);
            if (!rawConfig || rawConfig.length > MAX_EMBEDDED_SOURCE_BYTES) continue;
            if (consumedBytes + rawConfig.length > maxBytes) break;
            consumedBytes += rawConfig.length;
            const assumesMedia = /(?:player|video|media|sources)/.test(attributeName);
            for (const record of extractEmbeddedMedia(rawConfig, baseUrl, attributeName, assumesMedia)) {
                mergeMediaRecord(mediaByUrl, record, baseUrl);
            }
        }
        return consumedBytes;
    }

    function scanInlineScriptElement(element, mediaByUrl, baseUrl) {
        const scriptType = normalizeMimeType(readAttribute(element, 'type'));
        if (scriptType === 'application/ld+json') return 0;
        let rawSource = '';
        try {
            rawSource = typeof element?.textContent === 'string' ? element.textContent : '';
        } catch (_error) {
            return 0;
        }
        if (!rawSource || rawSource.length > MAX_EMBEDDED_SOURCE_BYTES) return 0;
        const source = /(?:application|text)\/(?:json|.+\+json)/i.test(scriptType)
            ? 'inline-json'
            : 'inline-script';
        for (const record of extractEmbeddedMedia(rawSource, baseUrl, source, false)) {
            mergeMediaRecord(mediaByUrl, record, baseUrl);
        }
        return rawSource.length;
    }

    function scanExplicitMediaElement(element, mediaByUrl, documentRef, baseUrl) {
        const tagName = String(element?.tagName || '').toLowerCase();
        const metadata = elementMetadata(element, documentRef);
        if (tagName === 'meta') {
            const field = sanitizeText(
                readAttribute(element, 'property') ||
                readAttribute(element, 'name') ||
                readAttribute(element, 'itemprop'),
                80
            ).toLowerCase();
            const value = readAttribute(element, 'content');
            const streamField = field === 'twitter:player:stream';
            const mediaField = streamField || /^(?:og:)(?:audio|video)(?::(?:secure_url|url))?$/.test(field) ||
                field === 'contenturl';
            if (
                mediaField &&
                (looksLikeMediaUrl(value, baseUrl) || (streamField && looksLikeUrlReference(value))) &&
                !isBlockedDiscoveryUrl(value, baseUrl)
            ) {
                mergeMediaRecord(mediaByUrl, {
                    url: value,
                    source: 'meta-content',
                    kind: field.includes('audio') ? 'audio' : 'video',
                    ...metadata
                }, baseUrl);
            }
            return;
        }

        const href = readProperty(element, 'href') || readAttribute(element, 'href');
        if (!href || isBlockedDiscoveryUrl(href, baseUrl)) return;
        if (tagName === 'link') {
            const mimeType = normalizeMimeType(readAttribute(element, 'type'));
            const rel = sanitizeText(readAttribute(element, 'rel'), 80).toLowerCase().split(/\s+/);
            const as = sanitizeText(readAttribute(element, 'as'), 32).toLowerCase();
            const explicitlyMedia = ['audio', 'video'].includes(as) ||
                /(?:audio|video|mpegurl|dash|mp4|webm)/i.test(mimeType);
            if (!looksLikeMediaUrl(href, baseUrl) && !(explicitlyMedia && looksLikeUrlReference(href))) return;
            mergeMediaRecord(mediaByUrl, {
                url: href,
                mimeType,
                source: rel.includes('preload') ? 'link-preload' : 'link-media',
                ...(['audio', 'video'].includes(as) ? { kind: as } : {}),
                ...metadata
            }, baseUrl);
            return;
        }

        if (tagName === 'a' && looksLikeMediaUrl(href, baseUrl)) {
            mergeMediaRecord(mediaByUrl, {
                url: href,
                source: 'media-link',
                ...metadata
            }, baseUrl);
        }
    }

    function jsonLdTypes(value) {
        const list = Array.isArray(value) ? value : [value];
        return list
            .filter((item) => typeof item === 'string')
            .map((item) => item.toLowerCase());
    }

    function isMediaJsonLdObject(value) {
        return jsonLdTypes(value?.['@type']).some((type) =>
            /(?:video|audio|media|movie|episode|clip|broadcast|podcast|musicrecording)/.test(type)
        );
    }

    function jsonLdContentUrls(value) {
        if (typeof value === 'string') return [value];
        if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
        return [];
    }

    function extractJsonLdMedia(rawJson, baseUrl) {
        if (typeof rawJson !== 'string' || !rawJson.trim() || rawJson.length > MAX_JSON_LD_LENGTH) return [];
        let root;
        try {
            root = JSON.parse(rawJson);
        } catch (_error) {
            return [];
        }

        const results = new Map();
        const stack = [{ value: root, mediaContext: false, depth: 0 }];
        let visited = 0;
        while (stack.length && visited < MAX_JSON_LD_NODES) {
            const item = stack.pop();
            visited += 1;
            if (!item || item.depth > 24 || item.value === null || typeof item.value !== 'object') continue;

            if (Array.isArray(item.value)) {
                for (let index = Math.min(item.value.length, 256) - 1; index >= 0; index -= 1) {
                    stack.push({ value: item.value[index], mediaContext: item.mediaContext, depth: item.depth + 1 });
                }
                continue;
            }

            const node = item.value;
            const mediaContext = item.mediaContext || isMediaJsonLdObject(node);
            const mimeType = typeof node.encodingFormat === 'string' ? node.encodingFormat : '';
            const formatSuggestsMedia = /(?:video|audio|mpegurl|dash|mp4|webm)/i.test(mimeType);
            const duration = typeof node.duration === 'number'
                ? finitePositiveNumber(node.duration, 31_536_000)
                : parseIsoDuration(node.duration);
            const title = sanitizeText(node.name || node.headline || node.caption || '', 180);
            const quality = sanitizeText(node.videoQuality || '', 80);
            const width = finitePositiveNumber(node.width, 32_768);
            const height = finitePositiveNumber(node.height, 32_768);

            for (const contentUrl of jsonLdContentUrls(node.contentUrl)) {
                if (!mediaContext && !formatSuggestsMedia && !looksLikeMediaUrl(contentUrl, baseUrl)) continue;
                mergeMediaRecord(results, {
                    url: contentUrl,
                    mimeType,
                    source: 'json-ld-content-url',
                    title,
                    quality,
                    duration,
                    width,
                    height,
                    kind: jsonLdTypes(node['@type']).some((type) => type.includes('audio')) ? 'audio' : 'video'
                }, baseUrl);
            }

            for (const [key, child] of Object.entries(node)) {
                if (key === 'contentUrl' || child === null || typeof child !== 'object') continue;
                stack.push({ value: child, mediaContext, depth: item.depth + 1 });
            }
        }
        return Array.from(results.values());
    }

    function scanJsonLdElement(element, mediaByUrl, baseUrl) {
        let rawJson = '';
        try {
            rawJson = typeof element?.textContent === 'string' ? element.textContent : '';
        } catch (_error) {
            return;
        }
        for (const record of extractJsonLdMedia(rawJson, baseUrl)) {
            mergeMediaRecord(mediaByUrl, record, baseUrl);
        }
    }

    function performanceEntryMediaRecord(entry, baseUrl) {
        const url = normalizeHttpUrl(typeof entry?.name === 'string' ? entry.name : '', baseUrl);
        if (
            !url ||
            isBlockedDiscoveryUrl(url) ||
            isLikelyMediaSegmentUrl(url)
        ) return null;
        const initiatorType = sanitizeText(entry?.initiatorType || '', 40).toLowerCase();
        const mimeType = normalizeMimeType(entry?.contentType || entry?.mimeType || '');
        const mediaMime = /^(?:audio|video)\//.test(mimeType) ||
            /(?:mpegurl|dash\+xml|application\/(?:mp4|webm))/.test(mimeType);
        const directMedia = looksLikeMediaUrl(url);
        const mediaInitiator = initiatorType === 'video' || initiatorType === 'audio';
        const fetchLikeInitiator = ['fetch', 'xmlhttprequest', 'other', 'link'].includes(initiatorType);
        if (!directMedia && !mediaMime && !mediaInitiator && !(fetchLikeInitiator && looksLikeOpaqueMediaEndpoint(url))) {
            return null;
        }
        const kind = initiatorType === 'audio' || mimeType.startsWith('audio/')
            ? 'audio'
            : (initiatorType === 'video' || mimeType.startsWith('video/') ? 'video' : '');
        return {
            url,
            mimeType,
            source: 'performance-resource',
            ...(kind ? { kind } : {})
        };
    }

    function scanPerformanceEntries(entries, mediaByUrl, baseUrl) {
        if (!Array.isArray(entries) || !(mediaByUrl instanceof Map)) return false;
        let changed = false;
        let totalUrlBytes = 0;
        const boundedEntries = entries.slice(-MAX_PERFORMANCE_ENTRIES);
        for (const entry of boundedEntries) {
            const rawName = typeof entry?.name === 'string' ? entry.name : '';
            totalUrlBytes += rawName.length;
            if (totalUrlBytes > MAX_PERFORMANCE_TOTAL_URL_BYTES) break;
            const record = performanceEntryMediaRecord(entry, baseUrl);
            if (record && mergeMediaRecord(mediaByUrl, record, baseUrl)) changed = true;
        }
        return changed;
    }

    function elementMatches(element, selector) {
        try {
            return typeof element?.matches === 'function' && element.matches(selector);
        } catch (_error) {
            return false;
        }
    }

    function queryElements(root, selector, maximum = MAX_DOM_ELEMENTS_PER_SELECTOR) {
        try {
            if (typeof root?.querySelectorAll !== 'function') return [];
            const matches = root.querySelectorAll(selector);
            const results = [];
            const length = Math.min(Number(matches?.length) || 0, maximum);
            for (let index = 0; index < length; index += 1) results.push(matches[index]);
            return results;
        } catch (_error) {
            return [];
        }
    }

    function boundedNodes(nodes, maximum = 256) {
        const results = [];
        const length = Math.min(Number(nodes?.length) || 0, maximum);
        for (let index = 0; index < length; index += 1) results.push(nodes[index]);
        return results;
    }

    function scanRoot(root, mediaByUrl, documentRef, playerKeyFor, options = {}) {
        const baseUrl = documentRef?.baseURI || documentRef?.location?.href || '';
        const includeEmbedded = options.includeEmbedded !== false;
        const mediaElements = [];
        const dataElements = [];
        const configElements = [];
        const jsonLdElements = [];
        const explicitElements = [];
        const inlineScriptElements = [];

        if (elementMatches(root, 'video,audio,source')) mediaElements.push(root);
        mediaElements.push(...queryElements(root, 'video,audio,source'));
        if (includeEmbedded) {
            if (elementMatches(root, DATA_SELECTOR)) dataElements.push(root);
            if (elementMatches(root, CONFIG_DATA_SELECTOR)) configElements.push(root);
            if (elementMatches(root, 'script[type="application/ld+json"]')) jsonLdElements.push(root);
            if (elementMatches(root, EXPLICIT_MEDIA_SELECTOR)) explicitElements.push(root);
            if (elementMatches(root, INLINE_SCRIPT_SELECTOR)) inlineScriptElements.push(root);
            dataElements.push(...queryElements(root, DATA_SELECTOR));
            configElements.push(...queryElements(root, CONFIG_DATA_SELECTOR));
            jsonLdElements.push(...queryElements(root, 'script[type="application/ld+json"]', MAX_JSON_LD_SOURCES));
            explicitElements.push(...queryElements(root, EXPLICIT_MEDIA_SELECTOR));
            inlineScriptElements.push(...queryElements(root, INLINE_SCRIPT_SELECTOR, MAX_EMBEDDED_SOURCES));
        }

        for (const element of new Set(mediaElements)) {
            scanMediaElement(element, mediaByUrl, documentRef, baseUrl, playerKeyFor);
            if (!includeEmbedded) scanDataAttributes(element, mediaByUrl, documentRef, baseUrl, playerKeyFor);
        }
        for (const element of new Set(dataElements)) scanDataAttributes(element, mediaByUrl, documentRef, baseUrl, playerKeyFor);
        let embeddedBytes = 0;
        for (const element of new Set(configElements)) {
            if (embeddedBytes >= MAX_EMBEDDED_TOTAL_BYTES) break;
            embeddedBytes += scanConfigDataAttributes(
                element,
                mediaByUrl,
                baseUrl,
                MAX_EMBEDDED_TOTAL_BYTES - embeddedBytes
            );
        }
        let jsonLdBytes = 0;
        for (const element of new Set(jsonLdElements)) {
            let rawLength = 0;
            try {
                rawLength = typeof element?.textContent === 'string' ? element.textContent.length : 0;
            } catch (_error) {
                rawLength = 0;
            }
            if (!rawLength || rawLength > MAX_JSON_LD_LENGTH) continue;
            if (jsonLdBytes + rawLength > MAX_JSON_LD_TOTAL_LENGTH) break;
            jsonLdBytes += rawLength;
            scanJsonLdElement(element, mediaByUrl, baseUrl);
        }
        for (const element of new Set(explicitElements)) {
            scanExplicitMediaElement(element, mediaByUrl, documentRef, baseUrl);
        }
        for (const element of new Set(inlineScriptElements)) {
            if (embeddedBytes >= MAX_EMBEDDED_TOTAL_BYTES) break;
            let rawLength = 0;
            try {
                rawLength = typeof element?.textContent === 'string' ? element.textContent.length : 0;
            } catch (_error) {
                rawLength = 0;
            }
            if (!rawLength || rawLength > MAX_EMBEDDED_SOURCE_BYTES) continue;
            if (embeddedBytes + rawLength > MAX_EMBEDDED_TOTAL_BYTES) break;
            embeddedBytes += scanInlineScriptElement(element, mediaByUrl, baseUrl);
        }
        return mediaByUrl;
    }

    function stableSnapshotFingerprint(media) {
        let hash = 2166136261;
        const serialized = JSON.stringify(media);
        for (let index = 0; index < serialized.length; index += 1) {
            hash ^= serialized.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `${media.length}:${(hash >>> 0).toString(16)}`;
    }

    function sendPageMedia(chromeRef, documentRef, media, state, retry, completion = null) {
        const complete = (result) => {
            if (typeof completion !== 'function') return;
            try {
                completion(result);
            } catch (_error) {
                // The frame or message channel may disappear after the scan.
            }
        };
        const fingerprint = stableSnapshotFingerprint(media);
        if (fingerprint === state.lastFingerprint || fingerprint === state.pendingFingerprint) {
            complete({ ok: true, unchanged: true });
            return;
        }
        state.pendingFingerprint = fingerprint;
        const message = {
            type: MESSAGE_TYPE,
            version: 1,
            page: {
                url: safePageUrl(documentRef?.location?.href || documentRef?.baseURI || ''),
                title: sanitizeText(documentRef?.title || '', 180)
            },
            media
        };

        try {
            chromeRef.runtime.sendMessage(message, (response) => {
                const runtimeError = chromeRef.runtime.lastError;
                if (state.pendingFingerprint !== fingerprint) {
                    complete({ ok: false, stale: true });
                    return;
                }
                state.pendingFingerprint = '';
                if (!runtimeError && response?.ok === true && response?.stale !== true) {
                    state.lastFingerprint = fingerprint;
                    state.retryAttempts = 0;
                    complete({ ok: true });
                    return;
                }
                retry();
                complete({ ok: false });
            });
        } catch (_error) {
            if (state.pendingFingerprint === fingerprint) state.pendingFingerprint = '';
            retry();
            complete({ ok: false });
        }
    }

    function nodeCouldContainMedia(node) {
        if (!node || node.nodeType !== 1) return false;
        if (elementMatches(node, RELEVANT_SELECTOR)) return true;
        try {
            return typeof node.querySelector === 'function' && Boolean(node.querySelector(RELEVANT_SELECTOR));
        } catch (_error) {
            return false;
        }
    }

    function isRelevantAttributeMutation(record) {
        const name = String(record?.attributeName || '').toLowerCase();
        const target = record?.target;
        if (!name || !target) return false;
        if (DATA_ATTRIBUTE_NAMES.includes(name)) return true;
        if (CONFIG_DATA_ATTRIBUTE_NAMES.includes(name)) return true;
        if (name === 'src') return elementMatches(target, 'video,audio,source');
        const tagName = String(target?.tagName || '').toLowerCase();
        if (name === 'content') return tagName === 'meta';
        if (name === 'href') {
            if (tagName === 'link') return true;
            if (tagName === 'a') return looksLikeMediaUrl(readAttribute(target, 'href'), target?.baseURI || '');
        }
        if (['property', 'name', 'itemprop'].includes(name)) return tagName === 'meta';
        if (['rel', 'as'].includes(name)) return tagName === 'link';
        if (name === 'type' && ['script', 'link', 'meta'].includes(tagName)) return true;
        return elementMatches(target, 'video,audio,source') || Boolean(closestMediaElement(target));
    }

    function createPageMediaReader(documentRef, chromeRef, environment = {}) {
        if (!documentRef || !chromeRef?.runtime?.sendMessage) return null;
        const MutationObserverClass = environment.MutationObserver || globalThis.MutationObserver;
        const PerformanceObserverClass = environment.PerformanceObserver || documentRef.defaultView?.PerformanceObserver;
        const performanceRef = environment.performance || documentRef.defaultView?.performance;
        const setTimer = environment.setTimeout || globalThis.setTimeout;
        const clearTimer = environment.clearTimeout || globalThis.clearTimeout;
        let detectedTopFrame = true;
        try {
            const view = documentRef.defaultView;
            detectedTopFrame = !view?.top || view.top === view;
        } catch (_error) {
            detectedTopFrame = false;
        }
        const aggressiveScan = typeof environment.aggressiveScan === 'boolean'
            ? environment.aggressiveScan
            : detectedTopFrame;
        const playerKeyByElement = new WeakMap();
        let nextPlayerKey = 1;
        const playerKeyFor = (element) => {
            if (!element || (typeof element !== 'object' && typeof element !== 'function')) return '';
            const tagName = String(element.tagName || '').toLowerCase();
            if (tagName !== 'video' && tagName !== 'audio') return '';
            const existing = playerKeyByElement.get(element);
            if (existing) return existing;
            if (!Number.isSafeInteger(nextPlayerKey) || nextPlayerKey < 1) return '';
            const key = `p${nextPlayerKey.toString(36)}`;
            nextPlayerKey += 1;
            playerKeyByElement.set(element, key);
            return key;
        };
        const state = {
            mediaByUrl: new Map(),
            performanceMediaByUrl: new Map(),
            performancePageIdentity: normalizeHttpUrl(documentRef.location?.href || documentRef.baseURI || ''),
            performanceEntryCount: 0,
            performanceBufferInitialized: false,
            lastFingerprint: '',
            pendingFingerprint: '',
            retryAttempts: 0,
            pageIdentity: normalizeHttpUrl(documentRef.location?.href || documentRef.baseURI || ''),
            timer: null,
            needsFullScan: true,
            pendingRoots: new Set(),
            readyRetryTimers: new Set(),
            readyRetriesArmed: false,
            aggressiveScan
        };

        const flush = (completion = null) => {
            state.timer = null;
            const pageIdentity = normalizeHttpUrl(documentRef.location?.href || documentRef.baseURI || '');
            if (pageIdentity !== state.pageIdentity) {
                state.pageIdentity = pageIdentity;
                state.needsFullScan = true;
                state.lastFingerprint = '';
                state.pendingFingerprint = '';
                state.retryAttempts = 0;
                if (state.performancePageIdentity !== pageIdentity) {
                    state.performanceMediaByUrl = new Map();
                    state.performancePageIdentity = pageIdentity;
                }
                for (const handle of state.readyRetryTimers) clearTimer(handle);
                state.readyRetryTimers.clear();
                state.readyRetriesArmed = false;
                armReadyRetries();
            }

            try {
                const entries = performanceRef?.getEntriesByType?.('resource');
                if (Array.isArray(entries)) {
                    const entriesToScan = !state.performanceBufferInitialized || entries.length < state.performanceEntryCount
                        ? entries
                        : entries.slice(state.performanceEntryCount);
                    state.performanceEntryCount = entries.length;
                    state.performanceBufferInitialized = true;
                    scanPerformanceEntries(entriesToScan, state.performanceMediaByUrl, documentRef.baseURI || pageIdentity);
                }
            } catch (_error) {
                // Resource timing is optional and may be disabled by the page.
            }

            if (state.needsFullScan) {
                state.mediaByUrl = new Map();
                scanRoot(documentRef, state.mediaByUrl, documentRef, playerKeyFor, {
                    includeEmbedded: state.aggressiveScan
                });
            } else {
                for (const root of state.pendingRoots) {
                    scanRoot(root, state.mediaByUrl, documentRef, playerKeyFor, {
                        includeEmbedded: state.aggressiveScan
                    });
                }
            }
            for (const record of state.performanceMediaByUrl.values()) {
                mergeMediaRecord(state.mediaByUrl, record, documentRef.baseURI || pageIdentity);
            }
            state.needsFullScan = false;
            state.pendingRoots.clear();
            sendPageMedia(
                chromeRef,
                documentRef,
                Array.from(state.mediaByUrl.values()),
                state,
                scheduleRetry,
                completion
            );
        };

        const scheduleRetry = () => {
            if (state.retryAttempts >= MAX_SNAPSHOT_RETRIES || state.timer !== null) return;
            state.retryAttempts += 1;
            state.needsFullScan = true;
            const delay = Math.min(SNAPSHOT_RETRY_BASE_MS * (2 ** (state.retryAttempts - 1)), 8_000);
            state.timer = setTimer(flush, delay);
        };

        const schedule = (root, fullScan = false) => {
            state.retryAttempts = 0;
            if (fullScan) state.needsFullScan = true;
            else if (root) state.pendingRoots.add(root);
            if (state.timer !== null) clearTimer(state.timer);
            state.timer = setTimer(flush, DEBOUNCE_MS);
        };

        const armReadyRetries = () => {
            if (!state.aggressiveScan || state.readyRetriesArmed) return;
            state.readyRetriesArmed = true;
            for (const delay of PAGE_READY_RESCAN_DELAYS_MS) {
                let handle = null;
                const callback = () => {
                    if (handle !== null) state.readyRetryTimers.delete(handle);
                    schedule(documentRef, true);
                };
                handle = setTimer(callback, delay);
                if (handle !== null && handle !== undefined) state.readyRetryTimers.add(handle);
            }
        };

        const observer = typeof MutationObserverClass === 'function'
            ? new MutationObserverClass((records) => {
                for (const record of records) {
                    if (record.type === 'attributes') {
                        if (isRelevantAttributeMutation(record)) schedule(record.target, true);
                        continue;
                    }
                    if (record.type !== 'childList') continue;
                    const targetIsScannableScript = elementMatches(record.target, 'script[type="application/ld+json"]') ||
                        elementMatches(record.target, INLINE_SCRIPT_SELECTOR);
                    if (targetIsScannableScript || boundedNodes(record.removedNodes).some(nodeCouldContainMedia)) {
                        schedule(documentRef, true);
                        continue;
                    }
                    for (const node of boundedNodes(record.addedNodes)) {
                        if (nodeCouldContainMedia(node)) schedule(node, false);
                    }
                }
            })
            : null;

        try {
            observer?.observe(documentRef, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: Array.from(new Set(OBSERVED_ATTRIBUTES))
            });
        } catch (_error) {
            // A very early/closing document can reject observation; initial scan still works.
        }

        let performanceObserver = null;
        if (typeof PerformanceObserverClass === 'function') {
            try {
                performanceObserver = new PerformanceObserverClass((entryList) => {
                    let entries = [];
                    try {
                        entries = entryList?.getEntries?.() || [];
                    } catch (_error) {
                        entries = [];
                    }
                    const observedPageIdentity = normalizeHttpUrl(
                        documentRef.location?.href || documentRef.baseURI || ''
                    );
                    if (observedPageIdentity !== state.performancePageIdentity) {
                        state.performanceMediaByUrl = new Map();
                        state.performancePageIdentity = observedPageIdentity;
                    }
                    if (
                        Array.isArray(entries) &&
                        scanPerformanceEntries(
                            entries,
                            state.performanceMediaByUrl,
                            documentRef.baseURI || state.pageIdentity
                        )
                    ) schedule(null, false);
                });
            } catch (_error) {
                performanceObserver = null;
            }
        }
        try {
            performanceObserver?.observe({ type: 'resource', buffered: true });
        } catch (_error) {
            try {
                performanceObserver?.observe({ entryTypes: ['resource'] });
            } catch (_ignored) {
                // PerformanceObserver is best-effort; page-ready scans still read the buffer.
            }
        }

        const onMediaMetadata = () => schedule(documentRef, true);
        const onReady = () => {
            schedule(documentRef, true);
            armReadyRetries();
        };
        const onRuntimeMessage = (message, sender, sendResponse) => {
            const runtimeId = typeof chromeRef.runtime.id === 'string' ? chromeRef.runtime.id : '';
            if (runtimeId && sender?.id && sender.id !== runtimeId) {
                if ([PLATFORM_TARGETS_MESSAGE_TYPE, RESCAN_PAGE_MEDIA_MESSAGE_TYPE].includes(message?.type)) {
                    sendResponse?.({ ok: false, code: 'INVALID_SENDER' });
                }
                return false;
            }
            if (message?.type === RESCAN_PAGE_MEDIA_MESSAGE_TYPE) {
                // The worker has rejected an expired transport. Forget only the
                // snapshot deduplication state and schedule a complete page scan;
                // the popup keeps rendering its current state until a fresh
                // PAGE_MEDIA_DISCOVERED snapshot is committed by the worker.
                state.lastFingerprint = '';
                state.pendingFingerprint = '';
                state.retryAttempts = 0;
                state.needsFullScan = true;
                state.performanceBufferInitialized = false;
                state.performanceEntryCount = 0;
                if (state.timer !== null) clearTimer(state.timer);
                state.timer = null;
                state.pendingRoots.clear();
                // Scan immediately and acknowledge only after the worker has
                // committed PAGE_MEDIA_DISCOVERED. The expiry refresher can
                // then safely decide whether the page itself replaced a token.
                flush((result) => {
                    sendResponse?.({ ok: result?.ok === true, scanned: true });
                });
                return true;
            }
            if (message?.type !== PLATFORM_TARGETS_MESSAGE_TYPE) return false;
            try {
                sendResponse({ ok: true, targets: readPlatformResolverTargets(documentRef) });
            } catch (_error) {
                sendResponse({ ok: false, targets: [] });
            }
            return false;
        };
        try {
            documentRef.addEventListener('loadedmetadata', onMediaMetadata, true);
            documentRef.addEventListener('durationchange', onMediaMetadata, true);
            documentRef.addEventListener('loadstart', onMediaMetadata, true);
            documentRef.addEventListener('DOMContentLoaded', onReady, { once: true });
            documentRef.defaultView?.addEventListener('pageshow', onReady);
            chromeRef.runtime.onMessage?.addListener(onRuntimeMessage);
        } catch (_error) {
            // The document can disappear while an iframe is being removed.
        }
        if (documentRef.readyState === 'interactive' || documentRef.readyState === 'complete') {
            armReadyRetries();
        }
        schedule(documentRef, true);

        return {
            flush,
            schedule,
            disconnect() {
                observer?.disconnect();
                performanceObserver?.disconnect?.();
                if (state.timer !== null) clearTimer(state.timer);
                for (const handle of state.readyRetryTimers) clearTimer(handle);
                state.readyRetryTimers.clear();
                try {
                    documentRef.removeEventListener('loadedmetadata', onMediaMetadata, true);
                    documentRef.removeEventListener('durationchange', onMediaMetadata, true);
                    documentRef.removeEventListener('loadstart', onMediaMetadata, true);
                    documentRef.removeEventListener('DOMContentLoaded', onReady);
                    documentRef.defaultView?.removeEventListener('pageshow', onReady);
                    chromeRef.runtime.onMessage?.removeListener(onRuntimeMessage);
                } catch (_error) {
                    // Best-effort cleanup for tests and removed frames.
                }
            },
            state
        };
    }

    if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
        createPageMediaReader(document, chrome);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            MESSAGE_TYPE,
            PLATFORM_TARGETS_MESSAGE_TYPE,
            RESCAN_PAGE_MEDIA_MESSAGE_TYPE,
            DATA_ATTRIBUTE_NAMES,
            CONFIG_DATA_ATTRIBUTE_NAMES,
            normalizeHttpUrl,
            safePageUrl,
            normalizeTvpResolverTarget,
            extractTvpResolverTargets,
            readPlatformResolverTargets,
            sanitizeText,
            normalizeMimeType,
            inferMediaType,
            looksLikeMediaUrl,
            looksLikeUrlReference,
            parseIsoDuration,
            buildMediaRecord,
            mergeMediaRecord,
            isMediaDataAttribute,
            extractEmbeddedMedia,
            extractJsonLdMedia,
            performanceEntryMediaRecord,
            scanPerformanceEntries,
            scanRoot,
            stableSnapshotFingerprint,
            isRelevantAttributeMutation,
            createPageMediaReader
        };
    }
}());

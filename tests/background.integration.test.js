'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const TAB_STATE_PREFIX = 'tabState_';
const REQUEST_CONTEXT_PREFIX = 'requestContext_';
const EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POPUP_SENDER = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/popup.html`
};

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await wait(10);
    }
    assert.fail('Timed out while waiting for background worker state');
}

function createStorageArea(data, hooks = {}) {
    return {
        async get(query) {
            let result;
            if (query === null || query === undefined) {
                result = clone(data);
            } else if (typeof query === 'string') {
                result = { [query]: clone(data[query]) };
            } else if (Array.isArray(query)) {
                result = Object.fromEntries(query.map((key) => [key, clone(data[key])]));
            } else {
                result = clone(query || {});
                for (const key of Object.keys(query || {})) {
                    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = clone(data[key]);
                }
            }
            if (typeof hooks.afterGet === 'function') await hooks.afterGet(query, clone(result));
            return result;
        },
        async set(values) {
            Object.assign(data, clone(values));
        },
        async remove(keys) {
            for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key];
        }
    };
}

function createHarness(options = {}) {
    const listeners = {};
    const timers = new Set();
    const sessionData = options.sessionData || {};
    const localData = options.localData || {
        siteAutoLaunch: {},
        defaultPlayMode: 'new',
        legacyAutoLaunchMigrationPending: false
    };
    const tabUrls = options.tabUrls || new Map();
    const activeTabIds = new Set(options.activeTabIds || []);
    const closedTabs = options.closedTabs || new Set();
    const nativeMessages = [];
    const platformMessages = [];
    const pageRescanMessages = [];
    const contextMenuItems = new Map();
    const contextMenuOperations = [];
    const alarms = new Map();

    const chromeEvent = (name) => ({
        addListener(listener) {
            listeners[name] = listener;
        }
    });
    const trackedSetTimeout = (callback, delay, ...args) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            callback(...args);
        }, delay);
        timers.add(timer);
        return timer;
    };
    const trackedClearTimeout = (timer) => {
        timers.delete(timer);
        clearTimeout(timer);
    };

    const chrome = {
        storage: {
            session: createStorageArea(sessionData, { afterGet: options.afterSessionGet }),
            local: createStorageArea(localData, { afterGet: options.afterLocalGet })
        },
        cookies: {
            getAll(details, callback) {
                if (options.cookieError) {
                    chrome.runtime.lastError = { message: options.cookieError };
                    callback([]);
                    chrome.runtime.lastError = null;
                    return;
                }
                assert.equal(typeof details.url, 'string');
                callback(clone(options.cookies || []));
            }
        },
        action: {
            async setBadgeText() {},
            async setBadgeBackgroundColor() {}
        },
        contextMenus: {
            onClicked: chromeEvent('contextMenuClicked'),
            create(details, callback) {
                const id = String(details?.id || '');
                contextMenuOperations.push({ action: 'create', details: clone(details) });
                if (contextMenuItems.has(id)) {
                    chrome.runtime.lastError = { message: `Duplicate menu id: ${id}` };
                } else {
                    contextMenuItems.set(id, clone(details));
                }
                callback?.();
                chrome.runtime.lastError = null;
                return id;
            },
            remove(id, callback) {
                contextMenuOperations.push({ action: 'remove', id });
                if (!contextMenuItems.delete(id)) {
                    chrome.runtime.lastError = { message: `Cannot find menu id: ${id}` };
                }
                callback?.();
                chrome.runtime.lastError = null;
            }
        },
        tabs: {
            onUpdated: chromeEvent('tabUpdated'),
            onActivated: chromeEvent('tabActivated'),
            onCreated: chromeEvent('tabCreated'),
            onRemoved: chromeEvent('tabRemoved'),
            async get(tabId) {
                if (closedTabs.has(tabId)) throw new Error('No tab with id');
                return { id: tabId, url: tabUrls.get(tabId) || '' };
            },
            query(_query, callback) {
                const tabs = [...activeTabIds].filter((tabId) => tabUrls.has(tabId)).map((tabId) => ({
                    id: tabId,
                    url: tabUrls.get(tabId),
                    active: true,
                    windowId: 1
                }));
                callback(tabs);
            },
            sendMessage(tabId, message, sendOptions, callback) {
                if (typeof sendOptions === 'function') {
                    callback = sendOptions;
                    sendOptions = undefined;
                }
                if (message.type === 'RESCAN_PAGE_MEDIA') {
                    pageRescanMessages.push({ tabId, message: clone(message), options: clone(sendOptions) });
                    if (Array.isArray(options.pageRescanMedia)) {
                        if (options.pageRescanAckBeforeMedia === true) {
                            callback?.({ ok: true, scanned: true });
                        }
                        trackedSetTimeout(() => {
                            listeners.runtimeMessage({
                                type: 'PAGE_MEDIA_DISCOVERED',
                                tabId,
                                page: { url: tabUrls.get(tabId) || '' },
                                media: clone(options.pageRescanMedia)
                            }, {
                                frameId: Number.isInteger(options.pageRescanFrameId)
                                    ? options.pageRescanFrameId
                                    : 0,
                                documentId: 'expiry-rescan-document',
                                url: tabUrls.get(tabId) || ''
                            }, (response) => {
                                if (options.pageRescanAckBeforeMedia !== true) {
                                    callback?.({ ok: response?.ok === true, scanned: true });
                                }
                            });
                        }, Number.isInteger(options.pageRescanDelayMs) ? options.pageRescanDelayMs : 0);
                    } else {
                        callback?.({ ok: true, scanned: true });
                    }
                    return;
                }
                assert.equal(message.type, 'GET_PLATFORM_RESOLVER_TARGETS');
                platformMessages.push({ tabId, message: clone(message), options: clone(sendOptions) });
                if (Array.isArray(options.platformTargets)) {
                    callback({ ok: true, targets: clone(options.platformTargets) });
                    return;
                }
                chrome.runtime.lastError = { message: `No content script in tab ${tabId}` };
                callback(undefined);
                chrome.runtime.lastError = null;
            }
        },
        alarms: {
            onAlarm: chromeEvent('alarm'),
            create(name, alarmInfo) {
                alarms.set(String(name), clone(alarmInfo));
            },
            clear(name, callback) {
                const removed = alarms.delete(String(name));
                callback?.(removed);
            }
        },
        webRequest: {
            onBeforeRequest: chromeEvent('beforeRequest'),
            onSendHeaders: chromeEvent('sendHeaders'),
            onHeadersReceived: chromeEvent('headersReceived'),
            onCompleted: chromeEvent('requestCompleted'),
            onErrorOccurred: chromeEvent('requestError')
        },
        runtime: {
            id: EXTENSION_ID,
            onMessage: chromeEvent('runtimeMessage'),
            onInstalled: chromeEvent('installed'),
            onStartup: chromeEvent('startup'),
            lastError: null,
            sendNativeMessage(_hostName, request, callback) {
                nativeMessages.push(clone(request));
                const runtimeError = typeof options.nativeRuntimeError === 'function'
                    ? options.nativeRuntimeError(request)
                    : options.nativeRuntimeError;
                if (typeof runtimeError === 'string' && runtimeError) {
                    chrome.runtime.lastError = { message: runtimeError };
                    callback(undefined);
                    chrome.runtime.lastError = null;
                    return;
                }
                const response = options.nativeResponder
                    ? options.nativeResponder(request)
                    : {
                        protocolVersion: 2,
                        hostVersion: '3.2.0-test',
                        ok: true,
                        action: request.action,
                        requestId: request.requestId,
                        ...(request.action === 'play'
                            ? { confirmed: true, mode: request.mode, confirmation: 'test' }
                            : { mpv: { available: true }, queue: { state: 'stopped', responsive: false } })
                    };
                if (Number.isInteger(options.nativeDelayMs) && options.nativeDelayMs > 0) {
                    trackedSetTimeout(() => callback(response), options.nativeDelayMs);
                } else {
                    callback(response);
                }
            }
        },
        i18n: {
            getAcceptLanguages(callback) {
                callback(clone(options.acceptLanguages || []));
            }
        }
    };

    const moduleObject = { exports: {} };
    const context = vm.createContext({
        chrome,
        module: moduleObject,
        exports: moduleObject.exports,
        URL,
        TextEncoder,
        TextDecoder,
        ...(typeof options.fetch === 'function' ? { fetch: options.fetch } : {}),
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClearTimeout
    });
    let workerSource = WORKER_SOURCE.replace(
        'const GENERIC_PREROLL_GUARD_MS = 2_500;',
        `const GENERIC_PREROLL_GUARD_MS = ${Number.isInteger(options.genericPrerollGuardMs)
            ? options.genericPrerollGuardMs
            : 0};`
    );
    workerSource = Number.isInteger(options.autoDebounceMs)
        ? workerSource.replace(
            'const AUTO_DEBOUNCE_MS = 800;',
            `const AUTO_DEBOUNCE_MS = ${options.autoDebounceMs};`
        )
        : workerSource;
    workerSource = Number.isInteger(options.autoRetryCooldownMs)
        ? workerSource.replace(
            'const AUTO_RETRY_COOLDOWN_MS = 5_000;',
            `const AUTO_RETRY_COOLDOWN_MS = ${options.autoRetryCooldownMs};`
        )
        : workerSource;
    workerSource = Number.isInteger(options.expiryBusyRetryMs)
        ? workerSource.replace(
            'const MEDIA_EXPIRY_BUSY_RETRY_MS = 5_000;',
            `const MEDIA_EXPIRY_BUSY_RETRY_MS = ${options.expiryBusyRetryMs};`
        )
        : workerSource;
    workerSource = Number.isInteger(options.expiryBusyRetryLimit)
        ? workerSource.replace(
            'const MAX_MEDIA_EXPIRY_BUSY_RETRIES = 6;',
            `const MAX_MEDIA_EXPIRY_BUSY_RETRIES = ${options.expiryBusyRetryLimit};`
        )
        : workerSource;
    workerSource = Number.isInteger(options.pageMediaRescanSettleMs)
        ? workerSource.replace(
            'const PAGE_MEDIA_RESCAN_SETTLE_MS = 500;',
            `const PAGE_MEDIA_RESCAN_SETTLE_MS = ${options.pageMediaRescanSettleMs};`
        )
        : workerSource;
    workerSource = Number.isInteger(options.manifestFetchTimeoutMs)
        ? workerSource.replace(
            'const MANIFEST_FETCH_TIMEOUT_MS = 6_000;',
            `const MANIFEST_FETCH_TIMEOUT_MS = ${options.manifestFetchTimeoutMs};`
        )
        : workerSource;
    const configuredWorkerSource = Number.isInteger(options.pageReadyDebounceMs)
        ? workerSource.replace(
            'const PAGE_READY_RESOLVE_DEBOUNCE_MS = 1_000;',
            `const PAGE_READY_RESOLVE_DEBOUNCE_MS = ${options.pageReadyDebounceMs};`
        )
        : workerSource;
    vm.runInContext(configuredWorkerSource, context, { filename: 'background.js' });

    return {
        sessionData,
        localData,
        tabUrls,
        activeTabIds,
        closedTabs,
        nativeMessages,
        platformMessages,
        pageRescanMessages,
        alarms,
        contextMenuItems,
        contextMenuOperations,
        popupSender: POPUP_SENDER,
        async ready() {
            await wait(25);
        },
        fire(name, ...args) {
            assert.equal(typeof listeners[name], 'function', `Missing listener: ${name}`);
            return listeners[name](...args);
        },
        message(payload, sender = {}) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Runtime message timeout: ${payload.type}`)), 2_000);
                listeners.runtimeMessage(payload, sender, (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                });
            });
        },
        dispose() {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        }
    };
}

function requestDetails({ tabId, requestId, url, type = 'xmlhttprequest', timeStamp }) {
    return { tabId, requestId, url, type, timeStamp };
}

function emitConfirmedMedia(harness, details, options = {}) {
    harness.fire('beforeRequest', details);
    harness.fire('sendHeaders', {
        ...details,
        timeStamp: details.timeStamp + 1,
        requestHeaders: options.requestHeaders || [
            { name: 'Referer', value: `https://${options.pageHostname || 'page.test'}/watch` },
            { name: 'User-Agent', value: 'Integration-Test/1.0' }
        ]
    });
    harness.fire('headersReceived', {
        ...details,
        timeStamp: details.timeStamp + 2,
        statusCode: options.statusCode ?? 200,
        responseHeaders: [{
            name: 'Content-Type',
            value: options.contentType || 'application/vnd.apple.mpegurl'
        }]
    });
}

function tabStateFixture(tabId, hostname) {
    const now = Date.now();
    return {
        schemaVersion: 4,
        tabId,
        hostname,
        candidates: [],
        events: [],
        status: { state: 'scanning', code: 'SCANNING', message: 'Skanuję.', updatedAt: now },
        auto: {
            enabled: false,
            pendingDueAt: null,
            cooldownUntil: 0,
            lastCandidateId: null,
            lastFingerprint: null,
            lastAttemptAt: 0
        },
        createdAt: now,
        updatedAt: now
    };
}

function manualPlayCandidate(options) {
    const now = Date.now();
    const source = options.source || 'network';
    const type = options.type || (options.url.includes('.mp4') ? 'MP4' : 'HLS');
    const role = options.role || (type === 'MP4' ? 'direct' : 'master');
    return {
        id: options.id,
        url: options.url,
        type,
        role,
        groupKey: options.groupKey || `group:${options.id}`,
        source,
        sources: [source],
        resourceType: source.startsWith('resolver_') ? 'resolver' : 'media',
        contentType: type === 'MP4' ? 'video/mp4' : 'application/vnd.apple.mpegurl',
        networkObserved: source === 'network',
        statusCode: 200,
        firstSeenAt: now,
        lastSeenAt: now,
        requestStartedAt: now,
        mediaKind: options.mediaKind,
        hasAudio: options.hasAudio,
        hasVideo: options.hasVideo,
        diagnosticOnly: options.diagnosticOnly === true,
        drmProtected: options.drmProtected === true,
        genericPrerollGuardUntil: options.genericPrerollGuardUntil || 0,
        playState: options.playState || '',
        lastPlayErrorCode: options.lastPlayErrorCode || '',
        userPriority: options.userPriority || 0,
        height: options.height,
        bitrateKbps: options.bitrateKbps
    };
}

function installManualPlayState(harness, tabId, hostname, candidates) {
    const state = tabStateFixture(tabId, hostname);
    state.candidates = candidates;
    harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`] = state;
    return state;
}

test('context menu permission and registration are minimal, scoped, and idempotent', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    assert.deepEqual(
        [...manifest.permissions].sort(),
        ['alarms', 'contextMenus', 'downloads', 'nativeMessaging', 'storage', 'webRequest']
    );
    assert.deepEqual(manifest.optional_permissions, ['cookies']);
    assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
    assert.equal(manifest.minimum_chrome_version, '120');

    const harness = createHarness();
    try {
        await harness.ready();
        const expected = {
            id: 'open-recommended-in-mpv',
            title: 'Otwórz polecany w MPV',
            contexts: ['page'],
            documentUrlPatterns: ['http://*/*', 'https://*/*']
        };
        assert.deepEqual(harness.contextMenuItems.get(expected.id), expected);

        harness.fire('installed', { reason: 'update' });
        harness.fire('startup');
        await wait(10);
        assert.equal(harness.contextMenuItems.size, 1);
        assert.deepEqual(harness.contextMenuItems.get(expected.id), expected);
    } finally {
        harness.dispose();
    }
});

test('good master plus a 404 variant launches exactly the healthy master once', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'page.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[1, 'https://page.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 1, url: 'https://page.test/watch' });
        const master = requestDetails({
            tabId: 1,
            requestId: 'master-good',
            url: 'https://cdn.test/live/master.m3u8?token=good',
            timeStamp: 1_000
        });
        const badVariant = requestDetails({
            tabId: 1,
            requestId: 'variant-404',
            url: 'https://cdn.test/live/720p/variant.m3u8?token=bad',
            timeStamp: 2_000
        });
        emitConfirmedMedia(harness, master);
        emitConfirmedMedia(harness, badVariant, { statusCode: 404 });

        await wait(1_000);
        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        assert.equal(plays[0].stream.url, master.url);
        assert.equal(plays[0].source, 'auto');
    } finally {
        harness.dispose();
    }
});

test('TVP advertisement is filtered and the following HLS master launches once', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'sport.tvp.pl': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[7, 'https://sport.tvp.pl/material']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 7, url: 'https://sport.tvp.pl/material' });
        const advertisement = requestDetails({
            tabId: 7,
            requestId: 'tvp-advertisement',
            url: 'https://media.example.test/video/vod/reklamy/123_1080p_5000K.mp4?token=ad',
            type: 'media',
            timeStamp: 9_000
        });
        emitConfirmedMedia(harness, advertisement, {
            pageHostname: 'sport.tvp.pl',
            contentType: 'video/mp4'
        });

        await wait(950);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
        const afterAdvertisement = await harness.message({ type: 'GET_TAB_STATE', tabId: 7 });
        assert.equal(afterAdvertisement.state.status.code, 'ADS_FILTERED');
        assert.equal(afterAdvertisement.state.candidates[0].purpose, 'advertisement');
        assert.equal(afterAdvertisement.state.candidates[0].blocked, true);

        const content = requestDetails({
            tabId: 7,
            requestId: 'tvp-content-master',
            url: 'https://media.example.test/video/vod/program/video.ism/video-fmp4.m3u8?token=content',
            timeStamp: 10_000
        });
        emitConfirmedMedia(harness, content, {
            pageHostname: 'sport.tvp.pl',
            contentType: 'application/vnd.apple.mpegurl'
        });

        await wait(1_000);
        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        assert.equal(plays[0].stream.url, content.url);
        assert.equal(plays[0].source, 'auto');

        const finalState = await harness.message({ type: 'GET_TAB_STATE', tabId: 7 });
        assert.equal(finalState.state.candidates[0].purpose, 'content');
        assert.equal(finalState.state.candidates[0].recommended, true);
    } finally {
        harness.dispose();
    }
});

test('TVP master remains recommended after later video and audio child playlists', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'sport.tvp.pl': false },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[70, 'https://sport.tvp.pl/material']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 70, url: 'https://sport.tvp.pl/material' });
        const root = 'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/date/client/signature/video.ism/';
        const master = requestDetails({
            tabId: 70,
            requestId: 'tvp-master',
            url: `${root}video-fmp4.m3u8`,
            timeStamp: 10_000
        });
        const videoChild = requestDetails({
            tabId: 70,
            requestId: 'tvp-video-child',
            url: `${root}nv-hlsfmp4-index-vod4-f7-v1.m3u8`,
            timeStamp: 10_100
        });
        const audioChild = requestDetails({
            tabId: 70,
            requestId: 'tvp-audio-child',
            url: `${root}nv-hlsfmp4-index-vod4-f8-a1.m3u8`,
            timeStamp: 10_200
        });

        emitConfirmedMedia(harness, master, { pageHostname: 'sport.tvp.pl' });
        emitConfirmedMedia(harness, videoChild, { pageHostname: 'sport.tvp.pl' });
        emitConfirmedMedia(harness, audioChild, { pageHostname: 'sport.tvp.pl' });
        await wait(100);

        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 70 });
        assert.equal(state.state.candidates.length, 3);
        assert.equal(state.state.candidates[0].url, master.url);
        assert.equal(state.state.candidates[0].role, 'master');
        assert.equal(state.state.candidates[0].recommended, true);
        assert.equal(state.state.candidates[1].role, 'variant');
        assert.equal(state.state.candidates[2].role, 'audio');
    } finally {
        harness.dispose();
    }
});

test('TVP unknown child cannot auto-open before a complete master arrives', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'sport.tvp.pl': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[72, 'https://sport.tvp.pl/material']]),
        autoDebounceMs: 40
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 72, url: 'https://sport.tvp.pl/material' });
        const root = 'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/date/client/signature/video.ism/';
        const child = requestDetails({
            tabId: 72,
            requestId: 'tvp-early-video-child',
            url: `${root}nv-hlsfmp4-index-vod4-f7-v1.m3u8`,
            timeStamp: 11_000
        });
        const master = requestDetails({
            tabId: 72,
            requestId: 'tvp-late-master',
            url: `${root}video-fmp4.m3u8`,
            timeStamp: 11_100
        });

        emitConfirmedMedia(harness, child, { pageHostname: 'sport.tvp.pl' });
        await wait(120);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);

        emitConfirmedMedia(harness, master, { pageHostname: 'sport.tvp.pl' });
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'play').length === 1);
        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        assert.equal(plays[0].stream.url, master.url);
        assert.equal(plays[0].source, 'auto');
    } finally {
        harness.dispose();
    }
});

test('TVP path-token refresh replaces the stale URL and waits for the new response', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'sport.tvp.pl': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[71, 'https://sport.tvp.pl/material']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 71, url: 'https://sport.tvp.pl/material' });
        const first = requestDetails({
            tabId: 71,
            requestId: 'tvp-signed-first',
            url: 'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/date-a/client-a/signature-a/video.ism/video-fmp4.m3u8',
            timeStamp: 20_000
        });
        emitConfirmedMedia(harness, first, { pageHostname: 'sport.tvp.pl' });
        await wait(100);

        const refreshed = requestDetails({
            tabId: 71,
            requestId: 'tvp-signed-refreshed',
            url: 'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/date-b/client-b/signature-b/video.ism/video-fmp4.m3u8',
            timeStamp: 21_000
        });
        harness.fire('beforeRequest', refreshed);
        await wait(100);

        const pending = await harness.message({ type: 'GET_TAB_STATE', tabId: 71 });
        assert.equal(pending.state.candidates.length, 1);
        assert.equal(pending.state.candidates[0].url, refreshed.url);
        assert.equal(pending.state.candidates[0].statusCode, undefined);
        assert.equal(pending.state.candidates[0].contentType, undefined);
        assert.equal(pending.state.auto.pendingDueAt > Date.now(), true);

        harness.fire('sendHeaders', {
            ...refreshed,
            timeStamp: refreshed.timeStamp + 1,
            requestHeaders: [
                { name: 'Referer', value: 'https://sport.tvp.pl/material' },
                { name: 'User-Agent', value: 'Integration-Test/1.0' }
            ]
        });
        harness.fire('headersReceived', {
            ...refreshed,
            timeStamp: refreshed.timeStamp + 2,
            statusCode: 200,
            responseHeaders: [{
                name: 'Content-Type',
                value: 'application/vnd.apple.mpegurl'
            }]
        });
        await wait(100);

        const confirmed = await harness.message({ type: 'GET_TAB_STATE', tabId: 71 });
        assert.equal(confirmed.state.candidates.length, 1);
        assert.equal(confirmed.state.candidates[0].url, refreshed.url);
        assert.equal(confirmed.state.candidates[0].statusCode, 200);
        assert.equal(confirmed.state.candidates[0].recommended, true);
    } finally {
        harness.dispose();
    }
});

test('confirmed auto-play stays single-shot when late variants and formats appear', async () => {
    const sessionData = {};
    const harness = createHarness({
        sessionData,
        localData: {
            siteAutoLaunch: { 'page.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[9, 'https://page.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 9, url: 'https://page.test/watch' });
        const master = requestDetails({
            tabId: 9,
            requestId: 'single-shot-master',
            url: 'https://cdn.test/program/master.m3u8?token=first',
            timeStamp: 11_000
        });
        emitConfirmedMedia(harness, master);
        await wait(950);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 1);

        // Expire the time cooldown deliberately. Session-level confirmation,
        // rather than the cooldown alone, must prevent a second window. Flood
        // the bounded list first: the transport already handled by auto-play
        // must remain retained even when newer 2160p files would otherwise
        // occupy all eighty slots.
        const persisted = sessionData[TAB_STATE_PREFIX + 9];
        const playedFingerprint = persisted.auto.lastFingerprint;
        const playedCandidate = persisted.candidates.find((candidate) => candidate.groupKey === playedFingerprint);
        assert.ok(playedCandidate);
        for (let index = 0; index < 79; index += 1) {
            const url = `https://cdn.test/program/flood/video-${index}-2160.mp4`;
            persisted.candidates.push({
                ...playedCandidate,
                id: `flood-${index}`,
                url,
                canonicalKey: url,
                groupKey: `flood-group-${index}`,
                source: 'response_headers',
                sourceMethod: 'network',
                sources: ['response_headers'],
                type: 'MP4',
                role: 'direct',
                isMaster: false,
                height: 2160,
                qualityHeight: 2160,
                quality: '2160p',
                qualityBucket: '2160p',
                qualityPreferenceRank: 0,
                firstSeenAt: persisted.auto.lastAttemptAt + 100 + index,
                lastSeenAt: persisted.auto.lastAttemptAt + 100 + index,
                recommended: false,
                playState: 'idle',
                lastPlayedAt: 0
            });
        }
        persisted.auto.cooldownUntil = 0;
        const overflowTransport = requestDetails({
            tabId: 9,
            requestId: 'single-shot-overflow-transport',
            url: 'https://overflow-unique.example.test/quality/2160/movie.mp4',
            type: 'media',
            timeStamp: 11_900
        });
        emitConfirmedMedia(harness, overflowTransport, { contentType: 'video/mp4' });
        await wait(100);
        const bounded = await harness.message({ type: 'GET_TAB_STATE', tabId: 9 });
        assert.equal(bounded.state.candidates.length, 80);
        assert.equal(bounded.state.candidates.some((candidate) => candidate.url === overflowTransport.url), true);
        assert.equal(bounded.state.candidates.some((candidate) => candidate.groupKey === playedFingerprint), true);
        const lateVariant = requestDetails({
            tabId: 9,
            requestId: 'single-shot-variant',
            url: 'https://cdn.test/program/1080p/variant.m3u8?token=second',
            timeStamp: 12_000
        });
        emitConfirmedMedia(harness, lateVariant);
        await wait(950);

        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 9 });
        assert.equal(state.state.status.code, 'PLAY_CONFIRMED');
        assert.equal(state.state.auto.pendingDueAt, null);
    } finally {
        harness.dispose();
    }
});

test('page reader discoveries become manual playlist candidates without fabricated headers', async () => {
    const harness = createHarness({
        tabUrls: new Map([[8, 'https://page.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 8, url: 'https://page.test/watch' });
        const response = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 8,
            media: [{
                url: 'https://cdn.test/movie/master.m3u8?token=page-source',
                type: 'HLS',
                title: 'Film ze strony',
                quality: 'Auto',
                mimeType: 'application/vnd.apple.mpegurl',
                tagName: 'video'
            }, {
                url: 'https://cdn.test/opaque/player-source?token=page-source',
                type: 'MEDIA',
                title: 'Źródło bez rozszerzenia',
                tagName: 'video'
            }, {
                url: 'blob:https://page.test/local-only',
                type: 'HLS'
            }]
        });
        assert.equal(response.ok, true);
        assert.equal(response.accepted, 2);
        assert.equal(response.rejected, 1);

        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 8 });
        assert.equal(state.state.candidates.length, 2);
        assert.equal(state.state.candidates[0].source, 'page_dom');
        assert.equal(state.state.candidates[0].title, 'Film ze strony');
        assert.equal(state.state.candidates[0].quality, 'Auto');
        assert.equal(state.state.candidates[0].referer, undefined);
        assert.equal(state.state.candidates[0].origin, undefined);
        assert.ok(state.state.candidates.some((candidate) =>
            candidate.type === 'MEDIA' && candidate.title === 'Źródło bez rozszerzenia'
        ));
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
    } finally {
        harness.dispose();
    }
});

test('a page-discovered HLS master is scanned in the background into quality variants without autoplay', async () => {
    const tabId = 80;
    const pageUrl = 'https://video.example.com/watch';
    const masterUrl = 'https://cdn.example.com/hls/59633985/master.m3u8?token=signed';
    const fetchCalls = [];
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url, options) {
            fetchCalls.push({ url, options });
            return {
                ok: true,
                url,
                headers: { get: () => null },
                body: null,
                async text() {
                    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160
2160P_12000K_59633985.mp4/index.m3u8?validto=2&hash=first
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720
720P_4000K_59633985.mp4/index.m3u8?validto=2&hash=second`;
                }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        const discovered = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: masterUrl, type: 'HLS', title: 'Film' }]
        }, { frameId: 0, documentId: 'manifest-document', url: pageUrl });
        assert.equal(discovered.ok, true);
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.filter((candidate) => candidate.source === 'manifest_scan').length === 2
        ));

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const variants = state.candidates.filter((candidate) => candidate.source === 'manifest_scan');
        assert.deepEqual(variants.map((candidate) => candidate.quality).sort(), ['2160p', '720p']);
        assert.equal(variants.every((candidate) => candidate.autoEligible === false), true);
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].options.credentials, 'omit');
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: masterUrl, type: 'HLS', title: 'Film' }]
        }, { frameId: 0, documentId: 'manifest-document', url: pageUrl });
        const afterRepeatedSnapshot = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(afterRepeatedSnapshot.candidates
            .filter((candidate) => candidate.source === 'manifest_scan')
            .every((candidate) => candidate.superseded !== true && candidate.diagnosticOnly !== true), true);
    } finally {
        harness.dispose();
    }
});

test('manifest expansion keeps token-only quality variants distinct in final tab state', async () => {
    const tabId = 801;
    const pageUrl = 'https://video.example.com/token-only';
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url, options) {
            assert.equal(options.redirect, 'error');
            return {
                ok: true,
                status: 200,
                url,
                headers: { get: () => null },
                body: null,
                async text() {
                    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
same/index.m3u8?token=full-hd
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
same/index.m3u8?token=hd`;
                }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/master.m3u8?token=master', type: 'HLS' }]
        }, { frameId: 0, documentId: 'token-variants', url: pageUrl });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.filter((candidate) => candidate.source === 'manifest_scan').length === 2
        ));

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const variants = state.candidates.filter((candidate) => candidate.source === 'manifest_scan');
        assert.deepEqual(variants.map((candidate) => candidate.quality).sort(), ['1080p', '720p']);
        assert.equal(new Set(variants.map((candidate) => candidate.id)).size, 2);
    } finally {
        harness.dispose();
    }
});

test('manifest scanner rejects a public redirect to a private destination before a second request', async () => {
    const tabId = 802;
    const pageUrl = 'https://video.example.com/redirect';
    const fetchCalls = [];
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url, options) {
            fetchCalls.push({ url, options });
            return {
                ok: false,
                status: 302,
                url,
                headers: {
                    get(name) {
                        return String(name).toLowerCase() === 'location'
                            ? 'https://127.0.0.1/private/master.m3u8'
                            : null;
                    }
                },
                body: null,
                async text() { return ''; }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/redirect/master.m3u8', type: 'HLS' }]
        }, { frameId: 0, documentId: 'private-redirect', url: pageUrl });
        await waitFor(() => fetchCalls.length === 1);
        await wait(30);

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].options.redirect, 'error');
        assert.equal(state.candidates.some((candidate) => candidate.source === 'manifest_scan'), false);
    } finally {
        harness.dispose();
    }
});

test('a refreshed signed master cannot be overwritten by an older manifest scan', async () => {
    const tabId = 803;
    const pageUrl = 'https://video.example.com/race';
    let releaseOldFetch;
    const fetchCalls = [];
    const responseFor = (url, token) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => null },
        body: null,
        async text() {
            return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8?token=${token}`;
        }
    });
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        fetch(url) {
            fetchCalls.push(url);
            if (url.includes('token=old')) {
                return new Promise((resolve) => { releaseOldFetch = () => resolve(responseFor(url, 'old-child')); });
            }
            return Promise.resolve(responseFor(url, 'fresh-child'));
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        const sender = { frameId: 0, documentId: 'signed-race', url: pageUrl };
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/master.m3u8?token=old', type: 'HLS' }]
        }, sender);
        await waitFor(() => fetchCalls.length === 1 && typeof releaseOldFetch === 'function');

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/master.m3u8?token=fresh', type: 'HLS' }]
        }, sender);
        await waitFor(() => fetchCalls.length === 2);
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.source === 'manifest_scan' && candidate.url.includes('fresh-child'))
        ));
        releaseOldFetch();
        await wait(50);

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const variants = state.candidates.filter((candidate) => candidate.source === 'manifest_scan');
        assert.equal(variants.length, 1);
        assert.match(variants[0].url, /fresh-child/);
        assert.doesNotMatch(variants[0].url, /old-child/);
    } finally {
        harness.dispose();
    }
});

test('manifest timeout prevents a late fetch from committing variants after its deadline', async () => {
    const tabId = 804;
    const pageUrl = 'https://video.example.com/manifest-timeout';
    let releaseFetch;
    let fetchStarted = false;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        manifestFetchTimeoutMs: 25,
        fetch(url) {
            fetchStarted = true;
            return new Promise((resolve) => {
                releaseFetch = () => resolve({
                    ok: true,
                    status: 200,
                    url,
                    headers: { get: () => null },
                    body: null,
                    async text() {
                        return '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\n720/index.m3u8';
                    }
                });
            });
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/slow/master.m3u8', type: 'HLS' }]
        }, { frameId: 0, documentId: 'manifest-timeout', url: pageUrl });
        await waitFor(() => fetchStarted && typeof releaseFetch === 'function');
        await wait(50);
        releaseFetch();
        await wait(50);

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.candidates.some((candidate) => candidate.source === 'manifest_scan'), false);
    } finally {
        harness.dispose();
    }
});

test('manifest response above one MiB is rejected before variant parsing', async () => {
    const tabId = 805;
    const pageUrl = 'https://video.example.com/oversized-manifest';
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url) {
            return {
                ok: true,
                status: 200,
                url,
                headers: { get: () => null },
                body: null,
                async text() {
                    return `#EXTM3U\n${'x'.repeat((1024 * 1024) + 1)}`;
                }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/large/master.m3u8', type: 'HLS' }]
        }, { frameId: 0, documentId: 'manifest-size', url: pageUrl });
        await wait(60);

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.candidates.some((candidate) => candidate.source === 'manifest_scan'), false);
    } finally {
        harness.dispose();
    }
});

test('aggressive manifest scanning has a hard twelve-attempt budget per navigation', async () => {
    const tabId = 806;
    const pageUrl = 'https://video.example.com/many-masters';
    const fetchCalls = [];
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url) {
            fetchCalls.push(url);
            return {
                ok: true,
                status: 200,
                url,
                headers: { get: () => null },
                body: null,
                async text() { return '#EXTM3U\n'; }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: Array.from({ length: 20 }, (_value, index) => ({
                url: `https://cdn${index}.example.com/video/master.m3u8?token=${index}`,
                type: 'HLS'
            }))
        }, { frameId: 0, documentId: 'many-masters', url: pageUrl });
        await waitFor(() => fetchCalls.length === 12);
        await wait(100);

        assert.equal(fetchCalls.length, 12);
    } finally {
        harness.dispose();
    }
});

test('global manifest concurrency queues a ninth tab and drains it fairly when a slot opens', async () => {
    const fetchCalls = [];
    const releases = [];
    const tabUrls = new Map(Array.from({ length: 9 }, (_value, index) => [
        820 + index,
        `https://video${index}.example.com/watch`
    ]));
    const harness = createHarness({
        tabUrls,
        async fetch(url) {
            fetchCalls.push(url);
            return new Promise((resolve) => {
                releases.push(() => resolve({
                    ok: true,
                    status: 200,
                    url,
                    headers: { get: () => null },
                    body: null,
                    async text() { return '#EXTM3U\n'; }
                }));
            });
        }
    });
    try {
        await harness.ready();
        for (let index = 0; index < 9; index += 1) {
            const tabId = 820 + index;
            const pageUrl = tabUrls.get(tabId);
            harness.fire('tabCreated', { id: tabId, url: pageUrl });
            await harness.message({
                type: 'PAGE_MEDIA_DISCOVERED',
                tabId,
                page: { url: pageUrl },
                media: [{
                    url: `https://cdn${index}.example.com/master.m3u8`,
                    type: 'HLS'
                }]
            }, { frameId: 0, documentId: `queued-${index}`, url: pageUrl });
        }

        await waitFor(() => fetchCalls.length === 8);
        assert.equal(fetchCalls.includes('https://cdn8.example.com/master.m3u8'), false);
        const releaseFirst = releases.shift();
        assert.equal(typeof releaseFirst, 'function');
        releaseFirst();
        await waitFor(() => fetchCalls.includes('https://cdn8.example.com/master.m3u8'));
        assert.equal(fetchCalls.length, 9);
    } finally {
        for (const release of releases.splice(0)) release();
        await wait(20);
        harness.dispose();
    }
});

test('a confirmed network child promotes the manifest candidate and keeps fresh transport plus completeness', async () => {
    const tabId = 807;
    const pageUrl = 'https://video.example.com/promote-child';
    const masterUrl = 'https://cdn.example.com/movie/master.m3u8?token=master';
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url) {
            return {
                ok: true,
                status: 200,
                url,
                headers: { get: () => null },
                body: null,
                async text() {
                    if (url !== masterUrl) return '#EXTM3U\n';
                    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8?token=manifest-old`;
                }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        const sender = { frameId: 0, documentId: 'promote-child', url: pageUrl };
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: masterUrl, type: 'HLS' }]
        }, sender);
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.source === 'manifest_scan')
        ));

        const freshChildUrl = 'https://cdn.example.com/movie/720/index.m3u8?token=network-fresh';
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'confirmed-manifest-child',
            url: freshChildUrl,
            timeStamp: Date.now() + 1_000
        }), { pageHostname: 'video.example.com' });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === freshChildUrl && candidate.statusCode === 200)
        ));

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const children = state.candidates.filter((candidate) => candidate.url.includes('/720/index.m3u8'));
        assert.equal(children.length, 1);
        assert.equal(children[0].url, freshChildUrl);
        assert.equal(children[0].sourceMethod, 'network');
        assert.equal(children[0].statusCode, 200);
        assert.equal(children[0].role, 'variant');
        assert.equal(children[0].mediaKind, 'muxed');
        assert.equal(children[0].hasAudio, true);
        assert.equal(children[0].hasVideo, true);
        assert.equal(children[0].prerollProvisional, false);
        assert.equal(children[0].recommended, true);
        assert.ok(children[0].sources.includes('manifest_scan'));
        assert.ok(children[0].sources.includes('response_headers'));
    } finally {
        harness.dispose();
    }
});

test('page discovery keeps token-only quality renditions separate and reconciles them by synthetic identity', async () => {
    const tabId = 809;
    const pageUrl = 'https://video.example.com/page-renditions';
    const sender = { frameId: 0, documentId: 'page-renditions', url: pageUrl };
    const harness = createHarness({ tabUrls: new Map([[tabId, pageUrl]]) });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        const response = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{
                url: 'https://cdn.example.com/movie/index.m3u8?token=full-hd',
                type: 'HLS',
                quality: '1080p',
                height: 1080
            }, {
                url: 'https://cdn.example.com/movie/index.m3u8?token=hd',
                type: 'HLS',
                quality: '720p',
                height: 720
            }]
        }, sender);
        assert.equal(response.accepted, 2);

        let state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        let renditions = state.candidates.filter((candidate) => candidate.url.includes('/movie/index.m3u8'));
        assert.equal(renditions.length, 2, JSON.stringify(renditions.map((candidate) => ({
            id: candidate.id,
            groupKey: candidate.groupKey,
            url: candidate.url,
            height: candidate.height,
            source: candidate.source,
            sourceMethod: candidate.sourceMethod,
            manifestDerived: candidate.manifestDerived,
            networkObserved: candidate.networkObserved,
            statusCode: candidate.statusCode
        })), null, 2));
        assert.deepEqual(renditions.map((candidate) => candidate.height).sort((a, b) => b - a), [1080, 720]);
        assert.equal(renditions.every((candidate) => candidate.pageSnapshotKeys.length === 1), true);

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{
                url: 'https://cdn.example.com/movie/index.m3u8?token=full-hd-refreshed',
                type: 'HLS',
                quality: '1080p',
                height: 1080
            }]
        }, sender);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        renditions = state.candidates.filter((candidate) => candidate.url.includes('/movie/index.m3u8'));
        assert.equal(renditions.length, 1);
        assert.equal(renditions[0].height, 1080);
        assert.match(renditions[0].url, /full-hd-refreshed/);
    } finally {
        harness.dispose();
    }
});

test('network confirmations preserve two token-only manifest qualities in either observation order', async () => {
    const tabId = 810;
    const pageUrl = 'https://video.example.com/two-manifest-renditions';
    const masterUrl = 'https://cdn.example.com/movie/master.m3u8?token=master';
    const fullHdUrl = 'https://cdn.example.com/movie/same/index.m3u8?token=full-hd';
    const hdUrl = 'https://cdn.example.com/movie/same/index.m3u8?token=hd';
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url) {
            return {
                ok: true,
                status: 200,
                url,
                headers: { get: () => null },
                body: null,
                async text() {
                    if (url !== masterUrl) return '#EXTM3U\n';
                    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
${fullHdUrl}
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
${hdUrl}`;
                }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'network-full-hd-first',
            url: fullHdUrl,
            timeStamp: Date.now()
        }), { pageHostname: 'video.example.com' });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === fullHdUrl && candidate.statusCode === 200)
        ));

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: masterUrl, type: 'HLS' }]
        }, { frameId: 0, documentId: 'two-manifest-renditions', url: pageUrl });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.filter((candidate) => candidate.url.includes('/same/index.m3u8')).length === 2
        ));

        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'network-hd-second',
            url: hdUrl,
            timeStamp: Date.now() + 1_000
        }), { pageHostname: 'video.example.com' });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === hdUrl && candidate.statusCode === 200)
        ));

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{
                url: hdUrl,
                type: 'HLS',
                playerKeys: ['main-video'],
                currentPlayerKeys: ['main-video']
            }]
        }, { frameId: 0, documentId: 'two-manifest-renditions', url: pageUrl });

        const refreshedFullHdUrl = 'https://cdn.example.com/movie/same/index.m3u8?token=full-hd-refreshed';
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'network-full-hd-refreshed',
            url: refreshedFullHdUrl,
            timeStamp: Date.now() + 2_000
        }), { pageHostname: 'video.example.com' });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === refreshedFullHdUrl && candidate.statusCode === 200)
        ));

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const renditions = state.candidates.filter((candidate) => candidate.url.includes('/same/index.m3u8'));
        assert.equal(renditions.length, 2, JSON.stringify(renditions.map((candidate) => ({
            id: candidate.id,
            groupKey: candidate.groupKey,
            url: candidate.url,
            height: candidate.height,
            source: candidate.source,
            sourceMethod: candidate.sourceMethod,
            manifestDerived: candidate.manifestDerived,
            networkObserved: candidate.networkObserved,
            statusCode: candidate.statusCode
        })), null, 2));
        assert.deepEqual(renditions.map((candidate) => candidate.height).sort((a, b) => b - a), [1080, 720]);
        assert.deepEqual(renditions.map((candidate) => candidate.statusCode), [200, 200]);
        assert.equal(renditions.some((candidate) => candidate.url === refreshedFullHdUrl), true);
        assert.equal(renditions.some((candidate) => candidate.url === hdUrl), true);
        const fullHd = renditions.find((candidate) => candidate.height === 1080);
        const hd = renditions.find((candidate) => candidate.height === 720);
        assert.equal(fullHd.currentPlayerKeys.length, 0);
        assert.equal(hd.currentPlayerKeys.length, 1);
        assert.equal(hd.diagnosticOnly, false);
        assert.notEqual(hd.diagnosticReason, 'MANIFEST_TRANSPORT_REPLACED');
    } finally {
        harness.dispose();
    }
});

test('a late manifest scan enriches an already confirmed exact network child without replacing transport', async () => {
    const tabId = 808;
    const pageUrl = 'https://video.example.com/network-first';
    const childUrl = 'https://cdn.example.com/movie/720/index.m3u8?token=already-confirmed';
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        async fetch(url) {
            return {
                ok: true,
                status: 200,
                url,
                headers: { get: () => null },
                body: null,
                async text() {
                    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
${childUrl}`;
                }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'network-first-child',
            url: childUrl,
            timeStamp: 60_000
        }), { pageHostname: 'video.example.com' });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === childUrl && candidate.statusCode === 200)
        ));

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: 'https://cdn.example.com/movie/master.m3u8?token=master', type: 'HLS' }]
        }, { frameId: 0, documentId: 'network-first', url: pageUrl });
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) =>
                candidate.url === childUrl && candidate.manifestDerived === true && candidate.mediaKind === 'muxed'
            )
        ));

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const children = state.candidates.filter((candidate) => candidate.url === childUrl);
        assert.equal(children.length, 1);
        assert.equal(children[0].sourceMethod, 'network');
        assert.equal(children[0].statusCode, 200);
        assert.equal(children[0].role, 'variant');
        assert.equal(children[0].mediaKind, 'muxed');
        assert.equal(children[0].autoEligible, undefined);
        assert.ok(children[0].sources.includes('manifest_scan'));
        assert.ok(children[0].sources.includes('response_headers'));
    } finally {
        harness.dispose();
    }
});

test('manual resolver uses the trusted tab URL and merges provenance without weakening a network candidate', async () => {
    const pageUrl = 'https://sport.tvp.pl/95063559/material?view=article#player';
    const networkUrl = 'https://cdn.test/live/master.m3u8?token=network';
    const harness = createHarness({
        tabUrls: new Map([[81, pageUrl]]),
        nativeResponder(request) {
            if (request.action !== 'resolve') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.0-test',
                    ok: true,
                    action: request.action,
                    requestId: request.requestId,
                    mpv: { available: true },
                    queue: { state: 'stopped', responsive: false }
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'found',
                resolver: 'streamlink',
                attempted: [{
                    resolver: 'streamlink',
                    status: 'found',
                    available: true,
                    compatible: true,
                    version: '8.4.0',
                    count: 2
                }],
                candidates: [{
                    resolver: 'streamlink',
                    url: 'https://cdn.test/live/master.m3u8?token=resolver-refresh',
                    type: 'HLS',
                    quality: 'Auto',
                    title: 'Materiał TVP',
                    live: false
                }, {
                    resolver: 'streamlink',
                    url: 'https://cdn.test/movie-720p.mp4?signature=resolver',
                    type: 'MP4',
                    quality: '720p',
                    title: 'Materiał TVP',
                    live: false
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 81, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 81,
            requestId: 'resolver-network-master',
            url: networkUrl,
            timeStamp: 40_000
        }), { pageHostname: 'sport.tvp.pl' });
        await wait(100);

        const response = await harness.message({
            type: 'RESOLVE_PAGE',
            tabId: 81,
            pageUrl: 'https://attacker.invalid/ignored'
        }, harness.popupSender);
        assert.equal(response.ok, true);
        assert.equal(response.result.status, 'found');

        const request = harness.nativeMessages.find((message) => message.action === 'resolve');
        assert.equal(request.pageUrl, 'https://sport.tvp.pl/95063559/material?view=article');
        assert.equal(request.adapter, 'tvp');
        assert.deepEqual(request.resolverOrder, ['streamlink', 'yt-dlp']);
        assert.deepEqual(request.cookies, []);

        const state = response.state;
        assert.equal(state.resolver.state, 'found');
        assert.equal(state.platform.id, 'tvp');
        assert.equal(state.candidates.length, 2);
        const networkCandidate = state.candidates.find((candidate) => candidate.groupKey.includes('master.m3u8'));
        assert.equal(networkCandidate.url, networkUrl);
        assert.equal(networkCandidate.source, 'response_headers');
        assert.equal(networkCandidate.statusCode, 200);
        assert.equal(networkCandidate.userAgent, 'Integration-Test/1.0');
        assert.ok(networkCandidate.sources.includes('resolver_streamlink'));
        assert.ok(state.candidates.some((candidate) => candidate.source === 'resolver_streamlink'));
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
    } finally {
        harness.dispose();
    }
});

test('TVP adapter resolves the same-origin video page linked by the loaded article', async () => {
    const articleUrl = 'https://sport.tvp.pl/95063559/nie-bylo-powtorki-z-rozrywki';
    const videoUrl = 'https://sport.tvp.pl/95065681/fc-thun-lech-poznan-skrot';
    const harness = createHarness({
        tabUrls: new Map([[85, articleUrl]]),
        platformTargets: [
            videoUrl,
            'https://attacker.example/95065682/ignored',
            'https://sport.tvp.pl/not-a-video'
        ],
        nativeResponder(request) {
            return {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: request.action,
                requestId: request.requestId,
                status: 'found',
                resolver: 'streamlink',
                attempted: [
                    { resolver: 'streamlink', status: 'found', available: true, compatible: true, version: '8.5.0', count: 1 }
                ],
                candidates: [{
                    resolver: 'streamlink',
                    url: 'https://cdn.tvp.test/video.mpd?token=fresh',
                    type: 'DASH',
                    quality: 'Auto',
                    title: 'Skrót meczu',
                    role: 'master'
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 85, url: articleUrl });
        const response = await harness.message({ type: 'RESOLVE_PAGE', tabId: 85 }, harness.popupSender);

        assert.equal(response.ok, true);
        const nativeRequest = harness.nativeMessages.find((message) => message.action === 'resolve');
        assert.equal(nativeRequest.pageUrl, videoUrl);
        assert.equal(nativeRequest.adapter, 'tvp');
        assert.deepEqual(nativeRequest.cookies, []);
        assert.deepEqual(harness.platformMessages, [{
            tabId: 85,
            message: { type: 'GET_PLATFORM_RESOLVER_TARGETS' },
            options: { frameId: 0 }
        }]);
        assert.equal(response.state.hostname, 'sport.tvp.pl');
        assert.equal(response.state.candidates.length, 1);
        assert.equal(response.state.candidates[0].source, 'resolver_streamlink');
    } finally {
        harness.dispose();
    }
});

test('context menu opens the existing recommended content and never selects an advertisement', async () => {
    const pageUrl = 'https://sport.tvp.pl/95063559/article';
    const advertisementUrl = 'https://media.test/ads/preroll/ad.mp4';
    const contentUrl = 'https://media.test/video/program/video.ism/video-fmp4.m3u8';
    const harness = createHarness({
        localData: {
            siteAutoLaunch: {},
            resolverCookieSites: {},
            defaultPlayMode: 'replace',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[86, pageUrl]])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 86, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 86,
            requestId: 'context-advertisement',
            url: advertisementUrl,
            type: 'media',
            timeStamp: 50_000
        }), { pageHostname: 'sport.tvp.pl', contentType: 'video/mp4' });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 86,
            requestId: 'context-content',
            url: contentUrl,
            timeStamp: 51_000
        }), { pageHostname: 'sport.tvp.pl' });
        await wait(100);

        assert.equal(harness.nativeMessages.length, 0);
        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 86, url: pageUrl });
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'play'));

        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 0);
        const play = harness.nativeMessages.find((message) => message.action === 'play');
        assert.equal(play.stream.url, contentUrl);
        assert.equal(play.mode, 'replace');
        assert.equal(play.source, 'manual');
        assert.notEqual(play.stream.url, advertisementUrl);
    } finally {
        harness.dispose();
    }
});

test('context menu resolves only after its click, reselects safely, and uses the default mode', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const advertisementUrl = 'https://cdn.example.test/ads/preroll/master.m3u8';
    const contentUrl = 'https://cdn.example.test/show/master.m3u8';
    const harness = createHarness({
        localData: {
            siteAutoLaunch: {},
            resolverCookieSites: {},
            defaultPlayMode: 'append',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[87, pageUrl]]),
        nativeResponder(request) {
            if (request.action === 'resolve') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.0-test',
                    ok: true,
                    action: 'resolve',
                    requestId: request.requestId,
                    status: 'found',
                    resolver: 'streamlink',
                    attempted: [{
                        resolver: 'streamlink',
                        status: 'found',
                        available: true,
                        compatible: true,
                        version: '8.5.0',
                        count: 2
                    }],
                    candidates: [{
                        resolver: 'streamlink',
                        url: advertisementUrl,
                        type: 'HLS',
                        quality: 'Auto',
                        role: 'master'
                    }, {
                        resolver: 'streamlink',
                        url: contentUrl,
                        type: 'HLS',
                        quality: 'Auto',
                        role: 'master'
                    }],
                    truncated: false
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: 'play',
                requestId: request.requestId,
                confirmed: true,
                mode: request.mode,
                confirmation: 'test'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 87, url: pageUrl });
        await wait(50);
        assert.equal(harness.nativeMessages.length, 0);

        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 87, url: pageUrl });
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'play').length === 1);

        assert.deepEqual(harness.nativeMessages.map((message) => message.action), ['resolve', 'play']);
        const play = harness.nativeMessages[1];
        assert.equal(play.stream.url, contentUrl);
        assert.equal(play.mode, 'append');
        assert.equal(play.source, 'manual');
    } finally {
        harness.dispose();
    }
});

test('YouTube context menu selects only current resolve IDs over old resolver and network masters', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
    const networkUrl = 'https://rr.example.test/videoplayback?id=stale-network';
    const oldMasterUrl = 'https://media.example.test/youtube/old-master.m3u8';
    const audioUrl = 'https://media.example.test/youtube/audio.webm';
    const resolvedVideoUrl = 'https://media.example.test/youtube/video.mp4';
    let resolveAttempt = 0;
    const harness = createHarness({
        tabUrls: new Map([[89, pageUrl]]),
        nativeResponder(request) {
            if (request.action === 'resolve') {
                resolveAttempt += 1;
                const pageCandidate = {
                    resolver: 'yt-dlp',
                    url: pageUrl,
                    type: 'MEDIA',
                    role: 'master',
                    title: 'Big Buck Bunny',
                    language: 'pl-PL',
                    mediaKind: 'adaptive',
                    hasAudio: true,
                    hasVideo: true,
                    formatId: 'yt-dlp-page',
                    playbackKind: 'yt-dlp-page'
                };
                const candidates = resolveAttempt === 1 ? [pageCandidate, {
                    resolver: 'yt-dlp',
                    url: oldMasterUrl,
                    type: 'HLS',
                    role: 'master',
                    title: 'Stary wynik'
                }] : [pageCandidate, {
                    resolver: 'yt-dlp',
                    url: audioUrl,
                    type: 'WEBM',
                    role: 'audio',
                    title: 'Big Buck Bunny'
                }, {
                    resolver: 'yt-dlp',
                    url: resolvedVideoUrl,
                    type: 'MP4',
                    role: 'direct',
                    title: 'Big Buck Bunny'
                }];
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.1-test',
                    ok: true,
                    action: 'resolve',
                    requestId: request.requestId,
                    status: 'found',
                    resolver: 'yt-dlp',
                    attempted: [{
                        resolver: 'yt-dlp',
                        status: 'found',
                        available: true,
                        compatible: true,
                        version: '2026.08.19',
                        count: candidates.length
                    }],
                    candidates,
                    truncated: false
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.1-test',
                ok: true,
                action: 'play',
                requestId: request.requestId,
                confirmed: true,
                mode: request.mode,
                confirmation: 'test'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 89, url: pageUrl });
        const seeded = await harness.message({ type: 'RESOLVE_PAGE', tabId: 89 }, harness.popupSender);
        assert.equal(seeded.ok, true);
        assert.equal(Object.hasOwn(seeded, 'freshCandidateIds'), false);
        assert.equal(Object.hasOwn(seeded.result, 'freshCandidateIds'), false);
        emitConfirmedMedia(harness, requestDetails({
            tabId: 89,
            requestId: 'youtube-existing-videoplayback',
            url: networkUrl,
            type: 'media',
            timeStamp: 60_000
        }), { pageHostname: 'www.youtube.com', contentType: 'application/vnd.apple.mpegurl' });
        await wait(75);

        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 89, url: pageUrl });
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'play').length === 1);

        assert.deepEqual(harness.nativeMessages.map((message) => message.action), ['resolve', 'resolve', 'play']);
        const resolve = harness.nativeMessages[1];
        const play = harness.nativeMessages[2];
        assert.deepEqual(resolve.resolverOrder, ['yt-dlp', 'streamlink']);
        assert.equal(play.stream.url, pageUrl);
        assert.equal(play.stream.playbackKind, 'yt-dlp-page');
        assert.notEqual(play.stream.url, networkUrl);
        assert.notEqual(play.stream.url, audioUrl);

        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 89 });
        const resolvedVideo = state.state.candidates.find((candidate) => candidate.url === resolvedVideoUrl);
        const audio = state.state.candidates.find((candidate) => candidate.url === audioUrl);
        const network = state.state.candidates.find((candidate) => candidate.url === networkUrl);
        const oldMaster = state.state.candidates.find((candidate) => candidate.url === oldMasterUrl);
        const page = state.state.candidates.find((candidate) => candidate.url === pageUrl);
        assert.equal(page.diagnosticOnly, false);
        assert.equal(page.playbackKind, 'yt-dlp-page');
        assert.equal(resolvedVideo.role, 'direct');
        assert.equal(resolvedVideo.resolverRole, 'direct');
        assert.equal(resolvedVideo.diagnosticOnly, true);
        assert.equal(audio.role, 'audio');
        assert.equal(audio.resolverRole, 'audio');
        assert.equal(network.role, 'master');
        assert.equal(network.diagnosticOnly, true);
        assert.ok(network.score > resolvedVideo.score);
        assert.equal(oldMaster, undefined, 'a successful resolve replaces the previous resolver batch');
    } finally {
        harness.dispose();
    }
});

test('loaded active YouTube tab prepares one resolver batch without cookies or autoplay', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4&utm_source=test';
    const harness = createHarness({
        tabUrls: new Map([[90, pageUrl]]),
        activeTabIds: [90],
        acceptLanguages: ['pl_PL', 'en-US', 'pl-PL', 'bad tag'],
        pageReadyDebounceMs: 10,
        nativeResponder(request) {
            if (request.action === 'resolve') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.2-test',
                    ok: true,
                    action: 'resolve',
                    requestId: request.requestId,
                    status: 'found',
                    resolver: 'yt-dlp',
                    attempted: [{ resolver: 'yt-dlp', status: 'found', available: true, compatible: true, version: '2026.08.28', count: 2 }],
                    candidates: [{
                        resolver: 'yt-dlp',
                        url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
                        type: 'MEDIA',
                        role: 'master',
                        title: 'Big Buck Bunny',
                        language: 'pl-PL',
                        mediaKind: 'adaptive',
                        hasAudio: true,
                        hasVideo: true,
                        formatId: 'yt-dlp-page',
                        playbackKind: 'yt-dlp-page'
                    }, {
                        resolver: 'yt-dlp',
                        url: 'https://media.example.test/youtube/master.m3u8',
                        type: 'HLS',
                        role: 'master',
                        title: 'Big Buck Bunny',
                        language: 'pl-PL',
                        mediaKind: 'adaptive',
                        hasAudio: true,
                        hasVideo: true,
                        formatId: 'hls-master'
                    }],
                    truncated: false
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.2-test',
                ok: true,
                action: 'play',
                requestId: request.requestId,
                confirmed: true,
                mode: request.mode,
                confirmation: 'test'
            };
        }
    });
    try {
        await harness.ready();
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'resolve'));
        const resolve = harness.nativeMessages.find((message) => message.action === 'resolve');
        assert.equal(resolve.source, 'page_ready');
        assert.deepEqual(resolve.cookies, []);
        assert.deepEqual(resolve.preferredLanguages, ['pl-PL', 'en-US']);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);

        emitConfirmedMedia(harness, requestDetails({
            tabId: 90,
            requestId: 'youtube-raw-diagnostic',
            url: 'https://rr.example.test/videoplayback?id=prefetch',
            type: 'media',
            timeStamp: 61_000
        }), { pageHostname: 'www.youtube.com', contentType: 'video/mp4' });
        await wait(80);

        let state = await harness.message({ type: 'GET_TAB_STATE', tabId: 90 });
        assert.equal(state.state.platform.id, 'youtube');
        assert.equal(state.state.materialScope.id, 'youtube:watch:YE7VzlLtp-4');
        const primary = state.state.candidates.find((candidate) => candidate.resolverCurrent === true);
        const diagnostic = state.state.candidates.find((candidate) => candidate.url.includes('videoplayback'));
        assert.equal(primary.diagnosticOnly, false);
        assert.equal(primary.playbackKind, 'yt-dlp-page');
        assert.equal(primary.language, 'pl-PL');
        assert.equal(primary.mediaKind, 'adaptive');
        assert.equal(diagnostic.diagnosticOnly, true);
        assert.equal(diagnostic.recommended, false);

        const played = await harness.message(
            { type: 'PLAY', tabId: 90, candidateId: primary.id, mode: 'new' },
            harness.popupSender
        );
        assert.equal(played.ok, true);
        const play = harness.nativeMessages.find((message) => message.action === 'play');
        assert.equal(play.stream.language, 'pl-PL');
        assert.equal(play.stream.playbackKind, 'yt-dlp-page');

        harness.tabUrls.set(90, 'https://www.youtube.com/watch?v=YE7VzlLtp-4&t=90&list=PL123');
        harness.fire('tabUpdated', 90, { url: harness.tabUrls.get(90) }, { id: 90, url: harness.tabUrls.get(90), active: true, windowId: 1 });
        harness.fire('tabUpdated', 90, { status: 'complete' }, { id: 90, url: harness.tabUrls.get(90), active: true, windowId: 1 });
        await wait(60);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 90 });
        assert.equal(state.state.materialScope.id, 'youtube:watch:YE7VzlLtp-4');
    } finally {
        harness.dispose();
    }
});

test('loaded active TVP asset page prepares one Streamlink-first resolver batch without cookies or autoplay', async () => {
    const tabId = 96;
    const pageUrl = 'https://sport.tvp.pl/95063559/material?view=article#player';
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        cookies: [{ name: 'session', value: 'must-not-be-used', domain: '.tvp.pl', path: '/' }],
        acceptLanguages: ['pl_PL', 'en-US'],
        pageReadyDebounceMs: 10,
        nativeResponder(request) {
            if (request.action === 'resolve') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: true,
                    action: 'resolve',
                    requestId: request.requestId,
                    status: 'found',
                    resolver: 'streamlink',
                    attempted: [{ resolver: 'streamlink', status: 'found', available: true, compatible: true, version: '8.5.0', count: 1 }],
                    candidates: [{
                        resolver: 'streamlink',
                        url: 'https://media.example.test/tvp/master.m3u8',
                        type: 'HLS',
                        role: 'master',
                        title: 'Materiał TVP',
                        language: 'pl-PL',
                        mediaKind: 'adaptive',
                        hasAudio: true,
                        hasVideo: true
                    }],
                    truncated: false
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'play',
                requestId: request.requestId,
                confirmed: true,
                mode: request.mode,
                confirmation: 'test'
            };
        }
    });
    try {
        await harness.ready();
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'resolve'));

        const resolve = harness.nativeMessages.find((message) => message.action === 'resolve');
        assert.equal(resolve.source, 'page_ready');
        assert.equal(resolve.pageUrl, 'https://sport.tvp.pl/95063559/material?view=article');
        assert.equal(resolve.adapter, 'tvp');
        assert.deepEqual(resolve.resolverOrder, ['streamlink', 'yt-dlp']);
        assert.deepEqual(resolve.cookies, []);
        assert.deepEqual(resolve.preferredLanguages, ['pl-PL', 'en-US']);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);

        let state = await harness.message({ type: 'GET_TAB_STATE', tabId });
        assert.equal(state.state.platform.id, 'tvp');
        assert.equal(state.state.materialScope.id, 'tvp:asset:95063559');
        assert.equal(state.state.resolver.source, 'page_ready');
        assert.equal(state.state.resolver.pageReadyScope, 'tvp:asset:95063559');
        assert.equal(state.state.resolver.pageReadyState, 'done');
        const primary = state.state.candidates.find((candidate) => candidate.resolverCurrent === true);
        assert.equal(primary.source, 'resolver_streamlink');
        assert.equal(primary.autoEligible, false);

        harness.tabUrls.set(tabId, 'https://sport.tvp.pl/95063559/material?view=video');
        harness.fire('tabUpdated', tabId, { url: harness.tabUrls.get(tabId) }, { id: tabId, url: harness.tabUrls.get(tabId), active: true, windowId: 1 });
        harness.fire('tabUpdated', tabId, { status: 'complete' }, { id: tabId, url: harness.tabUrls.get(tabId), active: true, windowId: 1 });
        harness.fire('tabActivated', { tabId, windowId: 1 });
        await wait(60);

        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId });
        assert.equal(state.state.materialScope.id, 'tvp:asset:95063559');
    } finally {
        harness.dispose();
    }
});

test('page-ready resolver excludes TVP routes without a numeric asset and generic numeric routes', async () => {
    const tabUrls = new Map([
        [97, 'https://www.tvp.pl/sport/transmisje'],
        [98, 'https://video.example.test/123456/material']
    ]);
    const harness = createHarness({
        tabUrls,
        activeTabIds: [97, 98],
        pageReadyDebounceMs: 10
    });
    try {
        await harness.ready();
        for (const [tabId, url] of tabUrls) {
            harness.fire('tabUpdated', tabId, { status: 'complete' }, { id: tabId, url, active: true, windowId: tabId });
        }
        await wait(40);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 0);
    } finally {
        harness.dispose();
    }
});

test('YouTube context menu shares an in-flight page-ready resolve instead of failing busy', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
    const resolvedUrl = 'https://media.example.test/youtube/coalesced-master.m3u8';
    const harness = createHarness({
        tabUrls: new Map([[95, pageUrl]]),
        activeTabIds: [95],
        pageReadyDebounceMs: 10,
        nativeDelayMs: 120,
        nativeResponder(request) {
            if (request.action === 'resolve') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.2-test',
                    ok: true,
                    action: 'resolve',
                    requestId: request.requestId,
                    status: 'found',
                    resolver: 'yt-dlp',
                    attempted: [{ resolver: 'yt-dlp', status: 'found', available: true, compatible: true, version: '2026.08.28', count: 2 }],
                    candidates: [{
                        resolver: 'yt-dlp',
                        url: pageUrl,
                        type: 'MEDIA',
                        role: 'master',
                        language: 'pl-PL',
                        mediaKind: 'adaptive',
                        hasAudio: true,
                        hasVideo: true,
                        formatId: 'yt-dlp-page',
                        playbackKind: 'yt-dlp-page'
                    }, {
                        resolver: 'yt-dlp',
                        url: resolvedUrl,
                        type: 'HLS',
                        role: 'master',
                        language: 'pl-PL',
                        mediaKind: 'adaptive',
                        hasAudio: true,
                        hasVideo: true
                    }],
                    truncated: false
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.2-test',
                ok: true,
                action: 'play',
                requestId: request.requestId,
                confirmed: true,
                mode: request.mode,
                confirmation: 'test'
            };
        }
    });
    try {
        await harness.ready();
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'resolve').length === 1);
        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 95, url: pageUrl, active: true, windowId: 1 });
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'play').length === 1);

        assert.deepEqual(harness.nativeMessages.map((message) => message.action), ['resolve', 'play']);
        const play = harness.nativeMessages.find((message) => message.action === 'play');
        assert.equal(play.source, 'manual');
        assert.equal(play.stream.url, pageUrl);
        assert.equal(play.stream.language, 'pl-PL');
        assert.equal(play.stream.playbackKind, 'yt-dlp-page');
    } finally {
        harness.dispose();
    }
});

test('background YouTube tab waits for activation before page-ready resolve', async () => {
    const pageUrl = 'https://www.youtube.com/shorts/dQw4w9WgXcQ';
    const harness = createHarness({
        tabUrls: new Map([[91, pageUrl]]),
        pageReadyDebounceMs: 10,
        nativeResponder(request) {
            return {
                protocolVersion: 2,
                hostVersion: '3.4.2-test',
                ok: true,
                action: request.action,
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [
                    { resolver: 'yt-dlp', status: 'empty', available: true, compatible: true, version: '2026.08.28', count: 0 },
                    { resolver: 'streamlink', status: 'empty', available: true, compatible: true, version: '8.5.0', count: 0 }
                ],
                candidates: [],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabUpdated', 91, { status: 'complete' }, { id: 91, url: pageUrl, active: false, windowId: 1 });
        await wait(40);
        assert.equal(harness.nativeMessages.length, 0);

        harness.activeTabIds.add(91);
        harness.fire('tabActivated', { tabId: 91, windowId: 1 });
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'resolve'));
        assert.equal(harness.nativeMessages[0].source, 'page_ready');
    } finally {
        harness.dispose();
    }
});

test('incomplete YouTube resolver tracks stay diagnostic and cannot become ready media', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
    const harness = createHarness({
        tabUrls: new Map([[94, pageUrl]]),
        activeTabIds: [94],
        pageReadyDebounceMs: 10,
        nativeResponder(request) {
            return {
                protocolVersion: 2,
                hostVersion: '3.4.2-test',
                ok: true,
                action: request.action,
                requestId: request.requestId,
                status: 'found',
                resolver: 'yt-dlp',
                attempted: [{ resolver: 'yt-dlp', status: 'found', available: true, compatible: true, version: '2026.08.28', count: 2 }],
                candidates: [
                    {
                        resolver: 'yt-dlp',
                        url: 'https://media.example.test/youtube/video-only.mp4',
                        type: 'MP4',
                        role: 'direct',
                        mediaKind: 'video-only',
                        hasAudio: false,
                        hasVideo: true
                    },
                    {
                        resolver: 'yt-dlp',
                        url: 'https://media.example.test/youtube/audio-only.m4a',
                        type: 'MP4',
                        role: 'audio',
                        mediaKind: 'audio-only',
                        hasAudio: true,
                        hasVideo: false,
                        language: 'pl'
                    }
                ],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'resolve'));
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 94 });
        assert.equal(state.state.candidates.length, 2);
        assert.equal(state.state.candidates.every((candidate) => candidate.diagnosticOnly === true), true);
        assert.equal(state.state.candidates.some((candidate) => candidate.recommended === true), false);

        const play = await harness.message({
            type: 'PLAY',
            tabId: 94,
            candidateId: state.state.candidates[0].id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(play.ok, false);
        assert.equal(play.errorCode, 'DIAGNOSTIC_SOURCE_BLOCKED');
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
    } finally {
        harness.dispose();
    }
});

test('foreign YouTube iframe remains diagnostic and cannot be played', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
    const harness = createHarness({ tabUrls: new Map([[92, pageUrl]]) });
    try {
        await harness.ready();
        harness.fire('beforeRequest', requestDetails({
            tabId: 92,
            requestId: 'youtube-main-frame',
            url: pageUrl,
            type: 'main_frame',
            timeStamp: 62_000
        }));
        await wait(60);
        const discovered = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            page: { url: 'https://ads.example/frame' },
            media: [{ url: 'https://ads-cdn.example/promo/master.m3u8', type: 'HLS', title: 'Promo' }]
        }, {
            tab: { id: 92 },
            frameId: 7,
            documentId: 'foreign-frame',
            url: 'https://ads.example/frame'
        });
        assert.equal(discovered.accepted, 1);
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 92 });
        assert.equal(state.state.candidates[0].diagnosticOnly, true);
        assert.equal(state.state.candidates[0].recommended, false);
        const play = await harness.message(
            { type: 'PLAY', tabId: 92, candidateId: state.state.candidates[0].id, mode: 'new' },
            harness.popupSender
        );
        assert.equal(play.ok, false);
        assert.equal(play.errorCode, 'DIAGNOSTIC_SOURCE_BLOCKED');
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
    } finally {
        harness.dispose();
    }
});

test('YouTube current found set with only blocked media never falls back to stale network content', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
    const staleNetworkUrl = 'https://rr.example.test/videoplayback?id=stale-healthy';
    const harness = createHarness({
        tabUrls: new Map([[93, pageUrl]]),
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.1-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'found',
                resolver: 'yt-dlp',
                attempted: [{
                    resolver: 'yt-dlp',
                    status: 'found',
                    available: true,
                    compatible: true,
                    version: '2026.08.19',
                    count: 2
                }],
                candidates: [{
                    resolver: 'yt-dlp',
                    url: 'https://media.example.test/ads/preroll/master.m3u8',
                    type: 'HLS',
                    role: 'master'
                }, {
                    resolver: 'yt-dlp',
                    url: 'https://media.example.test/player/silence.mp4',
                    type: 'MP4',
                    role: 'direct'
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 93, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 93,
            requestId: 'youtube-stale-healthy-network',
            url: staleNetworkUrl,
            type: 'media',
            timeStamp: 60_500
        }), { pageHostname: 'www.youtube.com', contentType: 'video/mp4' });
        await wait(75);

        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 93, url: pageUrl });
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}93`]?.status?.code === 'NO_PLAYABLE_SOURCE');
        await wait(50);

        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
        const state = harness.sessionData[`${TAB_STATE_PREFIX}93`];
        assert.equal(state.candidates.find((candidate) => candidate.url === staleNetworkUrl)?.blocked, false);
        assert.equal(state.candidates.filter((candidate) => candidate.source === 'resolver_ytdlp').every((candidate) => candidate.blocked), true);
    } finally {
        harness.dispose();
    }
});

test('YouTube resolve transport failure is recorded once and never falls back to stale media', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
    const harness = createHarness({
        tabUrls: new Map([[90, pageUrl]]),
        nativeRuntimeError(request) {
            return request.action === 'resolve' ? 'Native messaging host disconnected.' : '';
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 90, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 90,
            requestId: 'youtube-stale-videoplayback',
            url: 'https://rr.example.test/videoplayback?id=stale',
            type: 'media',
            timeStamp: 61_000
        }), { pageHostname: 'www.youtube.com', contentType: 'video/mp4' });
        await wait(75);

        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 90, url: pageUrl });
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}90`]?.status?.code === 'NATIVE_HOST_DISCONNECTED');
        await wait(50);

        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
    } finally {
        harness.dispose();
    }
});

test('context menu releases the play queue and retries one different non-audio candidate without deadlock', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const masterUrl = 'https://media.example.test/show/master.m3u8';
    const fallbackUrl = 'https://media.example.test/show/movie.mp4';
    const audioUrl = 'https://media.example.test/show/audio/main_audio.m3u8';
    let playAttempt = 0;
    const harness = createHarness({
        tabUrls: new Map([[91, pageUrl]]),
        nativeResponder(request) {
            assert.equal(request.action, 'play');
            playAttempt += 1;
            if (playAttempt === 1) {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.1-test',
                    ok: false,
                    action: 'play',
                    requestId: request.requestId,
                    errorCode: 'MPV_LOAD_FAILED'
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.1-test',
                ok: true,
                action: 'play',
                requestId: request.requestId,
                confirmed: true,
                mode: request.mode,
                confirmation: 'test'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 91, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 91, requestId: 'retry-master', url: masterUrl, timeStamp: 62_000
        }));
        emitConfirmedMedia(harness, requestDetails({
            tabId: 91, requestId: 'retry-fallback', url: fallbackUrl, type: 'media', timeStamp: 63_000
        }), { contentType: 'video/mp4' });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 91, requestId: 'retry-audio', url: audioUrl, timeStamp: 64_000
        }), { contentType: 'audio/mpegurl' });
        await wait(100);

        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 91, url: pageUrl });
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'play').length === 2);
        await wait(50);

        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 2);
        assert.equal(plays[0].stream.url, fallbackUrl);
        assert.equal(plays[1].stream.url, masterUrl);
        assert.notEqual(plays[1].stream.url, plays[0].stream.url);
        assert.notEqual(plays[1].stream.url, audioUrl);
        assert.equal(harness.sessionData[`${TAB_STATE_PREFIX}91`].status.code, 'PLAY_CONFIRMED');
    } finally {
        harness.dispose();
    }
});

test('context menu does not retry another candidate for an unrelated MPV error', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const harness = createHarness({
        tabUrls: new Map([[92, pageUrl]]),
        nativeResponder(request) {
            assert.equal(request.action, 'play');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.1-test',
                ok: false,
                action: 'play',
                requestId: request.requestId,
                errorCode: 'MPV_IPC_REJECTED'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 92, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 92,
            requestId: 'no-retry-master',
            url: 'https://media.example.test/no-retry/master.m3u8?validto=2000000000',
            timeStamp: 65_000
        }));
        emitConfirmedMedia(harness, requestDetails({
            tabId: 92,
            requestId: 'no-retry-alternate',
            url: 'https://media.example.test/no-retry/movie.mp4?validto=2000000000',
            type: 'media',
            timeStamp: 66_000
        }), { contentType: 'video/mp4' });
        await wait(100);

        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 92, url: pageUrl });
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}92`]?.status?.code === 'MPV_IPC_REJECTED');
        await wait(50);

        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 1);
        const state = harness.sessionData[`${TAB_STATE_PREFIX}92`];
        assert.equal(state.candidates.some((candidate) => candidate.playState === 'error'), false);
        assert.ok(state.candidates.some((candidate) => candidate.recommended === true));
        assert.equal(harness.nativeMessages.some((message) => message.action === 'resolve'), false);
        assert.equal(harness.pageRescanMessages.length, 0);
    } finally {
        harness.dispose();
    }
});

test('popup PLAY retries each eligible MPV content failure once and returns safe fallback metadata', async (t) => {
    for (const [index, errorCode] of [
        'MPV_LOAD_FAILED',
        'MPV_EXITED_EARLY',
        'MPV_DEMUXER_TIMEOUT'
    ].entries()) {
        await t.test(errorCode, async () => {
            const tabId = 180 + index;
            const pageUrl = `https://fallback-${index}.example.test/watch`;
            const hostname = new URL(pageUrl).hostname;
            const primaryUrl = `https://media.example.test/fallback-${index}/movie.mp4`;
            const fallbackUrl = `https://media.example.test/fallback-${index}/master.m3u8`;
            let playAttempt = 0;
            let harness;
            harness = createHarness({
                tabUrls: new Map([[tabId, pageUrl]]),
                nativeResponder(request) {
                    assert.equal(request.action, 'play');
                    playAttempt += 1;
                    if (playAttempt === 1) {
                        return {
                            protocolVersion: 2,
                            hostVersion: '3.4.7-test',
                            ok: false,
                            action: 'play',
                            requestId: request.requestId,
                            errorCode
                        };
                    }
                    const openingState = harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`];
                    assert.equal(openingState.status.code, 'PLAY_FALLBACK_OPENING');
                    assert.equal(openingState.status.initialErrorCode, errorCode);
                    return {
                        protocolVersion: 2,
                        hostVersion: '3.4.7-test',
                        ok: true,
                        action: 'play',
                        requestId: request.requestId,
                        confirmed: true,
                        mode: request.mode,
                        confirmation: 'test'
                    };
                }
            });
            try {
                await harness.ready();
                installManualPlayState(harness, tabId, hostname, [
                    manualPlayCandidate({ id: 'primary', url: primaryUrl }),
                    manualPlayCandidate({
                        id: 'fallback',
                        url: fallbackUrl,
                        source: 'resolver_streamlink',
                        role: 'master',
                        mediaKind: 'adaptive',
                        hasAudio: true,
                        hasVideo: true
                    })
                ]);

                const response = await harness.message({
                    type: 'PLAY',
                    tabId,
                    candidateId: 'primary',
                    mode: 'new'
                }, harness.popupSender);

                assert.equal(response.ok, true);
                assert.equal(response.result.fallbackUsed, true);
                assert.equal(response.result.initialErrorCode, errorCode);
                assert.equal(response.result.mode, 'new');
                const plays = harness.nativeMessages.filter((message) => message.action === 'play');
                assert.equal(plays.length, 2);
                assert.equal(plays[0].stream.url, primaryUrl);
                assert.equal(plays[1].stream.url, fallbackUrl);
                assert.equal(response.state.status.code, 'PLAY_CONFIRMED');
                assert.equal(response.state.status.fallbackUsed, true);
                assert.equal(response.state.status.initialErrorCode, errorCode);
                assert.equal(harness.nativeMessages.some((message) => message.action === 'resolve'), false);
            } finally {
                harness.dispose();
            }
        });
    }
});

test('popup fallback skips unsafe candidates and prefers the complete resolver master', async () => {
    const tabId = 184;
    const pageUrl = 'https://fallback-filter.example.test/watch';
    const hostname = new URL(pageUrl).hostname;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const primary = manualPlayCandidate({
        id: 'primary',
        url: 'https://media.example.test/filter/primary-1080p.mp4',
        groupKey: 'primary-group',
        height: 1080
    });
    const resolverMaster = manualPlayCandidate({
        id: 'resolver-master',
        url: 'https://resolver.example.test/filter/master-720p.m3u8',
        source: 'resolver_streamlink',
        role: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        userPriority: -1,
        height: 720
    });
    const candidates = [
        primary,
        manualPlayCandidate({
            id: 'same-group',
            url: 'https://resolver.example.test/filter/same-master.m3u8',
            groupKey: 'primary-group',
            source: 'resolver_streamlink',
            role: 'master',
            mediaKind: 'adaptive',
            hasAudio: true,
            hasVideo: true
        }),
        manualPlayCandidate({
            id: 'audio',
            url: 'https://resolver.example.test/filter/audio.m3u8',
            source: 'resolver_streamlink',
            role: 'audio',
            mediaKind: 'audio-only',
            hasAudio: true,
            hasVideo: false
        }),
        manualPlayCandidate({
            id: 'advertisement',
            url: 'https://resolver.example.test/ads/preroll.m3u8',
            source: 'resolver_streamlink',
            role: 'master',
            mediaKind: 'adaptive',
            hasAudio: true,
            hasVideo: true
        }),
        manualPlayCandidate({
            id: 'diagnostic',
            url: 'https://resolver.example.test/filter/diagnostic.m3u8',
            source: 'resolver_streamlink',
            role: 'master',
            mediaKind: 'adaptive',
            hasAudio: true,
            hasVideo: true,
            diagnosticOnly: true
        }),
        manualPlayCandidate({
            id: 'provisional',
            url: 'https://network.example.test/filter/provisional.m3u8',
            role: 'master',
            genericPrerollGuardUntil: Date.now() + 60_000
        }),
        manualPlayCandidate({
            id: 'failed',
            url: 'https://resolver.example.test/filter/failed.m3u8',
            source: 'resolver_streamlink',
            role: 'master',
            mediaKind: 'adaptive',
            hasAudio: true,
            hasVideo: true,
            playState: 'error',
            lastPlayErrorCode: 'MPV_LOAD_FAILED'
        }),
        manualPlayCandidate({
            id: 'expired',
            url: `https://resolver.example.test/filter/expired.m3u8?validto=${nowSeconds - 60}`,
            source: 'resolver_streamlink',
            role: 'master',
            mediaKind: 'adaptive',
            hasAudio: true,
            hasVideo: true
        }),
        manualPlayCandidate({
            id: 'incomplete',
            url: 'https://resolver.example.test/filter/video-only.mp4',
            source: 'resolver_ytdlp',
            role: 'direct',
            mediaKind: 'video-only',
            hasAudio: false,
            hasVideo: true
        }),
        manualPlayCandidate({
            id: 'weak-variant',
            url: 'https://network.example.test/filter/variant.m3u8',
            role: 'variant'
        }),
        manualPlayCandidate({
            id: 'drm',
            url: 'https://resolver.example.test/filter/protected.m3u8',
            source: 'resolver_streamlink',
            role: 'master',
            mediaKind: 'adaptive',
            hasAudio: true,
            hasVideo: true,
            drmProtected: true
        }),
        manualPlayCandidate({
            id: 'high-direct',
            url: 'https://network.example.test/filter/movie-2160p.mp4',
            userPriority: 1,
            height: 2160
        }),
        resolverMaster
    ];
    let playAttempt = 0;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        nativeResponder(request) {
            playAttempt += 1;
            return playAttempt === 1
                ? {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: false,
                    action: 'play',
                    requestId: request.requestId,
                    errorCode: 'MPV_LOAD_FAILED'
                }
                : {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: true,
                    action: 'play',
                    requestId: request.requestId,
                    confirmed: true,
                    mode: request.mode,
                    confirmation: 'test'
                };
        }
    });
    try {
        await harness.ready();
        installManualPlayState(harness, tabId, hostname, candidates);

        const response = await harness.message({
            type: 'PLAY',
            tabId,
            candidateId: primary.id,
            mode: 'new'
        }, harness.popupSender);

        assert.equal(response.ok, true);
        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 2);
        assert.equal(plays[0].stream.url, primary.url);
        assert.equal(plays[1].stream.url, resolverMaster.url);
        assert.equal(response.result.fallbackUsed, true);
    } finally {
        harness.dispose();
    }
});

test('popup fallback makes at most two play attempts and does not retry unrelated failures', async (t) => {
    await t.test('second eligible failure is final', async () => {
        const tabId = 185;
        const pageUrl = 'https://fallback-bounded.example.test/watch';
        const harness = createHarness({
            tabUrls: new Map([[tabId, pageUrl]]),
            nativeResponder(request) {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: false,
                    action: 'play',
                    requestId: request.requestId,
                    errorCode: 'MPV_EXITED_EARLY'
                };
            }
        });
        try {
            await harness.ready();
            installManualPlayState(harness, tabId, new URL(pageUrl).hostname, [
                manualPlayCandidate({ id: 'primary', url: 'https://media.example.test/bounded/primary.mp4' }),
                manualPlayCandidate({
                    id: 'fallback-one',
                    url: 'https://resolver.example.test/bounded/master-one.m3u8',
                    source: 'resolver_streamlink',
                    role: 'master',
                    mediaKind: 'adaptive',
                    hasAudio: true,
                    hasVideo: true
                }),
                manualPlayCandidate({
                    id: 'fallback-two',
                    url: 'https://resolver.example.test/bounded/master-two.m3u8',
                    source: 'resolver_ytdlp',
                    role: 'master',
                    mediaKind: 'adaptive',
                    hasAudio: true,
                    hasVideo: true
                })
            ]);
            const response = await harness.message({
                type: 'PLAY',
                tabId,
                candidateId: 'primary',
                mode: 'new'
            }, harness.popupSender);
            assert.equal(response.ok, false);
            assert.equal(response.errorCode, 'MPV_EXITED_EARLY');
            assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 2);
        } finally {
            harness.dispose();
        }
    });

    await t.test('an unrelated MPV failure is not retried', async () => {
        const tabId = 186;
        const pageUrl = 'https://fallback-unrelated.example.test/watch';
        const harness = createHarness({
            tabUrls: new Map([[tabId, pageUrl]]),
            nativeResponder(request) {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: false,
                    action: 'play',
                    requestId: request.requestId,
                    errorCode: 'MPV_IPC_REJECTED'
                };
            }
        });
        try {
            await harness.ready();
            installManualPlayState(harness, tabId, new URL(pageUrl).hostname, [
                manualPlayCandidate({ id: 'primary', url: 'https://media.example.test/unrelated/primary.mp4' }),
                manualPlayCandidate({
                    id: 'fallback',
                    url: 'https://resolver.example.test/unrelated/master.m3u8',
                    source: 'resolver_streamlink',
                    role: 'master',
                    mediaKind: 'adaptive',
                    hasAudio: true,
                    hasVideo: true
                })
            ]);
            const response = await harness.message({
                type: 'PLAY',
                tabId,
                candidateId: 'primary',
                mode: 'new'
            }, harness.popupSender);
            assert.equal(response.ok, false);
            assert.equal(response.errorCode, 'MPV_IPC_REJECTED');
            assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 1);
        } finally {
            harness.dispose();
        }
    });
});

test('popup PLAY requires the trusted popup and leaves STREAM_URL_EXPIRED to background refresh', async (t) => {
    await t.test('untrusted sender cannot launch MPV', async () => {
        const tabId = 187;
        const pageUrl = 'https://fallback-sender.example.test/watch';
        const harness = createHarness({ tabUrls: new Map([[tabId, pageUrl]]) });
        try {
            await harness.ready();
            installManualPlayState(harness, tabId, new URL(pageUrl).hostname, [
                manualPlayCandidate({ id: 'primary', url: 'https://media.example.test/sender/primary.mp4' })
            ]);
            const response = await harness.message({
                type: 'PLAY',
                tabId,
                candidateId: 'primary',
                mode: 'new'
            }, { tab: { id: tabId }, frameId: 0, url: pageUrl });
            assert.equal(response.ok, false);
            assert.equal(response.errorCode, 'POPUP_GESTURE_REQUIRED');
            assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
        } finally {
            harness.dispose();
        }
    });

    await t.test('expired primary is not replaced by a playlist fallback', async () => {
        const tabId = 188;
        const pageUrl = 'https://fallback-expired.example.test/watch';
        const expiredAt = Math.floor(Date.now() / 1000) - 60;
        const harness = createHarness({ tabUrls: new Map([[tabId, pageUrl]]) });
        try {
            await harness.ready();
            installManualPlayState(harness, tabId, new URL(pageUrl).hostname, [
                manualPlayCandidate({
                    id: 'expired-primary',
                    url: `https://media.example.test/expired/primary.m3u8?validto=${expiredAt}`,
                    role: 'master'
                }),
                manualPlayCandidate({
                    id: 'fallback',
                    url: 'https://resolver.example.test/expired/master.m3u8',
                    source: 'resolver_streamlink',
                    role: 'master',
                    mediaKind: 'adaptive',
                    hasAudio: true,
                    hasVideo: true
                })
            ]);
            const response = await harness.message({
                type: 'PLAY',
                tabId,
                candidateId: 'expired-primary',
                mode: 'new'
            }, harness.popupSender);
            assert.equal(response.ok, false);
            assert.equal(response.errorCode, 'STREAM_URL_EXPIRED');
            assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
        } finally {
            harness.dispose();
        }
    });
});

test('an already expired signed transport is rejected before Native Messaging play', async () => {
    const tabId = 221;
    const pageUrl = 'https://video.example.test/expired';
    const expiredAt = Math.floor(Date.now() / 1000) - 3_600;
    const expiredUrl = `https://cdn.example.test/show/1080P_8000K/index.m3u8?validto=${expiredAt}&hash=stale`;
    const harness = createHarness({ tabUrls: new Map([[tabId, pageUrl]]) });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'expired-signed-transport',
            url: expiredUrl,
            timeStamp: 90_000
        }));
        await wait(80);

        const state = await harness.message({ type: 'GET_TAB_STATE', tabId });
        const candidate = state.state.candidates.find((item) => item.url === expiredUrl);
        assert.ok(candidate);
        assert.equal(candidate.expired, true);
        assert.equal(candidate.recommended, false);

        const response = await harness.message({
            type: 'PLAY',
            tabId,
            candidateId: candidate.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(response.ok, false);
        assert.equal(response.errorCode, 'STREAM_URL_EXPIRED');
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
    } finally {
        harness.dispose();
    }
});

test('expiry alarm rescans the page and resolves a fresh signed transport without autoplay', async () => {
    const tabId = 222;
    const pageUrl = 'https://video.example.test/refresh';
    const expiringAt = Math.floor(Date.now() / 1000) + 20;
    const freshAt = Math.floor(Date.now() / 1000) + 7_200;
    const expiringUrl = `https://cdn.example.test/show/1080P_8000K/index.m3u8?validto=${expiringAt}&hash=old`;
    const freshUrl = `https://cdn.example.test/show/1080P_8000K/index.m3u8?validto=${freshAt}&hash=fresh`;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        localData: {
            siteAutoLaunch: { 'video.example.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'found',
                resolver: 'streamlink',
                attempted: [{
                    resolver: 'streamlink',
                    status: 'found',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 1
                }],
                candidates: [{
                    resolver: 'streamlink',
                    url: freshUrl,
                    type: 'HLS',
                    quality: '1080p',
                    height: 1080,
                    role: 'variant'
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'expiring-signed-transport',
            url: expiringUrl,
            timeStamp: 91_000
        }));
        await waitFor(() => [...harness.alarms.keys()].some((name) => name.endsWith(`:${tabId}`)));
        const alarmName = [...harness.alarms.keys()].find((name) => name.endsWith(`:${tabId}`));
        harness.fire('alarm', { name: alarmName });

        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'resolve'));
        const resolveRequest = harness.nativeMessages.find((message) => message.action === 'resolve');
        assert.equal(resolveRequest.source, 'refresh');
        assert.deepEqual(resolveRequest.cookies, []);
        assert.equal(harness.pageRescanMessages.length, 1);
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === freshUrl)
        ));
        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const fresh = state.candidates.find((candidate) => candidate.url === freshUrl);
        assert.ok(fresh);
        assert.equal(fresh.expired, false);
        assert.equal(fresh.playState === 'error', false);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
    } finally {
        harness.dispose();
    }
});

test('page rescan replacement succeeds even when the external resolver is empty', async () => {
    const tabId = 225;
    const pageUrl = 'https://video.example.test/rescan-refresh';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiringUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${nowSeconds + 20}&hash=old`;
    const freshUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${nowSeconds + 7_200}&hash=fresh`;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        localData: {
            siteAutoLaunch: { 'video.example.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        nativeDelayMs: 25,
        pageRescanFrameId: 7,
        pageRescanAckBeforeMedia: true,
        pageRescanDelayMs: 650,
        pageRescanMedia: [{
            url: freshUrl,
            type: 'HLS',
            title: 'Materiał Full HD',
            quality: '1080p',
            height: 1080,
            kind: 'video'
        }],
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            assert.equal(request.source, 'refresh');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [{
                    resolver: 'streamlink',
                    status: 'empty',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 0
                }],
                candidates: [],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        const discovered = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{
                url: expiringUrl,
                type: 'HLS',
                title: 'Materiał Full HD',
                quality: '1080p',
                height: 1080,
                kind: 'video'
            }]
        }, { frameId: 7, documentId: 'initial-player-frame', url: pageUrl });
        assert.equal(discovered.ok, true);

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]?.status?.code === 'STREAM_REFRESHED');
        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const fresh = state.candidates.find((candidate) => candidate.url === freshUrl);
        assert.ok(fresh);
        assert.equal(fresh.recommended, true);
        assert.equal(state.auto.lastCandidateId, fresh.id);
        assert.equal(state.auto.lastFingerprint, fresh.groupKey);
        assert.equal(state.auto.pendingDueAt, null);
        assert.equal(state.candidates.some((candidate) => candidate.url === expiringUrl && candidate.recommended), false);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
        assert.equal(harness.pageRescanMessages.length, 1);
        assert.equal(harness.pageRescanMessages[0].options, undefined);
    } finally {
        harness.dispose();
    }
});

test('a late different-family iframe source cannot repair a failed expiry refresh', async () => {
    const tabId = 233;
    const pageUrl = 'https://video.example.test/rescan-wrong-family';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiringUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${nowSeconds + 20}&hash=old`;
    const unrelatedUrl = `https://other-cdn.example.test/other/720/index.m3u8?validto=${nowSeconds + 7_200}&hash=fresh`;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        pageRescanFrameId: 9,
        pageRescanAckBeforeMedia: true,
        pageRescanDelayMs: 650,
        pageRescanMedia: [{
            url: unrelatedUrl,
            type: 'HLS',
            title: 'Inny materiał',
            quality: '720p',
            height: 720,
            kind: 'video'
        }],
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            assert.equal(request.source, 'refresh');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [{
                    resolver: 'streamlink',
                    status: 'empty',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 0
                }],
                candidates: [],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        const discovered = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{
                url: expiringUrl,
                type: 'HLS',
                title: 'Bieżący materiał Full HD',
                quality: '1080p',
                height: 1080,
                kind: 'video'
            }]
        }, { frameId: 9, documentId: 'wrong-family-initial', url: pageUrl });
        assert.equal(discovered.ok, true);

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]?.status?.code === 'STREAM_REFRESH_FAILED');
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            ?.candidates?.some((candidate) => candidate.url === unrelatedUrl));
        await wait(100);

        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.status.code, 'STREAM_REFRESH_FAILED');
        assert.equal(state.candidates.some((candidate) =>
            candidate.url === expiringUrl && candidate.recommended
        ), false);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
    } finally {
        harness.dispose();
    }
});

test('refresh with a pre-3.4.7 native host reports an actionable upgrade error', async () => {
    const tabId = 226;
    const pageUrl = 'https://video.example.test/old-host';
    const expiresAt = Math.floor(Date.now() / 1000) + 20;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            assert.equal(request.source, 'refresh');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.6',
                ok: false,
                action: 'resolve',
                requestId: request.requestId,
                errorCode: 'INVALID_REQUEST'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'old-host-expiring',
            url: `https://cdn.example.test/show/master.m3u8?validto=${expiresAt}&hash=old`,
            timeStamp: 94_000
        }));

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]?.status?.code === 'HOST_TOO_OLD');
        const state = harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`];
        assert.match(state.status.message, /3\.4\.7/);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
    } finally {
        harness.dispose();
    }
});

test('an exact forced refresh survives a resolver busy on another tab without a retry loop', async () => {
    const failedTabId = 227;
    const resolverTabId = 228;
    const failedPageUrl = 'https://video.example.test/forced-while-busy';
    const resolverPageUrl = 'https://other.example.test/manual-resolve';
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const freshAt = Math.floor(Date.now() / 1000) + 7_200;
    const expiredUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${expiredAt}&hash=expired`;
    const freshUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${freshAt}&hash=fresh`;
    const harness = createHarness({
        tabUrls: new Map([
            [failedTabId, failedPageUrl],
            [resolverTabId, resolverPageUrl]
        ]),
        nativeDelayMs: 250,
        expiryBusyRetryMs: 250,
        nativeResponder(request) {
            if (request.source === 'manual') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: true,
                    action: 'resolve',
                    requestId: request.requestId,
                    status: 'empty',
                    resolver: null,
                    attempted: [{
                        resolver: 'streamlink',
                        status: 'empty',
                        available: true,
                        compatible: true,
                        version: '8.5.0',
                        count: 0
                    }],
                    candidates: [],
                    truncated: false
                };
            }
            assert.equal(request.source, 'refresh');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'found',
                resolver: 'streamlink',
                attempted: [{
                    resolver: 'streamlink',
                    status: 'found',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 1
                }],
                candidates: [{
                    resolver: 'streamlink',
                    url: freshUrl,
                    type: 'HLS',
                    quality: '1080p',
                    height: 1080,
                    role: 'variant'
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: failedTabId, url: failedPageUrl, active: false, windowId: 1 });
        harness.fire('tabCreated', { id: resolverTabId, url: resolverPageUrl, active: true, windowId: 1 });
        emitConfirmedMedia(harness, requestDetails({
            tabId: failedTabId,
            requestId: 'expired-before-busy',
            url: expiredUrl,
            timeStamp: 95_000
        }));
        await wait(350);

        const manualResolve = harness.message({
            type: 'RESOLVE_PAGE',
            tabId: resolverTabId
        }, harness.popupSender);
        await waitFor(() => harness.nativeMessages.some((message) => message.source === 'manual'));

        const before = (await harness.message({ type: 'GET_TAB_STATE', tabId: failedTabId })).state;
        const expiredCandidate = before.candidates.find((candidate) => candidate.url === expiredUrl);
        assert.ok(expiredCandidate);
        const play = await harness.message({
            type: 'PLAY',
            tabId: failedTabId,
            candidateId: expiredCandidate.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(play.ok, false);
        assert.equal(play.errorCode, 'STREAM_URL_EXPIRED');
        harness.activeTabIds.clear();
        harness.activeTabIds.add(failedTabId);

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${failedTabId}`]
            ?.expiryRefresh?.pendingCandidateId === expiredCandidate.id);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.pageRescanMessages.length, 0);

        await manualResolve;
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${failedTabId}`]?.status?.code === 'STREAM_REFRESHED');
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 2);
        assert.equal(harness.pageRescanMessages.length, 1);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
        assert.ok(harness.sessionData[`${TAB_STATE_PREFIX}${failedTabId}`]
            .candidates.some((candidate) => candidate.url === freshUrl));
        await wait(350);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 2);
    } finally {
        harness.dispose();
    }
});

test('an exact forced refresh stops after bounded native resolver busy responses', async () => {
    const tabId = 229;
    const pageUrl = 'https://video.example.test/forced-always-busy';
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const expiredUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${expiredAt}&hash=always-busy`;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        expiryBusyRetryMs: 250,
        expiryBusyRetryLimit: 2,
        pageMediaRescanSettleMs: 10,
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            assert.equal(request.source, 'refresh');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: false,
                action: 'resolve',
                requestId: request.requestId,
                errorCode: 'RESOLVER_BUSY'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'expired-always-busy',
            url: expiredUrl,
            timeStamp: 96_000
        }));
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            ?.candidates?.some((candidate) => candidate.url === expiredUrl));

        const before = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const expiredCandidate = before.candidates.find((candidate) => candidate.url === expiredUrl);
        const play = await harness.message({
            type: 'PLAY',
            tabId,
            candidateId: expiredCandidate.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(play.ok, false);
        assert.equal(play.errorCode, 'STREAM_URL_EXPIRED');

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            ?.expiryRefresh?.pendingRetryCount === 1);
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            ?.status?.code === 'STREAM_REFRESH_FAILED', 2_500);
        const stopped = harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`];
        assert.equal(stopped.expiryRefresh.pendingCandidateId, '');
        assert.equal(stopped.expiryRefresh.pendingRetryCount, 0);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 3);
        assert.equal(harness.pageRescanMessages.length, 3);
        assert.equal([...harness.alarms.keys()].some((name) => name.endsWith(`:${tabId}`)), false);

        await wait(400);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 3);
        assert.equal(harness.pageRescanMessages.length, 3);
    } finally {
        harness.dispose();
    }
});

test('a due non-forced refresh persists a busy lease before the next kick window', async () => {
    const refreshTabId = 230;
    const resolverTabId = 231;
    const refreshPageUrl = 'https://video.example.test/due-while-busy';
    const resolverPageUrl = 'https://other.example.test/manual-resolve-lease';
    const expiresAt = Math.floor(Date.now() / 1000) + 20;
    const expiringUrl = `https://cdn.example.test/show/master.m3u8?validto=${expiresAt}&hash=lease`;
    const harness = createHarness({
        tabUrls: new Map([
            [refreshTabId, refreshPageUrl],
            [resolverTabId, resolverPageUrl]
        ]),
        activeTabIds: [refreshTabId],
        nativeDelayMs: 600,
        expiryBusyRetryMs: 500,
        nativeResponder(request) {
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [],
                candidates: [],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: refreshTabId, url: refreshPageUrl, active: true, windowId: 1 });
        harness.fire('tabCreated', { id: resolverTabId, url: resolverPageUrl, active: false, windowId: 1 });
        const manualResolve = harness.message({
            type: 'RESOLVE_PAGE',
            tabId: resolverTabId
        }, harness.popupSender);
        await waitFor(() => harness.nativeMessages.some((message) => message.source === 'manual'));

        emitConfirmedMedia(harness, requestDetails({
            tabId: refreshTabId,
            requestId: 'expiring-during-resolve',
            url: expiringUrl,
            timeStamp: 97_000
        }));
        await waitFor(() => {
            const retryNotBefore = harness.sessionData[`${TAB_STATE_PREFIX}${refreshTabId}`]
                ?.expiryRefresh?.retryNotBefore;
            return Number.isFinite(retryNotBefore) && retryNotBefore > Date.now() + 300;
        });
        const lease = harness.sessionData[`${TAB_STATE_PREFIX}${refreshTabId}`].expiryRefresh.retryNotBefore;

        await wait(200);
        assert.equal(harness.sessionData[`${TAB_STATE_PREFIX}${refreshTabId}`].expiryRefresh.retryNotBefore, lease);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.pageRescanMessages.length, 0);
        await manualResolve;
    } finally {
        harness.dispose();
    }
});

test('a non-forced refresh retries its exact target after it expires during native resolver busy', async () => {
    const tabId = 232;
    const pageUrl = 'https://video.example.test/expires-during-native-busy';
    const expiresAt = Date.now() + 550;
    const freshAt = Math.floor(Date.now() / 1000) + 7_200;
    const expiringUrl = `https://cdn.example.test/show/master.m3u8?validto=${expiresAt}&hash=short`;
    const freshUrl = `https://cdn.example.test/show/master.m3u8?validto=${freshAt}&hash=fresh`;
    let refreshRequests = 0;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        expiryBusyRetryMs: 750,
        pageMediaRescanSettleMs: 10,
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            assert.equal(request.source, 'refresh');
            refreshRequests += 1;
            if (refreshRequests === 1) {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: false,
                    action: 'resolve',
                    requestId: request.requestId,
                    errorCode: 'RESOLVER_BUSY'
                };
            }
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'found',
                resolver: 'streamlink',
                attempted: [{
                    resolver: 'streamlink',
                    status: 'found',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 1
                }],
                candidates: [{
                    resolver: 'streamlink',
                    url: freshUrl,
                    type: 'HLS',
                    quality: '1080p',
                    height: 1080,
                    role: 'master'
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'expires-before-busy-retry',
            url: expiringUrl,
            timeStamp: 98_000
        }));

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            ?.expiryRefresh?.pendingRetryCount === 1);
        const pending = harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`];
        const target = pending.candidates.find((candidate) => candidate.url === expiringUrl);
        assert.equal(pending.expiryRefresh.pendingCandidateId, target.id);
        assert.equal(pending.expiryRefresh.pendingReason, 'STREAM_URL_EXPIRED');
        await wait(Math.max(0, expiresAt - Date.now() + 25));
        assert.equal(Date.now() > expiresAt, true);

        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            ?.status?.code === 'STREAM_REFRESHED', 3_000);
        assert.equal(refreshRequests, 2);
        assert.equal(harness.pageRescanMessages.length, 2);
        assert.equal(harness.nativeMessages.some((message) => message.action === 'play'), false);
        assert.ok(harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]
            .candidates.some((candidate) => candidate.url === freshUrl));
    } finally {
        harness.dispose();
    }
});

test('forced recovery refreshes only the failed signed candidate, not another earlier deadline', async () => {
    const tabId = 224;
    const pageUrl = 'https://video.example.test/forced-refresh';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const failedUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${nowSeconds + 120}&hash=failed`;
    const freshUrl = `https://cdn.example.test/show/1080/index.m3u8?validto=${nowSeconds + 7_200}&hash=fresh`;
    const earlierUrl = `https://other-cdn.example.test/show/720/index.m3u8?validto=${nowSeconds + 90}&hash=healthy`;
    const harness = createHarness({
        tabUrls: new Map([[tabId, pageUrl]]),
        activeTabIds: [tabId],
        nativeResponder(request) {
            if (request.action === 'play') {
                return {
                    protocolVersion: 2,
                    hostVersion: '3.4.7-test',
                    ok: false,
                    action: 'play',
                    requestId: request.requestId,
                    errorCode: 'MPV_LOAD_FAILED'
                };
            }
            assert.equal(request.action, 'resolve');
            assert.equal(request.source, 'refresh');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.7-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'found',
                resolver: 'streamlink',
                attempted: [{
                    resolver: 'streamlink',
                    status: 'found',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 1
                }],
                candidates: [{
                    resolver: 'streamlink',
                    url: freshUrl,
                    type: 'HLS',
                    quality: '1080p',
                    height: 1080,
                    role: 'variant'
                }],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl, active: true, windowId: 1 });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'forced-failed-candidate',
            url: failedUrl,
            timeStamp: 92_000
        }));
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'other-earlier-deadline',
            url: earlierUrl,
            timeStamp: 93_000
        }), { contentType: 'audio/mpegurl' });
        await wait(80);

        const before = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const failedCandidate = before.candidates.find((candidate) => candidate.url === failedUrl);
        assert.ok(failedCandidate);
        const response = await harness.message({
            type: 'PLAY',
            tabId,
            candidateId: failedCandidate.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(response.ok, false);
        assert.equal(response.errorCode, 'MPV_LOAD_FAILED');

        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'resolve'));
        await waitFor(() => Object.values(harness.sessionData).some((state) =>
            state?.candidates?.some((candidate) => candidate.url === freshUrl)
        ));
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}${tabId}`]?.status?.code === 'STREAM_REFRESHED');
        const after = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.ok(after.candidates.some((candidate) => candidate.url === freshUrl));
        const earlier = after.candidates.find((candidate) => candidate.url === earlierUrl);
        assert.ok(earlier);
        assert.notEqual(earlier.diagnosticReason, 'EXPIRED_SOURCE_REPLACED');
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 1);
    } finally {
        harness.dispose();
    }
});

test('one discovery batch is summarized instead of flooding diagnostics with duplicate events', async () => {
    const tabId = 223;
    const pageUrl = 'https://video.example.test/batch';
    const harness = createHarness({ tabUrls: new Map([[tabId, pageUrl]]) });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: pageUrl });
        const response = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: Array.from({ length: 11 }, (_unused, index) => ({
                url: `https://cdn.example.test/show/video-${index + 1}-1080p.mp4`,
                type: 'MP4',
                title: `Wariant ${index + 1}`,
                quality: '1080p',
                kind: 'video'
            }))
        }, { frameId: 0, documentId: 'batch-document', url: pageUrl });
        assert.equal(response.ok, true);
        const state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const detectedEvents = state.events.filter((event) => event.code === 'MEDIA_DETECTED');
        assert.equal(detectedEvents.length, 1);
        assert.match(detectedEvents[0].message, /11/);
    } finally {
        harness.dispose();
    }
});

test('context menu stores a resolver-without-source error without an unhandled rejection', async () => {
    const pageUrl = 'https://video.example.test/empty';
    const harness = createHarness({
        tabUrls: new Map([[88, pageUrl]]),
        nativeResponder(request) {
            assert.equal(request.action, 'resolve');
            return {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [{
                    resolver: 'streamlink',
                    status: 'empty',
                    available: true,
                    compatible: true,
                    version: '8.5.0',
                    count: 0
                }, {
                    resolver: 'yt-dlp',
                    status: 'empty',
                    available: true,
                    compatible: true,
                    version: '2026.08.19',
                    count: 0
                }],
                candidates: [],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 88, url: pageUrl });
        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 88, url: pageUrl });
        await waitFor(() => harness.sessionData[`${TAB_STATE_PREFIX}88`]?.status?.code === 'NO_PLAYABLE_SOURCE');

        const state = harness.sessionData[`${TAB_STATE_PREFIX}88`];
        assert.equal(state.status.state, 'error');
        assert.equal(state.status.source, 'context_menu');
        assert.equal(state.status.confirmed, false);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 1);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
    } finally {
        harness.dispose();
    }
});

test('resolver cookies are opt-in for the exact HTTPS hostname and never include profile metadata', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const harness = createHarness({
        tabUrls: new Map([[82, pageUrl]]),
        cookies: [{
            name: 'session_id',
            value: 'signed-session',
            domain: '.example.test',
            path: '/',
            secure: true,
            httpOnly: true,
            hostOnly: false,
            expirationDate: 2_000_000_000,
            storeId: 'profile-5',
            partitionKey: { topLevelSite: pageUrl }
        }],
        nativeResponder(request) {
            return request.action === 'resolve' ? {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: 'resolve',
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [
                    { resolver: 'streamlink', status: 'empty', available: true, compatible: true, version: '8.4.0', count: 0 },
                    { resolver: 'yt-dlp', status: 'empty', available: true, compatible: true, version: '2026.07.04', count: 0 }
                ],
                candidates: [],
                truncated: false
            } : {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: request.action,
                requestId: request.requestId,
                mpv: { available: true },
                queue: { state: 'stopped', responsive: false }
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 82, url: pageUrl });
        const enabled = await harness.message({
            type: 'SET_RESOLVER_COOKIE_POLICY',
            tabId: 82,
            enabled: true
        }, harness.popupSender);
        assert.equal(enabled.ok, true);
        assert.equal(enabled.hostname, 'video.example.test');

        const resolved = await harness.message({ type: 'RESOLVE_PAGE', tabId: 82 }, harness.popupSender);
        assert.equal(resolved.ok, true);
        assert.equal(resolved.result.cookiesUsed, true);
        const nativeRequest = harness.nativeMessages.find((message) => message.action === 'resolve');
        assert.deepEqual(nativeRequest.cookies, [{
            name: 'session_id',
            value: 'signed-session',
            domain: '.example.test',
            path: '/',
            secure: true,
            httpOnly: true,
            hostOnly: false,
            expires: 2_000_000_000
        }]);
        assert.doesNotMatch(JSON.stringify(resolved.state), /signed-session|profile-5|partitionKey/);
    } finally {
        harness.dispose();
    }
});

test('resolver, cookie-policy, and source-preference actions reject every sender except the extension popup', async () => {
    const harness = createHarness({
        tabUrls: new Map([[84, 'https://video.example.test/watch']])
    });
    const untrustedSenders = [
        {},
        { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/background.html` },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', url: `chrome-extension://${EXTENSION_ID}/popup.html` },
        { id: EXTENSION_ID, url: 'https://attacker.example/popup.html' }
    ];
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 84, url: 'https://video.example.test/watch' });
        for (const sender of untrustedSenders) {
            for (const payload of [
                { type: 'RESOLVE_PAGE', tabId: 84 },
                { type: 'GET_RESOLVER_COOKIE_POLICY', tabId: 84 },
                { type: 'SET_RESOLVER_COOKIE_POLICY', tabId: 84, enabled: true },
                { type: 'SET_CANDIDATE_PRIORITY', tabId: 84, candidateId: 'missing', priority: 'preferred' },
                { type: 'SET_SOURCE_URL_VISIBILITY', tabId: 84, visible: true },
                {
                    type: 'SET_QUALITY_ORDER',
                    tabId: 84,
                    qualityOrder: ['720p', '1080p', '2160p', '1440p', '480p']
                }
            ]) {
                const response = await harness.message(payload, sender);
                assert.equal(response.ok, false);
                assert.equal(response.errorCode, 'POPUP_GESTURE_REQUIRED');
            }
        }
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 0);
        assert.deepEqual(harness.localData.resolverCookieSites || {}, {});
        assert.deepEqual(harness.localData.siteSourcePreferences || {}, {});
    } finally {
        harness.dispose();
    }
});

test('parallel resolver clicks are rejected and a late result cannot cross navigation epochs', async () => {
    const oldUrl = 'https://video.example.test/old';
    const newUrl = 'https://video.example.test/new';
    const harness = createHarness({
        tabUrls: new Map([[83, oldUrl]]),
        nativeDelayMs: 90,
        nativeResponder(request) {
            return {
                protocolVersion: 2,
                hostVersion: '3.4.0-test',
                ok: true,
                action: request.action,
                requestId: request.requestId,
                status: 'empty',
                resolver: null,
                attempted: [
                    { resolver: 'streamlink', status: 'empty', available: true, compatible: true, version: '8.4.0', count: 0 },
                    { resolver: 'yt-dlp', status: 'empty', available: true, compatible: true, version: '2026.07.04', count: 0 }
                ],
                candidates: [],
                truncated: false
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 83, url: oldUrl });
        const first = harness.message({ type: 'RESOLVE_PAGE', tabId: 83 }, harness.popupSender);
        await wait(15);
        const duplicate = await harness.message({ type: 'RESOLVE_PAGE', tabId: 83 }, harness.popupSender);
        assert.equal(duplicate.ok, false);
        assert.equal(duplicate.errorCode, 'RESOLVE_IN_PROGRESS');

        harness.tabUrls.set(83, newUrl);
        harness.fire('tabUpdated', 83, { status: 'loading', url: newUrl }, { id: 83, url: newUrl });
        await wait(25);
        const stale = await first;
        assert.equal(stale.ok, false);
        assert.equal(stale.errorCode, 'STALE_TAB_SESSION');
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 83 });
        assert.equal(state.state.candidates.length, 0);
    } finally {
        harness.dispose();
    }
});

test('URL detection without an HTTP response does not auto-launch after 950 ms', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'page.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[2, 'https://page.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 2 });
        const pending = requestDetails({
            tabId: 2,
            requestId: 'pending-no-http',
            url: 'https://cdn.test/live/master.m3u8?token=pending',
            timeStamp: 3_000
        });
        harness.fire('beforeRequest', pending);
        harness.fire('sendHeaders', {
            ...pending,
            timeStamp: 3_001,
            requestHeaders: [{ name: 'User-Agent', value: 'Integration-Test/1.0' }]
        });

        await wait(950);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);
    } finally {
        harness.dispose();
    }
});

test('main_frame detection keeps the reserved new hostname while tabs.get is still old', async () => {
    const harness = createHarness({
        tabUrls: new Map([[3, 'https://old.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 3, url: 'https://old.test/watch' });
        const direct = requestDetails({
            tabId: 3,
            requestId: 'main-new-domain',
            url: 'https://new.test/Movie.mp4?token=new-domain',
            type: 'main_frame',
            timeStamp: 4_000
        });
        emitConfirmedMedia(harness, direct, {
            pageHostname: 'new.test',
            contentType: 'video/mp4'
        });

        await wait(120);
        const response = await harness.message({ type: 'GET_TAB_STATE', tabId: 3 });
        assert.equal(response.ok, true);
        assert.equal(response.state.hostname, 'new.test');
        assert.equal(response.state.candidates[0].url, direct.url);
    } finally {
        harness.dispose();
    }
});

test('response completion without a surviving start context is dropped after navigation', async () => {
    const oldPage = 'https://old.test/watch';
    const newPage = 'https://new.test/watch';
    const harness = createHarness({ tabUrls: new Map([[18, oldPage]]) });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 18, url: oldPage });
        const oldMedia = requestDetails({
            tabId: 18,
            requestId: 'old-context-cleared',
            url: 'https://cdn.test/opaque/old-stream?token=old',
            type: 'xmlhttprequest',
            timeStamp: 4_200
        });
        const oldFailedMedia = requestDetails({
            tabId: 18,
            requestId: 'old-error-context-cleared',
            url: 'https://cdn.test/old-video.mp4',
            type: 'media',
            timeStamp: 4_210
        });
        harness.fire('beforeRequest', oldMedia);
        harness.fire('beforeRequest', oldFailedMedia);
        harness.fire('beforeRequest', requestDetails({
            tabId: 18,
            requestId: 'new-main-frame-context',
            url: newPage,
            type: 'main_frame',
            timeStamp: 4_300
        }));
        harness.tabUrls.set(18, newPage);
        await wait(80);
        harness.fire('headersReceived', {
            ...oldMedia,
            timeStamp: 4_400,
            statusCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
        });
        harness.fire('requestError', {
            ...oldFailedMedia,
            timeStamp: 4_410,
            error: 'net::ERR_ABORTED'
        });
        await wait(100);

        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 18 });
        assert.equal(state.state.hostname, 'new.test');
        assert.equal(state.state.candidates.length, 0);
    } finally {
        harness.dispose();
    }
});

test('page snapshot follows a reserved navigation while tabs.get still has the old URL', async () => {
    const oldPage = 'https://old.test/article-a';
    const newPage = 'https://new.test/article-b';
    const harness = createHarness({ tabUrls: new Map([[17, oldPage]]) });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 17, url: oldPage });
        harness.fire('beforeRequest', requestDetails({
            tabId: 17,
            requestId: 'reserved-page-navigation',
            url: newPage,
            type: 'main_frame',
            timeStamp: 4_500
        }));
        await wait(80);

        const response = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 17,
            page: { url: newPage },
            media: [{ url: 'https://cdn.test/reserved/master.m3u8', type: 'HLS' }]
        }, {
            tab: { id: 17 },
            frameId: 0,
            documentId: 'reserved-new-document',
            url: newPage
        });
        assert.equal(response.stale, undefined);
        assert.equal(response.accepted, 1);
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 17 });
        assert.equal(state.state.hostname, 'new.test');
        assert.equal(state.state.candidates.length, 1);
    } finally {
        harness.dispose();
    }
});

test('manual PLAY during auto debounce opens once and token refresh preserves playing', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'page.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[4, 'https://page.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 4 });
        const first = requestDetails({
            tabId: 4,
            requestId: 'manual-before-auto',
            url: 'https://cdn.test/live/master.m3u8?token=first',
            timeStamp: 5_000
        });
        emitConfirmedMedia(harness, first);
        await wait(100);

        const detected = await harness.message({ type: 'GET_TAB_STATE', tabId: 4 });
        const candidate = detected.state.candidates[0];
        assert.ok(detected.state.auto.pendingDueAt);
        const played = await harness.message({
            type: 'PLAY',
            tabId: 4,
            candidateId: candidate.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(played.ok, true);
        assert.equal(played.state.status.state, 'playing');
        assert.equal(played.state.auto.pendingDueAt, null);

        const refreshed = requestDetails({
            ...first,
            requestId: 'same-stream-new-token',
            url: 'https://cdn.test/live/master.m3u8?token=second',
            timeStamp: 6_000
        });
        emitConfirmedMedia(harness, refreshed);
        await wait(950);

        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        assert.equal(plays[0].source, 'manual');
        const finalState = await harness.message({ type: 'GET_TAB_STATE', tabId: 4 });
        assert.equal(finalState.state.status.state, 'playing');
        assert.equal(finalState.state.status.code, 'PLAY_CONFIRMED');
        assert.equal(finalState.state.auto.pendingDueAt, null);
        assert.equal(finalState.state.candidates[0].url, refreshed.url);
    } finally {
        harness.dispose();
    }
});

test('persisted site policy succeeds and removes a stale closed-tab state', async () => {
    const sessionData = { [TAB_STATE_PREFIX + 99]: tabStateFixture(99, 'page.test') };
    const localData = {
        siteAutoLaunch: {},
        defaultPlayMode: 'new',
        legacyAutoLaunchMigrationPending: false
    };
    const harness = createHarness({
        sessionData,
        localData,
        closedTabs: new Set([99])
    });
    try {
        await harness.ready();
        const response = await harness.message({
            type: 'SET_SITE_AUTO',
            hostname: 'page.test',
            enabled: true
        });
        assert.equal(response.ok, true);
        assert.equal(localData.siteAutoLaunch['page.test'], true);
        assert.equal(response.stateSync.staleTabsRemoved, 1);
        assert.equal(sessionData[TAB_STATE_PREFIX + 99], undefined);
    } finally {
        harness.dispose();
    }
});

test('extensionless stream restores observed headers after a worker restart', async () => {
    const sessionData = {};
    const localData = {
        siteAutoLaunch: {},
        defaultPlayMode: 'new',
        legacyAutoLaunchMigrationPending: false
    };
    const tabUrls = new Map([[5, 'https://page.test/watch']]);
    const firstWorker = createHarness({ sessionData, localData, tabUrls });
    const details = requestDetails({
        tabId: 5,
        requestId: 'opaque-across-restart',
        url: 'https://cdn.test/opaque/live?token=must-not-be-persisted',
        type: 'xmlhttprequest',
        timeStamp: 7_000
    });
    try {
        await firstWorker.ready();
        firstWorker.fire('tabCreated', { id: 5 });
        firstWorker.fire('beforeRequest', details);
        firstWorker.fire('sendHeaders', {
            ...details,
            timeStamp: 7_001,
            requestHeaders: [
                { name: 'Referer', value: 'https://page.test/watch' },
                { name: 'Origin', value: 'https://page.test' },
                { name: 'User-Agent', value: 'Restart-Test/1.0' }
            ]
        });
        await wait(100);
        const contextKeys = Object.keys(sessionData).filter((key) => key.startsWith(REQUEST_CONTEXT_PREFIX));
        assert.equal(contextKeys.length, 1);
        const persistedText = JSON.stringify(sessionData[contextKeys[0]]);
        assert.doesNotMatch(persistedText, /must-not-be-persisted|cdn\.test|opaque\/live/);
    } finally {
        firstWorker.dispose();
    }

    const secondWorker = createHarness({ sessionData, localData, tabUrls });
    try {
        await secondWorker.ready();
        secondWorker.fire('headersReceived', {
            ...details,
            timeStamp: 7_100,
            statusCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
        });
        await wait(150);

        const response = await secondWorker.message({ type: 'GET_TAB_STATE', tabId: 5 });
        assert.equal(response.state.candidates.length, 1);
        const candidate = response.state.candidates[0];
        assert.equal(candidate.referer, 'https://page.test/watch');
        assert.equal(candidate.origin, 'https://page.test');
        assert.equal(candidate.userAgent, 'Restart-Test/1.0');
        assert.equal(candidate.url, details.url);

        secondWorker.fire('requestCompleted', details);
        await wait(50);
        assert.equal(Object.keys(sessionData).filter((key) => key.startsWith(REQUEST_CONTEXT_PREFIX)).length, 0);
    } finally {
        secondWorker.dispose();
    }
});

test('restart rejects an older epoch before restoring the current request headers', async () => {
    const sessionData = {};
    const localData = {
        siteAutoLaunch: {},
        defaultPlayMode: 'new',
        legacyAutoLaunchMigrationPending: false
    };
    const tabUrls = new Map([[6, 'https://old.test/watch']]);
    const firstWorker = createHarness({ sessionData, localData, tabUrls });
    const oldRequest = requestDetails({
        tabId: 6,
        requestId: 'old-epoch-request',
        url: 'https://cdn.test/opaque/live/old?token=old-secret',
        type: 'xmlhttprequest',
        timeStamp: 8_000
    });
    const navigation = requestDetails({
        tabId: 6,
        requestId: 'new-main-frame',
        url: 'https://new.test/watch',
        type: 'main_frame',
        timeStamp: 8_100
    });
    const currentRequest = requestDetails({
        tabId: 6,
        requestId: 'current-epoch-request',
        url: 'https://cdn.test/opaque/live/current?token=current-secret',
        type: 'xmlhttprequest',
        timeStamp: 8_200
    });

    try {
        await firstWorker.ready();
        firstWorker.fire('tabCreated', { id: 6, url: 'https://old.test/watch' });
        firstWorker.fire('beforeRequest', oldRequest);
        firstWorker.fire('sendHeaders', {
            ...oldRequest,
            timeStamp: 8_001,
            requestHeaders: [
                { name: 'Referer', value: 'https://old.test/watch' },
                { name: 'Origin', value: 'https://old.test' },
                { name: 'User-Agent', value: 'Old-Epoch/1.0' }
            ]
        });
        await wait(60);

        firstWorker.fire('beforeRequest', navigation);
        tabUrls.set(6, 'https://new.test/watch');
        await wait(80);

        firstWorker.fire('beforeRequest', currentRequest);
        firstWorker.fire('sendHeaders', {
            ...currentRequest,
            timeStamp: 8_201,
            requestHeaders: [
                { name: 'Referer', value: 'https://new.test/watch' },
                { name: 'Origin', value: 'https://new.test' },
                { name: 'User-Agent', value: 'Current-Epoch/2.0' }
            ]
        });
        await wait(100);

        const storedState = sessionData[TAB_STATE_PREFIX + 6];
        assert.equal(storedState.hostname, 'new.test');
        assert.equal(storedState.navigationEpoch, 2);
        const contexts = Object.values(sessionData).filter((value) =>
            value && Number.isInteger(value.tabEpoch) && value.tabId === 6
        );
        assert.deepEqual(contexts.map((value) => value.tabEpoch).sort(), [1, 2]);
    } finally {
        firstWorker.dispose();
    }

    const secondWorker = createHarness({ sessionData, localData, tabUrls });
    try {
        // Do not await startup recovery: the first response itself must resolve
        // the authoritative epoch from persisted session data.
        secondWorker.fire('headersReceived', {
            ...oldRequest,
            timeStamp: 8_300,
            statusCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
        });
        secondWorker.fire('headersReceived', {
            ...currentRequest,
            timeStamp: 8_301,
            statusCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
        });
        await wait(200);

        const response = await secondWorker.message({ type: 'GET_TAB_STATE', tabId: 6 });
        assert.equal(response.state.hostname, 'new.test');
        assert.equal(response.state.navigationEpoch, 2);
        assert.equal(response.state.candidates.length, 1);
        const candidate = response.state.candidates[0];
        assert.equal(candidate.url, currentRequest.url);
        assert.equal(candidate.referer, 'https://new.test/watch');
        assert.equal(candidate.origin, 'https://new.test');
        assert.equal(candidate.userAgent, 'Current-Epoch/2.0');
        assert.notEqual(candidate.url, oldRequest.url);
        assert.equal(Object.keys(sessionData).filter((key) => key.startsWith(REQUEST_CONTEXT_PREFIX)).length, 0);
    } finally {
        secondWorker.dispose();
    }
});

test('first page snapshot after worker wake uses the recovered tab epoch', async () => {
    const sessionData = { [TAB_STATE_PREFIX + 10]: tabStateFixture(10, 'page.test') };
    sessionData[TAB_STATE_PREFIX + 10].navigationEpoch = 4;
    const harness = createHarness({
        sessionData,
        tabUrls: new Map([[10, 'https://page.test/watch']])
    });
    try {
        // Intentionally do not call ready(): the message races startup recovery.
        const response = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            media: [{ url: 'https://cdn.test/wake/master.m3u8?token=fresh', type: 'HLS' }]
        }, {
            tab: { id: 10 },
            frameId: 0,
            documentId: 'wake-document'
        });
        assert.equal(response.ok, true);
        assert.equal(response.accepted, 1);
        assert.equal(sessionData[TAB_STATE_PREFIX + 10].navigationEpoch, 4);
        assert.equal(sessionData[TAB_STATE_PREFIX + 10].candidates.length, 1);
    } finally {
        harness.dispose();
    }
});

test('DOM discovery before HTTP 200 does not steal network confirmation', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'page.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[11, 'https://page.test/watch']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 11 });
        const details = requestDetails({
            tabId: 11,
            requestId: 'dom-before-response',
            url: 'https://cdn.test/race/master.m3u8?token=current',
            timeStamp: 20_000
        });
        harness.fire('beforeRequest', details);
        harness.fire('sendHeaders', {
            ...details,
            timeStamp: 20_001,
            requestHeaders: [
                { name: 'Referer', value: 'https://page.test/watch' },
                { name: 'User-Agent', value: 'Race-Test/1.0' }
            ]
        });
        await wait(40);
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 11,
            page: { url: 'https://page.test/watch' },
            media: [{ url: details.url, type: 'HLS', title: 'Materiał z DOM' }]
        }, { frameId: 0, documentId: 'race-document' });
        harness.fire('headersReceived', {
            ...details,
            timeStamp: 20_002,
            statusCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
        });

        await wait(950);
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 11 });
        assert.equal(state.state.candidates.length, 1);
        assert.equal(state.state.candidates[0].statusCode, 200);
        assert.equal(state.state.candidates[0].source, 'response_headers');
        assert.equal(state.state.candidates[0].referer, 'https://page.test/watch');
        assert.equal(state.state.candidates[0].title, 'Materiał z DOM');
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 1);
    } finally {
        harness.dispose();
    }
});

test('page snapshots reconcile SPA sources and keep more than forty entries', async () => {
    const harness = createHarness({ tabUrls: new Map([[12, 'https://page.test/watch']]) });
    const sender = { frameId: 0, documentId: 'spa-document' };
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 12 });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 12,
            page: { url: 'https://page.test/watch' },
            media: [{ url: 'https://cdn.test/spa/A/master.m3u8', type: 'HLS' }]
        }, sender);
        const changed = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 12,
            page: { url: 'https://page.test/watch' },
            media: [{ url: 'https://cdn.test/spa/B/master.m3u8', type: 'HLS' }]
        }, sender);
        assert.equal(changed.removed, 1);
        let state = await harness.message({ type: 'GET_TAB_STATE', tabId: 12 });
        assert.deepEqual(state.state.candidates.map((candidate) => candidate.url), [
            'https://cdn.test/spa/B/master.m3u8'
        ]);

        const media = Array.from({ length: 42 }, (_, index) => ({
            url: `https://cdn.test/many/${index}/master.m3u8`,
            type: 'HLS'
        }));
        const many = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 12,
            page: { url: 'https://page.test/watch' },
            media
        }, sender);
        assert.equal(many.accepted, 42);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 12 });
        assert.equal(state.state.candidates.length, 42);

        const empty = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 12,
            page: { url: 'https://page.test/watch' },
            media: []
        }, sender);
        assert.equal(empty.removed, 42);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 12 });
        assert.equal(state.state.candidates.length, 0);
    } finally {
        harness.dispose();
    }
});

test('same-host SPA route change drops an older network-confirmed stream', async () => {
    const firstPage = 'https://sport.tvp.pl/material-a';
    const secondPage = 'https://sport.tvp.pl/material-b';
    const harness = createHarness({ tabUrls: new Map([[15, firstPage]]) });
    const sender = { frameId: 0, documentId: 'same-spa-document' };
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 15 });
        const firstStream = requestDetails({
            tabId: 15,
            requestId: 'spa-network-a',
            url: 'https://cdn.test/spa/network-a/master.m3u8',
            timeStamp: 25_000
        });
        emitConfirmedMedia(harness, firstStream, { pageHostname: 'sport.tvp.pl' });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 15,
            page: { url: firstPage },
            media: [{ url: firstStream.url, type: 'HLS' }]
        }, sender);
        let state = await harness.message({ type: 'GET_TAB_STATE', tabId: 15 });
        assert.equal(state.state.candidates.length, 1);
        assert.equal(state.state.candidates[0].statusCode, 200);

        harness.tabUrls.set(15, secondPage);
        harness.fire('tabUpdated', 15, { url: secondPage }, { id: 15, url: secondPage });
        await wait(80);
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 15,
            page: { url: secondPage },
            media: [{ url: 'https://cdn.test/spa/network-b/master.m3u8', type: 'HLS' }]
        }, sender);

        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 15 });
        assert.equal(state.state.candidates.length, 1);
        assert.match(state.state.candidates[0].url, /network-b/);
        assert.doesNotMatch(JSON.stringify(state.state.candidates), /network-a/);

        const stale = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 15,
            page: { url: firstPage },
            media: [{ url: firstStream.url, type: 'HLS' }]
        }, { frameId: 0, documentId: 'old-document', url: firstPage });
        assert.equal(stale.stale, true);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 15 });
        assert.equal(state.state.candidates.length, 1);
        assert.match(state.state.candidates[0].url, /network-b/);
    } finally {
        harness.dispose();
    }
});

test('query identity survives hash changes while a real query change resets the session', async () => {
    const firstUrl = 'https://page.test/watch?video=one#start';
    const hashOnlyUrl = 'https://page.test/watch?video=one#details';
    const secondUrl = 'https://page.test/watch?video=two';
    const harness = createHarness({ tabUrls: new Map([[16, firstUrl]]) });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 16 });
        harness.fire('beforeRequest', requestDetails({
            tabId: 16,
            requestId: 'query-main-frame',
            url: firstUrl,
            type: 'main_frame',
            timeStamp: 26_000
        }));
        await wait(60);
        const stream = requestDetails({
            tabId: 16,
            requestId: 'query-stream',
            url: 'https://cdn.test/query/master.m3u8',
            timeStamp: 26_100
        });
        emitConfirmedMedia(harness, stream);
        await wait(60);
        let state = await harness.message({ type: 'GET_TAB_STATE', tabId: 16 });
        const confirmedEpoch = state.state.navigationEpoch;
        assert.equal(state.state.candidates[0].statusCode, 200);

        const snapshot = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 16,
            page: { url: 'https://page.test/watch' },
            media: [{ url: stream.url, type: 'HLS' }]
        }, { frameId: 0, documentId: 'query-document', url: firstUrl });
        assert.equal(snapshot.stale, undefined);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 16 });
        assert.equal(state.state.navigationEpoch, confirmedEpoch);
        assert.equal(state.state.candidates[0].statusCode, 200);

        harness.tabUrls.set(16, hashOnlyUrl);
        harness.fire('tabUpdated', 16, { url: hashOnlyUrl }, { id: 16, url: hashOnlyUrl });
        await wait(80);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 16 });
        assert.equal(state.state.navigationEpoch, confirmedEpoch);
        assert.equal(state.state.candidates.length, 1);

        harness.tabUrls.set(16, secondUrl);
        harness.fire('tabUpdated', 16, { url: secondUrl }, { id: 16, url: secondUrl });
        await wait(80);
        state = await harness.message({ type: 'GET_TAB_STATE', tabId: 16 });
        assert.equal(state.state.navigationEpoch, confirmedEpoch + 1);
        assert.equal(state.state.candidates.length, 0);
    } finally {
        harness.dispose();
    }
});

test('continuous blocked TVP traffic cannot postpone a confirmed content deadline', async () => {
    const harness = createHarness({
        localData: {
            siteAutoLaunch: { 'sport.tvp.pl': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[13, 'https://sport.tvp.pl/material']])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 13 });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 13,
            requestId: 'content-deadline',
            url: 'https://cdn.test/program/master.m3u8?token=content',
            timeStamp: 30_000
        }), { pageHostname: 'sport.tvp.pl' });

        for (let index = 0; index < 3; index += 1) {
            await wait(index === 0 ? 150 : 200);
            emitConfirmedMedia(harness, requestDetails({
                tabId: 13,
                requestId: `ad-${index}`,
                url: `https://cdn.test/video/vod/reklamy/ad-${index}.mp4?token=${index}`,
                type: 'media',
                timeStamp: 31_000 + index
            }), { pageHostname: 'sport.tvp.pl', contentType: 'video/mp4' });
        }
        await wait(400);
        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        assert.match(plays[0].stream.url, /program\/master\.m3u8/);
    } finally {
        harness.dispose();
    }
});

test('automatic host failure retries once and then stops window churn', async () => {
    const harness = createHarness({
        autoRetryCooldownMs: 50,
        localData: {
            siteAutoLaunch: { 'page.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[14, 'https://page.test/watch']]),
        nativeResponder(request) {
            return {
                protocolVersion: 2,
                hostVersion: '3.3.0-test',
                ok: false,
                action: request.action,
                requestId: request.requestId,
                errorCode: 'MPV_START_FAILED'
            };
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 14 });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 14,
            requestId: 'bounded-retry',
            url: 'https://cdn.test/retry/master.m3u8',
            timeStamp: 40_000
        }));
        await wait(1_150);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 2);
        await wait(250);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 2);
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 14 });
        assert.equal(state.state.auto.retryCount, 2);
        assert.equal(state.state.auto.pendingDueAt, null);
    } finally {
        harness.dispose();
    }
});

test('generic active player replacement supersedes an opaque HLS first phase and manual actions use content', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const firstPhaseUrl = 'https://edge.test/x/01/index.m3u8?token=one';
    const contentUrl = 'https://edge.test/x/02/file.mp4?token=two';
    const sender = { frameId: 0, documentId: 'p1', url: pageUrl };
    const harness = createHarness({
        tabUrls: new Map([[201, pageUrl]])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 201, url: pageUrl });

        emitConfirmedMedia(harness, requestDetails({
            tabId: 201,
            requestId: 'generic-first-phase',
            url: firstPhaseUrl,
            timeStamp: 50_000
        }), { pageHostname: 'video.example.test' });
        await wait(30);
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 201,
            page: { url: pageUrl },
            media: [{
                url: firstPhaseUrl,
                type: 'HLS',
                duration: 18,
                playerKeys: ['p1'],
                currentPlayerKeys: ['p1']
            }]
        }, sender);

        emitConfirmedMedia(harness, requestDetails({
            tabId: 201,
            requestId: 'generic-content-phase',
            url: contentUrl,
            type: 'media',
            timeStamp: 51_000
        }), {
            pageHostname: 'video.example.test',
            contentType: 'video/mp4'
        });
        await wait(30);
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 201,
            page: { url: pageUrl },
            media: [{
                url: contentUrl,
                type: 'MP4',
                duration: 1_800,
                playerKeys: ['p1'],
                currentPlayerKeys: ['p1']
            }]
        }, sender);

        const detected = await harness.message({ type: 'GET_TAB_STATE', tabId: 201 });
        const firstPhase = detected.state.candidates.find((candidate) => candidate.url === firstPhaseUrl);
        const content = detected.state.candidates.find((candidate) => candidate.url === contentUrl);
        assert.ok(firstPhase);
        assert.ok(content);
        assert.equal(firstPhase.superseded, true);
        assert.equal(firstPhase.diagnosticOnly, true);
        assert.equal(firstPhase.recommended, false);
        assert.equal(content.superseded, false);
        assert.equal(content.recommended, true);

        const directPlay = await harness.message({
            type: 'PLAY',
            tabId: 201,
            candidateId: content.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(directPlay.ok, true);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').at(-1).stream.url, contentUrl);

        harness.nativeMessages.length = 0;
        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 201, url: pageUrl });
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'play'));
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'resolve').length, 0);
        const contextPlay = harness.nativeMessages.find((message) => message.action === 'play');
        assert.equal(contextPlay.stream.url, contentUrl);
        assert.equal(contextPlay.source, 'manual');
    } finally {
        harness.dispose();
    }
});

test('generic auto waits for a reused player URL to advance beyond its short first phase', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const playerUrl = 'https://edge.test/player/feed.m3u8';
    const sender = { frameId: 0, documentId: 'p1', url: pageUrl };
    const harness = createHarness({
        genericPrerollGuardMs: 120,
        autoDebounceMs: 10,
        localData: {
            siteAutoLaunch: { 'video.example.test': true },
            defaultPlayMode: 'new',
            legacyAutoLaunchMigrationPending: false
        },
        tabUrls: new Map([[202, pageUrl]])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 202, url: pageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 202,
            page: { url: pageUrl },
            media: [{
                url: playerUrl,
                type: 'HLS',
                duration: 18,
                playerKeys: ['p1'],
                currentPlayerKeys: ['p1']
            }]
        }, sender);
        emitConfirmedMedia(harness, requestDetails({
            tabId: 202,
            requestId: 'reused-player-first-phase',
            url: playerUrl,
            timeStamp: 60_000
        }), { pageHostname: 'video.example.test' });

        await wait(45);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').length, 0);

        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: 202,
            page: { url: pageUrl },
            media: [{
                url: playerUrl,
                type: 'HLS',
                duration: 1_800,
                playerKeys: ['p1'],
                currentPlayerKeys: ['p1']
            }]
        }, sender);
        await waitFor(() => harness.nativeMessages.filter((message) => message.action === 'play').length === 1);
        await wait(150);

        const plays = harness.nativeMessages.filter((message) => message.action === 'play');
        assert.equal(plays.length, 1);
        assert.equal(plays[0].stream.url, playerUrl);
        assert.equal(plays[0].source, 'auto');
        const state = await harness.message({ type: 'GET_TAB_STATE', tabId: 202 });
        assert.equal(state.state.candidates.length, 1);
        assert.equal(state.state.candidates[0].duration, 1_800);
        assert.equal(state.state.candidates[0].recommended, true);
    } finally {
        harness.dispose();
    }
});

test('candidate priority is hostname-scoped, controls ranking and survives a signed URL refresh', async () => {
    const pageUrl = 'https://video.example.test/watch';
    const masterUrl = 'https://cdn.test/catalog/a/master.m3u8?token=a-one';
    const preferredUrl = 'https://cdn.test/catalog/b/file.mp4?token=b-one';
    const refreshedPreferredUrl = 'https://cdn.test/catalog/b/file.mp4?token=b-two';
    const harness = createHarness({
        tabUrls: new Map([[203, pageUrl]])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 203, url: pageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 203,
            requestId: 'priority-master',
            url: masterUrl,
            timeStamp: 70_000
        }), { pageHostname: 'video.example.test' });
        emitConfirmedMedia(harness, requestDetails({
            tabId: 203,
            requestId: 'priority-direct',
            url: preferredUrl,
            type: 'media',
            timeStamp: 70_100
        }), {
            pageHostname: 'video.example.test',
            contentType: 'video/mp4'
        });
        await wait(80);

        let state = (await harness.message({ type: 'GET_TAB_STATE', tabId: 203 })).state;
        const master = state.candidates.find((candidate) => candidate.url === masterUrl);
        const direct = state.candidates.find((candidate) => candidate.url === preferredUrl);
        assert.ok(master);
        assert.ok(direct);
        assert.equal(direct.recommended, true);
        assert.equal(master.recommended, false);

        const deprioritized = await harness.message({
            type: 'SET_CANDIDATE_PRIORITY',
            tabId: 203,
            candidateId: master.id,
            priority: 'deprioritized'
        }, harness.popupSender);
        assert.equal(deprioritized.ok, true);
        const preferred = await harness.message({
            type: 'SET_CANDIDATE_PRIORITY',
            tabId: 203,
            candidateId: direct.id,
            priority: 'preferred'
        }, harness.popupSender);
        assert.equal(preferred.ok, true);

        state = (await harness.message({ type: 'GET_TAB_STATE', tabId: 203 })).state;
        const rankedMaster = state.candidates.find((candidate) => candidate.id === master.id);
        let rankedDirect = state.candidates.find((candidate) => candidate.id === direct.id);
        assert.equal(rankedMaster.userPriority, -1);
        assert.equal(rankedMaster.recommended, false);
        assert.equal(rankedDirect.userPriority, 1);
        assert.equal(rankedDirect.recommended, true);
        const preferredFingerprint = rankedDirect.groupKey;

        emitConfirmedMedia(harness, requestDetails({
            tabId: 203,
            requestId: 'priority-direct-refresh',
            url: refreshedPreferredUrl,
            type: 'media',
            timeStamp: 71_000
        }), {
            pageHostname: 'video.example.test',
            contentType: 'video/mp4'
        });
        await wait(80);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId: 203 })).state;
        rankedDirect = state.candidates.find((candidate) => candidate.groupKey === preferredFingerprint);
        assert.ok(rankedDirect);
        assert.equal(rankedDirect.id, direct.id);
        assert.equal(rankedDirect.url, refreshedPreferredUrl);
        assert.equal(rankedDirect.userPriority, 1);
        assert.equal(rankedDirect.recommended, true);

        const directPlay = await harness.message({
            type: 'PLAY',
            tabId: 203,
            candidateId: rankedDirect.id,
            mode: 'new'
        }, harness.popupSender);
        assert.equal(directPlay.ok, true);
        assert.equal(harness.nativeMessages.filter((message) => message.action === 'play').at(-1).stream.url, refreshedPreferredUrl);

        harness.nativeMessages.length = 0;
        harness.fire('contextMenuClicked', {
            menuItemId: 'open-recommended-in-mpv',
            pageUrl
        }, { id: 203, url: pageUrl });
        await waitFor(() => harness.nativeMessages.some((message) => message.action === 'play'));
        assert.equal(harness.nativeMessages.find((message) => message.action === 'play').stream.url, refreshedPreferredUrl);

        const sameHostTabId = 205;
        harness.tabUrls.set(sameHostTabId, 'https://video.example.test/other');
        harness.fire('tabCreated', { id: sameHostTabId, url: harness.tabUrls.get(sameHostTabId) });
        emitConfirmedMedia(harness, requestDetails({
            tabId: sameHostTabId,
            requestId: 'priority-same-host',
            url: refreshedPreferredUrl,
            type: 'media',
            timeStamp: 72_000
        }), {
            pageHostname: 'video.example.test',
            contentType: 'video/mp4'
        });
        await wait(80);
        const sameHostState = (await harness.message({ type: 'GET_TAB_STATE', tabId: sameHostTabId })).state;
        assert.equal(sameHostState.candidates[0].userPriority, 1);

        const otherHostTabId = 206;
        harness.tabUrls.set(otherHostTabId, 'https://other.example.test/watch');
        harness.fire('tabCreated', { id: otherHostTabId, url: harness.tabUrls.get(otherHostTabId) });
        emitConfirmedMedia(harness, requestDetails({
            tabId: otherHostTabId,
            requestId: 'priority-other-host',
            url: refreshedPreferredUrl,
            type: 'media',
            timeStamp: 73_000
        }), {
            pageHostname: 'other.example.test',
            contentType: 'video/mp4'
        });
        await wait(80);
        const otherHostState = (await harness.message({ type: 'GET_TAB_STATE', tabId: otherHostTabId })).state;
        assert.equal(otherHostState.candidates[0].userPriority, 0);
    } finally {
        harness.dispose();
    }
});

test('full source URL visibility selected from a tab survives same-host resets and clears on another host', async () => {
    const firstUrl = 'https://visible.example.test/watch';
    const sameHostUrl = 'https://visible.example.test/next';
    const otherHostUrl = 'https://other.example.test/watch';
    const harness = createHarness({
        tabUrls: new Map([[204, firstUrl]])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: 204, url: firstUrl });

        const enabled = await harness.message({
            type: 'SET_SOURCE_URL_VISIBILITY',
            tabId: 204,
            visible: true
        }, harness.popupSender);
        assert.equal(enabled.ok, true);
        assert.equal(enabled.state.sourcePreferences.showFullUrls, true);

        let state = (await harness.message({ type: 'GET_TAB_STATE', tabId: 204 })).state;
        assert.equal(state.sourcePreferences.showFullUrls, true);
        const cleared = await harness.message({ type: 'CLEAR_TAB', tabId: 204 }, harness.popupSender);
        assert.equal(cleared.ok, true);
        assert.equal(cleared.state.sourcePreferences.showFullUrls, true);

        harness.tabUrls.set(204, sameHostUrl);
        harness.fire('tabUpdated', 204, { status: 'loading', url: sameHostUrl }, { id: 204, url: sameHostUrl });
        await wait(100);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId: 204 })).state;
        assert.equal(state.hostname, 'visible.example.test');
        assert.equal(state.sourcePreferences.showFullUrls, true);

        harness.tabUrls.set(204, otherHostUrl);
        harness.fire('tabUpdated', 204, { status: 'loading', url: otherHostUrl }, { id: 204, url: otherHostUrl });
        await wait(100);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId: 204 })).state;
        assert.equal(state.hostname, 'other.example.test');
        assert.equal(state.sourcePreferences.showFullUrls, false);
    } finally {
        harness.dispose();
    }
});

test('quality order is configurable per hostname and survives token refresh plus same-host navigation', async () => {
    const tabId = 207;
    const firstPageUrl = 'https://quality.example.test/watch/one';
    const sameHostPageUrl = 'https://quality.example.test/watch/two';
    const otherHostPageUrl = 'https://other-quality.example.test/watch';
    const quality2160Url = 'https://cdn.test/movie/quality/2160/video.mp4?token=first';
    const quality720Url = 'https://cdn.test/movie/quality/720/video.mp4?token=first';
    const refreshed720Url = 'https://cdn.test/movie/quality/720/video.mp4?token=second';
    const defaultQualityOrder = ['2160p', '1440p', '1080p', '720p', '480p'];
    const customQualityOrder = ['720p', '1080p', '2160p', '1440p', '480p'];
    const harness = createHarness({
        tabUrls: new Map([[tabId, firstPageUrl]])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: firstPageUrl });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'quality-2160',
            url: quality2160Url,
            type: 'media',
            timeStamp: 80_000
        }), {
            pageHostname: 'quality.example.test',
            contentType: 'video/mp4'
        });
        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'quality-720',
            url: quality720Url,
            type: 'media',
            timeStamp: 80_100
        }), {
            pageHostname: 'quality.example.test',
            contentType: 'video/mp4'
        });
        await wait(100);

        let state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.deepEqual(state.sourcePreferences.qualityOrder, defaultQualityOrder);
        assert.equal(state.candidates.find((candidate) => candidate.recommended)?.quality, '2160p');

        const changed = await harness.message({
            type: 'SET_QUALITY_ORDER',
            tabId,
            qualityOrder: customQualityOrder
        }, harness.popupSender);
        assert.equal(changed.ok, true);
        assert.deepEqual(changed.state.sourcePreferences.qualityOrder, customQualityOrder);
        assert.deepEqual(
            harness.localData.siteSourcePreferences['quality.example.test'].qualityOrder,
            customQualityOrder
        );

        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.candidates.find((candidate) => candidate.recommended)?.quality, '720p');

        emitConfirmedMedia(harness, requestDetails({
            tabId,
            requestId: 'quality-720-token-refresh',
            url: refreshed720Url,
            type: 'media',
            timeStamp: 81_000
        }), {
            pageHostname: 'quality.example.test',
            contentType: 'video/mp4'
        });
        await wait(100);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const refreshed720 = state.candidates.find((candidate) => candidate.url === refreshed720Url);
        assert.ok(refreshed720);
        assert.equal(state.candidates.filter((candidate) => candidate.quality === '720p').length, 1);
        assert.equal(refreshed720.recommended, true);
        assert.deepEqual(state.sourcePreferences.qualityOrder, customQualityOrder);

        const cleared = await harness.message({ type: 'CLEAR_TAB', tabId }, harness.popupSender);
        assert.equal(cleared.ok, true);
        assert.deepEqual(cleared.state.sourcePreferences.qualityOrder, customQualityOrder);

        harness.tabUrls.set(tabId, sameHostPageUrl);
        harness.fire('tabUpdated', tabId, { status: 'loading', url: sameHostPageUrl }, {
            id: tabId,
            url: sameHostPageUrl
        });
        await wait(100);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.hostname, 'quality.example.test');
        assert.deepEqual(state.sourcePreferences.qualityOrder, customQualityOrder);

        harness.tabUrls.set(tabId, otherHostPageUrl);
        harness.fire('tabUpdated', tabId, { status: 'loading', url: otherHostPageUrl }, {
            id: tabId,
            url: otherHostPageUrl
        });
        await wait(100);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.hostname, 'other-quality.example.test');
        assert.deepEqual(state.sourcePreferences.qualityOrder, defaultQualityOrder);
    } finally {
        harness.dispose();
    }
});

test('a delayed source-preference sync cannot cross a navigation hostname boundary', async () => {
    const tabId = 207;
    const firstPageUrl = 'https://first-preference.example.test/watch';
    const secondPageUrl = 'https://second-preference.example.test/watch';
    const sharedMediaUrl = 'https://cdn.example.test/shared/movie.mp4?token=refreshable';
    let armDelayedSync = false;
    let releaseDelayedSync;
    let markSyncCaptured;
    const delayedSync = new Promise((resolve) => {
        releaseDelayedSync = resolve;
    });
    const syncCaptured = new Promise((resolve) => {
        markSyncCaptured = resolve;
    });
    const harness = createHarness({
        tabUrls: new Map([[tabId, firstPageUrl]]),
        afterSessionGet: async (query) => {
            if (!armDelayedSync || query !== null) return;
            armDelayedSync = false;
            markSyncCaptured();
            await delayedSync;
        }
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: tabId, url: firstPageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: firstPageUrl },
            media: [{ url: sharedMediaUrl, type: 'MP4', duration: 1_800 }]
        }, { frameId: 0, documentId: 'first-document', url: firstPageUrl });

        let state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        const firstCandidate = state.candidates.find((candidate) => candidate.url === sharedMediaUrl);
        assert.ok(firstCandidate);
        const visibility = await harness.message({
            type: 'SET_SOURCE_URL_VISIBILITY',
            tabId,
            visible: true
        }, harness.popupSender);
        assert.equal(visibility.ok, true);

        armDelayedSync = true;
        const pendingPriority = harness.message({
            type: 'SET_CANDIDATE_PRIORITY',
            tabId,
            candidateId: firstCandidate.id,
            priority: 'preferred'
        }, harness.popupSender);
        await syncCaptured;

        harness.tabUrls.set(tabId, secondPageUrl);
        harness.fire(
            'tabUpdated',
            tabId,
            { status: 'loading', url: secondPageUrl },
            { id: tabId, url: secondPageUrl }
        );
        await wait(20);
        const discovered = await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: secondPageUrl },
            media: [{ url: sharedMediaUrl, type: 'MP4', duration: 1_800 }]
        }, { frameId: 0, documentId: 'second-document', url: secondPageUrl });
        assert.equal(discovered.ok, true);

        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.hostname, 'second-preference.example.test');
        assert.equal(state.sourcePreferences.showFullUrls, false);
        assert.equal(state.candidates.find((candidate) => candidate.url === sharedMediaUrl)?.userPriority, 0);

        releaseDelayedSync();
        const priority = await pendingPriority;
        assert.equal(priority.ok, true);
        state = (await harness.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.hostname, 'second-preference.example.test');
        assert.equal(state.sourcePreferences.showFullUrls, false);
        assert.equal(state.candidates.find((candidate) => candidate.url === sharedMediaUrl)?.userPriority, 0);
    } finally {
        releaseDelayedSync();
        harness.dispose();
    }
});

test('evicting the sixty-fifth site preference clears the evicted open tab policy', async () => {
    const evictedTabId = 208;
    const newTabId = 209;
    const evictedPageUrl = 'https://oldest-preference.example.test/watch';
    const newPageUrl = 'https://new-preference.example.test/watch';
    const mediaUrl = 'https://cdn.example.test/catalog/evicted.mp4?token=one';
    const harness = createHarness({
        tabUrls: new Map([
            [evictedTabId, evictedPageUrl],
            [newTabId, newPageUrl]
        ])
    });
    try {
        await harness.ready();
        harness.fire('tabCreated', { id: evictedTabId, url: evictedPageUrl });
        await harness.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId: evictedTabId,
            page: { url: evictedPageUrl },
            media: [{ url: mediaUrl, type: 'MP4', duration: 1_800 }]
        }, { frameId: 0, documentId: 'evicted-document', url: evictedPageUrl });

        let evictedState = (await harness.message({ type: 'GET_TAB_STATE', tabId: evictedTabId })).state;
        const candidate = evictedState.candidates.find((item) => item.url === mediaUrl);
        assert.ok(candidate);
        assert.equal((await harness.message({
            type: 'SET_SOURCE_URL_VISIBILITY',
            tabId: evictedTabId,
            visible: true
        }, harness.popupSender)).ok, true);
        assert.equal((await harness.message({
            type: 'SET_CANDIDATE_PRIORITY',
            tabId: evictedTabId,
            candidateId: candidate.id,
            priority: 'preferred'
        }, harness.popupSender)).ok, true);

        const storedMap = harness.localData.siteSourcePreferences;
        const oldestRecord = storedMap['oldest-preference.example.test'];
        assert.ok(oldestRecord);
        for (let index = 0; index < 63; index += 1) {
            const hostname = `retained-${String(index).padStart(2, '0')}.example.test`;
            storedMap[hostname] = {
                hostname,
                showFullUrls: true,
                priorities: {},
                ruleCount: 0,
                updatedAt: oldestRecord.updatedAt + 1_000 + index
            };
        }
        await wait(5);

        harness.fire('tabCreated', { id: newTabId, url: newPageUrl });
        const added = await harness.message({
            type: 'SET_SOURCE_URL_VISIBILITY',
            tabId: newTabId,
            visible: true
        }, harness.popupSender);
        assert.equal(added.ok, true);
        assert.equal(Object.keys(harness.localData.siteSourcePreferences).length, 64);
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                harness.localData.siteSourcePreferences,
                'oldest-preference.example.test'
            ),
            false
        );

        evictedState = (await harness.message({ type: 'GET_TAB_STATE', tabId: evictedTabId })).state;
        assert.equal(evictedState.hostname, 'oldest-preference.example.test');
        assert.equal(evictedState.sourcePreferences.showFullUrls, false);
        assert.equal(evictedState.candidates.find((item) => item.url === mediaUrl)?.userPriority, 0);
    } finally {
        harness.dispose();
    }
});

test('worker recovery revalidates persisted source preferences against local storage', async () => {
    const tabId = 210;
    const pageUrl = 'https://recovery-preference.example.test/watch';
    const mediaUrl = 'https://cdn.example.test/catalog/recovery.mp4?token=one';
    const sessionData = {};
    const localData = {
        siteAutoLaunch: {},
        siteSourcePreferences: {},
        defaultPlayMode: 'new',
        legacyAutoLaunchMigrationPending: false
    };
    const tabUrls = new Map([[tabId, pageUrl]]);
    const firstWorker = createHarness({ sessionData, localData, tabUrls });
    try {
        await firstWorker.ready();
        firstWorker.fire('tabCreated', { id: tabId, url: pageUrl });
        await firstWorker.message({
            type: 'PAGE_MEDIA_DISCOVERED',
            tabId,
            page: { url: pageUrl },
            media: [{ url: mediaUrl, type: 'MP4', duration: 1_800 }]
        }, { frameId: 0, documentId: 'recovery-document', url: pageUrl });
        let state = (await firstWorker.message({ type: 'GET_TAB_STATE', tabId })).state;
        const candidate = state.candidates.find((item) => item.url === mediaUrl);
        assert.ok(candidate);
        assert.equal((await firstWorker.message({
            type: 'SET_SOURCE_URL_VISIBILITY',
            tabId,
            visible: true
        }, firstWorker.popupSender)).ok, true);
        assert.equal((await firstWorker.message({
            type: 'SET_CANDIDATE_PRIORITY',
            tabId,
            candidateId: candidate.id,
            priority: 'preferred'
        }, firstWorker.popupSender)).ok, true);
        state = (await firstWorker.message({ type: 'GET_TAB_STATE', tabId })).state;
        assert.equal(state.sourcePreferences.showFullUrls, true);
        assert.equal(state.candidates.find((item) => item.url === mediaUrl)?.userPriority, 1);
    } finally {
        firstWorker.dispose();
    }

    localData.siteSourcePreferences = {};
    const recoveredWorker = createHarness({ sessionData, localData, tabUrls });
    try {
        await recoveredWorker.ready();
        const health = await recoveredWorker.message({ type: 'HEALTH' });
        assert.equal(health.ok, true);

        const recoveredState = sessionData[`${TAB_STATE_PREFIX}${tabId}`];
        assert.ok(recoveredState);
        assert.equal(recoveredState.sourcePreferences.showFullUrls, false);
        assert.equal(recoveredState.candidates.find((item) => item.url === mediaUrl)?.userPriority, 0);
    } finally {
        recoveredWorker.dispose();
    }
});

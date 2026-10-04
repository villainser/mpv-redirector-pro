'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

const previousDocument = global.document;
global.document = { addEventListener() {} };
const {
    TRANSIENT_NATIVE_HOST_ERROR_CODES,
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
    resolveCandidateUrlVisibility,
    buildCandidatePriorityRequest,
    buildSourceUrlVisibilityRequest,
    normalizeCandidateExpiry,
    isExpiredCandidate,
    isRejectedCandidate,
    isReadyCandidate,
    chooseRecommendedCandidate,
    buildMpvCommand,
    buildLaunchScript,
    sendRuntimeRequest,
    REQUEST_TIMEOUT_MS,
    PLAY_REQUEST_TIMEOUT_MS
} = require('../popup.js');
if (previousDocument === undefined) delete global.document;
else global.document = previousDocument;

function hostError(code, updatedAt) {
    return Object.freeze({
        state: 'error',
        code,
        message: 'Chrome odmówił rozszerzeniu dostępu do hosta MPV.',
        updatedAt
    });
}

function health({ hostAvailable = true, probeSucceeded = true, checkedAt }) {
    return Object.freeze({
        hostAvailable,
        mpvAvailable: hostAvailable ? true : null,
        mpvRunning: false,
        message: hostAvailable ? '' : 'Host nadal jest niedostępny.',
        probeSucceeded,
        checkedAt
    });
}

function createFakeClock() {
    let now = 0;
    let nextId = 1;
    const jobs = new Map();
    return {
        setTimeout(callback, delay = 0) {
            const id = nextId++;
            jobs.set(id, { callback, dueAt: now + Math.max(0, Number(delay) || 0) });
            return id;
        },
        clearTimeout(id) {
            jobs.delete(id);
        },
        advanceTo(target) {
            while (true) {
                const next = [...jobs.entries()]
                    .filter(([, job]) => job.dueAt <= target)
                    .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
                if (!next) break;
                const [id, job] = next;
                jobs.delete(id);
                now = job.dueAt;
                job.callback();
            }
            now = target;
        },
        pendingCount() {
            return jobs.size;
        }
    };
}

class PopupDomNode {
    constructor(ownerDocument, tagName = 'div') {
        this.ownerDocument = ownerDocument;
        this.tagName = String(tagName).toUpperCase();
        this.parentNode = null;
        this.childNodes = [];
        this.attributes = new Map();
        this.dataset = {};
        this.className = '';
        this.id = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.open = false;
        this.value = '';
        this.name = '';
        this.type = '';
        this.scrollTop = 0;
        this._textContent = '';
        this._listeners = new Map();
    }

    get parentElement() {
        return this.parentNode;
    }

    get children() {
        return this.childNodes;
    }

    get textContent() {
        return this._textContent + this.childNodes.map((child) => child.textContent).join('');
    }

    set textContent(value) {
        this._dropChildren();
        this._textContent = String(value ?? '');
    }

    get classList() {
        const node = this;
        return {
            contains(name) {
                return node.className.split(/\s+/).filter(Boolean).includes(name);
            },
            add(...names) {
                const values = new Set(node.className.split(/\s+/).filter(Boolean));
                names.forEach((name) => values.add(name));
                node.className = [...values].join(' ');
            },
            remove(...names) {
                const removed = new Set(names);
                node.className = node.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(' ');
            }
        };
    }

    appendChild(node) {
        if (node?.tagName === '#FRAGMENT') {
            for (const child of [...node.childNodes]) this.appendChild(child);
            return node;
        }
        if (!(node instanceof PopupDomNode)) throw new TypeError('The popup DOM harness accepts nodes only.');
        if (node.parentNode) node.parentNode._removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }

    append(...nodes) {
        nodes.forEach((node) => this.appendChild(node));
    }

    replaceChildren(...nodes) {
        this._dropChildren();
        this._textContent = '';
        nodes.forEach((node) => this.appendChild(node));
    }

    _removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) this.childNodes.splice(index, 1);
        node.parentNode = null;
    }

    _dropChildren() {
        const activeElement = this.ownerDocument?.activeElement;
        if (activeElement && this.childNodes.some((child) => child.contains(activeElement))) {
            this.ownerDocument.activeElement = this.ownerDocument.body;
        }
        this.childNodes.forEach((child) => {
            child.parentNode = null;
        });
        this.childNodes = [];
    }

    contains(node) {
        if (node === this) return true;
        return this.childNodes.some((child) => child.contains(node));
    }

    setAttribute(name, value) {
        const normalizedName = String(name);
        const normalizedValue = String(value);
        this.attributes.set(normalizedName, normalizedValue);
        if (normalizedName === 'class') this.className = normalizedValue;
        if (normalizedName === 'id') this.id = normalizedValue;
        if (normalizedName === 'name') this.name = normalizedValue;
        if (normalizedName === 'value') this.value = normalizedValue;
        if (normalizedName.startsWith('data-')) {
            const key = normalizedName.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
            this.dataset[key] = normalizedValue;
        }
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    toggleAttribute(name, force) {
        const enabled = force === undefined ? !this.attributes.has(name) : force === true;
        if (enabled) this.setAttribute(name, '');
        else this.removeAttribute(name);
        return enabled;
    }

    remove() {
        if (this.parentNode) this.parentNode._removeChild(this);
    }

    addEventListener(type, listener) {
        const listeners = this._listeners.get(type) || [];
        listeners.push(listener);
        this._listeners.set(type, listeners);
    }

    dispatchEvent(event) {
        const normalizedEvent = typeof event === 'string' ? { type: event } : event;
        if (!normalizedEvent.target) normalizedEvent.target = this;
        for (const listener of this._listeners.get(normalizedEvent.type) || []) listener.call(this, normalizedEvent);
        return true;
    }

    click() {
        this.dispatchEvent({ type: 'click', target: this });
    }

    focus(options) {
        this.ownerDocument.activeElement = this;
        this.ownerDocument.onFocus?.(this, options);
    }

    querySelectorAll(selector) {
        const matches = [];
        const visit = (node) => {
            for (const child of node.childNodes) {
                if (matchesPopupSelector(child, selector)) matches.push(child);
                visit(child);
            }
        };
        visit(this);
        return matches;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    closest(selector) {
        let current = this;
        while (current) {
            if (matchesPopupSelector(current, selector)) return current;
            current = current.parentNode;
        }
        return null;
    }

    matches(selector) {
        return matchesPopupSelector(this, selector);
    }

    getBoundingClientRect() {
        const rect = this.ownerDocument.getBoundingClientRect?.(this);
        if (rect) return rect;
        return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    }

    scrollIntoView() {}

    scrollTo(first, second) {
        this.scrollTop = typeof first === 'object' ? Number(first?.top) || 0 : Number(second) || 0;
    }
}

function matchesPopupSelector(node, selector) {
    let remaining = String(selector).trim();
    const needsChecked = remaining.endsWith(':checked');
    if (needsChecked) remaining = remaining.slice(0, -8);

    const attributes = [];
    remaining = remaining.replace(/\[([^=\]]+)(?:="([^"]*)")?\]/g, (_match, name, value) => {
        attributes.push({ name, value });
        return '';
    });

    const parts = remaining.split('.');
    const tag = parts.shift();
    const classNames = parts.filter(Boolean);
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    const nodeClasses = node.className.split(/\s+/).filter(Boolean);
    if (classNames.some((name) => !nodeClasses.includes(name))) return false;
    if (needsChecked && node.checked !== true) return false;

    return attributes.every(({ name, value }) => {
        const actual = name === 'name'
            ? node.name
            : name === 'value'
                ? node.value
                : name === 'open'
                    ? (node.open ? '' : null)
                : name.startsWith('data-')
                    ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())]
                    : node.getAttribute(name);
        return value === undefined ? actual !== undefined && actual !== null : String(actual) === value;
    });
}

class PopupDocument {
    constructor(options = {}) {
        this.onFocus = options.onFocus;
        this.getBoundingClientRect = options.getBoundingClientRect;
        this._listeners = new Map();
        this._elementsById = new Map();
        this.body = new PopupDomNode(this, 'body');
        this.documentElement = this.body;
        this.activeElement = this.body;
        this.appShell = new PopupDomNode(this, 'div');
        this.appShell.className = 'app-shell';
        this.body.appendChild(this.appShell);
        // Reuse the fixture's scroll container as the browser document scroller.
        this.scrollingElement = this.appShell;

        const buttonIds = new Set([
            'refresh-button', 'resolve-page-button', 'quick-play-button', 'export-m3u-button', 'clear-button'
        ]);
        const inputIds = new Set(['site-auto-toggle', 'resolver-cookie-toggle', 'show-full-urls-toggle']);
        const detailsIds = new Set(['diagnostics-panel']);
        const ids = [
            'app-version', 'host-health', 'host-health-text', 'mpv-health', 'mpv-health-text',
            'refresh-button', 'site-hostname', 'site-auto-toggle', 'site-auto-note', 'resolver-health',
            'resolver-note', 'resolve-page-button', 'resolver-cookie-toggle', 'resolver-cookie-host',
            'resolver-cookie-note', 'permission-notice', 'permission-message', 'host-notice',
            'host-notice-title', 'host-notice-message', 'progress-card', 'stage-icon', 'stage-label',
            'status-title', 'status-message', 'reason-label', 'status-reason', 'play-options', 'mode-help',
            'candidate-count', 'diagnostic-source-note', 'playlist-tools', 'playlist-summary',
            'quick-play-button', 'export-m3u-button', 'source-preferences', 'show-full-urls-toggle',
            'candidate-content', 'diagnostics-panel', 'event-count', 'event-list', 'global-feedback',
            'clear-button'
        ];
        for (const id of ids) {
            const tag = buttonIds.has(id) ? 'button' : inputIds.has(id) ? 'input' : detailsIds.has(id) ? 'details' : 'div';
            const element = new PopupDomNode(this, tag);
            element.id = id;
            this._elementsById.set(id, element);
            this.appShell.appendChild(element);
        }

        for (const value of ['new', 'append', 'replace']) {
            const input = new PopupDomNode(this, 'input');
            input.name = 'play-mode';
            input.value = value;
            input.checked = value === 'new';
            this.appShell.appendChild(input);
        }
    }

    createElement(tagName) {
        return new PopupDomNode(this, tagName);
    }

    createDocumentFragment() {
        return new PopupDomNode(this, '#fragment');
    }

    getElementById(id) {
        return this._elementsById.get(id) || null;
    }

    addEventListener(type, listener) {
        const listeners = this._listeners.get(type) || [];
        listeners.push(listener);
        this._listeners.set(type, listeners);
    }

    dispatch(type) {
        for (const listener of this._listeners.get(type) || []) listener({ type, target: this });
    }

    querySelectorAll(selector) {
        return this.body.querySelectorAll(selector);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
}

function popupCandidate(id, url, score, recommended = false) {
    return {
        id,
        url,
        type: url.endsWith('.mp4') ? 'MP4' : 'HLS',
        title: `Źródło ${id.toUpperCase()}`,
        score,
        recommended,
        purpose: 'content',
        role: url.endsWith('.mp4') ? 'direct' : 'master',
        mediaKind: 'adaptive',
        sourceMethod: 'page_dom'
    };
}

function popupState(candidates) {
    return {
        hostname: 'video.example',
        platform: { id: 'generic', label: 'Strona internetowa' },
        sourcePreferences: {
            showFullUrls: false,
            qualityOrder: ['2160p', '1440p', '1080p', '720p', '480p']
        },
        candidates,
        events: [],
        status: { code: 'READY', recommendedCandidateId: 'source-a' }
    };
}

function createPopupDomHarness(initialState, options = {}) {
    const document = new PopupDocument(options);
    const animationFrames = [];
    const storageListeners = [];
    const runtimeMessages = [];
    const clipboardWrites = [];
    let currentNow = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    class HarnessDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [currentNow]));
        }

        static now() {
            return currentNow;
        }
    }
    let deferredHealthCallback = null;
    const healthResponse = {
        ok: true,
        hostAvailable: true,
        mpvAvailable: true,
        mpvRunning: false,
        capabilities: ['resolve'],
        resolvers: {
            streamlink: { installed: true, available: true, compatible: true },
            ytDlp: { installed: true, available: true, compatible: true }
        }
    };
    const chrome = {
        runtime: {
            lastError: null,
            getManifest: () => ({ version: 'test' }),
            sendMessage(message, callback) {
                runtimeMessages.push(clone(message));
                if (message.type === 'HEALTH' && options.deferHealth === true) {
                    deferredHealthCallback = callback;
                    return;
                }
                if (message.type === 'PLAY' && options.playResponse) {
                    callback(clone(options.playResponse));
                    return;
                }
                const responses = {
                    GET_TAB_STATE: { ok: true, state: initialState },
                    HEALTH: healthResponse,
                    GET_SITE_AUTO: { ok: true, enabled: false },
                    GET_RESOLVER_COOKIE_POLICY: {
                        ok: true,
                        enabled: false,
                        httpsEligible: true,
                        enabledSiteCount: 0
                    }
                };
                if (message.type === 'SET_QUALITY_ORDER') {
                    const state = clone(initialState);
                    state.sourcePreferences = {
                        ...state.sourcePreferences,
                        qualityOrder: clone(message.qualityOrder)
                    };
                    callback({ ok: true, state });
                    return;
                }
                callback(responses[message.type] || { ok: true });
            }
        },
        tabs: {
            query(_query, callback) {
                callback([{ id: 41, url: 'https://video.example/watch/fixture' }]);
            }
        },
        storage: {
            onChanged: {
                addListener(listener) {
                    storageListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageListeners.indexOf(listener);
                    if (index >= 0) storageListeners.splice(index, 1);
                }
            },
            local: {
                get(defaults, callback) {
                    callback({ ...defaults, defaultPlayMode: 'new' });
                },
                set(_values, callback) {
                    callback();
                }
            }
        },
        permissions: {
            contains(_permissions, callback) {
                callback(false);
            }
        }
    };
    const window = {
        addEventListener() {},
        innerHeight: 600,
        scrollY: 0,
        scrollTo(_x, y) {
            this.scrollY = y;
        }
    };
    const source = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
    const context = vm.createContext({
        module: { exports: {} },
        exports: {},
        document,
        window,
        chrome,
        console,
        URL,
        Blob,
        Date: HarnessDate,
        navigator: {
            clipboard: {
                async writeText(value) {
                    clipboardWrites.push(String(value));
                }
            }
        },
        CSS: { escape: (value) => String(value) },
        requestAnimationFrame: (callback) => {
            if (options.queueAnimationFrames === true) return animationFrames.push(callback);
            return callback(0);
        },
        queueMicrotask,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source, context, { filename: 'popup.js' });
    document.dispatch('DOMContentLoaded');

    return {
        document,
        runtimeMessages,
        clipboardWrites,
        flushAnimationFrames() {
            for (const callback of animationFrames.splice(0)) callback(currentNow);
        },
        setNow(value) {
            currentNow = Number(value);
        },
        emitTabState(nextState) {
            for (const listener of storageListeners) {
                listener({ tabState_41: { oldValue: initialState, newValue: nextState } }, 'session');
            }
        },
        resolveHealth() {
            assert.ok(deferredHealthCallback, 'the HEALTH response should be pending');
            const callback = deferredHealthCallback;
            deferredHealthCallback = null;
            callback(healthResponse);
        }
    };
}

function candidateCard(document, candidateId) {
    const identityButton = document.querySelectorAll('.candidate-priority-button')
        .find((button) => button.dataset.candidateId === candidateId);
    return identityButton?.closest('.candidate-card') || null;
}

function candidateIdForNode(node) {
    return node?.closest('.candidate-card')
        ?.querySelector('.candidate-priority-button')
        ?.dataset.candidateId || '';
}

async function settlePopup() {
    for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test('newer successful health supersedes an older transient native-host error without mutating history', () => {
    const status = hostError('NATIVE_HOST_FORBIDDEN', 100);
    const originalStatus = { ...status };
    const view = createRecoveredNativeHostView(status, health({ checkedAt: 200 }), 1);

    assert.equal(isSupersededTransientNativeHostError(status, health({ checkedAt: 200 })), true);
    assert.equal(view.title, 'Host lokalny odpowiada');
    assert.equal(view.tone, 'success');
    assert.doesNotMatch(JSON.stringify(view), /Chrome odmówił/);
    assert.deepEqual(status, originalStatus);
});

test('recovery is independent of whether state or health response renders first', () => {
    const status = hostError('NATIVE_HOST_NOT_FOUND', 100);
    const successfulHealth = health({ checkedAt: 200 });

    let currentHealth = health({ hostAvailable: false, checkedAt: 0 });
    assert.equal(createRecoveredNativeHostView(status, currentHealth), null);
    currentHealth = successfulHealth;
    const stateFirstView = createRecoveredNativeHostView(status, currentHealth);

    let currentStatus = null;
    assert.equal(createRecoveredNativeHostView(currentStatus, successfulHealth), null);
    currentStatus = status;
    const healthFirstView = createRecoveredNativeHostView(currentStatus, successfulHealth);

    assert.deepEqual(healthFirstView, stateFirstView);
    assert.equal(stateFirstView.title, 'Host lokalny odpowiada');
});

test('health must be strictly newer than the stored error', () => {
    const status = hostError('NATIVE_HOST_DISCONNECTED', 200);

    assert.equal(createRecoveredNativeHostView(status, health({ checkedAt: 199 })), null);
    assert.equal(createRecoveredNativeHostView(status, health({ checkedAt: 200 })), null);
    assert.notEqual(createRecoveredNativeHostView(status, health({ checkedAt: 201 })), null);
});

test('missing or non-numeric timestamps cannot establish that an error is older', () => {
    const successfulHealth = health({ checkedAt: 200 });

    assert.equal(createRecoveredNativeHostView(hostError('NATIVE_HOST_FORBIDDEN', undefined), successfulHealth), null);
    assert.equal(createRecoveredNativeHostView(hostError('NATIVE_HOST_FORBIDDEN', null), successfulHealth), null);
    assert.equal(createRecoveredNativeHostView(hostError('NATIVE_HOST_FORBIDDEN', '100'), successfulHealth), null);
    assert.equal(createRecoveredNativeHostView(hostError('NATIVE_HOST_FORBIDDEN', 100), health({ checkedAt: null })), null);
});

test('a native-host error recorded after health is not masked', () => {
    const successfulHealth = health({ checkedAt: 200 });
    const laterError = hostError('NATIVE_MESSAGING_ERROR', 201);

    assert.equal(isSupersededTransientNativeHostError(laterError, successfulHealth), false);
    assert.equal(createRecoveredNativeHostView(laterError, successfulHealth), null);
});

test('failed health never supersedes the stored host error', () => {
    const status = hostError('NATIVE_TIMEOUT', 100);
    const failedHealth = health({ hostAvailable: false, probeSucceeded: false, checkedAt: 200 });
    const classifiedButRejectedHealth = health({ hostAvailable: true, probeSucceeded: false, checkedAt: 200 });

    assert.equal(isSupersededTransientNativeHostError(status, failedHealth), false);
    assert.equal(createRecoveredNativeHostView(status, failedHealth), null);
    assert.equal(isSupersededTransientNativeHostError(status, classifiedButRejectedHealth), false);
    assert.equal(createRecoveredNativeHostView(status, classifiedButRejectedHealth), null);
});

test('only the explicit transient transport allowlist can be superseded', () => {
    const successfulHealth = health({ checkedAt: 200 });

    for (const code of TRANSIENT_NATIVE_HOST_ERROR_CODES) {
        assert.notEqual(createRecoveredNativeHostView(hostError(code, 100), successfulHealth), null, code);
    }
    assert.equal(createRecoveredNativeHostView(hostError('MPV_IPC_PROTOCOL', 100), successfulHealth), null);
    assert.equal(createRecoveredNativeHostView(hostError('MPV_NOT_FOUND', 100), successfulHealth), null);
    assert.equal(createRecoveredNativeHostView(hostError('PERMISSION_DENIED', 100), successfulHealth), null);
});

test('candidate origins distinguish network, page adapter, Streamlink and yt-dlp', () => {
    assert.equal(resolverMethodLabel('resolver_streamlink'), 'Streamlink');
    assert.equal(resolverMethodLabel('resolver_ytdlp'), 'yt-dlp');
    assert.equal(resolverMethodLabel('manifest_scan'), 'Manifest');
    assert.equal(resolverMethodLabel('page_dom'), 'Strona');
    assert.equal(resolverMethodLabel('response_headers'), 'Sieć');
    assert.deepEqual(
        candidateOriginLabels('network', ['response_headers', 'resolver_streamlink', 'resolver_ytdlp']),
        ['Sieć', 'Streamlink', 'yt-dlp']
    );
});

test('resolver order copy follows the platform adapter', () => {
    assert.equal(resolverOrderCopy('youtube').label, 'yt-dlp → Streamlink');
    assert.match(resolverOrderCopy('youtube').action, /^Najpierw uruchamiam yt-dlp/);
    assert.equal(resolverOrderCopy('generic', 'www.youtube.com').label, 'yt-dlp → Streamlink');
    assert.equal(resolverOrderCopy('generic', 'youtu.be').label, 'yt-dlp → Streamlink');
    assert.equal(resolverOrderCopy('generic', 'notyoutube.com').label, 'Streamlink → yt-dlp');
    assert.equal(resolverOrderCopy('tvp').label, 'Streamlink → yt-dlp');
    assert.equal(resolverOrderCopy('generic').label, 'Streamlink → yt-dlp');
    assert.equal(resolverPlatformId('generic', 'www.youtube.com'), 'youtube');
    assert.equal(resolverPlatformLabel({ id: 'generic', label: 'Strona internetowa' }, 'www.youtube.com'), 'YouTube');
    assert.equal(resolverPlatformLabel({ id: 'generic', label: 'Strona internetowa' }, 'sport.tvp.pl'), 'TVP');
});

test('Polish candidate counters use the few form outside teen endings', () => {
    for (const value of [2, 3, 4, 22, 23, 24, 102]) assert.equal(usesPolishFewForm(value), true, value);
    for (const value of [0, 1, 5, 11, 12, 13, 14, 25, 112, 114]) assert.equal(usesPolishFewForm(value), false, value);
});

test('candidate origin labels are deduplicated and default to network', () => {
    assert.deepEqual(candidateOriginLabels('', []), ['Sieć']);
    assert.deepEqual(
        candidateOriginLabels('streamlink', ['resolver_streamlink', 'resolver_streamlink']),
        ['Streamlink']
    );
});

test('resolver attempt summary exposes actionable stages without command output', () => {
    assert.equal(
        resolverAttemptSummary([
            { resolver: 'streamlink', status: 'timeout', stderr: 'sekret' },
            { resolver: 'yt-dlp', status: 'invalid_output', url: 'https://secret.invalid/' }
        ]),
        'Streamlink: limit czasu; yt-dlp: niepoprawna odpowiedź'
    );
    assert.doesNotMatch(resolverAttemptSummary([{ resolver: 'streamlink', status: 'failed', stderr: 'sekret' }]), /sekret/);
});

test('candidate metadata names audio-only and language without calling it video', () => {
    assert.equal(candidateMediaKindLabel('audio-only', 'audio', false), 'Tylko dźwięk');
    assert.equal(candidateMediaKindLabel('video-only', 'direct', false), 'Tylko obraz');
    assert.equal(candidateMediaKindLabel('adaptive', 'master', false), 'Adaptacyjne audio + wideo');
    assert.equal(candidateLanguageLabel('pl-PL'), 'Język: pl-PL');
    assert.equal(candidateLanguageLabel('bad tag'), '');
    assert.equal(mpvAlangValue('pl-PL'), 'pl-PL,pl');
    assert.equal(mpvAlangValue('en'), 'en');
    assert.equal(mpvAlangValue('pl,--profile=evil'), '');
    assert.equal(
        ytdlFormatValue('pl-PL'),
        'bv[height<=1080]+ba[language=pl-PL]/bv[height<=1080]+ba[language^=pl]/b[height<=1080][language=pl-PL]/b[height<=1080][language^=pl]/bv[height<=1080]+ba/b[height<=1080]'
    );
    assert.equal(ytdlFormatValue('bad tag'), 'bv[height<=1080]+ba/b[height<=1080]');
    assert.match(diagnosticSourceCountLabel(3), /^3 technicznych obserwacji/);
});

test('candidate priorities accept only the three numeric contract values and build exact worker payloads', () => {
    assert.equal(normalizeUserPriority(1), 1);
    assert.equal(normalizeUserPriority(0), 0);
    assert.equal(normalizeUserPriority(-1), -1);
    for (const invalid of ['1', '-1', 2, -2, NaN, null, undefined, true]) {
        assert.equal(normalizeUserPriority(invalid), 0, String(invalid));
    }
    assert.equal(candidatePriorityMode(1), 'preferred');
    assert.equal(candidatePriorityMode(0), 'normal');
    assert.equal(candidatePriorityMode(-1), 'deprioritized');
    assert.deepEqual(buildCandidatePriorityRequest(42, 'candidate-a', 1), {
        tabId: 42,
        candidateId: 'candidate-a',
        priority: 'preferred'
    });
    assert.deepEqual(buildCandidatePriorityRequest(42, 'candidate-a', -1), {
        tabId: 42,
        candidateId: 'candidate-a',
        priority: 'deprioritized'
    });
});

test('full source URLs are hidden by default and a temporary per-card choice overrides the site setting', () => {
    assert.deepEqual(normalizeSourcePreferences(), { showFullUrls: false });
    assert.deepEqual(normalizeSourcePreferences({}), { showFullUrls: false });
    assert.deepEqual(normalizeSourcePreferences({ showFullUrls: 'true' }), { showFullUrls: false });
    assert.deepEqual(normalizeSourcePreferences({ showFullUrls: true }), { showFullUrls: true });
    assert.equal(resolveCandidateUrlVisibility(false, undefined), false);
    assert.equal(resolveCandidateUrlVisibility(true, undefined), true);
    assert.equal(resolveCandidateUrlVisibility(false, true), true);
    assert.equal(resolveCandidateUrlVisibility(true, false), false);
    assert.deepEqual(buildSourceUrlVisibilityRequest(42, true), { tabId: 42, visible: true });
    assert.deepEqual(buildSourceUrlVisibilityRequest(42, 'true'), { tabId: 42, visible: false });
});

test('a provisional preroll is never recommended while proper content exists', () => {
    const preroll = { id: 'preroll', score: 100, recommended: true, prerollProvisional: true };
    const content = { id: 'content', score: 25, recommended: false, prerollProvisional: false };

    assert.equal(chooseRecommendedCandidate([preroll, content], { recommendedCandidateId: 'preroll' }), content);
    assert.equal(chooseRecommendedCandidate([preroll], { recommendedCandidateId: 'preroll' }), null);
    assert.equal(isReadyCandidate({
        id: 'preroll',
        url: 'https://media.example/preroll.m3u8',
        purpose: 'content',
        prerollProvisional: true
    }), true, 'provisional sources remain available for explicit manual play');
    assert.equal(chooseRecommendedCandidate([
        { id: 'canonical-first', score: 10 },
        { id: 'later-high-score', score: 90 }
    ], {}).id, 'canonical-first');
});

test('expired and play-rejected candidates are neither ready nor recommended', () => {
    const now = Date.now();
    const pastSeconds = Math.floor(now / 1000) - 60;
    const futureSeconds = Math.floor(now / 1000) + 3_600;
    const base = {
        id: 'candidate',
        url: 'https://cdn.video.example/master.m3u8',
        purpose: 'content',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true
    };

    assert.equal(normalizeCandidateExpiry(pastSeconds), pastSeconds * 1000);
    assert.equal(normalizeCandidateExpiry(now), now);
    assert.equal(normalizeCandidateExpiry('not-a-date'), null);
    assert.equal(isExpiredCandidate({ ...base, raw: { expired: true } }, now), true);
    assert.equal(isExpiredCandidate({ ...base, raw: { expiry: pastSeconds } }, now), true);
    assert.equal(isExpiredCandidate({ ...base, expiry: futureSeconds }, now), false);
    assert.equal(isRejectedCandidate({ ...base, raw: { playState: 'error' } }, now), true);
    assert.equal(isReadyCandidate({ ...base, raw: { expired: true } }), false);
    assert.equal(isReadyCandidate({ ...base, raw: { expiry: pastSeconds } }), false);
    assert.equal(isReadyCandidate({ ...base, raw: { playState: 'error' } }), false);

    const fresh = { ...base, id: 'fresh', recommended: false };
    const stale = { ...base, id: 'stale', recommended: true, expired: true };
    assert.equal(
        chooseRecommendedCandidate([stale, fresh], { recommendedCandidateId: 'stale' })?.id,
        'fresh'
    );
});

test('popup recommendation skips incomplete tracks even when stale state marks one recommended', () => {
    const videoOnly = {
        id: 'video-only',
        score: 999,
        recommended: true,
        mediaKind: 'video-only',
        hasAudio: false,
        hasVideo: true
    };
    const muxed1080 = {
        id: 'muxed-1080',
        score: 20,
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true
    };

    assert.equal(
        chooseRecommendedCandidate([videoOnly, muxed1080], { recommendedCandidateId: 'video-only' })?.id,
        'muxed-1080'
    );
});

test('popup keeps canonical transport order aligned with the recommended card and quick play', async () => {
    const video1080 = {
        ...popupCandidate('source-a', 'https://cdn.video.example/movie-1080.mp4', 40, true),
        quality: '1080p',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        sourceMethod: 'network'
    };
    const stream720 = {
        ...popupCandidate('source-b', 'https://cdn.video.example/master-720.m3u8', 90),
        quality: '720p',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        sourceMethod: 'manifest'
    };
    const pageRecipe = {
        ...popupCandidate('page-recipe', 'https://video.example/watch', 100),
        type: 'MEDIA',
        playbackKind: 'yt-dlp-page',
        sourceMethod: 'yt-dlp'
    };
    const incomplete = {
        ...popupCandidate('video-only', 'https://cdn.video.example/track-2160.mp4', 999),
        quality: '2160p',
        mediaKind: 'video-only',
        hasAudio: false,
        hasVideo: true
    };
    const diagnostic = {
        ...popupCandidate('diagnostic', 'https://cdn.video.example/old.mp4', 999),
        diagnosticOnly: true
    };
    const harness = createPopupDomHarness(popupState([
        video1080,
        stream720,
        pageRecipe,
        incomplete,
        diagnostic
    ]));
    await settlePopup();

    const renderedIds = harness.document.querySelectorAll('.candidate-card')
        .map((card) => card.dataset.candidateId);
    assert.deepEqual(renderedIds, ['source-a', 'source-b', 'page-recipe', 'video-only']);
    assert.equal(harness.document.querySelectorAll('.candidate-card.recommended').length, 1);
    assert.equal(harness.document.querySelector('.candidate-card.recommended').dataset.candidateId, 'source-a');
    assert.equal(harness.document.getElementById('quick-play-button').dataset.candidateId, 'source-a');
    assert.match(harness.document.getElementById('diagnostic-source-note').textContent, /1 techniczna/);
});

test('popup hides expired and play-rejected sources while preserving a fresh recommendation', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const fresh = popupCandidate('source-a', 'https://cdn.video.example/movie-1080.mp4', 90, true);
    const explicitExpired = {
        ...popupCandidate('expired-flag', 'https://cdn.video.example/expired-flag.m3u8', 99),
        expired: true
    };
    const deadlineExpired = {
        ...popupCandidate('expired-time', 'https://cdn.video.example/expired-time.m3u8', 98),
        expiry: nowSeconds - 60
    };
    const rejected = {
        ...popupCandidate('play-error', 'https://cdn.video.example/play-error.m3u8', 97),
        playState: 'error'
    };
    const harness = createPopupDomHarness(popupState([
        fresh,
        explicitExpired,
        deadlineExpired,
        rejected
    ]));
    await settlePopup();

    assert.deepEqual(
        harness.document.querySelectorAll('.candidate-card').map((card) => card.dataset.candidateId),
        ['source-a']
    );
    assert.equal(harness.document.getElementById('candidate-count').textContent, '1');
    assert.equal(harness.document.getElementById('quick-play-button').dataset.candidateId, 'source-a');
    assert.equal(candidateCard(harness.document, 'expired-flag'), null);
    assert.equal(candidateCard(harness.document, 'expired-time'), null);
    assert.equal(candidateCard(harness.document, 'play-error'), null);
    assert.match(
        harness.document.getElementById('playlist-summary').textContent,
        /Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle\. Ukryto 3 wpisy\./
    );
});

test('secondary actions revalidate a signed source after an open popup outlives its expiry', async () => {
    const now = 1_787_995_000_000;
    const signedUrl = `https://cdn.video.example/movie-1080.m3u8?validto=${Math.floor(now / 1000) + 1}&token=secret`;
    const source = {
        ...popupCandidate('source-a', signedUrl, 90, true),
        expiresAt: now + 1_000
    };
    const harness = createPopupDomHarness(popupState([source]), { nowMs: now });
    await settlePopup();

    const card = candidateCard(harness.document, source.id);
    assert.ok(card);
    harness.setNow(now + 2_000);

    for (const label of ['Kopiuj URL', 'Kopiuj komendę', 'Zapisz skrypt']) {
        const button = card.querySelectorAll('button').find((entry) => entry.textContent === label);
        assert.ok(button, label);
        button.click();
        await settlePopup();
        const feedback = card.querySelector('.action-feedback').textContent;
        assert.match(feedback, /wygasło|świeżego/i);
        assert.doesNotMatch(feedback, /secret|https?:\/\//i);
    }
    assert.deepEqual(harness.clipboardWrites, []);
});

test('popup explains background recovery when every candidate has expired', async () => {
    const state = popupState([{
        ...popupCandidate('expired', 'https://cdn.video.example/expired.m3u8', 99, true),
        expiry: Math.floor(Date.now() / 1000) - 60
    }]);
    state.status = { code: 'STREAM_REFRESHING' };
    const harness = createPopupDomHarness(state);
    await settlePopup();

    const content = harness.document.getElementById('candidate-content').textContent;
    assert.match(content, /Źródła wygasły lub zostały odrzucone/);
    assert.match(content, /Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle/);
    assert.match(content, /uruchom materiał na stronie ponownie/);
    assert.equal(harness.document.getElementById('status-title').textContent, 'Szukam świeżego źródła');
    assert.equal(
        harness.document.getElementById('status-message').textContent,
        'Wygasłe lub odrzucone źródło jest ukryte i odświeżane w tle.'
    );
    assert.match(harness.document.getElementById('status-reason').textContent, /Nie wybieraj starego adresu/);
});

test('STREAM_URL_EXPIRED play errors use friendly recovery copy without exposing raw details', async () => {
    const source = popupCandidate('source-a', 'https://cdn.video.example/master.m3u8', 90, true);
    const harness = createPopupDomHarness(popupState([source]), {
        playResponse: {
            ok: false,
            code: 'STREAM_URL_EXPIRED',
            message: 'upstream rejected token=secret-value'
        }
    });
    await settlePopup();

    harness.document.getElementById('quick-play-button').click();
    await settlePopup();

    assert.equal(harness.document.getElementById('status-title').textContent, 'Nie udało się otworzyć w MPV');
    assert.equal(
        harness.document.getElementById('status-message').textContent,
        'Wybrane źródło wygasło i zostało ukryte. Wtyczka szuka świeżego adresu w tle.'
    );
    assert.match(harness.document.getElementById('status-reason').textContent, /Wtyczka skanuje stronę w tle/);
    assert.doesNotMatch(harness.document.getElementById('global-feedback').textContent, /secret-value/);
});

test('popup renders the bounded fallback stage and reports a successful fallback without a public flag', async () => {
    const source = popupCandidate('source-a', 'https://cdn.video.example/master.m3u8', 90, true);
    const initialState = popupState([source]);
    const harness = createPopupDomHarness(initialState, {
        playResponse: {
            ok: true,
            action: 'PLAY',
            result: {
                mode: 'new',
                fallbackUsed: true,
                initialErrorCode: 'MPV_LOAD_FAILED'
            }
        }
    });
    await settlePopup();

    harness.emitTabState({
        ...initialState,
        status: {
            code: 'PLAY_FALLBACK_OPENING',
            state: 'opening',
            message: 'Pierwsze źródło nie zadziałało. Próbuję raz z bezpiecznym źródłem zapasowym…'
        }
    });
    await settlePopup();
    assert.equal(harness.document.getElementById('stage-label').textContent, 'Próba zapasowa');
    assert.equal(harness.document.getElementById('status-title').textContent, 'Próbuję innego źródła');

    harness.document.getElementById('quick-play-button').click();
    await settlePopup();

    assert.match(
        harness.document.getElementById('status-message').textContent,
        /użyto bezpiecznego źródła zapasowego/
    );
    const playRequest = harness.runtimeMessages.find((message) => message.type === 'PLAY');
    assert.ok(playRequest);
    assert.equal(Object.hasOwn(playRequest, 'fallbackOnce'), false);
});

test('copied yt-dlp command uses the installed resolver path and preserves every playback option', () => {
    const candidate = {
        url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4&list=PL123',
        language: 'pl-PL',
        playbackKind: 'yt-dlp-page',
        raw: {
            referer: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
            origin: 'https://www.youtube.com',
            userAgent: 'Popup-Test/1.0'
        }
    };
    const expectedParts = [
        'mpv',
        '--tls-verify=yes',
        '--load-unsafe-playlists=no',
        "--referrer='https://www.youtube.com/watch?v=YE7VzlLtp-4'",
        "--user-agent='Popup-Test/1.0'",
        "--http-header-fields='Origin: https://www.youtube.com'",
        '"--script-opts-append=ytdl_hook-ytdl_path=$HOME/.local/share/mpv-redirector/resolvers/bin/yt-dlp"',
        '--script-opts-append=ytdl_hook-try_ytdl_first=yes',
        '--script-opts-append=ytdl_hook-use_manifests=no',
        '--script-opts-append=ytdl_hook-all_formats=no',
        '--script-opts-append=ytdl_hook-force_all_formats=no',
        '--script-opts-append=ytdl_hook-thumbnails=none',
        '--script-opts-append=ytdl_hook-exclude=',
        '--ytdl=yes',
        "--ytdl-format='bv[height<=1080]+ba[language=pl-PL]/bv[height<=1080]+ba[language^=pl]/b[height<=1080][language=pl-PL]/b[height<=1080][language^=pl]/bv[height<=1080]+ba/b[height<=1080]'",
        '--ytdl-raw-options-append=ignore-config=',
        '--ytdl-raw-options-append=no-plugin-dirs=',
        '--ytdl-raw-options-append=no-remote-components=',
        '--ytdl-raw-options-append=no-update=',
        '--ytdl-raw-options-append=no-cache-dir=',
        '--ytdl-raw-options-append=no-cookies-from-browser=',
        '--ytdl-raw-options-append=no-cookies=',
        '--ytdl-raw-options-append=no-playlist=',
        '--ytdl-raw-options-append=playlist-items=1',
        '--ytdl-raw-options-append=no-wait-for-video=',
        '--ytdl-raw-options-append=no-mark-watched=',
        '--ytdl-raw-options-append=socket-timeout=5',
        '--ytdl-raw-options-append=extractor-retries=1',
        '--ytdl-raw-options-append=retries=0',
        '--ytdl-raw-options-append=fragment-retries=0',
        "--alang='pl-PL,pl'",
        '--',
        "'https://www.youtube.com/watch?v=YE7VzlLtp-4&list=PL123'"
    ];
    const command = buildMpvCommand(candidate);

    assert.equal(command, expectedParts.join(' '));
    assert.doesNotMatch(command, /XDG_DATA_HOME/);
    assert.equal(buildLaunchScript(candidate), `#!/usr/bin/env bash\nset -euo pipefail\n\n${command}\n`);
});

test('PLAY accepts a controlled response after the former 14 second popup deadline', async () => {
    assert.equal(REQUEST_TIMEOUT_MS, 14_000);
    assert.equal(PLAY_REQUEST_TIMEOUT_MS, 28_000);
    const clock = createFakeClock();
    let sentMessage = null;
    const chromeApi = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                sentMessage = message;
                clock.setTimeout(() => callback({ ok: true, action: 'PLAY' }), 15_000);
            }
        }
    };
    let state = 'pending';
    const request = sendRuntimeRequest(
        chromeApi,
        'PLAY',
        { candidateId: 'media_recipe' },
        undefined,
        clock
    ).then((response) => {
        state = 'resolved';
        return response;
    }, (error) => {
        state = 'rejected';
        throw error;
    });

    clock.advanceTo(14_001);
    await Promise.resolve();
    assert.equal(state, 'pending');

    clock.advanceTo(15_000);
    assert.deepEqual(await request, { ok: true, action: 'PLAY' });
    assert.equal(state, 'resolved');
    assert.deepEqual(sentMessage, {
        type: 'PLAY',
        action: 'PLAY',
        candidateId: 'media_recipe'
    });
    assert.equal(clock.pendingCount(), 0);
});

test('a background candidate update preserves popup scroll, expanded controls, focus and temporary URL reveal', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8?token=stable', 70);
    const harness = createPopupDomHarness(popupState([sourceA, sourceB]));
    await settlePopup();

    const { document } = harness;
    const appShell = document.appShell;
    const candidateContent = document.getElementById('candidate-content');
    const initialCard = candidateCard(document, 'source-b');
    assert.ok(initialCard, `the initial secondary candidate should render; feedback=${document.getElementById('global-feedback').textContent}; content=${candidateContent.textContent}`);

    const otherCandidates = initialCard.closest('.other-candidates');
    const actionsMenu = initialCard.querySelector('.actions-menu');
    const urlToggle = initialCard.querySelector('.candidate-url-toggle');
    const fullUrl = initialCard.querySelector('.candidate-full-url');
    const focusedAction = actionsMenu.querySelectorAll('button')
        .find((button) => button.textContent === 'Kopiuj URL');
    assert.ok(otherCandidates && actionsMenu && urlToggle && fullUrl && focusedAction);

    otherCandidates.open = true;
    actionsMenu.open = true;
    urlToggle.click();
    focusedAction.focus();
    appShell.scrollTop = 318;
    candidateContent.scrollTop = 44;
    assert.equal(fullUrl.hidden, false, 'the per-card URL reveal is active before the update');

    const sourceC = popupCandidate('source-c', 'https://cdn.video.example/movie-720p.mp4', 45);
    harness.emitTabState(popupState([sourceA, sourceB, sourceC]));

    const updatedCard = candidateCard(document, 'source-b');
    const updatedOuterDetails = updatedCard?.closest('.other-candidates');
    const updatedActionsMenu = updatedCard?.querySelector('.actions-menu');
    const updatedFullUrl = updatedCard?.querySelector('.candidate-full-url');
    const updatedUrlToggle = updatedCard?.querySelector('.candidate-url-toggle');
    const actual = {
        newCandidateRendered: Boolean(candidateCard(document, 'source-c')),
        appScrollTop: appShell.scrollTop,
        listScrollTop: candidateContent.scrollTop,
        otherCandidatesOpen: updatedOuterDetails?.open === true,
        actionsMenuOpen: updatedActionsMenu?.open === true,
        focusedCandidateId: candidateIdForNode(document.activeElement),
        focusedAction: document.activeElement === document.body ? '' : document.activeElement?.textContent || '',
        fullUrlVisible: updatedFullUrl?.hidden === false,
        urlToggleExpanded: updatedUrlToggle?.getAttribute('aria-expanded')
    };

    assert.deepEqual(actual, {
        newCandidateRendered: true,
        appScrollTop: 318,
        listScrollTop: 44,
        otherCandidatesOpen: true,
        actionsMenuOpen: true,
        focusedCandidateId: 'source-b',
        focusedAction: 'Kopiuj URL',
        fullUrlVisible: true,
        urlToggleExpanded: 'true'
    });
});

for (const updateCount of [1, 3]) {
    test(`${updateCount} background updates cannot rewind a newer user scroll on the next animation frame`, async () => {
        const candidates = [popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true)];
        const harness = createPopupDomHarness(popupState(candidates), { queueAnimationFrames: true });
        await settlePopup();
        harness.flushAnimationFrames();

        const { appShell } = harness.document;
        const candidateContent = harness.document.getElementById('candidate-content');
        appShell.scrollTop = 300;
        candidateContent.scrollTop = 40;
        for (let index = 0; index < updateCount; index += 1) {
            candidates.push(popupCandidate(`source-new-${index}`, `https://cdn.video.example/${index}.mp4`, 40));
            harness.emitTabState(popupState(candidates));
            appShell.scrollTop = 420 + index * 100;
            candidateContent.scrollTop = 60 + index * 20;
            appShell.dispatchEvent('scroll');
            candidateContent.dispatchEvent('scroll');
        }

        const userScroll = { app: appShell.scrollTop, candidates: candidateContent.scrollTop };
        harness.flushAnimationFrames();
        assert.deepEqual({ app: appShell.scrollTop, candidates: candidateContent.scrollTop }, userScroll);
    });
}

test('a background update cannot steal a newer user focus on the next animation frame', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const harness = createPopupDomHarness(popupState([sourceA]), { queueAnimationFrames: true });
    await settlePopup();
    harness.flushAnimationFrames();

    const { document } = harness;
    candidateCard(document, 'source-a').querySelector('.candidate-url-toggle').focus();
    harness.emitTabState(popupState([sourceA, sourceB]));
    const refreshButton = document.getElementById('refresh-button');
    refreshButton.focus();
    harness.flushAnimationFrames();

    assert.equal(document.activeElement.id, refreshButton.id);
});

test('background quality-control refocus does not scroll back to a control the user scrolled away from', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    let automaticScrolls = 0;
    const harness = createPopupDomHarness(popupState([sourceA]), {
        onFocus(node, options) {
            if (node.classList.contains('quality-order-button') && options?.preventScroll !== true) {
                node.ownerDocument.appShell.scrollTop = 0;
                automaticScrolls += 1;
            }
        }
    });
    await settlePopup();

    const { document } = harness;
    document.querySelector('.quality-order-panel').open = true;
    const qualityButton = document.querySelectorAll('.quality-order-button').find((button) =>
        button.dataset.qualityValue === '1080p' && button.dataset.viewAction === 'quality-up'
    );
    qualityButton.focus();
    document.appShell.scrollTop = 450;
    automaticScrolls = 0;
    harness.emitTabState(popupState([sourceA, sourceB]));

    assert.equal(automaticScrolls, 0, 'passive refocus must suppress the browser default scroll');
    assert.equal(document.appShell.scrollTop, 450);
    assert.equal(document.activeElement.dataset.qualityValue, '1080p');
    assert.equal(document.activeElement.dataset.viewAction, 'quality-up');
});

function popupRect(top, height, width = 380) {
    return { top, bottom: top + height, left: 0, right: width, width, height };
}

test('a hidden secondary card becoming recommended does not anchor the popup to its former zero-size box', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const harness = createPopupDomHarness(popupState([sourceA, sourceB]), {
        getBoundingClientRect(node) {
            if (node.classList.contains('app-shell')) return popupRect(0, 600);
            if (!node.classList.contains('candidate-card')) return null;
            if (node.closest('.other-candidates')?.open === false) return popupRect(0, 0, 0);
            return popupRect(1000 - node.ownerDocument.appShell.scrollTop, 180);
        }
    });
    await settlePopup();
    harness.document.appShell.scrollTop = 300;
    assert.equal(candidateCard(harness.document, 'source-b').getBoundingClientRect().height, 0);

    const nextState = popupState([{ ...sourceA, recommended: false }, { ...sourceB, recommended: true }]);
    nextState.status.recommendedCandidateId = 'source-b';
    harness.emitTabState(nextState);

    assert.equal(candidateCard(harness.document, 'source-b').closest('.other-candidates'), null);
    assert.equal(harness.document.appShell.scrollTop, 300);
});

test('closed secondary cards with positive geometry cannot displace a visible scroll anchor', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const sourceC = popupCandidate('source-c', 'https://cdn.video.example/master-c.m3u8', 80);
    const harness = createPopupDomHarness(popupState([sourceA, sourceB]), {
        getBoundingClientRect(node) {
            if (node.classList.contains('app-shell')) return popupRect(0, 600);
            if (!node.classList.contains('candidate-card')) return null;
            const otherCandidates = node.closest('.other-candidates');
            const documentTop = otherCandidates
                ? 310 + otherCandidates.querySelectorAll('.candidate-card').indexOf(node) * 200
                : 400;
            // Chromium may expose layout boxes even while their details is closed.
            return popupRect(documentTop - node.ownerDocument.appShell.scrollTop, 180);
        }
    });
    await settlePopup();
    const { document } = harness;
    document.appShell.scrollTop = 300;
    const hiddenCard = candidateCard(document, 'source-b');
    assert.equal(hiddenCard.closest('.other-candidates').open, false);
    assert.equal(hiddenCard.getBoundingClientRect().height, 180);
    assert.equal(hiddenCard.getBoundingClientRect().top, 10);
    const visibleTop = candidateCard(document, 'source-a').getBoundingClientRect().top;

    harness.emitTabState(popupState([sourceA, sourceC, sourceB]));

    assert.equal(document.appShell.scrollTop, 300);
    assert.equal(candidateCard(document, 'source-a').getBoundingClientRect().top, visibleTop);
    assert.equal(candidateCard(document, 'source-b').getBoundingClientRect().top, 210);
    assert.equal(candidateCard(document, 'source-b').closest('.other-candidates').open, false);
});

test('a formerly visible anchor moved into closed secondary details cannot restore scroll from its positive geometry', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const harness = createPopupDomHarness(popupState([sourceA, sourceB]), {
        getBoundingClientRect(node) {
            if (node.classList.contains('app-shell')) return popupRect(0, 600);
            if (!node.classList.contains('candidate-card')) return null;
            const documentTop = node.closest('.other-candidates') ? 1100 : 400;
            return popupRect(documentTop - node.ownerDocument.appShell.scrollTop, 180);
        }
    });
    await settlePopup();
    const { document } = harness;
    document.appShell.scrollTop = 300;
    assert.equal(candidateCard(document, 'source-a').closest('.other-candidates'), null);
    assert.equal(candidateCard(document, 'source-a').getBoundingClientRect().top, 100);

    const nextState = popupState([{ ...sourceA, recommended: false }, { ...sourceB, recommended: true }]);
    nextState.status.recommendedCandidateId = 'source-b';
    harness.emitTabState(nextState);

    const formerAnchor = candidateCard(document, 'source-a');
    assert.equal(formerAnchor.closest('.other-candidates').open, false);
    assert.equal(formerAnchor.getBoundingClientRect().height, 180);
    assert.equal(document.appShell.scrollTop, 300);
    assert.equal(candidateCard(document, 'source-b').getBoundingClientRect().top, 100);
});

test('a visible candidate still anchors the viewport when content above it grows', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const harness = createPopupDomHarness(popupState([sourceA]), {
        getBoundingClientRect(node) {
            if (node.classList.contains('app-shell')) return popupRect(0, 600);
            if (!node.classList.contains('candidate-card')) return null;
            if (node.closest('.other-candidates')?.open === false) return popupRect(0, 0, 0);
            const contentGrowth = candidateCard(node.ownerDocument, 'source-b') ? 100 : 0;
            return popupRect(500 + contentGrowth - node.ownerDocument.appShell.scrollTop, 180);
        }
    });
    await settlePopup();
    harness.document.appShell.scrollTop = 420;
    const previousTop = candidateCard(harness.document, 'source-a').getBoundingClientRect().top;
    harness.emitTabState(popupState([sourceA, sourceB]));

    assert.equal(harness.document.appShell.scrollTop, 520);
    assert.equal(candidateCard(harness.document, 'source-a').getBoundingClientRect().top, previousTop);
});

test('document scrolling anchors to the viewport even when the document rectangle has moved above it', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const sourceC = popupCandidate('source-c', 'https://cdn.video.example/master-c.m3u8', 60);
    const sourceInserted = popupCandidate('source-inserted', 'https://cdn.video.example/inserted.m3u8', 65);
    const harness = createPopupDomHarness(popupState([sourceA, sourceB, sourceC]), {
        getBoundingClientRect(node) {
            const scrollTop = node.ownerDocument.scrollingElement.scrollTop;
            if (node === node.ownerDocument.scrollingElement) return popupRect(-scrollTop, 2500);
            if (!node.classList.contains('candidate-card')) return null;
            const index = node.ownerDocument.querySelectorAll('.candidate-card').indexOf(node);
            return popupRect(100 + index * 500 - scrollTop, 300);
        }
    });
    await settlePopup();
    const { document } = harness;
    document.querySelector('.other-candidates').open = true;
    document.scrollingElement.scrollTop = 1000;
    assert.equal(document.scrollingElement.getBoundingClientRect().top, -1000);
    assert.equal(candidateCard(document, 'source-a').getBoundingClientRect().bottom, -600);
    assert.equal(candidateCard(document, 'source-c').getBoundingClientRect().top, 100);

    harness.emitTabState(popupState([sourceA, sourceB, sourceInserted, sourceC]));

    assert.equal(document.scrollingElement.scrollTop, 1500);
    assert.equal(candidateCard(document, 'source-c').getBoundingClientRect().top, 100);
});

for (const change of ['moved earlier in the ranking', 'promoted to recommended']) {
    test(`a visible candidate ${change} does not pull the reader back up the popup`, async () => {
        const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
        const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
        const sourceC = popupCandidate('source-c', 'https://cdn.video.example/master-c.m3u8', 60);
        const harness = createPopupDomHarness(popupState([sourceA, sourceB, sourceC]), {
            getBoundingClientRect(node) {
                if (node.classList.contains('app-shell')) return popupRect(0, 600);
                if (!node.classList.contains('candidate-card')) return null;
                const index = node.ownerDocument.querySelectorAll('.candidate-card').indexOf(node);
                return popupRect(300 + index * 400 - node.ownerDocument.appShell.scrollTop, 300);
            }
        });
        await settlePopup();
        const { document } = harness;
        document.querySelector('.other-candidates').open = true;
        document.appShell.scrollTop = 1000;
        assert.equal(candidateCard(document, 'source-c').getBoundingClientRect().top, 100);

        const promoted = change === 'promoted to recommended';
        const nextState = promoted
            ? popupState([{ ...sourceA, recommended: false }, sourceB, { ...sourceC, recommended: true }])
            : popupState([sourceA, sourceC, sourceB]);
        if (promoted) nextState.status.recommendedCandidateId = 'source-c';
        harness.emitTabState(nextState);

        assert.equal(document.appShell.scrollTop, 1000);
        const nextOrder = document.querySelectorAll('.candidate-card').map((card) => card.dataset.candidateId);
        assert.deepEqual(nextOrder, promoted
            ? ['source-c', 'source-a', 'source-b']
            : ['source-a', 'source-c', 'source-b']);
        assert.equal(document.querySelector('.other-candidates').open, true);
    });
}

test('quality-order controls send the exact domain-scoped order and render the saved ranking', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const harness = createPopupDomHarness(popupState([sourceA]));
    await settlePopup();

    const move1080Up = harness.document.querySelectorAll('.quality-order-button').find((button) =>
        button.dataset.qualityValue === '1080p' && button.dataset.viewAction === 'quality-up'
    );
    assert.ok(move1080Up && move1080Up.disabled === false);
    move1080Up.click();
    await settlePopup();

    const request = harness.runtimeMessages.find((message) => message.type === 'SET_QUALITY_ORDER');
    assert.deepEqual(request, {
        type: 'SET_QUALITY_ORDER',
        action: 'SET_QUALITY_ORDER',
        tabId: 41,
        qualityOrder: ['2160p', '1080p', '1440p', '720p', '480p']
    });
    const renderedOrder = harness.document.querySelectorAll('.quality-order-item')
        .map((item) => item.dataset.qualityValue)
        .filter(Boolean);
    assert.deepEqual(renderedOrder, ['2160p', '1080p', '1440p', '720p', '480p']);
    assert.match(harness.document.querySelector('.quality-order-panel').querySelector('small').textContent, /2160/);
});

test('a late health response does not redraw an already interactive candidate list', async () => {
    const sourceA = popupCandidate('source-a', 'https://cdn.video.example/master-a.m3u8', 90, true);
    const sourceB = popupCandidate('source-b', 'https://cdn.video.example/master-b.m3u8', 70);
    const harness = createPopupDomHarness(popupState([sourceA, sourceB]), { deferHealth: true });
    await settlePopup();

    const { document } = harness;
    const initialCard = candidateCard(document, 'source-b');
    const initialOuterDetails = initialCard?.closest('.other-candidates');
    const initialActionsMenu = initialCard?.querySelector('.actions-menu');
    const initialUrlToggle = initialCard?.querySelector('.candidate-url-toggle');
    assert.ok(initialOuterDetails && initialActionsMenu && initialUrlToggle);

    initialOuterDetails.open = true;
    initialActionsMenu.open = true;
    initialUrlToggle.click();
    initialUrlToggle.focus();
    document.appShell.scrollTop = 275;

    harness.resolveHealth();
    await settlePopup();

    const updatedCard = candidateCard(document, 'source-b');
    const updatedUrlToggle = updatedCard?.querySelector('.candidate-url-toggle');
    assert.deepEqual({
        appScrollTop: document.appShell.scrollTop,
        otherCandidatesOpen: updatedCard?.closest('.other-candidates')?.open === true,
        actionsMenuOpen: updatedCard?.querySelector('.actions-menu')?.open === true,
        focusedCandidateId: candidateIdForNode(document.activeElement),
        focusedControl: document.activeElement?.className || '',
        fullUrlVisible: updatedCard?.querySelector('.candidate-full-url')?.hidden === false,
        urlToggleExpanded: updatedUrlToggle?.getAttribute('aria-expanded')
    }, {
        appScrollTop: 275,
        otherCandidatesOpen: true,
        actionsMenuOpen: true,
        focusedCandidateId: 'source-b',
        focusedControl: 'candidate-url-toggle',
        fullUrlVisible: true,
        urlToggleExpanded: 'true'
    });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reader = require('../content.js');

class FakeElement {
    constructor(tagName, attributes = {}, properties = {}, owner = null) {
        this.tagName = tagName.toUpperCase();
        this.attributesMap = { ...attributes };
        Object.assign(this, properties);
        this.owner = owner;
        this.textContent = properties.textContent || '';
        this.nodeType = 1;
    }

    getAttribute(name) {
        return this.attributesMap[name] || null;
    }

    closest(selector) {
        if (selector !== 'video,audio') return null;
        if (['VIDEO', 'AUDIO'].includes(this.tagName)) return this;
        return this.owner;
    }

    matches(selector) {
        if (selector === 'video,audio,source') return ['VIDEO', 'AUDIO', 'SOURCE'].includes(this.tagName);
        if (selector === 'script[type="application/ld+json"]') {
            return this.tagName === 'SCRIPT' && this.getAttribute('type') === 'application/ld+json';
        }
        if (selector === 'script:not([src]):not([type="application/ld+json"])') {
            return this.tagName === 'SCRIPT' && !this.getAttribute('src') &&
                this.getAttribute('type') !== 'application/ld+json';
        }
        if (selector.includes('meta[content]') || selector.includes('link[href]')) {
            if (this.tagName === 'META' && this.getAttribute('content')) return true;
            if (this.tagName === 'LINK' && this.getAttribute('href')) return true;
            if (this.tagName === 'A' && this.getAttribute('href')) return true;
        }
        const attributeNames = Array.from(selector.matchAll(/\[([a-z0-9-]+)/gi), (match) => match[1]);
        if (attributeNames.some((name) => this.getAttribute(name) !== null)) return true;
        return false;
    }

    querySelectorAll() {
        return [];
    }
}

function fakeDocument(groups, options = {}) {
    const listeners = new Map();
    return {
        baseURI: options.baseURI || 'https://page.test/watch/episode',
        location: { href: options.href || 'https://page.test/watch/episode?session=private#player' },
        title: options.title || 'Testowy materiał',
        readyState: options.readyState || 'loading',
        defaultView: {
            performance: options.performance,
            PerformanceObserver: options.PerformanceObserver,
            addEventListener() {},
            removeEventListener() {}
        },
        querySelectorAll(selector) {
            if (selector === 'video,audio,source') return groups.media || [];
            if (selector === 'script[type="application/ld+json"]') return groups.jsonLd || [];
            if (selector === 'script:not([src]):not([type="application/ld+json"])') return groups.inline || [];
            if (selector.includes('[data-config]')) return groups.config || [];
            if (selector.includes('[data-src]')) return groups.data || [];
            if (selector.includes('meta[content]')) return groups.explicit || [];
            return [];
        },
        addEventListener(name, callback) {
            listeners.set(name, callback);
        },
        removeEventListener(name) {
            listeners.delete(name);
        },
        _listeners: listeners
    };
}

test('normalizes only credential-free HTTP(S) URLs and resolves relative sources', () => {
    assert.equal(
        reader.normalizeHttpUrl('../media/master.m3u8?token=keep', 'https://page.test/watch/episode'),
        'https://page.test/media/master.m3u8?token=keep'
    );
    assert.equal(reader.normalizeHttpUrl('blob:https://page.test/id', 'https://page.test/'), '');
    assert.equal(reader.normalizeHttpUrl('data:video/mp4;base64,AA==', 'https://page.test/'), '');
    assert.equal(reader.normalizeHttpUrl('javascript:alert(1)', 'https://page.test/'), '');
    assert.equal(reader.normalizeHttpUrl('https://user:secret@media.test/master.m3u8'), '');
});

test('TVP adapter reads only same-origin linked video pages from bounded inline data', () => {
    const articleUrl = 'https://sport.tvp.pl/95063559/nie-bylo-powtorki-z-rozrywki';
    const raw = String.raw`{"urls":{"news":"\/95063559\/nie-bylo-powtorki","video":"\/95065681\/fc-thun-lech-poznan-skrot"}}`;

    assert.deepEqual(reader.extractTvpResolverTargets([raw], articleUrl), [
        'https://sport.tvp.pl/95065681/fc-thun-lech-poznan-skrot'
    ]);
    assert.deepEqual(reader.extractTvpResolverTargets([
        '{"video":{"items":[{"_id":95065681,"type":"video","playable":true,"title":"Skrót"}]}}'
    ], articleUrl), [
        'https://sport.tvp.pl/95065681/mpv-redirector'
    ]);
    assert.equal(reader.normalizeTvpResolverTarget('/95065681/fc-thun-lech-poznan-skrot', articleUrl),
        'https://sport.tvp.pl/95065681/fc-thun-lech-poznan-skrot');
    assert.equal(reader.normalizeTvpResolverTarget(articleUrl, articleUrl), '');
    assert.equal(reader.normalizeTvpResolverTarget('https://evil.example/95065681/video', articleUrl), '');
    assert.equal(reader.normalizeTvpResolverTarget('/95065681/video', 'https://example.test/article'), '');
    assert.deepEqual(reader.extractTvpResolverTargets([
        `{"video":"${'x'.repeat(1024 * 1024 + 1)}"}`,
        '{"video":"javascript:alert(1)"}'
    ], articleUrl), []);
});

test('TVP nested video parser keeps linked URLs first and accepts bounded nested metadata', () => {
    const articleUrl = 'https://sport.tvp.pl/95063559/article';
    const nestedVideo = JSON.stringify({
        video: {
            items: [{
                _id: 95065681,
                type: 'video',
                playable: true,
                image: {
                    variants: [{ width: 1920, height: 1080 }]
                },
                metadata: {
                    tournament: { round: { number: 4 } },
                    labels: ['sport', 'skrót']
                }
            }]
        }
    });
    const linkedVideo = String.raw`{"urls":{"video":"\/95065681\/fc-thun-lech-poznan-skrot"}}`;

    assert.deepEqual(reader.extractTvpResolverTargets([nestedVideo, linkedVideo], articleUrl), [
        'https://sport.tvp.pl/95065681/fc-thun-lech-poznan-skrot',
        'https://sport.tvp.pl/95065681/mpv-redirector'
    ]);
});

test('TVP nested video parser ignores braces and escaped quotes inside JSON strings', () => {
    const articleUrl = 'https://sport.tvp.pl/95063559/article';
    const raw = JSON.stringify({
        video: {
            items: [{
                _id: 95065682,
                type: 'video',
                playable: true,
                title: 'Tekst z } ] { oraz "video": { fałszywy } i ukośnikiem \\',
                metadata: {
                    description: 'Escaped quote: " oraz nawiasy {{{ ]]]'
                }
            }]
        }
    });

    assert.deepEqual(reader.extractTvpResolverTargets([raw], articleUrl), [
        'https://sport.tvp.pl/95065682/mpv-redirector'
    ]);
});

test('TVP nested video parser rejects oversized, too-deep, malformed and unplayable values', () => {
    const articleUrl = 'https://sport.tvp.pl/95063559/article';
    const oversized = JSON.stringify({
        video: {
            items: [{
                _id: 95065683,
                type: 'video',
                playable: true,
                title: 'x'.repeat(128 * 1024)
            }]
        }
    });
    let deepMetadata = { value: true };
    for (let index = 0; index < 20; index += 1) deepMetadata = { nested: deepMetadata };
    const tooDeep = JSON.stringify({
        video: {
            items: [{
                _id: 95065684,
                type: 'video',
                playable: true,
                metadata: deepMetadata
            }]
        }
    });
    const malformed = '{"video":{"items":[{"_id":95065685,"type":"video","playable":true}]';
    const invalidItems = JSON.stringify({
        video: {
            items: [
                { _id: 95065686, type: 'video', playable: false },
                { _id: 95065687, type: 'audio', playable: true },
                { _id: '95065688', type: 'video', playable: true },
                { _id: 1234, type: 'video', playable: true },
                { _id: 1_234_567_890_123, type: 'video', playable: true }
            ]
        }
    });

    assert.deepEqual(reader.extractTvpResolverTargets([
        oversized,
        tooDeep,
        malformed,
        invalidItems
    ], articleUrl), []);
});

test('TVP nested video parser never scans beyond its bounded item window', () => {
    const articleUrl = 'https://sport.tvp.pl/95063559/article';
    const items = Array.from({ length: 16 }, (_value, index) => ({
        _id: 95065700 + index,
        type: 'video',
        playable: false
    }));
    items.push({ _id: 95065999, type: 'video', playable: true });

    assert.deepEqual(reader.extractTvpResolverTargets([
        JSON.stringify({ video: { items } })
    ], articleUrl), []);
});

test('infers playlist and direct-media types from MIME, path, or explicit format query', () => {
    assert.equal(reader.inferMediaType('https://media.test/no-extension', 'application/vnd.apple.mpegurl'), 'HLS');
    assert.equal(reader.inferMediaType('https://media.test/manifest.MPD'), 'DASH');
    assert.equal(reader.inferMediaType('https://media.test/play?format=m3u8'), 'HLS');
    assert.equal(reader.inferMediaType('https://media.test/movie.mp4?token=x'), 'MP4');
    assert.equal(reader.inferMediaType('https://media.test/playback/opaque'), 'MEDIA');
    assert.equal(reader.buildMediaRecord({
        url: 'https://media.test/playback/opaque',
        source: 'data-hls'
    }).type, 'HLS');
    assert.equal(reader.buildMediaRecord({
        url: 'https://media.test/playback/opaque',
        source: 'data-stream'
    }).type, 'MEDIA');
});

test('ignores unrelated high-frequency attribute mutations', () => {
    const image = new FakeElement('img', { src: 'https://images.test/poster.jpg' });
    const source = new FakeElement('source', { src: 'https://media.test/master.m3u8' });
    const streamContainer = new FakeElement('div', { 'data-hls': 'https://media.test/play' });
    const playerConfig = new FakeElement('div', { 'data-setup': '{"sources":[]}' });
    const mediaMeta = new FakeElement('meta', { property: 'og:video', content: 'https://media.test/movie.mp4' });

    assert.equal(reader.isRelevantAttributeMutation({ target: image, attributeName: 'src' }), false);
    assert.equal(reader.isRelevantAttributeMutation({ target: image, attributeName: 'title' }), false);
    assert.equal(reader.isRelevantAttributeMutation({ target: source, attributeName: 'src' }), true);
    assert.equal(reader.isRelevantAttributeMutation({ target: streamContainer, attributeName: 'data-hls' }), true);
    assert.equal(reader.isRelevantAttributeMutation({ target: playerConfig, attributeName: 'data-setup' }), true);
    assert.equal(reader.isRelevantAttributeMutation({ target: mediaMeta, attributeName: 'content' }), true);
});

test('rejects bare media IDs from strong data attributes but keeps real URL references', () => {
    assert.equal(reader.looksLikeUrlReference('95065681'), false);
    assert.equal(reader.looksLikeUrlReference('{"videoId":95065681}'), false);
    assert.equal(reader.looksLikeUrlReference('/player/stream?id=95065681'), true);
    assert.equal(reader.looksLikeUrlReference('movie.mp4'), true);

    const bareId = new FakeElement('div', { 'data-video': '95065681' });
    const bareHlsId = new FakeElement('div', { 'data-hls': '95065682' });
    const relativeStream = new FakeElement('div', { 'data-stream': '/player/stream?id=95065681' });
    const documentRef = fakeDocument({ media: [], data: [bareId, bareHlsId, relativeStream], jsonLd: [] });
    const results = reader.scanRoot(documentRef, new Map(), documentRef);
    assert.equal(results.size, 1);
    assert.ok(results.has('https://page.test/player/stream?id=95065681'));
});

test('extracts useful JSON-LD contentUrl metadata without evaluating page code', () => {
    globalThis.__contentReaderMustNotExecute = false;
    const raw = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'VideoObject',
                name: 'Skrót meczu',
                duration: 'PT8M36S',
                videoQuality: 'Full HD',
                width: 1920,
                height: 1080,
                contentUrl: '/video/master.m3u8?token=secret'
            },
            {
                '@type': 'WebSite',
                contentUrl: 'https://page.test/about'
            },
            {
                '@type': 'Thing',
                ignored: 'globalThis.__contentReaderMustNotExecute = true'
            }
        ]
    });

    const media = reader.extractJsonLdMedia(raw, 'https://page.test/watch');
    assert.equal(media.length, 1);
    assert.equal(media[0].url, 'https://page.test/video/master.m3u8?token=secret');
    assert.equal(media[0].type, 'HLS');
    assert.equal(media[0].title, 'Skrót meczu');
    assert.equal(media[0].duration, 516);
    assert.equal(media[0].quality, 'Full HD');
    assert.equal(media[0].playerKeys, undefined);
    assert.equal(media[0].currentPlayerKeys, undefined);
    assert.equal(globalThis.__contentReaderMustNotExecute, false);
    assert.deepEqual(reader.extractJsonLdMedia('{not-json}', 'https://page.test/'), []);
    delete globalThis.__contentReaderMustNotExecute;
});

test('extracts every configured quality from bounded JSON player data and skips ads, DRM and tokens', () => {
    globalThis.__embeddedConfigMustNotExecute = false;
    const raw = JSON.stringify({
        player: {
            sources: [
                {
                    src: 'https://cdn.test/program/master.m3u8?token=main',
                    type: 'application/vnd.apple.mpegurl',
                    label: 'Auto'
                },
                {
                    file: '/program/1080.mp4?token=full-hd',
                    label: '1080p',
                    width: 1920,
                    height: 1080
                },
                {
                    url: '/playback/video?id=720',
                    quality: '720p'
                },
                {
                    src: 'https://cdn.test/commercial.mp4',
                    isAd: true
                }
            ]
        },
        ads: {
            sources: [{ src: 'https://ads.test/preroll.mp4' }]
        },
        drm: {
            licenseUrl: 'https://license.test/widevine'
        },
        poster: 'https://images.test/poster.mp4',
        sessionToken: 'https://api.test/session.mp4?token=not-media',
        navigation: { url: 'https://page.test/account?from=player' },
        ignored: 'globalThis.__embeddedConfigMustNotExecute = true'
    });

    const media = reader.extractEmbeddedMedia(raw, 'https://page.test/watch', 'inline-json');
    assert.deepEqual(media.map((item) => item.url), [
        'https://cdn.test/program/master.m3u8?token=main',
        'https://page.test/program/1080.mp4?token=full-hd',
        'https://page.test/playback/video?id=720'
    ]);
    assert.equal(media[0].type, 'HLS');
    assert.equal(media[1].quality, '1080p');
    assert.equal(media[1].height, 1080);
    assert.equal(media[2].quality, '720p');
    assert.equal(media.some((item) => /account|ads|license|poster|session/.test(item.url)), false);
    assert.equal(globalThis.__embeddedConfigMustNotExecute, false);
    delete globalThis.__embeddedConfigMustNotExecute;
});

test('scans JavaScript-like player literals without evaluating code or collecting comments and ad blocks', () => {
    const raw = String.raw`
        // const stale = "https://cdn.test/comment-only.mp4";
        const unrelated = { url: "https://api.test/session?token=random" };
        const playerConfig = {
            hlsUrl: "https:\/\/cdn.test\/event\/master.m3u8?token=live",
            sources: [
                { src: "/event/1080.mp4", label: "1080p", height: 1080 },
                { src: "/playback/video?id=720", label: "720p" }
            ]
        };
        const hiddenAd = { isAd: true, src: "https://cdn.test/commercial.mp4" };
        const adConfig = { src: "https://ads.test/preroll.mp4" };
        const licenseUrl = "https://license.test/widevine";
        globalThis.__inlineScriptMustNotExecute = true;
    `;
    globalThis.__inlineScriptMustNotExecute = false;

    const media = reader.extractEmbeddedMedia(raw, 'https://page.test/watch', 'inline-script');
    assert.deepEqual(media.map((item) => item.url), [
        'https://cdn.test/event/master.m3u8?token=live',
        'https://page.test/event/1080.mp4',
        'https://page.test/playback/video?id=720'
    ]);
    assert.equal(media[0].quality, undefined);
    assert.equal(media[1].quality, '1080p');
    assert.equal(media[2].quality, '720p');
    assert.equal(globalThis.__inlineScriptMustNotExecute, false);
    delete globalThis.__inlineScriptMustNotExecute;
});

test('embedded scanner enforces source-size and result-count limits', () => {
    assert.deepEqual(reader.extractEmbeddedMedia('x'.repeat(1_100 * 1024), 'https://page.test/'), []);
    const manySources = JSON.stringify({
        sources: Array.from({ length: 100 }, (_value, index) => ({
            src: `https://cdn.test/video/${index}.mp4`
        }))
    });
    assert.equal(reader.extractEmbeddedMedia(manySources, 'https://page.test/').length, 64);
    const lateSources = Object.fromEntries(Array.from({ length: 600 }, (_value, index) => [`copy${index}`, `tekst ${index}`]));
    lateSources.sources = [{ src: '/late/kept-1080.mp4', label: '1080p' }];
    assert.deepEqual(
        reader.extractEmbeddedMedia(JSON.stringify(lateSources), 'https://page.test/').map((item) => item.url),
        ['https://page.test/late/kept-1080.mp4']
    );
    const tooManyLiterals = `${Array.from({ length: 4_100 }, () => '"x"').join(',')};"/late/movie.mp4"`;
    assert.deepEqual(reader.extractEmbeddedMedia(tooManyLiterals, 'https://page.test/'), []);
});

test('bounded media collection evicts an earlier weak hit for a later high-value manifest', () => {
    const media = new Map();
    for (let index = 0; index < 80; index += 1) {
        assert.equal(reader.mergeMediaRecord(media, {
            url: `https://downloads.test/archive/${index}.mp4`,
            source: 'media-link'
        }, 'https://page.test/'), true);
    }
    assert.equal(media.size, 80);
    assert.equal(reader.mergeMediaRecord(media, {
        url: 'https://cdn.test/program/master.m3u8',
        source: 'inline-script'
    }, 'https://page.test/'), true);
    assert.equal(media.size, 80);
    assert.equal(media.has('https://cdn.test/program/master.m3u8'), true);
    assert.equal(media.has('https://downloads.test/archive/0.mp4'), false);
    assert.equal(reader.mergeMediaRecord(media, {
        url: 'https://api.test/weak-playback-endpoint',
        source: 'media-link'
    }, 'https://page.test/'), false);
    assert.equal(media.has('https://api.test/weak-playback-endpoint'), false);
});

test('scans currentSrc, source tags, media data attributes and JSON-LD into one deduplicated list', () => {
    const video = new FakeElement('video', { title: 'Mecz' }, {
        currentSrc: 'https://cdn.test/program/master.m3u8?token=current',
        src: 'https://cdn.test/program/master.m3u8?token=current',
        duration: 516,
        videoWidth: 1920,
        videoHeight: 1080
    });
    const source = new FakeElement('source', {
        src: 'https://cdn.test/program/720p.mp4?token=variant',
        type: 'video/mp4',
        label: '720p'
    }, {
        src: 'https://cdn.test/program/720p.mp4?token=variant'
    }, video);
    const dataStream = new FakeElement('div', {
        'data-hls': 'https://edge.test/opaque-playback?id=123'
    });
    const dataImage = new FakeElement('div', {
        'data-src': 'https://images.test/poster.jpg'
    });
    const jsonLd = new FakeElement('script', {
        type: 'application/ld+json'
    }, {
        textContent: JSON.stringify({
            '@type': 'VideoObject',
            name: 'Alternatywny DASH',
            contentUrl: 'https://cdn.test/program/manifest.mpd'
        })
    });
    const documentRef = fakeDocument({
        media: [video, source],
        data: [dataStream, dataImage],
        jsonLd: [jsonLd]
    });

    const results = reader.scanRoot(documentRef, new Map(), documentRef);
    assert.equal(results.size, 4);
    assert.equal(results.get(video.currentSrc).source, 'dom-current-src');
    assert.equal(results.get(video.currentSrc).duration, 516);
    assert.equal(results.get(video.currentSrc).quality, '1080p');
    assert.equal(results.get(source.src).type, 'MP4');
    assert.equal(results.get(source.src).quality, '720p');
    assert.equal(results.get('https://edge.test/opaque-playback?id=123').source, 'data-hls');
    assert.equal(results.get('https://edge.test/opaque-playback?id=123').type, 'HLS');
    assert.equal(results.get('https://cdn.test/program/manifest.mpd').type, 'DASH');
    assert.equal(results.has('https://images.test/poster.jpg'), false);
});

test('scans config attributes, inline JSON, media metadata and preload/link hints before playback', () => {
    const lazyVideo = new FakeElement('div', {
        'data-video-src': '/library/lazy-720.mp4',
        'data-quality': '720p'
    });
    const playerConfig = new FakeElement('div', {
        'data-setup': JSON.stringify({
            sources: [
                { src: '/library/1080.mp4', label: '1080p' },
                { src: '/playback/video?id=auto', label: 'Auto' }
            ]
        })
    });
    const inlineJson = new FakeElement('script', { type: 'application/json' }, {
        textContent: JSON.stringify({ hlsUrl: 'https://edge.test/library/master.m3u8?token=inline' })
    });
    const meta = new FakeElement('meta', {
        property: 'og:video:secure_url',
        content: 'https://cdn.test/library/social.mp4'
    });
    const preload = new FakeElement('link', {
        rel: 'preload',
        as: 'video',
        href: '/playback/video?id=preloaded'
    });
    const directLink = new FakeElement('a', { href: '/downloads/movie.webm' });
    const documentRef = fakeDocument({
        media: [],
        data: [lazyVideo],
        config: [playerConfig],
        jsonLd: [],
        inline: [inlineJson],
        explicit: [meta, preload, directLink]
    });

    const results = reader.scanRoot(documentRef, new Map(), documentRef);
    assert.deepEqual(Array.from(results.keys()), [
        'https://page.test/library/lazy-720.mp4',
        'https://page.test/library/1080.mp4',
        'https://page.test/playback/video?id=auto',
        'https://cdn.test/library/social.mp4',
        'https://page.test/playback/video?id=preloaded',
        'https://page.test/downloads/movie.webm',
        'https://edge.test/library/master.m3u8?token=inline'
    ]);
    assert.equal(results.get('https://page.test/library/1080.mp4').quality, '1080p');
    assert.equal(results.get('https://page.test/playback/video?id=preloaded').source, 'link-preload');
});

test('resource timing scan keeps manifests and full media but rejects segments, ads, DRM and generic API traffic', () => {
    const entries = [
        { name: 'https://api.test/session?token=random', initiatorType: 'fetch' },
        { name: 'https://cdn.test/event/master.m3u8?token=hls', initiatorType: 'fetch' },
        { name: 'https://cdn.test/playback/video?id=opaque', initiatorType: 'xmlhttprequest' },
        { name: 'https://cdn.test/tokenized/asset?id=video', initiatorType: 'video' },
        { name: 'https://cdn.test/event/segment-0001.m4s', initiatorType: 'fetch', contentType: 'video/mp4' },
        { name: 'https://cdn.test/ads/preroll.mp4', initiatorType: 'video' },
        { name: 'https://cdn.test/license/widevine', initiatorType: 'fetch', contentType: 'video/mp4' }
    ];
    const results = new Map();

    assert.equal(reader.scanPerformanceEntries(entries, results, 'https://page.test/watch'), true);
    assert.deepEqual(Array.from(results.keys()), [
        'https://cdn.test/event/master.m3u8?token=hls',
        'https://cdn.test/playback/video?id=opaque',
        'https://cdn.test/tokenized/asset?id=video'
    ]);
    assert.equal(results.get('https://cdn.test/tokenized/asset?id=video').kind, 'video');
    assert.equal(reader.scanPerformanceEntries(entries, results, 'https://page.test/watch'), false);
});

test('player-key metadata is validated, deduplicated and bounded while merging records', () => {
    const url = 'https://cdn.test/shared/master.m3u8';
    const mediaByUrl = new Map();
    const manyKeys = Array.from({ length: 12 }, (_value, index) => `p${index + 1}`);

    reader.mergeMediaRecord(mediaByUrl, {
        url,
        playerKeys: ['p1', 'p1', ...manyKeys, 'player key with spaces', '<dom-id>'],
        currentPlayerKeys: ['p1', 'p1']
    });
    reader.mergeMediaRecord(mediaByUrl, {
        url,
        playerKeys: ['p9', 'p2'],
        currentPlayerKeys: ['p9']
    });

    const record = mediaByUrl.get(url);
    assert.deepEqual(record.currentPlayerKeys, ['p9', 'p1']);
    assert.equal(record.playerKeys.length, 8);
    assert.equal(new Set(record.playerKeys).size, record.playerKeys.length);
    assert.deepEqual(record.playerKeys.slice(0, 3), ['p9', 'p1', 'p2']);
    assert.equal(record.playerKeys.includes('player key with spaces'), false);
    assert.equal(record.playerKeys.includes('<dom-id>'), false);
});

test('reader sends a bounded page-media payload and removes query secrets from page metadata', () => {
    const video = new FakeElement('video', {}, {
        currentSrc: 'https://cdn.test/master.m3u8?token=required-for-playback',
        duration: 900
    });
    const documentRef = fakeDocument({ media: [video] });
    const messages = [];
    const chromeRef = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback({ ok: true });
            }
        }
    };
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        MutationObserver: FakeMutationObserver,
        setTimeout(callback) {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout() {}
    });

    instance.flush();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'PAGE_MEDIA_DISCOVERED');
    assert.equal(messages[0].page.url, 'https://page.test/watch/episode');
    assert.doesNotMatch(messages[0].page.url, /private/);
    assert.equal(messages[0].media.length, 1);
    assert.match(messages[0].media[0].url, /required-for-playback/);

    instance.flush();
    assert.equal(messages.length, 1, 'unchanged snapshots are not sent repeatedly');
    instance.disconnect();
});

test('reader consumes resource timing updates and arms only three bounded page-ready rescans', () => {
    const initialUrl = 'https://cdn.test/live/master.m3u8?token=initial';
    const laterUrl = 'https://cdn.test/live/manifest.mpd?token=later';
    const nextPageUrl = 'https://cdn.test/next/movie.mp4?token=next';
    const resourceEntries = [{ name: initialUrl, initiatorType: 'fetch' }];
    const performanceRef = {
        getEntriesByType(type) {
            return type === 'resource' ? resourceEntries : [];
        }
    };
    let performanceCallback = null;
    let performanceDisconnected = false;
    const observedOptions = [];
    class FakePerformanceObserver {
        constructor(callback) {
            performanceCallback = callback;
        }

        observe(options) {
            observedOptions.push(options);
        }

        disconnect() {
            performanceDisconnected = true;
        }
    }
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const clearedTimers = new Set();
    const documentRef = fakeDocument({ media: [] }, { performance: performanceRef });
    const messages = [];
    const chromeRef = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback({ ok: true });
            }
        }
    };
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        MutationObserver: FakeMutationObserver,
        PerformanceObserver: FakePerformanceObserver,
        performance: performanceRef,
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimeout(handle) {
            clearedTimers.add(handle);
        }
    });

    instance.flush();
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].media.map((item) => item.url), [initialUrl]);
    assert.deepEqual(observedOptions, [{ type: 'resource', buffered: true }]);

    performanceCallback({
        getEntries() {
            return [{ name: laterUrl, initiatorType: 'fetch' }];
        }
    });
    timers.at(-1).callback();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1].media.map((item) => item.url), [initialUrl, laterUrl]);

    documentRef.location.href = 'https://page.test/watch/next?private=1';
    instance.schedule(documentRef, true);
    timers.at(-1).callback();
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[2].media, [], 'old resource timings do not leak into a new page identity');

    resourceEntries.push({ name: nextPageUrl, initiatorType: 'video' });
    instance.schedule(documentRef, true);
    timers.at(-1).callback();
    assert.equal(messages.length, 4);
    assert.deepEqual(messages[3].media.map((item) => item.url), [nextPageUrl]);

    documentRef._listeners.get('DOMContentLoaded')();
    documentRef._listeners.get('DOMContentLoaded')();
    assert.deepEqual(
        timers.filter((timer) => [750, 2_500, 6_000].includes(timer.delay)).map((timer) => timer.delay),
        [750, 2_500, 6_000]
    );

    instance.disconnect();
    assert.equal(performanceDisconnected, true);
    assert.ok(clearedTimers.size >= 3);
});

test('subframe reader scans live media but skips embedded-script sweeps and page-ready rescans', () => {
    const videoUrl = 'https://cdn.test/embed/current.m3u8';
    const hiddenUrl = 'https://cdn.test/embed/hidden-master.m3u8';
    const video = new FakeElement('video', {}, { currentSrc: videoUrl, duration: 600 });
    const inline = new FakeElement('script', { type: 'application/json' }, {
        textContent: JSON.stringify({ hlsUrl: hiddenUrl })
    });
    const documentRef = fakeDocument({ media: [video], inline: [inline] });
    const queriedSelectors = [];
    const originalQuerySelectorAll = documentRef.querySelectorAll;
    documentRef.querySelectorAll = (selector) => {
        queriedSelectors.push(selector);
        return originalQuerySelectorAll.call(documentRef, selector);
    };
    const messages = [];
    const chromeRef = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback({ ok: true });
            }
        }
    };
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        aggressiveScan: false,
        MutationObserver: FakeMutationObserver,
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimeout() {}
    });

    instance.flush();
    assert.deepEqual(messages[0].media.map((item) => item.url), [videoUrl]);
    assert.equal(messages[0].media.some((item) => item.url === hiddenUrl), false);
    assert.deepEqual([...new Set(queriedSelectors)], ['video,audio,source']);
    documentRef._listeners.get('DOMContentLoaded')();
    assert.equal(timers.some((timer) => [750, 2_500, 6_000].includes(timer.delay)), false);
    assert.equal(instance.state.aggressiveScan, false);
    instance.disconnect();
});

test('reader keeps one opaque player key when currentSrc changes on the same media element', () => {
    const advertisementUrl = 'https://cdn.test/opaque/first/master.m3u8';
    const contentUrl = 'https://cdn.test/program/movie.mp4';
    const variantUrl = 'https://cdn.test/program/720p.mp4';
    const video = new FakeElement('video', { id: 'private-player-dom-id' }, {
        currentSrc: advertisementUrl,
        duration: 15
    });
    const source = new FakeElement('source', {
        src: variantUrl,
        type: 'video/mp4'
    }, {
        src: variantUrl
    }, video);
    const documentRef = fakeDocument({ media: [video, source] });
    const messages = [];
    const chromeRef = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback({ ok: true });
            }
        }
    };
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        MutationObserver: FakeMutationObserver,
        setTimeout(callback) {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout() {}
    });

    instance.flush();
    const firstCurrent = messages[0].media.find((item) => item.url === advertisementUrl);
    const configuredVariant = messages[0].media.find((item) => item.url === variantUrl);
    assert.equal(firstCurrent.playerKeys.length, 1);
    assert.deepEqual(firstCurrent.currentPlayerKeys, firstCurrent.playerKeys);
    assert.deepEqual(configuredVariant.playerKeys, firstCurrent.playerKeys);
    assert.equal(configuredVariant.currentPlayerKeys, undefined);
    assert.notEqual(firstCurrent.playerKeys[0], video.getAttribute('id'));
    assert.match(firstCurrent.playerKeys[0], /^p[0-9a-z]+$/);

    video.currentSrc = contentUrl;
    video.duration = 516;
    documentRef._listeners.get('loadstart')({ target: video });
    timers.at(-1)();

    assert.equal(messages.length, 2);
    assert.equal(messages[1].media.some((item) => item.url === advertisementUrl), false);
    const secondCurrent = messages[1].media.find((item) => item.url === contentUrl);
    assert.deepEqual(secondCurrent.playerKeys, firstCurrent.playerKeys);
    assert.deepEqual(secondCurrent.currentPlayerKeys, firstCurrent.currentPlayerKeys);
    instance.disconnect();
});

test('durationchange sends a fresh snapshot for the same currentSrc and player key', () => {
    const streamUrl = 'https://cdn.test/program/master.m3u8';
    const video = new FakeElement('video', {}, {
        currentSrc: streamUrl,
        duration: 15
    });
    const documentRef = fakeDocument({ media: [video] });
    const messages = [];
    const chromeRef = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback({ ok: true });
            }
        }
    };
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        MutationObserver: FakeMutationObserver,
        setTimeout(callback) {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout() {}
    });

    instance.flush();
    const first = messages[0].media.find((item) => item.url === streamUrl);
    assert.equal(first.duration, 15);

    video.duration = 516;
    documentRef._listeners.get('durationchange')({ target: video });
    timers.at(-1)();

    assert.equal(messages.length, 2);
    const second = messages[1].media.find((item) => item.url === streamUrl);
    assert.equal(second.duration, 516);
    assert.deepEqual(second.playerKeys, first.playerKeys);
    assert.deepEqual(second.currentPlayerKeys, first.currentPlayerKeys);
    instance.disconnect();
});

test('reader retries an unchanged snapshot when the worker reload drops the first message', () => {
    const video = new FakeElement('video', {}, {
        currentSrc: 'https://cdn.test/retry/master.m3u8?token=fresh'
    });
    const documentRef = fakeDocument({ media: [video] });
    const messages = [];
    const chromeRef = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback(messages.length === 1 ? { ok: true, stale: true } : { ok: true });
            }
        }
    };
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        MutationObserver: FakeMutationObserver,
        setTimeout(callback) {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout() {}
    });

    instance.flush();
    assert.equal(messages.length, 1);
    assert.equal(instance.state.lastFingerprint, '');
    const retryTimer = timers.at(-1);
    retryTimer();
    assert.equal(messages.length, 2);
    assert.notEqual(instance.state.lastFingerprint, '');
    instance.flush();
    assert.equal(messages.length, 2);
    instance.disconnect();
});

test('trusted RESCAN_PAGE_MEDIA forgets snapshot deduplication and schedules a full scan', () => {
    const streamUrl = 'https://cdn.test/refresh/master.m3u8?token=current';
    const video = new FakeElement('video', {}, { currentSrc: streamUrl, duration: 516 });
    const performanceRef = {
        getEntriesByType(type) {
            return type === 'resource' ? [] : [];
        }
    };
    const documentRef = fakeDocument({ media: [video] }, { performance: performanceRef });
    let mediaQueryCount = 0;
    const originalQuerySelectorAll = documentRef.querySelectorAll;
    documentRef.querySelectorAll = (selector) => {
        if (selector === 'video,audio,source') mediaQueryCount += 1;
        return originalQuerySelectorAll.call(documentRef, selector);
    };
    const messages = [];
    const runtimeListeners = [];
    const removedRuntimeListeners = [];
    const chromeRef = {
        runtime: {
            id: 'extension-test-id',
            lastError: null,
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                callback({ ok: true });
            },
            onMessage: {
                addListener(listener) {
                    runtimeListeners.push(listener);
                },
                removeListener(listener) {
                    removedRuntimeListeners.push(listener);
                }
            }
        }
    };
    class FakeMutationObserver {
        observe() {}
        disconnect() {}
    }
    const timers = [];
    const instance = reader.createPageMediaReader(documentRef, chromeRef, {
        MutationObserver: FakeMutationObserver,
        performance: performanceRef,
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimeout() {}
    });

    instance.flush();
    assert.equal(messages.length, 1);
    assert.equal(mediaQueryCount, 1);
    assert.notEqual(instance.state.lastFingerprint, '');
    assert.equal(instance.state.performanceBufferInitialized, true);
    assert.equal(runtimeListeners.length, 1);

    let foreignResponse = null;
    runtimeListeners[0](
        { type: reader.RESCAN_PAGE_MEDIA_MESSAGE_TYPE },
        { id: 'foreign-extension-id' },
        (response) => { foreignResponse = response; }
    );
    assert.deepEqual(foreignResponse, { ok: false, code: 'INVALID_SENDER' });
    assert.notEqual(instance.state.lastFingerprint, '');
    assert.equal(timers.filter((timer) => timer.delay === 300).length, 1,
        'the rejected sender does not schedule another scan');

    let trustedResponse = null;
    const trustedResult = runtimeListeners[0](
        { type: reader.RESCAN_PAGE_MEDIA_MESSAGE_TYPE },
        { id: 'extension-test-id' },
        (response) => { trustedResponse = response; }
    );
    assert.equal(trustedResult, true);
    assert.deepEqual(trustedResponse, { ok: true, scanned: true });
    assert.notEqual(instance.state.lastFingerprint, '');
    assert.equal(instance.state.pendingFingerprint, '');
    assert.equal(instance.state.needsFullScan, false);
    assert.equal(instance.state.performanceBufferInitialized, true);
    assert.equal(mediaQueryCount, 2, 'the trusted message runs a complete DOM scan');
    assert.equal(messages.length, 2, 'the unchanged snapshot is sent again after dedup reset');
    assert.equal(messages[1].type, reader.MESSAGE_TYPE);
    assert.deepEqual(messages[1].media.map((item) => item.url), [streamUrl]);

    instance.disconnect();
    assert.deepEqual(removedRuntimeListeners, runtimeListeners);
});

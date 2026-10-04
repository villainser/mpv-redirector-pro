'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../background.js');

test('worker PLAY timeout leaves transport margin above the 20 second host deadline', () => {
    assert.equal(worker.PLAY_TIMEOUT_MS, 24_000);
});

test('schema 4 recovery discards stale 3.4.3 candidates instead of reusing a multilingual master', () => {
    const staleState = worker.createTabState(430, 'www.youtube.com');
    staleState.schemaVersion = 3;
    staleState.candidates.push({
        id: 'stale-master',
        url: 'https://manifest.example.test/multilingual-master.m3u8',
        type: 'HLS',
        role: 'master',
        recommended: true
    });

    const recovered = worker.normalizeTabState(staleState, 430, 'www.youtube.com');

    assert.equal(worker.STATE_SCHEMA_VERSION, 4);
    assert.equal(recovered.schemaVersion, 4);
    assert.deepEqual(recovered.candidates, []);
    assert.equal(recovered.status.code, 'SCANNING');
});

test('canonical identity drops query tokens but preserves path case', () => {
    const first = worker.canonicalizeMediaUrl(
        'https://MEDIA.example.test/Live/Master.M3U8?token=first-secret#part'
    );
    const refreshed = worker.canonicalizeMediaUrl(
        'https://media.example.test/Live/Master.M3U8?token=second-secret'
    );
    const differentCase = worker.canonicalizeMediaUrl(
        'https://media.example.test/live/Master.M3U8?token=second-secret'
    );

    assert.equal(first, 'https://media.example.test/Live/Master.M3U8');
    assert.equal(first, refreshed);
    assert.notEqual(first, differentCase);
});

test('canonical identity preserves stable asset parameters while sorting them', () => {
    const firstAsset = worker.canonicalizeMediaUrl(
        'https://media.example.test/play.mp4?token=secret&format=mp4&id=content'
    );
    const sameAsset = worker.canonicalizeMediaUrl(
        'https://media.example.test/play.mp4?id=content&format=mp4&token=refreshed'
    );
    const advertisement = worker.canonicalizeMediaUrl(
        'https://media.example.test/play.mp4?format=mp4&id=advertisement&token=secret'
    );

    assert.equal(firstAsset, sameAsset);
    assert.match(firstAsset, /format=mp4&id=content/);
    assert.notEqual(firstAsset, advertisement);
});

test('signed media expiry accepts only plausible unambiguous Unix seconds or milliseconds', () => {
    const secondsExpiry = 1_787_991_369_000;
    const millisecondsExpiry = 2_000_000_000_123;

    assert.equal(
        worker.parseMediaUrlExpiry('https://cdn.test/video.m3u8?validto=1787991369'),
        secondsExpiry
    );
    assert.equal(
        worker.parseMediaUrlExpiry('https://cdn.test/video.m3u8?EXP=2000000000123'),
        millisecondsExpiry
    );
    assert.equal(
        worker.parseMediaUrlExpiry('https://cdn.test/video.m3u8?expires=2000000000&expiry=1787991369'),
        secondsExpiry,
        'the earliest valid deadline is authoritative'
    );
    assert.equal(
        worker.parseMediaUrlExpiry('https://cdn.test/video.m3u8?validto=1787991369&VALIDTO=1787991369000'),
        secondsExpiry,
        'equivalent duplicate values are unambiguous'
    );
    assert.equal(
        worker.parseMediaUrlExpiry('https://cdn.test/video.m3u8?validto=1787991369&validto=2000000000'),
        null,
        'conflicting duplicate fields are ignored rather than guessed'
    );

    for (const url of [
        'https://cdn.test/video.m3u8?validto=2',
        'https://cdn.test/video.m3u8?validto=1787991369.0',
        'https://cdn.test/video.m3u8?validto=9999999999',
        'https://cdn.test/video.m3u8?expires=3600',
        'https://cdn.test/video.m3u8?exp=not-a-timestamp',
        'https://cdn.test/video.m3u8?hdnea=exp%3D1787991369',
        'https://cdn.test/video.m3u8?token=1787991369'
    ]) assert.equal(worker.parseMediaUrlExpiry(url), null, url);
});

test('expired and previously failed playback URLs are explicit failures', () => {
    const now = 1_787_995_347_894;
    const expired = { url: 'https://cdn.test/video.m3u8?validto=1787991369' };
    const future = { url: 'https://cdn.test/video.m3u8?validto=2000000000' };

    assert.equal(worker.isCandidateExpired(expired, now), true);
    assert.equal(worker.isCandidateExpired(future, now), false);
    assert.equal(worker.isExplicitlyFailedCandidate(expired, now), true);
    assert.equal(worker.isExplicitlyFailedCandidate(future, now), false);
    assert.equal(worker.isExplicitlyFailedCandidate({ ...future, playState: 'error' }, now), true);
    assert.equal(worker.isExplicitlyFailedCandidate({ ...future, statusCode: 403 }, now), true);
    assert.equal(worker.isExplicitlyFailedCandidate({ ...future, networkError: 'net::ERR_FAILED' }, now), true);
});

test('play failures hide only the exact content URL and infrastructure errors keep media selectable', () => {
    const firstUrl = 'https://cdn.test/video.m3u8?validto=2000000000&hash=first';
    const refreshedUrl = 'https://cdn.test/video.m3u8?validto=2000000000&hash=second';
    const failed = {
        url: firstUrl,
        playState: 'error',
        lastPlayErrorCode: 'MPV_LOAD_FAILED',
        lastPlayErrorUrlHash: worker.stableHash(firstUrl)
    };

    assert.equal(worker.isExplicitlyFailedCandidate(failed), true);
    assert.equal(worker.isExplicitlyFailedCandidate({ ...failed, url: refreshedUrl }), false);
    assert.equal(worker.isExplicitlyFailedCandidate({
        ...failed,
        lastPlayErrorCode: 'QUEUE_BUSY'
    }), false);
});

test('expiry refresh advances across more than sixteen deadlines without retrying an attempted group', () => {
    const now = 1_900_000_000_000;
    const rawState = worker.createTabState(7, 'page.test');
    rawState.candidates = Array.from({ length: 20 }, (_unused, index) => ({
            id: `deadline-${index}`,
            url: `https://cdn.test/item-${index}/1080/index.m3u8?validto=${1900000020 + index * 100}`,
            type: 'HLS',
            role: 'variant',
            purpose: 'content'
        }));
    const state = worker.normalizeTabState(rawState, 7, 'page.test');

    const fingerprints = [];
    for (let index = 0; index < state.candidates.length; index += 1) {
        state.expiryRefresh.attemptedFingerprints = [...fingerprints];
        const plan = worker.expiryRefreshPlan(state, now);
        assert.deepEqual(plan.candidateIds, [`deadline-${index}`]);
        fingerprints.push(plan.fingerprint);
    }
    state.expiryRefresh.attemptedFingerprints = fingerprints;
    const normalized = worker.normalizeTabState(state, 7, 'page.test');
    assert.equal(normalized.expiryRefresh.attemptedFingerprints.length, 20);
    assert.equal(worker.expiryRefreshPlan(normalized, now), null);
});

test('a refreshed signature with unchanged validto does not schedule a tight second refresh', () => {
    const now = 1_900_000_000_000;
    const state = worker.createTabState(8, 'page.test');
    state.candidates = [{
        id: 'same-deadline',
        url: 'https://cdn.test/item/1080/index.m3u8?validto=1900000020&hash=old',
        type: 'HLS',
        role: 'variant',
        purpose: 'content'
    }];
    let normalized = worker.normalizeTabState(state, 8, 'page.test');
    const plan = worker.expiryRefreshPlan(normalized, now);
    normalized.expiryRefresh.attemptedFingerprints = [plan.fingerprint];
    normalized.candidates[0].url = 'https://cdn.test/item/1080/index.m3u8?validto=1900000020&hash=fresh';
    normalized = worker.normalizeTabState(normalized, 8, 'page.test');

    assert.equal(worker.expiryRefreshPlan(normalized, now), null);
});

test('an interrupted refresh lease becomes retryable after its bounded deadline', () => {
    const now = 1_900_000_000_000;
    const state = worker.createTabState(9, 'page.test');
    state.candidates = [{
        id: 'leased-deadline',
        url: 'https://cdn.test/item/1080/index.m3u8?validto=1900000020',
        type: 'HLS',
        role: 'variant',
        purpose: 'content'
    }];
    const normalized = worker.normalizeTabState(state, 9, 'page.test');
    const initial = worker.expiryRefreshPlan(normalized, now);
    normalized.expiryRefresh.inFlightFingerprint = initial.fingerprint;
    normalized.expiryRefresh.inFlightUntil = now + 10_000;

    const leased = worker.expiryRefreshPlan(normalized, now + 1_000);
    assert.equal(leased.inFlight, true);
    assert.ok(leased.dueAt > normalized.expiryRefresh.inFlightUntil);
    const retry = worker.expiryRefreshPlan(normalized, now + 10_001);
    assert.equal(retry.inFlight, false);
    assert.equal(retry.fingerprint, initial.fingerprint);
});

test('source preference fingerprint survives volatile token refresh without collapsing different assets', () => {
    const first = worker.sourcePreferenceFingerprint(
        'https://cdn.test/catalog/movie.mp4?id=episode-7&token=first-secret'
    );
    const refreshed = worker.sourcePreferenceFingerprint(
        'https://cdn.test/catalog/movie.mp4?token=second-secret&id=episode-7'
    );
    const otherAsset = worker.sourcePreferenceFingerprint(
        'https://cdn.test/catalog/movie.mp4?id=episode-8&token=second-secret'
    );

    assert.equal(first, refreshed);
    assert.notEqual(first, otherAsset);
    assert.match(first, /^(?:[a-z0-9]+_){3}[a-z0-9]+$/);
    assert.doesNotMatch(first, /episode|secret|cdn/);
});

test('source family pattern keeps rendition traits while replacing asset ids, dates and signatures', () => {
    const first = 'https://cdn.test/hls/c6251/videos/202608/20/59633985/720P_4000K_59633985.mp4/index-v1-a1.m3u8?validfrom=1787984169&validto=1787991369&hash=first';
    const nextMovie = 'https://cdn.test/hls/c9912/videos/202609/21/88776655/720P_4000K_88776655.mp4/index-v1-a1.m3u8?validfrom=1788990000&validto=1788997200&hash=second';
    const fullHd = nextMovie.replace('720P_4000K', '1080P_8000K');
    const otherHost = nextMovie.replace('cdn.test', 'other-cdn.test');

    assert.equal(worker.sourceFamilyFingerprint(first), worker.sourceFamilyFingerprint(nextMovie));
    assert.notEqual(worker.sourceFamilyFingerprint(first), worker.sourceFamilyFingerprint(fullHd));
    assert.notEqual(worker.sourceFamilyFingerprint(first), worker.sourceFamilyFingerprint(otherHost));
    assert.match(worker.sourceFamilySignature(first), /720\|4000/);
    assert.doesNotMatch(worker.sourceFamilySignature(first), /59633985|178798|first/);
    assert.equal(worker.inferCandidateBitrateKbps({ url: first }), 4000);
});

test('source family pattern and visible label keep language variants separate', () => {
    const base = {
        url: 'https://cdn.test/video/quality/1080/index.m3u8?token=secret',
        type: 'HLS',
        role: 'variant',
        height: 1080,
        bitrateKbps: 8000
    };
    const polish = { ...base, language: 'pl-PL' };
    const english = { ...base, language: 'en-US' };

    assert.notEqual(worker.sourceFamilyFingerprint(polish), worker.sourceFamilyFingerprint(english));
    assert.match(worker.sourceFamilyLabel(polish), /pl-PL/);
    assert.match(worker.sourceFamilyLabel(english), /en-US/);
});

test('HLS master scan expands bounded quality variants and rejects ad renditions', () => {
    const manifest = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"
2160P_12000K_59633985.mp4/index.m3u8?validto=2&hash=secret
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720P_4000K_59633985.mp4/index.m3u8?validto=2&hash=secret
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
ads/preroll-360p.m3u8`;
    const variants = worker.parseHlsMasterPlaylist(
        manifest,
        'https://cdn.example.com/hls/videos/59633985/master.m3u8?token=secret'
    );

    assert.deepEqual(variants.map((item) => item.quality), ['2160p', '720p']);
    assert.deepEqual(variants.map((item) => item.bitrateKbps), [12000, 4000]);
    assert.equal(variants.every((item) => item.autoEligible === false), true);
    assert.equal(variants.every((item) => item.hasAudio === true && item.hasVideo === true), true);
});

test('HLS master marks external audio variants incomplete and keeps token-only quality variants separate', () => {
    const variants = worker.parseHlsMasterPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main",NAME="Polski",URI="audio-pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="main"
same/index.m3u8?token=full-hd
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="main"
same/index.m3u8?token=hd`, 'https://cdn.example.com/master.m3u8');

    assert.equal(variants.length, 2);
    assert.deepEqual(variants.map((item) => item.quality), ['1080p', '720p']);
    assert.equal(variants.every((item) => item.mediaKind === 'video-only'), true);
    assert.equal(variants.every((item) => item.hasAudio === false && item.hasVideo === true), true);
});

test('HLS audio-only and in-band audio groups preserve honest completeness metadata', () => {
    const variants = worker.parseHlsMasterPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="embedded",NAME="Main",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="embedded"
muxed.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2",AUDIO="aac"
audio-only.m3u8`, 'https://cdn.example.com/master.m3u8');

    assert.equal(variants[0].mediaKind, 'muxed');
    assert.equal(variants[0].hasAudio, true);
    assert.equal(variants[0].hasVideo, true);
    assert.equal(variants[1].role, 'audio');
    assert.equal(variants[1].mediaKind, 'audio-only');
    assert.equal(variants[1].hasAudio, true);
    assert.equal(variants[1].hasVideo, false);
});

test('HLS treats a mixed audio group with an in-band rendition as playable with audio', () => {
    const variants = worker.parseHlsMasterPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="mixed",NAME="Wbudowany",DEFAULT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="mixed",NAME="Alternatywny",URI="audio-alt.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028, mp4a.40.2",AUDIO="mixed"
video.m3u8`, 'https://cdn.example.com/master.m3u8');

    assert.equal(variants.length, 1);
    assert.equal(variants[0].mediaKind, 'muxed');
    assert.equal(variants[0].hasAudio, true);
    assert.equal(variants[0].hasVideo, true);
});

test('HLS keeps same-resolution SDR and HDR frame-rate variants distinct', () => {
    const variants = worker.parseHlsMasterPlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=30,VIDEO-RANGE=SDR
same/index.m3u8?token=sdr
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=60,VIDEO-RANGE=PQ
same/index.m3u8?token=hdr`, 'https://cdn.example.com/master.m3u8');

    assert.equal(variants.length, 2);
    assert.match(variants[0].title, /30 fps/);
    assert.match(variants[1].title, /60 fps.*HDR PQ/);
});

test('manifest variants accept only public HTTPS children and do not leak request context cross-origin', () => {
    const hls = worker.parseHlsMasterPlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://127.0.0.1/private.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
http://media.example.com/insecure.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"
safe.m3u8`, 'https://cdn.example.com/master.m3u8');
    assert.deepEqual(hls.map((item) => item.url), ['https://cdn.example.com/safe.m3u8']);

    const dash = worker.parseDashManifestRepresentations(`<MPD><Period><AdaptationSet mimeType="video/mp4">
<Representation height="1080"><BaseURL>https://192.168.1.20/private.mp4</BaseURL></Representation>
<Representation height="720"><BaseURL>https://media.example.com/public.mp4</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://cdn.example.com/manifest.mpd');
    assert.deepEqual(dash.map((item) => item.url), ['https://media.example.com/public.mp4']);

    const parent = {
        url: 'https://cdn.example.com/master.m3u8',
        referer: 'https://video.example.com/watch?private=1',
        origin: 'https://video.example.com',
        userAgent: 'Browser/Test'
    };
    assert.deepEqual(worker.manifestChildRequestContext(parent, 'https://cdn.example.com/720.m3u8'), {
        referer: parent.referer,
        origin: parent.origin,
        userAgent: parent.userAgent
    });
    assert.deepEqual(worker.manifestChildRequestContext(parent, 'https://other.example.com/720.m3u8'), {
        userAgent: parent.userAgent
    });
    assert.equal(worker.isSafeManifestDerivedUrl('https://127.0.0.1/private.m3u8'), false);
    assert.equal(worker.isSafeManifestDerivedUrl('http://media.example.com/plain.m3u8'), false);
    assert.equal(worker.isSafeManifestDerivedUrl('https://media.example.com/public.m3u8'), true);
});

test('HLS scans past early audio entries, understands spaced modern codecs and keeps unknown completeness honest', () => {
    const earlyAudio = Array.from({ length: 24 }, (_value, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${128000 + index},CODECS="mp4a.40.2"\naudio-${index}.m3u8`).join('\n');
    const variants = worker.parseHlsMasterPlaylist(`#EXTM3U
${earlyAudio}
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,CODECS="avc1.640028, ac-4.02.01"
video-1080.m3u8`, 'https://cdn.example.com/master.m3u8');
    assert.equal(variants.length, 24);
    assert.equal(variants[0].quality, '1080p');
    assert.equal(variants[0].mediaKind, 'muxed');
    assert.equal(variants[0].hasAudio, true);

    const unknown = worker.parseHlsMasterPlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f, mystery-audio"
unknown.m3u8`, 'https://cdn.example.com/master.m3u8')[0];
    assert.equal(unknown.hasVideo, true);
    assert.equal(unknown.hasAudio, undefined);
    assert.equal(unknown.mediaKind, undefined);
});

test('DASH direct representations inherit adaptation media type and do not call audio video-only', () => {
    const variants = worker.parseDashManifestRepresentations(`<?xml version="1.0"?>
<MPD><Period>
  <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
    <Representation bandwidth="5000000" width="1920" height="1080"><BaseURL>video.mp4</BaseURL></Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2">
    <Representation bandwidth="192000"><BaseURL>audio.mp4</BaseURL></Representation>
  </AdaptationSet>
</Period></MPD>`, 'https://cdn.example.com/movie/manifest.mpd');

    assert.equal(variants.length, 2);
    assert.equal(variants[0].mediaKind, 'video-only');
    assert.equal(variants[0].hasAudio, false);
    assert.equal(variants[1].role, 'audio');
    assert.equal(variants[1].mediaKind, 'audio-only');
    assert.equal(variants[1].hasAudio, true);
    assert.equal(variants[1].hasVideo, false);
});

test('DASH composes inherited BaseURL scopes and blocks unsafe or protected ancestry', () => {
    const inherited = worker.parseDashManifestRepresentations(`<MPD><BaseURL>https://media.example.com/movie/</BaseURL><Period>
<BaseURL>period/</BaseURL><AdaptationSet mimeType="video/mp4"><BaseURL>video/</BaseURL>
<Representation height="1080"><BaseURL>file.mp4</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://origin.example.com/path/manifest.mpd');
    assert.equal(inherited.length, 1);
    assert.equal(inherited[0].url, 'https://media.example.com/movie/period/video/file.mp4');

    const privateAncestor = worker.parseDashManifestRepresentations(`<MPD><BaseURL>https://127.0.0.1/private/</BaseURL><Period><AdaptationSet mimeType="video/mp4">
<Representation height="1080"><BaseURL>file.mp4</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://origin.example.com/path/manifest.mpd');
    assert.deepEqual(privateAncestor, []);

    const insecureAncestor = worker.parseDashManifestRepresentations(`<MPD><Period><BaseURL>http://media.example.com/plain/</BaseURL><AdaptationSet mimeType="video/mp4">
<Representation height="1080"><BaseURL>file.mp4</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://origin.example.com/path/manifest.mpd');
    assert.deepEqual(insecureAncestor, []);

    const protectedPeriod = worker.parseDashManifestRepresentations(`<MPD><Period><ContentProtection schemeIdUri="urn:uuid:test"/>
<AdaptationSet mimeType="video/mp4"><Representation height="720"><BaseURL>clear-looking.mp4</BaseURL></Representation></AdaptationSet>
</Period></MPD>`, 'https://origin.example.com/path/manifest.mpd');
    assert.deepEqual(protectedPeriod, []);
});

test('DASH accepts an extensionless direct representation only with a trusted container MIME', () => {
    const extensionless = worker.parseDashManifestRepresentations(`<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
<Representation bandwidth="5000000" width="1920" height="1080"><BaseURL>https://media.example.com/playback?id=main</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://origin.example.com/manifest.mpd');
    assert.equal(extensionless.length, 1);
    assert.equal(extensionless[0].mediaType, 'MP4');
    assert.equal(extensionless[0].url, 'https://media.example.com/playback?id=main');

    const unknownMime = worker.parseDashManifestRepresentations(`<MPD><Period><AdaptationSet>
<Representation height="1080"><BaseURL>https://media.example.com/playback?id=unknown</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://origin.example.com/manifest.mpd');
    assert.deepEqual(unknownMime, []);

    const segmented = worker.parseDashManifestRepresentations(`<MPD><Period><AdaptationSet mimeType="video/mp4">
<SegmentTemplate media="chunk-$Number$.m4s" initialization="init.mp4"/>
<Representation height="1080"><BaseURL>https://media.example.com/segments/</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://origin.example.com/manifest.mpd');
    assert.deepEqual(segmented, []);
});

test('DASH parser skips self-closing representations and stops safely on an unclosed one', () => {
    const selfClosing = worker.parseDashManifestRepresentations(
        '<MPD><Representation height="1080"/><Representation height="720"><BaseURL>720.mp4</BaseURL></Representation></MPD>',
        'https://cdn.example.com/manifest.mpd'
    );
    assert.equal(selfClosing.length, 1);
    assert.equal(selfClosing[0].quality, '720p');

    const malformed = `<MPD>${'<Representation height="1080">'.repeat(10_000)}</MPD>`;
    const startedAt = Date.now();
    assert.deepEqual(worker.parseDashManifestRepresentations(malformed, 'https://cdn.example.com/manifest.mpd'), []);
    assert.ok(Date.now() - startedAt < 250, 'malformed MPD should remain a bounded linear scan');
});

test('DASH parser skips representations protected by ContentProtection', () => {
    const variants = worker.parseDashManifestRepresentations(`<MPD><Period>
<AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:test"/>
<Representation height="1080"><BaseURL>protected.mp4</BaseURL></Representation></AdaptationSet>
<AdaptationSet mimeType="video/mp4"><Representation height="720"><BaseURL>clear.mp4</BaseURL></Representation></AdaptationSet>
</Period></MPD>`, 'https://cdn.example.com/manifest.mpd');

    assert.equal(variants.length, 1);
    assert.equal(variants[0].quality, '720p');
    assert.match(variants[0].url, /clear\.mp4$/);
});

test('DASH keeps representations with the same URL shape but distinct ids and frame rates', () => {
    const variants = worker.parseDashManifestRepresentations(`<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
<Representation id="sdr30" bandwidth="8000000" width="1920" height="1080" frameRate="30"><BaseURL>same.mp4?token=sdr</BaseURL></Representation>
<Representation id="hdr60" bandwidth="8000000" width="1920" height="1080" frameRate="60"><BaseURL>same.mp4?token=hdr</BaseURL></Representation>
</AdaptationSet></Period></MPD>`, 'https://cdn.example.com/manifest.mpd');

    assert.equal(variants.length, 2);
    assert.match(variants[0].title, /30 fps/);
    assert.match(variants[1].title, /60 fps/);
});

test('an explicitly incomplete preferred source cannot become recommended over a complete source', () => {
    const incomplete = {
        id: 'video-only',
        url: 'https://cdn.test/video-2160p.mp4',
        type: 'MP4',
        role: 'variant',
        purpose: 'content',
        mediaKind: 'video-only',
        hasAudio: false,
        hasVideo: true,
        userPriority: 1,
        score: 100
    };
    const complete = {
        id: 'complete',
        url: 'https://cdn.test/master.m3u8',
        type: 'HLS',
        role: 'master',
        purpose: 'content',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        userPriority: 0,
        score: 10
    };

    assert.equal(worker.selectRecommendedCandidate([incomplete, complete]).id, 'complete');
});

test('a lone video-only rendition stays visible but is never recommended or auto-opened', () => {
    const videoOnly = {
        id: 'video-only-singleton',
        url: 'https://media.example.com/video-2160p.mp4',
        type: 'MP4',
        role: 'variant',
        purpose: 'content',
        mediaKind: 'video-only',
        hasAudio: false,
        hasVideo: true,
        networkObserved: true,
        sourceMethod: 'network',
        statusCode: 200,
        score: 100,
        diagnosticOnly: false,
        autoEligible: true
    };
    assert.equal(worker.selectRecommendedCandidate([videoOnly]), null);
    assert.equal(worker.isConfirmedAutoTransport(videoOnly), false);
});

test('a lone audio-role playlist is never recommended or auto-opened', () => {
    const audio = {
        id: 'audio-child',
        url: 'https://media.test/nv-hlsfmp4-index-vod4-f8-a1.m3u8',
        type: 'HLS',
        role: 'audio',
        purpose: 'content',
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        score: 70
    };

    assert.equal(worker.selectRecommendedCandidate([audio]), null);
    assert.equal(worker.isConfirmedAutoTransport(audio), false);
});

test('automatic manifest fetch gate blocks local and private destinations', () => {
    assert.equal(worker.isSafeRemoteManifestUrl('https://cdn.example.com/master.m3u8'), true);
    for (const url of [
        'http://localhost/master.m3u8',
        'http://127.0.0.1/master.m3u8',
        'http://10.1.2.3/master.m3u8',
        'http://169.254.169.254/latest/meta-data/master.m3u8',
        'http://192.168.1.10/master.m3u8',
        'http://[::1]/master.m3u8',
        'http://[::ffff:127.0.0.1]/master.m3u8',
        'http://[::ffff:c0a8:1]/master.m3u8',
        'http://[ff02::1]/master.m3u8',
        'http://[fec0::1]/master.m3u8',
        'https://player.internal/master.m3u8'
    ]) assert.equal(worker.isSafeRemoteManifestUrl(url), false, url);
});

test('generic preroll guard cannot be overridden by a user priority', () => {
    const now = 50_000;
    const candidate = {
        id: 'short-current',
        url: 'https://opaque.test/media/file.mp4',
        groupKey: 'https://opaque.test/media/file.mp4',
        type: 'MP4',
        role: 'direct',
        purpose: 'content',
        statusCode: 200,
        score: 100,
        userPriority: 1,
        playerKeys: ['0:doc:p1'],
        currentPlayerKeys: ['0:doc:p1'],
        duration: 30,
        genericPrerollGuardUntil: now - 1,
        prerollProvisional: true
    };

    assert.equal(worker.isGenericPrerollProvisional(candidate, now), true);
    assert.equal(worker.selectRecommendedCandidate([candidate]), null);
});

test('TVP path-token refreshes merge only within the same stable asset and rendition', () => {
    const firstMaster = worker.canonicalizeMediaUrl(
        'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/20260828/client-a/first-signature/video.ism/video-fmp4.m3u8'
    );
    const refreshedMaster = worker.canonicalizeMediaUrl(
        'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/20260829/client-b/second-signature/video.ism/video-fmp4.m3u8'
    );
    const otherAsset = worker.canonicalizeMediaUrl(
        'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065682/20260829/client-b/second-signature/video.ism/video-fmp4.m3u8'
    );
    const childRendition = worker.canonicalizeMediaUrl(
        'https://sdt-thinx3-163.tvp.pl/token/video/vod/95065681/20260829/client-b/second-signature/video.ism/nv-hlsfmp4-index-vod4-f7-v1.m3u8'
    );

    assert.equal(firstMaster, refreshedMaster);
    assert.notEqual(firstMaster, otherAsset);
    assert.notEqual(firstMaster, childRendition);
    assert.doesNotMatch(firstMaster, /signature|client-|202608/);
});

test('URL detection covers playlists and direct media without treating segments as candidates', () => {
    assert.equal(worker.detectMediaFromUrl('https://example.test/master.m3u8?token=x'), 'HLS');
    assert.equal(worker.detectMediaFromUrl('https://example.test/manifest.MPD'), 'DASH');
    assert.equal(worker.detectMediaFromUrl('https://example.test/watch?format=m3u8'), 'HLS');
    assert.equal(worker.detectMediaFromUrl('https://example.test/video/file.mp4'), 'MP4');
    assert.equal(worker.detectMediaFromUrl('https://example.test/video/file.webm'), 'WEBM');
    assert.equal(worker.detectMediaFromUrl('https://example.test/segments/seg-001.ts?token=x'), null);
    assert.equal(worker.detectMediaFromUrl('file:///tmp/master.m3u8'), null);
});

test('response Content-Type detects extensionless streams', () => {
    assert.equal(worker.detectMediaFromContentType('Application/Vnd.Apple.MpegURL; charset=utf-8'), 'HLS');
    assert.equal(worker.detectMediaFromContentType('application/dash+xml'), 'DASH');
    assert.equal(worker.detectMediaFromContentType('video/mp4'), 'MP4');
    assert.equal(worker.detectMediaFromContentType('video/webm; codecs=vp9'), 'WEBM');
    assert.equal(worker.detectMediaFromContentType('video/mp2t'), null);
});

test('candidate scoring prefers master playlists and demotes audio renditions', () => {
    const base = {
        type: 'HLS',
        contentType: 'application/vnd.apple.mpegurl',
        resourceType: 'xmlhttprequest',
        statusCode: 200
    };
    const master = { ...base, url: 'https://example.test/live/master.m3u8' };
    const variant = { ...base, url: 'https://example.test/live/720p/variant.m3u8' };
    const audio = { ...base, url: 'https://example.test/live/audio/main_audio.m3u8' };

    master.role = worker.classifyMediaRole(master);
    variant.role = worker.classifyMediaRole(variant);
    audio.role = worker.classifyMediaRole(audio);

    assert.equal(master.role, 'master');
    assert.equal(variant.role, 'variant');
    assert.equal(audio.role, 'audio');
    assert.ok(worker.scoreCandidate(master) > worker.scoreCandidate(variant));
    assert.ok(worker.scoreCandidate(variant) > worker.scoreCandidate(audio));

    const direct = {
        type: 'MP4',
        role: 'direct',
        url: 'https://example.test/video/movie.mp4',
        contentType: 'video/mp4',
        resourceType: 'media',
        statusCode: 200
    };
    assert.ok(worker.scoreCandidate(master) > worker.scoreCandidate(direct));
});

test('TVP adaptive child playlists never outrank the HLS master', () => {
    const base = {
        type: 'HLS',
        contentType: 'application/vnd.apple.mpegurl',
        resourceType: 'xmlhttprequest',
        statusCode: 200,
        referer: 'https://sport.tvp.pl/article'
    };
    const root = 'https://cdn.tvp.test/token/video/vod/95065681/signed/video.ism/';
    const master = { ...base, url: `${root}video-fmp4.m3u8` };
    const video = { ...base, url: `${root}nv-hlsfmp4-index-vod4-f7-v1.m3u8` };
    const audio = { ...base, url: `${root}nv-hlsfmp4-index-vod4-f8-a1.m3u8` };

    master.role = worker.classifyMediaRole(master);
    video.role = worker.classifyMediaRole(video);
    audio.role = worker.classifyMediaRole(audio);

    assert.equal(master.role, 'master');
    assert.equal(video.role, 'variant');
    assert.equal(audio.role, 'audio');
    assert.ok(worker.scoreCandidate(master) > worker.scoreCandidate(video));
    assert.ok(worker.scoreCandidate(video) > worker.scoreCandidate(audio));
});

test('TVP-style advertisements and silent probes are blocked without rejecting normal MP4', () => {
    const advertisement = {
        type: 'MP4',
        url: 'https://media.example.test/video/vod/reklamy/123_1080p_5000K.mp4'
    };
    const silentProbe = {
        type: 'MP4',
        url: 'https://media.example.test/player/silence.mp4'
    };
    const movie = {
        type: 'MP4',
        url: 'https://media.example.test/video/vod/film/123_1080p.mp4'
    };
    const advertisementPlaylist = {
        type: 'HLS',
        url: 'https://media.example.test/ads/preroll/master.m3u8'
    };
    const numberedSilentProbe = {
        type: 'MP4',
        url: 'https://media.example.test/player/silence-1.mp4'
    };
    const dashInitialization = {
        type: 'MP4',
        url: 'https://media.example.test/video.ism/nv-dash-init-vod4-f7-v1-x3.mp4'
    };

    assert.equal(worker.classifyMediaPurpose(advertisement), 'advertisement');
    assert.equal(worker.classifyMediaPurpose(silentProbe), 'utility');
    assert.equal(worker.classifyMediaPurpose(movie), 'content');
    assert.equal(worker.classifyMediaPurpose(advertisementPlaylist), 'advertisement');
    assert.equal(worker.classifyMediaPurpose(numberedSilentProbe), 'utility');
    assert.equal(worker.isLikelySegmentUrl(dashInitialization.url), true);
    assert.equal(worker.classifyMediaPurpose(dashInitialization), 'utility');
    assert.equal(worker.isBlockedCandidate(advertisement), true);
    assert.equal(worker.isBlockedCandidate(movie), false);
    assert.equal(worker.isBlockedCandidate(dashInitialization), true);
    assert.equal(worker.scoreCandidate(advertisement), 0);
    assert.ok(worker.scoreCandidate(movie) > 0);
});

test('global hard ad signals are tokenized across host, path, query, and title', () => {
    const base = {
        type: 'HLS',
        role: 'master',
        contentType: 'application/vnd.apple.mpegurl',
        resourceType: 'xmlhttprequest',
        statusCode: 200
    };
    const advertisements = [
        { id: 'singular-ad', url: 'https://cdn.example.test/ad/master.m3u8' },
        { id: 'ads-host-token', url: 'https://ads-cdn.example.test/creative/master.m3u8' },
        { id: 'vast-path', url: 'https://cdn.example.test/vast/master.m3u8' },
        { id: 'vmap-path', url: 'https://cdn.example.test/vmap/master.m3u8' },
        { id: 'ima-path', url: 'https://cdn.example.test/ima/master.m3u8' },
        { id: 'ad-type', url: 'https://cdn.example.test/master.m3u8?ad_type=preroll' },
        { id: 'ad-id', url: 'https://cdn.example.test/master.m3u8?adid=42' },
        { id: 'ad-unit', url: 'https://cdn.example.test/master.m3u8?ad_unit=video-preroll' },
        { id: 'creative-id', url: 'https://cdn.example.test/master.m3u8?creative_id=creative-9' },
        { id: 'title-advertisement', url: 'https://cdn.example.test/opaque/master.m3u8', title: 'Advertisement: 1 of 2' },
        { id: 'title-ima', url: 'https://cdn.example.test/opaque/master.m3u8', title: 'IMA ad: preroll' }
    ].map((candidate) => ({ ...base, ...candidate }));

    for (const candidate of advertisements) {
        assert.equal(worker.classifyMediaPurpose(candidate), 'advertisement', candidate.id);
        assert.equal(worker.isBlockedCandidate(candidate), true, candidate.id);
        assert.equal(worker.scoreCandidate(candidate), 0, candidate.id);
    }

    const content = {
        id: 'content',
        url: 'https://cdn.example.test/movie/main.mp4?download=1',
        type: 'MP4',
        role: 'direct',
        contentType: 'video/mp4',
        resourceType: 'media',
        statusCode: 200,
        score: 70
    };
    assert.equal(worker.selectRecommendedCandidate([advertisements[0], content])?.id, 'content');
});

test('hard ad tokens do not match ordinary words, googlevideo, or unrelated query names', () => {
    const controls = [
        { id: 'adapter', url: 'https://cdn.example.test/adapter/master.m3u8', title: 'Adapter tutorial' },
        { id: 'shadow', url: 'https://cdn.example.test/shadow/master.m3u8', title: 'Shadow play' },
        { id: 'download-path', url: 'https://cdn.example.test/download/master.m3u8', title: 'Download' },
        { id: 'adventure-host', url: 'https://adventure.example/movie/master.m3u8', title: 'Adventure documentary' },
        { id: 'download-query', url: 'https://cdn.example.test/movie/master.m3u8?download=1', title: 'Feature film' },
        { id: 'googlevideo-domain', url: 'https://rr1.googlevideo.com/videoplayback?format=mp4&download=1', title: 'Feature film' },
        { id: 'disabled-ad-switch', url: 'https://cdn.example.test/movie/master.m3u8?ad=0', title: 'Feature film' },
        { id: 'ad-as-title-word', url: 'https://cdn.example.test/movie/master.m3u8', title: 'Ad Astra' }
    ];

    for (const candidate of controls) {
        assert.equal(worker.classifyMediaPurpose(candidate), 'content', candidate.id);
        assert.equal(worker.isBlockedCandidate(candidate), false, candidate.id);
    }
});

test('recommended selection is deterministic and excludes advertisements and failed media', () => {
    const candidates = [{
        id: 'advertisement',
        url: 'https://media.test/ads/preroll/master.m3u8',
        type: 'HLS',
        purpose: 'advertisement',
        score: 100,
        lastSeenAt: 50
    }, {
        id: 'failed',
        url: 'https://media.test/failed/master.m3u8',
        type: 'HLS',
        purpose: 'content',
        statusCode: 404,
        score: 100,
        lastSeenAt: 40
    }, {
        id: 'variant',
        url: 'https://media.test/live/720p/variant.m3u8',
        type: 'HLS',
        purpose: 'content',
        score: 70,
        lastSeenAt: 30
    }, {
        id: 'master',
        url: 'https://media.test/live/master.m3u8',
        type: 'HLS',
        purpose: 'content',
        score: 90,
        lastSeenAt: 20
    }];

    assert.equal(worker.selectRecommendedCandidate(candidates)?.id, 'master');
    assert.equal(worker.selectRecommendedCandidate(candidates.slice().reverse())?.id, 'master');
    assert.equal(worker.selectRecommendedCandidate(candidates.slice(0, 2)), null);
});

test('recommended selection prefers a non-audio resolver master over audio and stale network candidates', () => {
    const candidates = [{
        id: 'network-master',
        url: 'https://googlevideo.example.test/videoplayback?id=stale',
        type: 'HLS',
        role: 'master',
        source: 'response_headers',
        sources: ['response_headers'],
        purpose: 'content',
        score: 100,
        lastSeenAt: 30
    }, {
        id: 'resolver-audio',
        url: 'https://media.example.test/audio.webm',
        type: 'WEBM',
        role: 'audio',
        resolverRole: 'audio',
        source: 'resolver_ytdlp',
        sources: ['resolver_ytdlp'],
        purpose: 'content',
        score: 100,
        lastSeenAt: 40
    }, {
        id: 'resolver-master',
        url: 'https://media.example.test/adaptive.m3u8',
        type: 'HLS',
        role: 'master',
        resolverRole: 'master',
        source: 'resolver_ytdlp',
        sources: ['resolver_ytdlp'],
        purpose: 'content',
        score: 70,
        lastSeenAt: 20
    }];

    assert.equal(worker.selectRecommendedCandidate(candidates)?.id, 'resolver-master');
    assert.equal(worker.selectRecommendedCandidate(candidates.slice().reverse())?.id, 'resolver-master');
});

test('primary ranking excludes diagnostics and prefers a direct muxed file over adaptive and incomplete streams', () => {
    const base = {
        type: 'MP4',
        purpose: 'content',
        source: 'resolver_ytdlp',
        sources: ['resolver_ytdlp'],
        resolverRole: 'direct',
        role: 'direct',
        score: 90
    };
    const diagnostic = { ...base, id: 'diagnostic', url: 'https://cdn.test/diagnostic.mp4', diagnosticOnly: true };
    const videoOnly = { ...base, id: 'video', url: 'https://cdn.test/video.mp4', mediaKind: 'video-only', hasAudio: false, hasVideo: true };
    const muxed = { ...base, id: 'muxed', url: 'https://cdn.test/muxed.mp4', mediaKind: 'muxed', hasAudio: true, hasVideo: true, score: 70 };
    const adaptive = { ...base, id: 'adaptive', url: 'https://cdn.test/master.m3u8', type: 'HLS', role: 'master', resolverRole: 'master', mediaKind: 'adaptive', hasAudio: true, hasVideo: true, score: 60 };

    assert.equal(worker.selectRecommendedCandidate([diagnostic, videoOnly, muxed, adaptive])?.id, 'muxed');
});

test('concrete resolver media outranks a page recipe while the recipe remains a safe fallback', () => {
    const page = {
        id: 'page',
        url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
        type: 'MEDIA',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        source: 'resolver_ytdlp',
        sources: ['resolver_ytdlp'],
        playbackKind: 'yt-dlp-page',
        diagnosticOnly: false,
        score: 60
    };
    const rawMaster = {
        ...page,
        id: 'raw-master',
        url: 'https://manifest.example.test/master.m3u8',
        type: 'HLS',
        playbackKind: undefined,
        score: 75
    };
    assert.equal(worker.selectRecommendedCandidate([rawMaster, page]).id, 'raw-master');
    assert.equal(worker.selectRecommendedCandidate([page, rawMaster]).id, 'raw-master');

    const incomplete = {
        ...rawMaster,
        id: 'video-only',
        mediaKind: 'video-only',
        hasAudio: false,
        hasVideo: true
    };
    assert.equal(worker.selectRecommendedCandidate([incomplete, page]).id, 'page');
});

test('recommendation prefers a complete resolver master over a browser-only 2xx transport without reordering the visible playlist', () => {
    const browserOnly2160 = {
        id: 'browser-only-2160',
        url: 'https://media.example.test/video-2160.mp4',
        type: 'MP4',
        role: 'direct',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        height: 2160,
        score: 100
    };
    const resolverMaster720 = {
        id: 'resolver-master-720',
        url: 'https://resolver.example.test/master-720.m3u8',
        type: 'HLS',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'resolver_streamlink',
        sources: ['resolver_streamlink'],
        height: 720,
        score: 40
    };

    assert.equal(
        worker.selectRecommendedCandidate([browserOnly2160, resolverMaster720])?.id,
        'resolver-master-720'
    );
    assert.deepEqual(
        [resolverMaster720, browserOnly2160].sort(worker.compareCandidates).map((candidate) => candidate.id),
        ['browser-only-2160', 'resolver-master-720']
    );
});

test('confirmed transports and quality outrank page discoveries, score and player evidence', () => {
    const base = {
        purpose: 'content',
        role: 'direct',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        userPriority: 0
    };
    const network1080 = {
        ...base,
        id: 'network-1080',
        url: 'https://media.example.test/video-1080.mp4',
        type: 'MP4',
        source: 'response_headers',
        sourceMethod: 'network',
        networkObserved: true,
        statusCode: 200,
        height: 1080,
        score: 25
    };
    const network720Current = {
        ...network1080,
        id: 'network-720-current',
        url: 'https://media.example.test/video-720.mp4',
        height: 720,
        score: 100,
        playerKeys: ['0:video:main'],
        currentPlayerKeys: ['0:video:main']
    };
    const page720 = {
        ...network720Current,
        id: 'page-720-current',
        url: 'https://page.example.test/video-720.mp4',
        source: 'page_dom',
        sourceMethod: 'page',
        networkObserved: false,
        statusCode: undefined
    };

    for (const candidates of [
        [page720, network720Current, network1080],
        [network1080, network720Current, page720]
    ]) {
        assert.equal(worker.selectRecommendedCandidate(candidates)?.id, 'network-1080');
        assert.deepEqual(
            candidates.slice().sort(worker.compareCandidates).map((candidate) => candidate.id),
            ['network-1080', 'network-720-current', 'page-720-current']
        );
    }
});

test('visible playlist ranks concrete video qualities before opaque streams and page fallbacks', () => {
    const concrete = [
        {
            id: 'video-2160-page-mp4',
            url: 'https://page.example.test/quality/2160/movie.mp4',
            type: 'MP4',
            role: 'direct',
            mediaKind: 'muxed',
            hasAudio: true,
            hasVideo: true,
            source: 'page_dom',
            height: 2160
        },
        {
            id: 'video-1440-resolver-hls',
            url: 'https://resolver.example.test/quality/1440/index.m3u8',
            type: 'HLS',
            role: 'variant',
            source: 'resolver_streamlink',
            height: 1440
        },
        {
            id: 'video-1080-network-unknown-av',
            url: 'https://cdn.example.test/quality/1080/index.m3u8?validto=2000000000',
            type: 'HLS',
            role: 'variant',
            source: 'response_headers',
            networkObserved: true,
            statusCode: 200,
            height: 1080
        },
        {
            id: 'video-720-master',
            url: 'https://cdn.example.test/quality/720/master.m3u8',
            type: 'HLS',
            role: 'master',
            source: 'response_headers',
            networkObserved: true,
            statusCode: 200,
            height: 720
        },
        {
            id: 'video-480-page-webm',
            url: 'https://page.example.test/quality/480/movie.webm',
            type: 'WEBM',
            role: 'direct',
            source: 'page_dom',
            height: 480
        }
    ].map((candidate) => ({
        purpose: 'content',
        score: 60,
        userPriority: 0,
        ...candidate
    }));
    const opaqueStream = {
        id: 'opaque-network-stream',
        url: 'https://cdn.example.test/playback?id=movie',
        type: 'MEDIA',
        role: 'direct',
        purpose: 'content',
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        score: 90
    };
    const opaquePage = {
        id: 'opaque-page-fallback',
        url: 'https://video.example.test/watch/movie',
        type: 'MEDIA',
        role: 'direct',
        purpose: 'content',
        source: 'page_dom',
        userPriority: 1,
        score: 100
    };
    const pageRecipe = {
        id: 'page-recipe',
        url: 'https://video.example.test/watch/movie?id=1',
        type: 'MEDIA',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'resolver_ytdlp',
        playbackKind: 'yt-dlp-page',
        userPriority: 1,
        score: 100
    };

    const ranked = [pageRecipe, opaquePage, opaqueStream, ...concrete]
        .sort(worker.compareCandidates)
        .map((candidate) => candidate.id);

    assert.deepEqual(ranked, [
        'video-2160-page-mp4',
        'video-1440-resolver-hls',
        'video-1080-network-unknown-av',
        'video-720-master',
        'video-480-page-webm',
        'opaque-network-stream',
        'opaque-page-fallback',
        'page-recipe'
    ]);
    assert.equal(worker.candidatePlaylistTier(concrete[2]), 0);
    assert.equal(worker.candidatePlaylistTier(opaqueStream), 1);
    assert.equal(worker.candidatePlaylistTier(opaquePage), 2);
    assert.equal(worker.candidatePlaylistTier(pageRecipe), 2);
});

test('playback fitness keeps a complete browser master recommended over a higher-quality unknown-A/V rendition', () => {
    const variant1080 = {
        id: 'fresh-1080-unknown-av',
        url: 'https://cdn.example.test/quality/1080/index.m3u8?validto=2000000000',
        type: 'HLS',
        role: 'variant',
        purpose: 'content',
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        height: 1080,
        score: 80
    };
    const master720 = {
        ...variant1080,
        id: 'complete-master-720',
        url: 'https://cdn.example.test/quality/720/master.m3u8?validto=2000000000',
        role: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        height: 720
    };
    assert.deepEqual(
        [master720, variant1080].sort(worker.compareCandidates).map((candidate) => candidate.id),
        ['fresh-1080-unknown-av', 'complete-master-720']
    );
    assert.equal(worker.selectRecommendedCandidate([variant1080, master720])?.id, 'complete-master-720');
    assert.equal(worker.isConfirmedAutoTransport(variant1080), false);
});

test('a yt-dlp page recipe is recommended over a browser-only 2xx transport without changing visible quality order', () => {
    const pageRecipe = {
        id: 'page-recipe',
        url: 'https://video.example.test/watch/movie',
        type: 'MEDIA',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'resolver_ytdlp',
        playbackKind: 'yt-dlp-page',
        userPriority: 0,
        score: 100
    };
    const video1080 = {
        id: 'browser-only-video-1080',
        url: 'https://cdn.example.test/movie/1080P_8000K/movie.mp4?validto=2000000000',
        type: 'MP4',
        role: 'direct',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        height: 1080,
        userPriority: 0,
        score: 50
    };

    assert.equal(worker.selectRecommendedCandidate([pageRecipe, video1080])?.id, 'page-recipe');
    assert.deepEqual(
        [pageRecipe, video1080].sort(worker.compareCandidates).map((candidate) => candidate.id),
        ['browser-only-video-1080', 'page-recipe']
    );
});

test('expired and play-error renditions fall behind and cannot replace a healthy page fallback', () => {
    const pageRecipe = {
        id: 'healthy-page-recipe',
        url: 'https://video.example.test/watch/movie',
        type: 'MEDIA',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'resolver_ytdlp',
        playbackKind: 'yt-dlp-page',
        score: 40
    };
    const expired2160 = {
        id: 'expired-2160',
        url: 'https://cdn.example.test/quality/2160/index.m3u8?validto=1787991369',
        type: 'HLS',
        role: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        height: 2160,
        score: 100
    };
    const playError2160 = {
        ...expired2160,
        id: 'play-error-2160',
        url: 'https://cdn.example.test/quality/2160/error.m3u8?validto=2000000000',
        playState: 'error'
    };

    assert.deepEqual(
        [expired2160, playError2160, pageRecipe].sort(worker.compareCandidates).map((candidate) => candidate.id),
        ['healthy-page-recipe', 'expired-2160', 'play-error-2160']
    );
    assert.equal(worker.selectRecommendedCandidate([expired2160, playError2160, pageRecipe])?.id, 'healthy-page-recipe');
    assert.equal(worker.isConfirmedAutoTransport(expired2160), false);
});

test('page tiers and user priority cannot promote advertisements, audio or explicit incomplete tracks', () => {
    const pageRecipe = {
        id: 'page-recipe',
        url: 'https://video.example.test/watch/movie',
        type: 'MEDIA',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        source: 'resolver_ytdlp',
        playbackKind: 'yt-dlp-page',
        userPriority: -1,
        score: 10
    };
    const unsafeBase = {
        url: 'https://cdn.example.test/quality/2160/index.m3u8',
        type: 'HLS',
        role: 'variant',
        purpose: 'content',
        source: 'response_headers',
        userPriority: 1,
        height: 2160,
        score: 100
    };
    const advertisement = {
        ...unsafeBase,
        id: 'advertisement',
        url: 'https://cdn.example.test/ads/preroll-2160.m3u8',
        purpose: 'advertisement'
    };
    const audio = { ...unsafeBase, id: 'audio', role: 'audio' };
    const videoOnly = {
        ...unsafeBase,
        id: 'video-only',
        mediaKind: 'video-only',
        hasAudio: false,
        hasVideo: true
    };

    const ranked = [advertisement, audio, videoOnly, pageRecipe].sort(worker.compareCandidates);
    assert.equal(ranked[0].id, 'page-recipe');
    assert.equal(worker.selectRecommendedCandidate(ranked)?.id, 'page-recipe');
});

test('bounded retention preserves a page fallback even though visible ranking places it last', () => {
    const page = {
        id: 'page-fallback',
        url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
        type: 'MEDIA',
        role: 'master',
        resolverRole: 'master',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        source: 'resolver_ytdlp',
        playbackKind: 'yt-dlp-page',
        score: 20,
        lastSeenAt: 1
    };
    const transports = Array.from({ length: 80 }, (_unused, index) => ({
        id: `transport-${String(index).padStart(2, '0')}`,
        url: `https://media.example.test/video-${index}.mp4`,
        type: 'MP4',
        role: 'direct',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        source: 'response_headers',
        networkObserved: true,
        statusCode: 200,
        score: 70,
        lastSeenAt: 100 + index
    }));

    const visible = [page, ...transports].sort(worker.compareCandidates);
    assert.equal(visible.at(-1)?.id, 'page-fallback');
    const retained = [page, ...transports]
        .sort(worker.compareCandidatesForRetention)
        .slice(0, 80);
    assert.equal(retained.some((candidate) => candidate.id === 'page-fallback'), true);

    const preferred = {
        ...transports[0],
        id: 'preferred-oldest',
        url: 'https://media.example.test/preferred-oldest.mp4',
        userPriority: 1,
        lastSeenAt: 1
    };
    const retainedWithPreference = [page, preferred, ...transports.slice(1)]
        .sort(worker.compareCandidatesForRetention)
        .slice(0, 80);
    assert.equal(retainedWithPreference.some((candidate) => candidate.id === 'page-fallback'), true);
    assert.equal(retainedWithPreference.some((candidate) => candidate.id === 'preferred-oldest'), true);

    const quality2160 = {
        ...transports[0],
        id: 'quality-2160-oldest',
        url: 'https://media.example.test/video-2160.mp4',
        height: 2160,
        lastSeenAt: 1
    };
    const lowerQualityFlood = transports.map((candidate, index) => ({
        ...candidate,
        id: `quality-480-${index}`,
        height: 480,
        lastSeenAt: 1_000 + index
    }));
    const retainedByQuality = [quality2160, ...lowerQualityFlood]
        .sort(worker.compareCandidatesForRetention)
        .slice(0, 80);
    assert.equal(retainedByQuality.some((candidate) => candidate.id === 'quality-2160-oldest'), true);
});

test('initialization filtering is narrow enough to keep ordinary MP4 names', () => {
    assert.equal(worker.isLikelySegmentUrl('https://media.test/video.ism/init-stream0.mp4'), true);
    assert.equal(worker.isLikelySegmentUrl('https://media.test/video.ism/nv-dash-init-vod4-f7-v1-x3.mp4'), true);
    assert.equal(worker.isLikelySegmentUrl('https://media.test/movies/movie-init-final.mp4'), false);
});

test('playlist quality labels are inferred from metadata, URL, or adaptive master role', () => {
    assert.equal(worker.inferCandidateQuality({ height: 1080, type: 'MP4', url: 'https://media.test/file.mp4' }), '1080p');
    assert.equal(worker.inferCandidateQuality({ type: 'MP4', url: 'https://media.test/movie-720p.mp4' }), '720p');
    assert.equal(worker.inferCandidateQuality({ type: 'HLS', role: 'master', url: 'https://media.test/master.m3u8' }), 'Auto');
    assert.equal(worker.inferCandidateQuality({ type: 'HLS', role: 'variant', url: 'https://media.test/variant.m3u8' }), '');
});

test('quality inference recognizes common CDN URL aliases without confusing bitrate with 4K', () => {
    const urlsByExpectedQuality = {
        '720p': 'https://media.test/renditions/movie_720P_4000K.mp4',
        '2160p': 'https://media.test/renditions/movie_4K_main.mp4',
        '2160p-uhd': 'https://media.test/renditions/movie_UHD_main.mp4',
        '1080p-fhd': 'https://media.test/renditions/movie_FHD_8000K.mp4',
        '1080p-number': 'https://media.test/renditions/quality/1080/movie.mp4',
        '480p': 'https://media.test/renditions/quality/480/movie.mp4'
    };
    const actual = Object.fromEntries(Object.entries(urlsByExpectedQuality).map(([label, url]) => [
        label,
        worker.inferCandidateQuality({ type: 'MP4', role: 'direct', url })
    ]));

    assert.deepEqual(actual, {
        '720p': '720p',
        '2160p': '2160p',
        '2160p-uhd': '2160p',
        '1080p-fhd': '1080p',
        '1080p-number': '1080p',
        '480p': '480p'
    });
    assert.equal(
        worker.inferCandidateQuality({
            type: 'MP4',
            role: 'direct',
            url: 'https://media.test/renditions/movie_4000K_main.mp4'
        }),
        '',
        'a bitrate such as 4000K is not a 4K resolution marker'
    );
});

test('quality inference ignores movie ids, dates and numeric query parameters', () => {
    const nonQualityUrls = [
        'https://media.test/catalog/video-id-1080/movie.mp4',
        'https://media.test/catalog/asset-2160/movie.mp4',
        'https://media.test/video/vod/95063559/20260829/movie.mp4',
        'https://media.test/catalog/movie.mp4?videoId=2160&episode=1080',
        'https://media.test/catalog/movie_4000K_main.mp4'
    ];

    assert.deepEqual(
        nonQualityUrls.map((url) => worker.inferCandidateQuality({ type: 'MP4', role: 'direct', url })),
        ['', '', '', '', '']
    );
});

test('quality and source identity survive signed-token refreshes', () => {
    const firstUrl = 'https://media.test/renditions/movie_UHD_main.mp4?id=episode-7&token=first';
    const refreshedUrl = 'https://media.test/renditions/movie_UHD_main.mp4?token=second&id=episode-7';

    assert.equal(worker.inferCandidateQuality({ type: 'MP4', role: 'direct', url: firstUrl }), '2160p');
    assert.equal(worker.inferCandidateQuality({ type: 'MP4', role: 'direct', url: refreshedUrl }), '2160p');
    assert.equal(worker.canonicalizeMediaUrl(firstUrl), worker.canonicalizeMediaUrl(refreshedUrl));
    assert.equal(worker.sourcePreferenceFingerprint(firstUrl), worker.sourcePreferenceFingerprint(refreshedUrl));
});

test('default source ranking is 2160p, 1440p, 1080p, 720p, then 480p', () => {
    const candidates = [
        ['quality-z', 'https://media.test/quality/2160/movie.mp4'],
        ['quality-y', 'https://media.test/quality/1440/movie.mp4'],
        ['quality-x', 'https://media.test/quality/1080/movie.mp4'],
        ['quality-w', 'https://media.test/quality/720/movie.mp4'],
        ['quality-v', 'https://media.test/quality/480/movie.mp4']
    ].map(([id, url]) => ({
        id,
        url,
        type: 'MP4',
        role: 'direct',
        purpose: 'content',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        score: 70,
        quality: worker.inferCandidateQuality({ type: 'MP4', role: 'direct', url })
    }));

    for (let index = 0; index < candidates.length; index += 1) {
        assert.equal(
            worker.selectRecommendedCandidate(candidates.slice(index))?.id,
            candidates[index].id,
            `quality order diverged at ${candidates[index].quality}`
        );
    }
});

test('public diagnostics omit complete URLs and token values', () => {
    const secretUrl = 'https://media.example.test/live/master.m3u8?token=do-not-leak';
    const metadataText = JSON.stringify(worker.redactMediaMetadata({
        url: secretUrl,
        type: 'HLS',
        role: 'master'
    }));
    const message = worker.sanitizePublicMessage(`Failed while opening ${secretUrl}`);

    assert.doesNotMatch(metadataText, /do-not-leak/);
    assert.doesNotMatch(metadataText, /master\.m3u8\?token/);
    assert.doesNotMatch(message, /do-not-leak/);
    assert.match(message, /\[URL\]/);
});

test('legacy privacy keys and play mode aliases are deterministic', () => {
    assert.equal(worker.isLegacyLocalKey('streams_42'), true);
    assert.equal(worker.isLegacyLocalKey('logs_42'), true);
    assert.equal(worker.isLegacyLocalKey('autoLaunchMpv'), true);
    assert.equal(worker.isLegacyLocalKey('siteAutoLaunch'), false);
    assert.equal(worker.normalizePlayMode('queue'), 'append');
    assert.equal(worker.normalizePlayMode('replace'), 'replace');
    assert.equal(worker.normalizePlayMode('invalid'), 'new');
});

test('platform adapters keep TVP specific routing and a generic fallback', () => {
    assert.deepEqual(worker.platformAdapterForUrl('https://sport.tvp.pl/95063559/material'), {
        id: 'tvp',
        label: 'TVP',
        resolverOrder: ['streamlink', 'yt-dlp']
    });
    assert.deepEqual(worker.platformAdapterForUrl('https://www.youtube.com/watch?v=test'), {
        id: 'youtube',
        label: 'YouTube',
        resolverOrder: ['yt-dlp', 'streamlink']
    });
    assert.equal(worker.platformAdapterForUrl('https://video.example.test/watch').id, 'generic');
    assert.equal(worker.platformAdapterForUrl('file:///tmp/movie').id, 'generic');
});

test('trusted material scope ignores YouTube tracking but changes with the video id', () => {
    const first = worker.materialScopeForUrl('https://www.youtube.com/watch?v=YE7VzlLtp-4&utm_source=test&t=12');
    const tracked = worker.materialScopeForUrl('https://www.youtube.com/watch?t=90&v=YE7VzlLtp-4&list=PL123');
    const next = worker.materialScopeForUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share');
    const tvp = worker.materialScopeForUrl('https://sport.tvp.pl/95063559/material?tracking=x');

    assert.equal(first.id, 'youtube:watch:YE7VzlLtp-4');
    assert.equal(tracked.id, first.id);
    assert.equal(next.id, 'youtube:shorts:dQw4w9WgXcQ');
    assert.equal(tvp.id, 'tvp:asset:95063559');
});

test('preferred languages and resolver media metadata are bounded and preserved', () => {
    assert.deepEqual(
        worker.normalizePreferredLanguages(['PL_pl', 'en-us', 'pl-PL', 'bad tag', 'de']),
        ['pl-PL', 'en-US', 'de']
    );
    const candidate = worker.normalizeResolvedCandidate({
        resolver: 'yt-dlp',
        url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
        type: 'MEDIA',
        role: 'master',
        language: 'pl_pl',
        mediaKind: 'adaptive',
        hasAudio: true,
        hasVideo: true,
        formatId: 'yt-dlp-page',
        playbackKind: 'yt-dlp-page'
    });
    assert.equal(candidate.language, 'pl-PL');
    assert.equal(candidate.mediaKind, 'adaptive');
    assert.equal(candidate.hasAudio, true);
    assert.equal(candidate.hasVideo, true);
    assert.equal(candidate.formatId, 'yt-dlp-page');
    assert.equal(candidate.playbackKind, 'yt-dlp-page');
    const stream = worker.buildStreamPayload({
        ...candidate,
        source: 'resolver_ytdlp',
        sources: ['resolver_ytdlp']
    });
    assert.equal(stream.language, 'pl-PL');
    assert.equal(stream.playbackKind, 'yt-dlp-page');

    assert.deepEqual(worker.buildStreamPayload({
        url: 'https://media.example.com/polish.mp4',
        manifestDerived: true,
        language: 'pl_PL'
    }), {
        url: 'https://media.example.com/polish.mp4',
        language: 'pl-PL'
    });
    assert.throws(() => worker.buildStreamPayload({
        url: 'https://127.0.0.1/private.mp4',
        manifestDerived: true
    }), /niedozwolonego|niezabezpieczonego/i);

    assert.equal(worker.normalizeResolvedCandidate({
        resolver: 'yt-dlp',
        url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
        type: 'MEDIA',
        role: 'master',
        playbackKind: 'forged'
    }), null);
});

test('TVP resolver target is restricted to a numeric video path on the trusted origin', () => {
    const page = 'https://sport.tvp.pl/95063559/article?tracking=private';
    assert.equal(
        worker.normalizePlatformResolverTarget(
            'https://sport.tvp.pl/95065681/video-slug?token=ignored#player',
            page,
            'tvp'
        ),
        'https://sport.tvp.pl/95065681/video-slug'
    );
    assert.equal(worker.normalizePlatformResolverTarget('https://evil.example/95065681/video', page, 'tvp'), '');
    assert.equal(worker.normalizePlatformResolverTarget('https://sport.tvp.pl/settings', page, 'tvp'), '');
    assert.equal(worker.normalizePlatformResolverTarget('https://sport.tvp.pl/95065681/video', page, 'generic'), '');
});

test('resolver-only candidate stays resolver-only after state recovery', () => {
    const state = worker.createTabState(431, 'sport.tvp.pl');
    state.candidates.push({
        id: 'media_resolver',
        groupKey: 'https://cdn.example.test/master.m3u8',
        url: 'https://cdn.example.test/master.m3u8',
        type: 'HLS',
        source: 'resolver_streamlink',
        sourceMethod: 'streamlink',
        sources: ['resolver_streamlink'],
        networkObserved: false,
        firstSeenAt: 1,
        lastSeenAt: 1,
        requestStartedAt: 1
    });

    const recovered = worker.normalizeTabState(state, 431, 'sport.tvp.pl');

    assert.equal(recovered.candidates[0].sourceMethod, 'streamlink');
    assert.equal(recovered.candidates[0].networkObserved, false);
});

test('validated resolver role survives recovery while network and invalid roles are not trusted', () => {
    const state = worker.createTabState(432, 'www.youtube.com');
    state.candidates.push({
        id: 'media_resolver_role',
        groupKey: 'https://cdn.example.test/adaptive.m3u8',
        url: 'https://cdn.example.test/adaptive.m3u8',
        type: 'HLS',
        role: 'audio',
        resolverRole: 'audio',
        source: 'resolver_ytdlp',
        sources: ['resolver_ytdlp'],
        networkObserved: false,
        firstSeenAt: 1,
        lastSeenAt: 1,
        requestStartedAt: 1
    }, {
        id: 'media_network_role',
        groupKey: 'https://cdn.example.test/network/master.m3u8',
        url: 'https://cdn.example.test/network/master.m3u8',
        type: 'HLS',
        role: 'audio',
        resolverRole: 'audio',
        source: 'response_headers',
        sources: ['response_headers'],
        networkObserved: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        requestStartedAt: 1
    });

    const recovered = worker.normalizeTabState(state, 432, 'www.youtube.com');
    const resolver = recovered.candidates.find((candidate) => candidate.id === 'media_resolver_role');
    const network = recovered.candidates.find((candidate) => candidate.id === 'media_network_role');

    assert.equal(resolver.resolverRole, 'audio');
    assert.equal(resolver.role, 'audio');
    assert.equal(network.resolverRole, undefined);
    assert.equal(network.role, 'master');
});

test('manifest-derived language and completeness survive state normalization after promotion to network', () => {
    const state = worker.createTabState(433, 'video.example.test');
    state.candidates.push({
        id: 'manifest-polish',
        groupKey: 'https://cdn.test/video.mp4|manifest:variant:1080:8000:test',
        url: 'https://cdn.test/video.mp4?token=fresh',
        type: 'MP4',
        source: 'response_headers',
        sourceMethod: 'network',
        sources: ['manifest_scan', 'response_headers'],
        manifestDerived: true,
        manifestRole: 'variant',
        manifestCanonicalKey: 'https://cdn.test/video.mp4',
        role: 'variant',
        language: 'pl-PL',
        mediaKind: 'muxed',
        hasAudio: true,
        hasVideo: true,
        purpose: 'content',
        firstSeenAt: 1,
        lastSeenAt: 2,
        requestStartedAt: 2,
        score: 50
    });

    const normalized = worker.normalizeTabState(state, 433, 'video.example.test');
    assert.equal(normalized.candidates[0].language, 'pl-PL');
    assert.equal(normalized.candidates[0].mediaKind, 'muxed');
    assert.equal(normalized.candidates[0].hasAudio, true);
    assert.equal(normalized.candidates[0].hasVideo, true);
    assert.equal(normalized.candidates[0].role, 'variant');
});

test('resolver candidates are reduced to the public allowlist before storage', () => {
    const streamlink = worker.normalizeResolvedCandidate({
        resolver: 'streamlink',
        url: 'https://cdn.example.test/live/master.m3u8?token=signed',
        type: 'HLS',
        role: 'master',
        quality: 'Auto',
        title: 'Transmisja',
        live: true,
        referer: 'https://video.example.test/watch',
        userAgent: 'Resolver-Test/1.0'
    });
    assert.equal(streamlink.source, 'resolver_streamlink');
    assert.equal(streamlink.mediaType, 'HLS');
    assert.equal(streamlink.live, true);
    assert.equal(streamlink.role, 'master');
    assert.equal(streamlink.resolverRole, 'master');
    assert.equal(worker.candidateSourceMethod(streamlink.source), 'streamlink');

    const invalidRole = worker.normalizeResolvedCandidate({
        resolver: 'yt-dlp',
        url: 'https://cdn.example.test/video.mp4',
        type: 'MP4',
        role: 'advertisement'
    });
    assert.equal(invalidRole.role, undefined);
    assert.equal(invalidRole.resolverRole, undefined);

    assert.equal(worker.normalizeResolvedCandidate({
        resolver: 'yt-dlp',
        url: 'https://cdn.example.test/video.mp4',
        type: 'MP4',
        cookie: 'secret'
    }), null);
    assert.equal(worker.normalizeResolvedCandidate({
        resolver: 'yt-dlp',
        url: 'file:///etc/passwd',
        type: 'MP4'
    }), null);
    assert.equal(worker.normalizeResolvedCandidate({
        resolver: 'streamlink',
        url: 'https://cdn.example.test/segment-1.ts',
        type: 'HLS'
    }), null);
});

test('resolver cookie records contain only bounded fields required by the native jar', () => {
    assert.deepEqual(worker.resolverCookieRecord({
        name: 'session_id',
        value: 'signed-value',
        domain: '.example.test',
        path: '/watch',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        session: false,
        expirationDate: 2_000_000_000,
        storeId: 'profile-secret',
        partitionKey: { topLevelSite: 'https://example.test' }
    }), {
        name: 'session_id',
        value: 'signed-value',
        domain: '.example.test',
        path: '/watch',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        expires: 2_000_000_000
    });
    assert.throws(() => worker.resolverCookieRecord({
        name: 'bad\nname',
        value: 'secret',
        domain: 'example.test',
        path: '/',
        secure: true,
        httpOnly: false,
        hostOnly: true
    }), /cookie/i);
});

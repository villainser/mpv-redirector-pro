from __future__ import annotations

import io
import json
import os
import socket
import stat
import struct
import sys
import tempfile
import time
import unittest
from collections import deque
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.fspath(PROJECT_ROOT / "native_host"))

import mpv_redirector_host as host  # noqa: E402


VALID_STREAM = {
    "url": "https://media.example.test/live/master.m3u8?token=secret",
    "referer": "https://www.example.test/watch?id=12",
    "origin": "https://www.example.test",
    "userAgent": "Mozilla/5.0 Test",
}

VALID_RESOLVER_COOKIE = {
    "name": "session",
    "value": "cookie-secret",
    "domain": ".tvp.pl",
    "path": "/",
    "secure": True,
    "httpOnly": True,
    "hostOnly": False,
    "expires": None,
}


def valid_resolve_payload(**updates: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocolVersion": 2,
        "action": "resolve",
        "requestId": "resolve-test-1",
        "source": "manual",
        "pageUrl": "https://sport.tvp.pl/watch/video",
        "adapter": "tvp",
        "resolverOrder": ["streamlink", "yt-dlp"],
        "cookies": [dict(VALID_RESOLVER_COOKIE)],
    }
    payload.update(updates)
    return payload


class ChunkSocket:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = deque(chunks)
        self.sent = bytearray()
        self.timeouts: list[float] = []
        self.closed = False

    def settimeout(self, value: float) -> None:
        self.timeouts.append(value)

    def sendall(self, data: bytes) -> None:
        self.sent.extend(data)

    def recv(self, _size: int) -> bytes:
        if not self.chunks:
            return b""
        return self.chunks.popleft()

    def close(self) -> None:
        self.closed = True


class TimeoutChunkSocket(ChunkSocket):
    def recv(self, _size: int) -> bytes:
        if not self.chunks:
            raise socket.timeout
        return self.chunks.popleft()


class ControlledMonotonicClock:
    def __init__(self, value: float = 0.0) -> None:
        self.value = value
        self.next_value: float | None = None

    def monotonic(self) -> float:
        if self.next_value is not None:
            self.value = self.next_value
            self.next_value = None
        return self.value


class ScriptedIpcSession:
    def __init__(
        self,
        clock: ControlledMonotonicClock,
        messages: list[tuple[float, dict[str, object]]],
        *,
        post_event_replies: bool = False,
        jump_after_event: float | None = None,
    ) -> None:
        self.clock = clock
        self.messages = deque(messages)
        self.events: deque[dict[str, object]] = deque()
        self.post_event_replies = post_event_replies
        self.jump_after_event = jump_after_event
        self.event_seen = False
        self.next_request_id = 7
        self.sent: list[tuple[int, list[object], float]] = []

    def send_request(
        self,
        command: list[object],
        deadline: float,
        *,
        request_id: int | None = None,
    ) -> int:
        actual_request_id = (
            request_id if request_id is not None else self.next_request_id
        )
        if request_id is None:
            self.next_request_id += 1
        self.sent.append((actual_request_id, list(command), deadline))
        if self.post_event_replies and self.event_seen:
            property_name = command[1]
            message: dict[str, object] = {
                "request_id": actual_request_id,
                "error": "success" if property_name == "path" else "property unavailable",
            }
            if property_name == "path":
                message["data"] = VALID_STREAM["url"]
            response_time = self.clock.value + (0.01 if property_name == "path" else 0.02)
            self.messages.append((response_time, message))
        return actual_request_id

    def receive(self, deadline: float) -> dict[str, object]:
        if self.messages and self.messages[0][0] <= deadline:
            ready_at, message = self.messages.popleft()
            self.clock.value = max(self.clock.value, ready_at)
            if message.get("event") == "file-loaded":
                self.event_seen = True
                self.clock.next_value = self.jump_after_event
            return message
        self.clock.value = max(self.clock.value, deadline)
        raise host.IpcReadTimeout


class ExitedProcess:
    def __init__(self, exit_code: int) -> None:
        self.exit_code = exit_code
        self.pid = 1234

    def poll(self) -> int:
        return self.exit_code


class RunningProcess:
    pid = 1234

    def poll(self) -> None:
        return None


class DelayedExitProcess:
    pid = 1234

    def __init__(self, exit_code: int, running_polls: int) -> None:
        self.exit_code = exit_code
        self.running_polls = running_polls
        self.poll_count = 0

    def poll(self) -> int | None:
        self.poll_count += 1
        if self.poll_count <= self.running_polls:
            return None
        return self.exit_code


class ValidationTests(unittest.TestCase):
    def test_accepts_v2_health(self) -> None:
        request = host.validate_request(
            {
                "protocolVersion": 2,
                "action": "health",
                "requestId": "popup-42",
            }
        )
        self.assertEqual(request.action, "health")
        self.assertEqual(request.request_protocol_version, 2)
        self.assertEqual(request.request_id, "popup-42")

    def test_playback_kind_is_exact_and_v2_only(self) -> None:
        stream = host.validate_stream(
            {
                "url": "https://www.youtube.com/watch?v=YE7VzlLtp-4",
                "language": "pl-pl",
                "playbackKind": "yt-dlp-page",
            }
        )
        self.assertEqual(stream.playback_kind, "yt-dlp-page")
        self.assertEqual(stream.language, "pl-PL")
        for invalid in ("", "ytdlp", "yt-dlp-page\n--profile=evil", True):
            if invalid == "":
                continue
            with self.subTest(invalid=invalid), self.assertRaises(host.HostError):
                host.validate_stream(
                    {
                        "url": "https://www.youtube.com/watch?v=YE7VzlLtp-4",
                        "playbackKind": invalid,
                    }
                )
        with self.assertRaises(host.HostError):
            host.validate_stream(
                {
                    "url": "https://www.youtube.com/watch?v=YE7VzlLtp-4",
                    "playbackKind": "yt-dlp-page",
                },
                legacy=True,
            )

    def test_accepts_exact_v2_resolve_with_domain_scoped_cookie(self) -> None:
        request = host.validate_request(valid_resolve_payload())
        self.assertEqual(request.action, "resolve")
        self.assertEqual(request.source, "manual")
        self.assertEqual(request.page_url, "https://sport.tvp.pl/watch/video")
        self.assertEqual(request.adapter, "tvp")
        self.assertEqual(request.resolver_order, ("streamlink", "yt-dlp"))
        self.assertEqual(len(request.cookies), 1)
        cookie = request.cookies[0]
        self.assertEqual(cookie.domain, "tvp.pl")
        self.assertFalse(cookie.host_only)
        self.assertTrue(cookie.http_only)

    def test_resolve_accepts_page_ready_and_bounded_preferred_languages(self) -> None:
        request = host.validate_request(
            valid_resolve_payload(
                source="page_ready",
                cookies=[],
                preferredLanguages=["pl-pl", "en", "zh-Hant-TW"],
            )
        )
        self.assertEqual(request.source, "page_ready")
        self.assertEqual(
            request.preferred_languages,
            ("pl-PL", "en", "zh-Hant-TW"),
        )

        without_preferences = host.validate_request(valid_resolve_payload())
        empty_preferences = host.validate_request(
            valid_resolve_payload(preferredLanguages=[])
        )
        self.assertEqual(without_preferences.preferred_languages, ())
        self.assertEqual(empty_preferences.preferred_languages, ())

    def test_page_ready_resolve_rejects_cookies(self) -> None:
        expired = {**VALID_RESOLVER_COOKIE, "expires": 1}
        for cookies in ([dict(VALID_RESOLVER_COOKIE)], [expired]):
            with self.subTest(cookies=cookies):
                with self.assertRaises(host.HostError) as caught:
                    host.validate_request(
                        valid_resolve_payload(source="page_ready", cookies=cookies)
                    )
                self.assertEqual(caught.exception.code, "INVALID_REQUEST")

    def test_background_refresh_resolve_is_cookie_free(self) -> None:
        request = host.validate_request(
            valid_resolve_payload(source="refresh", cookies=[])
        )
        self.assertEqual(request.source, "refresh")
        self.assertEqual(request.cookies, ())

        with self.assertRaises(host.HostError) as caught:
            host.validate_request(
                valid_resolve_payload(
                    source="refresh",
                    cookies=[dict(VALID_RESOLVER_COOKIE)],
                )
            )
        self.assertEqual(caught.exception.code, "INVALID_REQUEST")

    def test_resolve_rejects_invalid_or_injectable_preferred_languages(self) -> None:
        invalid_preferences = [
            "pl",
            None,
            ["pl", "PL"],
            ["en_US"],
            ["pl,--script-opts=evil"],
            ["pl\n--audio-file=evil"],
            ["a" * (host.MAX_LANGUAGE_TAG_BYTES + 1)],
            ["en"] * (host.MAX_PREFERRED_LANGUAGES + 1),
            ["en-a-foo-a-bar"],
            ["sl-rozaj-rozaj"],
        ]
        for preferred_languages in invalid_preferences:
            with self.subTest(preferred_languages=preferred_languages):
                with self.assertRaises(host.HostError) as caught:
                    host.validate_request(
                        valid_resolve_payload(
                            preferredLanguages=preferred_languages,
                        )
                    )
                self.assertEqual(caught.exception.code, "INVALID_REQUEST")

    def test_resolve_rejects_http_cookies_unknown_fields_and_bad_order(self) -> None:
        invalid = [
            valid_resolve_payload(pageUrl="http://sport.tvp.pl/watch/video"),
            valid_resolve_payload(extra=True),
            valid_resolve_payload(source="auto"),
            valid_resolve_payload(adapter="unknown"),
            valid_resolve_payload(resolverOrder=[]),
            valid_resolve_payload(resolverOrder=["streamlink", "streamlink"]),
            valid_resolve_payload(resolverOrder=["curl"]),
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(host.HostError):
                    host.validate_request(payload)

        without_cookies = host.validate_request(
            valid_resolve_payload(
                pageUrl="http://sport.tvp.pl/watch/video",
                cookies=[],
            )
        )
        self.assertEqual(without_cookies.page_url, "http://sport.tvp.pl/watch/video")

    def test_resolve_rejects_local_private_and_legacy_numeric_page_urls(self) -> None:
        forbidden = [
            "http://localhost/watch",
            "http://player.local/watch",
            "http://metadata.internal/watch",
            "http://127.0.0.1/watch",
            "http://127.1/watch",
            "http://2130706433/watch",
            "http://0x7f000001/watch",
            "http://10.0.0.1/watch",
            "http://169.254.169.254/watch",
            "http://192.168.1.1/watch",
            "http://[::1]/watch",
            "http://[fc00::1]/watch",
            "http://[fe80::1]/watch",
        ]
        for page_url in forbidden:
            with self.subTest(page_url=page_url):
                with self.assertRaises(host.HostError) as raised:
                    host.validate_request(
                        valid_resolve_payload(pageUrl=page_url, cookies=[])
                    )
                self.assertEqual(raised.exception.code, "RESOLVER_URL_FORBIDDEN")

        public_ip = host.validate_request(
            valid_resolve_payload(pageUrl="https://8.8.8.8/watch", cookies=[])
        )
        self.assertEqual(public_ip.page_url, "https://8.8.8.8/watch")

    def test_resolve_cookie_schema_is_exact_and_bound_to_page_domain_and_path(self) -> None:
        bad_cookie_values = [
            {**VALID_RESOLVER_COOKIE, "extra": True},
            {key: value for key, value in VALID_RESOLVER_COOKIE.items() if key != "hostOnly"},
            {**VALID_RESOLVER_COOKIE, "hostOnly": 0},
            {**VALID_RESOLVER_COOKIE, "domain": ".example.test"},
            {**VALID_RESOLVER_COOKIE, "path": "/account"},
            {**VALID_RESOLVER_COOKIE, "name": "bad\tname"},
            {**VALID_RESOLVER_COOKIE, "value": "bad\nvalue"},
            {**VALID_RESOLVER_COOKIE, "expires": float("inf")},
            {**VALID_RESOLVER_COOKIE, "expires": 10**1000},
        ]
        for cookie in bad_cookie_values:
            with self.subTest(cookie=cookie):
                with self.assertRaises(host.HostError):
                    host.validate_request(valid_resolve_payload(cookies=[cookie]))

        host_only_parent = {**VALID_RESOLVER_COOKIE, "hostOnly": True}
        with self.assertRaises(host.HostError):
            host.validate_request(valid_resolve_payload(cookies=[host_only_parent]))

    def test_expired_resolve_cookie_is_validated_but_not_forwarded(self) -> None:
        cookie = {**VALID_RESOLVER_COOKIE, "expires": 1}
        request = host.validate_request(valid_resolve_payload(cookies=[cookie]))
        self.assertEqual(request.cookies, ())

    def test_cookie_path_matching_obeys_segment_boundary(self) -> None:
        matching = {
            **VALID_RESOLVER_COOKIE,
            "path": "/watch",
        }
        request = host.validate_request(valid_resolve_payload(cookies=[matching]))
        self.assertEqual(len(request.cookies), 1)
        with self.assertRaises(host.HostError):
            host.validate_request(
                valid_resolve_payload(
                    pageUrl="https://sport.tvp.pl/watcher/video",
                    cookies=[matching],
                )
            )

    def test_accepts_all_v2_play_modes(self) -> None:
        for mode in ("new", "append", "replace"):
            with self.subTest(mode=mode):
                request = host.validate_request(
                    {
                        "protocolVersion": 2,
                        "action": "play",
                        "requestId": f"play-{mode}",
                        "source": "manual",
                        "mode": mode,
                        "stream": dict(VALID_STREAM),
                    }
                )
                self.assertEqual(request.mode, mode)
                self.assertEqual(request.stream.url, VALID_STREAM["url"])

    def test_legacy_queue_mapping_is_narrow(self) -> None:
        legacy_stream = {
            **VALID_STREAM,
            "type": "HLS",
            "isMaster": True,
        }
        new_request = host.validate_request(
            {
                "action": "play",
                "stream": legacy_stream,
                "source": "manual",
                "queue": False,
            }
        )
        append_request = host.validate_request(
            {
                "action": "play",
                "stream": dict(VALID_STREAM),
                "source": "auto",
                "queue": True,
            }
        )
        self.assertEqual(new_request.request_protocol_version, 1)
        self.assertEqual(new_request.mode, "new")
        self.assertEqual(append_request.mode, "append")

        with self.assertRaises(host.HostError):
            host.validate_request(
                {
                    "action": "play",
                    "stream": {**legacy_stream, "isMaster": 1},
                    "queue": False,
                }
            )

        invalid_legacy = [
            {"action": "health", "stream": dict(VALID_STREAM), "queue": False},
            {"action": "play", "stream": dict(VALID_STREAM)},
            {
                "action": "play",
                "stream": dict(VALID_STREAM),
                "queue": 1,
            },
            {
                "action": "play",
                "stream": dict(VALID_STREAM),
                "queue": False,
                "mode": "new",
            },
        ]
        for payload in invalid_legacy:
            with self.subTest(payload=payload):
                with self.assertRaises(host.HostError):
                    host.validate_request(payload)

    def test_rejects_unknown_fields_and_non_exact_types(self) -> None:
        invalid_requests = [
            {"protocolVersion": True, "action": "health"},
            {"protocolVersion": 3, "action": "health"},
            {"protocolVersion": 2, "action": "health", "extra": True},
            {
                "protocolVersion": 2,
                "action": "play",
                "mode": "new",
                "stream": dict(VALID_STREAM),
            },
            {
                "protocolVersion": 2,
                "action": "play",
                "source": "scheduler",
                "mode": "new",
                "stream": dict(VALID_STREAM),
            },
            {
                "protocolVersion": 2,
                "action": "play",
                "source": "manual",
                "mode": True,
                "stream": dict(VALID_STREAM),
            },
            {
                "protocolVersion": 2,
                "action": "play",
                "source": "manual",
                "mode": "new",
                "stream": {**VALID_STREAM, "cookie": "secret"},
            },
        ]
        for payload in invalid_requests:
            with self.subTest(payload=payload):
                with self.assertRaises(host.HostError):
                    host.validate_request(payload)

    def test_rejects_non_http_urls_credentials_and_header_injection(self) -> None:
        invalid_streams = [
            {"url": "file:///etc/passwd"},
            {"url": "javascript:alert(1)"},
            {"url": "https://user:password@example.test/live.m3u8"},
            {"url": "https://example.test/live.m3u8\n--profile=evil"},
            {
                "url": "https://example.test/live.m3u8",
                "referer": "https://example.test/watch\r\nX-Evil: yes",
            },
            {
                "url": "https://example.test/live.m3u8",
                "origin": "https://example.test/not-an-origin",
            },
            {
                "url": "https://example.test/live.m3u8",
                "userAgent": "Good\nBad",
            },
            {
                "url": "https://example.test/live.m3u8",
                "userAgent": "Mozilla/5.0 ☃",
            },
        ]
        for stream in invalid_streams:
            with self.subTest(stream=stream):
                with self.assertRaises(host.HostError):
                    host.validate_stream(stream)

    def test_enforces_url_and_header_limits(self) -> None:
        with self.assertRaises(host.HostError):
            host.validate_stream(
                {"url": "https://example.test/" + "a" * host.MAX_URL_BYTES}
            )
        with self.assertRaises(host.HostError):
            host.validate_stream(
                {
                    "url": "https://example.test/live.m3u8",
                    "userAgent": "A" * (host.MAX_USER_AGENT_BYTES + 1),
                }
            )

    def test_accepts_exact_opaque_null_origin(self) -> None:
        stream = host.validate_stream(
            {
                "url": "https://example.test/live.m3u8",
                "origin": "null",
            }
        )
        self.assertEqual(stream.origin, "null")
        args = host.build_mpv_args(
            "/usr/bin/mpv",
            stream,
            ipc_path=Path("/run/user/1000/mpv-redirector/test.sock"),
            idle=False,
        )
        self.assertIn("--http-header-fields=Origin: null", args)
        command = host.build_loadfile_command(stream, "append")
        self.assertEqual(command[4]["http-header-fields"], "Origin: null")

    def test_rejects_malformed_null_origin_variants(self) -> None:
        for origin in ("NULL", "null ", "null/path", "null\r\nX-Evil: yes", None):
            with self.subTest(origin=origin):
                with self.assertRaises(host.HostError) as caught:
                    host.validate_stream(
                        {
                            "url": "https://example.test/live.m3u8",
                            "origin": origin,
                        }
                    )
                self.assertEqual(caught.exception.code, "INVALID_HEADER")

    def test_v2_stream_errors_preserve_trusted_response_correlation(self) -> None:
        cases = (
            ({"url": "file:///etc/passwd"}, "INVALID_URL"),
            (
                {
                    "url": "https://example.test/live.m3u8",
                    "origin": "null\r\nX-Evil: yes",
                },
                "INVALID_HEADER",
            ),
        )
        for stream, error_code in cases:
            with self.subTest(error_code=error_code):
                payload = {
                    "protocolVersion": 2,
                    "action": "play",
                    "requestId": f"correlation-{error_code.lower()}",
                    "source": "manual",
                    "mode": "new",
                    "stream": stream,
                }
                response = host.handle_payload(payload, mock.Mock())
                self.assertFalse(response["ok"])
                self.assertEqual(response["errorCode"], error_code)
                self.assertEqual(response["action"], "play")
                self.assertEqual(response["requestId"], payload["requestId"])
                self.assertEqual(response["requestProtocolVersion"], 2)
                self.assertEqual(response["mode"], "new")
                self.assertFalse(response["confirmed"])

    def test_untrusted_request_id_is_never_reflected_on_validation_error(self) -> None:
        response = host.handle_payload(
            {
                "protocolVersion": 2,
                "action": "play",
                "requestId": "unsafe\r\nid",
                "source": "manual",
                "mode": "new",
                "stream": {"url": "file:///etc/passwd"},
            },
            mock.Mock(),
        )
        self.assertEqual(response["errorCode"], "INVALID_REQUEST")
        self.assertNotIn("requestId", response)
        self.assertNotIn("action", response)


class SignedUrlExpiryTests(unittest.TestCase):
    NOW = 1_787_995_000.25

    @staticmethod
    def stream(query: str, *, playback_kind: str = "") -> host.StreamSpec:
        return host.StreamSpec(
            url=f"https://media.example.test/live/master.m3u8?{query}",
            playback_kind=playback_kind,
        )

    def test_validto_is_case_insensitive_and_accepts_unix_seconds_or_milliseconds(
        self,
    ) -> None:
        expired_seconds = int(self.NOW) - 1
        expired_milliseconds = int((self.NOW - 1) * 1000)

        self.assertTrue(
            host._stream_url_is_expired(
                self.stream(f"VaLiDtO={expired_seconds}"),
                now=self.NOW,
            )
        )
        self.assertTrue(
            host._stream_url_is_expired(
                self.stream(f"VALIDTO={expired_milliseconds}"),
                now=self.NOW,
            )
        )

    def test_future_validto_remains_playable_outside_small_safety_margin(self) -> None:
        future_seconds = int(self.NOW + host.SIGNED_URL_EXPIRY_GRACE_SECONDS + 2)
        future_milliseconds = int(
            (self.NOW + host.SIGNED_URL_EXPIRY_GRACE_SECONDS + 2) * 1000
        )

        for expiry in (future_seconds, future_milliseconds):
            with self.subTest(expiry=expiry):
                self.assertFalse(
                    host._stream_url_is_expired(
                        self.stream(f"validto={expiry}"),
                        now=self.NOW,
                    )
                )

    def test_validto_inside_safety_margin_is_rejected(self) -> None:
        almost_expired = int(
            self.NOW + host.SIGNED_URL_EXPIRY_GRACE_SECONDS - 1
        )
        self.assertTrue(
            host._stream_url_is_expired(
                self.stream(f"validto={almost_expired}"),
                now=self.NOW,
            )
        )

    def test_expiry_aliases_share_the_extension_allowlist_and_earliest_wins(
        self,
    ) -> None:
        expired_seconds = int(self.NOW) - 1
        future_seconds = int(self.NOW + 60)

        for name in ("validto", "exp", "expires", "expiry"):
            with self.subTest(name=name):
                self.assertTrue(
                    host._stream_url_is_expired(
                        self.stream(f"{name}={expired_seconds}"),
                        now=self.NOW,
                    )
                )
        self.assertTrue(
            host._stream_url_is_expired(
                self.stream(
                    f"validto={future_seconds}&expires={expired_seconds}"
                ),
                now=self.NOW,
            )
        )

    def test_malformed_or_implausible_validto_is_ignored(self) -> None:
        values = (
            "",
            "not-a-time",
            "-1787994999",
            "1",
            "1787994999.5",
            "999999999999999999999999",
        )
        for value in values:
            with self.subTest(value=value):
                self.assertFalse(
                    host._stream_url_is_expired(
                        self.stream(f"validto={value}"),
                        now=self.NOW,
                    )
                )

    def test_duplicate_validto_requires_one_unambiguous_normalized_expiry(self) -> None:
        expired_seconds = int(self.NOW) - 1
        expired_milliseconds = expired_seconds * 1000
        future_seconds = int(self.NOW + 60)

        self.assertTrue(
            host._stream_url_is_expired(
                self.stream(
                    f"validto={expired_seconds}&VALIDTO={expired_milliseconds}"
                ),
                now=self.NOW,
            )
        )
        self.assertFalse(
            host._stream_url_is_expired(
                self.stream(
                    f"validto={expired_seconds}&validto={future_seconds}"
                ),
                now=self.NOW,
            )
        )
        self.assertFalse(
            host._stream_url_is_expired(
                self.stream(f"validto={expired_seconds}&validto=malformed"),
                now=self.NOW,
            )
        )

    def test_page_recipe_does_not_treat_page_query_as_stream_expiry(self) -> None:
        expired_seconds = int(self.NOW) - 60
        self.assertFalse(
            host._stream_url_is_expired(
                self.stream(
                    f"validto={expired_seconds}",
                    playback_kind="yt-dlp-page",
                ),
                now=self.NOW,
            )
        )

    def test_expired_url_fails_before_mpv_lookup_without_leaking_url_or_expiry(
        self,
    ) -> None:
        expiry = int(self.NOW) - 60
        stream = self.stream(f"validto={expiry}&token=do-not-log")
        request = host.HostRequest(
            action="play",
            request_protocol_version=2,
            request_id="expired-play",
            source="manual",
            mode="new",
            stream=stream,
        )

        with tempfile.TemporaryDirectory() as temporary:
            logger = host.SecureLogger(Path(temporary) / "private-state")
            with (
                mock.patch.object(host.time, "time", return_value=self.NOW),
                mock.patch.object(host, "find_mpv_path") as find_mpv,
                mock.patch.object(host, "play_new") as play_new,
            ):
                response = host.dispatch(request, logger)

            find_mpv.assert_not_called()
            play_new.assert_not_called()
            self.assertFalse(response["ok"])
            self.assertEqual(response["errorCode"], "STREAM_URL_EXPIRED")
            serialized_response = json.dumps(response)
            log_text = logger.path.read_text(encoding="utf-8")
            for secret in (stream.url, str(expiry), "do-not-log"):
                self.assertNotIn(secret, serialized_response)
                self.assertNotIn(secret, log_text)


class ArgumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stream = host.validate_stream(dict(VALID_STREAM))

    def test_new_process_args_have_secure_defaults_and_option_terminator(self) -> None:
        args = host.build_mpv_args(
            "/usr/bin/mpv",
            self.stream,
            ipc_path=Path("/run/user/1000/mpv-redirector/new.sock"),
            idle=False,
        )
        self.assertEqual(args[0], "/usr/bin/mpv")
        self.assertIn("--tls-verify=yes", args)
        self.assertIn("--load-unsafe-playlists=no", args)
        self.assertIn("--idle=no", args)
        self.assertIn(f"--referrer={VALID_STREAM['referer']}", args)
        self.assertIn(f"--user-agent={VALID_STREAM['userAgent']}", args)
        self.assertIn(
            f"--http-header-fields=Origin: {VALID_STREAM['origin']}", args
        )
        self.assertEqual(args[-2], "--")
        self.assertEqual(args[-1], VALID_STREAM["url"])

    def test_loadfile_modes_and_options(self) -> None:
        append = host.build_loadfile_command(self.stream, "append")
        replace = host.build_loadfile_command(self.stream, "replace")
        self.assertEqual(append[:4], ["loadfile", VALID_STREAM["url"], "append-play", -1])
        self.assertEqual(replace[:4], ["loadfile", VALID_STREAM["url"], "replace", -1])
        for command in (append, replace):
            options = command[4]
            self.assertEqual(options["tls-verify"], "yes")
            self.assertEqual(options["load-unsafe-playlists"], "no")
            self.assertEqual(options["referrer"], VALID_STREAM["referer"])
            self.assertEqual(
                options["http-header-fields"],
                f"Origin: {VALID_STREAM['origin']}",
            )

    def test_language_is_canonicalized_and_applied_to_spawn_and_loadfile(self) -> None:
        stream = host.validate_stream({**VALID_STREAM, "language": "pl-pl"})
        self.assertEqual(stream.language, "pl-PL")
        args = host.build_mpv_args(
            "/usr/bin/mpv",
            stream,
            ipc_path=Path("/run/user/1000/mpv-redirector/lang.sock"),
            idle=False,
        )
        self.assertIn("--alang=pl-PL,pl", args)
        self.assertEqual(
            host.build_loadfile_command(stream, "replace")[4]["alang"],
            "pl-PL,pl",
        )

        base_only = host.validate_stream({"url": VALID_STREAM["url"], "language": "en"})
        self.assertIn(
            "--alang=en",
            host.build_mpv_args(
                "/usr/bin/mpv",
                base_only,
                ipc_path=Path("/run/user/1000/mpv-redirector/base.sock"),
                idle=False,
            ),
        )

    def test_ytdl_page_uses_private_resolver_polish_audio_and_no_master_manifest(self) -> None:
        page_url = "https://www.youtube.com/watch?v=YE7VzlLtp-4"
        resolver_path = "/home/test/.local/share/mpv-redirector/resolvers/bin/yt-dlp"
        stream = host.validate_stream(
            {
                "url": page_url,
                "language": "pl-PL",
                "playbackKind": "yt-dlp-page",
            }
        )
        args = host.build_mpv_args(
            "/usr/bin/mpv",
            stream,
            ipc_path=Path("/run/user/1000/mpv-redirector/ytdl.sock"),
            idle=False,
            yt_dlp_path=resolver_path,
        )
        self.assertIn(
            f"--script-opts-append=ytdl_hook-ytdl_path={resolver_path}",
            args,
        )
        self.assertIn("--script-opts-append=ytdl_hook-use_manifests=no", args)
        self.assertIn("--script-opts-append=ytdl_hook-all_formats=no", args)
        self.assertIn(
            "--ytdl-format=bv[height<=1080]+ba[language=pl-PL]/bv[height<=1080]+ba[language^=pl]/b[height<=1080][language=pl-PL]/b[height<=1080][language^=pl]/bv[height<=1080]+ba/b[height<=1080]",
            args,
        )
        self.assertIn("--ytdl-raw-options-append=ignore-config=", args)
        self.assertIn("--ytdl-raw-options-append=no-cookies=", args)
        self.assertEqual(args[-1], page_url)

        command = host.build_loadfile_command(
            stream,
            "replace",
            yt_dlp_path=resolver_path,
        )
        self.assertEqual(command[4]["ytdl"], "yes")
        self.assertIn("language^=pl", command[4]["ytdl-format"])
        self.assertIn("ytdl_hook-use_manifests=no", command[4]["script-opts"])
        self.assertIn("no-cookies=", command[4]["ytdl-raw-options"])

        with self.assertRaises(host.HostError) as caught:
            host.build_mpv_args(
                "/usr/bin/mpv",
                stream,
                ipc_path=Path("/run/user/1000/mpv-redirector/missing.sock"),
                idle=False,
            )
        self.assertEqual(caught.exception.code, "RESOLVER_UNAVAILABLE")

    def test_language_cannot_inject_mpv_options(self) -> None:
        for language in (
            "pl,--audio-file=/tmp/evil",
            "pl\n--script=/tmp/evil",
            "../pl",
            "en_US",
        ):
            with self.subTest(language=language):
                with self.assertRaises(host.HostError) as caught:
                    host.validate_stream({"url": VALID_STREAM["url"], "language": language})
                self.assertEqual(caught.exception.code, "INVALID_REQUEST")

        forged = host.StreamSpec(url=VALID_STREAM["url"], language="pl,--profile=evil")
        with self.assertRaises(host.HostError):
            host.build_mpv_args(
                "/usr/bin/mpv",
                forged,
                ipc_path=Path("/run/user/1000/mpv-redirector/forged.sock"),
                idle=False,
            )

    def test_spawn_never_uses_shell_or_captures_output(self) -> None:
        fake_process = object()
        with mock.patch.object(host.subprocess, "Popen", return_value=fake_process) as popen:
            result = host.spawn_mpv(["/usr/bin/mpv", "--", VALID_STREAM["url"]])
        self.assertIs(result, fake_process)
        positional, kwargs = popen.call_args
        self.assertEqual(positional[0][0], "/usr/bin/mpv")
        self.assertIs(kwargs["stdin"], host.subprocess.DEVNULL)
        self.assertIs(kwargs["stdout"], host.subprocess.DEVNULL)
        self.assertIs(kwargs["stderr"], host.subprocess.DEVNULL)
        self.assertFalse(kwargs["shell"])
        self.assertTrue(kwargs["close_fds"])
        self.assertEqual(kwargs["umask"], 0o077)

    def test_early_process_exit_is_not_success(self) -> None:
        process = ExitedProcess(17)
        with mock.patch.object(host, "spawn_mpv", return_value=process):
            with self.assertRaises(host.HostError) as caught:
                host._run_spawned_play(
                    "/usr/bin/mpv",
                    self.stream,
                    Path("/run/user/1000/mpv-redirector/test.sock"),
                    idle=False,
                    deadline=time.monotonic() + 0.2,
                )
        self.assertEqual(caught.exception.code, "MPV_EXITED_EARLY")
        self.assertEqual(caught.exception.exit_code, 17)

    def test_exit_code_two_before_ipc_is_a_load_failure(self) -> None:
        process = ExitedProcess(2)
        with mock.patch.object(host, "spawn_mpv", return_value=process):
            with self.assertRaises(host.HostError) as caught:
                host._run_spawned_play(
                    "/usr/bin/mpv",
                    self.stream,
                    Path("/run/user/1000/mpv-redirector/test.sock"),
                    idle=False,
                    deadline=time.monotonic() + 0.2,
                )
        self.assertEqual(caught.exception.code, "MPV_LOAD_FAILED")
        self.assertEqual(caught.exception.exit_code, 2)


class ResolverCookieJarTests(unittest.TestCase):
    def test_netscape_cookie_jar_uses_host_only_and_http_only_columns(self) -> None:
        domain_cookie = host.ResolverCookie(
            name="session",
            value="secret",
            domain="tvp.pl",
            path="/watch",
            secure=True,
            http_only=True,
            host_only=False,
            expires=0,
        )
        host_cookie = host.ResolverCookie(
            name="preference",
            value="value",
            domain="sport.tvp.pl",
            path="/",
            secure=False,
            http_only=False,
            host_only=True,
            expires=2_000_000_000,
        )
        encoded = host.encode_netscape_cookie_jar((domain_cookie, host_cookie))
        text = encoded.decode("utf-8")
        self.assertIn(
            "#HttpOnly_.tvp.pl\tTRUE\t/watch\tTRUE\t0\tsession\tsecret",
            text,
        )
        self.assertIn(
            "sport.tvp.pl\tFALSE\t/\tFALSE\t2000000000\tpreference\tvalue",
            text,
        )

    def test_private_cookie_jar_is_0600_unique_and_always_removed(self) -> None:
        request = host.validate_request(valid_resolve_payload())
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary)
            os.chmod(runtime_root, 0o700)
            paths: list[Path] = []
            with mock.patch.dict(
                os.environ,
                {"XDG_RUNTIME_DIR": os.fspath(runtime_root)},
            ):
                for should_raise in (False, True):
                    try:
                        with host.temporary_cookie_jar(request.cookies) as path:
                            self.assertIsNotNone(path)
                            assert path is not None
                            paths.append(path)
                            self.assertTrue(path.exists())
                            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                            if should_raise:
                                raise RuntimeError("test cleanup")
                    except RuntimeError:
                        pass
                    self.assertFalse(paths[-1].exists())
            self.assertEqual(len(set(paths)), 2)

    def test_resolver_arguments_use_only_explicit_cookie_jar(self) -> None:
        jar = Path("/run/user/1000/mpv-redirector/cookies.txt")
        page_url = "https://sport.tvp.pl/watch/video"
        streamlink = host.build_resolver_args(
            "streamlink",
            "/usr/bin/streamlink",
            page_url,
            jar,
        )
        yt_dlp = host.build_resolver_args(
            "yt-dlp",
            "/usr/bin/yt-dlp",
            page_url,
            jar,
        )
        self.assertEqual(
            streamlink,
            [
                "/usr/bin/streamlink",
                "--no-config",
                "--no-plugin-sideloading",
                "--no-plugin-cache",
                "--http-ignore-env",
                "--webbrowser=no",
                "--http-timeout",
                "5",
                "--retry-streams",
                "0",
                "--retry-max",
                "0",
                "--loglevel",
                "none",
                "--json",
                "--http-cookies-file",
                os.fspath(jar),
                "--url",
                page_url,
            ],
        )
        self.assertEqual(
            yt_dlp,
            [
                "/usr/bin/yt-dlp",
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-remote-components",
                "--no-update",
                "--no-cache-dir",
                "--no-cookies-from-browser",
                "--cookies",
                os.fspath(jar),
                "--no-playlist",
                "--playlist-items",
                "1",
                "--no-wait-for-video",
                "--no-mark-watched",
                "--socket-timeout",
                "5",
                "--extractor-retries",
                "1",
                "--retries",
                "0",
                "--fragment-retries",
                "0",
                "--file-access-retries",
                "0",
                "--skip-download",
                "--no-warnings",
                "--dump-single-json",
                "--",
                page_url,
            ],
        )
        self.assertNotIn("--cookies-from-browser", yt_dlp)

        without_cookies = host.build_resolver_args(
            "yt-dlp",
            "/usr/bin/yt-dlp",
            page_url,
            None,
        )
        self.assertIn("--no-cookies", without_cookies)
        self.assertNotIn("--cookies", without_cookies)


class ResolverProcessTests(unittest.TestCase):
    def test_runner_has_sanitized_environment_and_bounded_output(self) -> None:
        script = (
            "import json,os,stat;"
            "print(json.dumps({'pythonpath':os.getenv('PYTHONPATH'),"
            "'secret':os.getenv('RESOLVER_TEST_SECRET'),"
            "'proxy':os.getenv('HTTPS_PROXY'),"
            "'netrc':os.getenv('NETRC'),"
            "'preload':os.getenv('LD_PRELOAD'),"
            "'runtime':os.getenv('XDG_RUNTIME_DIR'),"
            "'home':os.getenv('HOME'),"
            "'config':os.getenv('XDG_CONFIG_HOME'),"
            "'cache':os.getenv('XDG_CACHE_HOME'),"
            "'data':os.getenv('XDG_DATA_HOME'),"
            "'cwd':os.getcwd(),"
            "'mode':stat.S_IMODE(os.stat(os.getcwd()).st_mode),"
            "'lang':os.getenv('LC_ALL')}))"
        )
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary)
            os.chmod(runtime_root, 0o700)
            with mock.patch.dict(
                os.environ,
                {
                    "XDG_RUNTIME_DIR": os.fspath(runtime_root),
                    "PYTHONPATH": "/unsafe",
                    "RESOLVER_TEST_SECRET": "do-not-pass",
                    "HTTPS_PROXY": "http://proxy.invalid",
                    "NETRC": "/unsafe/netrc",
                    "LD_PRELOAD": "/unsafe/preload.so",
                },
            ):
                result = host.run_bounded_process(
                    [os.path.abspath(sys.executable), "-c", script],
                    timeout=2.0,
                    stdout_limit=4096,
                    stderr_limit=4096,
                )
        environment = json.loads(result.stdout)
        self.assertEqual(result.return_code, 0)
        self.assertIsNone(environment["pythonpath"])
        self.assertIsNone(environment["secret"])
        self.assertIsNone(environment["proxy"])
        self.assertIsNone(environment["netrc"])
        self.assertIsNone(environment["preload"])
        self.assertIsNone(environment["runtime"])
        self.assertEqual(environment["lang"], "C.UTF-8")
        self.assertEqual(environment["mode"], 0o700)
        private_paths = {
            environment["home"],
            environment["config"],
            environment["cache"],
            environment["data"],
            environment["cwd"],
        }
        self.assertEqual(len(private_paths), 1)
        workspace = Path(private_paths.pop())
        self.assertFalse(workspace.exists())

    def test_global_resolver_lock_is_private_and_nonblocking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lock_path = Path(temporary) / host.RESOLVER_LOCK_NAME
            with host.exclusive_resolver_lock(lock_path):
                self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o600)
                with self.assertRaises(host.HostError) as busy:
                    with host.exclusive_resolver_lock(lock_path):
                        self.fail("the second resolver lock unexpectedly succeeded")
            self.assertEqual(busy.exception.code, "RESOLVER_BUSY")

    def test_runner_terminates_on_stdout_overflow_and_timeout(self) -> None:
        with self.assertRaises(host.HostError) as overflow:
            host.run_bounded_process(
                [
                    os.path.abspath(sys.executable),
                    "-c",
                    "import sys;sys.stdout.buffer.write(b'x'*8192);sys.stdout.flush()",
                ],
                timeout=2.0,
                stdout_limit=128,
                stderr_limit=128,
            )
        self.assertEqual(overflow.exception.code, "RESOLVER_OUTPUT_TOO_LARGE")

        started = time.monotonic()
        with self.assertRaises(host.HostError) as timeout:
            host.run_bounded_process(
                [os.path.abspath(sys.executable), "-c", "import time;time.sleep(10)"],
                timeout=0.05,
                stdout_limit=128,
                stderr_limit=128,
            )
        self.assertEqual(timeout.exception.code, "RESOLVER_TIMEOUT")
        self.assertLess(time.monotonic() - started, 1.5)

    def test_venv_resolver_precedes_path_and_versions_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fake_home = Path(temporary)
            preferred = (
                fake_home
                / ".local/share/mpv-redirector/resolvers/bin/streamlink"
            )
            preferred.parent.mkdir(parents=True)
            preferred.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            preferred.chmod(0o700)
            with (
                mock.patch.object(host.Path, "home", return_value=fake_home),
                mock.patch.object(host.shutil, "which", return_value="/usr/bin/streamlink"),
            ):
                self.assertEqual(host.find_resolver_path("streamlink"), os.fspath(preferred))

        with (
            mock.patch.object(host, "find_resolver_path", return_value="/mock/streamlink"),
            mock.patch.object(
                host,
                "run_bounded_process",
                return_value=host.ProcessResult(0, b"streamlink 8.3.0\n", b""),
            ),
        ):
            old = host.resolver_info("streamlink")
        self.assertTrue(old.installed)
        self.assertFalse(old.compatible)
        self.assertEqual(old.error_code, "RESOLVER_TOO_OLD")

        with (
            mock.patch.object(host, "find_resolver_path", return_value="/mock/yt-dlp"),
            mock.patch.object(
                host,
                "run_bounded_process",
                return_value=host.ProcessResult(0, b"2026.06.09\n", b""),
            ),
        ):
            current = host.resolver_info("yt-dlp")
        self.assertTrue(current.compatible)
        self.assertEqual(current.version, "2026.06.09")


class ResolverParserTests(unittest.TestCase):
    def test_streamlink_parser_deduplicates_aliases_and_strips_sensitive_headers(self) -> None:
        payload = {
            "plugin": "tvp",
            "metadata": {"title": "TVP Sport"},
            "streams": {
                "720p": {
                    "type": "hls",
                    "url": "https://cdn.tvp.pl/live/720p.m3u8",
                    "master": "https://cdn.tvp.pl/live/master.m3u8",
                    "headers": {
                        "Referer": "https://sport.tvp.pl/watch/video",
                        "User-Agent": "Resolver Test",
                        "Cookie": "session=must-not-return",
                        "Authorization": "Bearer must-not-return",
                    },
                },
                "best": {
                    "type": "hls",
                    "url": "https://cdn.tvp.pl/live/720p.m3u8",
                    "master": "https://cdn.tvp.pl/live/master.m3u8",
                },
            },
        }
        parsed = host.parse_streamlink_output(json.dumps(payload).encode())
        self.assertEqual(len(parsed.candidates), 2)
        self.assertEqual(parsed.candidates[0]["role"], "master")
        self.assertEqual(parsed.candidates[0]["quality"], "Auto")
        self.assertEqual(parsed.candidates[1]["quality"], "720p")
        serialized = json.dumps(parsed.candidates)
        self.assertNotIn("must-not-return", serialized)
        self.assertNotIn("Cookie", serialized)
        self.assertEqual(parsed.candidates[1]["referer"], "https://sport.tvp.pl/watch/video")

    def test_streamlink_duplicate_dash_qualities_become_one_adaptive_master(self) -> None:
        payload = {
            "plugin": "tvp",
            "metadata": {"title": "Skrót meczu"},
            "streams": {
                "224p": {
                    "type": "dash",
                    "url": "https://cdn.tvp.pl/vod/video.mpd?token=fresh",
                },
                "720p": {
                    "type": "dash",
                    "url": "https://cdn.tvp.pl/vod/video.mpd?token=fresh",
                },
                "1080p": {
                    "type": "dash",
                    "url": "https://cdn.tvp.pl/vod/video.mpd?token=fresh",
                },
            },
        }
        parsed = host.parse_streamlink_output(json.dumps(payload).encode())
        self.assertEqual(len(parsed.candidates), 1)
        self.assertEqual(parsed.candidates[0]["role"], "master")
        self.assertEqual(parsed.candidates[0]["quality"], "Auto")

    def test_yt_dlp_parser_keeps_complete_av_and_skips_drm_and_audio_fanout(self) -> None:
        payload = {
            "title": "Mecz",
            "is_live": False,
            "http_headers": {
                "Referer": "https://sport.tvp.pl/watch/video",
                "Cookie": "secret=must-not-return",
            },
            "formats": [
                {
                    "format_id": "hls-720",
                    "format_note": "720p",
                    "protocol": "m3u8_native",
                    "ext": "mp4",
                    "manifest_url": "https://cdn.tvp.pl/live/master.m3u8",
                    "url": "https://cdn.tvp.pl/live/720p.m3u8",
                    "width": 1280,
                    "height": 720,
                    "vcodec": "h264",
                    "acodec": "aac",
                },
                {
                    "format_id": "audio",
                    "protocol": "https",
                    "ext": "m4a",
                    "url": "https://cdn.tvp.pl/live/audio.m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                },
                {
                    "format_id": "drm",
                    "protocol": "https",
                    "ext": "mp4",
                    "url": "https://cdn.tvp.pl/live/drm.mp4",
                    "has_drm": True,
                },
            ],
        }
        parsed = host.parse_yt_dlp_output(json.dumps(payload).encode())
        self.assertEqual([item["role"] for item in parsed.candidates], ["master", "variant"])
        self.assertEqual(
            [item["mediaKind"] for item in parsed.candidates],
            ["adaptive", "muxed"],
        )
        self.assertTrue(parsed.candidates[0]["hasAudio"])
        self.assertTrue(parsed.candidates[0]["hasVideo"])
        self.assertEqual(parsed.candidates[1]["height"], 720)
        serialized = json.dumps(parsed.candidates)
        self.assertNotIn("drm.mp4", serialized)
        self.assertNotIn("must-not-return", serialized)

    def test_yt_dlp_multilingual_audio_before_video_becomes_one_preferred_master(self) -> None:
        manifest_url = "https://cdn.example.test/watch/master.m3u8"
        dubbed_audio = [
            {
                "format_id": f"dub-{index}",
                "format_note": "Dubbed",
                "protocol": "m3u8_native",
                "ext": "mp4",
                "manifest_url": manifest_url,
                "url": f"https://cdn.example.test/watch/dub-{index}.m4a",
                "vcodec": "none",
                "language": "es",
            }
            for index in range(22)
        ]
        dubbed_audio.append(
            {
                "format_id": "polish-audio",
                "format_note": "Dubbed, Default",
                "protocol": "m3u8_native",
                "ext": "mp4",
                "manifest_url": manifest_url,
                "url": "https://cdn.example.test/watch/pl.m4a",
                "vcodec": "none",
                "language": "pl",
            }
        )
        payload = {
            "title": "Wielojęzyczny materiał",
            "formats": [
                *dubbed_audio,
                {
                    "format_id": "video-1080",
                    "protocol": "m3u8_native",
                    "ext": "mp4",
                    "manifest_url": manifest_url,
                    "url": "https://cdn.example.test/watch/video-1080.m3u8",
                    "width": 1920,
                    "height": 1080,
                    "vcodec": "avc1",
                    "acodec": "none",
                },
            ],
        }
        parsed = host.parse_yt_dlp_output(
            json.dumps(payload).encode(),
            preferred_languages=("pl-PL", "en"),
        )
        self.assertFalse(parsed.truncated)
        self.assertEqual(len(parsed.candidates), 1)
        master = parsed.candidates[0]
        self.assertEqual(master["role"], "master")
        self.assertEqual(master["mediaKind"], "adaptive")
        self.assertTrue(master["hasAudio"])
        self.assertTrue(master["hasVideo"])
        self.assertEqual(master["language"], "pl-PL")

    def test_yt_dlp_language_aliases_preserve_browser_preference_order(self) -> None:
        payload = {
            "formats": [
                {
                    "format_id": "pl-muxed",
                    "url": "https://cdn.example.test/pl.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1",
                    "acodec": "aac",
                    "language": "pl",
                    "height": 720,
                },
                {
                    "format_id": "en-muxed",
                    "url": "https://cdn.example.test/en.mp4",
                    "ext": "mp4",
                    "vcodec": "avc1",
                    "acodec": "aac",
                    "language": "en-US",
                    "height": 720,
                },
            ]
        }
        parsed = host.parse_yt_dlp_output(
            json.dumps(payload).encode(),
            preferred_languages=("pl-PL", "pl", "en-US", "en"),
        )
        self.assertEqual(parsed.candidates[0]["language"], "pl")
        self.assertEqual(parsed.candidates[0]["formatId"], "pl-muxed")
        self.assertNotIn("audio-only", json.dumps(parsed.candidates))

    def test_yt_dlp_audio_only_manifest_never_claims_master_or_video(self) -> None:
        payload = {
            "title": "Podcast",
            "formats": [
                {
                    "format_id": "audio-pl",
                    "format_note": "Default",
                    "protocol": "m3u8_native",
                    "ext": "m4a",
                    "manifest_url": "https://cdn.example.test/podcast/audio.m3u8",
                    "url": "https://cdn.example.test/podcast/audio.m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                    "language": "pl",
                }
            ],
        }
        parsed = host.parse_yt_dlp_output(json.dumps(payload).encode())
        self.assertEqual(len(parsed.candidates), 2)
        self.assertTrue(all(item["role"] == "audio" for item in parsed.candidates))
        self.assertTrue(all(item["mediaKind"] == "audio-only" for item in parsed.candidates))
        self.assertTrue(all(item["hasAudio"] for item in parsed.candidates))
        self.assertTrue(all(not item["hasVideo"] for item in parsed.candidates))
        self.assertTrue(all(item["language"] == "pl" for item in parsed.candidates))

    def test_yt_dlp_ranks_all_formats_before_candidate_limit(self) -> None:
        low_formats = [
            {
                "format_id": f"low-{index}",
                "protocol": "https",
                "ext": "mp4",
                "url": f"https://cdn.example.test/movie/low-{index}.mp4",
                "width": 256,
                "height": 144,
                "vcodec": "avc1",
                "acodec": "aac",
            }
            for index in range(100)
        ]
        payload = {
            "title": "Long format list",
            "formats": [
                *low_formats,
                {
                    "format_id": "best-1080",
                    "format_note": "1080p",
                    "protocol": "https",
                    "ext": "mp4",
                    "url": "https://cdn.example.test/movie/best-1080.mp4",
                    "width": 1920,
                    "height": 1080,
                    "vcodec": "avc1",
                    "acodec": "aac",
                },
            ],
        }
        parsed = host.parse_yt_dlp_output(json.dumps(payload).encode())
        self.assertTrue(parsed.truncated)
        self.assertEqual(len(parsed.candidates), host.MAX_RESOLVER_CANDIDATES)
        self.assertEqual(parsed.candidates[0]["formatId"], "best-1080")
        self.assertEqual(parsed.candidates[0]["height"], 1080)
        self.assertTrue(all(item["mediaKind"] == "muxed" for item in parsed.candidates))

    def test_yt_dlp_video_only_and_root_audio_are_classified_without_fabricated_tracks(self) -> None:
        video = host.parse_yt_dlp_output(
            json.dumps(
                {
                    "formats": [
                        {
                            "format_id": "video-only",
                            "protocol": "https",
                            "ext": "mp4",
                            "url": "https://cdn.example.test/video-only.mp4",
                            "height": 720,
                            "vcodec": "avc1",
                            "acodec": "none",
                        }
                    ]
                }
            ).encode()
        )
        self.assertEqual(video.candidates[0]["mediaKind"], "video-only")
        self.assertFalse(video.candidates[0]["hasAudio"])
        self.assertTrue(video.candidates[0]["hasVideo"])

        audio = host.parse_yt_dlp_output(
            json.dumps(
                {
                    "title": "Root audio",
                    "url": "https://cdn.example.test/root-audio.m4a",
                    "protocol": "https",
                    "ext": "m4a",
                    "format_id": "root-audio",
                    "vcodec": "none",
                    "acodec": "aac",
                    "language": "en",
                }
            ).encode()
        )
        self.assertEqual(len(audio.candidates), 1)
        self.assertEqual(audio.candidates[0]["role"], "audio")
        self.assertEqual(audio.candidates[0]["mediaKind"], "audio-only")
        self.assertFalse(audio.candidates[0]["hasVideo"])

    def test_yt_dlp_missing_codecs_or_mhtml_do_not_create_adaptive_master(self) -> None:
        payload = {
            "formats": [
                {
                    "format_id": "unknown-video",
                    "protocol": "https",
                    "ext": "mp4",
                    "manifest_url": "https://cdn.example.test/unknown/master.m3u8",
                    "url": "https://cdn.example.test/unknown/video.mp4",
                    "height": 720,
                },
                {
                    "format_id": "storyboard",
                    "protocol": "mhtml",
                    "ext": "mhtml",
                    "manifest_url": "https://cdn.example.test/fake/master.m3u8",
                    "url": "https://cdn.example.test/storyboard.mhtml",
                },
            ],
        }
        parsed = host.parse_yt_dlp_output(json.dumps(payload).encode())
        self.assertTrue(parsed.candidates)
        self.assertTrue(all(item["role"] != "master" for item in parsed.candidates))
        self.assertTrue(all(item["mediaKind"] == "video-only" for item in parsed.candidates))
        self.assertNotIn("fake", json.dumps(parsed.candidates))

    def test_yt_dlp_invalid_complete_urls_do_not_suppress_valid_fallbacks(self) -> None:
        invalid_muxed = {
            "formats": [
                {
                    "format_id": "audio",
                    "protocol": "https",
                    "ext": "m4a",
                    "url": "https://cdn.example.test/fallback.m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                },
                {
                    "format_id": "invalid-muxed",
                    "protocol": "https",
                    "ext": "mp4",
                    "url": "file:///tmp/not-allowed.mp4",
                    "vcodec": "avc1",
                    "acodec": "aac",
                },
            ]
        }
        parsed = host.parse_yt_dlp_output(json.dumps(invalid_muxed).encode())
        self.assertEqual(len(parsed.candidates), 1)
        self.assertEqual(parsed.candidates[0]["mediaKind"], "audio-only")

        invalid_manifest = {
            "formats": [
                {
                    "format_id": "audio",
                    "protocol": "https",
                    "ext": "m4a",
                    "manifest_url": "file:///tmp/not-allowed.m3u8",
                    "url": "https://cdn.example.test/audio.m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                },
                {
                    "format_id": "video",
                    "protocol": "https",
                    "ext": "mp4",
                    "manifest_url": "file:///tmp/not-allowed.m3u8",
                    "url": "https://cdn.example.test/video.mp4",
                    "vcodec": "avc1",
                    "acodec": "none",
                },
            ]
        }
        parsed = host.parse_yt_dlp_output(json.dumps(invalid_manifest).encode())
        self.assertEqual(
            {item["mediaKind"] for item in parsed.candidates},
            {"audio-only", "video-only"},
        )

    def test_yt_dlp_audio_evidence_does_not_fabricate_webm_video(self) -> None:
        payload = {
            "formats": [
                {
                    "format_id": "audio-webm",
                    "protocol": "https",
                    "ext": "webm",
                    "url": "https://cdn.example.test/audio.webm",
                    "audio_channels": 2,
                }
            ]
        }
        parsed = host.parse_yt_dlp_output(json.dumps(payload).encode())
        self.assertEqual(parsed.candidates[0]["mediaKind"], "audio-only")
        self.assertFalse(parsed.candidates[0]["hasVideo"])

    def test_yt_dlp_does_not_claim_unobserved_manifest_language(self) -> None:
        manifest_url = "https://cdn.example.test/untagged/master.m3u8"
        payload = {
            "formats": [
                {
                    "format_id": "audio",
                    "protocol": "m3u8_native",
                    "ext": "m4a",
                    "manifest_url": manifest_url,
                    "url": "https://cdn.example.test/untagged/audio.m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                },
                {
                    "format_id": "video",
                    "protocol": "m3u8_native",
                    "ext": "mp4",
                    "manifest_url": manifest_url,
                    "url": "https://cdn.example.test/untagged/video.m3u8",
                    "vcodec": "avc1",
                    "acodec": "none",
                },
            ]
        }
        parsed = host.parse_yt_dlp_output(
            json.dumps(payload).encode(),
            preferred_languages=("fr-FR",),
        )
        self.assertEqual(len(parsed.candidates), 1)
        self.assertEqual(parsed.candidates[0]["mediaKind"], "adaptive")
        self.assertNotIn("language", parsed.candidates[0])

    def test_resolver_json_rejects_duplicates_nonfinite_and_wrong_shapes(self) -> None:
        invalid = [
            b'{"streams":{},"streams":{}}',
            b'{"streams":{"x":{"url":NaN}}}',
            b'[]',
            b'{"streams":[]}',
            b'\xff',
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(host.HostError) as caught:
                    host.parse_streamlink_output(payload)
                self.assertEqual(caught.exception.code, "RESOLVER_INVALID_OUTPUT")

    def test_parser_candidate_limit_sets_truncated(self) -> None:
        payload = {
            "streams": {
                f"{index}p": {
                    "type": "hls",
                    "url": f"https://cdn.example.test/live/{index}.m3u8",
                }
                for index in range(host.MAX_RESOLVER_CANDIDATES + 5)
            }
        }
        parsed = host.parse_streamlink_output(json.dumps(payload).encode())
        self.assertEqual(len(parsed.candidates), host.MAX_RESOLVER_CANDIDATES)
        self.assertTrue(parsed.truncated)


class ResolverFlowTests(unittest.TestCase):
    @staticmethod
    def _info(name: str) -> host.ResolverInfo:
        return host.ResolverInfo(
            name=name,
            path=f"/mock/{name}",
            version="8.4.0" if name == "streamlink" else "2026.06.09",
            installed=True,
            compatible=True,
        )

    def test_streamlink_empty_falls_back_to_yt_dlp(self) -> None:
        request = host.validate_request(valid_resolve_payload(cookies=[]))
        yt_payload = {
            "title": "Fallback",
            "formats": [
                {
                    "format_id": "http",
                    "protocol": "https",
                    "ext": "mp4",
                    "url": "https://cdn.example.test/movie.mp4",
                    "vcodec": "h264",
                    "acodec": "aac",
                }
            ],
        }

        def fake_run(args: list[str], **_kwargs: object) -> host.ProcessResult:
            if args[0].endswith("streamlink"):
                return host.ProcessResult(0, b'{"streams":{}}', b"")
            return host.ProcessResult(0, json.dumps(yt_payload).encode(), b"")

        with (
            mock.patch.object(host, "resolver_info", side_effect=lambda name: self._info(name)),
            mock.patch.object(host, "run_bounded_process", side_effect=fake_run),
        ):
            response = host.handle_resolve(request)
        self.assertTrue(response["ok"])
        self.assertEqual(response["status"], "found")
        self.assertEqual(response["resolver"], "yt-dlp")
        self.assertEqual(
            [attempt["status"] for attempt in response["attempted"]],
            ["empty", "found"],
        )
        self.assertEqual(response["candidates"][0]["resolver"], "yt-dlp")

    def test_page_ready_resolve_forwards_preferred_language_to_yt_dlp_parser(self) -> None:
        request = host.validate_request(
            valid_resolve_payload(
                source="page_ready",
                cookies=[],
                resolverOrder=["yt-dlp"],
                preferredLanguages=["pl-PL"],
            )
        )
        manifest_url = "https://cdn.example.test/multilingual/master.m3u8"
        payload = {
            "formats": [
                {
                    "format_id": "pl-audio",
                    "protocol": "m3u8_native",
                    "ext": "m4a",
                    "manifest_url": manifest_url,
                    "url": "https://cdn.example.test/multilingual/pl.m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                    "language": "pl",
                },
                {
                    "format_id": "video",
                    "protocol": "m3u8_native",
                    "ext": "mp4",
                    "manifest_url": manifest_url,
                    "url": "https://cdn.example.test/multilingual/video.m3u8",
                    "vcodec": "avc1",
                    "acodec": "none",
                    "height": 720,
                },
            ]
        }
        with (
            mock.patch.object(host, "resolver_info", return_value=self._info("yt-dlp")),
            mock.patch.object(
                host,
                "run_bounded_process",
                return_value=host.ProcessResult(0, json.dumps(payload).encode(), b""),
            ),
        ):
            response = host.handle_resolve(request)
        self.assertEqual(response["status"], "found")
        self.assertEqual(response["candidates"][0]["language"], "pl-PL")
        self.assertEqual(response["candidates"][0]["mediaKind"], "adaptive")

    def test_youtube_resolve_prepends_fresh_ytdl_page_recipe(self) -> None:
        page_url = "https://www.youtube.com/watch?v=YE7VzlLtp-4"
        request = host.validate_request(
            valid_resolve_payload(
                source="page_ready",
                pageUrl=page_url,
                adapter="youtube",
                resolverOrder=["yt-dlp"],
                cookies=[],
                preferredLanguages=["pl-PL", "en-US"],
            )
        )
        payload = {
            "title": "Wielojęzyczny materiał",
            "formats": [
                {
                    "format_id": "audio-pl",
                    "protocol": "https",
                    "ext": "webm",
                    "manifest_url": "https://cdn.example.test/master.m3u8",
                    "url": "https://cdn.example.test/audio-pl.webm",
                    "vcodec": "none",
                    "acodec": "opus",
                    "language": "pl",
                },
                {
                    "format_id": "video-1080",
                    "protocol": "m3u8_native",
                    "ext": "mp4",
                    "manifest_url": "https://cdn.example.test/master.m3u8",
                    "url": "https://cdn.example.test/video-1080.m3u8",
                    "vcodec": "vp9",
                    "acodec": "none",
                    "height": 1080,
                },
            ],
        }
        with (
            mock.patch.object(host, "resolver_info", return_value=self._info("yt-dlp")),
            mock.patch.object(
                host,
                "run_bounded_process",
                return_value=host.ProcessResult(0, json.dumps(payload).encode(), b""),
            ),
        ):
            response = host.handle_resolve(request)

        self.assertEqual(response["status"], "found")
        self.assertEqual(len(response["candidates"]), 2)
        page = response["candidates"][0]
        self.assertEqual(page["url"], page_url)
        self.assertEqual(page["playbackKind"], "yt-dlp-page")
        self.assertEqual(page["formatId"], "yt-dlp-page")
        self.assertEqual(page["language"], "pl-PL")
        self.assertEqual(page["mediaKind"], "adaptive")
        self.assertTrue(page["hasAudio"])
        self.assertTrue(page["hasVideo"])
        self.assertNotIn("playbackKind", response["candidates"][1])

    def test_timeout_is_reported_without_raw_process_output(self) -> None:
        request = host.validate_request(
            valid_resolve_payload(cookies=[], resolverOrder=["streamlink"])
        )
        with (
            mock.patch.object(host, "resolver_info", return_value=self._info("streamlink")),
            mock.patch.object(
                host,
                "run_bounded_process",
                side_effect=host.HostError("RESOLVER_TIMEOUT"),
            ),
        ):
            response = host.handle_resolve(request)
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["attempted"][0]["status"], "timeout")
        self.assertEqual(
            response["attempted"][0]["errorCode"],
            "RESOLVER_TIMEOUT",
        )
        self.assertNotIn("stderr", json.dumps(response).lower())

    def test_dispatch_log_never_receives_cookie_or_page_url(self) -> None:
        request = host.validate_request(valid_resolve_payload())
        logger = mock.Mock()
        resolved = {
            **host.base_response(request),
            "ok": True,
            "status": "empty",
            "resolver": None,
            "attempted": [],
            "candidates": [],
            "truncated": False,
        }
        with mock.patch.object(host, "handle_resolve", return_value=resolved):
            response = host.dispatch(request, logger)
        self.assertTrue(response["ok"])
        logged = repr(logger.mock_calls)
        self.assertNotIn("cookie-secret", logged)
        self.assertNotIn("sport.tvp.pl/watch", logged)

    def test_cookie_jar_is_separate_per_attempt_deleted_and_never_echoed(self) -> None:
        request = host.validate_request(valid_resolve_payload())
        observed_paths: list[Path] = []

        def fake_run(args: list[str], **_kwargs: object) -> host.ProcessResult:
            option = "--http-cookies-file" if args[0].endswith("streamlink") else "--cookies"
            path = Path(args[args.index(option) + 1])
            observed_paths.append(path)
            self.assertTrue(path.exists())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertIn("cookie-secret", path.read_text(encoding="utf-8"))
            if args[0].endswith("streamlink"):
                return host.ProcessResult(0, b'{"streams":{}}', b"")
            return host.ProcessResult(
                0,
                json.dumps(
                    {
                        "formats": [
                            {
                                "url": "https://cdn.example.test/video.mp4",
                                "protocol": "https",
                                "ext": "mp4",
                            }
                        ]
                    }
                ).encode(),
                b"",
            )

        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary)
            os.chmod(runtime_root, 0o700)
            with (
                mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": os.fspath(runtime_root)}),
                mock.patch.object(host, "resolver_info", side_effect=lambda name: self._info(name)),
                mock.patch.object(host, "run_bounded_process", side_effect=fake_run),
            ):
                response = host.handle_resolve(request)

        self.assertEqual(len(observed_paths), 2)
        self.assertNotEqual(observed_paths[0], observed_paths[1])
        self.assertTrue(all(not path.exists() for path in observed_paths))
        serialized = json.dumps(response)
        self.assertNotIn("cookie-secret", serialized)
        self.assertNotIn("cookies", serialized.lower())

    def test_response_candidates_are_trimmed_below_native_message_limit(self) -> None:
        request = host.validate_request(valid_resolve_payload(cookies=[], resolverOrder=["streamlink"]))
        candidates = tuple(
            {
                "resolver": "streamlink",
                "url": f"https://cdn.example.test/{index}/" + ("x" * 20_000),
                "type": "MEDIA",
                "role": "direct",
            }
            for index in range(4)
        )
        with (
            mock.patch.object(host, "resolver_info", return_value=self._info("streamlink")),
            mock.patch.object(
                host,
                "run_bounded_process",
                return_value=host.ProcessResult(0, b"{}", b""),
            ),
            mock.patch.object(
                host,
                "parse_resolver_output",
                return_value=host.ResolverParseResult(candidates),
            ),
        ):
            response = host.handle_resolve(request)
        self.assertTrue(response["truncated"])
        self.assertGreater(len(response["candidates"]), 0)
        self.assertLessEqual(host._encoded_response_size(response), host.RESOLVER_RESPONSE_BUDGET)
        output = io.BytesIO()
        host.write_native_message(output, response)


class IpcTests(unittest.TestCase):
    def test_matches_request_id_and_ignores_events_and_foreign_replies(self) -> None:
        chunk = (
            b'{"event":"start-file"}\n'
            b'{"request_id":88,"error":"success","data":"foreign"}\n'
            b'{"request_id":7,"error":"success","data":"wanted"}\n'
        )
        client = ChunkSocket([chunk])
        session = host.IpcSession(client)
        response = session.command(
            ["get_property", "path"],
            time.monotonic() + 1.0,
            request_id=7,
        )
        self.assertEqual(response["data"], "wanted")
        self.assertEqual(session.events[0]["event"], "start-file")
        sent = json.loads(bytes(client.sent).decode("utf-8"))
        self.assertEqual(sent["request_id"], 7)

    def test_handles_json_lines_split_across_reads(self) -> None:
        client = ChunkSocket(
            [
                b'{"request_id":9,',
                b'"error":"success","data":true}\n',
            ]
        )
        session = host.IpcSession(client)
        response = session.wait_for_response(9, time.monotonic() + 1.0)
        self.assertTrue(response["data"])

    def test_rejects_duplicate_keys_and_oversized_lines(self) -> None:
        duplicate = ChunkSocket(
            [b'{"request_id":1,"request_id":1,"error":"success"}\n']
        )
        with self.assertRaises(host.HostError) as duplicate_error:
            host.IpcSession(duplicate).receive(time.monotonic() + 1.0)
        self.assertEqual(duplicate_error.exception.code, "MPV_IPC_PROTOCOL")

        oversized = ChunkSocket([b"x" * (host.MAX_IPC_LINE_BYTES + 1)])
        with self.assertRaises(host.HostError) as oversized_error:
            host.IpcSession(oversized).receive(time.monotonic() + 1.0)
        self.assertEqual(oversized_error.exception.code, "MPV_IPC_PROTOCOL")

    def test_eof_is_a_transport_failure_not_a_success_response(self) -> None:
        session = host.IpcSession(ChunkSocket([]))
        with self.assertRaises(host.IpcTransportError):
            session.receive(time.monotonic() + 1.0)

    def test_spawned_ipc_eof_waits_for_delayed_process_exit(self) -> None:
        process = DelayedExitProcess(23, running_polls=3)
        session = host.IpcSession(ChunkSocket([]))
        with (
            mock.patch.object(host.secrets, "randbits", return_value=6),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=process,
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_EXITED_EARLY")
        self.assertEqual(caught.exception.exit_code, 23)

    def test_spawned_ipc_eof_maps_delayed_exit_two_to_load_failure(self) -> None:
        process = DelayedExitProcess(2, running_polls=3)
        session = host.IpcSession(ChunkSocket([]))
        with (
            mock.patch.object(host.secrets, "randbits", return_value=6),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=process,
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_LOAD_FAILED")
        self.assertEqual(caught.exception.exit_code, 2)

    def test_spawned_ipc_eof_stays_protocol_error_if_process_lives(self) -> None:
        session = host.IpcSession(ChunkSocket([]))
        with (
            mock.patch.object(host, "PROCESS_EXIT_GRACE_SECONDS", 0.0),
            mock.patch.object(host.secrets, "randbits", return_value=6),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_IPC_PROTOCOL")

    def test_existing_queue_replacement_requires_file_loaded(self) -> None:
        response = (
            json.dumps(
                {
                    "request_id": 7,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"event":"file-loaded"}\n'
            + json.dumps(
                {
                    "request_id": 9,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"request_id":10,"error":"property unavailable"}\n'
        )
        session = host.IpcSession(TimeoutChunkSocket([response]))
        with mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)):
            confirmation = host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=None,
                accept_file_loaded_event=True,
            )
        self.assertEqual(confirmation, "file-loaded")

    def test_existing_queue_replacement_rejects_path_only(self) -> None:
        response = json.dumps(
            {
                "request_id": 7,
                "error": "success",
                "data": VALID_STREAM["url"],
            }
        ).encode("utf-8") + b"\n"
        session = host.IpcSession(TimeoutChunkSocket([response]))
        with (
            mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 0.03,
                process=None,
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_DEMUXER_TIMEOUT")

    def test_spawned_confirmation_rejects_matching_path_without_demuxer(self) -> None:
        chunk = (
            json.dumps(
                {
                    "request_id": 7,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + json.dumps(
                {
                    "request_id": 8,
                    "error": "property unavailable",
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"event":"start-file"}\n'
        )
        session = host.IpcSession(TimeoutChunkSocket([chunk]))
        with (
            mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 0.03,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_DEMUXER_TIMEOUT")

    def test_confirmation_timeout_when_expected_path_never_matches(self) -> None:
        chunk = (
            b'{"request_id":7,"error":"success","data":"https://other.test/video.m3u8"}\n'
            b'{"request_id":8,"error":"success","data":"hls"}\n'
        )
        session = host.IpcSession(TimeoutChunkSocket([chunk]))
        with (
            mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 0.03,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_CONFIRM_TIMEOUT")

    def test_demuxer_evidence_may_finish_bounded_settle_after_primary_deadline(self) -> None:
        chunk = (
            json.dumps(
                {
                    "request_id": 7,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"request_id":8,"error":"success","data":"hls"}\n'
        )
        session = host.IpcSession(TimeoutChunkSocket([chunk]))
        started = time.monotonic()
        with mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)):
            confirmation = host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                started + 0.02,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        elapsed = time.monotonic() - started
        self.assertEqual(confirmation, "demuxer-property")
        self.assertGreaterEqual(elapsed, host.LOAD_CONFIRM_SETTLE_SECONDS)
        self.assertLess(elapsed, host.LOAD_CONFIRM_SETTLE_SECONDS + 0.08)

    def test_file_loaded_at_deadline_gets_one_bounded_correlation_probe(self) -> None:
        clock = ControlledMonotonicClock()
        primary_deadline = 0.1
        session = ScriptedIpcSession(
            clock,
            [(0.099, {"event": "file-loaded"})],
            post_event_replies=True,
            # Model scheduler overhead after the final pre-deadline event.
            jump_after_event=primary_deadline + 0.001,
        )

        with mock.patch.object(host.time, "monotonic", clock.monotonic):
            confirmation = host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                primary_deadline,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )

        self.assertEqual(confirmation, "file-loaded")
        post_deadline_requests = [
            request for request in session.sent if request[2] > primary_deadline
        ]
        self.assertEqual(
            [request[1] for request in post_deadline_requests],
            [
                ["get_property", "path"],
                ["get_property", "file-format"],
            ],
        )
        self.assertTrue(
            all(
                request[2]
                <= primary_deadline + host.LOAD_CONFIRM_SETTLE_SECONDS
                for request in post_deadline_requests
            )
        )
        self.assertLessEqual(
            clock.value,
            primary_deadline + host.LOAD_CONFIRM_SETTLE_SECONDS,
        )

    def test_correlated_probe_replies_may_straddle_primary_deadline(self) -> None:
        clock = ControlledMonotonicClock()
        primary_deadline = 0.1
        session = ScriptedIpcSession(
            clock,
            [
                (
                    primary_deadline - 0.001,
                    {
                        "request_id": 7,
                        "error": "success",
                        "data": VALID_STREAM["url"],
                    },
                ),
                (
                    primary_deadline + 0.001,
                    {
                        "request_id": 8,
                        "error": "success",
                        "data": "hls",
                    },
                ),
            ],
        )

        with mock.patch.object(host.time, "monotonic", clock.monotonic):
            confirmation = host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                primary_deadline,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )

        self.assertEqual(confirmation, "demuxer-property")
        self.assertLessEqual(
            clock.value,
            primary_deadline + host.LOAD_CONFIRM_SETTLE_SECONDS,
        )

    def test_final_boundary_poll_reports_early_exit(self) -> None:
        session = host.IpcSession(TimeoutChunkSocket([]))
        with self.assertRaises(host.HostError) as caught:
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() - 0.001,
                process=ExitedProcess(9),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_EXITED_EARLY")
        self.assertEqual(caught.exception.exit_code, 9)

    def test_queued_end_file_error_wins_over_simultaneous_exit_two(self) -> None:
        session = host.IpcSession(ChunkSocket([]))
        session.events.append(
            {"event": "end-file", "reason": "error", "error": -13}
        )
        with self.assertRaises(host.HostError) as caught:
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=ExitedProcess(2),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_LOAD_FAILED")
        self.assertIsNone(caught.exception.exit_code)
        self.assertEqual(caught.exception.mpv_error_category, "unknown")

    def test_end_file_error_maps_only_allowlisted_file_error_categories(
        self,
    ) -> None:
        cases = (
            ("loading failed", "load"),
            ("no audio or video data played", "media"),
            ("unrecognized file format", "format"),
            ("not supported", "unsupported"),
            ("operation not implemented", "unsupported"),
            ("something happened", "unknown"),
            (
                "HTTP 403 https://secret.example.test/live.m3u8?token=do-not-log",
                "unknown",
            ),
            (None, "unknown"),
        )
        for file_error, expected_category in cases:
            with self.subTest(file_error=file_error):
                session = host.IpcSession(ChunkSocket([]))
                session.events.append(
                    {
                        "event": "end-file",
                        "reason": "error",
                        "file_error": file_error,
                    }
                )
                with self.assertRaises(host.HostError) as caught:
                    host.confirm_loaded(
                        session,
                        VALID_STREAM["url"],
                        time.monotonic() + 1.0,
                        process=RunningProcess(),
                        accept_file_loaded_event=True,
                    )
                self.assertEqual(caught.exception.code, "MPV_LOAD_FAILED")
                self.assertEqual(
                    caught.exception.mpv_error_category,
                    expected_category,
                )
                self.assertNotIn("secret.example.test", repr(vars(caught.exception)))
                self.assertNotIn("do-not-log", repr(vars(caught.exception)))

    def test_spawned_confirmation_accepts_correlated_file_loaded_event(self) -> None:
        chunk = (
            json.dumps(
                {
                    "request_id": 7,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + json.dumps(
                {
                    "request_id": 8,
                    "error": "property unavailable",
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"event":"file-loaded"}\n'
            + json.dumps(
                {
                    "request_id": 9,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"request_id":10,"error":"property unavailable"}\n'
            + json.dumps(
                {
                    "request_id": 11,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"request_id":12,"error":"property unavailable"}\n'
        )
        session = host.IpcSession(TimeoutChunkSocket([chunk]))
        with mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)):
            confirmation = host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(confirmation, "file-loaded")

    def test_spawned_confirmation_accepts_correlated_demuxer_property(self) -> None:
        chunk = (
            json.dumps(
                {
                    "request_id": 7,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + json.dumps(
                {
                    "request_id": 8,
                    "error": "success",
                    "data": "hls",
                }
            ).encode("utf-8")
            + b"\n"
        )
        session = host.IpcSession(TimeoutChunkSocket([chunk]))
        with mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)):
            confirmation = host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(confirmation, "demuxer-property")

    def test_demuxer_evidence_cannot_cross_probe_generations(self) -> None:
        chunk = (
            b'{"request_id":7,"error":"success","data":"https://old.test/previous.m3u8"}\n'
            + b'{"request_id":8,"error":"success","data":"hls"}\n'
            + json.dumps(
                {
                    "request_id": 9,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"request_id":10,"error":"property unavailable"}\n'
        )
        session = host.IpcSession(TimeoutChunkSocket([chunk]))
        with (
            mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 0.05,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_DEMUXER_TIMEOUT")

    def test_spawned_confirmation_reports_end_file_error_before_success(self) -> None:
        session = host.IpcSession(
            ChunkSocket([b'{"event":"end-file","reason":"error","error":-13}\n'])
        )
        with (
            mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_LOAD_FAILED")

    def test_spawned_confirmation_prefers_immediate_error_over_demuxer_evidence(
        self,
    ) -> None:
        chunk = (
            json.dumps(
                {
                    "request_id": 7,
                    "error": "success",
                    "data": VALID_STREAM["url"],
                }
            ).encode("utf-8")
            + b"\n"
            + json.dumps(
                {
                    "request_id": 8,
                    "error": "success",
                    "data": "hls",
                }
            ).encode("utf-8")
            + b"\n"
            + b'{"event":"end-file","reason":"error","error":-13}\n'
        )
        session = host.IpcSession(ChunkSocket([chunk]))
        with (
            mock.patch.object(host.secrets, "randbits", side_effect=range(6, 1000)),
            self.assertRaises(host.HostError) as caught,
        ):
            host.confirm_loaded(
                session,
                VALID_STREAM["url"],
                time.monotonic() + 1.0,
                process=RunningProcess(),
                accept_file_loaded_event=True,
            )
        self.assertEqual(caught.exception.code, "MPV_LOAD_FAILED")


class QueueSocketSafetyTests(unittest.TestCase):
    def test_live_private_queue_socket_is_never_unlinked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            socket_path = Path(temporary) / "queue.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                listener.bind(os.fspath(socket_path))
                os.chmod(socket_path, 0o600)
                listener.listen(1)
                session = host._connect_existing_queue(
                    socket_path, time.monotonic() + 1.0
                )
                self.assertIsNotNone(session)
                self.assertTrue(socket_path.exists())
                session.close()
            finally:
                listener.close()

    def test_only_proven_stale_queue_socket_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            socket_path = Path(temporary) / "queue.sock"
            stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            stale.bind(os.fspath(socket_path))
            os.chmod(socket_path, 0o600)
            stale.close()
            session = host._connect_existing_queue(
                socket_path, time.monotonic() + 1.0
            )
            self.assertIsNone(session)
            self.assertFalse(socket_path.exists())


class LoggingAndRuntimeTests(unittest.TestCase):
    def test_logger_drops_secrets_and_enforces_private_permissions(self) -> None:
        secret_url = "https://secret.example.test/live.m3u8?token=do-not-log"
        secret_header = "Bearer do-not-log"
        with tempfile.TemporaryDirectory() as temporary:
            log_directory = Path(temporary) / "private-state"
            logger = host.SecureLogger(log_directory)
            logger.log(
                "request",
                "error",
                "MPV_LOAD_FAILED",
                action="play",
                mode="new",
                confirmed=False,
                url=secret_url,
                referer=secret_header,
                stderr=secret_header,
                mpvErrorCategory=secret_url,
            )
            text = (log_directory / host.LOG_FILE_NAME).read_text(encoding="utf-8")
            record = json.loads(text)
            self.assertNotIn(secret_url, text)
            self.assertNotIn(secret_header, text)
            self.assertNotIn("url", record)
            self.assertNotIn("referer", record)
            self.assertNotIn("stderr", record)
            self.assertNotIn("mpvErrorCategory", record)
            self.assertEqual(record["code"], "MPV_LOAD_FAILED")
            self.assertEqual(stat.S_IMODE(log_directory.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((log_directory / host.LOG_FILE_NAME).stat().st_mode),
                0o600,
            )

    def test_dispatch_logs_safe_mpv_category_without_changing_response(self) -> None:
        request = host.validate_request(
            {
                "protocolVersion": 2,
                "action": "play",
                "requestId": "safe-mpv-category",
                "source": "manual",
                "mode": "new",
                "stream": dict(VALID_STREAM),
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            logger = host.SecureLogger(Path(temporary) / "private-state")
            with mock.patch.object(
                host,
                "handle_play",
                side_effect=host.HostError(
                    "MPV_LOAD_FAILED",
                    mpv_error_category="format",
                ),
            ):
                response = host.dispatch(request, logger)

            record = json.loads(logger.path.read_text(encoding="utf-8"))

        self.assertEqual(record["code"], "MPV_LOAD_FAILED")
        self.assertEqual(record["mpvErrorCategory"], "format")
        self.assertEqual(
            set(response),
            {
                "protocolVersion",
                "hostVersion",
                "action",
                "requestProtocolVersion",
                "requestId",
                "ok",
                "errorCode",
                "error",
                "confirmed",
                "mode",
            },
        )
        self.assertEqual(response["errorCode"], "MPV_LOAD_FAILED")
        self.assertEqual(response["error"], host.ERROR_MESSAGES["MPV_LOAD_FAILED"])
        self.assertNotIn("mpvErrorCategory", response)

    def test_logger_rotates_with_private_backups(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            log_directory = Path(temporary) / "private-state"
            logger = host.SecureLogger(log_directory, max_bytes=180, backups=2)
            for _ in range(5):
                logger.log("request", "success", "OK", action="health")
            backups = sorted(log_directory.glob("host.log.*"))
            self.assertTrue(backups)
            for path in backups:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_runtime_directory_must_be_absolute_owned_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary) / "xdg-runtime"
            runtime_root.mkdir(mode=0o700)
            os.chmod(runtime_root, 0o700)
            with mock.patch.dict(
                os.environ, {"XDG_RUNTIME_DIR": os.fspath(runtime_root)}
            ):
                paths = host.get_runtime_paths(create=True)
            self.assertEqual(paths.directory.parent, runtime_root)
            self.assertEqual(stat.S_IMODE(paths.directory.stat().st_mode), 0o700)

            os.chmod(runtime_root, 0o755)
            with mock.patch.dict(
                os.environ, {"XDG_RUNTIME_DIR": os.fspath(runtime_root)}
            ):
                with self.assertRaises(host.HostError) as caught:
                    host.get_runtime_paths(create=False)
            self.assertEqual(caught.exception.code, "RUNTIME_INSECURE")

    def test_runtime_falls_back_only_to_run_user_uid(self) -> None:
        expected_root = Path("/run/user") / str(os.getuid())
        root_stat = mock.Mock(
            st_mode=stat.S_IFDIR | 0o700,
            st_uid=os.getuid(),
        )
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(Path, "lstat", return_value=root_stat),
            mock.patch.object(Path, "exists", return_value=False),
        ):
            paths = host.get_runtime_paths(create=False)
        self.assertEqual(paths.directory.parent, expected_root)
        self.assertNotIn("/tmp", os.fspath(paths.directory))

    def test_health_queue_is_missing_when_private_runtime_child_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary) / "xdg-runtime"
            runtime_root.mkdir(mode=0o700)
            os.chmod(runtime_root, 0o700)
            with mock.patch.dict(
                os.environ, {"XDG_RUNTIME_DIR": os.fspath(runtime_root)}
            ):
                paths = host.get_runtime_paths(create=False)
                state = host.inspect_queue_state(paths)
        self.assertFalse(paths.directory.exists())
        self.assertEqual(
            state,
            {"state": "missing", "socketPresent": False, "responsive": False},
        )


class NativeFramingTests(unittest.TestCase):
    def test_native_message_round_trip_and_duplicate_rejection(self) -> None:
        payload = {"protocolVersion": 2, "action": "health"}
        encoded = json.dumps(payload).encode("utf-8")
        source = io.BytesIO(struct.pack("<I", len(encoded)) + encoded)
        self.assertEqual(host.read_native_message(source), payload)

        duplicate = b'{"action":"health","action":"play"}'
        source = io.BytesIO(struct.pack("<I", len(duplicate)) + duplicate)
        with self.assertRaises(host.HostError) as caught:
            host.read_native_message(source)
        self.assertEqual(caught.exception.code, "INVALID_MESSAGE")

    def test_response_is_versioned_and_never_echoes_stream(self) -> None:
        request = host.validate_request(
            {
                "protocolVersion": 2,
                "action": "play",
                "requestId": "test-1",
                "source": "manual",
                "mode": "new",
                "stream": dict(VALID_STREAM),
            }
        )
        response = host.error_response(host.HostError("MPV_LOAD_FAILED"), request)
        output = io.BytesIO()
        host.write_native_message(output, response)
        framed = output.getvalue()
        size = struct.unpack("<I", framed[:4])[0]
        decoded = json.loads(framed[4 : 4 + size])
        serialized = json.dumps(decoded)
        self.assertEqual(decoded["protocolVersion"], 2)
        self.assertEqual(decoded["requestId"], "test-1")
        self.assertFalse(decoded["confirmed"])
        self.assertNotIn(VALID_STREAM["url"], serialized)


class HealthTests(unittest.TestCase):
    def test_health_uses_mocked_mpv_and_queue_probe(self) -> None:
        request = host.HostRequest(
            action="health",
            request_protocol_version=2,
            request_id="health-1",
        )
        runtime = host.RuntimePaths(
            directory=Path("/run/user/1000/mpv-redirector"),
            queue_socket=Path("/run/user/1000/mpv-redirector/queue.sock"),
            queue_lock=Path("/run/user/1000/mpv-redirector/queue.lock"),
        )
        queue_state = {
            "state": "running",
            "socketPresent": True,
            "responsive": True,
        }
        with (
            mock.patch.object(host, "find_mpv_path", return_value="/mock/mpv"),
            mock.patch.object(host, "get_mpv_version", return_value="mpv v9.9.9"),
            mock.patch.object(host, "get_runtime_paths", return_value=runtime),
            mock.patch.object(host, "inspect_queue_state", return_value=queue_state),
            mock.patch.object(
                host,
                "resolver_info",
                side_effect=lambda name: host.ResolverInfo(
                    name=name,
                    path=f"/mock/{name}",
                    version="8.4.0" if name == "streamlink" else "2026.06.09",
                    installed=True,
                    compatible=True,
                ),
            ),
        ):
            response = host.handle_health(request)
        self.assertTrue(response["ok"])
        self.assertEqual(response["hostVersion"], host.HOST_VERSION)
        self.assertEqual(response["mpv"]["path"], "/mock/mpv")
        self.assertEqual(response["mpv"]["version"], "mpv v9.9.9")
        self.assertEqual(response["queue"], queue_state)
        self.assertEqual(response["capabilities"], ["health", "play", "resolve"])
        self.assertTrue(response["resolvers"]["streamlink"]["available"])
        self.assertTrue(response["resolvers"]["yt-dlp"]["available"])

    def test_health_reports_missing_mpv_without_running_it(self) -> None:
        request = host.HostRequest(action="health", request_protocol_version=2)
        with (
            mock.patch.object(
                host, "find_mpv_path", side_effect=host.HostError("MPV_NOT_FOUND")
            ),
            mock.patch.object(
                host,
                "get_runtime_paths",
                side_effect=host.HostError("RUNTIME_UNAVAILABLE"),
            ),
            mock.patch.object(host, "get_mpv_version") as version,
        ):
            response = host.handle_health(request)
        version.assert_not_called()
        self.assertTrue(response["ok"])
        self.assertFalse(response["mpv"]["available"])
        self.assertIsNone(response["mpv"]["path"])
        self.assertEqual(response["queue"]["state"], "unavailable")

    def test_health_reports_missing_queue_when_runtime_child_does_not_exist(self) -> None:
        request = host.HostRequest(action="health", request_protocol_version=2)
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary) / "xdg-runtime"
            runtime_root.mkdir(mode=0o700)
            os.chmod(runtime_root, 0o700)
            with (
                mock.patch.dict(
                    os.environ, {"XDG_RUNTIME_DIR": os.fspath(runtime_root)}
                ),
                mock.patch.object(host, "find_mpv_path", return_value="/mock/mpv"),
                mock.patch.object(
                    host, "get_mpv_version", return_value="mpv v9.9.9"
                ),
            ):
                response = host.handle_health(request)
        self.assertTrue(response["ok"])
        self.assertEqual(response["queue"]["state"], "missing")
        self.assertFalse(response["queue"]["socketPresent"])


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Secure Native Messaging host for MPV Redirector Pro.

Play and health responses never echo media URLs or HTTP headers. The explicit
resolve action returns a bounded, validated candidate list, but never cookies,
command lines, resolver stderr, or other raw subprocess output.
"""

from __future__ import annotations

import contextlib
import errno
import fcntl
import ipaddress
import json
import math
import os
import re
import secrets
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterator, Mapping, Sequence
from urllib.parse import parse_qsl, urlsplit


HOST_VERSION = "3.4.8"
PROTOCOL_VERSION = 2

MAX_NATIVE_MESSAGE_BYTES = 64 * 1024
MAX_NATIVE_RESPONSE_BYTES = 64 * 1024
MAX_IPC_LINE_BYTES = 64 * 1024
MAX_URL_BYTES = 32 * 1024
MAX_REFERER_BYTES = 8 * 1024
MAX_ORIGIN_BYTES = 2 * 1024
MAX_USER_AGENT_BYTES = 1024
MAX_REQUEST_ID_BYTES = 96
MAX_COOKIE_COUNT = 64
MAX_COOKIE_NAME_BYTES = 256
MAX_COOKIE_VALUE_BYTES = 4096
MAX_COOKIE_DOMAIN_BYTES = 253
MAX_COOKIE_PATH_BYTES = 2048
MAX_COOKIE_TOTAL_BYTES = 32 * 1024
MAX_RESOLVER_ORDER = 2
MAX_RESOLVER_STDOUT_BYTES = 2 * 1024 * 1024
MAX_RESOLVER_STDERR_BYTES = 64 * 1024
MAX_RESOLVER_CANDIDATES = 24
MAX_RESOLVER_TITLE_BYTES = 512
MAX_RESOLVER_QUALITY_BYTES = 64
MAX_RESOLVER_FORMAT_ID_BYTES = 64
MAX_LANGUAGE_TAG_BYTES = 63
MAX_PREFERRED_LANGUAGES = 8
RESOLVER_RESPONSE_BUDGET = MAX_NATIVE_RESPONSE_BYTES - 1024

PLAY_DEADLINE_SECONDS = 20.0
QUEUE_LOCK_SECONDS = 2.0
HEALTH_IPC_SECONDS = 0.4
PROCESS_STOP_SECONDS = 0.5
PROCESS_EXIT_GRACE_SECONDS = 0.25
SOCKET_RETRY_SECONDS = 0.04
LOAD_CONFIRM_SETTLE_SECONDS = 0.15
SIGNED_URL_EXPIRY_GRACE_SECONDS = 5.0
SIGNED_URL_MAX_QUERY_FIELDS = 128
SIGNED_URL_MIN_UNIX_SECONDS = 946_684_800
SIGNED_URL_MAX_UNIX_SECONDS = 253_402_300_799
SIGNED_URL_EXPIRY_QUERY_NAMES = frozenset({"validto", "exp", "expires", "expiry"})
RESOLVER_VERSION_SECONDS = 1.5
RESOLVER_ATTEMPT_SECONDS = 9.0
RESOLVER_PROCESS_STOP_SECONDS = 0.35

RUNTIME_DIR_NAME = "mpv-redirector"
QUEUE_SOCKET_NAME = "queue.sock"
QUEUE_LOCK_NAME = "queue.lock"
RESOLVER_LOCK_NAME = "resolver.lock"
LOG_FILE_NAME = "host.log"
LOG_LOCK_NAME = "host.log.lock"
LOG_MAX_BYTES = 512 * 1024
LOG_BACKUPS = 2

ALLOWED_MODES = frozenset({"new", "append", "replace"})
ALLOWED_RESOLVERS = frozenset({"streamlink", "yt-dlp"})
ALLOWED_ADAPTERS = frozenset({"tvp", "youtube", "generic"})
ALLOWED_RESOLVE_SOURCES = frozenset({"manual", "page_ready", "refresh"})
ALLOWED_PLAYBACK_KINDS = frozenset({"yt-dlp-page"})
RESOLVER_MINIMUM_VERSIONS: Mapping[str, tuple[int, int, int]] = {
    "streamlink": (8, 4, 0),
    "yt-dlp": (2026, 6, 9),
}
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]+$")
LOG_ATOM_RE = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")
COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
RESOLVER_VERSION_RE = re.compile(r"(?<!\d)(\d{1,4})\.(\d{1,2})\.(\d{1,2})(?!\d)")
LANGUAGE_TAG_RE = re.compile(
    r"^(?:"
    r"(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})"
    r"(?:-[A-Za-z]{4})?"
    r"(?:-(?:[A-Za-z]{2}|[0-9]{3}))?"
    r"(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*"
    r"(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*"
    r"(?:-x(?:-[A-Za-z0-9]{1,8})+)?"
    r"|x(?:-[A-Za-z0-9]{1,8})+"
    r")$"
)
RESOLVER_MEDIA_KINDS = frozenset(
    {"adaptive", "muxed", "video-only", "audio-only"}
)

ERROR_MESSAGES = {
    "INVALID_MESSAGE": "The native message is malformed.",
    "MESSAGE_TOO_LARGE": "The native message exceeds the size limit.",
    "INVALID_REQUEST": "The request does not match the host protocol.",
    "UNSUPPORTED_PROTOCOL": "The requested protocol version is not supported.",
    "UNSUPPORTED_ACTION": "The requested action is not supported.",
    "INVALID_URL": "The stream URL is not an allowed HTTP or HTTPS URL.",
    "INVALID_HEADER": "A stream header is invalid.",
    "MPV_NOT_FOUND": "The mpv executable was not found.",
    "MPV_EXEC_FAILED": "mpv could not be started.",
    "MPV_EXITED_EARLY": "mpv exited before the stream was confirmed.",
    "MPV_IPC_TIMEOUT": "mpv did not expose IPC before the deadline.",
    "MPV_CONFIRM_TIMEOUT": "mpv did not confirm the stream before the deadline.",
    "MPV_DEMUXER_TIMEOUT": "mpv accepted the input but did not open a demuxer before the deadline.",
    "MPV_LOAD_FAILED": "mpv reported a stream loading failure.",
    "STREAM_URL_EXPIRED": "The signed stream URL has expired.",
    "MPV_IPC_REJECTED": "mpv rejected the IPC command.",
    "MPV_IPC_PROTOCOL": "mpv returned an invalid IPC response.",
    "QUEUE_BUSY": "The MPV queue is busy.",
    "QUEUE_UNRESPONSIVE": "The managed MPV queue is not responding.",
    "QUEUE_SOCKET_UNSAFE": "The managed MPV socket is not private or trustworthy.",
    "RUNTIME_UNAVAILABLE": "A private XDG runtime directory is unavailable.",
    "RUNTIME_INSECURE": "The XDG runtime directory is not private.",
    "RESOLVER_UNAVAILABLE": "No compatible resolver executable is available.",
    "RESOLVER_BUSY": "Another resolver request is already running.",
    "RESOLVER_TOO_OLD": "The resolver executable is older than the supported version.",
    "RESOLVER_EXEC_FAILED": "The resolver executable could not be started.",
    "RESOLVER_TIMEOUT": "The resolver exceeded its execution deadline.",
    "RESOLVER_OUTPUT_TOO_LARGE": "The resolver produced too much output.",
    "RESOLVER_INVALID_OUTPUT": "The resolver returned invalid output.",
    "RESOLVER_EXITED": "The resolver exited without usable streams.",
    "RESOLVER_URL_FORBIDDEN": "Resolvers do not accept local or private page URLs.",
    "INTERNAL_ERROR": "The native host encountered an internal error.",
}

# mpv's ``end-file`` event exposes ``file_error`` as a short libmpv error
# string. Treat the IPC peer as untrusted regardless: only exact, documented
# values are classified, and neither the raw value nor any other event field is
# retained. This keeps future/custom mpv strings (which could contain a URL or
# other request data) behind the non-secret ``unknown`` category.
MPV_FILE_ERROR_CATEGORIES: Mapping[str, str] = {
    "loading failed": "load",
    "no audio or video data played": "media",
    "unrecognized file format": "format",
    "not supported": "unsupported",
    "operation not implemented": "unsupported",
    "something happened": "unknown",
}
ALLOWED_MPV_ERROR_CATEGORIES = frozenset(
    {"load", "media", "format", "unsupported", "unknown"}
)


class HostError(Exception):
    """An expected failure with a stable, non-secret public error code."""

    def __init__(
        self,
        code: str,
        *,
        exit_code: int | None = None,
        mpv_error_category: str | None = None,
        request_context: HostRequest | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.mpv_error_category = (
            mpv_error_category
            if type(mpv_error_category) is str
            and mpv_error_category in ALLOWED_MPV_ERROR_CATEGORIES
            else None
        )
        self.request_context = request_context

    @property
    def public_message(self) -> str:
        return ERROR_MESSAGES.get(self.code, ERROR_MESSAGES["INTERNAL_ERROR"])


def _mpv_file_error_category(value: Any) -> str:
    """Return a bounded public category without retaining the raw IPC value."""

    if type(value) is not str:
        return "unknown"
    return MPV_FILE_ERROR_CATEGORIES.get(value, "unknown")


class IpcReadTimeout(Exception):
    pass


class IpcTransportError(Exception):
    pass


class DuplicateJsonKey(ValueError):
    pass


@dataclass(frozen=True)
class StreamSpec:
    url: str
    referer: str = ""
    origin: str = ""
    user_agent: str = ""
    language: str = ""
    playback_kind: str = ""


@dataclass(frozen=True)
class ResolverCookie:
    name: str
    value: str
    domain: str
    path: str
    secure: bool
    http_only: bool
    host_only: bool
    expires: int


@dataclass(frozen=True)
class HostRequest:
    action: str
    request_protocol_version: int
    request_id: str | None = None
    source: str | None = None
    mode: str | None = None
    stream: StreamSpec | None = None
    page_url: str | None = None
    adapter: str | None = None
    resolver_order: tuple[str, ...] = ()
    cookies: tuple[ResolverCookie, ...] = ()
    preferred_languages: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuntimePaths:
    directory: Path
    queue_socket: Path
    queue_lock: Path


@dataclass(frozen=True)
class SocketIdentity:
    device: int
    inode: int


@dataclass(frozen=True)
class PlayResult:
    mode: str
    confirmation: str
    disposition: str


@dataclass(frozen=True)
class ProcessResult:
    return_code: int
    stdout: bytes
    stderr: bytes


@dataclass(frozen=True)
class ResolverInfo:
    name: str
    path: str | None
    version: str | None
    installed: bool
    compatible: bool
    error_code: str | None = None


@dataclass(frozen=True)
class ResolverParseResult:
    candidates: tuple[dict[str, Any], ...]
    truncated: bool = False


@dataclass(frozen=True)
class YtDlpFormatModel:
    raw: Mapping[str, Any]
    index: int
    has_audio: bool
    has_video: bool
    media_kind: str
    language: str
    requested: bool


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(key)
        result[key] = value
    return result


def _reject_nonfinite_number(value: str) -> None:
    raise ValueError(value)


def strict_json_loads(data: str | bytes) -> Any:
    return json.loads(
        data,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_nonfinite_number,
    )


def _is_exact_int(value: Any) -> bool:
    return type(value) is int


def _is_exact_bool(value: Any) -> bool:
    return type(value) is bool


def _require_object(value: Any) -> dict[str, Any]:
    if type(value) is not dict:
        raise HostError("INVALID_REQUEST")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], required: set[str], optional: set[str] | None = None
) -> None:
    allowed = required | (optional or set())
    if not required.issubset(value) or set(value) - allowed:
        raise HostError("INVALID_REQUEST")


def _validate_request_id(value: Any) -> str:
    if type(value) is not str:
        raise HostError("INVALID_REQUEST")
    if not value or len(value.encode("utf-8")) > MAX_REQUEST_ID_BYTES:
        raise HostError("INVALID_REQUEST")
    if not REQUEST_ID_RE.fullmatch(value):
        raise HostError("INVALID_REQUEST")
    return value


def _validate_no_controls(value: str, *, allow_unicode: bool = True) -> None:
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise HostError("INVALID_HEADER")
    if not allow_unicode and any(ord(char) > 0x7E for char in value):
        raise HostError("INVALID_HEADER")


def _validate_http_url(
    value: Any,
    *,
    max_bytes: int,
    header: bool,
    allow_query: bool = True,
    allow_path: bool = True,
    allow_fragment: bool = False,
) -> str:
    error_code = "INVALID_HEADER" if header else "INVALID_URL"
    if type(value) is not str or not value:
        raise HostError(error_code)
    try:
        encoded = value.encode("utf-8")
    except UnicodeError as exc:
        raise HostError(error_code) from exc
    if len(encoded) > max_bytes:
        raise HostError(error_code)
    if "\\" in value or any(char.isspace() for char in value):
        raise HostError(error_code)
    try:
        _validate_no_controls(value)
        parsed = urlsplit(value)
        hostname = parsed.hostname
        _ = parsed.port
    except (HostError, UnicodeError, ValueError) as exc:
        raise HostError(error_code) from exc
    if parsed.scheme.lower() not in {"http", "https"}:
        raise HostError(error_code)
    if not parsed.netloc or not hostname:
        raise HostError(error_code)
    if parsed.username is not None or parsed.password is not None:
        raise HostError(error_code)
    try:
        hostname.encode("idna")
    except UnicodeError as exc:
        raise HostError(error_code) from exc
    if not allow_path and parsed.path:
        raise HostError(error_code)
    if not allow_query and parsed.query:
        raise HostError(error_code)
    if not allow_fragment and parsed.fragment:
        raise HostError(error_code)
    return value


def _validate_resolver_page_url(value: Any) -> str:
    validated = _validate_http_url(
        value,
        max_bytes=MAX_URL_BYTES,
        header=False,
        allow_fragment=False,
    )
    parsed = urlsplit(validated)
    try:
        hostname = _ascii_hostname(parsed.hostname or "")
    except HostError as exc:
        raise HostError("RESOLVER_URL_FORBIDDEN") from exc
    if (
        not hostname
        or hostname == "localhost"
        or hostname.endswith(".localhost")
        or hostname.endswith(".local")
        or hostname.endswith(".internal")
        or hostname.endswith(".home.arpa")
    ):
        raise HostError("RESOLVER_URL_FORBIDDEN")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        # Reject legacy numeric IPv4 spellings such as 127.1, 2130706433 and
        # 0x7f000001 even when the URL parser treats them as DNS names.
        try:
            socket.inet_aton(hostname)
        except OSError:
            return validated
        raise HostError("RESOLVER_URL_FORBIDDEN")
    if not address.is_global:
        raise HostError("RESOLVER_URL_FORBIDDEN")
    return validated


def validate_language_tag(value: Any) -> str:
    if type(value) is not str or not value:
        raise HostError("INVALID_REQUEST")
    try:
        encoded = value.encode("ascii")
    except UnicodeError as exc:
        raise HostError("INVALID_REQUEST") from exc
    if len(encoded) > MAX_LANGUAGE_TAG_BYTES or LANGUAGE_TAG_RE.fullmatch(value) is None:
        raise HostError("INVALID_REQUEST")

    subtags = value.split("-")
    extension_singletons: set[str] = set()
    private_use = subtags[0].casefold() == "x"
    for raw_subtag in subtags[1:]:
        lower = raw_subtag.casefold()
        if private_use:
            continue
        if lower == "x":
            private_use = True
        elif len(raw_subtag) == 1:
            if lower in extension_singletons:
                raise HostError("INVALID_REQUEST")
            extension_singletons.add(lower)

    core_end = next(
        (
            index
            for index, subtag in enumerate(subtags[1:], start=1)
            if len(subtag) == 1
        ),
        len(subtags),
    )
    index = 1
    if len(subtags[0]) in {2, 3}:
        extlang_count = 0
        while (
            index < core_end
            and extlang_count < 3
            and len(subtags[index]) == 3
            and subtags[index].isalpha()
        ):
            index += 1
            extlang_count += 1
    if index < core_end and len(subtags[index]) == 4 and subtags[index].isalpha():
        index += 1
    if index < core_end and (
        (len(subtags[index]) == 2 and subtags[index].isalpha())
        or (len(subtags[index]) == 3 and subtags[index].isdigit())
    ):
        index += 1
    variants = [subtag.casefold() for subtag in subtags[index:core_end]]
    if len(variants) != len(set(variants)):
        raise HostError("INVALID_REQUEST")

    canonical: list[str] = []
    in_extension = False
    private_use = False
    for index, raw_subtag in enumerate(value.split("-")):
        lower = raw_subtag.lower()
        if index == 0:
            canonical.append(lower)
            private_use = lower == "x"
        elif private_use or in_extension:
            canonical.append(lower)
        elif lower == "x":
            canonical.append(lower)
            private_use = True
        elif len(raw_subtag) == 1:
            canonical.append(lower)
            in_extension = True
        elif len(raw_subtag) == 4 and raw_subtag.isalpha():
            canonical.append(lower.title())
        elif (
            len(raw_subtag) == 2
            and raw_subtag.isalpha()
        ) or (len(raw_subtag) == 3 and raw_subtag.isdigit()):
            canonical.append(raw_subtag.upper())
        else:
            canonical.append(lower)
    return "-".join(canonical)


def validate_preferred_languages(value: Any) -> tuple[str, ...]:
    if type(value) is not list or len(value) > MAX_PREFERRED_LANGUAGES:
        raise HostError("INVALID_REQUEST")
    result: list[str] = []
    seen: set[str] = set()
    for raw_language in value:
        language = validate_language_tag(raw_language)
        dedupe_key = language.casefold()
        if dedupe_key in seen:
            raise HostError("INVALID_REQUEST")
        seen.add(dedupe_key)
        result.append(language)
    return tuple(result)


def validate_stream(value: Any, *, legacy: bool = False) -> StreamSpec:
    stream = _require_object(value)
    optional_fields = {"referer", "origin", "userAgent", "language"}
    if legacy:
        optional_fields.update({"type", "isMaster"})
    else:
        optional_fields.add("playbackKind")
    _require_exact_keys(
        stream,
        {"url"},
        optional_fields,
    )
    if legacy and "type" in stream:
        if type(stream["type"]) is not str or stream["type"] not in {"HLS", "DASH"}:
            raise HostError("INVALID_REQUEST")
    if legacy and "isMaster" in stream and not _is_exact_bool(stream["isMaster"]):
        raise HostError("INVALID_REQUEST")
    url = _validate_http_url(
        stream["url"], max_bytes=MAX_URL_BYTES, header=False, allow_fragment=True
    )

    referer = stream.get("referer", "")
    if referer:
        referer = _validate_http_url(
            referer,
            max_bytes=MAX_REFERER_BYTES,
            header=True,
            allow_fragment=False,
        )
    elif type(referer) is not str:
        raise HostError("INVALID_HEADER")

    origin = stream.get("origin", "")
    if type(origin) is not str:
        raise HostError("INVALID_HEADER")
    if origin and origin != "null":
        origin = _validate_http_url(
            origin,
            max_bytes=MAX_ORIGIN_BYTES,
            header=True,
            allow_query=False,
            allow_path=False,
            allow_fragment=False,
        )

    user_agent = stream.get("userAgent", "")
    if user_agent:
        if type(user_agent) is not str:
            raise HostError("INVALID_HEADER")
        try:
            encoded_user_agent = user_agent.encode("ascii")
        except UnicodeError as exc:
            raise HostError("INVALID_HEADER") from exc
        if len(encoded_user_agent) > MAX_USER_AGENT_BYTES:
            raise HostError("INVALID_HEADER")
        _validate_no_controls(user_agent, allow_unicode=False)
    elif type(user_agent) is not str:
        raise HostError("INVALID_HEADER")

    language = ""
    if "language" in stream:
        language = validate_language_tag(stream["language"])

    playback_kind = stream.get("playbackKind", "")
    if (
        type(playback_kind) is not str
        or (playback_kind and playback_kind not in ALLOWED_PLAYBACK_KINDS)
    ):
        raise HostError("INVALID_REQUEST")

    return StreamSpec(
        url=url,
        referer=referer,
        origin=origin,
        user_agent=user_agent,
        language=language,
        playback_kind=playback_kind,
    )


def _parse_signed_url_expiry_milliseconds(value: str) -> int | None:
    if re.fullmatch(r"[0-9]{1,15}", value) is None:
        return None
    raw_expiry = int(value)
    if SIGNED_URL_MIN_UNIX_SECONDS <= raw_expiry <= SIGNED_URL_MAX_UNIX_SECONDS:
        return raw_expiry * 1000
    minimum_milliseconds = SIGNED_URL_MIN_UNIX_SECONDS * 1000
    maximum_milliseconds = SIGNED_URL_MAX_UNIX_SECONDS * 1000 + 999
    if minimum_milliseconds <= raw_expiry <= maximum_milliseconds:
        return raw_expiry
    return None


def _stream_url_is_expired(
    stream: StreamSpec,
    *,
    now: float | None = None,
) -> bool:
    # A page recipe is resolved by yt-dlp at playback time. Its query string is
    # page state, not a media authorization contract, so never infer expiry
    # from it. For direct streams, only the explicit absolute-expiry allowlist
    # shared with the extension is considered. Unknown or ambiguous values
    # remain MPV's concern.
    if stream.playback_kind:
        return False
    try:
        fields = parse_qsl(
            urlsplit(stream.url).query,
            keep_blank_values=True,
            strict_parsing=False,
            max_num_fields=SIGNED_URL_MAX_QUERY_FIELDS,
            separator="&",
        )
    except (UnicodeError, ValueError):
        return False
    values_by_name: dict[str, set[int]] = {}
    for raw_name, raw_value in fields:
        name = raw_name.casefold()
        if name not in SIGNED_URL_EXPIRY_QUERY_NAMES:
            continue
        expiry = _parse_signed_url_expiry_milliseconds(raw_value)
        if expiry is None:
            return False
        expiries = values_by_name.setdefault(name, set())
        expiries.add(expiry)
        if len(expiries) > 1:
            return False
    if not values_by_name:
        return False
    expiry_values = [next(iter(expiries)) for expiries in values_by_name.values()]
    current_time = time.time() if now is None else now
    if type(current_time) not in {int, float} or not math.isfinite(current_time):
        return False
    threshold_milliseconds = math.ceil(
        (float(current_time) + SIGNED_URL_EXPIRY_GRACE_SECONDS) * 1000
    )
    return min(expiry_values) <= threshold_milliseconds


def _validate_cookie_text(
    value: Any,
    *,
    max_bytes: int,
    allow_empty: bool,
    ascii_only: bool = False,
) -> str:
    if type(value) is not str or (not allow_empty and not value):
        raise HostError("INVALID_REQUEST")
    try:
        encoded = value.encode("ascii" if ascii_only else "utf-8")
    except UnicodeError as exc:
        raise HostError("INVALID_REQUEST") from exc
    if len(encoded) > max_bytes:
        raise HostError("INVALID_REQUEST")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise HostError("INVALID_REQUEST")
    return value


def _ascii_hostname(value: str) -> str:
    normalized = value.rstrip(".").lower()
    try:
        return normalized.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise HostError("INVALID_REQUEST") from exc


def _validate_cookie_domain(value: Any) -> str:
    raw = _validate_cookie_text(
        value,
        max_bytes=MAX_COOKIE_DOMAIN_BYTES + 1,
        allow_empty=False,
        ascii_only=False,
    )
    if raw.endswith(".") or raw.startswith("..") or any(char.isspace() for char in raw):
        raise HostError("INVALID_REQUEST")
    domain = _ascii_hostname(raw[1:] if raw.startswith(".") else raw)
    if not domain or len(domain.encode("ascii")) > MAX_COOKIE_DOMAIN_BYTES:
        raise HostError("INVALID_REQUEST")
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        labels = domain.split(".")
        if any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            or re.fullmatch(r"[a-z0-9-]+", label) is None
            for label in labels
        ):
            raise HostError("INVALID_REQUEST")
    return domain


def _cookie_domain_matches(page_hostname: str, cookie_domain: str, host_only: bool) -> bool:
    page_host = _ascii_hostname(page_hostname)
    if host_only:
        return page_host == cookie_domain
    try:
        ipaddress.ip_address(cookie_domain)
    except ValueError:
        return page_host == cookie_domain or page_host.endswith(f".{cookie_domain}")
    return page_host == cookie_domain


def _cookie_path_matches(page_path: str, cookie_path: str) -> bool:
    actual_path = page_path if page_path.startswith("/") else "/"
    if actual_path == cookie_path:
        return True
    if not actual_path.startswith(cookie_path):
        return False
    return cookie_path.endswith("/") or actual_path[len(cookie_path) :].startswith("/")


def validate_resolver_cookies(value: Any, page_url: str) -> tuple[ResolverCookie, ...]:
    if type(value) is not list or len(value) > MAX_COOKIE_COUNT:
        raise HostError("INVALID_REQUEST")
    parsed_page = urlsplit(page_url)
    if parsed_page.scheme.lower() not in {"http", "https"} or not parsed_page.hostname:
        raise HostError("INVALID_URL")
    if value and parsed_page.scheme.lower() != "https":
        raise HostError("INVALID_URL")
    page_path = parsed_page.path or "/"
    now = int(time.time())
    total_bytes = 0
    cookies: list[ResolverCookie] = []
    for raw_cookie in value:
        cookie = _require_object(raw_cookie)
        _require_exact_keys(
            cookie,
            {
                "name",
                "value",
                "domain",
                "path",
                "secure",
                "httpOnly",
                "hostOnly",
                "expires",
            },
        )
        name = _validate_cookie_text(
            cookie["name"],
            max_bytes=MAX_COOKIE_NAME_BYTES,
            allow_empty=False,
            ascii_only=True,
        )
        if COOKIE_NAME_RE.fullmatch(name) is None:
            raise HostError("INVALID_REQUEST")
        cookie_value = _validate_cookie_text(
            cookie["value"],
            max_bytes=MAX_COOKIE_VALUE_BYTES,
            allow_empty=True,
        )
        domain = _validate_cookie_domain(cookie["domain"])
        path = _validate_cookie_text(
            cookie["path"],
            max_bytes=MAX_COOKIE_PATH_BYTES,
            allow_empty=False,
        )
        if not path.startswith("/"):
            raise HostError("INVALID_REQUEST")
        for boolean_name in ("secure", "httpOnly", "hostOnly"):
            if not _is_exact_bool(cookie[boolean_name]):
                raise HostError("INVALID_REQUEST")
        raw_expires = cookie["expires"]
        if raw_expires is None:
            expires = 0
        elif type(raw_expires) is int:
            if raw_expires < 0 or raw_expires > 253_402_300_799:
                raise HostError("INVALID_REQUEST")
            expires = raw_expires
        elif type(raw_expires) is float:
            if not math.isfinite(raw_expires) or raw_expires < 0 or raw_expires > 253_402_300_799:
                raise HostError("INVALID_REQUEST")
            expires = int(raw_expires)
        else:
            raise HostError("INVALID_REQUEST")
        if not _cookie_domain_matches(parsed_page.hostname, domain, cookie["hostOnly"]):
            raise HostError("INVALID_REQUEST")
        if not _cookie_path_matches(page_path, path):
            raise HostError("INVALID_REQUEST")
        total_bytes += sum(
            len(part.encode("utf-8"))
            for part in (name, cookie_value, domain, path)
        )
        if total_bytes > MAX_COOKIE_TOTAL_BYTES:
            raise HostError("INVALID_REQUEST")
        if expires and expires <= now:
            continue
        cookies.append(
            ResolverCookie(
                name=name,
                value=cookie_value,
                domain=domain,
                path=path,
                secure=cookie["secure"],
                http_only=cookie["httpOnly"],
                host_only=cookie["hostOnly"],
                expires=expires,
            )
        )
    return tuple(cookies)


def validate_resolver_order(value: Any) -> tuple[str, ...]:
    if type(value) is not list or not value or len(value) > MAX_RESOLVER_ORDER:
        raise HostError("INVALID_REQUEST")
    if any(type(item) is not str or item not in ALLOWED_RESOLVERS for item in value):
        raise HostError("INVALID_REQUEST")
    if len(set(value)) != len(value):
        raise HostError("INVALID_REQUEST")
    return tuple(value)


def validate_request(payload: Any) -> HostRequest:
    request = _require_object(payload)

    # Rollback compatibility: only the old play + queue shape is accepted as v1.
    if "protocolVersion" not in request:
        _require_exact_keys(
            request,
            {"action", "stream", "queue"},
            {"source"},
        )
        if request["action"] != "play" or not _is_exact_bool(request["queue"]):
            raise HostError("INVALID_REQUEST")
        if "source" in request:
            if type(request["source"]) is not str or request["source"] not in {
                "auto",
                "manual",
            }:
                raise HostError("INVALID_REQUEST")
        mode = "append" if request["queue"] else "new"
        return HostRequest(
            action="play",
            request_protocol_version=1,
            source=request.get("source"),
            mode=mode,
            stream=validate_stream(request["stream"], legacy=True),
        )

    if not _is_exact_int(request["protocolVersion"]):
        raise HostError("INVALID_REQUEST")
    if request["protocolVersion"] != PROTOCOL_VERSION:
        raise HostError("UNSUPPORTED_PROTOCOL")
    if type(request.get("action")) is not str:
        raise HostError("INVALID_REQUEST")

    action = request["action"]
    request_id = None
    if "requestId" in request:
        request_id = _validate_request_id(request["requestId"])

    if action == "health":
        envelope = HostRequest(
            action=action,
            request_protocol_version=PROTOCOL_VERSION,
            request_id=request_id,
        )
        try:
            _require_exact_keys(
                request, {"protocolVersion", "action"}, {"requestId"}
            )
        except HostError as error:
            raise HostError(
                error.code,
                exit_code=error.exit_code,
                request_context=envelope,
            ) from error
        return envelope

    if action == "play":
        envelope = HostRequest(
            action=action,
            request_protocol_version=PROTOCOL_VERSION,
            request_id=request_id,
        )
        try:
            _require_exact_keys(
                request,
                {"protocolVersion", "action", "source", "mode", "stream"},
                {"requestId"},
            )
            if type(request["source"]) is not str or request["source"] not in {
                "auto",
                "manual",
            }:
                raise HostError("INVALID_REQUEST")
            if (
                type(request["mode"]) is not str
                or request["mode"] not in ALLOWED_MODES
            ):
                raise HostError("INVALID_REQUEST")
            envelope = HostRequest(
                action=action,
                request_protocol_version=PROTOCOL_VERSION,
                request_id=request_id,
                source=request["source"],
                mode=request["mode"],
            )
            stream = validate_stream(request["stream"])
        except HostError as error:
            raise HostError(
                error.code,
                exit_code=error.exit_code,
                request_context=envelope,
            ) from error
        return HostRequest(
            action=envelope.action,
            request_protocol_version=envelope.request_protocol_version,
            request_id=envelope.request_id,
            source=envelope.source,
            mode=envelope.mode,
            stream=stream,
        )

    if action == "resolve":
        envelope = HostRequest(
            action=action,
            request_protocol_version=PROTOCOL_VERSION,
            request_id=request_id,
        )
        try:
            _require_exact_keys(
                request,
                {
                    "protocolVersion",
                    "action",
                    "source",
                    "pageUrl",
                    "adapter",
                    "resolverOrder",
                    "cookies",
                },
                {"requestId", "preferredLanguages"},
            )
            if (
                type(request["source"]) is not str
                or request["source"] not in ALLOWED_RESOLVE_SOURCES
            ):
                raise HostError("INVALID_REQUEST")
            if type(request["adapter"]) is not str or request["adapter"] not in ALLOWED_ADAPTERS:
                raise HostError("INVALID_REQUEST")
            envelope = HostRequest(
                action=action,
                request_protocol_version=PROTOCOL_VERSION,
                request_id=request_id,
                source=request["source"],
                adapter=request["adapter"],
            )
            page_url = _validate_resolver_page_url(request["pageUrl"])
            resolver_order = validate_resolver_order(request["resolverOrder"])
            if request["source"] in {"page_ready", "refresh"} and request["cookies"] != []:
                raise HostError("INVALID_REQUEST")
            cookies = validate_resolver_cookies(request["cookies"], page_url)
            preferred_languages = validate_preferred_languages(
                request.get("preferredLanguages", [])
            )
        except HostError as error:
            raise HostError(
                error.code,
                exit_code=error.exit_code,
                request_context=envelope,
            ) from error
        return HostRequest(
            action=envelope.action,
            request_protocol_version=envelope.request_protocol_version,
            request_id=envelope.request_id,
            source=envelope.source,
            page_url=page_url,
            adapter=envelope.adapter,
            resolver_order=resolver_order,
            cookies=cookies,
            preferred_languages=preferred_languages,
        )

    raise HostError("UNSUPPORTED_ACTION")


def read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise HostError("INVALID_MESSAGE")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_native_message(stream: BinaryIO) -> Any | None:
    first = stream.read(4)
    if first == b"":
        return None
    if len(first) != 4:
        raise HostError("INVALID_MESSAGE")
    message_length = struct.unpack("<I", first)[0]
    if message_length == 0:
        raise HostError("INVALID_MESSAGE")
    if message_length > MAX_NATIVE_MESSAGE_BYTES:
        raise HostError("MESSAGE_TOO_LARGE")
    raw = read_exact(stream, message_length)
    try:
        return strict_json_loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise HostError("INVALID_MESSAGE") from exc


def write_native_message(stream: BinaryIO, response: Mapping[str, Any]) -> None:
    encoded = json.dumps(
        response,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(encoded) > MAX_NATIVE_RESPONSE_BYTES:
        raise HostError("INTERNAL_ERROR")
    stream.write(struct.pack("<I", len(encoded)))
    stream.write(encoded)
    stream.flush()


def _ensure_private_directory(path: Path, *, parents: bool) -> None:
    try:
        path.mkdir(mode=0o700, parents=parents, exist_ok=True)
        details = path.lstat()
    except OSError as exc:
        raise HostError("RUNTIME_UNAVAILABLE") from exc
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
        raise HostError("RUNTIME_INSECURE")
    if details.st_uid != os.getuid():
        raise HostError("RUNTIME_INSECURE")
    try:
        os.chmod(path, 0o700)
    except OSError as exc:
        raise HostError("RUNTIME_INSECURE") from exc
    if path.lstat().st_mode & 0o077:
        raise HostError("RUNTIME_INSECURE")


def get_runtime_paths(*, create: bool) -> RuntimePaths:
    raw_runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    # Chrome may launch Native Messaging hosts without XDG_RUNTIME_DIR. The
    # systemd user-runtime location is the only fallback; /tmp is never used.
    runtime_root = Path(raw_runtime) if raw_runtime else Path("/run/user") / str(os.getuid())
    if not runtime_root.is_absolute():
        raise HostError("RUNTIME_UNAVAILABLE")
    try:
        root_details = runtime_root.lstat()
    except OSError as exc:
        raise HostError("RUNTIME_UNAVAILABLE") from exc
    if (
        stat.S_ISLNK(root_details.st_mode)
        or not stat.S_ISDIR(root_details.st_mode)
        or root_details.st_uid != os.getuid()
    ):
        raise HostError("RUNTIME_INSECURE")
    if root_details.st_mode & 0o077:
        raise HostError("RUNTIME_INSECURE")

    directory = runtime_root / RUNTIME_DIR_NAME
    if create:
        _ensure_private_directory(directory, parents=False)
    elif directory.exists():
        _ensure_private_directory(directory, parents=False)

    paths = RuntimePaths(
        directory=directory,
        queue_socket=directory / QUEUE_SOCKET_NAME,
        queue_lock=directory / QUEUE_LOCK_NAME,
    )
    if len(os.fsencode(paths.queue_socket)) >= 100:
        raise HostError("RUNTIME_UNAVAILABLE")
    return paths


def _state_log_directory() -> Path:
    raw_state = os.environ.get("XDG_STATE_HOME", "")
    if raw_state and Path(raw_state).is_absolute():
        base = Path(raw_state)
    else:
        base = Path.home() / ".local" / "state"
    return base / RUNTIME_DIR_NAME


def _open_private_regular(path: Path, flags: int) -> int:
    open_flags = flags | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        open_flags |= os.O_NOFOLLOW
    fd = os.open(path, open_flags, 0o600)
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid():
            raise OSError(errno.EPERM, "unsafe private file")
        os.fchmod(fd, 0o600)
        return fd
    except Exception:
        os.close(fd)
        raise


def _safe_log_atom(value: Any) -> str:
    if type(value) is not str or not LOG_ATOM_RE.fullmatch(value):
        return "invalid"
    return value


def make_log_record(event: str, status: str, code: str, **fields: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "event": _safe_log_atom(event),
        "status": _safe_log_atom(status),
        "code": _safe_log_atom(code),
        "protocolVersion": PROTOCOL_VERSION,
        "pid": os.getpid(),
    }
    # This allowlist intentionally excludes URL, referer, origin, userAgent,
    # command lines, exception text, and stderr.
    for key in ("action", "source", "mode", "confirmation", "disposition"):
        if type(fields.get(key)) is str and LOG_ATOM_RE.fullmatch(fields[key]):
            record[key] = fields[key]
    for key in ("confirmed",):
        if type(fields.get(key)) is bool:
            record[key] = fields[key]
    mpv_error_category = fields.get("mpvErrorCategory")
    if (
        type(mpv_error_category) is str
        and mpv_error_category in ALLOWED_MPV_ERROR_CATEGORIES
    ):
        record["mpvErrorCategory"] = mpv_error_category
    for key in ("exitCode", "durationMs"):
        if _is_exact_int(fields.get(key)):
            record[key] = fields[key]
    return record


class SecureLogger:
    def __init__(
        self,
        directory: Path | None = None,
        *,
        max_bytes: int = LOG_MAX_BYTES,
        backups: int = LOG_BACKUPS,
    ) -> None:
        self.directory = directory or _state_log_directory()
        self.path = self.directory / LOG_FILE_NAME
        self.lock_path = self.directory / LOG_LOCK_NAME
        self.max_bytes = max_bytes
        self.backups = backups

    def log(self, event: str, status: str, code: str, **fields: Any) -> None:
        try:
            _ensure_private_directory(self.directory, parents=True)
            lock_fd = _open_private_regular(self.lock_path, os.O_RDWR)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                record = make_log_record(event, status, code, **fields)
                line = (
                    json.dumps(record, ensure_ascii=True, separators=(",", ":"))
                    + "\n"
                ).encode("utf-8")
                self._rotate_if_needed(len(line))
                log_fd = _open_private_regular(
                    self.path, os.O_WRONLY | os.O_APPEND
                )
                try:
                    view = memoryview(line)
                    while view:
                        written = os.write(log_fd, view)
                        if written <= 0:
                            raise OSError(errno.EIO, "short log write")
                        view = view[written:]
                finally:
                    os.close(log_fd)
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
        except (OSError, HostError, ValueError):
            # Logging must never prevent a Native Messaging response.
            return

    def _rotate_if_needed(self, incoming_bytes: int) -> None:
        try:
            current_size = self.path.lstat().st_size
        except FileNotFoundError:
            return
        details = self.path.lstat()
        if (
            stat.S_ISLNK(details.st_mode)
            or not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
        ):
            raise OSError(errno.EPERM, "unsafe log file")
        if current_size + incoming_bytes <= self.max_bytes:
            return
        for index in range(self.backups, 0, -1):
            source = self.path if index == 1 else self.path.with_name(
                f"{LOG_FILE_NAME}.{index - 1}"
            )
            target = self.path.with_name(f"{LOG_FILE_NAME}.{index}")
            try:
                source_details = source.lstat()
            except FileNotFoundError:
                continue
            if (
                stat.S_ISLNK(source_details.st_mode)
                or not stat.S_ISREG(source_details.st_mode)
                or source_details.st_uid != os.getuid()
            ):
                raise OSError(errno.EPERM, "unsafe log backup")
            if index == self.backups:
                try:
                    target_details = target.lstat()
                except FileNotFoundError:
                    target_details = None
                if target_details is not None:
                    if (
                        stat.S_ISLNK(target_details.st_mode)
                        or not stat.S_ISREG(target_details.st_mode)
                        or target_details.st_uid != os.getuid()
                    ):
                        raise OSError(errno.EPERM, "unsafe log backup")
                    target.unlink()
            os.replace(source, target)
            replaced_details = target.lstat()
            if (
                not stat.S_ISREG(replaced_details.st_mode)
                or replaced_details.st_uid != os.getuid()
            ):
                raise OSError(errno.EPERM, "unsafe rotated log")
            os.chmod(target, 0o600)


@contextlib.contextmanager
def exclusive_queue_lock(path: Path, deadline: float) -> Iterator[None]:
    try:
        fd = _open_private_regular(path, os.O_RDWR)
    except OSError as exc:
        raise HostError("RUNTIME_INSECURE") from exc
    acquired = False
    try:
        while time.monotonic() < deadline:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                time.sleep(SOCKET_RETRY_SECONDS)
        if not acquired:
            raise HostError("QUEUE_BUSY")
        yield
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


@contextlib.contextmanager
def exclusive_resolver_lock(path: Path) -> Iterator[None]:
    try:
        fd = _open_private_regular(path, os.O_RDWR)
    except OSError as exc:
        raise HostError("RUNTIME_INSECURE") from exc
    acquired = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError as exc:
            raise HostError("RESOLVER_BUSY") from exc
        yield
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def validate_socket_path(path: Path, *, make_private: bool) -> SocketIdentity:
    try:
        details = path.lstat()
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise HostError("QUEUE_SOCKET_UNSAFE") from exc
    if not stat.S_ISSOCK(details.st_mode) or details.st_uid != os.getuid():
        raise HostError("QUEUE_SOCKET_UNSAFE")
    if make_private:
        try:
            os.chmod(path, 0o600)
            details = path.lstat()
        except OSError as exc:
            raise HostError("QUEUE_SOCKET_UNSAFE") from exc
    if details.st_mode & 0o077:
        raise HostError("QUEUE_SOCKET_UNSAFE")
    return SocketIdentity(details.st_dev, details.st_ino)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise IpcReadTimeout
    return remaining


def connect_unix_socket(path: Path, deadline: float) -> socket.socket:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(_remaining(deadline))
        client.connect(os.fspath(path))
        return client
    except Exception:
        client.close()
        raise


class IpcSession:
    """Line-oriented mpv IPC client with request_id response matching."""

    def __init__(self, client: Any) -> None:
        self.client = client
        self.buffer = bytearray()
        self.messages: deque[dict[str, Any]] = deque()
        self.events: deque[dict[str, Any]] = deque()

    def close(self) -> None:
        self.client.close()

    def _decode_available_lines(self) -> None:
        while True:
            newline = self.buffer.find(b"\n")
            if newline < 0:
                if len(self.buffer) > MAX_IPC_LINE_BYTES:
                    raise HostError("MPV_IPC_PROTOCOL")
                return
            raw_line = bytes(self.buffer[:newline])
            del self.buffer[: newline + 1]
            if not raw_line.strip():
                continue
            if len(raw_line) > MAX_IPC_LINE_BYTES:
                raise HostError("MPV_IPC_PROTOCOL")
            try:
                message = strict_json_loads(raw_line.decode("utf-8"))
            except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
                raise HostError("MPV_IPC_PROTOCOL") from exc
            if type(message) is not dict:
                raise HostError("MPV_IPC_PROTOCOL")
            self.messages.append(message)

    def receive(self, deadline: float) -> dict[str, Any]:
        while True:
            self._decode_available_lines()
            if self.messages:
                return self.messages.popleft()
            try:
                self.client.settimeout(_remaining(deadline))
                chunk = self.client.recv(4096)
            except socket.timeout as exc:
                raise IpcReadTimeout from exc
            if not chunk:
                raise IpcTransportError
            self.buffer.extend(chunk)
            if len(self.buffer) > MAX_IPC_LINE_BYTES and b"\n" not in self.buffer:
                raise HostError("MPV_IPC_PROTOCOL")

    def send_request(
        self,
        command: Sequence[Any],
        deadline: float,
        *,
        request_id: int | None = None,
    ) -> int:
        actual_request_id = (
            request_id if request_id is not None else (secrets.randbits(62) + 1)
        )
        payload = json.dumps(
            {"command": list(command), "request_id": actual_request_id},
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        if len(payload) > MAX_IPC_LINE_BYTES:
            raise HostError("MPV_IPC_PROTOCOL")
        try:
            self.client.settimeout(_remaining(deadline))
            self.client.sendall(payload)
        except socket.timeout as exc:
            raise IpcReadTimeout from exc
        except OSError as exc:
            raise IpcTransportError from exc
        return actual_request_id

    def wait_for_response(self, request_id: int, deadline: float) -> dict[str, Any]:
        while True:
            message = self.receive(deadline)
            if type(message.get("event")) is str:
                self.events.append(message)
                continue
            response_id = message.get("request_id")
            if not _is_exact_int(response_id) or response_id != request_id:
                # Events and replies for other clients/commands are unrelated.
                continue
            return message

    def command(
        self,
        command: Sequence[Any],
        deadline: float,
        *,
        request_id: int | None = None,
    ) -> dict[str, Any]:
        actual_request_id = self.send_request(
            command, deadline, request_id=request_id
        )
        return self.wait_for_response(actual_request_id, deadline)


def build_stream_options(stream: StreamSpec) -> list[str]:
    options: list[str] = []
    if stream.referer:
        options.append(f"--referrer={stream.referer}")
    if stream.user_agent:
        options.append(f"--user-agent={stream.user_agent}")
    if stream.origin:
        options.append(f"--http-header-fields=Origin: {stream.origin}")
    if stream.language:
        options.append(f"--alang={build_mpv_alang(stream.language)}")
    return options


def build_mpv_alang(language: str) -> str:
    canonical = validate_language_tag(language)
    primary = canonical.split("-", 1)[0]
    if canonical == primary or primary == "x":
        return canonical
    return f"{canonical},{primary}"


YTDL_RAW_OPTIONS: tuple[tuple[str, str], ...] = (
    ("ignore-config", ""),
    ("no-plugin-dirs", ""),
    ("no-remote-components", ""),
    ("no-update", ""),
    ("no-cache-dir", ""),
    ("no-cookies-from-browser", ""),
    ("no-cookies", ""),
    ("no-playlist", ""),
    ("playlist-items", "1"),
    ("no-wait-for-video", ""),
    ("no-mark-watched", ""),
    ("socket-timeout", "5"),
    ("extractor-retries", "1"),
    ("retries", "0"),
    ("fragment-retries", "0"),
)


def build_ytdl_format(language: str) -> str:
    video = "bv[height<=1080]"
    muxed = "b[height<=1080]"
    fallback = f"{video}+ba/{muxed}"
    if not language:
        return fallback
    canonical = validate_language_tag(language)
    primary = canonical.split("-", 1)[0]
    choices: list[str] = []
    if canonical.casefold() != primary.casefold():
        choices.append(f"{video}+ba[language={canonical}]")
    choices.append(f"{video}+ba[language^={primary}]")
    if canonical.casefold() != primary.casefold():
        choices.append(f"{muxed}[language={canonical}]")
    choices.append(f"{muxed}[language^={primary}]")
    choices.append(fallback)
    return "/".join(choices)


def build_ytdl_script_options(yt_dlp_path: str) -> tuple[str, ...]:
    if (
        type(yt_dlp_path) is not str
        or not os.path.isabs(yt_dlp_path)
        or any(
            character in yt_dlp_path
            for character in ("\x00", "\r", "\n", ",", ":")
        )
    ):
        raise HostError("RESOLVER_UNAVAILABLE")
    return (
        f"ytdl_hook-ytdl_path={yt_dlp_path}",
        "ytdl_hook-try_ytdl_first=yes",
        "ytdl_hook-use_manifests=no",
        "ytdl_hook-all_formats=no",
        "ytdl_hook-force_all_formats=no",
        "ytdl_hook-thumbnails=none",
        "ytdl_hook-exclude=",
    )


def build_ytdl_file_options(stream: StreamSpec, yt_dlp_path: str) -> dict[str, str]:
    if stream.playback_kind != "yt-dlp-page":
        return {}
    return {
        "ytdl": "yes",
        "ytdl-format": build_ytdl_format(stream.language),
        "ytdl-raw-options": ",".join(
            f"{name}={value}" for name, value in YTDL_RAW_OPTIONS
        ),
        "script-opts": ",".join(build_ytdl_script_options(yt_dlp_path)),
    }


def build_mpv_args(
    mpv_path: str,
    stream: StreamSpec,
    *,
    ipc_path: Path,
    idle: bool,
    yt_dlp_path: str | None = None,
) -> list[str]:
    args = [
        mpv_path,
        "--tls-verify=yes",
        "--load-unsafe-playlists=no",
        f"--input-ipc-server={ipc_path}",
        "--idle=yes" if idle else "--idle=no",
    ]
    if yt_dlp_path:
        args.append(
            f"--script-opts-append={build_ytdl_script_options(yt_dlp_path)[0]}"
        )
    if stream.playback_kind == "yt-dlp-page":
        if not yt_dlp_path:
            raise HostError("RESOLVER_UNAVAILABLE")
        script_options = build_ytdl_script_options(yt_dlp_path)
        args.extend(f"--script-opts-append={value}" for value in script_options[1:])
        args.append("--ytdl=yes")
        args.append(f"--ytdl-format={build_ytdl_format(stream.language)}")
        args.extend(
            f"--ytdl-raw-options-append={name}={value}"
            for name, value in YTDL_RAW_OPTIONS
        )
    args.extend(build_stream_options(stream))
    args.extend(["--", stream.url])
    return args


def build_loadfile_command(
    stream: StreamSpec,
    mode: str,
    *,
    yt_dlp_path: str | None = None,
) -> list[Any]:
    if mode not in {"append", "replace"}:
        raise HostError("INVALID_REQUEST")
    options: dict[str, str] = {
        "tls-verify": "yes",
        "load-unsafe-playlists": "no",
    }
    if stream.referer:
        options["referrer"] = stream.referer
    if stream.user_agent:
        options["user-agent"] = stream.user_agent
    if stream.origin:
        options["http-header-fields"] = f"Origin: {stream.origin}"
    if stream.language:
        options["alang"] = build_mpv_alang(stream.language)
    if stream.playback_kind == "yt-dlp-page":
        if not yt_dlp_path:
            raise HostError("RESOLVER_UNAVAILABLE")
        options.update(build_ytdl_file_options(stream, yt_dlp_path))
    flag = "append-play" if mode == "append" else "replace"
    return ["loadfile", stream.url, flag, -1, options]


def find_mpv_path() -> str:
    found = shutil.which("mpv")
    if not found:
        raise HostError("MPV_NOT_FOUND")
    path = os.path.abspath(found)
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise HostError("MPV_NOT_FOUND")
    return path


def get_mpv_version(mpv_path: str) -> str | None:
    try:
        result = subprocess.run(
            [mpv_path, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1.5,
            check=False,
            close_fds=True,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    first_line = result.stdout[:512].decode("utf-8", errors="replace").splitlines()
    if not first_line:
        return None
    return first_line[0][:256]


def resolver_environment(private_directory: Path) -> dict[str, str]:
    if not private_directory.is_absolute():
        raise HostError("INVALID_REQUEST")
    private_path = os.fspath(private_directory)
    path = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    environment = {
        "HOME": private_path,
        "XDG_CONFIG_HOME": private_path,
        "XDG_CACHE_HOME": private_path,
        "XDG_DATA_HOME": private_path,
        "PATH": path,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
    }
    for name in ("SSL_CERT_FILE", "SSL_CERT_DIR"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


@contextlib.contextmanager
def temporary_resolver_workspace() -> Iterator[Path]:
    runtime = get_runtime_paths(create=True)
    workspace: Path | None = None
    try:
        workspace = Path(
            tempfile.mkdtemp(
                prefix=".resolver-run-",
                dir=runtime.directory,
            )
        )
        details = workspace.lstat()
        if (
            stat.S_ISLNK(details.st_mode)
            or not stat.S_ISDIR(details.st_mode)
            or details.st_uid != os.getuid()
        ):
            raise HostError("RUNTIME_INSECURE")
        os.chmod(workspace, 0o700)
        if workspace.lstat().st_mode & 0o077:
            raise HostError("RUNTIME_INSECURE")
        yield workspace
    except HostError:
        raise
    except OSError as exc:
        raise HostError("RUNTIME_UNAVAILABLE") from exc
    finally:
        if workspace is not None:
            with contextlib.suppress(OSError):
                shutil.rmtree(workspace)


def _stop_process_group(process: Any) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except OSError:
        pass
    if process.poll() is None:
        with contextlib.suppress(OSError, subprocess.TimeoutExpired):
            process.wait(timeout=RESOLVER_PROCESS_STOP_SECONDS)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        pass
    with contextlib.suppress(OSError, subprocess.TimeoutExpired):
        process.wait(timeout=RESOLVER_PROCESS_STOP_SECONDS)


def run_bounded_process(
    args: Sequence[str],
    *,
    timeout: float,
    stdout_limit: int = MAX_RESOLVER_STDOUT_BYTES,
    stderr_limit: int = MAX_RESOLVER_STDERR_BYTES,
) -> ProcessResult:
    if (
        not args
        or type(args[0]) is not str
        or not os.path.isabs(args[0])
        or timeout <= 0
        or stdout_limit < 0
        or stderr_limit < 0
    ):
        raise HostError("INVALID_REQUEST")
    with temporary_resolver_workspace() as workspace:
        return _run_bounded_process_in_workspace(
            args,
            timeout=timeout,
            stdout_limit=stdout_limit,
            stderr_limit=stderr_limit,
            workspace=workspace,
        )


def _run_bounded_process_in_workspace(
    args: Sequence[str],
    *,
    timeout: float,
    stdout_limit: int,
    stderr_limit: int,
    workspace: Path,
) -> ProcessResult:
    try:
        process = subprocess.Popen(
            list(args),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
            shell=False,
            cwd=os.fspath(workspace),
            env=resolver_environment(workspace),
            umask=0o077,
        )
    except (OSError, ValueError) as exc:
        raise HostError("RESOLVER_EXEC_FAILED") from exc

    selector = selectors.DefaultSelector()
    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout
    try:
        if process.stdout is None or process.stderr is None:
            raise HostError("RESOLVER_EXEC_FAILED")
        for pipe, label in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, label)

        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HostError("RESOLVER_TIMEOUT")
            events = selector.select(min(remaining, 0.1))
            for key, _mask in events:
                try:
                    chunk = os.read(key.fd, 64 * 1024)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                target = stdout if key.data == "stdout" else stderr
                limit = stdout_limit if key.data == "stdout" else stderr_limit
                target.extend(chunk)
                if len(target) > limit:
                    raise HostError("RESOLVER_OUTPUT_TOO_LARGE")

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HostError("RESOLVER_TIMEOUT")
        try:
            return_code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            raise HostError("RESOLVER_TIMEOUT") from exc
        if not _is_exact_int(return_code):
            raise HostError("RESOLVER_EXEC_FAILED")
        return ProcessResult(
            return_code=return_code,
            stdout=bytes(stdout),
            stderr=bytes(stderr),
        )
    except HostError:
        _stop_process_group(process)
        raise
    except (OSError, ValueError) as exc:
        _stop_process_group(process)
        raise HostError("RESOLVER_EXEC_FAILED") from exc
    finally:
        selector.close()
        for pipe in (process.stdout, process.stderr):
            if pipe is not None:
                with contextlib.suppress(OSError):
                    pipe.close()


def find_resolver_path(name: str) -> str | None:
    if name not in ALLOWED_RESOLVERS:
        return None
    preferred = (
        Path.home()
        / ".local"
        / "share"
        / "mpv-redirector"
        / "resolvers"
        / "bin"
        / name
    )
    candidates = [os.fspath(preferred)]
    found = shutil.which(
        name,
        path=os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    )
    if found:
        candidates.append(found)
    for candidate in candidates:
        path = os.path.abspath(candidate)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def resolver_info(name: str) -> ResolverInfo:
    path = find_resolver_path(name)
    if path is None:
        return ResolverInfo(
            name=name,
            path=None,
            version=None,
            installed=False,
            compatible=False,
            error_code="RESOLVER_UNAVAILABLE",
        )
    try:
        result = run_bounded_process(
            [path, "--version"],
            timeout=RESOLVER_VERSION_SECONDS,
            stdout_limit=4096,
            stderr_limit=4096,
        )
    except HostError as error:
        return ResolverInfo(
            name=name,
            path=path,
            version=None,
            installed=True,
            compatible=False,
            error_code=error.code,
        )
    version_bytes = result.stdout or result.stderr
    try:
        version_output = version_bytes.decode("utf-8", errors="strict")
    except UnicodeError:
        version_output = ""
    match = RESOLVER_VERSION_RE.search(version_output)
    if result.return_code != 0 or match is None:
        return ResolverInfo(
            name=name,
            path=path,
            version=None,
            installed=True,
            compatible=False,
            error_code="RESOLVER_INVALID_OUTPUT",
        )
    version_tuple = tuple(int(part) for part in match.groups())
    version = (
        f"{version_tuple[0]:04d}.{version_tuple[1]:02d}.{version_tuple[2]:02d}"
        if name == "yt-dlp"
        else ".".join(str(part) for part in version_tuple)
    )
    compatible = version_tuple >= RESOLVER_MINIMUM_VERSIONS[name]
    return ResolverInfo(
        name=name,
        path=path,
        version=version,
        installed=True,
        compatible=compatible,
        error_code=None if compatible else "RESOLVER_TOO_OLD",
    )


def public_resolver_info(info: ResolverInfo) -> dict[str, Any]:
    response: dict[str, Any] = {
        "installed": info.installed,
        "available": info.compatible,
        "compatible": info.compatible,
        "version": info.version,
    }
    if info.error_code:
        response["errorCode"] = info.error_code
    return response


def encode_netscape_cookie_jar(cookies: Sequence[ResolverCookie]) -> bytes:
    lines = ["# Netscape HTTP Cookie File", "# Generated temporarily by MPV Redirector Pro."]
    for cookie in cookies:
        domain = cookie.domain if cookie.host_only else f".{cookie.domain}"
        if cookie.http_only:
            domain = f"#HttpOnly_{domain}"
        lines.append(
            "\t".join(
                (
                    domain,
                    "FALSE" if cookie.host_only else "TRUE",
                    cookie.path,
                    "TRUE" if cookie.secure else "FALSE",
                    str(cookie.expires),
                    cookie.name,
                    cookie.value,
                )
            )
        )
    return ("\n".join(lines) + "\n").encode("utf-8")


@contextlib.contextmanager
def temporary_cookie_jar(cookies: Sequence[ResolverCookie]) -> Iterator[Path | None]:
    if not cookies:
        yield None
        return
    runtime = get_runtime_paths(create=True)
    fd = -1
    path: Path | None = None
    try:
        fd, raw_path = tempfile.mkstemp(
            prefix=".resolver-cookies-",
            suffix=".txt",
            dir=runtime.directory,
        )
        path = Path(raw_path)
        os.fchmod(fd, 0o600)
        payload = encode_netscape_cookie_jar(cookies)
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError(errno.EIO, "short cookie-jar write")
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = -1
        yield path
    except HostError:
        raise
    except OSError as exc:
        raise HostError("RUNTIME_UNAVAILABLE") from exc
    finally:
        if fd >= 0:
            with contextlib.suppress(OSError):
                os.close(fd)
        if path is not None:
            with contextlib.suppress(OSError):
                path.unlink()


def build_resolver_args(
    name: str,
    executable: str,
    page_url: str,
    cookie_jar: Path | None,
) -> list[str]:
    if name == "streamlink":
        args = [
            executable,
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
        ]
        if cookie_jar is not None:
            args.extend(["--http-cookies-file", os.fspath(cookie_jar)])
        args.extend(["--url", page_url])
        return args
    if name == "yt-dlp":
        args = [
            executable,
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-remote-components",
            "--no-update",
            "--no-cache-dir",
            "--no-cookies-from-browser",
        ]
        if cookie_jar is not None:
            args.extend(["--cookies", os.fspath(cookie_jar)])
        else:
            args.append("--no-cookies")
        args.extend(
            [
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
            ]
        )
        return args
    raise HostError("INVALID_REQUEST")


def _resolver_text(value: Any, *, max_bytes: int) -> str:
    if type(value) is not str or not value:
        return ""
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        return ""
    if len(encoded) > max_bytes or any(
        ord(char) < 0x20 and char not in {"\t", "\n", "\r"} for char in value
    ):
        return ""
    return " ".join(value.split())


def _resolver_language(value: Any) -> str:
    try:
        return validate_language_tag(value)
    except HostError:
        return ""


def _resolver_media_type(
    url: str,
    *,
    declared_type: Any = "",
    protocol: Any = "",
    extension: Any = "",
) -> str:
    hints = " ".join(
        value.lower()
        for value in (declared_type, protocol, extension)
        if type(value) is str
    )
    path = urlsplit(url).path.lower()
    if "hls" in hints or "m3u8" in hints or ".m3u8" in path:
        return "HLS"
    if "dash" in hints or "mpd" in hints or ".mpd" in path:
        return "DASH"
    if "webm" in hints or ".webm" in path:
        return "WEBM"
    if "mp4" in hints or ".mp4" in path or "m4a" in hints:
        return "MP4"
    return "MEDIA"


def _resolver_headers(value: Any, url: str) -> dict[str, str]:
    if type(value) is not dict:
        return {}
    raw_headers: dict[str, str] = {}
    for raw_name, raw_value in value.items():
        if type(raw_name) is not str or type(raw_value) is not str:
            continue
        normalized = raw_name.strip().lower()
        if normalized == "referer" and "referer" not in raw_headers:
            raw_headers["referer"] = raw_value
        elif normalized == "origin" and "origin" not in raw_headers:
            raw_headers["origin"] = raw_value
        elif normalized == "user-agent" and "userAgent" not in raw_headers:
            raw_headers["userAgent"] = raw_value

    accepted: dict[str, str] = {}
    for field in ("referer", "origin", "userAgent"):
        if field not in raw_headers:
            continue
        try:
            validated = validate_stream({"url": url, field: raw_headers[field]})
        except HostError:
            continue
        if field == "referer" and validated.referer:
            accepted[field] = validated.referer
        elif field == "origin" and validated.origin:
            accepted[field] = validated.origin
        elif field == "userAgent" and validated.user_agent:
            accepted[field] = validated.user_agent
    return accepted


def _resolved_candidate(
    resolver: str,
    url: Any,
    *,
    declared_type: Any = "",
    protocol: Any = "",
    extension: Any = "",
    quality: Any = "",
    title: Any = "",
    width: Any = None,
    height: Any = None,
    live: Any = None,
    role: str = "direct",
    headers: Any = None,
    language: Any = "",
    media_kind: str = "",
    format_id: Any = "",
    playback_kind: str = "",
) -> dict[str, Any] | None:
    try:
        validated_url = _validate_http_url(
            url,
            max_bytes=MAX_URL_BYTES,
            header=False,
            allow_fragment=True,
        )
    except HostError:
        return None
    if role not in {"master", "variant", "audio", "direct"}:
        role = "direct"
    if media_kind not in RESOLVER_MEDIA_KINDS:
        media_kind = {
            "master": "adaptive",
            "audio": "audio-only",
            "variant": "muxed",
            "direct": "muxed",
        }[role]
    has_audio, has_video = {
        "adaptive": (True, True),
        "muxed": (True, True),
        "video-only": (False, True),
        "audio-only": (True, False),
    }[media_kind]
    candidate: dict[str, Any] = {
        "resolver": resolver,
        "url": validated_url,
        "type": _resolver_media_type(
            validated_url,
            declared_type=declared_type,
            protocol=protocol,
            extension=extension,
        ),
        "role": role,
        "mediaKind": media_kind,
        "hasAudio": has_audio,
        "hasVideo": has_video,
    }
    normalized_quality = _resolver_text(
        str(quality) if type(quality) in {int, float} else quality,
        max_bytes=MAX_RESOLVER_QUALITY_BYTES,
    )
    if normalized_quality:
        candidate["quality"] = normalized_quality
    normalized_title = _resolver_text(title, max_bytes=MAX_RESOLVER_TITLE_BYTES)
    if normalized_title:
        candidate["title"] = normalized_title
    for name, value in (("width", width), ("height", height)):
        if _is_exact_int(value) and 0 < value <= 16_384:
            candidate[name] = value
    if _is_exact_bool(live):
        candidate["live"] = live
    normalized_language = _resolver_language(language)
    if normalized_language:
        candidate["language"] = normalized_language
    normalized_format_id = _resolver_text(
        format_id,
        max_bytes=MAX_RESOLVER_FORMAT_ID_BYTES,
    )
    if normalized_format_id:
        candidate["formatId"] = normalized_format_id
    if playback_kind:
        if playback_kind not in ALLOWED_PLAYBACK_KINDS:
            return None
        candidate["playbackKind"] = playback_kind
    candidate.update(_resolver_headers(headers, validated_url))
    return candidate


def _append_resolved_candidate(
    candidates: list[dict[str, Any]],
    indexes: dict[str, int],
    candidate: dict[str, Any] | None,
) -> str:
    if candidate is None:
        return "ignored"
    url = candidate["url"]
    existing_index = indexes.get(url)
    if existing_index is not None:
        existing = candidates[existing_index]
        if existing.get("role") != "master" and candidate.get("role") == "master":
            candidates[existing_index] = candidate
        return "duplicate"
    if len(candidates) >= MAX_RESOLVER_CANDIDATES:
        return "full"
    indexes[url] = len(candidates)
    candidates.append(candidate)
    return "added"


def decode_resolver_json(data: bytes) -> dict[str, Any]:
    if not data:
        raise HostError("RESOLVER_INVALID_OUTPUT")
    try:
        decoded = data.decode("utf-8", errors="strict")
        value = strict_json_loads(decoded)
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise HostError("RESOLVER_INVALID_OUTPUT") from exc
    if type(value) is not dict:
        raise HostError("RESOLVER_INVALID_OUTPUT")
    return value


def parse_streamlink_output(data: bytes) -> ResolverParseResult:
    payload = decode_resolver_json(data)
    raw_streams = payload.get("streams")
    if raw_streams is None and type(payload.get("error")) is str:
        return ResolverParseResult(())
    if type(raw_streams) is not dict:
        raise HostError("RESOLVER_INVALID_OUTPUT")
    metadata = payload.get("metadata")
    title = metadata.get("title", "") if type(metadata) is dict else ""
    candidates: list[dict[str, Any]] = []
    indexes: dict[str, int] = {}
    truncated = False
    aliases = {"best", "worst", "best-unfiltered", "worst-unfiltered"}
    items = sorted(raw_streams.items(), key=lambda item: item[0] in aliases)
    for name, raw_stream in items:
        if type(name) is not str or type(raw_stream) is not dict:
            continue
        stream_type = raw_stream.get("type", "")
        headers = raw_stream.get("headers")
        master_url = raw_stream.get("master")
        if master_url:
            result = _append_resolved_candidate(
                candidates,
                indexes,
                _resolved_candidate(
                    "streamlink",
                    master_url,
                    declared_type="hls",
                    quality="Auto",
                    title=title,
                    role="master",
                    headers=headers,
                ),
            )
            truncated = truncated or result == "full"
        normalized_stream_type = str(stream_type).lower()
        if normalized_stream_type.startswith("dash"):
            # Streamlink exposes every DASH quality under the same MPD URL.
            # MPV should receive that adaptive manifest once, labelled Auto.
            role = "master"
            quality = "Auto"
        else:
            role = "audio" if "audio" in name.lower() else (
                "variant" if normalized_stream_type.startswith("hls") else "direct"
            )
            quality = "" if name in aliases else name
        result = _append_resolved_candidate(
            candidates,
            indexes,
            _resolved_candidate(
                "streamlink",
                raw_stream.get("url"),
                declared_type=stream_type,
                quality=quality,
                title=title,
                role=role,
                headers=headers,
            ),
        )
        truncated = truncated or result == "full"
    return ResolverParseResult(tuple(candidates), truncated)


def _yt_dlp_infos(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if "entries" not in payload:
        return [payload]
    entries = payload["entries"]
    if type(entries) is not list:
        raise HostError("RESOLVER_INVALID_OUTPUT")
    result: list[dict[str, Any]] = []
    for entry in entries[:4]:
        if entry is None:
            continue
        if type(entry) is not dict:
            raise HostError("RESOLVER_INVALID_OUTPUT")
        result.append(entry)
    return result


def _yt_dlp_is_drm(value: Mapping[str, Any]) -> bool:
    if value.get("has_drm") is True:
        return True
    family = value.get("drm_family")
    return type(family) is str and family.lower() not in {"", "none"}


def _yt_dlp_codec_state(value: Any) -> bool | None:
    if type(value) is not str:
        return None
    normalized = value.strip().lower()
    if normalized == "none":
        return False
    if normalized:
        return True
    return None


def _yt_dlp_av_completeness(raw_format: Mapping[str, Any]) -> tuple[bool, bool]:
    video_state = _yt_dlp_codec_state(raw_format.get("vcodec"))
    audio_state = _yt_dlp_codec_state(raw_format.get("acodec"))
    extension = str(raw_format.get("ext", "")).strip().lower()
    audio_extensions = {"aac", "flac", "m4a", "mka", "mp3", "oga", "ogg", "opus", "wav"}
    video_extensions = {"flv", "mkv", "mov", "mp4", "mpeg", "ts", "webm"}
    has_dimensions = any(
        _is_exact_int(raw_format.get(name)) and raw_format[name] > 0
        for name in ("width", "height")
    )
    audio_channels = raw_format.get("audio_channels")
    has_audio_channels = (
        type(audio_channels) in {int, float}
        and not isinstance(audio_channels, bool)
        and math.isfinite(audio_channels)
        and audio_channels > 0
    )
    has_audio_evidence = (
        audio_state is True
        or has_audio_channels
        or extension in audio_extensions
    )

    if video_state is None:
        has_video = has_dimensions or (
            not has_audio_evidence and extension in video_extensions
        )
    else:
        has_video = video_state
    if audio_state is None:
        has_audio = has_audio_channels or (
            video_state is not True and extension in audio_extensions
        ) or (
            video_state is False and not has_dimensions
        )
    else:
        has_audio = audio_state
    return has_audio, has_video


def _yt_dlp_media_kind(has_audio: bool, has_video: bool) -> str:
    if has_audio and has_video:
        return "muxed"
    if has_video:
        return "video-only"
    return "audio-only"


def _yt_dlp_number(value: Any) -> float:
    if type(value) not in {int, float} or not math.isfinite(value):
        return 0.0
    return float(value)


def _yt_dlp_language_match(
    language: str,
    preferred_languages: Sequence[str],
) -> int:
    if not language:
        return 0
    normalized = language.casefold()
    primary = normalized.split("-", 1)[0]
    for index, preferred in enumerate(preferred_languages):
        preferred_normalized = preferred.casefold()
        preference_score = (MAX_PREFERRED_LANGUAGES - index) * 2
        if normalized == preferred_normalized:
            return preference_score + 1
        if primary == preferred_normalized.split("-", 1)[0]:
            return preference_score
    return 0


def _yt_dlp_model_sort_key(
    model: YtDlpFormatModel,
    preferred_languages: Sequence[str],
) -> tuple[float, ...]:
    raw_format = model.raw
    note = str(raw_format.get("format_note", "")).casefold()
    return (
        float(_yt_dlp_language_match(model.language, preferred_languages)),
        float(model.requested),
        float("default" in note or "original" in note),
        float(not any(marker in note for marker in ("drc", "audio description", "descriptive"))),
        _yt_dlp_number(raw_format.get("language_preference")),
        _yt_dlp_number(raw_format.get("preference")),
        _yt_dlp_number(raw_format.get("quality")),
        _yt_dlp_number(raw_format.get("height")),
        _yt_dlp_number(raw_format.get("width")),
        _yt_dlp_number(raw_format.get("tbr")),
        _yt_dlp_number(raw_format.get("vbr")),
        _yt_dlp_number(raw_format.get("abr")),
        _yt_dlp_number(raw_format.get("fps")),
        float(model.index),
    )


def _yt_dlp_preferred_manifest_language(
    models: Sequence[YtDlpFormatModel],
    preferred_languages: Sequence[str],
) -> str:
    audio_models = [model for model in models if model.has_audio]
    languages = [model.language for model in audio_models if model.language]
    for preferred in preferred_languages:
        preferred_primary = preferred.casefold().split("-", 1)[0]
        if any(
            language.casefold() == preferred.casefold()
            or language.casefold().split("-", 1)[0] == preferred_primary
            for language in languages
        ):
            return preferred
    unique_languages = list(dict.fromkeys(language.casefold() for language in languages))
    if len(unique_languages) == 1 and languages:
        return languages[0]

    marked = [
        model
        for model in audio_models
        if model.language
        and any(
            marker in str(model.raw.get("format_note", "")).casefold()
            for marker in ("default", "original")
        )
    ]
    if marked:
        return max(marked, key=lambda model: _yt_dlp_model_sort_key(model, ())).language

    ranked_languages = sorted(
        (model for model in audio_models if model.language),
        key=lambda model: _yt_dlp_number(model.raw.get("language_preference")),
        reverse=True,
    )
    if ranked_languages:
        best_preference = _yt_dlp_number(ranked_languages[0].raw.get("language_preference"))
        second_preference = (
            _yt_dlp_number(ranked_languages[1].raw.get("language_preference"))
            if len(ranked_languages) > 1
            else float("-inf")
        )
        if best_preference > second_preference:
            return ranked_languages[0].language
    return ""


def _yt_dlp_format_model(
    raw_format: Mapping[str, Any],
    *,
    index: int,
    requested_ids: frozenset[str],
) -> YtDlpFormatModel | None:
    if _yt_dlp_is_drm(raw_format):
        return None
    protocol = raw_format.get("protocol", "")
    if type(protocol) is str and protocol.lower() == "mhtml":
        return None
    has_audio, has_video = _yt_dlp_av_completeness(raw_format)
    if not has_audio and not has_video:
        return None
    raw_format_id = raw_format.get("format_id")
    return YtDlpFormatModel(
        raw=raw_format,
        index=index,
        has_audio=has_audio,
        has_video=has_video,
        media_kind=_yt_dlp_media_kind(has_audio, has_video),
        language=_resolver_language(raw_format.get("language")),
        requested=type(raw_format_id) is str and raw_format_id in requested_ids,
    )


def _yt_dlp_quality(model: YtDlpFormatModel) -> Any:
    height = model.raw.get("height")
    return model.raw.get("format_note") or (
        f"{height}p"
        if _is_exact_int(height) and height > 0
        else model.raw.get("format_id", "")
    )


def _yt_dlp_candidate_sort_key(
    candidate: Mapping[str, Any],
    model_key: tuple[float, ...],
    preferred_languages: Sequence[str],
) -> tuple[float, ...]:
    media_kind = candidate.get("mediaKind")
    complete_av = media_kind in {"adaptive", "muxed"}
    media_priority = {
        "adaptive": 4,
        "muxed": 3,
        "video-only": 2,
        "audio-only": 1,
    }.get(media_kind, 0)
    return (
        float(complete_av),
        float(_yt_dlp_language_match(str(candidate.get("language", "")), preferred_languages)),
        float(media_priority),
        *model_key,
    )


def parse_yt_dlp_output(
    data: bytes,
    preferred_languages: Sequence[str] = (),
) -> ResolverParseResult:
    payload = decode_resolver_json(data)
    normalized_preferences = tuple(
        validate_language_tag(language) for language in preferred_languages
    )
    modeled_candidates: list[
        tuple[tuple[float, ...], dict[str, Any], int]
    ] = []
    candidate_indexes: dict[str, int] = {}

    def add_candidate(
        candidate: dict[str, Any] | None,
        sort_key: tuple[float, ...],
        info_index: int,
    ) -> None:
        if candidate is None:
            return
        url = candidate["url"]
        existing_index = candidate_indexes.get(url)
        if existing_index is not None:
            if sort_key > modeled_candidates[existing_index][0]:
                modeled_candidates[existing_index] = (
                    sort_key,
                    candidate,
                    info_index,
                )
            return
        candidate_indexes[url] = len(modeled_candidates)
        modeled_candidates.append((sort_key, candidate, info_index))

    for info_index, info in enumerate(_yt_dlp_infos(payload)):
        if _yt_dlp_is_drm(info):
            continue
        title = info.get("title", "")
        live = info.get("is_live")
        root_headers = info.get("http_headers")
        formats = info.get("formats", [])
        if type(formats) is not list:
            raise HostError("RESOLVER_INVALID_OUTPUT")
        requested_formats = info.get("requested_formats", [])
        requested_ids = frozenset(
            raw_format.get("format_id")
            for raw_format in requested_formats
            if type(raw_format) is dict and type(raw_format.get("format_id")) is str
        ) if type(requested_formats) is list else frozenset()

        models: list[YtDlpFormatModel] = []
        for index, raw_format in enumerate(formats):
            if type(raw_format) is not dict:
                continue
            model = _yt_dlp_format_model(
                raw_format,
                index=index,
                requested_ids=requested_ids,
            )
            if model is not None:
                models.append(model)

        root_url = info.get("url")
        if (
            info.get("_type") not in {"url", "url_transparent", "playlist", "multi_video"}
            and root_url != info.get("webpage_url")
            and root_url != info.get("original_url")
            and root_url is not None
        ):
            root_model = _yt_dlp_format_model(
                info,
                index=len(formats),
                requested_ids=requested_ids,
            )
            if root_model is not None:
                models.append(root_model)

        manifest_groups: dict[str, list[YtDlpFormatModel]] = {}
        for model in models:
            manifest_url = model.raw.get("manifest_url")
            if type(manifest_url) is str and manifest_url:
                manifest_groups.setdefault(manifest_url, []).append(model)

        for manifest_url, group in manifest_groups.items():
            group_has_audio = any(model.has_audio for model in group)
            group_has_video = any(model.has_video for model in group)
            media_kind = (
                "adaptive"
                if group_has_audio and group_has_video
                else _yt_dlp_media_kind(group_has_audio, group_has_video)
            )
            representative = max(
                group,
                key=lambda model: _yt_dlp_model_sort_key(
                    model,
                    normalized_preferences,
                ),
            )
            raw_format = representative.raw
            role = {
                "adaptive": "master",
                "audio-only": "audio",
                "video-only": "variant",
            }[media_kind]
            language = (
                _yt_dlp_preferred_manifest_language(group, normalized_preferences)
                if media_kind == "adaptive"
                else representative.language
            )
            candidate = _resolved_candidate(
                "yt-dlp",
                manifest_url,
                declared_type=raw_format.get("protocol", ""),
                protocol=raw_format.get("protocol", ""),
                extension=raw_format.get("ext", ""),
                quality="Auto" if media_kind == "adaptive" else _yt_dlp_quality(representative),
                title=title,
                width=raw_format.get("width"),
                height=raw_format.get("height"),
                live=live,
                role=role,
                headers=raw_format.get("http_headers", root_headers),
                language=language,
                media_kind=media_kind,
                format_id=raw_format.get("format_id", ""),
            )
            if candidate is not None:
                model_key = _yt_dlp_model_sort_key(representative, normalized_preferences)
                add_candidate(
                    candidate,
                    _yt_dlp_candidate_sort_key(
                        candidate,
                        model_key,
                        normalized_preferences,
                    ),
                    info_index,
                )

        for model in models:
            raw_format = model.raw
            media_type = _resolver_media_type(
                str(raw_format.get("url", "")),
                declared_type=raw_format.get("protocol", ""),
                protocol=raw_format.get("protocol", ""),
                extension=raw_format.get("ext", ""),
            )
            role = (
                "audio"
                if model.media_kind == "audio-only"
                else "variant" if media_type in {"HLS", "DASH"} else "direct"
            )
            candidate = _resolved_candidate(
                "yt-dlp",
                raw_format.get("url"),
                declared_type=raw_format.get("protocol", ""),
                protocol=raw_format.get("protocol", ""),
                extension=raw_format.get("ext", ""),
                quality=_yt_dlp_quality(model),
                title=title,
                width=raw_format.get("width"),
                height=raw_format.get("height"),
                live=live,
                role=role,
                headers=raw_format.get("http_headers", root_headers),
                language=model.language,
                media_kind=model.media_kind,
                format_id=raw_format.get("format_id", ""),
            )
            if candidate is not None:
                model_key = _yt_dlp_model_sort_key(model, normalized_preferences)
                add_candidate(
                    candidate,
                    _yt_dlp_candidate_sort_key(
                        candidate,
                        model_key,
                        normalized_preferences,
                    ),
                    info_index,
                )

    complete_info_indexes = {
        info_index
        for _sort_key, candidate, info_index in modeled_candidates
        if candidate.get("mediaKind") in {"adaptive", "muxed"}
    }
    modeled_candidates = [
        item
        for item in modeled_candidates
        if item[2] not in complete_info_indexes
        or item[1].get("mediaKind") in {"adaptive", "muxed"}
    ]
    modeled_candidates.sort(key=lambda item: item[0], reverse=True)
    truncated = len(modeled_candidates) > MAX_RESOLVER_CANDIDATES
    return ResolverParseResult(
        tuple(
            candidate
            for _sort_key, candidate, _info_index in modeled_candidates[:MAX_RESOLVER_CANDIDATES]
        ),
        truncated,
    )


def parse_resolver_output(
    name: str,
    data: bytes,
    *,
    preferred_languages: Sequence[str] = (),
) -> ResolverParseResult:
    if name == "streamlink":
        return parse_streamlink_output(data)
    if name == "yt-dlp":
        return parse_yt_dlp_output(data, preferred_languages)
    raise HostError("INVALID_REQUEST")


def spawn_mpv(args: Sequence[str]) -> Any:
    try:
        return subprocess.Popen(
            list(args),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
            shell=False,
            cwd=os.fspath(Path.home()),
            env=os.environ.copy(),
            umask=0o077,
        )
    except (OSError, ValueError) as exc:
        raise HostError("MPV_EXEC_FAILED") from exc


def _process_exit_code(process: Any) -> int | None:
    try:
        value = process.poll()
    except Exception:
        return None
    return value if _is_exact_int(value) else None


def _mpv_process_exit_error(exit_code: int) -> HostError:
    # mpv documents exit status 2 as an input that could not be played. Keep
    # initialization, signal and unknown exits under the generic early-exit
    # code, while preserving the numeric status for safe diagnostics.
    code = "MPV_LOAD_FAILED" if exit_code == 2 else "MPV_EXITED_EARLY"
    return HostError(code, exit_code=exit_code)


def _process_exit_code_after_grace(
    process: Any, deadline: float
) -> int | None:
    """Give a closing IPC peer a moment to publish its process exit code.

    mpv closes its IPC socket just before ``Popen.poll()`` necessarily starts
    returning the final status.  Without this short, bounded grace period a
    normal early mpv exit is intermittently misreported as an IPC protocol
    violation.
    """

    grace_deadline = min(
        deadline,
        time.monotonic() + PROCESS_EXIT_GRACE_SECONDS,
    )
    while True:
        exit_code = _process_exit_code(process)
        if exit_code is not None:
            return exit_code
        remaining = grace_deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(0.01, remaining))


def stop_spawned_process(process: Any) -> None:
    if _process_exit_code(process) is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=PROCESS_STOP_SECONDS)
        return
    except Exception:
        pass
    try:
        process.kill()
        process.wait(timeout=PROCESS_STOP_SECONDS)
    except Exception:
        return


def remove_socket_after_process_exit(path: Path, process: Any) -> None:
    if _process_exit_code(process) is None:
        return
    try:
        validate_socket_path(path, make_private=False)
        path.unlink()
    except (FileNotFoundError, HostError, OSError):
        return


def wait_for_spawned_ipc(
    socket_path: Path, process: Any, deadline: float
) -> IpcSession:
    while time.monotonic() < deadline:
        exit_code = _process_exit_code(process)
        if exit_code is not None:
            raise _mpv_process_exit_error(exit_code)
        try:
            validate_socket_path(socket_path, make_private=True)
        except FileNotFoundError:
            time.sleep(SOCKET_RETRY_SECONDS)
            continue
        try:
            return IpcSession(connect_unix_socket(socket_path, deadline))
        except (ConnectionRefusedError, FileNotFoundError):
            time.sleep(SOCKET_RETRY_SECONDS)
        except socket.timeout:
            time.sleep(SOCKET_RETRY_SECONDS)
        except OSError as exc:
            if exc.errno in {errno.ECONNREFUSED, errno.ENOENT}:
                time.sleep(SOCKET_RETRY_SECONDS)
                continue
            raise HostError("MPV_IPC_PROTOCOL") from exc
    exit_code = _process_exit_code(process)
    if exit_code is not None:
        raise _mpv_process_exit_error(exit_code)
    raise HostError("MPV_IPC_TIMEOUT")


def confirm_loaded(
    session: IpcSession,
    expected_url: str,
    deadline: float,
    *,
    process: Any | None,
    accept_file_loaded_event: bool,
) -> str:
    # `path` changes as soon as mpv accepts an input. It does not mean that a
    # demuxer opened the stream, and treating it as playback confirmation lets
    # a process fail immediately after the host has already reported success.
    # A freshly spawned process and an explicit replacement must additionally
    # emit `file-loaded` or expose a non-empty `file-format`, which is only
    # available after demuxer startup. Queue append is acknowledged separately
    # by the successful IPC command because it is not expected to load now.
    require_loaded_evidence = process is not None or accept_file_loaded_event
    primary_deadline = deadline
    effective_deadline = deadline
    pending_requests: dict[int, tuple[int, str]] = {}
    probe_results: dict[int, dict[str, bool | None]] = {}
    next_probe_generation = 1
    next_probe = 0.0
    path_matches = False
    loaded_confirmation: str | None = None
    confirmation_not_before: float | None = None
    file_loaded_min_generation: int | None = None

    def open_correlation_settle() -> float:
        """Open only the short, hard-capped grace needed to correlate evidence."""

        nonlocal effective_deadline
        settle_deadline = min(
            time.monotonic() + LOAD_CONFIRM_SETTLE_SECONDS,
            primary_deadline + LOAD_CONFIRM_SETTLE_SECONDS,
        )
        effective_deadline = max(effective_deadline, settle_deadline)
        return settle_deadline

    def record_loaded_evidence(confirmation: str) -> None:
        nonlocal loaded_confirmation, confirmation_not_before
        if loaded_confirmation is None or confirmation == "file-loaded":
            loaded_confirmation = confirmation
        if confirmation_not_before is None:
            confirmation_not_before = open_correlation_settle()

    def confirmed_result() -> str | None:
        if not path_matches:
            return None
        if not require_loaded_evidence:
            return "path-property"
        if loaded_confirmation is None or confirmation_not_before is None:
            return None
        if time.monotonic() < confirmation_not_before:
            return None
        if process is not None:
            exit_code = _process_exit_code(process)
            if exit_code is not None:
                raise _mpv_process_exit_error(exit_code)
        return loaded_confirmation

    def consider_probe(generation: int) -> None:
        nonlocal path_matches, next_probe
        result = probe_results.get(generation)
        if result is None:
            return
        if (
            (result["path"] is True or result["file-format"] is True)
            and (result["path"] is None or result["file-format"] is None)
        ):
            # One positive half of an in-flight pair may arrive immediately
            # before the primary deadline. Keep reading only long enough for
            # the other half; never restart the full playback deadline.
            open_correlation_settle()
        if result["path"] is True:
            path_matches = True
            if result["file-format"] is True:
                record_loaded_evidence("demuxer-property")
            elif (
                file_loaded_min_generation is not None
                and generation >= file_loaded_min_generation
            ):
                # mpv events have no request id. Re-probing path after the
                # event ties it to the expected item instead of a stale file.
                record_loaded_evidence("file-loaded")
        if result["path"] is not None and result["file-format"] is not None:
            # A complete non-matching pair should be followed immediately; it
            # must never lend one property's evidence to another generation.
            if loaded_confirmation is None:
                next_probe = 0.0
            for old_generation in list(probe_results):
                if old_generation < generation - 8:
                    probe_results.pop(old_generation, None)

    def consume_queued_events() -> None:
        nonlocal file_loaded_min_generation, next_probe
        while session.events:
            event = session.events.popleft()
            if (
                event.get("event") == "end-file"
                and event.get("reason") == "error"
                and accept_file_loaded_event
            ):
                raise HostError(
                    "MPV_LOAD_FAILED",
                    mpv_error_category=_mpv_file_error_category(
                        event.get("file_error")
                    ),
                )
            if event.get("event") == "file-loaded" and accept_file_loaded_event:
                file_loaded_min_generation = next_probe_generation
                next_probe = 0.0
                # Events carry no request id. A late event may open only the
                # hard-capped window needed for one post-event path probe.
                open_correlation_settle()

    while True:
        # Prefer an already received load-error event to the less specific
        # process status. mpv may enqueue `end-file:error` immediately before
        # exiting, and polling first loses that useful classification.
        consume_queued_events()

        if process is not None:
            exit_code = _process_exit_code(process)
            if exit_code is not None:
                raise _mpv_process_exit_error(exit_code)

        confirmation = confirmed_result()
        if confirmation is not None:
            return confirmation

        now = time.monotonic()
        if now >= effective_deadline:
            break
        post_event_probe_due = (
            file_loaded_min_generation is not None
            and next_probe_generation == file_loaded_min_generation
            and now < effective_deadline
        )
        if (
            (now < primary_deadline or post_event_probe_due)
            and now >= next_probe
            and loaded_confirmation is None
        ):
            try:
                generation = next_probe_generation
                next_probe_generation += 1
                probe_results[generation] = {
                    "path": None,
                    "file-format": None,
                }
                probe_deadline = (
                    effective_deadline
                    if post_event_probe_due
                    else primary_deadline
                )
                request_id = session.send_request(
                    ["get_property", "path"], probe_deadline
                )
                pending_requests[request_id] = (generation, "path")
                if require_loaded_evidence:
                    request_id = session.send_request(
                        ["get_property", "file-format"], probe_deadline
                    )
                    pending_requests[request_id] = (generation, "file-format")
                else:
                    probe_results[generation]["file-format"] = False
            except IpcReadTimeout:
                break
            except IpcTransportError as exc:
                if process is not None:
                    exit_code = _process_exit_code_after_grace(
                        process, effective_deadline
                    )
                    if exit_code is not None:
                        raise _mpv_process_exit_error(exit_code) from exc
                    raise HostError("MPV_IPC_PROTOCOL") from exc
                raise HostError("QUEUE_UNRESPONSIVE") from exc
            next_probe = now + 0.12

        receive_deadline = min(effective_deadline, time.monotonic() + 0.10)
        if (
            path_matches
            and confirmation_not_before is not None
            and confirmation_not_before > time.monotonic()
        ):
            receive_deadline = min(receive_deadline, confirmation_not_before)
        try:
            message = session.receive(receive_deadline)
        except IpcReadTimeout:
            continue
        except IpcTransportError as exc:
            if process is not None:
                exit_code = _process_exit_code_after_grace(
                    process,
                    effective_deadline,
                )
                if exit_code is not None:
                    raise _mpv_process_exit_error(exit_code) from exc
                raise HostError("MPV_IPC_PROTOCOL") from exc
            raise HostError("QUEUE_UNRESPONSIVE") from exc
        if type(message.get("event")) is str:
            session.events.append(message)
            continue
        response_id = message.get("request_id")
        if not _is_exact_int(response_id) or response_id not in pending_requests:
            continue
        generation, property_name = pending_requests.pop(response_id)
        result = probe_results.get(generation)
        if result is None:
            continue
        if property_name == "path":
            result[property_name] = (
                message.get("error") == "success"
                and message.get("data") == expected_url
            )
        else:
            result[property_name] = (
                message.get("error") == "success"
                and type(message.get("data")) is str
                and bool(message["data"])
            )
        consider_probe(generation)

    consume_queued_events()
    if process is not None:
        exit_code = _process_exit_code(process)
        if exit_code is not None:
            raise _mpv_process_exit_error(exit_code)
    confirmation = confirmed_result()
    if confirmation is not None:
        return confirmation
    if path_matches and require_loaded_evidence and loaded_confirmation is None:
        raise HostError("MPV_DEMUXER_TIMEOUT")
    raise HostError("MPV_CONFIRM_TIMEOUT")


def _new_socket_path(runtime: RuntimePaths) -> Path:
    for _ in range(8):
        candidate = runtime.directory / f"new-{secrets.token_hex(6)}.sock"
        if len(os.fsencode(candidate)) >= 100:
            raise HostError("RUNTIME_UNAVAILABLE")
        try:
            candidate.lstat()
        except FileNotFoundError:
            return candidate
    raise HostError("RUNTIME_UNAVAILABLE")


def _run_spawned_play(
    mpv_path: str,
    stream: StreamSpec,
    socket_path: Path,
    *,
    idle: bool,
    deadline: float,
) -> str:
    yt_dlp_path = find_resolver_path("yt-dlp")
    args = build_mpv_args(
        mpv_path,
        stream,
        ipc_path=socket_path,
        idle=idle,
        yt_dlp_path=yt_dlp_path,
    )
    process = spawn_mpv(args)
    session: IpcSession | None = None
    try:
        session = wait_for_spawned_ipc(socket_path, process, deadline)
        return confirm_loaded(
            session,
            stream.url,
            deadline,
            process=process,
            accept_file_loaded_event=True,
        )
    except HostError:
        stop_spawned_process(process)
        remove_socket_after_process_exit(socket_path, process)
        raise
    except Exception:
        stop_spawned_process(process)
        remove_socket_after_process_exit(socket_path, process)
        raise
    finally:
        if session is not None:
            session.close()


def play_new(mpv_path: str, stream: StreamSpec, runtime: RuntimePaths) -> PlayResult:
    deadline = time.monotonic() + PLAY_DEADLINE_SECONDS
    confirmation = _run_spawned_play(
        mpv_path,
        stream,
        _new_socket_path(runtime),
        idle=False,
        deadline=deadline,
    )
    return PlayResult(
        mode="new",
        confirmation=confirmation,
        disposition="launched-new",
    )


def _connect_existing_queue(path: Path, deadline: float) -> IpcSession | None:
    try:
        original = validate_socket_path(path, make_private=False)
    except FileNotFoundError:
        return None

    for attempt in range(2):
        try:
            return IpcSession(connect_unix_socket(path, min(deadline, time.monotonic() + 0.35)))
        except FileNotFoundError:
            return None
        except IpcReadTimeout as exc:
            raise HostError("QUEUE_UNRESPONSIVE") from exc
        except socket.timeout as exc:
            raise HostError("QUEUE_UNRESPONSIVE") from exc
        except OSError as exc:
            if exc.errno != errno.ECONNREFUSED:
                raise HostError("QUEUE_UNRESPONSIVE") from exc
            if attempt == 0:
                time.sleep(SOCKET_RETRY_SECONDS)

    # Only a socket that refused two connections and is still the same inode is
    # stale. A responsive/live socket is never unlinked.
    try:
        current = validate_socket_path(path, make_private=False)
    except FileNotFoundError:
        return None
    if current != original:
        raise HostError("QUEUE_UNRESPONSIVE")
    try:
        path.unlink()
    except OSError as exc:
        raise HostError("QUEUE_SOCKET_UNSAFE") from exc
    return None


def _require_ipc_success(response: Mapping[str, Any]) -> None:
    if response.get("error") != "success":
        raise HostError("MPV_IPC_REJECTED")


def play_queue_mode(
    mpv_path: str,
    stream: StreamSpec,
    runtime: RuntimePaths,
    mode: str,
) -> PlayResult:
    total_deadline = time.monotonic() + PLAY_DEADLINE_SECONDS
    yt_dlp_path = find_resolver_path("yt-dlp")
    lock_deadline = min(total_deadline, time.monotonic() + QUEUE_LOCK_SECONDS)
    with exclusive_queue_lock(runtime.queue_lock, lock_deadline):
        session = _connect_existing_queue(runtime.queue_socket, total_deadline)
        if session is None:
            confirmation = _run_spawned_play(
                mpv_path,
                stream,
                runtime.queue_socket,
                idle=True,
                deadline=total_deadline,
            )
            return PlayResult(
                mode=mode,
                confirmation=confirmation,
                disposition="launched-managed",
            )

        try:
            try:
                response = session.command(
                    build_loadfile_command(
                        stream,
                        mode,
                        yt_dlp_path=yt_dlp_path,
                    ),
                    total_deadline,
                )
            except (IpcReadTimeout, IpcTransportError) as exc:
                raise HostError("QUEUE_UNRESPONSIVE") from exc
            _require_ipc_success(response)
            if mode == "append":
                return PlayResult(
                    mode=mode,
                    confirmation="ipc-response",
                    disposition="queued",
                )
            confirmation = confirm_loaded(
                session,
                stream.url,
                total_deadline,
                process=None,
                accept_file_loaded_event=True,
            )
            return PlayResult(
                mode=mode,
                confirmation=confirmation,
                disposition="replaced",
            )
        finally:
            session.close()


def inspect_queue_state(runtime: RuntimePaths) -> dict[str, Any]:
    if not runtime.directory.exists() or not runtime.queue_socket.exists():
        return {"state": "missing", "socketPresent": False, "responsive": False}
    try:
        validate_socket_path(runtime.queue_socket, make_private=False)
    except FileNotFoundError:
        return {"state": "missing", "socketPresent": False, "responsive": False}
    except HostError:
        return {"state": "unsafe", "socketPresent": True, "responsive": False}

    deadline = time.monotonic() + HEALTH_IPC_SECONDS
    try:
        session = IpcSession(connect_unix_socket(runtime.queue_socket, deadline))
    except ConnectionRefusedError:
        return {"state": "stale", "socketPresent": True, "responsive": False}
    except (OSError, socket.timeout, IpcReadTimeout, IpcTransportError):
        return {
            "state": "unresponsive",
            "socketPresent": True,
            "responsive": False,
        }
    try:
        response = session.command(
            ["get_property", "idle-active"], deadline, request_id=1
        )
        responsive = response.get("error") == "success"
        return {
            "state": "running" if responsive else "unresponsive",
            "socketPresent": True,
            "responsive": responsive,
        }
    except (HostError, IpcReadTimeout, IpcTransportError):
        return {
            "state": "unresponsive",
            "socketPresent": True,
            "responsive": False,
        }
    finally:
        session.close()


def base_response(request: HostRequest | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "hostVersion": HOST_VERSION,
    }
    if request is not None:
        response["action"] = request.action
        response["requestProtocolVersion"] = request.request_protocol_version
        if request.request_id is not None:
            response["requestId"] = request.request_id
    return response


def error_response(
    error: HostError,
    request: HostRequest | None = None,
) -> dict[str, Any]:
    response = base_response(request)
    response.update(
        {
            "ok": False,
            "errorCode": error.code,
            "error": error.public_message,
        }
    )
    if request is not None and request.action == "play":
        response["confirmed"] = False
        if request.mode is not None:
            response["mode"] = request.mode
    if error.exit_code is not None:
        response["exitCode"] = error.exit_code
    return response


def _encoded_response_size(response: Mapping[str, Any]) -> int:
    return len(
        json.dumps(
            response,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )


def _resolver_attempt_record(
    info: ResolverInfo,
    status: str,
    error_code: str | None = None,
    count: int = 0,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "resolver": info.name,
        "available": info.compatible,
        "compatible": info.compatible,
        "status": status,
        "count": max(0, min(count, MAX_RESOLVER_CANDIDATES)),
    }
    if info.version:
        record["version"] = info.version
    if error_code:
        record["errorCode"] = error_code
    return record


def _resolver_failure_status(error_code: str) -> str:
    if error_code == "RESOLVER_TIMEOUT":
        return "timeout"
    if error_code == "RESOLVER_OUTPUT_TOO_LARGE":
        return "overflow"
    if error_code == "RESOLVER_INVALID_OUTPUT":
        return "invalid_output"
    return "failed"


def _yt_dlp_page_candidate(
    request: HostRequest,
    parsed_result: ResolverParseResult,
) -> dict[str, Any] | None:
    if (
        request.adapter != "youtube"
        or request.page_url is None
        or not parsed_result.candidates
    ):
        return None
    representative = parsed_result.candidates[0]
    # The parser only labels a master when that language was actually observed
    # in its audio formats. Do not turn a browser preference into a false claim.
    language = str(representative.get("language", ""))
    return _resolved_candidate(
        "yt-dlp",
        request.page_url,
        declared_type="media",
        quality="Polecany",
        title=representative.get("title", ""),
        live=representative.get("live"),
        role="master",
        language=language,
        media_kind="adaptive",
        format_id="yt-dlp-page",
        playback_kind="yt-dlp-page",
    )


def handle_resolve(request: HostRequest) -> dict[str, Any]:
    if (
        request.page_url is None
        or request.source not in ALLOWED_RESOLVE_SOURCES
        or request.adapter not in ALLOWED_ADAPTERS
        or not request.resolver_order
        or (request.source == "page_ready" and bool(request.cookies))
    ):
        raise HostError("INVALID_REQUEST")
    runtime = get_runtime_paths(create=True)
    with exclusive_resolver_lock(runtime.directory / RESOLVER_LOCK_NAME):
        return _handle_resolve_locked(request)


def _handle_resolve_locked(request: HostRequest) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    resolved_by: str | None = None
    parsed_result = ResolverParseResult(())
    for name in request.resolver_order:
        info = resolver_info(name)
        if not info.installed:
            attempts.append(
                _resolver_attempt_record(info, "unavailable", info.error_code)
            )
            continue
        if not info.compatible or info.path is None:
            attempts.append(
                _resolver_attempt_record(info, "incompatible", info.error_code)
            )
            continue
        try:
            with temporary_cookie_jar(request.cookies) as cookie_jar:
                process_result = run_bounded_process(
                    build_resolver_args(
                        name,
                        info.path,
                        request.page_url,
                        cookie_jar,
                    ),
                    timeout=RESOLVER_ATTEMPT_SECONDS,
                )
            parsed = parse_resolver_output(
                name,
                process_result.stdout,
                preferred_languages=request.preferred_languages,
            )
        except HostError as error:
            attempts.append(
                _resolver_attempt_record(
                    info,
                    _resolver_failure_status(error.code),
                    error.code,
                )
            )
            continue

        if parsed.candidates:
            if name == "yt-dlp":
                page_candidate = _yt_dlp_page_candidate(request, parsed)
                if page_candidate is not None:
                    parsed = ResolverParseResult(
                        (
                            page_candidate,
                            *parsed.candidates[: MAX_RESOLVER_CANDIDATES - 1],
                        ),
                        parsed.truncated
                        or len(parsed.candidates) >= MAX_RESOLVER_CANDIDATES,
                    )
            parsed_result = parsed
            resolved_by = name
            attempts.append(
                _resolver_attempt_record(info, "found", count=len(parsed.candidates))
            )
            break
        if process_result.return_code == 0:
            attempts.append(_resolver_attempt_record(info, "empty"))
        else:
            attempts.append(
                _resolver_attempt_record(info, "failed", "RESOLVER_EXITED")
            )

    if resolved_by is not None:
        status = "found"
    elif attempts and all(attempt["status"] in {"unavailable", "incompatible"} for attempt in attempts):
        status = "unavailable"
    elif any(
        attempt["status"] in {"timeout", "overflow", "invalid_output", "failed"}
        for attempt in attempts
    ):
        status = "failed"
    elif any(attempt["status"] == "empty" for attempt in attempts):
        status = "empty"
    else:
        status = "failed"

    response = base_response(request)
    response.update(
        {
            "ok": True,
            "status": status,
            "resolver": resolved_by,
            "attempted": attempts,
            "candidates": [],
            "truncated": parsed_result.truncated,
        }
    )
    for candidate in parsed_result.candidates:
        proposed = [*response["candidates"], candidate]
        response["candidates"] = proposed
        if _encoded_response_size(response) > RESOLVER_RESPONSE_BUDGET:
            response["candidates"].pop()
            response["truncated"] = True
            break
    if resolved_by is not None and not response["candidates"]:
        response["status"] = "failed"
        response["resolver"] = None
    return response


def handle_health(request: HostRequest) -> dict[str, Any]:
    try:
        mpv_path = find_mpv_path()
    except HostError:
        mpv_path = None
    mpv_version = get_mpv_version(mpv_path) if mpv_path else None

    try:
        runtime = get_runtime_paths(create=False)
        queue = inspect_queue_state(runtime)
    except HostError as error:
        queue = {
            "state": "unavailable",
            "socketPresent": False,
            "responsive": False,
            "errorCode": error.code,
        }

    resolver_details = {
        name: public_resolver_info(resolver_info(name))
        for name in ("streamlink", "yt-dlp")
    }

    response = base_response(request)
    response.update(
        {
            "ok": True,
            "capabilities": ["health", "play", "resolve"],
            "mpv": {
                "available": mpv_path is not None,
                "path": mpv_path,
                "version": mpv_version,
            },
            "queue": queue,
            "resolvers": {
                "order": ["streamlink", "yt-dlp"],
                **resolver_details,
            },
        }
    )
    return response


def handle_play(request: HostRequest) -> dict[str, Any]:
    if request.mode is None or request.stream is None:
        raise HostError("INVALID_REQUEST")
    if _stream_url_is_expired(request.stream):
        raise HostError("STREAM_URL_EXPIRED")
    mpv_path = find_mpv_path()
    runtime = get_runtime_paths(create=True)
    if request.mode == "new":
        result = play_new(mpv_path, request.stream, runtime)
    else:
        result = play_queue_mode(
            mpv_path,
            request.stream,
            runtime,
            request.mode,
        )
    response = base_response(request)
    response.update(
        {
            "ok": True,
            "mode": result.mode,
            "confirmed": True,
            "confirmation": result.confirmation,
            "disposition": result.disposition,
        }
    )
    return response


def dispatch(request: HostRequest, logger: SecureLogger) -> dict[str, Any]:
    started = time.monotonic()
    try:
        if request.action == "health":
            response = handle_health(request)
        elif request.action == "play":
            response = handle_play(request)
        elif request.action == "resolve":
            response = handle_resolve(request)
        else:
            raise HostError("UNSUPPORTED_ACTION")
    except HostError as error:
        logger.log(
            "request",
            "error",
            error.code,
            action=request.action,
            source=request.source,
            mode=request.mode,
            confirmed=False,
            exitCode=error.exit_code,
            mpvErrorCategory=error.mpv_error_category,
            durationMs=int((time.monotonic() - started) * 1000),
        )
        return error_response(error, request)
    except Exception:
        error = HostError("INTERNAL_ERROR")
        logger.log(
            "request",
            "error",
            error.code,
            action=request.action,
            source=request.source,
            mode=request.mode,
            confirmed=False,
            durationMs=int((time.monotonic() - started) * 1000),
        )
        return error_response(error, request)

    logger.log(
        "request",
        "success",
        "OK",
        action=request.action,
        source=request.source,
        mode=request.mode,
        confirmed=response.get("confirmed"),
        confirmation=response.get("confirmation"),
        disposition=response.get("disposition"),
        durationMs=int((time.monotonic() - started) * 1000),
    )
    return response


def handle_payload(payload: Any, logger: SecureLogger) -> dict[str, Any]:
    """Validate one decoded message while retaining only trusted correlation data."""
    try:
        request = validate_request(payload)
    except HostError as error:
        request = error.request_context
        logger.log(
            "request",
            "error",
            error.code,
            action=request.action if request is not None else None,
            source=request.source if request is not None else None,
            mode=request.mode if request is not None else None,
            confirmed=False,
        )
        return error_response(error, request)
    except Exception:
        error = HostError("INTERNAL_ERROR")
        logger.log("request", "error", error.code, confirmed=False)
        return error_response(error)
    return dispatch(request, logger)


def main() -> int:
    logger = SecureLogger()
    try:
        payload = read_native_message(sys.stdin.buffer)
        if payload is None:
            return 0
    except HostError as error:
        logger.log("request", "error", error.code, confirmed=False)
        response = error_response(error)
    except Exception:
        error = HostError("INTERNAL_ERROR")
        logger.log("request", "error", error.code, confirmed=False)
        response = error_response(error)
    else:
        response = handle_payload(payload, logger)

    try:
        write_native_message(sys.stdout.buffer, response)
    except (BrokenPipeError, HostError, OSError):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

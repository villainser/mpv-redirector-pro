#!/usr/bin/env python3
"""User-scoped Linux installer for the MPV Redirector native host."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence, TextIO


DEFAULT_EXTENSION_ID = "jnlndklbijfpfbblphkhbfdfhlahahgm"
EXTENSION_ID_RE = re.compile(r"^[a-p]{32}$")
NATIVE_HOST_NAME = "com.villains.mpv_redirector"
HOST_TARGET_NAME = "mpv-redirector-host"
MANIFEST_FILE_NAME = f"{NATIVE_HOST_NAME}.json"
MAX_HOST_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ALLOWED_ORIGINS = 128
MAX_REGISTRY_BYTES = 64 * 1024
REGISTRY_SCHEMA_VERSION = 1
REGISTRY_DIRECTORY = Path(".config/mpv-redirector")
REGISTRY_FILE_NAME = "authorized_extensions.json"
REGISTRY_LOCK_FILE_NAME = ".install.lock"
REGISTRY_KEYS = frozenset({"schema_version", "native_host", "extension_ids"})

BROWSER_MANIFEST_DIRS: Mapping[str, Path] = {
    "chrome": Path(".config/google-chrome/NativeMessagingHosts"),
    "chrome-for-testing": Path(
        ".config/google-chrome-for-testing/NativeMessagingHosts"
    ),
    "chromium": Path(".config/chromium/NativeMessagingHosts"),
}
BROWSER_CHOICES = (*BROWSER_MANIFEST_DIRS.keys(), "all")


class InstallerError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DuplicateManifestKey(ValueError):
    pass


@dataclass(frozen=True)
class InstallPaths:
    home: Path
    host: Path
    manifests: Mapping[str, Path]
    registry: Path
    registry_lock: Path


@dataclass(frozen=True)
class VerificationIssue:
    component: str
    code: str


@dataclass(frozen=True)
class VerificationResult:
    ok: bool
    issues: tuple[VerificationIssue, ...]
    paths: InstallPaths


def validate_extension_id(value: str) -> str:
    if type(value) is not str or not EXTENSION_ID_RE.fullmatch(value):
        raise InstallerError("INVALID_EXTENSION_ID")
    return value


def selected_browsers(browser: str) -> tuple[str, ...]:
    if browser == "all":
        return tuple(BROWSER_MANIFEST_DIRS)
    if browser not in BROWSER_MANIFEST_DIRS:
        raise InstallerError("INVALID_BROWSER")
    return (browser,)


def installation_paths(home: Path, browser: str) -> InstallPaths:
    if not home.is_absolute():
        raise InstallerError("HOME_NOT_ABSOLUTE")
    browsers = selected_browsers(browser)
    host = home / ".local" / "bin" / HOST_TARGET_NAME
    manifests = {
        name: home / BROWSER_MANIFEST_DIRS[name] / MANIFEST_FILE_NAME
        for name in browsers
    }
    registry_directory = home / REGISTRY_DIRECTORY
    registry = registry_directory / REGISTRY_FILE_NAME
    registry_lock = registry_directory / REGISTRY_LOCK_FILE_NAME
    if (
        not host.is_absolute()
        or not registry.is_absolute()
        or not registry_lock.is_absolute()
        or any(not path.is_absolute() for path in manifests.values())
    ):
        raise InstallerError("TARGET_NOT_ABSOLUTE")
    return InstallPaths(
        home=home,
        host=host,
        manifests=manifests,
        registry=registry,
        registry_lock=registry_lock,
    )


def normalized_extension_ids(
    extension_id: str,
    additional_extension_ids: Sequence[str] = (),
) -> tuple[str, ...]:
    values = (validate_extension_id(extension_id),)
    if isinstance(additional_extension_ids, str):
        raise InstallerError("INVALID_EXTENSION_ID")
    values += tuple(validate_extension_id(value) for value in additional_extension_ids)
    unique_values = set(values)
    if len(unique_values) > MAX_ALLOWED_ORIGINS:
        raise InstallerError("TOO_MANY_EXTENSION_IDS")
    return tuple(
        sorted(
            unique_values,
            key=lambda value: (value != DEFAULT_EXTENSION_ID, value),
        )
    )


def build_manifest(
    host_path: Path,
    extension_id: str,
    additional_extension_ids: Sequence[str] = (),
) -> dict[str, Any]:
    extension_ids = normalized_extension_ids(extension_id, additional_extension_ids)
    if not host_path.is_absolute():
        raise InstallerError("TARGET_NOT_ABSOLUTE")
    return {
        "name": NATIVE_HOST_NAME,
        "description": "MPV Redirector Pro native host",
        "path": os.fspath(host_path),
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{allowed_extension_id}/"
            for allowed_extension_id in extension_ids
        ],
    }


def encode_manifest(
    host_path: Path,
    extension_id: str,
    additional_extension_ids: Sequence[str] = (),
) -> bytes:
    return (
        json.dumps(
            build_manifest(host_path, extension_id, additional_extension_ids),
            ensure_ascii=True,
            indent=2,
            sort_keys=False,
        )
        + "\n"
    ).encode("utf-8")


def _read_regular_file(path: Path, *, limit: int, error_code: str) -> bytes:
    try:
        details = path.lstat()
    except OSError as exc:
        raise InstallerError(error_code) from exc
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        raise InstallerError(error_code)
    if details.st_size > limit:
        raise InstallerError(error_code)
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise InstallerError(error_code) from exc
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != details.st_dev
            or opened.st_ino != details.st_ino
            or opened.st_size > limit
        ):
            raise InstallerError(error_code)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise InstallerError(error_code)
        final_details = os.fstat(fd)
        if (
            final_details.st_dev != opened.st_dev
            or final_details.st_ino != opened.st_ino
            or final_details.st_size != opened.st_size
            or len(data) != final_details.st_size
        ):
            raise InstallerError(error_code)
        return data
    finally:
        os.close(fd)


def read_source_host(source_host: Path) -> bytes:
    data = _read_regular_file(
        source_host,
        limit=MAX_HOST_BYTES,
        error_code="SOURCE_HOST_INVALID",
    )
    if not data.startswith(b"#!/usr/bin/env python3\n"):
        raise InstallerError("SOURCE_HOST_INVALID")
    return data


def _ensure_target_parent(home: Path, parent: Path) -> None:
    try:
        parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        resolved_home = home.resolve(strict=True)
        resolved_parent = parent.resolve(strict=True)
        resolved_parent.relative_to(resolved_home)
        details = parent.lstat()
    except (OSError, ValueError) as exc:
        raise InstallerError("TARGET_DIRECTORY_UNSAFE") from exc
    if (
        stat.S_ISLNK(details.st_mode)
        or not stat.S_ISDIR(details.st_mode)
        or details.st_uid != os.getuid()
    ):
        raise InstallerError("TARGET_DIRECTORY_UNSAFE")


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path: Path, data: bytes, mode: int, *, home: Path) -> None:
    if not path.is_absolute() or mode not in {0o600, 0o644, 0o755}:
        raise InstallerError("INVALID_ATOMIC_WRITE")
    _ensure_target_parent(home, path.parent)
    temporary_path: Path | None = None
    fd = -1
    try:
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            dir=os.fspath(path.parent),
        )
        temporary_path = Path(temporary_name)
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short atomic write")
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary_path, path)
        temporary_path = None
        _fsync_directory(path.parent)
    except (OSError, ValueError) as exc:
        raise InstallerError("ATOMIC_WRITE_FAILED") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def _duplicate_key_guard(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateManifestKey(key)
        result[key] = value
    return result


def build_registry(extension_ids: Sequence[str]) -> dict[str, Any]:
    if isinstance(extension_ids, str) or not extension_ids:
        raise InstallerError("INVALID_EXTENSION_ID")
    normalized = normalized_extension_ids(extension_ids[0], extension_ids[1:])
    return {
        "schema_version": REGISTRY_SCHEMA_VERSION,
        "native_host": NATIVE_HOST_NAME,
        "extension_ids": list(normalized),
    }


def encode_registry(extension_ids: Sequence[str]) -> bytes:
    return (
        json.dumps(
            build_registry(extension_ids),
            ensure_ascii=True,
            indent=2,
            sort_keys=False,
        )
        + "\n"
    ).encode("utf-8")


def _registry_extension_ids(registry: Any) -> tuple[str, ...] | None:
    if (
        type(registry) is not dict
        or set(registry) != REGISTRY_KEYS
        or type(registry.get("schema_version")) is not int
        or registry.get("schema_version") != REGISTRY_SCHEMA_VERSION
        or registry.get("native_host") != NATIVE_HOST_NAME
    ):
        return None
    extension_ids = registry.get("extension_ids")
    if type(extension_ids) is not list or not extension_ids:
        return None
    try:
        normalized = normalized_extension_ids(extension_ids[0], extension_ids[1:])
    except InstallerError:
        return None
    if extension_ids != list(normalized):
        return None
    return normalized


def _decode_registry(data: bytes) -> tuple[str, ...]:
    try:
        registry = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_duplicate_key_guard,
        )
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise InstallerError("REGISTRY_INVALID") from exc
    extension_ids = _registry_extension_ids(registry)
    if extension_ids is None:
        raise InstallerError("REGISTRY_INVALID")
    return extension_ids


def _read_registered_extension_ids(path: Path) -> tuple[str, ...] | None:
    try:
        details = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise InstallerError("REGISTRY_INVALID") from exc
    if (
        stat.S_ISLNK(details.st_mode)
        or not stat.S_ISREG(details.st_mode)
        or details.st_uid != os.getuid()
        or stat.S_IMODE(details.st_mode) != 0o600
    ):
        raise InstallerError("REGISTRY_INVALID")
    data = _read_regular_file(
        path,
        limit=MAX_REGISTRY_BYTES,
        error_code="REGISTRY_INVALID",
    )
    return _decode_registry(data)


@contextmanager
def _installation_lock(paths: InstallPaths) -> Iterator[None]:
    try:
        paths.registry.lstat()
        registry_exists = True
    except FileNotFoundError:
        registry_exists = False
    except OSError as exc:
        raise InstallerError("REGISTRY_INVALID") from exc
    try:
        initial_lock_details = paths.registry_lock.lstat()
    except FileNotFoundError:
        initial_lock_details = None
    except OSError as exc:
        raise InstallerError("INSTALL_LOCK_FAILED") from exc
    if registry_exists and initial_lock_details is None:
        raise InstallerError("INSTALL_LOCK_FAILED")

    _ensure_target_parent(paths.home, paths.registry_lock.parent)
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(paths.registry_lock, flags, 0o600)
    except OSError as exc:
        raise InstallerError("INSTALL_LOCK_FAILED") from exc
    try:
        details = os.fstat(fd)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
            or details.st_nlink != 1
            or (
                initial_lock_details is not None
                and (
                    initial_lock_details.st_dev != details.st_dev
                    or initial_lock_details.st_ino != details.st_ino
                    or stat.S_IMODE(initial_lock_details.st_mode) != 0o600
                )
            )
        ):
            raise InstallerError("INSTALL_LOCK_FAILED")
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        current_path = os.stat(paths.registry_lock, follow_symlinks=False)
        if (
            current_path.st_dev != details.st_dev
            or current_path.st_ino != details.st_ino
        ):
            raise InstallerError("INSTALL_LOCK_FAILED")
        yield
    except OSError as exc:
        raise InstallerError("INSTALL_LOCK_FAILED") from exc
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _acquire_verification_lock(paths: InstallPaths) -> int | None:
    try:
        initial = paths.registry_lock.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise InstallerError("INSTALL_LOCK_FAILED") from exc
    if (
        stat.S_ISLNK(initial.st_mode)
        or not stat.S_ISREG(initial.st_mode)
        or initial.st_uid != os.getuid()
        or initial.st_nlink != 1
        or stat.S_IMODE(initial.st_mode) != 0o600
    ):
        raise InstallerError("INSTALL_LOCK_FAILED")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(paths.registry_lock, flags)
    except OSError as exc:
        raise InstallerError("INSTALL_LOCK_FAILED") from exc
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.getuid()
            or opened.st_nlink != 1
            or stat.S_IMODE(opened.st_mode) != 0o600
            or opened.st_dev != initial.st_dev
            or opened.st_ino != initial.st_ino
        ):
            raise InstallerError("INSTALL_LOCK_FAILED")
        fcntl.flock(fd, fcntl.LOCK_SH)
        current_path = os.stat(paths.registry_lock, follow_symlinks=False)
        if (
            current_path.st_dev != opened.st_dev
            or current_path.st_ino != opened.st_ino
        ):
            raise InstallerError("INSTALL_LOCK_FAILED")
        return fd
    except InstallerError:
        os.close(fd)
        raise
    except OSError as exc:
        os.close(fd)
        raise InstallerError("INSTALL_LOCK_FAILED") from exc


def _release_verification_lock(fd: int | None) -> None:
    if fd is None:
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _manifest_install_targets(paths: InstallPaths) -> tuple[Path, ...]:
    targets = dict(paths.manifests)
    all_manifests = installation_paths(paths.home, "all").manifests
    for browser_name, manifest_path in all_manifests.items():
        if browser_name in targets:
            continue
        try:
            manifest_path.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise InstallerError("TARGET_READ_FAILED") from exc
        targets[browser_name] = manifest_path
    return tuple(targets.values())


def install(
    *,
    home: Path,
    source_host: Path,
    browser: str,
    extension_id: str,
    additional_extension_ids: Sequence[str] = (),
    bootstrap_extension_ids: Sequence[str] = (),
) -> InstallPaths:
    requested_extension_ids = normalized_extension_ids(
        extension_id,
        additional_extension_ids,
    )
    if isinstance(bootstrap_extension_ids, str):
        raise InstallerError("INVALID_EXTENSION_ID")
    if bootstrap_extension_ids:
        validated_bootstrap_ids = normalized_extension_ids(
            bootstrap_extension_ids[0],
            bootstrap_extension_ids[1:],
        )
    else:
        validated_bootstrap_ids = ()
    paths = installation_paths(home, browser)
    host_bytes = read_source_host(source_host)
    with _installation_lock(paths):
        registered_extension_ids = _read_registered_extension_ids(paths.registry)
        prior_extension_ids = registered_extension_ids or ()
        bootstrap_ids = (
            validated_bootstrap_ids if registered_extension_ids is None else ()
        )
        combined_extension_ids = normalized_extension_ids(
            requested_extension_ids[0],
            (
                *requested_extension_ids[1:],
                *prior_extension_ids,
                *bootstrap_ids,
            ),
        )
        registry_bytes = encode_registry(combined_extension_ids)
        manifest_bytes = encode_manifest(
            paths.host,
            combined_extension_ids[0],
            combined_extension_ids[1:],
        )

        atomic_write(paths.registry, registry_bytes, 0o600, home=home)
        atomic_write(paths.host, host_bytes, 0o755, home=home)
        for manifest_path in _manifest_install_targets(paths):
            atomic_write(manifest_path, manifest_bytes, 0o644, home=home)
    return paths


def _file_issues(
    path: Path,
    *,
    expected_mode: int,
    expected_bytes: bytes | None,
    component: str,
) -> list[VerificationIssue]:
    issues: list[VerificationIssue] = []
    try:
        details = path.lstat()
    except FileNotFoundError:
        return [VerificationIssue(component, "MISSING")]
    except OSError:
        return [VerificationIssue(component, "UNREADABLE")]
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        return [VerificationIssue(component, "NOT_REGULAR")]
    if details.st_uid != os.getuid():
        issues.append(VerificationIssue(component, "WRONG_OWNER"))
    if stat.S_IMODE(details.st_mode) != expected_mode:
        issues.append(VerificationIssue(component, "WRONG_MODE"))
    if expected_bytes is not None:
        try:
            actual = _read_regular_file(
                path,
                limit=max(len(expected_bytes), 1) + 1,
                error_code="TARGET_READ_FAILED",
            )
        except InstallerError:
            issues.append(VerificationIssue(component, "UNREADABLE"))
        else:
            if actual != expected_bytes:
                issues.append(VerificationIssue(component, "CONTENT_MISMATCH"))
    return issues


def _check_installation_state(
    *,
    paths: InstallPaths,
    expected_host: bytes,
    required_extension_ids: tuple[str, ...],
) -> VerificationResult:
    issues = _file_issues(
        paths.host,
        expected_mode=0o755,
        expected_bytes=expected_host,
        component="host",
    )

    expected_manifest: dict[str, Any] | None = None
    registry_component = "registry"
    registry_issues = _file_issues(
        paths.registry,
        expected_mode=0o600,
        expected_bytes=None,
        component=registry_component,
    )
    issues.extend(registry_issues)
    if not any(
        issue.code in {"MISSING", "UNREADABLE", "NOT_REGULAR"}
        for issue in registry_issues
    ):
        try:
            raw_registry = _read_regular_file(
                paths.registry,
                limit=MAX_REGISTRY_BYTES,
                error_code="TARGET_READ_FAILED",
            )
        except InstallerError:
            issues.append(VerificationIssue(registry_component, "UNREADABLE"))
        else:
            try:
                parsed_registry = json.loads(
                    raw_registry.decode("utf-8"),
                    object_pairs_hook=_duplicate_key_guard,
                )
            except (UnicodeError, ValueError, json.JSONDecodeError):
                issues.append(
                    VerificationIssue(registry_component, "INVALID_JSON")
                )
            else:
                registered_extension_ids = _registry_extension_ids(parsed_registry)
                if registered_extension_ids is None:
                    issues.append(
                        VerificationIssue(registry_component, "CONTENT_MISMATCH")
                    )
                else:
                    if not set(required_extension_ids).issubset(
                        registered_extension_ids
                    ):
                        issues.append(
                            VerificationIssue(
                                registry_component,
                                "CONTENT_MISMATCH",
                            )
                        )
                    expected_manifest = build_manifest(
                        paths.host,
                        registered_extension_ids[0],
                        registered_extension_ids[1:],
                    )

    for browser_name, manifest_path in paths.manifests.items():
        component = f"manifest:{browser_name}"
        manifest_issues = _file_issues(
            manifest_path,
            expected_mode=0o644,
            expected_bytes=None,
            component=component,
        )
        issues.extend(manifest_issues)
        if any(issue.code in {"MISSING", "UNREADABLE", "NOT_REGULAR"} for issue in manifest_issues):
            continue
        try:
            raw_manifest = _read_regular_file(
                manifest_path,
                limit=MAX_MANIFEST_BYTES,
                error_code="TARGET_READ_FAILED",
            )
            parsed_manifest = json.loads(
                raw_manifest.decode("utf-8"),
                object_pairs_hook=_duplicate_key_guard,
            )
        except (InstallerError, UnicodeError, ValueError, json.JSONDecodeError):
            issues.append(VerificationIssue(component, "INVALID_JSON"))
            continue
        if expected_manifest is None or parsed_manifest != expected_manifest:
            issues.append(VerificationIssue(component, "CONTENT_MISMATCH"))

    return VerificationResult(ok=not issues, issues=tuple(issues), paths=paths)


def check_installation(
    *,
    home: Path,
    source_host: Path,
    browser: str,
    extension_id: str,
    additional_extension_ids: Sequence[str] = (),
) -> VerificationResult:
    required_extension_ids = normalized_extension_ids(
        extension_id,
        additional_extension_ids,
    )
    paths = installation_paths(home, browser)
    expected_host = read_source_host(source_host)
    lock_issue: VerificationIssue | None = None
    try:
        lock_fd = _acquire_verification_lock(paths)
    except InstallerError:
        lock_fd = None
        lock_issue = VerificationIssue("registry_lock", "UNSAFE")
    if lock_fd is None and lock_issue is None:
        try:
            paths.registry.lstat()
        except FileNotFoundError:
            pass
        except OSError:
            lock_issue = VerificationIssue("registry_lock", "UNSAFE")
        else:
            lock_issue = VerificationIssue("registry_lock", "MISSING")
    try:
        result = _check_installation_state(
            paths=paths,
            expected_host=expected_host,
            required_extension_ids=required_extension_ids,
        )
    finally:
        _release_verification_lock(lock_fd)
    if lock_issue is None:
        return result
    return VerificationResult(
        ok=False,
        issues=(*result.issues, lock_issue),
        paths=paths,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install the MPV Redirector native host for the current Linux user."
    )
    parser.add_argument(
        "--browser",
        choices=BROWSER_CHOICES,
        default="chrome",
        help="browser manifest target (default: chrome)",
    )
    parser.add_argument(
        "--extension-id",
        default=DEFAULT_EXTENSION_ID,
        help="32-character Chrome extension ID",
    )
    parser.add_argument(
        "--allow-extension-id",
        action="append",
        default=[],
        help="additional 32-character extension ID allowed to use the host",
    )
    parser.add_argument(
        "--bootstrap-extension-id",
        action="append",
        default=[],
        help=(
            "extension ID added only while creating the authorization registry"
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the selected installation without changing files",
    )
    return parser


def run(
    argv: Sequence[str] | None = None,
    *,
    home: Path | None = None,
    source_host: Path | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    output = stdout or sys.stdout
    error_output = stderr or sys.stderr
    args = build_parser().parse_args(argv)
    actual_home = home or Path.home()
    actual_source = source_host or Path(__file__).with_name("mpv_redirector_host.py")

    if not sys.platform.startswith("linux"):
        print("error: LINUX_REQUIRED", file=error_output)
        return 2
    try:
        normalized_extension_ids(
            args.extension_id,
            (*args.allow_extension_id, *args.bootstrap_extension_id),
        )
        if args.check:
            result = check_installation(
                home=actual_home,
                source_host=actual_source,
                browser=args.browser,
                extension_id=args.extension_id,
                additional_extension_ids=args.allow_extension_id,
            )
            if result.ok:
                print("ok: installation verified", file=output)
                return 0
            for issue in result.issues:
                print(f"error: {issue.component}: {issue.code}", file=error_output)
            return 1

        paths = install(
            home=actual_home,
            source_host=actual_source,
            browser=args.browser,
            extension_id=args.extension_id,
            additional_extension_ids=args.allow_extension_id,
            bootstrap_extension_ids=args.bootstrap_extension_id,
        )
        print(f"installed: {paths.host}", file=output)
        for browser_name, manifest_path in paths.manifests.items():
            print(f"manifest:{browser_name}: {manifest_path}", file=output)
        return 0
    except InstallerError as exc:
        print(f"error: {exc.code}", file=error_output)
        return 2


def main() -> int:
    return run()


if __name__ == "__main__":
    raise SystemExit(main())

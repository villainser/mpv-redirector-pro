from __future__ import annotations

import io
import json
import multiprocessing
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.fspath(PROJECT_ROOT / "native_host"))

import install_host as installer  # noqa: E402


SOURCE_BYTES = b"#!/usr/bin/env python3\nprint('test host')\n"


def extension_id_for(index: int) -> str:
    hexadecimal = f"{index:032x}"
    return "".join(chr(ord("a") + int(digit, 16)) for digit in hexadecimal)


def concurrent_install_worker(
    home: str,
    source: str,
    extension_id: str,
    start: multiprocessing.synchronize.Event,
) -> None:
    start.wait()
    installer.install(
        home=Path(home),
        source_host=Path(source),
        browser="chrome",
        extension_id=extension_id,
    )


class InstallerFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.source = self.root / "mpv_redirector_host.py"
        self.source.write_bytes(SOURCE_BYTES)
        os.chmod(self.source, 0o755)

    def tearDown(self) -> None:
        self.temporary.cleanup()


class ValidationAndPathTests(InstallerFixture):
    def test_extension_id_validation_is_exact(self) -> None:
        self.assertEqual(
            installer.validate_extension_id(installer.DEFAULT_EXTENSION_ID),
            installer.DEFAULT_EXTENSION_ID,
        )
        invalid_ids = [
            "a" * 31,
            "a" * 33,
            "q" * 32,
            "A" * 32,
            "a" * 31 + "\n",
            "../" + "a" * 29,
        ]
        for extension_id in invalid_ids:
            with self.subTest(extension_id=extension_id):
                with self.assertRaises(installer.InstallerError) as caught:
                    installer.validate_extension_id(extension_id)
                self.assertEqual(caught.exception.code, "INVALID_EXTENSION_ID")

    def test_default_browser_is_chrome(self) -> None:
        args = installer.build_parser().parse_args([])
        self.assertEqual(args.browser, "chrome")
        self.assertEqual(args.extension_id, installer.DEFAULT_EXTENSION_ID)
        self.assertEqual(args.allow_extension_id, [])
        self.assertEqual(args.bootstrap_extension_id, [])
        self.assertFalse(args.check)

    def test_browser_paths_are_user_scoped(self) -> None:
        expected_parents = {
            "chrome": self.home / ".config/google-chrome/NativeMessagingHosts",
            "chrome-for-testing": self.home
            / ".config/google-chrome-for-testing/NativeMessagingHosts",
            "chromium": self.home / ".config/chromium/NativeMessagingHosts",
        }
        paths = installer.installation_paths(self.home, "all")
        self.assertEqual(paths.host, self.home / ".local/bin/mpv-redirector-host")
        self.assertEqual(
            paths.registry,
            self.home / ".config/mpv-redirector/authorized_extensions.json",
        )
        self.assertEqual(
            paths.registry_lock,
            self.home / ".config/mpv-redirector/.install.lock",
        )
        self.assertEqual(set(paths.manifests), set(expected_parents))
        for browser, manifest_path in paths.manifests.items():
            self.assertEqual(manifest_path.parent, expected_parents[browser])
            self.assertTrue(manifest_path.is_absolute())

    def test_manifest_has_exact_path_and_allowed_origin(self) -> None:
        target = self.home / ".local/bin/mpv-redirector-host"
        manifest = installer.build_manifest(target, installer.DEFAULT_EXTENSION_ID)
        self.assertEqual(
            manifest,
            {
                "name": "com.villains.mpv_redirector",
                "description": "MPV Redirector Pro native host",
                "path": os.fspath(target),
                "type": "stdio",
                "allowed_origins": [
                    "chrome-extension://jnlndklbijfpfbblphkhbfdfhlahahgm/"
                ],
            },
        )
        self.assertTrue(Path(manifest["path"]).is_absolute())

    def test_manifest_allows_multiple_deduplicated_extension_ids(self) -> None:
        target = self.home / ".local/bin/mpv-redirector-host"
        second_id = "a" * 32
        manifest = installer.build_manifest(
            target,
            installer.DEFAULT_EXTENSION_ID,
            (second_id, installer.DEFAULT_EXTENSION_ID),
        )
        self.assertEqual(
            manifest["allowed_origins"],
            [
                f"chrome-extension://{installer.DEFAULT_EXTENSION_ID}/",
                f"chrome-extension://{second_id}/",
            ],
        )


class InstallTests(InstallerFixture):
    def test_installs_host_and_default_chrome_manifest_with_exact_modes(self) -> None:
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertEqual(paths.host.read_bytes(), SOURCE_BYTES)
        self.assertEqual(stat.S_IMODE(paths.host.stat().st_mode), 0o755)
        self.assertEqual(set(paths.manifests), {"chrome"})
        self.assertEqual(stat.S_IMODE(paths.registry.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(paths.registry_lock.stat().st_mode), 0o600)
        self.assertEqual(
            json.loads(paths.registry.read_text(encoding="utf-8")),
            installer.build_registry((installer.DEFAULT_EXTENSION_ID,)),
        )

        manifest_path = paths.manifests["chrome"]
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(
            manifest,
            installer.build_manifest(paths.host, installer.DEFAULT_EXTENSION_ID),
        )
        self.assertEqual(stat.S_IMODE(manifest_path.stat().st_mode), 0o644)
        self.assertFalse(
            (self.home / ".config/chromium/NativeMessagingHosts").exists()
        )

    def test_all_installs_three_manifests_for_the_same_absolute_host(self) -> None:
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertEqual(
            set(paths.manifests),
            {"chrome", "chrome-for-testing", "chromium"},
        )
        for manifest_path in paths.manifests.values():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["path"], os.fspath(paths.host))
            self.assertTrue(Path(manifest["path"]).is_absolute())
            self.assertEqual(
                manifest["allowed_origins"],
                [
                    f"chrome-extension://{installer.DEFAULT_EXTENSION_ID}/"
                ],
            )
            self.assertEqual(stat.S_IMODE(manifest_path.stat().st_mode), 0o644)

    def test_existing_files_are_replaced_atomically_without_temp_debris(self) -> None:
        paths = installer.installation_paths(self.home, "chrome")
        paths.host.parent.mkdir(parents=True)
        paths.host.write_bytes(b"old host")
        manifest_path = paths.manifests["chrome"]
        manifest_path.parent.mkdir(parents=True)
        manifest_path.write_text("old manifest", encoding="utf-8")

        real_replace = os.replace
        with mock.patch.object(
            installer.os, "replace", wraps=real_replace
        ) as replace:
            installer.install(
                home=self.home,
                source_host=self.source,
                browser="chrome",
                extension_id=installer.DEFAULT_EXTENSION_ID,
            )
        self.assertEqual(replace.call_count, 3)
        self.assertEqual(paths.host.read_bytes(), SOURCE_BYTES)
        self.assertFalse(list(paths.host.parent.glob(f".{paths.host.name}.*")))
        self.assertFalse(
            list(manifest_path.parent.glob(f".{manifest_path.name}.*"))
        )

    def test_reinstall_preserves_registered_origins_across_paths(self) -> None:
        first_extra_id = "a" * 32
        second_extra_id = "b" * 32
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=installer.DEFAULT_EXTENSION_ID,
            additional_extension_ids=(first_extra_id,),
        )
        installer.install(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=second_extra_id,
        )

        expected_ids = (
            installer.DEFAULT_EXTENSION_ID,
            first_extra_id,
            second_extra_id,
        )
        expected_origins = [
            f"chrome-extension://{extension_id}/"
            for extension_id in expected_ids
        ]
        self.assertEqual(
            json.loads(paths.registry.read_text(encoding="utf-8")),
            installer.build_registry(expected_ids),
        )
        for manifest_path in paths.manifests.values():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["allowed_origins"], expected_origins)

    def test_reinstall_repairs_manifest_from_registry(self) -> None:
        extra_id = "a" * 32
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
            additional_extension_ids=(extra_id,),
        )
        manifest_path = paths.manifests["chrome"]
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["allowed_origins"].append("chrome-extension://*/")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )

        repaired = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(
            repaired["allowed_origins"],
            [
                f"chrome-extension://{installer.DEFAULT_EXTENSION_ID}/",
                f"chrome-extension://{extra_id}/",
            ],
        )

    def test_bootstrap_ids_are_used_only_when_registry_is_created(self) -> None:
        first_bootstrap_id = "a" * 32
        ignored_later_bootstrap_id = "b" * 32
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
            bootstrap_extension_ids=(first_bootstrap_id,),
        )
        installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
            bootstrap_extension_ids=(ignored_later_bootstrap_id,),
        )
        registry = json.loads(paths.registry.read_text(encoding="utf-8"))
        self.assertEqual(
            registry["extension_ids"],
            [installer.DEFAULT_EXTENSION_ID, first_bootstrap_id],
        )

    def test_invalid_registry_fails_closed_without_rewriting_installed_files(self) -> None:
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        paths.registry.write_text('{"schema_version":2}\n', encoding="utf-8")
        before = {
            path: (path.stat().st_mtime_ns, path.read_bytes())
            for path in (
                paths.registry,
                paths.host,
                paths.manifests["chrome"],
            )
        }
        with self.assertRaises(installer.InstallerError) as caught:
            installer.install(
                home=self.home,
                source_host=self.source,
                browser="chrome",
                extension_id="a" * 32,
            )
        self.assertEqual(caught.exception.code, "REGISTRY_INVALID")
        after = {
            path: (path.stat().st_mtime_ns, path.read_bytes())
            for path in before
        }
        self.assertEqual(after, before)

    def test_more_than_128_ids_are_rejected_before_writing(self) -> None:
        extension_ids = tuple(extension_id_for(index) for index in range(129))
        with self.assertRaises(installer.InstallerError) as caught:
            installer.install(
                home=self.home,
                source_host=self.source,
                browser="chrome",
                extension_id=extension_ids[0],
                additional_extension_ids=extension_ids[1:],
            )
        self.assertEqual(caught.exception.code, "TOO_MANY_EXTENSION_IDS")
        self.assertFalse((self.home / ".local").exists())
        self.assertFalse((self.home / ".config").exists())

    def test_single_browser_install_updates_other_existing_manifests(self) -> None:
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        extra_id = "a" * 32
        installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=extra_id,
        )
        expected = installer.build_manifest(
            paths.host,
            installer.DEFAULT_EXTENSION_ID,
            (extra_id,),
        )
        for manifest_path in paths.manifests.values():
            self.assertEqual(
                json.loads(manifest_path.read_text(encoding="utf-8")),
                expected,
            )

    def test_concurrent_installs_do_not_lose_registered_ids(self) -> None:
        context = multiprocessing.get_context("fork")
        start = context.Event()
        extension_ids = ("a" * 32, "b" * 32)
        processes = [
            context.Process(
                target=concurrent_install_worker,
                args=(
                    os.fspath(self.home),
                    os.fspath(self.source),
                    extension_id,
                    start,
                ),
            )
            for extension_id in extension_ids
        ]
        for process in processes:
            process.start()
        start.set()
        for process in processes:
            process.join(timeout=10)
            self.assertEqual(process.exitcode, 0)

        paths = installer.installation_paths(self.home, "chrome")
        registry = json.loads(paths.registry.read_text(encoding="utf-8"))
        self.assertEqual(registry, installer.build_registry(extension_ids))
        manifest = json.loads(
            paths.manifests["chrome"].read_text(encoding="utf-8")
        )
        self.assertEqual(
            manifest,
            installer.build_manifest(paths.host, extension_ids[0], extension_ids[1:]),
        )

    def test_retry_repairs_manifest_after_failure_following_registry_write(self) -> None:
        paths = installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        extra_id = "a" * 32
        real_atomic_write = installer.atomic_write
        failed = False

        def fail_host_once(
            path: Path,
            data: bytes,
            mode: int,
            *,
            home: Path,
        ) -> None:
            nonlocal failed
            if path == paths.host and not failed:
                failed = True
                raise installer.InstallerError("ATOMIC_WRITE_FAILED")
            real_atomic_write(path, data, mode, home=home)

        with mock.patch.object(installer, "atomic_write", side_effect=fail_host_once):
            with self.assertRaises(installer.InstallerError):
                installer.install(
                    home=self.home,
                    source_host=self.source,
                    browser="chrome",
                    extension_id=extra_id,
                )

        stale = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=extra_id,
        )
        self.assertFalse(stale.ok)
        installer.install(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=extra_id,
        )
        repaired = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=extra_id,
        )
        self.assertTrue(repaired.ok)

    def test_source_symlink_is_rejected(self) -> None:
        linked_source = self.root / "linked_host.py"
        linked_source.symlink_to(self.source)
        with self.assertRaises(installer.InstallerError) as caught:
            installer.install(
                home=self.home,
                source_host=linked_source,
                browser="chrome",
                extension_id=installer.DEFAULT_EXTENSION_ID,
            )
        self.assertEqual(caught.exception.code, "SOURCE_HOST_INVALID")
        self.assertFalse((self.home / ".local/bin/mpv-redirector-host").exists())


class CheckTests(InstallerFixture):
    def _install(self, browser: str = "chrome") -> installer.InstallPaths:
        return installer.install(
            home=self.home,
            source_host=self.source,
            browser=browser,
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )

    def _snapshot(self) -> dict[str, tuple[int, int, bytes]]:
        result: dict[str, tuple[int, int, bytes]] = {}
        for path in sorted(self.home.rglob("*")):
            if path.is_file():
                details = path.stat()
                result[os.fspath(path.relative_to(self.home))] = (
                    stat.S_IMODE(details.st_mode),
                    details.st_mtime_ns,
                    path.read_bytes(),
                )
        return result

    def test_check_accepts_matching_installation_without_changes(self) -> None:
        self._install("all")
        before = self._snapshot()
        result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        after = self._snapshot()
        self.assertTrue(result.ok)
        self.assertEqual(result.issues, ())
        self.assertEqual(after, before)

    def test_check_accepts_a_valid_preserved_origin_without_changes(self) -> None:
        extra_id = "a" * 32
        installer.install(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=installer.DEFAULT_EXTENSION_ID,
            additional_extension_ids=(extra_id,),
        )
        before = self._snapshot()
        result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="all",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        after = self._snapshot()
        self.assertTrue(result.ok)
        self.assertEqual(result.issues, ())
        self.assertEqual(after, before)

    def test_check_on_missing_installation_does_not_create_directories(self) -> None:
        result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertFalse(result.ok)
        self.assertEqual(
            {(issue.component, issue.code) for issue in result.issues},
            {
                ("host", "MISSING"),
                ("registry", "MISSING"),
                ("manifest:chrome", "MISSING"),
            },
        )
        self.assertFalse((self.home / ".local").exists())
        self.assertFalse((self.home / ".config").exists())

    def test_check_detects_content_permissions_and_manifest_mismatch(self) -> None:
        paths = self._install()
        paths.host.write_bytes(b"#!/usr/bin/env python3\nprint('tampered')\n")
        os.chmod(paths.host, 0o700)
        manifest_path = paths.manifests["chrome"]
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["allowed_origins"] = ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        issue_pairs = {(issue.component, issue.code) for issue in result.issues}
        self.assertIn(("host", "WRONG_MODE"), issue_pairs)
        self.assertIn(("host", "CONTENT_MISMATCH"), issue_pairs)
        self.assertIn(("manifest:chrome", "CONTENT_MISMATCH"), issue_pairs)

    def test_check_rejects_a_valid_but_unregistered_manifest_origin(self) -> None:
        paths = self._install()
        manifest_path = paths.manifests["chrome"]
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["allowed_origins"].append(
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
        )
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertIn(
            installer.VerificationIssue(
                "manifest:chrome",
                "CONTENT_MISMATCH",
            ),
            result.issues,
        )

    def test_check_distinguishes_invalid_registry_schema_from_invalid_json(self) -> None:
        paths = self._install()
        paths.registry.write_text('{"schema_version":2}\n', encoding="utf-8")
        schema_result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertIn(
            installer.VerificationIssue("registry", "CONTENT_MISMATCH"),
            schema_result.issues,
        )

        paths.registry.write_text("{", encoding="utf-8")
        json_result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertIn(
            installer.VerificationIssue("registry", "INVALID_JSON"),
            json_result.issues,
        )

    def test_check_rejects_symlinked_installed_host(self) -> None:
        paths = self._install()
        paths.host.unlink()
        paths.host.symlink_to(self.source)
        result = installer.check_installation(
            home=self.home,
            source_host=self.source,
            browser="chrome",
            extension_id=installer.DEFAULT_EXTENSION_ID,
        )
        self.assertIn(
            installer.VerificationIssue("host", "NOT_REGULAR"),
            result.issues,
        )

    def test_cli_check_uses_read_only_path_and_exit_status(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        missing_status = installer.run(
            ["--check"],
            home=self.home,
            source_host=self.source,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(missing_status, 1)
        self.assertFalse((self.home / ".local").exists())

        self._install()
        stdout = io.StringIO()
        stderr = io.StringIO()
        good_status = installer.run(
            ["--check"],
            home=self.home,
            source_host=self.source,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(good_status, 0)
        self.assertIn("installation verified", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    def test_cli_rejects_invalid_extension_id_before_writing(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        status = installer.run(
            ["--extension-id", "z" * 32],
            home=self.home,
            source_host=self.source,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(status, 2)
        self.assertIn("INVALID_EXTENSION_ID", stderr.getvalue())
        self.assertFalse((self.home / ".local").exists())
        self.assertFalse((self.home / ".config").exists())


if __name__ == "__main__":
    unittest.main()

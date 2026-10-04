#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
resolver_dir="$(python3 - <<'PY'
from pathlib import Path
print(Path.home() / ".local" / "share" / "mpv-redirector" / "resolvers")
PY
)"

if [[ ! -f "$package_dir/manifest.json" || ! -f "$package_dir/native_host/install_host.py" ]]; then
    echo "Błąd: uruchom install.sh z kompletnego katalogu MPV Redirector Pro." >&2
    exit 1
fi

extension_id="$(python3 - "$package_dir" <<'PY'
import hashlib
import os
import sys

extension_path = os.path.realpath(sys.argv[1])
digest = hashlib.sha256(os.fsencode(extension_path)).digest()[:16]
print("".join(chr(97 + nibble) for byte in digest for nibble in (byte >> 4, byte & 15)))
PY
)"

host_args=(
    --browser all
    --extension-id "$extension_id"
    --bootstrap-extension-id "jnlndklbijfpfbblphkhbfdfhlahahgm"
    --bootstrap-extension-id "dcgeifimhjppgmknghajookpfdaajjgn"
    --bootstrap-extension-id "gfkdjdbmmdailndnngolelpjpdiahleh"
)

usage() {
    echo "Użycie: ./install.sh [--check | --host-only]"
}

check_resolvers() {
    python3 - "$resolver_dir" <<'PY'
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

resolver_dir = Path(sys.argv[1])
minimums = {
    "streamlink": (8, 4, 0),
    "yt-dlp": (2026, 6, 9),
}
version_re = re.compile(r"(?<!\d)(\d{1,4})\.(\d{1,2})\.(\d{1,2})(?!\d)")
failed = False

for name, minimum in minimums.items():
    preferred = resolver_dir / "bin" / name
    executable = os.fspath(preferred) if preferred.is_file() and os.access(preferred, os.X_OK) else shutil.which(name)
    if not executable:
        print(f"✗ {name}: nie znaleziono (wymagane co najmniej {'.'.join(map(str, minimum))})", file=sys.stderr)
        failed = True
        continue
    try:
        result = subprocess.run(
            [executable, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=4,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        print(f"✗ {name}: nie udało się odczytać wersji", file=sys.stderr)
        failed = True
        continue
    text = result.stdout[:512].decode("utf-8", errors="replace").strip()
    match = version_re.search(text)
    version = tuple(int(part) for part in match.groups()) if match else None
    if result.returncode != 0 or version is None or version < minimum:
        shown = ".".join(map(str, version)) if version else "nieznana"
        print(f"✗ {name}: {shown}; wymagane co najmniej {'.'.join(map(str, minimum))}", file=sys.stderr)
        failed = True
        continue
    print(f"✓ {name}: {'.'.join(map(str, version))}")

raise SystemExit(1 if failed else 0)
PY
}

install_resolvers() {
    local resolver_parent
    resolver_parent="$(dirname -- "$resolver_dir")"
    install -d -m 700 "$resolver_parent"
    if [[ -e "$resolver_dir" && ! -x "$resolver_dir/bin/python" ]]; then
        echo "Błąd: $resolver_dir istnieje, ale nie jest kompletnym środowiskiem Python." >&2
        echo "Przenieś ten katalog w bezpieczne miejsce i uruchom instalator ponownie." >&2
        return 1
    fi
    if [[ ! -x "$resolver_dir/bin/python" ]]; then
        echo "Tworzę prywatne środowisko resolverów: $resolver_dir"
        python3 -m venv "$resolver_dir"
    fi
    chmod 700 "$resolver_dir"
    echo "Instaluję bezpieczne wersje Streamlink i yt-dlp bez uprawnień administratora…"
    "$resolver_dir/bin/python" -m pip install \
        --disable-pip-version-check \
        --no-input \
        --upgrade \
        'streamlink>=8.4.0,<9' \
        'yt-dlp>=2026.06.09'
    check_resolvers
}

mode="${1:-install}"
if [[ $# -gt 1 ]]; then
    usage >&2
    exit 2
fi

case "$mode" in
    --check)
        status=0
        if ! python3 "$package_dir/native_host/install_host.py" "${host_args[@]}" --check; then
            status=1
        fi
        if ! check_resolvers; then
            status=1
        fi
        exit "$status"
        ;;
    --host-only)
        python3 "$package_dir/native_host/install_host.py" "${host_args[@]}"
        echo
        echo "Host MPV zainstalowany bez opcjonalnych resolverów."
        ;;
    install)
        install_resolvers
        python3 "$package_dir/native_host/install_host.py" "${host_args[@]}"
        echo
        echo "MPV Redirector Pro wraz z resolverami jest gotowy."
        ;;
    --help|-h)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

echo "Katalog dodatku: $package_dir"
echo "ID rozszerzenia: $extension_id"
echo
echo "W każdym profilu Chrome:"
echo "  1. Otwórz chrome://extensions"
echo "  2. Włącz Tryb dewelopera"
echo "  3. Kliknij Załaduj rozpakowane"
echo "  4. Wskaż katalog podany powyżej"

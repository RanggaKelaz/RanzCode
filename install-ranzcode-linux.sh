#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG='v1.0.1'
ARCHIVE_NAME='RanzCode-v1.0.1-linux-x64.tar.gz'
ARCHIVE_SHA256='963e48a3ce4c965bb50dc154154fe51f888af1885e7a8d2effe58db762d35182'
RELEASE_URL="https://github.com/RanggaKelaz/RanzCode/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}"

usage() {
  cat <<'EOF'
RanzCode Linux installer
Usage: install-ranzcode-linux.sh [--install-dir PATH] [--help]

Installs RanzCode CLI to ~/.local/bin. Linux x86_64 with glibc is required.
EOF
}

install_dir="${HOME:-}/.local/bin"
while (($#)); do
  case "$1" in
    --install-dir)
      if (($# < 2)) || [[ -z "$2" ]]; then
        printf '%s\n' 'Error: --install-dir requires a path.' >&2
        exit 2
      fi
      install_dir=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${HOME:-}" ]]; then
  printf '%s\n' 'Error: HOME is not set.' >&2
  exit 1
fi
if [[ "$(uname -s)" != 'Linux' ]]; then
  printf '%s\n' 'Error: this installer supports Linux only.' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) printf 'Error: unsupported architecture: %s (requires x86_64).\n' "$(uname -m)" >&2; exit 1 ;;
esac
if [[ -f /etc/alpine-release ]] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
  printf '%s\n' 'Error: this build requires glibc and does not support Alpine/musl.' >&2
  exit 1
fi
if [[ ! -e /lib64/ld-linux-x86-64.so.2 && ! -e /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 ]]; then
  printf '%s\n' 'Error: the glibc x86_64 loader was not found.' >&2
  exit 1
fi
for command_name in curl sha256sum tar mktemp install mv; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Error: required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

if [[ "$install_dir" != /* ]]; then
  install_dir="$PWD/$install_dir"
fi
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/ranzcode-install.XXXXXX")
staged_binary=''
cleanup() {
  if [[ -n "$staged_binary" && -e "$staged_binary" ]]; then
    rm -f -- "$staged_binary"
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

archive="$work_dir/$ARCHIVE_NAME"
printf 'Downloading RanzCode %s for Linux x86_64...\n' "$RELEASE_TAG"
curl -fsSL --retry 3 "$RELEASE_URL" -o "$archive"
printf '%s  %s\n' "$ARCHIVE_SHA256" "$archive" | sha256sum -c - >/dev/null || {
  printf '%s\n' 'Error: downloaded archive SHA-256 does not match.' >&2
  exit 1
}
mkdir "$work_dir/extracted"
tar -xzf "$archive" -C "$work_dir/extracted" ranzcode
binary="$work_dir/extracted/ranzcode"
if [[ ! -x "$binary" ]]; then
  printf '%s\n' 'Error: archive did not contain an executable ranzcode binary.' >&2
  exit 1
fi
version_output=$("$binary" --version 2>&1) || {
  printf '%s\n' 'Error: downloaded executable failed its version check.' >&2
  exit 1
}
if [[ "$version_output" != 'ranzcode v1.0.1' ]]; then
  printf 'Error: unexpected executable version: %s\n' "$version_output" >&2
  exit 1
fi

mkdir -p -- "$install_dir"
install_dir=$(cd -- "$install_dir" && pwd -P)
staged_binary=$(mktemp "$install_dir/.ranzcode.XXXXXX")
install -m 0755 -- "$binary" "$staged_binary"
mv -f -- "$staged_binary" "$install_dir/ranzcode"
staged_binary=''

printf 'Installed %s (%s)\n' "$install_dir/ranzcode" "$version_output"
case ":${PATH:-}:" in
  *":$install_dir:"*) printf '%s\n' 'Run: ranzcode --help' ;;
  *) printf 'Add %s to PATH, or run %s/ranzcode directly.\n' "$install_dir" "$install_dir" ;;
esac

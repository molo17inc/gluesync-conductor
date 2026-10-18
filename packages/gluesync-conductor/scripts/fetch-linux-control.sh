#!/bin/bash
# Downloads Gluesync Control for Linux (the static `gluesync` binary, one file per CPU) published by the
# gluesync-launcher-and-installer repo and stages it, with the run.sh shim and a VERSION file, so the Conductor image can
# carry it (Dockerfile: COPY build/kit-control/ kit-control/). The Conductor delivers these files to existing Linux kits
# at start (src/helpers/syncKitControl).
#
#   scripts/fetch-linux-control.sh [CHANNEL] [DEST_DIR]
#
# CHANNEL is ga or beta (default: $LINUX_CONTROL_CHANNEL, else ga). DEST_DIR defaults to build/kit-control of this
# package. The version, size and sha256 of each file come from the public catalog
# (api.backoffice.molo17.com/agent/gluesync-control-linux-<arch>/version). CI uses ga for release-* tags, beta otherwise.
#
# Staged in DEST_DIR: gluesync-linux-amd64, gluesync-linux-arm64, run.sh (copy of kit-control/run.sh) and VERSION (the
# version string, e.g. 1.4.2.425; both CPUs must report the same one).
#
# There is deliberately no fallback to a previously downloaded copy: stale files in DEST_DIR are removed first, and the
# script exits non-zero if the catalog has no such release, a download fails, the size or sha256 differ from the catalog,
# the file is not an ELF64 executable for the right CPU, or the two CPUs disagree on the version. Everything is staged only
# when both files validated.
#
# Needs bash, curl, jq, od, wc, sha256sum (or shasum). In CI (node:24.16.0-alpine): apk add --no-cache bash curl jq.
# LINUX_CONTROL_CATALOG_BASE_URL and LINUX_CONTROL_BASE_URL exist only so tests can point the script at a local server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CHANNEL="${1:-${LINUX_CONTROL_CHANNEL:-ga}}"
DEST_DIR="${2:-$PACKAGE_DIR/build/kit-control}"
CATALOG_BASE_URL="${LINUX_CONTROL_CATALOG_BASE_URL:-https://api.backoffice.molo17.com/agent}"
BASE_URL="${LINUX_CONTROL_BASE_URL:-https://molo17.com/gs-content/utils}"
SHIM="$PACKAGE_DIR/kit-control/run.sh"
ARCHS=(amd64 arm64)

fail() { echo "ERROR: $*" >&2; exit 1; }

case "$CHANNEL" in
  ga) KEY=GA ;;
  beta) KEY=Beta; BASE_URL="${BASE_URL}/beta" ;;
  *) fail "unknown channel '${CHANNEL}' (expected ga or beta)" ;;
esac

for tool in curl jq od wc; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required (in CI: apk add --no-cache bash curl jq)"
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "neither sha256sum nor shasum is available"
fi
[[ -f "$SHIM" ]] || fail "the run.sh shim ${SHIM} is missing"

mkdir -p "$DEST_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for arch in "${ARCHS[@]}"; do rm -f "${DEST_DIR:?}/gluesync-linux-$arch"; done
rm -f "${DEST_DIR:?}/VERSION" "${DEST_DIR:?}/run.sh"

echo "Downloading Gluesync Control for Linux (${CHANNEL}) from ${BASE_URL}..."
VERSION=""
for arch in "${ARCHS[@]}"; do
  f="gluesync-linux-$arch"
  row_url="${CATALOG_BASE_URL}/gluesync-control-linux-${arch}/version"
  curl -fsSL --retry 3 --retry-delay 2 -o "$TMP_DIR/$f.json" "$row_url" || fail "failed to read the catalog row ${row_url}"

  field() { jq -r --arg k "latestVersion${KEY}$1" '.[$k] // empty | tostring' "$TMP_DIR/$f.json" 2>/dev/null; }
  jq -e 'type == "object"' "$TMP_DIR/$f.json" >/dev/null 2>&1 || fail "the catalog answer for gluesync-control-linux-${arch} is not a JSON object"
  version="$(field '')"
  want_sha="$(field Sha256)"
  want_size="$(field SizeBytes)"
  if [[ -z "$version" || -z "$want_sha" || -z "$want_size" ]]; then
    hint=""
    [[ "$CHANNEL" == "ga" ]] && hint="; dev/test builds can use the beta channel"
    fail "no ${CHANNEL} release of Gluesync Control for Linux is published for ${arch} yet${hint}"
  fi
  [[ "$version" =~ ^[0-9]+(\.[0-9]+)+$ ]] || fail "the catalog version '${version}' for ${arch} is not a dotted number"
  [[ "$want_size" =~ ^[0-9]+$ ]] || fail "the catalog size '${want_size}' for ${arch} is not a number"
  [[ "$want_sha" =~ ^[0-9a-fA-F]{64}$ ]] || fail "the catalog sha256 '${want_sha}' for ${arch} is not a sha256"
  if [[ -n "$VERSION" && "$VERSION" != "$version" ]]; then
    fail "the CPUs disagree on the ${CHANNEL} version (${VERSION} vs ${version} for ${arch}); refusing to ship a mixed pair"
  fi
  VERSION="$version"

  curl -fsSL --retry 3 --retry-delay 2 -o "$TMP_DIR/$f" "${BASE_URL}/${f}" || fail "failed to download ${BASE_URL}/${f}"

  size="$(wc -c < "$TMP_DIR/$f" | tr -d ' ')"
  [[ "$size" == "$want_size" ]] || fail "$f is ${size} bytes, the catalog says ${want_size}; refusing to ship it"
  digest="$(sha256_of "$TMP_DIR/$f")"
  [[ "$digest" == "$(printf '%s' "$want_sha" | tr 'A-F' 'a-f')" ]] || fail "$f sha256 ${digest} differs from the catalog (${want_sha}); refusing to ship it"

  # ELF64 header: magic 7f 45 4c 46, EI_CLASS (byte 4) = 2 (64-bit), e_machine (bytes 18-19, little endian): 3e 00 x86-64, b7 00 AArch64.
  case "$arch" in amd64) machine="3e 00" ;; arm64) machine="b7 00" ;; esac
  magic="$(od -An -tx1 -j0 -N5 "$TMP_DIR/$f" | tr -s ' ' | sed 's/^ //;s/ $//')"
  emachine="$(od -An -tx1 -j18 -N2 "$TMP_DIR/$f" | tr -s ' ' | sed 's/^ //;s/ $//')"
  [[ "$size" -gt 20 && "$magic" == "7f 45 4c 46 02" && "$emachine" == "$machine" ]] \
    || fail "$f is not an ELF64 executable for ${arch} (${size} bytes); refusing to ship it"
  echo "$f: ${CHANNEL} ${version}, ELF ${arch} ok, ${size} bytes, sha256 ${digest}"
done

# Stage only when every file downloaded and validated, so a failure never leaves a half-updated pair behind.
for arch in "${ARCHS[@]}"; do
  mv "$TMP_DIR/gluesync-linux-$arch" "$DEST_DIR/gluesync-linux-$arch"
  chmod 755 "$DEST_DIR/gluesync-linux-$arch"
done
cp "$SHIM" "$DEST_DIR/run.sh"
chmod 755 "$DEST_DIR/run.sh"
printf '%s\n' "$VERSION" > "$DEST_DIR/VERSION"
echo "Gluesync Control for Linux ${VERSION} (${CHANNEL}) staged in ${DEST_DIR}"

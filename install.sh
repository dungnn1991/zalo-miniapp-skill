#!/usr/bin/env bash
# install.sh — cài skill create-zmp-app cho agent host, KHÔNG cần git/clone.
#
#   curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash
#   ... | bash -s -- --version v0.3.0          # chỉ định version rõ ràng (git tag)
#   ... | bash -s -- --channel staging          # bản thử nghiệm (nhánh staging)
#   ... | bash -s -- --codex <dir>              # cài thêm cho Codex host
#   ... | bash -s -- --dest <dir>               # đổi đích (default ~/.claude/skills)
#
# Quy tắc version (tránh mất thời gian check bug sai bản):
#   - KHÔNG có --version/--channel → tự resolve TAG MỚI NHẤT trên repo (không lấy HEAD trần).
#   - Bản cài luôn được stamp vào INSTALLED_VERSION (version + ref + ngày) — khi báo bug
#     PHẢI kèm nội dung file này.
set -euo pipefail

REPO="dungnn1991/zalo-miniapp-skill"
DEST="${HOME}/.claude/skills"
CODEX_DEST=""
REF=""
CHANNEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) REF="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --codex)   CODEX_DEST="$2"; shift 2 ;;
    --dest)    DEST="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$REF" && -n "$CHANNEL" ]]; then
  echo "install: dùng --version HOẶC --channel, không dùng cả hai" >&2; exit 2
fi

if [[ -z "$REF" ]]; then
  if [[ "$CHANNEL" == "staging" ]]; then
    REF="staging"
    echo "install: kênh STAGING (thử nghiệm liên tục — không dùng cho demo)"
  else
    # Bản release mới nhất = tag mới nhất trên repo
    REF="$(curl -fsSL "https://api.github.com/repos/${REPO}/tags?per_page=1" \
      | sed -n 's/.*"name": *"\(v[^"]*\)".*/\1/p' | head -1 || true)"
    if [[ -z "$REF" ]]; then
      echo "install: không resolve được tag mới nhất — dừng (chỉ định --version vX.Y.Z hoặc --channel staging)" >&2
      exit 1
    fi
    echo "install: version mới nhất = ${REF}"
  fi
fi

command -v node >/dev/null || { echo "install: cần Node >= 20" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "install: tải ${REPO}@${REF} ..."
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" | tar -xz -C "$TMP" --strip-components=1

SRC="$TMP/skill/create-zmp-app"
[[ -f "$SRC/SKILL.md" ]] || { echo "install: archive không có skill/create-zmp-app" >&2; exit 1; }

COMMIT_NOTE="$(curl -fsSL "https://api.github.com/repos/${REPO}/commits/${REF}" 2>/dev/null \
  | sed -n 's/.*"sha": *"\([0-9a-f]\{7\}\)[0-9a-f]*".*/\1/p' | head -1 || true)"
PKG_VER="$(node -e "console.log(require('$SRC/package.json').version)")"
printf 'version=%s\nref=%s\ncommit=%s\ninstalledAt=%s\n' \
  "$PKG_VER" "$REF" "${COMMIT_NOTE:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SRC/INSTALLED_VERSION"

install_to() {
  local dest="$1/create-zmp-app"
  mkdir -p "$1"
  rm -rf "$dest.tmp"
  cp -R "$SRC" "$dest.tmp"
  # giữ node_modules cũ nếu có (doctor sẽ tự bổ sung khi thiếu)
  [[ -d "$dest/node_modules" ]] && mv "$dest/node_modules" "$dest.tmp/node_modules"
  rm -rf "$dest" && mv "$dest.tmp" "$dest"
  echo "install: ✓ $dest ($PKG_VER, $REF)"
}

install_to "$DEST"
[[ -n "$CODEX_DEST" ]] && install_to "$CODEX_DEST"

echo ""
echo "Xong. Mở session agent mới và gõ thử:  tạo app bán quần áo với appId=..."
echo "Khi báo bug, kèm:  cat ${DEST}/create-zmp-app/INSTALLED_VERSION"

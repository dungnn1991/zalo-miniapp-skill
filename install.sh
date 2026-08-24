#!/usr/bin/env bash
# install.sh — cài skill create-zmp-app cho agent host, KHÔNG cần git/clone.
#
#   curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash
#       → mặc định cài cho CODEX (~/.codex/skills). Claude Code nên cài qua plugin
#         marketplace (README); curl chỉ là đường phụ: --host claude.
#
#   ... | bash -s -- --host codex|claude|both    # chọn host đích (default: codex)
#   ... | bash -s -- --version v0.4.0            # chỉ định version rõ ràng (git tag)
#   ... | bash -s -- --channel staging           # bản thử nghiệm (nhánh staging)
#   ... | bash -s -- --dest <dir>                # cài vào <dir>/create-zmp-app (bỏ qua --host)
#
# Quy tắc version (tránh mất thời gian check bug sai bản):
#   - KHÔNG có --version/--channel → tự resolve TAG MỚI NHẤT trên repo (không lấy HEAD trần).
#   - Bản cài luôn được stamp vào INSTALLED_VERSION (version + ref + ngày) — khi báo bug
#     PHẢI kèm nội dung file này.
set -euo pipefail

REPO="dungnn1991/zalo-miniapp-skill"
HOST="codex"
DEST=""
REF=""
CHANNEL=""
SRC_DIR=""

while [[ $# -gt 0 ]]; do
  if [[ "$1" == --* && -z "${2:-}" ]]; then
    echo "install: $1 cần giá trị ngay sau nó" >&2; exit 2
  fi
  case "$1" in
    --host)    HOST="$2"; shift 2 ;;
    --version) REF="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --dest)    DEST="$2"; shift 2 ;;
    --codex)   echo "install: --codex <dir> đã deprecated, dùng --host codex hoặc --dest <dir>" >&2
               DEST="$2"; shift 2 ;;
    --src-dir) SRC_DIR="$2"; shift 2 ;;   # test/dev: dùng repo local thay vì tải GitHub
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$HOST" in codex|claude|both) ;; *)
  echo "install: --host phải là codex, claude hoặc both (nhận: $HOST)" >&2; exit 2 ;;
esac
if [[ -n "$CHANNEL" && "$CHANNEL" != "staging" ]]; then
  echo "install: --channel chỉ nhận 'staging' (nhận: $CHANNEL) — bản release thì dùng --version vX.Y.Z" >&2; exit 2
fi
if [[ -n "$REF" && -n "$CHANNEL" ]]; then
  echo "install: dùng --version HOẶC --channel, không dùng cả hai" >&2; exit 2
fi

command -v node >/dev/null || { echo "install: cần Node >= 20" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -n "$SRC_DIR" ]]; then
  [[ -f "$SRC_DIR/skill/create-zmp-app/SKILL.md" ]] || {
    echo "install: --src-dir không có skill/create-zmp-app" >&2; exit 1; }
  REF="${REF:-src-dir}"
  # Stage vào TMP để stamp INSTALLED_VERSION mà không đụng vào source. Loại node_modules
  # của dev tree — tarball GitHub không bao giờ có, install phải giống hệt.
  tar -C "$SRC_DIR/skill" --exclude='node_modules' -cf - create-zmp-app | tar -xf - -C "$TMP"
  mv "$TMP/create-zmp-app" "$TMP/pkg"
  COMMIT_NOTE="local"
else
  if [[ -z "$REF" ]]; then
    if [[ "$CHANNEL" == "staging" ]]; then
      REF="staging"
      echo "install: kênh STAGING (thử nghiệm liên tục — không dùng cho demo)"
    else
      # Bản release mới nhất = tag STABLE cao nhất (vX.Y.Z đúng dạng — loại rc/alpha/beta,
      # kẻo một pre-release đầu tiên chiếm chỗ mọi bản cài mặc định). API GitHub
      # unauthenticated có rate-limit 60 req/giờ theo IP → fallback git ls-remote.
      STABLE_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
      REF="$(curl -fsSL "https://api.github.com/repos/${REPO}/tags?per_page=100" 2>/dev/null \
        | sed -n 's/.*"name": *"\(v[^"]*\)".*/\1/p' | grep -E "$STABLE_RE" | sort -V | tail -1 || true)"
      if [[ -z "$REF" ]] && command -v git >/dev/null; then
        REF="$(git ls-remote --tags "https://github.com/${REPO}.git" 2>/dev/null \
          | sed -n 's|.*refs/tags/\(v[0-9][^^{}]*\)$|\1|p' | grep -E "$STABLE_RE" | sort -V | tail -1 || true)"
      fi
      if [[ -z "$REF" ]]; then
        echo "install: không resolve được tag mới nhất (mạng hoặc GitHub API rate-limit) —" >&2
        echo "install: chỉ định --version vX.Y.Z hoặc --channel staging rồi chạy lại" >&2
        exit 1
      fi
      echo "install: version mới nhất = ${REF}"
    fi
  fi
  echo "install: tải ${REPO}@${REF} ..."
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" | tar -xz -C "$TMP" --strip-components=1
  [[ -f "$TMP/skill/create-zmp-app/SKILL.md" ]] || {
    echo "install: archive không có skill/create-zmp-app" >&2; exit 1; }
  mv "$TMP/skill/create-zmp-app" "$TMP/pkg"
  COMMIT_NOTE="$(curl -fsSL "https://api.github.com/repos/${REPO}/commits/${REF}" 2>/dev/null \
    | sed -n 's/.*"sha": *"\([0-9a-f]\{7\}\)[0-9a-f]*".*/\1/p' | head -1 || true)"
fi

SRC="$TMP/pkg"
PKG_VER="$(node -e "console.log(require('$SRC/package.json').version)")"
printf 'version=%s\nref=%s\ncommit=%s\ninstalledAt=%s\n' \
  "$PKG_VER" "$REF" "${COMMIT_NOTE:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SRC/INSTALLED_VERSION"

install_to() {
  local dest="$1/create-zmp-app"
  mkdir -p "$1"
  rm -rf "$dest.tmp"
  cp -R "$SRC" "$dest.tmp"
  # Chỉ giữ node_modules cũ khi lockfile KHÔNG đổi — lockfile khác thì để doctor cài mới,
  # tránh chạy skill mới trên dependency cũ.
  if [[ -d "$dest/node_modules" ]] && cmp -s "$dest/pnpm-lock.yaml" "$SRC/pnpm-lock.yaml"; then
    mv "$dest/node_modules" "$dest.tmp/node_modules"
  fi
  rm -rf "$dest" && mv "$dest.tmp" "$dest"
  echo "install: ✓ $dest ($PKG_VER, $REF)"
  LAST_DEST="$dest"
}

LAST_DEST=""
if [[ -n "$DEST" ]]; then
  install_to "$DEST"
else
  if [[ "$HOST" == "codex" || "$HOST" == "both" ]]; then install_to "${HOME}/.codex/skills"; fi
  if [[ "$HOST" == "claude" || "$HOST" == "both" ]]; then install_to "${HOME}/.claude/skills"; fi
fi

echo ""
echo "Xong. Mở session agent mới và gõ thử:  tạo app bán quần áo với appId=..."
echo "Khi báo bug, kèm:  cat ${LAST_DEST}/INSTALLED_VERSION"

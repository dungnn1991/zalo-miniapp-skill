#!/usr/bin/env bash
# clean-workspaces.sh — dọn disk các workspace/output máy sinh (đều đã gitignore).
# Hygiene round 2 slice A2 (DX file 55, hardening theo review độc lập 2026-08-27):
#   - Repo root resolve từ VỊ TRÍ SCRIPT, độc lập cwd; fail-closed nếu sentinel sai.
#   - CHỈ xoá đúng 3 nhóm path allowlist bên dưới — không nhận path từ tham số.
#   - Mặc định DRY-RUN (liệt kê + tổng dung lượng); phải --yes mới xoá thật.
#   - Từ chối chạy khi có eval/qualify process đang sống (tránh race xoá workspace đang dùng).
# Chạy TAY sau mỗi đợt eval. Fixture tracked (vd deploy-qr-parse/fixture/) không nằm trong
# allowlist nên không bao giờ bị đụng.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Sentinel fail-closed: đúng repo này mới được chạy.
for s in .claude-plugin/plugin.json evaluation/run-all.mjs skill/create-zmp-app/SKILL.md; do
  [ -e "$ROOT/$s" ] || { echo "clean-workspaces: sentinel thiếu ($s) — sai repo root, dừng." >&2; exit 3; }
done

if pgrep -f "run-case\.mjs|run-all\.mjs|run-corpus\.mjs|qualify-template\.mjs" >/dev/null 2>&1; then
  echo "clean-workspaces: đang có eval/qualify process chạy — dọn sau khi chúng xong." >&2
  exit 3
fi

YES=0
[ "${1:-}" = "--yes" ] && YES=1

TARGETS=()
while IFS= read -r d; do TARGETS+=("$d"); done < <(
  find "$ROOT/evaluation/cases" -mindepth 2 -maxdepth 2 -type d -name workspace 2>/dev/null
  find "$ROOT/runs" -mindepth 1 -maxdepth 1 2>/dev/null
  find "$ROOT/bench/results" -mindepth 1 -maxdepth 1 2>/dev/null
)

if [ "${#TARGETS[@]}" -eq 0 ]; then echo "clean-workspaces: không có gì để dọn."; exit 0; fi

TOTAL=$(du -sch "${TARGETS[@]}" 2>/dev/null | tail -1 | cut -f1)
echo "clean-workspaces: ${#TARGETS[@]} mục, tổng ~${TOTAL}:"
for t in "${TARGETS[@]}"; do echo "  ${t#"$ROOT"/}"; done

if [ "$YES" -ne 1 ]; then
  echo "(dry-run — thêm --yes để xoá thật)"
  exit 0
fi

for t in "${TARGETS[@]}"; do
  case "$t" in
    "$ROOT"/evaluation/cases/*/workspace|"$ROOT"/runs/*|"$ROOT"/bench/results/*) rm -rf "$t" ;;
    *) echo "clean-workspaces: path ngoài allowlist, bỏ qua: $t" >&2 ;;
  esac
done
echo "clean-workspaces: đã dọn ${#TARGETS[@]} mục (~${TOTAL})."

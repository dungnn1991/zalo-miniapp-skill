#!/usr/bin/env bash
# clean-workspaces.sh — dọn disk output máy sinh (workspace eval, runs, bench results).
# Hygiene round 2 slice A2, HARDENED theo review độc lập 2026-08-28 (DX file 56):
#   nguyên tắc "ignored ≠ disposable" — script phải TỰ CHỨNG MINH từng target được phép dọn.
#
#   1. Repo root resolve từ vị trí script + sentinel fail-closed (đúng repo mới chạy).
#   2. ABORT TOÀN BỘ nếu bất kỳ target nào chứa file TRACKED (git ls-files) — kể cả add -f.
#   3. Chỉ nhận case-workspace có marker do harness tạo (app/runs/home/pkg/script-install);
#      thiếu marker = có thể là dữ liệu tay → skip + cảnh báo.
#   4. Retention: giữ N mục mới nhất của runs/ và bench/results/ (--keep N, default 2);
#      giữ run có result.json status=fail; giữ run được feedback/*.jsonl tham chiếu;
#      mục/con có file .keep → giữ.
#   5. Mặc định KHÔNG xoá vĩnh viễn: move (rename, không tốn disk) vào .trash/<ts>/ —
#      xoá thật bằng --purge-trash --yes ở vòng sau, khi chắc không cần gì.
#   6. Lock mkdir chống chạy chồng + pgrep chặn khi eval/qualify đang sống (pgrep vẫn có
#      race lý thuyết với runner — phối hợp lock hai chiều cần sửa runner, ngoài scope A2).
# Dry-run mặc định; --yes mới hành động. Chạy TAY sau mỗi đợt eval.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for s in .claude-plugin/plugin.json evaluation/run-all.mjs skill/create-zmp-app/SKILL.md; do
  [ -e "$ROOT/$s" ] || { echo "clean-workspaces: sentinel thiếu ($s) — sai repo root, dừng." >&2; exit 3; }
done

YES=0; KEEP=2; PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    --purge-trash) PURGE=1; shift ;;
    *) echo "clean-workspaces: tham số lạ '$1' (chỉ nhận --yes, --keep N, --purge-trash)" >&2; exit 3 ;;
  esac
done

if [ "$PURGE" -eq 1 ]; then
  [ -d "$ROOT/.trash" ] || { echo "clean-workspaces: không có .trash/ để purge."; exit 0; }
  du -sh "$ROOT/.trash" | sed 's|'"$ROOT"'/||'
  if [ "$YES" -ne 1 ]; then echo "(dry-run — thêm --yes để xoá vĩnh viễn .trash/)"; exit 0; fi
  rm -rf "$ROOT/.trash"; echo "clean-workspaces: đã purge .trash/."; exit 0
fi

if pgrep -f "run-case\.mjs|run-all\.mjs|run-corpus\.mjs|qualify-template\.mjs" >/dev/null 2>&1; then
  echo "clean-workspaces: đang có eval/qualify process chạy — dọn sau." >&2; exit 3
fi
LOCK="$ROOT/.clean-workspaces.lock"
mkdir "$LOCK" 2>/dev/null || { echo "clean-workspaces: lock đang giữ ($LOCK) — instance khác đang chạy?" >&2; exit 3; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# runId được findings/improvements tham chiếu → không dọn (evidence pointer còn sống).
REFIDS="$(grep -rhoE 'run-[0-9TZ:-]+[a-z0-9-]*' "$ROOT/feedback" 2>/dev/null | sort -u || true)"
is_referenced() { [ -n "$REFIDS" ] && printf '%s\n' "$REFIDS" | grep -qxF "$(basename "$1")"; }
has_keep() { find "$1" -maxdepth 2 -name .keep -print -quit 2>/dev/null | grep -q .; }
newest_n() { ls -1t "$1" 2>/dev/null | head -n "$2"; }

TARGETS=(); SKIPPED=()
# 1) case workspaces — cần harness marker, không .keep, không chứa run được tham chiếu.
while IFS= read -r ws; do
  [ -n "$ws" ] || continue
  if has_keep "$ws"; then SKIPPED+=("$ws (.keep)"); continue; fi
  if ! find "$ws" -maxdepth 1 \( -name app -o -name runs -o -name home -o -name pkg -o -name script-install -o -name target-ws \) -print -quit | grep -q .; then
    SKIPPED+=("$ws (không có harness marker — có thể dữ liệu tay)"); continue
  fi
  ref=0; for r in "$ws"/runs/* "$ws"/*/runs/*; do [ -e "$r" ] && is_referenced "$r" && ref=1 && break; done
  if [ "$ref" -eq 1 ]; then SKIPPED+=("$ws (chứa run được findings tham chiếu)"); continue; fi
  TARGETS+=("$ws")
done < <(find "$ROOT/evaluation/cases" -mindepth 2 -maxdepth 2 -type d -name workspace 2>/dev/null)
# 2) runs/ + bench/results — retention N mới nhất, giữ fail, giữ referenced, giữ .keep.
for base in "$ROOT/runs" "$ROOT/bench/results"; do
  [ -d "$base" ] || continue
  KEEPLIST="$(newest_n "$base" "$KEEP")"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    t="$base/$name"
    if printf '%s\n' "$KEEPLIST" | grep -qxF "$name"; then SKIPPED+=("$t (retention $KEEP mới nhất)"); continue; fi
    if has_keep "$t"; then SKIPPED+=("$t (.keep)"); continue; fi
    if is_referenced "$t"; then SKIPPED+=("$t (findings tham chiếu)"); continue; fi
    if [ -f "$t/result.json" ] && grep -q '"status": *"fail"' "$t/result.json" 2>/dev/null; then
      SKIPPED+=("$t (run fail — giữ để chẩn đoán)"); continue
    fi
    TARGETS+=("$t")
  done < <(ls -1 "$base" 2>/dev/null)
done

# Chốt an toàn tuyệt đối: bất kỳ target nào chứa file TRACKED → abort toàn bộ.
for t in "${TARGETS[@]:-}"; do
  [ -n "$t" ] || continue
  rel="${t#"$ROOT"/}"
  if [ -n "$(git -C "$ROOT" ls-files -- "$rel" | head -1)" ]; then
    echo "clean-workspaces: ABORT — '$rel' chứa file TRACKED trong git. Không dọn gì cả." >&2
    echo "  (gỡ tracked có chủ đích bằng git rm --cached trước, hoặc thêm .keep để giữ)" >&2
    exit 4
  fi
done

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "Giữ lại (${#SKIPPED[@]}):"; for s in "${SKIPPED[@]}"; do echo "  ${s#"$ROOT"/}"; done
fi
if [ "${#TARGETS[@]:-0}" -eq 0 ] || [ -z "${TARGETS[0]:-}" ]; then echo "clean-workspaces: không có gì để dọn."; exit 0; fi
TOTAL=$(du -sch "${TARGETS[@]}" 2>/dev/null | tail -1 | cut -f1)
echo "Sẽ chuyển vào .trash (${#TARGETS[@]} mục, ~${TOTAL}):"
for t in "${TARGETS[@]}"; do echo "  ${t#"$ROOT"/}"; done
if [ "$YES" -ne 1 ]; then echo "(dry-run — thêm --yes để chuyển vào .trash; xoá vĩnh viễn dùng --purge-trash sau)"; exit 0; fi

TRASH="$ROOT/.trash/clean-$(date -u +%Y%m%dT%H%M%SZ)"
for t in "${TARGETS[@]}"; do
  rel="${t#"$ROOT"/}"; dest="$TRASH/$rel"
  mkdir -p "$(dirname "$dest")"; mv "$t" "$dest"
done
echo "clean-workspaces: đã chuyển ${#TARGETS[@]} mục (~${TOTAL}) vào ${TRASH#"$ROOT"/}."
echo "Xoá vĩnh viễn khi chắc chắn: evaluation/clean-workspaces.sh --purge-trash --yes"

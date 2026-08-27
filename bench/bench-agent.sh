#!/usr/bin/env bash
# bench/bench-agent.sh — benchmark động: agent thật chạy skill qua `claude -p`, đo token/cost.
# Tooling dev ở root repo — KHÔNG thuộc bộ skill release. TỐN TIỀN API THẬT — không đưa vào CI.
#
# Cách ly để các lần đo độc lập:
#   - mỗi run một workspace mktemp làm cwd (tránh guard existing_app biến run 2..N thành
#     kịch bản khác);
#   - kết quả thô + meta lưu bench/results/<label>/ để summarize.mjs phân loại cold/warm
#     (theo cache_creation vs cache_read) và loại run sai kết cục.
#
# Usage:
#   bench/bench-agent.sh --label v0.5.0 [--runs 3] [--scenarios S4-diagnose-cors,S5-negative-knowledge]
#                        [--model claude-opus-5] [--heavy]
#   (mặc định: mọi scenario không-heavy trong bench/scenarios.json, 3 run/scenario)
#
# LƯU Ý version: script đo PLUGIN ĐANG CÀI trên máy, không phải working tree. Trước khi đo một
# release, cài đúng bản plugin đó rồi truyền --label khớp; meta.json ghi lại claude --version
# + model + thời điểm để đối chiếu.
set -euo pipefail

cd "$(dirname "$0")/.."
LABEL="" RUNS=3 MODEL="" ONLY="" HEAVY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --scenarios) ONLY="$2"; shift 2 ;;
    --heavy) HEAVY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 3 ;;
  esac
done
[ -n "$LABEL" ] || { echo "cần --label <tên bản đo, vd v0.5.0>" >&2; exit 3; }
command -v claude >/dev/null || { echo "không tìm thấy claude CLI" >&2; exit 3; }
command -v jq >/dev/null || { echo "cần jq" >&2; exit 3; }

[ -n "$MODEL" ] || MODEL=$(jq -r '.model' bench/scenarios.json)
OUT="bench/results/$LABEL"
mkdir -p "$OUT"
jq -n --arg label "$LABEL" --arg model "$MODEL" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg claude "$(claude --version 2>/dev/null | head -1)" \
      '{label:$label, model:$model, startedAt:$date, claudeVersion:$claude}' > "$OUT/meta.json"

SELECT='.scenarios[]'
[ "$HEAVY" = 1 ] || SELECT="$SELECT | select(.heavy | not)"

jq -c "$SELECT" bench/scenarios.json | while read -r sc; do
  id=$(jq -r '.id' <<<"$sc")
  if [ -n "$ONLY" ] && ! grep -Eq "(^|,)$id(,|\$)" <<<"$ONLY"; then continue; fi
  prompt=$(jq -r '.prompt' <<<"$sc")
  for i in $(seq 1 "$RUNS"); do
    W=$(mktemp -d)
    echo ">> $id run $i (cwd $W)" >&2
    if (cd "$W" && claude -p "$prompt" --output-format json --model "$MODEL") > "$OUT/${id}__run${i}.json" 2>"$OUT/${id}__run${i}.stderr"; then
      jq -r '"   turns=\(.num_turns) cost=$\(.total_cost_usd) in=\(.usage.input_tokens) cacheR=\(.usage.cache_read_input_tokens) cacheW=\(.usage.cache_creation_input_tokens) out=\(.usage.output_tokens)"' \
        "$OUT/${id}__run${i}.json" >&2 || true
    else
      echo "   RUN LỖI — xem ${id}__run${i}.stderr" >&2
    fi
    rm -rf "$W"
  done
done
echo "Xong. Tổng hợp: node bench/summarize.mjs $LABEL [labelCũ]" >&2

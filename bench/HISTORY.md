# Token budget history — create-zmp-app

Sổ theo dõi trọng-lượng-context của skill qua từng version. Mỗi lần bump version, chạy:

```bash
node bench/token-budget.mjs --record --note "lý do chính của đợt thay đổi"
```

Release-gate (validate-release) **enforce** row của version hiện tại phải tồn tại và khớp số
đo lại từ working tree — quên ghi sổ hoặc số lệch là CI đỏ. Số là **ước lượng offline**
(length/3.4, cùng estimator mọi row) nên delta giữa các version so sánh được; số tuyệt đối
chính xác lấy bằng `--api` khi cần. Ý nghĩa cột: `tax` = description (mọi session đều trả),
`trigger` = SKILL.md (trả khi invoke), `ondemand` = references/schemas/config (trả khi agent
mở từng file). Kết quả bench động (tốn tiền, chạy tay) dán vào mục cuối file, không enforce.

| Ngày | Version | tax | trigger | ondemand | Δtrigger | Δondemand | Ghi chú |
|---|---|---|---|---|---|---|---|
| 2026-08-24 | 0.4.1 | 146 | 7563 | 39637 | — | — | backfill từ tag v0.4.1 |
| 2026-08-27 | 0.5.0 | 146 | 8072 | 48752 | +509 (+6.7%) | +9115 (+23.0%) | plan51 Portal docs + App ID guidance + guardrail subpath (PR #10, #12) |
| 2026-08-27 | 0.5.1 | 146 | 8072 | 48841 | +0 (+0.0%) | +89 (+0.2%) | v0.5.1 fix harness (BUG-1 subpath lab, BUG-2 result.json) từ test độc lập Codex — số theo tag v0.5.1 (khôi phục 2026-08-27 sau khi bị --record đè) |
| 2026-09-03 | 0.5.2 | 146 | 8126 | 47998 | +54 (+0.7%) | -843 (-1.7%) | train hygiene round 2 — slice B: validator/case đọc registry, schema runtime, trim config officialTemplates.catalog |

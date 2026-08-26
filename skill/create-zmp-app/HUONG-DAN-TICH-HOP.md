# create-zmp-app — Hướng dẫn tích hợp

Skill tạo Zalo Mini App từ một câu prompt: scaffold → build → chạy thử trong browser/giả lập
→ (tuỳ chọn) deploy Development/Testing. Package tự chứa — copy 1 folder là xong.

## Cài đặt

### Cách 1 — Claude Code, qua marketplace (khuyên dùng cho mọi người, kể cả không phải dev)

Gõ 2 lệnh trong Claude Code, một lần duy nhất:

```
/plugin marketplace add dungnn1991/zalo-miniapp-skill
/plugin install create-zmp-app@zalo-miniapp-skill
```

Cập nhật bản mới: `/plugin update create-zmp-app`.

### Cách 2 — Một dòng curl (Codex mặc định; Claude/host khác qua flag)

```bash
# bản RELEASE stable mới nhất, cài cho Codex (~/.codex/skills — default):
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash

# cài cho Claude Code (hoặc --host both cho cả hai):
curl -fsSL .../main/install.sh | bash -s -- --host claude

# chỉ định version rõ ràng (khi cần tái hiện đúng bản để check bug):
curl -fsSL .../main/install.sh | bash -s -- --version v0.4.1

# kênh thử nghiệm (team nội bộ, đổi liên tục — KHÔNG dùng cho demo):
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/staging/install.sh | bash -s -- --channel staging

# đích tuỳ ý: --dest <dir>  (cài vào <dir>/create-zmp-app, bỏ qua --host)
```

**Quy tắc version (bắt buộc khi báo bug):** bản cài bằng `install.sh` có
`INSTALLED_VERSION` (version + ref + ngày) và in `doctor: ok — create-zmp-app vX.Y.Z (ref)`.
Claude Plugin dùng version do marketplace quản lý và in `(claude-plugin vX.Y.Z)`; đối chiếu
thêm bằng `/plugin details`. Bản copy tay không stamp in `(dev copy)`.

Yêu cầu máy: Node ≥ 20, Google Chrome (dùng Chrome hệ thống); `zmp-cli` chỉ cần khi deploy;
pnpm khuyên dùng (không có sẽ fallback npm). KHÔNG cần cài dependency tay — doctor tự lo
lần chạy đầu.

Kiểm tra CORS mặc định là passive source scan, không gửi request ra endpoint của app.
Chỉ khi đã được phép probe live mới chạy agent với `MB_ENABLE_CORS_PROBE=1`.

## Cài đặt thủ công (dev, từ source)

**Bước 1 — copy folder `create-zmp-app/` vào nơi agent host đọc skill:**

- **Claude Code:** `~/.claude/skills/create-zmp-app/` (hoặc `.claude/skills/` của project).
- **Codex CLI:** `~/.codex/skills/create-zmp-app/` — Codex discover bằng frontmatter của
  `SKILL.md` (gọi bằng `$create-zmp-app`); `agents/openai.yaml` chỉ là UI metadata.
  **Version cũ chưa hỗ trợ thư mục skills?** Cách fallback luôn chạy: đặt folder ở đâu cũng
  được, rồi thêm 1 dòng vào `AGENTS.md` của project:

  ```
  Khi user nhắc tạo/deploy/chạy thử Zalo Mini App: đọc và làm theo <path>/create-zmp-app/SKILL.md.
  ```

**Bước 2 — không có bước 2.** KHÔNG cần `pnpm install` thủ công: lần chạy đầu, doctor của
skill tự cài dependency. Máy chỉ cần sẵn:

- Node ≥ 20 và pnpm
- Google Chrome (skill dùng Chrome hệ thống, không tải browser riêng)
- `zmp-cli` — chỉ cần khi deploy

## Sử dụng — toàn bộ UX là gõ prompt

| Bạn muốn | Prompt mẫu |
|---|---|
| Tạo app theo mô tả | `tạo app bán quần áo với appId=2607885...` |
| Tạo từ mẫu chính thức đã support | `tạo app thời trang dùng mẫu zaui-fashion, appId=...` |
| Chạy thử giả lập (không cần Zalo) | `chạy giả lập app, thử flow xin quyền` |
| Deploy bản Development | `deploy bản development` |
| Deploy Testing kèm mô tả | `deploy testing với mô tả "demo sprint 3"` |
| Chẩn đoán lỗi | `app đang lỗi Network Error, check giúp` |

Cú pháp Codex explicit: `$create-zmp-app tạo app bán quần áo với appId="..."`.

Brief viết **tiếng Anh hay tiếng Việt (có dấu lẫn không dấu)** đều được.
Đây là khả năng nhận intent/ngôn ngữ, không phải sinh UI domain tuỳ ý: template bundle
chỉ có `clothing-store` và shell `neutral`; domain khác cần agent tích hợp tiếp.

Sau khi build + verify xong, agent **tự mở bản preview** cho bạn xem (browser, hoặc giả lập
nếu bạn nhắc), kèm báo cáo kết quả + gợi ý bước tiếp theo.

**Điểm chạm của bạn chỉ gồm:** gõ prompt · quét QR bằng Zalo khi deploy · trả lời khi được
hỏi (App ID, chọn mẫu, xác nhận deploy). Hết — mọi lệnh/kiểm tra agent tự chạy ngầm.

## Tài liệu

- `SKILL.md` — contract đầy đủ (workflow, guardrails, exit codes) mà agent tuân theo.
- `references/` — troubleshooting, vận hành + phát hành, quyền, lấy App ID, recipe tính năng,
  convert web app, deploy, simulator, mock data.
- `config.json` — mọi fact khoá (markers, catalog mẫu, zmp-cli, simulator).

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

### Cách 2 — Một dòng curl (Codex/host khác, hoặc thích script)

```bash
# bản RELEASE mới nhất (tự resolve tag mới nhất — không lấy code lửng lơ):
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash

# chỉ định version rõ ràng (khi cần tái hiện đúng bản để check bug):
curl -fsSL .../main/install.sh | bash -s -- --version v0.3.0

# kênh thử nghiệm (team nội bộ, đổi liên tục — KHÔNG dùng cho demo):
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/staging/install.sh | bash -s -- --channel staging

# cài thêm cho Codex: thêm  --codex <thư-mục-skills-codex>
```

**Quy tắc version (bắt buộc khi báo bug):** bản cài luôn có file `INSTALLED_VERSION`
(version + ref + ngày) và mỗi lần chạy in `doctor: ok — create-zmp-app vX.Y.Z (ref)`.
Báo bug PHẢI kèm dòng đó — sai version là mất thời gian check bug vô ích.

Yêu cầu máy: Node ≥ 20, Google Chrome (dùng Chrome hệ thống); `zmp-cli` chỉ cần khi deploy;
pnpm khuyên dùng (không có sẽ fallback npm). KHÔNG cần cài dependency tay — doctor tự lo
lần chạy đầu.

## Cài đặt thủ công (dev, từ source)

**Bước 1 — copy folder `create-zmp-app/` vào nơi agent host đọc skill:**

- **Claude Code:** `~/.claude/skills/create-zmp-app/` (hoặc `.claude/skills/` của project).
- **Codex CLI:** nếu version của bạn hỗ trợ thư mục skills thì đặt vào đó (agent đọc
  `agents/openai.yaml`, gọi bằng `$create-zmp-app`). **Không chắc version hỗ trợ?** Cách
  fallback luôn chạy: đặt folder ở đâu cũng được, rồi thêm 1 dòng vào `AGENTS.md` của
  project:

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
| Tạo từ mẫu chính thức | `tạo app cà phê dùng mẫu có sẵn, appId=...` |
| Chạy thử giả lập (không cần Zalo) | `chạy giả lập app, thử flow xin quyền` |
| Deploy bản Development | `deploy bản development` |
| Deploy Testing kèm mô tả | `deploy testing với mô tả "demo sprint 3"` |
| Chẩn đoán lỗi | `app đang lỗi Network Error, check giúp` |

Cú pháp Codex explicit: `$create-zmp-app tạo app bán quần áo với appId="..."`.

Brief viết **tiếng Anh hay tiếng Việt (có dấu lẫn không dấu)** đều được — "tạo app đặt món" = "tao app dat mon" = "create a food ordering app".

Sau khi build + verify xong, agent **tự mở bản preview** cho bạn xem (browser, hoặc giả lập
nếu bạn nhắc), kèm báo cáo kết quả + gợi ý bước tiếp theo.

**Điểm chạm của bạn chỉ gồm:** gõ prompt · quét QR bằng Zalo khi deploy · trả lời khi được
hỏi (App ID, chọn mẫu, xác nhận deploy). Hết — mọi lệnh/kiểm tra agent tự chạy ngầm.

## Tài liệu

- `SKILL.md` — contract đầy đủ (workflow, guardrails, exit codes) mà agent tuân theo.
- `references/` — troubleshooting, vận hành, deploy, simulator, mock data.
- `config.json` — mọi fact khoá (markers, catalog mẫu, zmp-cli, simulator).

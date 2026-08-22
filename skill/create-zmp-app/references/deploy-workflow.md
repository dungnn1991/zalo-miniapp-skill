# Deploy workflow — login gate + Development/Testing deploy (Phase 2, opt-in)

Reference cho pipeline opt-in `ensure-login → deploy → verify` (SKILL.md mục "Deploy (Phase 2,
opt-in)"). **`config.json` mục `zmpCli` là authoritative** cho mọi fact về zmp-cli — bảng
dưới chỉ chép lại để đọc nhanh; khi lệch nhau thì `config.json` thắng. Plan:
`27-miniapp-deploy-phase2-plan-2026-08-20.md`. Scripts thuộc Subagent C; file này là contract
vận hành cho host agent.

Điều kiện kích hoạt: user yêu cầu deploy **thẳng** ("deploy", "đưa lên development/testing")
**và** run hiện tại đã `verify` pass. Không bao giờ auto-deploy sau verify. Phase 2 chỉ deploy
Development/Testing — không release production, không provisioning.

## 1. Contract zmp-cli đã pin

Observed `zmp-cli 4.0.3`, ngày 2026-08-20 (`zmpCli.observedVersion` / `observedAt`). CLI
obfuscated, không có semver contract cho error code/env key → fact pin theo version; CLI đổi
version thì phải re-verify kiểu P2.0 trước khi tin.

| Fact | Giá trị pin |
|---|---|
| Binary | `zmp` |
| Env file | `<cwd>/.env` — mọi lệnh login/deploy chạy với cwd = `app/`, tức `app/.env` |
| Env keys | `APP_ID` (lab sở hữu), `ZMP_TOKEN` (zmp-cli sở hữu) |
| Login (interactive) | `zmp login` — in QR ra terminal, tự poll login status mỗi `2000ms`, tối đa `60` lần (~2 phút) |
| Login non-interactive | `zmp login --token <token>` — **CẤM tuyệt đối với agent** (token qua argv) |
| Deploy Development | `zmp deploy -p -e -o dist -m "<desc>"` (passive, existing-project, ghi đè bản Development) |
| Deploy Testing | thêm flag `-t` (đánh version) — chỉ khi user nói rõ bản Testing |
| `-o dist` | template pin outDir `dist` (default của CLI là `www` — không được bỏ `-o dist`) |
| API domain | `https://zmp-api.developers.zalo.me/` |
| Deployed URL scheme | `zalo.me/s/<appId>/?env=...&version=...` (`h5.zdn.vn/zapps/` chỉ là CDN asset base) |
| Auth failure message | `Permission denied. Please login again.` |
| Error codes | `-1400` app_config_not_found · `-2001` permission_denied · `-2003` request_timeout |

## 2. Token custody rules

`ZMP_TOKEN` do zmp-cli sở hữu **trọn vòng đời** — CLI tự ghi vào `app/.env` sau login, tự đọc
khi deploy. SKILL/harness/host agent:

- **Được**: key-existence scan (`ZMP_TOKEN` có tồn tại trong `app/.env` hay không) — cách duy
  nhất xác nhận trạng thái login.
- **Cấm**: đọc/parse/echo/log **giá trị** token; ghi/sửa/xóa key `ZMP_TOKEN`; truyền token qua
  argv, prompt, env của lệnh khác; `zmp login --token ...` dưới mọi hình thức.
- Mọi output CLI đi qua strip-ANSI + redact (`lib/redact.mjs` đã có pattern JWT/`ZMP_TOKEN=`)
  trước khi vào evidence. Gate `no_token_in_evidence` + `login_not_scripted` của verify chứng
  minh các rule này chạy thật — không tự miễn.
- `APP_ID` không phải secret; `ZMP_TOKEN` là secret.

## 3. QR relay flow — từng bước cho host agent

```text
ensure-login (exit 2) → spawn `zmp login` → gửi một ảnh QR đã crop → "Login Success!"
→ ensure-login lại (xác nhận key) → deploy
```

1. `node $S/ensure-login.mjs --run-id <id>` — exit `0`: đã có key, sang bước deploy. Exit `2`:
   `login_required`, đọc `needsInput.question` trong `result.json`, báo user và làm tiếp bước 2
   **khi user đồng ý login**.
2. Host agent spawn **`zmp login`** ở chế độ tương tác, cwd = `<workspace>/app/` (script không
   bao giờ tự spawn; `APP_ID` đã được bootstrap bind sẵn trong `app/.env` — QR flow cần nó).
3. Khi QR vừa hiện ổn định, dùng khả năng visual capture của host để chụp cửa sổ terminal,
   crop đủ toàn bộ QR cùng viền trống rồi gửi **một ảnh** cho user. Đây là đường relay ưu tiên
   trên chat/Remote vì giữ nguyên hình học QR và tránh serialize terminal động thành text.
4. **Không stream raw PTY, spinner hoặc các lần ANSI redraw** lên chat/Remote. Chúng có thể
   biến một QR hiện tức thì trên máy thành hàng nghìn dòng lặp và truyền rất chậm. Nếu host
   không chụp được ảnh, strip ANSI rồi gửi đúng một khối QR tĩnh một lần; không relay liên tục.
5. Giữ process login chạy nhưng agent ngừng poll terminal, đợi user báo đã quét rồi mới đọc
   trạng thái một lần. Cửa sổ ~2 phút (CLI tự poll mỗi 2s, tối đa 60 lần); agent không đọc hay
   can thiệp auth response.
6. Thấy `Login Success!` → CLI đã tự ghi `ZMP_TOKEN` vào `app/.env`. Không mở/đọc file để
   "kiểm tra" giá trị.
7. Timeout/QR hết hạn → hỏi user có muốn hiện QR mới không rồi mới chạy lại `zmp login`;
   không tự loop.
8. Chạy lại `ensure-login` để xác nhận — xác nhận **duy nhất** bằng key-existence (exit 0).
   Không bao giờ xác nhận bằng cách đọc giá trị token. Không lưu QR đăng nhập vào repo hoặc
   run evidence lâu dài.

## 4. Deploy + phân loại lỗi

`node $S/deploy.mjs --run-id <id> [--testing] [--desc "<text>"]` — preconditions do script
enforce (verify pass, `appIdBound=true`, `app/dist/index.html` tồn tại, key `ZMP_TOKEN` tồn
tại); agent không được lách. Default Development (ghi đè); `--testing` chỉ khi user nói rõ.

Mô tả phiên bản (`-m "<desc>"`, hiện trong Quản lý phiên bản — đáng chú ý nhất với mode
Testing): user kèm mô tả trong prompt (vd `deploy testing với mô tả "bản demo sprint 3"`) →
truyền `--desc "<text>"`; không kèm → **không hỏi thêm**, `deploy.mjs` tự default
`test <YYYY-MM-DD HH:mm UTC> (<runId>)`.

**Version semantics (quan trọng khi trích dẫn URL):** Testing lưu build lên CDN **gắn
version** — mỗi version là artifact bền, tham chiếu/so sánh được. Development chỉ có **một
slot**: bản deploy sau đè bản trước, không cache nhiều version — URL dev (kể cả kèm
`version=zdev-*`) luôn trỏ bản mới nhất, không phải tham chiếu ổn định. `deployedUrl` trong
evidence của một run development vì vậy chỉ đúng tại thời điểm deploy; cần build ổn định cho
UAT/regression thì deploy Testing.

| Tín hiệu | Phân loại | Hành động |
|---|---|---|
| `-2001` / message chứa `Permission denied. Please login again.` | Token hết hạn/không hợp lệ | Exit `2` `login_required` → quay lại mục 3. **Không retry mù**, không lặp vô hạn |
| `-1400` app_config_not_found | `app-config.json` thiếu/không hợp lệ | Finding stage `deploy` (category `app`/`template` tuỳ nguồn), exit 1 — sửa source rồi chạy lại pipeline |
| `-2003` request_timeout | Mạng/API domain | Finding stage `deploy` category `environment`, exit 1; retry chỉ khi user yêu cầu |
| Exit 0 nhưng không parse được URL `zalo.me/s/` (kể cả sau QR-decode jsqr — CLI 4.0.3 chỉ in URL dạng QR) | Output CLI đổi format | Finding `deploy_output_unparseable` category `dependency` (route cho zmp-cli owner), exit 1 — log vẫn giữ nguyên |
| Lỗi khác | Theo taxonomy finding hiện có | Finding stage `deploy`, exit 1 |

## 5. Evidence

| Artifact | Nội dung |
|---|---|
| `evidence/deploy.log` | Toàn bộ output CLI, strip-ANSI + redacted |
| `evidence/deploy.json` | `{mode: "development"\|"testing", deployedUrl, versionLabel?, deployedAt}` (deploy-evidence.schema.json); `deployedUrl` đúng scheme `zalo.me/s/` (nguồn thường là QR-decode vì CLI chỉ in URL dạng QR); `qrDecodedUrl` phải khớp `deployedUrl` |

Gates verify nối thêm khi run có deploy: `deploy_ok`, `deployed_url_recorded`,
`no_token_in_evidence`, `login_not_scripted` (xem README lab, mục Phase 2 pipeline).

## 6. UAT checkpoint thủ công

Mở `deployedUrl`/QR bằng **Zalo thật** trên điện thoại và xác nhận app render/hoạt động là
checkpoint **thủ công**: browser harness không giả lập được Zalo host nên bước này không bao
giờ thành gate tự động. Human xác nhận xong thì ghi kết quả (ngày, người xác nhận, quan sát)
vào run notes của run tương ứng. Deploy chưa có UAT note = chưa được coi là "đã nghiệm thu",
kể cả khi mọi gate máy đều xanh.

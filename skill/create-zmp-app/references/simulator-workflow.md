# Simulator workflow — chạy thử app + flow quyền không cần Zalo (Phase 3, opt-in)

Reference cho host agent khi dùng provider simulator. Facts biên SDK↔host và contract demo
tab khóa trong `config.json` (`sdkHostContract`, `simulatorDemo`) — file đó là authoritative.
Mock data/error codes: `references/sim-mock-data.json` (curated từ Portal docs, có docSource
từng API). Shim/serve thuộc harness (`scripts/sim/`).

## 1. Simulator làm gì

Chạy app trong browser với **mock tại biên zmp-sdk ↔ host**: shim define
`window.ZaloJavaScriptInterface` trước khi bundle app load, trả lời các native call bằng dữ
liệu từ registry mock. Kết quả: xem app + bấm thử các flow quyền (getUserInfo, getLocation,
getPhoneNumber, getAccessToken...) với bottomsheet consent **giả lập** — không cần điện thoại,
không cần tài khoản Zalo, không đụng dữ liệu thật.

Mọi sheet consent của sim đều mang **badge SIMULATOR** — nghĩa là consent GIẢ, do
`simDecision` hoặc người xem bấm, không phải người dùng thật đồng ý.

## 2. Lệnh

Chạy qua single entry `run.mjs` — flag cụ thể xem SKILL.md mục "Golden workflow" và
"Simulator" (do harness chốt). Hai behavior:

- **Verify sim**: pipeline chạy render với profile `simulator` — headless, full gates hiện có
  + demo checks **theo mode** (`--sim-decision`, default `accept`): `accept` → result marker
  non-empty; `deny` → error marker non-empty; `manual` → sheet thật sự hiện nên mới có gate
  `sim_sheet_badge` + screenshot `sim-sheet-<api>.png` (ở `accept`/`deny`, sheet auto-resolve
  **trước khi hiện** — không có badge gate, by design). Verify đủ flow quyền = chạy cả
  `accept` VÀ `deny`; cần evidence bottomsheet/badge thì chạy thêm `manual`. Evidence như mọi
  run: screenshot (`sim-demo-<decision>.png`), dom, console, thêm `evidence/bridge-log.jsonl`
  (log các native call qua biên).
- **Preview sim**: mở **cửa sổ Chrome thật** (headed) cho user tự bấm thử; `simDecision`
  thường là `manual` để user tự bấm đồng ý/từ chối trên sheet.

## 3. Deviation của preview: cửa sổ Chrome do harness điều khiển

Preview sim **không** mở bằng default browser của máy — nó là cửa sổ Chrome do harness điều
khiển (playwright, `channel: chrome`, `headless: false`). Lý do kỹ thuật, không phải tuỳ tiện:
SDK detect môi trường Mini App (`isMp`) bằng hostname `h5.zdn.vn` + path `/zapps` (xem
`config.json` `sdkHostContract.envDetection`), nên app phải được **serve qua route-interception
tại `https://h5.zdn.vn/zapps/<appId>/`** trong một browser context có UA mobile chứa
`Zalo android/<ver>` — default browser không làm được cả hai điều đó. Mở bằng static server
thường thì SDK coi là web thường (`isMpWeb` trả dummy), mock không chạy.

## 4. `simDecision` modes (từ `__SIM_CONFIG__`, khóa trong `config.json` `simulatorDemo`)

| Mode | Hành vi sheet consent | Dùng cho | Evidence sheet/badge |
|---|---|---|---|
| `accept` (default) | Auto-resolve đồng ý **trước khi sheet hiện** | verify golden path | không (by design) |
| `deny` | Auto-resolve từ chối trước khi sheet hiện | verify deny path (error UI + denyError đúng mã) | không (by design) |
| `manual` | Sheet hiện thật — chờ người xem/runner bấm | preview sim; evidence bottomsheet + badge (`sim_sheet_badge`, `sim-sheet-<api>.png`) | có |

Permission store per-API (`not_determined/granted/denied`, localStorage theo appId) persist
giữa các lần trong cùng browser profile — giống hành vi "ghi nhận cho lần sau" của docs
authorize; GET_SETTING luôn nhất quán với store (SDK pre-check trước API cần user-auth).

## 5. Giới hạn — nói thật với user

- **Mock ≠ native.** Sim chỉ mô phỏng biên SDK↔host bằng dữ liệu giả từ
  `sim-mock-data.json`. Pass sim **không thay được UAT trên Zalo thật**. FAQ cộng đồng nói
  thẳng điều này: *"trình duyệt hoặc simulator chỉ có thể giúp bạn xem giao diện của Mini App,
  chứ không giúp bạn tích hợp được các flow như getAccessToken hoặc createOrder, vì các flow
  này yêu cầu ứng dụng phải được chạy bên trong môi trường thật của Zalo"* —
  [API không có dữ liệu khi dev](https://miniapp.zaloplatforms.com/community/9179321132242792911/api-duoc-goi-thanh-cong-nhung-khong-co-du-lieu-khi-dev)
  (Hồng Phát, crawl 2026-08-21). Sim của lab thêm được flow quyền mock — vẫn không phải môi
  trường thật.
- **Token mock không dùng được thật.** `SIM_TOKEN_*` không decode được qua
  `graph.zalo.me` — decode server-side chỉ hoạt động với token thật (getLocation/
  getPhoneNumber trả token, xem notes trong registry + FAQ 22).
- **API ngoài registry fail rõ.** Shim chỉ mock 7 API trong `sim-mock-data.json`; app gọi API
  khác → lỗi rõ ràng + finding, **không** silent-mock. Muốn thêm API: bổ sung registry với
  docSource Portal, không chế dữ liệu không nguồn.
- Consent trên sheet sim là **consent giả** (badge SIMULATOR) — không có ý nghĩa pháp
  lý/chính sách; quyền thật vẫn phải xin ở Quản lý quyền và được user thật đồng ý
  (`references/operations.md` mục 5).

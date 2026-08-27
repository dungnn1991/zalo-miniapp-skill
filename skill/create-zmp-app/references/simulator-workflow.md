# Simulator workflow — chạy thử app + flow quyền không cần Zalo (Phase 3, opt-in)

Reference cho host agent khi dùng provider simulator. Facts biên SDK↔host và contract demo
tab khóa trong `config.json` (`sdkHostContract`, `simulatorDemo`) — file đó là authoritative.
Mock data/error codes: `references/sim-mock-data.json` (curated từ Portal docs, có docSource
từng API). Shim/serve thuộc harness (`scripts/sim/`).

> **Đọc provider cho đúng (v0.5.1, DX file 53 P3):** `input.json.renderProvider` ghi provider
> MẶC ĐỊNH lúc bootstrap; provider THẬT của run nằm ở `result.json.provider` (+
> `evidence/render-info.json`, `source: "flag"`). Khi chạy `--verify-sim`, hai giá trị này
> cố ý khác nhau — không phải bug.

## 1. Simulator làm gì

Chạy app trong browser với **mock tại biên zmp-sdk ↔ host**: shim define
`window.ZaloJavaScriptInterface` trước khi bundle app load, trả lời các native call bằng dữ
liệu từ registry mock. Kết quả: xem app + bấm thử các flow quyền (getUserInfo, getLocation,
getPhoneNumber, getAccessToken...) với bottomsheet consent **giả lập** — không cần điện thoại,
không cần tài khoản Zalo, không đụng dữ liệu thật.

Mọi sheet consent của sim đều mang **badge SIMULATOR** — nghĩa là consent GIẢ, do
`simDecision` hoặc người xem bấm, không phải người dùng thật đồng ý.

## 1b. Hai thứ khác nhau: sim SERVING và sim DEMO-FLOW

Trước 2026-08-23 hai thứ này bị gộp làm một, nên `render.mjs --provider simulator` **từ chối
thẳng** mọi app scaffold từ official template. Hệ quả: template chính thức không bao giờ chạy
được dưới đúng môi trường của nó, và bốn template Portal bị đánh trượt runtime chỉ vì
zmp-sdk trả `-2000` khi không có Zalo host.

| | Gồm gì | Áp dụng cho |
|---|---|---|
| **sim serving** | host interception tại `h5.zdn.vn/zapps/<appId>`, SDK shim, runtime marker, bridge log | MỌI app |
| **sim demo-flow** | tab "Tài khoản" + marker `api-btn-*`/`api-result-*` của LAB template | chỉ app từ lab template |

Chọn oracle profile theo `input.json` `template.source`:

| Nguồn app | Profile | Marker của lab | Demo-flow |
|---|---|---|---|
| lab | `simulator` | có | có |
| official / existing | `simulator-official` | không | không |

Guard cũ (`finding_30d7006aeaa7` — official template rơi vào `react_mount` fail khó hiểu) vẫn
còn nguyên giá trị: nó nằm ở chính profile `simulator-official`, vốn không đòi marker của lab.

## 1c. Runtime marker `window.__ZMP_DX_RUNTIME__` — contract fail-closed

Simulator **cố ý** serve từ hostname/path thật để zmp-sdk nhận đúng môi trường. Vì vậy
**không được** nhận biết simulator bằng URL, hostname hay user-agent — cả ba đều giống
production. Tín hiệu duy nhất là marker được inject in-memory trước app bundle:

```js
window.__ZMP_DX_RUNTIME__ = {
  schemaVersion: 1,
  mode: 'simulator',
  appId: '<appId>',
  mockData: { phoneNumber: '0000000000' },
};
```

Template/adapter chỉ được đọc contract này; `window.__SIM_CONFIG__` là config nội bộ của shim
và có thể đổi shape bất cứ lúc nào. Luật đọc:

```ts
const isSimulator =
  window.__ZMP_DX_RUNTIME__?.schemaVersion === 1 &&
  window.__ZMP_DX_RUNTIME__?.mode === 'simulator';
```

- `isSimulator === true` → được dùng mock, nhưng UI **phải** gắn nhãn rõ là dữ liệu giả lập.
- Mọi trường hợp khác (thiếu marker, sai `schemaVersion`, sai `mode`) → **không** mock, không
  gọi endpoint server-side từ client; hiển thị trạng thái `backend-required` và giữ đường nhập
  tay. Không cần phân biệt "browser local" với "Zalo thật" — cả hai đều là nhánh
  non-simulator và fail-closed như nhau.

Marker chỉ tồn tại trong bộ nhớ lúc serve: không ghi vào source, `.env`, dist trên đĩa hay bản
deploy. Runner gate cả hai chiều — `sim_runtime_marker` (phải có, dưới sim serving) và
`no_sim_runtime_marker` (phải KHÔNG có, mọi run khác); case
`evaluation/cases/sim-runtime-marker` giữ cả hai chiều đó cùng với việc `index.html` trong
dist không chứa marker.

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
- **Ngoại lệ có chủ đích: native storage (MPDS).** Đây là hạ tầng, không phải API nghiệp vụ,
  nên nó nằm trong shim chứ không nằm trong registry. CONFIRMED zmp-sdk@2.53.0
  (`apis/common/apis/general/storage/index.js`): backend mặc định là localStorage, nhưng khi
  `zaloVersionCode >= ZALO_SUPPORT_STORAGE_VERSION[platform]` **và** `appEnv.isMp` — đúng
  trạng thái dưới shim — SDK đổi sang `NativeResourceStorage` nói giao thức MPDS qua hai
  đường: jsCall `action.zbrowser.mpds` (async) và `ZaloJavaScriptInterface.processActionMPDS`
  (sync, `nativeStorage.handleResult`). Shim hiện thực cả hai trên một store localStorage
  theo appId, đúng năm `mpds_action` của SDK (`get`, `set`, `remove.key`, `clear.appData`,
  `get.size`); `mpds_action` lạ vẫn fail rõ. Thiếu phần này thì `getItem`/`setStorage` trả
  `error_code -1` và mọi template khôi phục trạng thái UI lúc mount đều log console error
  (đo thật 2026-08-23: `zaui-bistro` getItem, `zaui-menu` setStorage).
- Consent trên sheet sim là **consent giả** (badge SIMULATOR) — không có ý nghĩa pháp
  lý/chính sách; quyền thật vẫn phải xin ở Quản lý quyền và được user thật đồng ý
  (`references/operations.md` mục 5).

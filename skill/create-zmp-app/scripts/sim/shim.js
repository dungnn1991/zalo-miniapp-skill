/* shim.js — simulator host mock at the zmp-sdk <-> native boundary (Subagent C, plan 28).
 *
 * Pure browser JS, zero imports. Injected BEFORE the app bundle (runner/preview handle the
 * injection). Reads window.__SIM_CONFIG__ = { appId, decision: accept|deny|manual, persona,
 * apis: <references/sim-mock-data.json .apis>, checkout: {result} }.
 *
 * Facts source: config.json `sdkHostContract` (P3.0 spike, zmp-sdk@2.53.0 public npm):
 *  - injection point window.ZaloJavaScriptInterface, typeof-checked by the SDK per call
 *  - jsCall(...args): LAST arg is the callback — Android STRING
 *    'window.onNativeMessage("<serialId>", "<action>")' (native eval), iOS the function
 *    window.onNativeMessage(serialId, action). Response:
 *    window.onNativeMessage(serialId, action)(JSON.stringify({error_code,error_message,data}))
 *  - SDK pre-checks GET_SETTING (authSetting) before user-auth APIs — the shim answers the
 *    auth-settings openapi endpoint consistently with its permission store.
 * Additionally CONFIRMED from zmp-sdk@2.53.0 sources (apis/common/…, see report):
 *  - getSetting/getUserInfo/getAccessToken run over HTTPS openapi (h5.zalo.me auth-settings,
 *    graph.zalo.me/v2.0/me, h5.zalo.me openapi access_token) — mocked here via a fetch patch
 *    installed before the bundle loads. Every mock is logged; nothing succeeds silently.
 *  - JUMP_LOGIN (jump 'action.jump.login') must return miniProgramConfig.jwt + cookies
 *    named 'h5.zdn.vn_zoauth' / 'h5.zdn.vn_zlink3rd' (constants.js) for the token flow.
 */
(() => {
  'use strict';
  if (window.ZaloJavaScriptInterface) return; // never fight a real host

  const CFG = window.__SIM_CONFIG__ || {};
  const APIS = CFG.apis || {};
  const APP_ID = String(CFG.appId || '');
  const DECISION = CFG.decision === 'deny' || CFG.decision === 'manual' ? CFG.decision : 'accept';
  const CHECKOUT_RESULT = ['success', 'pending', 'fail', 'cancel'].includes(CFG.checkout && CFG.checkout.result)
    ? CFG.checkout.result
    : 'success';
  const PERM_KEY = 'sim-perm-' + APP_ID;

  // Wrapper-equivalent global: ZMPRouter của zmp-ui tính basename `zapps/${window.APP_ID}`
  // trong production build — thiếu là official template (zaui-*) render trắng không lỗi
  // (finding_39d06fc1099a, repro thật từ Codex preview --sim). Lab template không cần nhưng
  // set luôn cho nhất quán với môi trường thật (wrapper zalo-mini-app-index cũng set).
  if (APP_ID && !window.APP_ID) {
    try { window.APP_ID = APP_ID; } catch (e) { /* non-fatal */ }
  }
  // Host hooks version-support (zmp-sdk common/utils.js đọc CHÚNG TRƯỚC khi parse UA):
  // thiếu là isAPISupport(minAndroid,minIOS) tính từ UA — hệ cũ Android lấy version%10000,
  // UA sim cũ '24000000' → code 0 → authorize -1404 CLIENT_NOT_SUPPORT (repro Codex
  // 2026-08-21). zaloVersionCode đặt theo hệ mới (>=24112000); isAPISupport luôn true —
  // API sim không mock vẫn fail RÕ ở shim (by design), không fail giả -1404 ở SDK.
  try {
    if (!window.zaloVersionCode) window.zaloVersionCode = 24112050;
    if (!window.isAPISupport) window.isAPISupport = function () { return true; };
  } catch (e) { /* non-fatal */ }

  // ---- permission store (localStorage, per appId): not_determined | granted | denied ----
  const loadPerms = () => {
    try { return JSON.parse(localStorage.getItem(PERM_KEY)) || {}; } catch (e) { return {}; }
  };
  const savePerm = (key, value) => {
    try {
      const p = loadPerms();
      p[key] = value;
      localStorage.setItem(PERM_KEY, JSON.stringify(p));
    } catch (e) { /* storage unavailable — stays not_determined */ }
  };
  const permKeyOf = (api, entry) => (entry && entry.scope) || api;
  const permState = (api, entry) => loadPerms()[permKeyOf(api, entry)] || 'not_determined';

  const rand8 = () => (Math.random().toString(16) + '00000000').slice(2, 10);
  const simToken = (api) => 'SIM_TOKEN_' + String(api).replace(/[^a-z0-9]/gi, '_').toUpperCase() + '_' + rand8();

  // ---- stable Checkout order store -------------------------------------------------------
  // The merchant boundary is served by intercept.mjs. This browser-side store models only
  // the Checkout host order created afterwards. Reads are idempotent: checkTransaction can be
  // called by both the Mini App and zmp-sdk's own WebviewClosed fallback without consuming or
  // mutating the result.
  const CHECKOUT_STORE_KEY = 'sim-checkout-orders-' + APP_ID;
  const checkoutLoad = () => {
    try { return JSON.parse(localStorage.getItem(CHECKOUT_STORE_KEY)) || {}; } catch (e) { return {}; }
  };
  const checkoutSave = (orders) => {
    try { localStorage.setItem(CHECKOUT_STORE_KEY, JSON.stringify(orders)); } catch (e) { /* memory unavailable */ }
  };
  const checkoutPut = (order) => {
    const orders = checkoutLoad();
    orders[order.orderId] = order;
    checkoutSave(orders);
    return order;
  };
  const checkoutGet = (orderId) => checkoutLoad()[orderId] || null;
  const checkoutHash = (value) => {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
  };
  const resultCodeOf = (result) => ({ success: 1, pending: 0, fail: -1, cancel: -2 })[result] ?? 0;
  const resultLabelOf = (result) => ({
    success: 'Thành công',
    pending: 'Đang xử lý',
    fail: 'Thất bại',
    cancel: 'Đã huỷ',
  })[result] || 'Đang xử lý';

  // ---- MPDS: the native storage backend the SDK picks inside a real Zalo host ------------
  // CONFIRMED zmp-sdk@2.53.0 (apis/common/apis/general/storage/index.js): the default backend
  // is localStorage, but as soon as `zaloVersionCode >= ZALO_SUPPORT_STORAGE_VERSION[platform]`
  // AND appEnv.isMp — both true under this shim — it swaps to NativeResourceStorage, which
  // talks MPDS. Two transports:
  //   async  jsCall action 'action.zbrowser.mpds' (convertSDKActionToJumpAction('ZBROWSER_MPDS'))
  //   sync   ZaloJavaScriptInterface.processActionMPDS(json) -> json  (nativeStorage.handleResult)
  // Without this, getItem/setStorage answer error_code -1 in the simulator and every template
  // that restores UI state on mount logs a fatal console error (zaui-bistro `getItem`,
  // zaui-menu `setStorage` — measured 2026-08-23). Values are opaque strings to us: the SDK
  // has already run stringifyData/stringToData around them.
  const MPDS_KEY = 'sim-mpds-' + APP_ID;
  const mpdsLoad = () => {
    try { return JSON.parse(localStorage.getItem(MPDS_KEY)) || {}; } catch (e) { return {}; }
  };
  const mpdsSave = (map) => {
    try { localStorage.setItem(MPDS_KEY, JSON.stringify(map)); } catch (e) { /* storage off — stays empty */ }
  };
  const mpdsOk = (data) => ({ error_code: 0, error_message: 'Success', data: data });
  // Returns the SDK-shaped response, or null when the mpds_action is not one we model —
  // an unknown action must fail loudly like any other unmocked API, never silently succeed.
  const mpdsHandle = (req) => {
    const action = req && req.mpds_action;
    const data = (req && req.mpds_data) || {};
    const store = mpdsLoad();
    if (action === 'mpds.get') {
      const keys = Array.isArray(data.keys) ? data.keys : (data.keys == null ? Object.keys(store) : [data.keys]);
      const map = {};
      for (const k of keys) if (Object.prototype.hasOwnProperty.call(store, k)) map[k] = store[k];
      return mpdsOk({ mpds_data: { map: map } });
    }
    if (action === 'mpds.set') {
      const incoming = data.map || {};
      for (const k of Object.keys(incoming)) store[k] = incoming[k];
      mpdsSave(store);
      return mpdsOk({ mpds_data: { error_keys: [] } });
    }
    if (action === 'mpds.remove.key') {
      const keys = Array.isArray(data.keys) ? data.keys : (data.keys == null ? [] : [data.keys]);
      for (const k of keys) delete store[k];
      mpdsSave(store);
      return mpdsOk({ mpds_data: { error_keys: [] } });
    }
    if (action === 'mpds.clear.appData') {
      mpdsSave({});
      return mpdsOk({});
    }
    if (action === 'mpds.get.size') {
      let size = 0;
      for (const k of Object.keys(store)) size += 2 * (String(k).length + String(store[k]).length);
      return mpdsOk({ mpds_data: { size: size } });
    }
    return null;
  };

  // ---- bridge log: fire-and-forget POST, must never break the app ----
  const log = (entry) => {
    try {
      fetch('https://h5.zdn.vn/__sim__/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)),
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  };

  // ---- jump-action ↔ sdkApiName map (CONFIRMED zmp-sdk@2.53.0: SDK action literal in
  // apis/common/apis/general/<api>.js, jump = 'action.' + lowercased dot-form — utils/common.js
  // convertSDKActionToJumpAction; serialId = '<SDKACTION>_<random>') ----
  const ACTION_TO_API = {
    'action.get.location': 'getLocation',      // GET_LOCATION
    'action.mp.get.number': 'getPhoneNumber',  // MP_GET_NUMBER
    'action.mp.user.authorize': 'authorize',   // MP_USER_AUTHORIZE
    'action.mp.select.payment.method': 'selectPaymentMethod', // MP_SELECT_PAYMENT_METHOD
    'action.jump.login': '__jumpLogin',        // JUMP_LOGIN — token-flow infra, always mocked
    'action.login': 'login',                   // LOGIN — SDK auto-calls it on module load (isMp)
  };

  // Canonical scope keys the SDK pre-check reads from authSetting (confirmed in
  // zaloNative.js: authSetting["scope.userInfo"]; names match registry authorize.success).
  const SCOPE_OF = {
    getUserInfo: 'scope.userInfo',
    getLocation: 'scope.userLocation',
    getPhoneNumber: 'scope.userPhonenumber',
  };

  // Replace any PLACEHOLDER-marked string in registry success data with a fresh sim token.
  const materialize = (value, api) => {
    if (typeof value === 'string') return value.includes('PLACEHOLDER') ? simToken(api) : value;
    if (Array.isArray(value)) return value.map((v) => materialize(v, api));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = materialize(value[k], api);
      return out;
    }
    return value;
  };
  const denyErrorOf = (entry) => ({
    error_code: (entry && entry.denyError && entry.denyError.error_code) != null ? entry.denyError.error_code : -2002,
    error_message: (entry && entry.denyError && entry.denyError.error_message) || 'User denied',
    data: null,
  });

  // ---- SIMULATOR bottomsheet (manual mode), Zalo-like, with mandatory badge ----
  // Markers LOCKED in config.json simulatorDemo.sheetMarkers. Requests queue sequentially.
  const sheetQueue = [];
  let sheetOpen = false;
  const showSheet = (api, entry, done) => {
    sheetQueue.push({ api, entry, done });
    if (!sheetOpen) nextSheet();
  };
  const nextSheet = () => {
    const job = sheetQueue.shift();
    if (!job) { sheetOpen = false; return; }
    sheetOpen = true;
    const appName = (CFG.persona && CFG.persona.appName) || document.title || 'Mini App';
    const desc = (job.entry && job.entry.permissionDescription)
      || ('Cho phép ứng dụng dùng quyền "' + job.api + '"');
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'sim-sheet');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;font-family:-apple-system,Roboto,sans-serif;';
    wrap.innerHTML =
      '<div style="background:#fff;width:100%;border-radius:16px 16px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -4px 24px rgba(0,0,0,.18);">'
      + '<div data-testid="sim-badge" style="display:inline-block;background:#ffb300;color:#1a1a1a;font-size:11px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:4px;margin-bottom:10px;">SIMULATOR</div>'
      + '<div style="font-size:16px;font-weight:600;margin-bottom:6px;"></div>'
      + '<div style="font-size:14px;color:#4b5563;margin-bottom:18px;"></div>'
      + '<div style="display:flex;gap:12px;">'
      + '<button data-testid="sim-deny" style="flex:1;padding:12px 0;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-size:15px;">Từ chối</button>'
      + '<button data-testid="sim-accept" style="flex:1;padding:12px 0;border:0;border-radius:8px;background:#0068ff;color:#fff;font-size:15px;font-weight:600;">Đồng ý</button>'
      + '</div></div>';
    wrap.children[0].children[1].textContent = appName;
    wrap.children[0].children[2].textContent = desc;
    const close = (ok) => {
      try { wrap.remove(); } catch (e) { /* already gone */ }
      job.done(ok);
      nextSheet();
    };
    wrap.querySelector('[data-testid="sim-accept"]').addEventListener('click', () => close(true));
    wrap.querySelector('[data-testid="sim-deny"]').addEventListener('click', () => close(false));
    (document.body || document.documentElement).appendChild(wrap);
  };

  // ---- SIMULATOR Checkout payment sheet -------------------------------------------------
  // Unlike permission sheets, Checkout always has a visible host surface. Automatic runs
  // keep it briefly on-screen; manual runs let the viewer choose all four canonical results.
  // This is explicitly a simulator UI, never evidence of a real payment or real consent.
  const showCheckoutSheet = (order, done) => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'checkout-sim-sheet');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;font-family:-apple-system,Roboto,sans-serif;';
    wrap.innerHTML =
      '<div style="background:#fff;width:100%;border-radius:18px 18px 0 0;padding:18px 16px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -4px 24px rgba(0,0,0,.2);">'
      + '<div data-testid="checkout-sim-badge" style="display:inline-block;background:#ffb300;color:#1a1a1a;font-size:11px;font-weight:800;letter-spacing:.06em;padding:3px 8px;border-radius:4px;margin-bottom:10px;">SIMULATOR</div>'
      + '<div style="font-size:18px;font-weight:700;margin-bottom:4px;">Thanh toán giả lập</div>'
      + '<div data-testid="checkout-sim-order" style="font-size:13px;color:#667085;margin-bottom:14px;"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;background:#f5f7fb;border-radius:10px;padding:12px;margin-bottom:14px;">'
      + '<span style="font-size:14px;color:#475467;">Tổng thanh toán</span>'
      + '<strong data-testid="checkout-sim-amount" style="font-size:17px;"></strong>'
      + '</div>'
      + '<div data-testid="checkout-sim-result" style="font-size:13px;color:#475467;margin-bottom:12px;"></div>'
      + '<div data-testid="checkout-sim-actions" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"></div>'
      + '</div>';
    wrap.querySelector('[data-testid="checkout-sim-order"]').textContent = 'Mã đơn mock: ' + order.orderId;
    wrap.querySelector('[data-testid="checkout-sim-amount"]').textContent = Number(order.amount || 0).toLocaleString('vi-VN') + ' đ';
    const resultText = wrap.querySelector('[data-testid="checkout-sim-result"]');
    const actions = wrap.querySelector('[data-testid="checkout-sim-actions"]');
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      const latest = checkoutGet(order.orderId) || order;
      checkoutPut(Object.assign({}, latest, {
        result,
        resultCode: resultCodeOf(result),
        transTime: Date.now().toString(),
      }));
      try { wrap.remove(); } catch (e) { /* already gone */ }
      done(result);
    };
    if (DECISION === 'manual') {
      resultText.textContent = 'Chọn kết quả để thử UI của Mini App. Không có tiền thật.';
      const choices = [
        ['success', 'Thành công'],
        ['pending', 'Đang xử lý'],
        ['fail', 'Thất bại'],
        ['cancel', 'Huỷ thanh toán'],
      ];
      choices.forEach(([value, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-testid', 'checkout-sim-' + value);
        button.textContent = label;
        button.style.cssText = value === 'success'
          ? 'padding:11px 8px;border:0;border-radius:8px;background:#0068ff;color:#fff;font-size:14px;font-weight:600;'
          : 'padding:11px 8px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:14px;';
        button.addEventListener('click', () => close(value));
        actions.appendChild(button);
      });
    } else {
      actions.style.display = 'none';
      resultText.textContent = 'Kết quả mô phỏng: ' + resultLabelOf(CHECKOUT_RESULT) + '. Không có tiền thật.';
      // Keep the payment surface observable, then close as a host webview would. The close
      // drives WebviewClosed; zmp-sdk subsequently emits PaymentDone for the client listener.
      setTimeout(() => close(CHECKOUT_RESULT), 300);
    }
    (document.body || document.documentElement).appendChild(wrap);
  };

  const emitWebviewClosed = () => {
    try {
      const handler = window.zaloJSV2 && window.zaloJSV2.zalo_h5_event_handler;
      if (typeof handler === 'function') {
        handler('SIM_CHECKOUT_' + rand8(), 'h5.event.webview.close', JSON.stringify({}));
        log({ action: 'h5.event.webview.close', api: 'checkout', decision: 'mock-host', error_code: 0 });
        return;
      }
    } catch (e) { /* fail loudly below */ }
    log({ action: 'h5.event.webview.close', api: 'checkout', decision: 'unmocked', error_code: -1, unmocked: true });
  };

  // Permission-gated resolution shared by jsCall APIs and openapi mocks.
  // done(decision, payload) — decision ∈ accept|deny|already-granted|already-denied|granted
  const resolvePermissioned = (api, entry, done) => {
    const needsPerm = !entry || entry.requiresPermission !== false;
    const success = () => ({ error_code: 0, error_message: 'Success', data: materialize(entry.success, api) });
    if (!needsPerm) { done('granted', success()); return; }
    const state = permState(api, entry);
    if (state === 'granted') { done('already-granted', success()); return; }
    if (state === 'denied') { done('already-denied', denyErrorOf(entry)); return; }
    if (DECISION === 'accept') { savePerm(permKeyOf(api, entry), 'granted'); done('accept', success()); return; }
    if (DECISION === 'deny') { savePerm(permKeyOf(api, entry), 'denied'); done('deny', denyErrorOf(entry)); return; }
    showSheet(api, entry, (ok) => {
      savePerm(permKeyOf(api, entry), ok ? 'granted' : 'denied');
      done(ok ? 'accept' : 'deny', ok ? success() : denyErrorOf(entry));
    });
  };

  // ---- respond over the pinned transport ----
  const respond = (serialId, action, cb, payload, afterDeliver) => {
    const deliver = () => {
      try {
        const json = JSON.stringify(payload);
        if (typeof cb === 'function') { cb(json); return; }
        const f = window.onNativeMessage && window.onNativeMessage(serialId, action);
        if (typeof f === 'function') f(json);
      } catch (e) { /* SDK not listening — nothing to break */ }
      finally {
        // A host event must be later than the native success callback. This macrotask gives
        // zmp-sdk's resolved Promise time to register WebviewClosed/PaymentDone listeners.
        if (typeof afterDeliver === 'function') setTimeout(afterDeliver, 0);
      }
    };
    setTimeout(deliver, 30); // native is async; SDK registers the serialId before jsCall returns
  };

  // ---- jsCall handler ----
  const handleJsCall = (args) => {
    const cb = args[args.length - 1];
    let serialId = null;
    let action = null;
    if (typeof cb === 'string') {
      const m = cb.match(/onNativeMessage\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
      if (m) { serialId = m[1]; action = m[2]; }
    }
    if (!action) action = args.find((a) => typeof a === 'string' && a.indexOf('action.') === 0) || null;
    let requestData = null; // parsed only for debugging visibility, never logged with payload
    for (const a of args) {
      if (typeof a !== 'string' || a === action || a === cb) continue;
      try { const p = JSON.parse(a); if (p && typeof p === 'object') { requestData = p; break; } } catch (e) { /* not json */ }
    }
    if (requestData) { try { console.debug('[sim] jsCall request data keys:', Object.keys(requestData)); } catch (e) { /* noop */ } }

    const api = ACTION_TO_API[action] || null;

    if (api === '__jumpLogin') {
      // Token-flow infra (always mocked): jwt for getSetting, cookies for the token manager.
      respond(serialId, action, cb, {
        error_code: 0,
        error_message: 'Success',
        data: {
          miniProgramConfig: { jwt: 'SIM_JWT_' + rand8() },
          cookiesOAuthLogins: [
            { name: 'h5.zdn.vn_zoauth', value: 'SIM_ZOAUTH_' + rand8() },
            { name: 'h5.zdn.vn_zlink3rd', value: 'SIM_JSTOKEN_' + rand8() },
          ],
        },
      });
      log({ action, api: 'jumpLogin', decision: 'infra', error_code: 0 });
      return;
    }

    if (action === 'action.zbrowser.mpds') {
      const res = mpdsHandle(requestData);
      if (res) {
        respond(serialId, action, cb, res);
        log({ action, api: 'nativeStorage', decision: 'infra', error_code: 0 });
      } else {
        respond(serialId, action, cb, { error_code: -1, error_message: 'mpds action not supported in simulator', data: null });
        log({ action, api: 'nativeStorage', decision: 'unmocked', error_code: -1, unmocked: true });
      }
      return;
    }

    if (api === 'selectPaymentMethod') {
      const selected = requestData && requestData.selectedMethod;
      const channels = requestData && Array.isArray(requestData.channels) ? requestData.channels : [];
      const picked = (selected && selected.method && selected) || channels[0] || { method: 'COD' };
      const data = {
        method: picked.method || 'COD',
        subMethod: picked.subMethod || undefined,
        isCustom: false,
        displayName: picked.method === 'BANK' ? 'Chuyển khoản (Simulator)' : 'COD (Simulator)',
      };
      respond(serialId, action, cb, { error_code: 0, error_message: 'Success', data });
      log({ action: 'checkout.select-payment-method', api: 'checkout', decision: 'mock-selected', error_code: 0 });
      return;
    }

    if (action === 'action.open.inapp' && requestData && typeof requestData.url === 'string') {
      let checkoutOrder = null;
      try {
        const opened = new URL(requestData.url, window.location.href);
        if (opened.hostname === 'payment-mini.zalo.me') {
          checkoutOrder = checkoutGet(opened.searchParams.get('orderId'));
        }
      } catch (e) { checkoutOrder = null; }
      if (checkoutOrder) {
        respond(
          serialId,
          action,
          cb,
          { error_code: 0, error_message: 'Success', data: {} },
          () => showCheckoutSheet(checkoutOrder, () => emitWebviewClosed()),
        );
        log({ action: 'checkout.open-inapp', api: 'checkout', decision: 'mock-sheet', error_code: 0 });
        return;
      }
    }

    const entry = api ? APIS[api] : null;
    if (!api || !entry) {
      // Outside the registry → explicit failure, never a silent success.
      respond(serialId, action, cb, { error_code: -1, error_message: 'not supported in simulator', data: null });
      log({ action, api, decision: 'unmocked', error_code: -1, unmocked: true });
      return;
    }
    if (api === 'login') {
      // sdkHostContract.autoLoginOnLoad: the SDK calls login() by itself on module load —
      // answer from the registry entry (success {} suffices), never a sheet for this call.
      respond(serialId, action, cb, { error_code: 0, error_message: 'Success', data: materialize(entry.success || {}, api) });
      log({ action, api, decision: 'infra', error_code: 0 });
      return;
    }
    resolvePermissioned(api, entry, (decision, payload) => {
      // authorize grants/denies whole scopes at once — propagate into the store so the
      // per-API permission state and GET_SETTING stay consistent.
      if (api === 'authorize' && payload.error_code === 0 && payload.data) {
        for (const target of Object.keys(SCOPE_OF)) {
          const v = payload.data[SCOPE_OF[target]];
          if (v === true) savePerm(permKeyOf(target, APIS[target]), 'granted');
          else if (v === false) savePerm(permKeyOf(target, APIS[target]), 'denied');
        }
      }
      respond(serialId, action, cb, payload);
      log({ action, api, decision, error_code: payload.error_code });
    });
  };

  window.ZaloJavaScriptInterface = {
    jsCall: function () { try { handleJsCall(Array.prototype.slice.call(arguments)); } catch (e) { /* never break the app */ } },
    jsH5EventCallback: function () { /* native event acks — no-op in simulator */ },
    // SYNCHRONOUS native method, not a jsCall. zmp-ui reads
    // `window.ANDROID_STATUS_BAR_HEIGHT` and, when that is NaN, falls back to
    // `Math.round(ZaloJavaScriptInterface.getStatusBarHeight() / devicePixelRatio)` to set
    // --zaui-safe-area (CONFIRMED zmp-sdk@2.53.0). A real Android host provides both; the shim
    // used to provide neither, so the moment official templates started running under sim
    // serving zaui-coffee died with "K2.getStatusBarHeight is not a function" and rendered
    // blank (measured 2026-08-23). 24dp is the Android status bar height.
    getStatusBarHeight: function () {
      return 24 * (window.devicePixelRatio || 1);
    },
    // checkCameraPermission is deliberately NOT defined: the SDK typeof-guards it and treats
    // its absence as "no camera", which is the honest answer for a simulator.
    // Synchronous MPDS transport (nativeStorage.handleResult): takes a JSON string, returns a
    // JSON string. It THROWS on the SDK side when error_code !== 0, so an unmodelled action
    // still surfaces as a real failure instead of a fake empty read.
    processActionMPDS: function (json) {
      var req = null;
      try { req = JSON.parse(json); } catch (e) { req = null; }
      var res = mpdsHandle(req);
      if (!res) {
        log({ action: 'action.zbrowser.mpds', api: 'nativeStorage', decision: 'unmocked', error_code: -1, unmocked: true });
        return JSON.stringify({ error_code: -1, error_message: 'mpds action not supported in simulator', data: null });
      }
      log({ action: 'action.zbrowser.mpds', api: 'nativeStorage', decision: 'infra', error_code: 0 });
      return JSON.stringify(res);
    },
  };

  // zalo-js-bridge global the SDK pokes during the token flow (jump() calls
  // window.ZJSBridge.setJSToken / setZAccSession — confirmed zmp-sdk@2.53.0 common/token.js).
  // Without a stub that property access THROWS inside the jump success callback and the whole
  // token chain (getAccessToken/getUserInfo) hangs silently.
  if (!window.ZJSBridge) {
    window.ZJSBridge = { setJSToken: function () {}, setZAccSession: function () {} };
  }

  // ---- openapi fetch patch (installed before the bundle): getSetting / getUserInfo /
  // token endpoints run over HTTPS in zmp-sdk 2.53.0 — see header notes ----
  const buildAuthSetting = () => {
    // Base from the registry (getSetting.success.authSetting), then the permission store
    // OVERRIDES per canonical scope key — GET_SETTING must be consistent with the store,
    // and not_determined keys stay absent so the SDK pre-check lets calls reach the shim.
    const base = (APIS.getSetting && APIS.getSetting.success && APIS.getSetting.success.authSetting) || {};
    const out = {};
    for (const k of Object.keys(base)) { if (base[k] === true || base[k] === false) out[k] = base[k]; }
    const perms = loadPerms();
    for (const api of Object.keys(SCOPE_OF)) {
      const state = perms[permKeyOf(api, APIS[api])];
      if (state === 'granted') out[SCOPE_OF[api]] = true;
      else if (state === 'denied') out[SCOPE_OF[api]] = false;
      else delete out[SCOPE_OF[api]];
    }
    return out;
  };
  const jsonResponse = (obj) => Promise.resolve(new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  const decodeCheckoutValue = (value) => {
    if (value == null || value === '') return null;
    let text = String(value);
    try { text = decodeURIComponent(text); } catch (e) { /* already decoded */ }
    try { return JSON.parse(text); } catch (e) { return text; }
  };
  const checkoutBody = (init) => {
    const body = init && init.body;
    if (body instanceof URLSearchParams) return body;
    return new URLSearchParams(typeof body === 'string' ? body : '');
  };
  const checkoutTransactionData = (order) => {
    const result = order.result || 'pending';
    return {
      orderId: order.orderId,
      transId: order.transId,
      resultCode: resultCodeOf(result),
      resultMessage: resultLabelOf(result),
      transTime: order.transTime || '',
      createdAt: order.createdAt,
      method: order.method || 'COD',
      isCustom: false,
    };
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) { url = ''; }
    if (url.indexOf('h5.zdn.vn/__sim__/') >= 0) return origFetch(input, init);

    if (/payment-mini\.zalo\.me\/api\/order\/create-v2(?:\?|$)/.test(url)) {
      const params = checkoutBody(init);
      const amount = Number(params.get('amount'));
      const mac = String(params.get('mac') || '');
      const items = decodeCheckoutValue(params.get('item'));
      const extra = decodeCheckoutValue(params.get('extradata'));
      if (!Number.isSafeInteger(amount) || amount <= 0 || !Array.isArray(items)
        || !mac.startsWith('SIMULATOR_MAC_V1_')) {
        log({ action: 'checkout.create-order', api: 'checkout', decision: 'rejected', error_code: -1400 });
        return jsonResponse({ err: -1400, msg: 'Invalid simulator order input', data: null });
      }
      const merchantOrderId = extra && typeof extra === 'object' ? extra.merchantOrderId : '';
      const orderId = 'SIM-ZMP-' + checkoutHash(merchantOrderId || (mac + ':' + amount));
      const existing = checkoutGet(orderId);
      const createdAt = existing?.createdAt || Date.now().toString();
      const order = existing || checkoutPut({
        orderId,
        merchantOrderId: merchantOrderId || null,
        mac,
        amount,
        method: String(params.get('method') || 'COD'),
        result: 'pending',
        resultCode: 0,
        createdAt,
        transTime: '',
        transId: 'SIM-TRANS-' + checkoutHash(orderId),
      });
      log({ action: 'checkout.create-order', api: 'checkout', decision: existing ? 'idempotent-replay' : 'mock-created', error_code: 0 });
      return jsonResponse({
        err: 0,
        msg: 'Success (Simulator)',
        data: {
          id: order.orderId,
          jwt: 'SIMULATOR_PAYMENT_JWT',
          messageToken: 'SIMULATOR_MESSAGE_TOKEN',
          method: order.method,
          isCustom: false,
        },
      });
    }

    if (/payment-mini\.zalo\.me\/api\/transaction(?:\?|$)/.test(url)) {
      let orderId = '';
      try { orderId = new URL(url).searchParams.get('orderId') || ''; } catch (e) { orderId = ''; }
      const order = checkoutGet(orderId);
      if (!order) {
        log({ action: 'checkout.check-transaction', api: 'checkout', decision: 'not-found', error_code: -12107 });
        return jsonResponse({ err: -12107, msg: 'Transaction not found in simulator', data: null });
      }
      log({
        action: 'checkout.check-transaction',
        api: 'checkout',
        decision: order.result || 'pending',
        error_code: 0,
        result_code: resultCodeOf(order.result || 'pending'),
      });
      return jsonResponse({ err: 0, msg: 'Success (Simulator)', data: checkoutTransactionData(order) });
    }

    if (/h5\.zalo\.me\/apis\/users\/auth-settings/.test(url)) {
      log({ action: 'openapi.auth-settings', api: 'getSetting', decision: 'infra', error_code: 0 });
      // SDK getSetting resolve {authSetting: m.data} — m.data PHẢI là authSetting phẳng,
      // double-nest làm app đọc authSetting["scope..."] = undefined (repro Codex 2026-08-21)
      return jsonResponse({ err: 0, data: buildAuthSetting() });
    }
    if (/graph\.zalo\.me\/v2\.0\/me(\?|$)/.test(url)) {
      const entry = APIS.getUserInfo;
      if (!entry) {
        log({ action: 'openapi.graph.me', api: 'getUserInfo', decision: 'unmocked', error_code: -1, unmocked: true });
        return jsonResponse({ error: -1, message: 'not supported in simulator' });
      }
      return new Promise((resolve) => {
        resolvePermissioned('getUserInfo', entry, (decision, payload) => {
          log({ action: 'openapi.graph.me', api: 'getUserInfo', decision, error_code: payload.error_code });
          if (payload.error_code !== 0) {
            resolve(new Response(JSON.stringify({ error: payload.error_code, message: payload.error_message }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }));
            return;
          }
          // Registry success is SDK-output-shaped ({userInfo:{...}}); the SDK maps the raw
          // graph.zalo.me shape → answer in graph shape here.
          const d = (payload.data && payload.data.userInfo) || payload.data || {};
          resolve(new Response(JSON.stringify({
            error: 0,
            id: d.id || 'SIM_USER_' + rand8(),
            name: d.name || 'Sim User',
            picture: { data: { url: d.avatar || d.picture || '' } },
            is_follower: !!d.followedOA,
            user_id_by_oa: d.idByOA || null,
            is_sensitive: !!d.isSensitive,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });
      });
    }
    // Token endpoints: h5.zalo.me/openapi/access_token (GET_ACCESS_TOKEN) and
    // oauth.zaloapp.com/v3|v4/access_token (GET_ACCESS_TOKEN_V3/V4 — loginZaloV3/V4).
    if (/h5\.zalo\.me\/.*(access.?token|oauth)/i.test(url) || /oauth\.zaloapp\.com\//i.test(url)) {
      log({ action: 'openapi.access-token', api: 'getAccessToken', decision: 'infra', error_code: 0 });
      return jsonResponse({ err: 0, error: 0, access_token: simToken('getAccessToken'), refresh_token: simToken('refresh'), expires_in: 86400 });
    }
    if (/(h5\.zalo\.me|graph\.zalo\.me|payment-mini\.zalo\.me|oauth\.zaloapp\.com)/.test(url)) {
      log({ action: 'openapi.' + url.slice(0, 80), api: null, decision: 'unmocked', error_code: -1, unmocked: true });
      return jsonResponse({ err: -1, error: -1, message: 'not supported in simulator' });
    }
    return origFetch(input, init);
  };

  // getAccessToken shortcut: when the bundle exposes the SDK global, pin a sim token via the
  // public setAccessToken(token) (zod string — apis/setAccessToken.js), skipping the deep
  // jump/login chain. The fetch patch above stays as the safety net for the long path.
  (function pollSdkGlobal(n) {
    const sdk = window.ZaloMiniAppSDK;
    if (sdk && typeof sdk.setAccessToken === 'function') {
      try {
        sdk.setAccessToken(simToken('getAccessToken'));
        log({ action: 'sdk.setAccessToken', api: 'getAccessToken', decision: 'infra', error_code: 0 });
      } catch (e) { /* SDK rejected — long path still mocked */ }
      return;
    }
    if (n < 100) setTimeout(() => pollSdkGlobal(n + 1), 100);
  })(0);
})();

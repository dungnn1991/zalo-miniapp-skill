import { useState } from "react";
import { Button } from "zmp-ui";
import {
  getAccessToken,
  getLocation,
  getPhoneNumber,
  getUserInfo,
} from "zmp-sdk/apis";

// Demo tab for the zmp-sdk API surface (simulatorDemo contract): four buttons,
// each calling one API ON CLICK ONLY — never on mount/render, so the app stays
// error-free in a plain browser where no Zalo host bridge exists.
// getLocation/getPhoneNumber return a TOKEN that must be decoded server-side.

type ApiName = "getUserInfo" | "getLocation" | "getPhoneNumber" | "getAccessToken";

interface ApiResult {
  rows: { label: string; value: string }[];
  note?: string;
}

type CallState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: ApiResult }
  | { status: "error"; message: string };

const TOKEN_NOTE = "token — decode ở server";
const ERROR_MESSAGE =
  "Không lấy được — bạn đã từ chối quyền hoặc môi trường không hỗ trợ.";

const API_BUTTONS: { name: ApiName; label: string }[] = [
  { name: "getUserInfo", label: "Lấy thông tin tài khoản" },
  { name: "getLocation", label: "Lấy vị trí (token)" },
  { name: "getPhoneNumber", label: "Lấy số điện thoại (token)" },
  { name: "getAccessToken", label: "Lấy access token" },
];

const callers: Record<ApiName, () => Promise<ApiResult>> = {
  getUserInfo: async () => {
    const { userInfo } = await getUserInfo();
    return {
      rows: [
        { label: "ID", value: userInfo.id },
        { label: "Tên", value: userInfo.name },
        { label: "Avatar", value: userInfo.avatar },
      ],
    };
  },
  getLocation: async () => {
    const { token } = await getLocation();
    return {
      rows: [{ label: "Token", value: token || "(trống)" }],
      note: TOKEN_NOTE,
    };
  },
  getPhoneNumber: async () => {
    const { token } = await getPhoneNumber();
    return {
      rows: [{ label: "Token", value: token || "(trống)" }],
      note: TOKEN_NOTE,
    };
  },
  getAccessToken: async () => {
    const token = await getAccessToken();
    return { rows: [{ label: "Access token", value: token || "(trống)" }] };
  },
};

const initialCalls: Record<ApiName, CallState> = {
  getUserInfo: { status: "idle" },
  getLocation: { status: "idle" },
  getPhoneNumber: { status: "idle" },
  getAccessToken: { status: "idle" },
};

export default function AccountView() {
  const [calls, setCalls] = useState<Record<ApiName, CallState>>(initialCalls);

  const setCall = (name: ApiName, state: CallState) =>
    setCalls((current) => ({ ...current, [name]: state }));

  const runApi = async (name: ApiName) => {
    setCall(name, { status: "loading" });
    try {
      const result = await callers[name]();
      setCall(name, { status: "success", result });
    } catch {
      setCall(name, { status: "error", message: ERROR_MESSAGE });
    }
  };

  return (
    <section className="account-view">
      <h2 className="account-title">Tài khoản</h2>
      <p className="account-hint">
        Demo API zmp-sdk — kết quả thật chỉ có khi chạy trong Zalo hoặc
        simulator.
      </p>
      <div className="account-api-list">
        {API_BUTTONS.map(({ name, label }) => {
          const state = calls[name];
          return (
            <div key={name} className="account-api">
              <Button
                size="small"
                fullWidth
                variant="secondary"
                data-testid={`api-btn-${name}`}
                disabled={state.status === "loading"}
                onClick={() => void runApi(name)}
              >
                {label}
              </Button>
              {state.status === "success" && (
                <div className="account-result" data-testid={`api-result-${name}`}>
                  {state.result.rows.map((row) => (
                    <p key={row.label} className="account-result-row">
                      <span className="account-result-label">{row.label}</span>
                      <span className="account-result-value">{row.value}</span>
                    </p>
                  ))}
                  {state.result.note && (
                    <p className="account-result-note">{state.result.note}</p>
                  )}
                </div>
              )}
              {state.status === "error" && (
                <p className="account-error" data-testid={`api-error-${name}`}>
                  {state.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

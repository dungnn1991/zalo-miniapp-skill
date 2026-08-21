import "./utils/zmp-sdk-login-guard";
import React from "react";
import { createRoot } from "react-dom/client";
import "zmp-ui/zaui.css";
import "./app.css";
import StoreApp from "./app";

const container = document.getElementById("app");
if (!container) {
  throw new Error("Missing #app root element");
}

createRoot(container).render(
  <React.StrictMode>
    <StoreApp />
  </React.StrictMode>,
);

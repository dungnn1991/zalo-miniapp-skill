// zmp-sdk auto-calls login() as a side effect of loading its module
// (zmp-sdk/apis/index.js). Outside a Zalo/simulator host that call rejects as
// an unhandled promise rejection, which would surface as a page error in a
// plain browser. Swallow ONLY rejections carrying the SDK error shape
// ({ code: number, api: string }); app bugs stay loud. Must be imported
// before anything that pulls in "zmp-sdk/apis" (first import in main.tsx).

window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    typeof (reason as { api?: unknown }).api === "string" &&
    typeof (reason as { code?: unknown }).code === "number"
  ) {
    event.preventDefault();
  }
});

export {};

const elements = {
  form: document.querySelector("#setup-form"),
  syncCode: document.querySelector("#sync-code"),
  interval: document.querySelector("#interval"),
  bridgeUrl: document.querySelector("#bridge-url"),
  statusDot: document.querySelector("#status-dot"),
  statusLabel: document.querySelector("#status-label"),
  statusMessage: document.querySelector("#status-message"),
  lastSync: document.querySelector("#last-sync"),
  formMessage: document.querySelector("#form-message"),
  syncNow: document.querySelector("#sync-now"),
  disconnect: document.querySelector("#disconnect"),
  toggleCode: document.querySelector("#toggle-code"),
  copyCode: document.querySelector("#copy-code"),
  connectButton: document.querySelector("#connect-button")
};

const LABELS = {
  success: "同期済み",
  syncing: "同期中",
  "auth-required": "再ログインが必要",
  "page-required": "履歴画面を開いてください",
  error: "同期エラー",
  "not-configured": "未接続"
};

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `最終同期 ${new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date)}`;
}

function renderStatus(status) {
  const state = status?.state || "not-configured";
  elements.statusDot.dataset.state = state;
  elements.statusLabel.textContent = LABELS[state] || "状態不明";
  elements.statusMessage.textContent = status?.message || "同期コードを設定してください。";
  elements.lastSync.textContent = formatDate(status?.lastSyncedAt);
  elements.syncNow.disabled = state === "syncing" || state === "not-configured";
}

function setBusy(busy) {
  elements.connectButton.disabled = busy;
  elements.syncNow.disabled = busy;
  elements.connectButton.textContent = busy ? "接続中…" : "接続して同期";
}

async function loadState() {
  const state = await sendMessage({ type: "GET_STATE" });
  elements.syncCode.value = state.config.syncCode || "";
  elements.interval.value = String(state.config.intervalMinutes || 30);
  elements.bridgeUrl.value = state.config.bridgeUrl;
  renderStatus(state.syncStatus);
}

elements.toggleCode.addEventListener("click", () => {
  const reveal = elements.syncCode.type === "password";
  elements.syncCode.type = reveal ? "text" : "password";
  elements.toggleCode.textContent = reveal ? "隠す" : "表示";
  elements.toggleCode.setAttribute("aria-label", reveal ? "同期コードを隠す" : "同期コードを表示");
});

elements.copyCode.addEventListener("click", async () => {
  if (!elements.syncCode.value) {
    elements.formMessage.textContent = "先に同期コードを入力または作成してください。";
    return;
  }
  await navigator.clipboard.writeText(elements.syncCode.value);
  elements.formMessage.textContent = "同期コードをコピーしました。";
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.formMessage.textContent = "";
  setBusy(true);
  try {
    const bridge = new URL(elements.bridgeUrl.value);
    const originPattern = `${bridge.origin}/*`;
    const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
    const granted =
      alreadyGranted || (await chrome.permissions.request({ origins: [originPattern] }));
    if (!granted) throw new Error("暗号化同期サーバーへの接続権限が必要です。");
    const response = await sendMessage({
      type: "CONFIGURE",
      config: {
        syncCode: elements.syncCode.value,
        intervalMinutes: Number(elements.interval.value),
        bridgeUrl: elements.bridgeUrl.value
      }
    });
    if (!response?.ok) throw new Error(response?.error || "接続に失敗しました。");
    renderStatus(response.status);
  } catch (error) {
    elements.formMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
});

elements.syncNow.addEventListener("click", async () => {
  elements.formMessage.textContent = "";
  elements.syncNow.disabled = true;
  elements.syncNow.textContent = "同期中…";
  try {
    const response = await sendMessage({ type: "SYNC_NOW" });
    renderStatus(response.status);
  } finally {
    elements.syncNow.textContent = "今すぐ同期";
  }
});

elements.disconnect.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "このPCに保存した同期コードと接続設定を削除します。同期サーバー上の暗号化データは削除されません。"
  );
  if (!confirmed) return;
  await sendMessage({ type: "DISCONNECT" });
  elements.syncCode.value = "";
  await loadState();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.syncStatus?.newValue) {
    renderStatus(changes.syncStatus.newValue);
  }
});

void loadState();

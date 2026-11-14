/**
 * Runs in the SPOTJOBS page's MAIN world. The official page owns its signed-in
 * request, so this collector briefly observes the completed-history response
 * and reuses that in-memory Request as a pagination template. It never reads
 * cookies, Web Storage, password fields, or authorization header values.
 *
 * Keep every helper inside this function: chrome.scripting.executeScript
 * serializes the function without its module scope.
 */
export async function collectSpotJobsFromPage(options) {
  const page = typeof window === "undefined" ? globalThis : window;
  const pageSize = Math.min(Math.max(Number(options?.pageSize) || 50, 10), 100);
  const maxRecords = Math.min(Math.max(Number(options?.maxRecords) || 500, 50), 500);
  const maxPages = Math.ceil(maxRecords / pageSize);
  const captureTimeoutMs = Math.min(
    Math.max(Number(options?.captureTimeoutMs) || 12_000, 500),
    20_000
  );
  const collectedAt = () => new Date().toISOString();
  const originalFetch = page.fetch;

  const extractList = (payload) => {
    const queue = [{ value: payload, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (Array.isArray(current.value)) return current.value;
      if (!current.value || typeof current.value !== "object" || visited.has(current.value)) {
        continue;
      }
      visited.add(current.value);
      for (const key of ["list", "records", "content", "items", "rows"]) {
        if (Array.isArray(current.value[key])) return current.value[key];
      }
      if (current.depth < 3) {
        for (const key of ["data", "result", "payload"]) {
          if (current.value[key] && typeof current.value[key] === "object") {
            queue.push({ value: current.value[key], depth: current.depth + 1 });
          }
        }
      }
    }
    return null;
  };

  const errorResult = (error) => ({
    records: null,
    collectedAt: collectedAt(),
    error: error instanceof Error ? error.message : String(error)
  });

  const historyUrl = (request) => {
    try {
      const url = new URL(request.url);
      const isOfficialApi = url.protocol === "https:" &&
        (url.hostname === "spotapi.jp" || url.hostname.endsWith(".spotapi.jp"));
      return isOfficialApi && request.method === "GET" &&
        url.pathname === "/api/v1/rounder/work" &&
        url.searchParams.get("taskStatus") === "FINISHED"
        ? url
        : null;
    } catch {
      return null;
    }
  };

  const responseError = (response) => {
    if (response.status === 401 || response.status === 403) return "SPOTLOG_AUTH_REQUIRED";
    if (!response.ok) return `SPOTLOG_API_ERROR:${response.status}`;
    return "";
  };

  if (typeof originalFetch !== "function" || !page.document) {
    return errorResult(new Error("SPOTLOG_API_FORMAT_CHANGED"));
  }

  let resolveFirstCapture;
  const firstCapturePromise = new Promise((resolve) => {
    resolveFirstCapture = resolve;
  });
  let captured = false;
  const settleFirstCapture = (value) => {
    if (captured) return;
    captured = true;
    resolveFirstCapture(value);
  };

  const wrappedFetch = async (...args) => {
    let request;
    let matchingUrl = null;
    try {
      request = new Request(args[0], args[1]);
      matchingUrl = historyUrl(request);
    } catch {
      // Let the official client handle malformed requests unchanged.
    }

    let response;
    try {
      response = await originalFetch.apply(page, args);
    } catch (error) {
      if (matchingUrl) settleFirstCapture({ error: "SPOTLOG_API_ERROR:NETWORK" });
      throw error;
    }

    if (matchingUrl && request) {
      const responseFailure = responseError(response);
      if (responseFailure) {
        settleFirstCapture({ error: responseFailure });
      } else {
        void response.clone().json().then(
          (payload) => {
            const records = extractList(payload);
            settleFirstCapture(
              records
                ? { request, url: matchingUrl }
                : { error: "SPOTLOG_API_FORMAT_CHANGED" }
            );
          },
          () => settleFirstCapture({ error: "SPOTLOG_API_FORMAT_CHANGED" })
        );
      }
    }
    return response;
  };

  page.fetch = wrappedFetch;
  try {
    const buttonNamed = (label) => [...page.document.querySelectorAll("button")].find(
      (button) => String(button.textContent || "").replace(/\s+/gu, "") === label
    );
    const unfinishedButton = buttonNamed("未完了");
    if (!buttonNamed("完了")) throw new Error("SPOTLOG_API_FORMAT_CHANGED");

    // Switching away first guarantees a new official request even when the
    // completed tab was already active during a scheduled sync.
    unfinishedButton?.click();
    // React can replace the tab buttons when 未完了 is selected. Yield a task
    // for that render, then query again: clicking a detached cached button does
    // not reach the official app. MessageChannel avoids the prolonged timer
    // throttling of a hidden/background history tab.
    await new Promise((resolve) => {
      const Channel = page.MessageChannel || globalThis.MessageChannel;
      const channel = new Channel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
    const finishedButton = buttonNamed("完了");
    if (!finishedButton) throw new Error("SPOTLOG_API_FORMAT_CHANGED");
    finishedButton.click();

    let captureTimer;
    const captureTimeout = new Promise((resolve) => {
      captureTimer = page.setTimeout(
        () => resolve({ error: "SPOTLOG_API_CAPTURE_TIMEOUT" }),
        captureTimeoutMs
      );
    });
    const firstCapture = await Promise.race([firstCapturePromise, captureTimeout]);
    if (captureTimer !== undefined) {
      const clearTimer = typeof page.clearTimeout === "function"
        ? page.clearTimeout.bind(page)
        : clearTimeout;
      clearTimer(captureTimer);
    }
    if (firstCapture?.error) throw new Error(firstCapture.error);
    if (!firstCapture?.request || !firstCapture?.url) {
      throw new Error("SPOTLOG_API_FORMAT_CHANGED");
    }

    const collected = [];
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const url = new URL(firstCapture.url.toString());
      url.searchParams.set("pageNum", String(pageNum));
      url.searchParams.set("pageSize", String(pageSize));

      // Passing the captured Request as RequestInit preserves the official
      // client's ephemeral request context without inspecting header values.
      const request = new Request(url.toString(), firstCapture.request);
      const response = await originalFetch.call(page, request);
      const responseFailure = responseError(response);
      if (responseFailure) throw new Error(responseFailure);

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("SPOTLOG_API_FORMAT_CHANGED");
      }
      const pageRecords = extractList(payload);
      if (!pageRecords) throw new Error("SPOTLOG_API_FORMAT_CHANGED");

      for (const item of pageRecords) {
        collected.push(item);
        if (collected.length >= maxRecords) break;
      }
      if (collected.length >= maxRecords || pageRecords.length < pageSize) break;
    }

    return { records: collected, collectedAt: collectedAt() };
  } catch (error) {
    return errorResult(error);
  } finally {
    if (page.fetch === wrappedFetch) page.fetch = originalFetch;
  }
}

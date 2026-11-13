/**
 * Runs in the SPOTJOBS page's MAIN world so fetch uses that page's existing
 * signed-in session. This function deliberately never reads cookies,
 * localStorage, sessionStorage, password fields, or authorization headers.
 */
export async function collectSpotJobsFromPage(options) {
  const pageSize = Math.min(Math.max(Number(options?.pageSize) || 50, 10), 100);
  const maxRecords = Math.min(Math.max(Number(options?.maxRecords) || 500, 50), 500);
  const maxPages = Math.ceil(maxRecords / pageSize);
  const workTypes = "BATTERY_INSERT,BATTERY_EJECT,BL_BATTERY_EJECT";
  const collected = [];

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

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const url = new URL("/api/v1/rounder/work", location.origin);
    url.searchParams.set("lat", "0");
    url.searchParams.set("lng", "0");
    url.searchParams.set("pageNum", String(pageNum));
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("taskStatus", "FINISHED");
    url.searchParams.set("workTypes", workTypes);

    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("SPOTLOG_AUTH_REQUIRED");
    }
    if (!response.ok) {
      throw new Error(`SPOTLOG_API_ERROR:${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("SPOTLOG_AUTH_REQUIRED");
    }
    const payload = await response.json();
    const pageRecords = extractList(payload);
    if (!pageRecords) throw new Error("SPOTLOG_API_FORMAT_CHANGED");

    for (const item of pageRecords) {
      collected.push(item);
      if (collected.length >= maxRecords) break;
    }

    if (
      collected.length >= maxRecords ||
      pageRecords.length < pageSize
    ) {
      break;
    }
  }

  return {
    records: collected,
    collectedAt: new Date().toISOString()
  };
}

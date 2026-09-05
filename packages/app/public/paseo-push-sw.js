/* Paseo Web Push worker. Deliberately has no fetch handler or cache. */

function value(data, key) {
  const candidate = data && data[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function workspaceSegment(workspaceId) {
  if (/^[A-Za-z0-9._~-]+$/.test(workspaceId)) return encodeURIComponent(workspaceId);
  const bytes = new TextEncoder().encode(workspaceId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `b64_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function routeFor(data) {
  const serverId = value(data, "serverId");
  const workspaceId = value(data, "workspaceId");
  const agentId = value(data, "agentId");
  const terminalId = value(data, "terminalId");
  if (serverId && workspaceId && (agentId || terminalId)) {
    const target = agentId ? `agent:${agentId}` : `terminal:${terminalId}`;
    return `/h/${encodeURIComponent(serverId)}/workspace/${workspaceSegment(workspaceId)}?open=${encodeURIComponent(target)}`;
  }
  return serverId ? `/h/${encodeURIComponent(serverId)}` : "/";
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A malformed notification must not leave the worker event unhandled.
  }
  const notificationData =
    payload && typeof payload.data === "object" && payload.data ? payload.data : payload;
  const title = value(payload, "title") || "Paseo";
  const body = value(payload, "body") || "An agent needs your attention";
  const tagParts = [
    value(notificationData, "serverId"),
    value(notificationData, "agentId") || value(notificationData, "terminalId"),
    value(notificationData, "reason"),
  ]
    .filter(Boolean)
    .join(":");
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: notificationData,
      tag: tagParts || "paseo",
      renotify: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(routeFor(event.notification.data), self.location.origin).toString();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const current = windows.find(
        (windowClient) => new URL(windowClient.url).origin === self.location.origin,
      );
      if (current) {
        await current.navigate(target);
        return current.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

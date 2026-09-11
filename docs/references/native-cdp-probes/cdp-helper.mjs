export async function resolveCdp(cdpUrl) {
  const response = await fetch(new URL("/json/version", cdpUrl));
  const payload = await response.json();
  return payload.webSocketDebuggerUrl;
}

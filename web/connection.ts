type Options = {
  createSocket: () => WebSocket;
  checkSession: () => Promise<unknown>;
  onSocket: (socket: WebSocket) => void;
  onOpen: () => void;
  onMessage: (event: MessageEvent) => void;
  onDisconnect: () => void;
  onExpired: () => void;
};

// Browser WebSockets have no usable ping API. Probe the authenticated HTTP
// endpoint too, so a sleeping host / blackholed tunnel cannot look connected
// indefinitely. This only reads session status; commands are never replayed.
export function connectWorkspace(options: Options) {
  let stopped = false, socket: WebSocket | undefined, delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let health: ReturnType<typeof setTimeout> | undefined;
  function connect() {
    if (stopped) return;
    let ws: WebSocket;
    try { ws = options.createSocket(); }
    catch { options.onDisconnect(); scheduleRetry(); return; }
    socket = ws; options.onSocket(ws);
    let ended = false;
    const active = () => !stopped && !ended && socket === ws;
    function disconnect() {
      if (!active()) return;
      ended = true; clearTimeout(watchdog); clearTimeout(health);
      options.onDisconnect();
      // Do not wait for a closing handshake with an unreachable machine.
      ws.close();
      void options.checkSession().then(() => { if (!stopped && socket === ws) scheduleRetry(); }).catch(error => {
        if (stopped || socket !== ws) return;
        if (error.status === 401) options.onExpired(); else scheduleRetry();
      });
    }
    function probe() {
      void options.checkSession().then(() => {
        if (active()) health = setTimeout(probe, 15_000);
      }).catch(error => {
        if (!active()) return;
        if (error.status === 401) {
          ended = true; clearTimeout(watchdog); options.onDisconnect(); ws.close(); options.onExpired();
        } else disconnect();
      });
    }
    watchdog = setTimeout(disconnect, 12_000);
    ws.onopen = () => {
      if (!active()) return;
      clearTimeout(watchdog); delay = 1000; options.onOpen();
      health = setTimeout(probe, 15_000);
    };
    ws.onmessage = event => { if (active()) options.onMessage(event); };
    ws.onclose = disconnect;
    ws.onerror = disconnect;
  }
  function scheduleRetry() {
    if (stopped) return;
    retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 15_000);
  }
  connect();
  return () => {
    stopped = true; clearTimeout(retry); clearTimeout(watchdog); clearTimeout(health);
    socket?.close();
  };
}

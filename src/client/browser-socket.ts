import type { SocketFactory } from "./connection.ts";

// The one place the browser's WebSocket is named. Everything else in the client talks to
// SocketLike, which is what lets the reconnection ladder be tested under node:test.

/** Offered alongside the token so anything in between sees a protocol name rather than only a
 * secret. The server selects this one and echoes it back. */
const PROTOCOL = "agentdeck";

export const socketUrl = (href: string): string => {
  const url = new URL(href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // The upgrade handler ignores the path, so any would work. A distinct one lets a proxy route the
  // upgrade separately from the page.
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const browserSocket: SocketFactory = (token, handlers) => {
  // THE TOKEN GOES IN THE SUBPROTOCOL HEADER, NEVER THE URL. A URL lands in proxy logs, browser
  // history and referrer headers, and this token starts processes.
  const socket = new WebSocket(socketUrl(window.location.href), [PROTOCOL, token]);
  socket.addEventListener("open", () => {
    handlers.opened();
  });
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    handlers.message(event.data);
  });
  // `close` fires for a failed handshake too, and a rejected token looks like a phone in a lift.
  // `error` always precedes it, so only `close` is listened for and HTTP tells the two apart.
  socket.addEventListener("close", () => {
    handlers.closed();
  });
  return {
    send: (raw) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(raw);
    },
    close: () => {
      socket.close();
    },
  };
};

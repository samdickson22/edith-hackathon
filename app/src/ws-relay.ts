import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { randomUUID } from "crypto";
import { Unkey } from "@unkey/api";

/** Generate a random 8-char alphanumeric link code */
export function generateLinkCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** Message sent from app to plugin */
export interface RelayMessage {
  type: "message";
  requestId: string;
  text: string;
  imageUrl: string | null;
}

/** Response from plugin to app */
export interface RelayResponse {
  type: "response";
  requestId: string;
  text: string;
  error: string | null;
}

/** Pending request awaiting a response from the plugin */
interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long to wait for a plugin response before timing out (ms) */
const RELAY_TIMEOUT_MS = 120_000;

/**
 * WebSocket relay that bridges Mentra glasses sessions to OpenClaw plugins.
 *
 * Uses noServer mode so it can be attached to any HTTP server via the
 * handleUpgrade hook, without needing direct access to the server at
 * construction time.
 *
 * Lifecycle:
 *   1. Plugin connects to /openclaw-ws
 *   2. Plugin sends {"type":"auth","linkCode":"..."} or uses ?linkCode= query param
 *   3. App validates linkCode and registers the connection
 *   4. When a user speaks, the app sends a message via sendToPlugin()
 *   5. Plugin processes it and sends back a response
 *   6. sendToPlugin() resolves with the response text
 */
export class WebSocketRelay {
  private wss: WebSocketServer;
  /** linkCode -> active plugin WebSocket */
  private connections = new Map<string, WebSocket>();
  /** requestId -> pending request */
  private pending = new Map<string, PendingRequest>();
  /** Set of valid link codes (managed externally) */
  private validLinkCodes = new Set<string>();
  /** Callback when a plugin connects/disconnects for a linkCode */
  private statusListeners = new Map<string, Set<(connected: boolean) => void>>();

  /**
   * If UNKEY_API_ID is set, verify the given API key with Unkey.
   * Returns { valid: true } or { valid: false, error: string }.
   * If UNKEY_API_ID is not set, returns valid (backwards-compatible skip).
   */
  private async verifyApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const unkeyApiId = process.env.UNKEY_API_ID;
    if (!unkeyApiId) {
      console.log("[ws-relay] UNKEY_API_ID not set — skipping API key verification");
      return { valid: true };
    }

    try {
      const unkey = new Unkey({ rootKey: process.env.UNKEY_ROOT_KEY });
      const result = await unkey.keys.verifyKey({ key: apiKey });
      if (!result.data.valid) {
        const reason = result.data.code ?? "invalid_key";
        console.log(`[ws-relay] Unkey rejected key: ${reason}`);
        return { valid: false, error: reason };
      }
      console.log("[ws-relay] Unkey key verified successfully");
      return { valid: true };
    } catch (err: any) {
      console.error("[ws-relay] Unkey verification threw:", err.message);
      return { valid: false, error: "Verification service unavailable" };
    }
  }

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const queryLinkCode = url.searchParams.get("linkCode");
      const queryApiKey = url.searchParams.get("apiKey");

      console.log(`[ws-relay] New WebSocket connection from ${req.socket.remoteAddress} (linkCode query: ${queryLinkCode || "none"}, apiKey: ${queryApiKey ? "present" : "none"})`);

      let authenticated = false;
      let connLinkCode: string | null = null;

      // If linkCode was in the query string, authenticate immediately.
      // Accept any non-empty link code — the code itself is the shared secret.
      // The glasses session may not have started yet (race condition), so we
      // can't validate against validLinkCodes here.
      //
      // If an apiKey query param is also provided and UNKEY_API_ID is set,
      // verify the key with Unkey before completing auth.
      if (queryLinkCode) {
        const finishAuth = () => {
          authenticated = true;
          connLinkCode = queryLinkCode;
          this.validLinkCodes.add(queryLinkCode); // auto-register
          this.registerConnection(queryLinkCode, ws);
          ws.send(JSON.stringify({ type: "auth_ok" }));
          console.log(`[ws-relay] Plugin authenticated via query param: ${queryLinkCode}`);
        };

        if (queryApiKey) {
          // Verify with Unkey (async — fire and handle)
          this.verifyApiKey(queryApiKey).then((result) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!result.valid) {
              ws.send(JSON.stringify({ type: "auth_error", error: `API key invalid: ${result.error}` }));
              ws.close(4001, "Invalid API key");
              return;
            }
            finishAuth();
          });
        } else {
          finishAuth();
        }
      }

      // Auth timeout -- if not authenticated within 10 seconds, disconnect
      const authTimer = authenticated
        ? null
        : setTimeout(() => {
            if (!authenticated) {
              console.log("[ws-relay] Auth timeout -- disconnecting");
              ws.send(JSON.stringify({ type: "auth_error", error: "Auth timeout" }));
              ws.close(4002, "Auth timeout");
            }
          }, 10_000);

      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          console.log("[ws-relay] Received non-JSON message, ignoring");
          return;
        }

        // Handle auth message
        if (msg.type === "auth" && !authenticated) {
          if (authTimer) clearTimeout(authTimer);
          const code = msg.linkCode;

          if (!code) {
            ws.send(JSON.stringify({ type: "auth_error", error: "Missing link code" }));
            ws.close(4001, "Missing link code");
            return;
          }

          authenticated = true;
          connLinkCode = code;
          this.validLinkCodes.add(code); // auto-register
          this.registerConnection(code, ws);
          ws.send(JSON.stringify({ type: "auth_ok" }));
          console.log(`[ws-relay] Plugin authenticated via message: ${code}`);
          return;
        }

        if (!authenticated) {
          ws.send(JSON.stringify({ type: "auth_error", error: "Not authenticated. Send auth message first." }));
          return;
        }

        // Handle response from plugin
        if (msg.type === "response") {
          const pending = this.pending.get(msg.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.requestId);

            if (msg.error) {
              pending.reject(new Error(`OpenClaw plugin error: ${msg.error}`));
            } else if (msg.text) {
              pending.resolve(msg.text);
            } else {
              pending.reject(new Error("OpenClaw plugin returned empty response"));
            }
          } else {
            console.log(`[ws-relay] Received response for unknown requestId: ${msg.requestId}`);
          }
          return;
        }

        console.log(`[ws-relay] Unknown message type: ${msg.type}`);
      });

      ws.on("close", (code, reason) => {
        if (authTimer) clearTimeout(authTimer);
        if (connLinkCode) {
          console.log(`[ws-relay] Plugin disconnected for linkCode ${connLinkCode} (code=${code} reason=${reason})`);
          this.unregisterConnection(connLinkCode, ws);
        }
      });

      ws.on("error", (err) => {
        console.error(`[ws-relay] WebSocket error:`, err.message);
        if (connLinkCode) {
          this.unregisterConnection(connLinkCode, ws);
        }
      });
    });

    this.wss.on("error", (err) => {
      console.error("[ws-relay] WebSocketServer error:", err);
    });

    console.log("[ws-relay] WebSocket relay initialized (noServer mode)");
  }

  /**
   * Handle an HTTP upgrade request. Call this from the HTTP server's
   * 'upgrade' event when the path matches /openclaw-ws.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request);
    });
  }

  /** Check if a request URL matches our WebSocket path */
  static isOpenClawWsPath(url: string | undefined): boolean {
    if (!url) return false;
    const pathname = url.split("?")[0];
    return pathname === "/openclaw-ws";
  }

  /** Register a link code as valid */
  registerLinkCode(linkCode: string): void {
    this.validLinkCodes.add(linkCode);
  }

  /** Check if a plugin is connected for this link code */
  isPluginConnected(linkCode: string): boolean {
    const ws = this.connections.get(linkCode);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  /** Subscribe to connection status changes for a link code */
  onStatusChange(linkCode: string, listener: (connected: boolean) => void): () => void {
    if (!this.statusListeners.has(linkCode)) {
      this.statusListeners.set(linkCode, new Set());
    }
    this.statusListeners.get(linkCode)!.add(listener);
    return () => {
      this.statusListeners.get(linkCode)?.delete(listener);
    };
  }

  /**
   * Send a message to the connected OpenClaw plugin and wait for a response.
   * Returns the response text, or throws if timeout/error.
   */
  sendToPlugin(linkCode: string, text: string, imageUrl: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      const pluginWs = this.connections.get(linkCode);
      if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) {
        return reject(new Error("No OpenClaw plugin connected for this link code"));
      }

      const requestId = randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("OpenClaw plugin response timed out"));
      }, RELAY_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });

      const message: RelayMessage = {
        type: "message",
        requestId,
        text,
        imageUrl,
      };

      try {
        pluginWs.send(JSON.stringify(message));
        console.log(`[ws-relay] Sent message to plugin (linkCode=${linkCode} requestId=${requestId})`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(`Failed to send message to plugin: ${err}`));
      }
    });
  }

  /** Close all connections and the server */
  close(): void {
    // Reject all pending requests
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket relay shutting down"));
    }
    this.pending.clear();

    // Close all plugin connections
    for (const [, ws] of this.connections) {
      ws.close(1001, "Server shutting down");
    }
    this.connections.clear();

    this.wss.close();
    console.log("[ws-relay] WebSocket relay closed");
  }

  private registerConnection(linkCode: string, ws: WebSocket): void {
    // Close any existing connection for this link code
    const existing = this.connections.get(linkCode);
    if (existing && existing !== ws) {
      console.log(`[ws-relay] Replacing existing connection for ${linkCode}`);
      existing.close(4003, "Replaced by new connection");
    }

    this.connections.set(linkCode, ws);
    this.notifyStatusListeners(linkCode, true);
  }

  private unregisterConnection(linkCode: string, ws: WebSocket): void {
    if (this.connections.get(linkCode) === ws) {
      this.connections.delete(linkCode);
      this.notifyStatusListeners(linkCode, false);
    }
  }

  private notifyStatusListeners(linkCode: string, connected: boolean): void {
    const listeners = this.statusListeners.get(linkCode);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(connected);
        } catch (err) {
          console.error("[ws-relay] Status listener error:", err);
        }
      }
    }
  }
}

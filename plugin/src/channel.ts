import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  DEFAULT_ACCOUNT_ID,
  logTypingFailure,
  type ChannelPlugin,
  type OpenClawConfig,
  type PluginRuntime,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { getEdithGlassesRuntime } from "./runtime.js";

const CHANNEL_ID = "edith-glasses";
const DEFAULT_APP_URL = process.env.EDITH_APP_URL || "https://edith-app.ondigitalocean.app";
const meta = {
  id: CHANNEL_ID,
  label: "Edith Glasses",
  selectionLabel: "Edith Smart Glasses",
  blurb: "Connect smart glasses to OpenClaw via WebSocket relay",
  docsPath: "/channels/edith-glasses",
};

// ── Types ──────────────────────────────────────────────────────────────

type EdithGlassesConfig = {
  enabled?: boolean;
  appUrl?: string;
  linkCode?: string;
};

type ResolvedEdithAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: EdithGlassesConfig;
};

type InboundMessage = {
  type: "message";
  requestId: string;
  text: string;
  imageUrl?: string;
};

// ── Active connections (keyed by accountId) ────────────────────────────

const activeConnections = new Map<string, WebSocket>();

// ── Config helpers ─────────────────────────────────────────────────────

function resolveEdithAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedEdithAccount {
  const section = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  const edith = section?.[CHANNEL_ID] as EdithGlassesConfig | undefined;
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    enabled: edith?.enabled ?? false,
    config: edith ?? {},
  };
}

// ── Channel plugin ─────────────────────────────────────────────────────

export const edithGlassesPlugin: ChannelPlugin<ResolvedEdithAccount> = {
  id: CHANNEL_ID,
  meta: { ...meta },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveEdithAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) =>
      Boolean(account.config.appUrl?.trim() && account.config.linkCode?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.config.appUrl?.trim() && account.config.linkCode?.trim()),
    }),
  },

  // ── Setup (used by `openclaw channels add edith-glasses`) ─────────

  setup: {
    validateInput: ({ input }) => {
      if (!input.token) {
        return "Missing --token <linkCode>. Get your link code from the Edith app settings page on your glasses.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const appUrl = input.httpUrl || DEFAULT_APP_URL;
      const linkCode = input.token || "";
      return {
        ...cfg,
        channels: {
          ...(cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined,
          [CHANNEL_ID]: {
            enabled: true,
            appUrl,
            linkCode,
          },
        },
      } as OpenClawConfig;
    },
  },

  // ── Outbound ───────────────────────────────────────────────────────

  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => to,
    sendText: async ({ to, text }) => {
      // Find active WS for this target
      for (const [, ws] of activeConnections) {
        if (ws.readyState === WebSocket.OPEN) {
          // Extract requestId from the "to" field if embedded, otherwise use a generated one
          const requestId = to.split(":").slice(1).join(":") || crypto.randomUUID();
          ws.send(JSON.stringify({ type: "response", requestId, text }));
          return { channel: CHANNEL_ID };
        }
      }
      throw new Error("No active Edith glasses WebSocket connection");
    },
  },

  // ── Gateway ────────────────────────────────────────────────────────

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const { appUrl, linkCode } = account.config;

      if (!appUrl?.trim() || !linkCode?.trim()) {
        ctx.log?.error(
          `[${account.accountId}] Edith glasses: missing appUrl or linkCode in config`,
        );
        return;
      }

      ctx.log?.info(`[${account.accountId}] starting Edith glasses connection`);

      const core = getEdithGlassesRuntime();
      const cfg = ctx.cfg;
      const runtime = ctx.runtime;
      const abortSignal = ctx.abortSignal;
      const accountId = account.accountId;

      let backoffMs = 1000;
      const MAX_BACKOFF_MS = 30_000;

      const connect = () => {
        if (abortSignal.aborted) return;

        const wsUrl = `${appUrl.replace(/^http/, "ws")}/openclaw-ws?linkCode=${encodeURIComponent(linkCode)}`;
        ctx.log?.info(`[${accountId}] connecting to ${wsUrl}`);

        const ws = new WebSocket(wsUrl);
        activeConnections.set(accountId, ws);

        ws.addEventListener("open", () => {
          ctx.log?.info(`[${accountId}] Edith glasses WebSocket connected`);
          backoffMs = 1000; // reset backoff on successful connection
          ctx.setStatus({ accountId, running: true, lastStartAt: new Date().toISOString() });
        });

        ws.addEventListener("message", (event) => {
          handleInboundMessage(event.data as string, {
            core,
            cfg,
            runtime,
            accountId,
            linkCode,
            ws,
            log: ctx.log,
          }).catch((err) => {
            ctx.log?.error(`[${accountId}] Edith glasses message handler error: ${String(err)}`);
          });
        });

        ws.addEventListener("close", () => {
          ctx.log?.info(`[${accountId}] Edith glasses WebSocket closed`);
          activeConnections.delete(accountId);
          ctx.setStatus({ accountId, running: false, lastStopAt: new Date().toISOString() });
          scheduleReconnect();
        });

        ws.addEventListener("error", (err) => {
          ctx.log?.error(`[${accountId}] Edith glasses WebSocket error: ${String(err)}`);
          // close event will follow, which triggers reconnect
        });
      };

      const scheduleReconnect = () => {
        if (abortSignal.aborted) return;
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        ctx.log?.info(`[${accountId}] reconnecting in ${delay}ms`);
        const timer = setTimeout(connect, delay);
        abortSignal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      };

      // Clean up on abort
      abortSignal.addEventListener(
        "abort",
        () => {
          const ws = activeConnections.get(accountId);
          if (ws) {
            ws.close();
            activeConnections.delete(accountId);
          }
        },
        { once: true },
      );

      connect();
    },
  },
};

// ── Inbound message handler ──────────────────────────────────────────

async function handleInboundMessage(
  raw: string,
  deps: {
    core: PluginRuntime;
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    accountId: string;
    linkCode: string;
    ws: WebSocket;
    log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void; debug?: (msg: string, meta?: Record<string, unknown>) => void };
  },
) {
  const { core, cfg, runtime, accountId, linkCode, ws, log } = deps;

  let msg: InboundMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    log?.warn(`[${accountId}] Edith glasses: invalid JSON from WS`);
    return;
  }

  if (msg.type !== "message") return;

  const bodyText = msg.text?.trim() || "";
  if (!bodyText && !msg.imageUrl) return;

  const peerId = `${CHANNEL_ID}:${linkCode}`;

  // Resolve routing
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: "direct", id: peerId },
  });

  // Save image if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (msg.imageUrl) {
    try {
      let buffer: Buffer;
      let contentType: string;

      if (msg.imageUrl.startsWith("data:")) {
        // Decode data URL (data:image/jpeg;base64,...)
        const match = msg.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          contentType = match[1];
          buffer = Buffer.from(match[2], "base64");
        } else {
          throw new Error("Invalid data URL format");
        }
      } else {
        // Fetch from HTTP URL
        const fetched = await core.channel.media.fetchRemoteMedia(msg.imageUrl, {
          maxBytes: 10 * 1024 * 1024,
        });
        if (!fetched) throw new Error("Failed to fetch image");
        buffer = fetched.buffer;
        contentType = fetched.contentType;
      }

      const saved = await core.channel.media.saveMediaBuffer(buffer, { contentType });
      mediaPath = saved.path;
      mediaType = contentType;
    } catch (err) {
      log?.warn(`[${accountId}] Edith glasses: failed to process image: ${String(err)}`);
    }
  }

  // Build inbound context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyText,
    BodyForAgent: bodyText,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: peerId,
    To: peerId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    SenderName: "User",
    SenderId: peerId,
    Provider: CHANNEL_ID as "edith-glasses",
    Surface: CHANNEL_ID as "edith-glasses",
    MessageSid: msg.requestId,
    OriginatingChannel: CHANNEL_ID as "edith-glasses",
    OriginatingTo: peerId,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    CommandAuthorized: true,
    CommandSource: "text" as const,
  });

  // Record session
  const storePath = core.channel.session.resolveStorePath(
    (cfg as any).sessions?.store,
    { agentId: route.agentId },
  );
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: CHANNEL_ID,
      to: peerId,
      accountId: route.accountId,
    },
    onRecordError: (err) => {
      log?.warn(`[${accountId}] failed updating session meta: ${String(err)}`);
    },
  });

  // Create dispatcher that sends replies back over WS
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: route.accountId,
  });

  const typingCallbacks = createTypingCallbacks({
    start: () => {
      // No typing indicator for glasses
    },
    stop: () => {},
    onStartError: (err) => {
      logTypingFailure({
        log: (m) => log?.warn(m),
        channel: CHANNEL_ID,
        action: "start",
        target: peerId,
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (m) => log?.warn(m),
        channel: CHANNEL_ID,
        action: "stop",
        target: peerId,
        error: err,
      });
    },
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        const text =
          typeof payload === "string"
            ? payload
            : (payload as { text?: string }).text ?? String(payload);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, text }));
        }
      },
      onError: (err, info) => {
        log?.error(`[${accountId}] Edith glasses ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks.onReplyStart,
      onIdle: typingCallbacks.onIdle,
    });

  try {
    const result = core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onModelSelected,
      },
    });
    // Handle both sync and async results
    if (result && typeof (result as any).then === "function") {
      await result;
    }
  } catch (err) {
    log?.error(`[${accountId}] dispatchReplyFromConfig error: ${String(err)}`);
    // Send error back to app so it doesn't hang
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, text: "", error: String(err) }));
    }
  }

  markDispatchIdle();
}

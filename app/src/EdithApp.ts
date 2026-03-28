import { AppServer, AppSession } from "@mentra/sdk";
import { WebSocketRelay, generateLinkCode } from "./ws-relay";
import {
  UTTERANCE_TIMEOUT_MS,
  WAKE_WORDS,
  WAKE_TIMEOUT_MS,
  FOLLOWUP_WINDOW_MS,
} from "./config";
import { readFileSync } from "fs";
import { join } from "path";

/** Grace period after TTS finishes to ignore mic echo (ms) */
const TTS_COOLDOWN_MS = 3000;

/** Words that interrupt/stop TTS playback */
const STOP_WORDS = ["stop", "shut up", "cancel", "nevermind", "never mind"];

/** Keywords that suggest the user wants to use the camera */
const VISION_KEYWORDS = [
  "look", "looking at", "see", "seeing", "read", "reading",
  "what is this", "what's this", "what are these", "show me",
  "in front of me", "scan", "photo", "picture", "image",
  "describe", "identify", "recognize",
];

/** Per-session state */
interface SessionState {
  linkCode: string;
  utteranceBuffer: string;
  utteranceTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  speaking: boolean;
  speakingEndedAt: number;
  awake: boolean;
  wakeTimer: ReturnType<typeof setTimeout> | null;
  session: AppSession | null;
  userId: string;
}

const sessions = new Map<string, SessionState>();

/** Load the webview HTML once at startup */
const webviewHtml = readFileSync(join(import.meta.dir, "webview.html"), "utf-8");

function extractAfterWakeWord(text: string): string | null {
  const lower = text.toLowerCase();
  for (const wake of WAKE_WORDS) {
    const idx = lower.indexOf(wake);
    if (idx !== -1) {
      // Strip leading punctuation/whitespace after the wake word
      return text.slice(idx + wake.length).replace(/^[\s.,!?;:]+/, "");
    }
  }
  return null;
}

function isStopCommand(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return STOP_WORDS.some((w) => lower === w || lower.startsWith(w));
}

function isVisionQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return VISION_KEYWORDS.some((kw) => lower.includes(kw));
}

export class EdithApp extends AppServer {
  private wsRelay: WebSocketRelay;

  constructor(config: any) {
    super(config);

    // Initialize WebSocket relay in noServer mode
    this.wsRelay = new WebSocketRelay();

    // Intercept HTTP upgrade events for /openclaw-ws before the Mentra SDK sees them
    const app = this.getExpressApp();
    const originalListen = app.listen.bind(app);
    const relay = this.wsRelay;
    app.listen = (...args: any[]) => {
      const httpServer = originalListen(...args);
      // Prepend our listener so it runs first
      const existingListeners = httpServer.listeners("upgrade").slice();
      httpServer.removeAllListeners("upgrade");
      httpServer.on("upgrade", (request: any, socket: any, head: any) => {
        if (WebSocketRelay.isOpenClawWsPath(request.url)) {
          console.log("[EdithApp] Intercepting upgrade for /openclaw-ws");
          relay.handleUpgrade(request, socket, head);
          return; // Don't let other handlers touch this
        }
        // Re-emit for other handlers (Mentra SDK WebSockets etc.)
        for (const listener of existingListeners) {
          listener.call(httpServer, request, socket, head);
        }
      });
      console.log("[EdithApp] HTTP server upgrade handler attached for /openclaw-ws");
      return httpServer;
    };

    // Serve webview — inject link code if session is available
    const serveWebview = async (req: any, res: any) => {
      res.set("Content-Type", "text/html");
      const session: AppSession | null = req.activeSession || null;
      if (session) {
        const linkCode = await session.simpleStorage.get("openclaw_link_code") || "";
        const wsConnected = linkCode ? this.wsRelay.isPluginConnected(linkCode) : false;
        // Inject config as a global variable so the webview doesn't need API calls
        const injected = webviewHtml.replace(
          "</head>",
          `<script>window.__EDITH_CONFIG__ = ${JSON.stringify({ linkCode, wsConnected })};</script></head>`
        );
        res.send(injected);
      } else {
        res.send(webviewHtml);
      }
    };
    app.get("/", serveWebview);
    app.get("/webview", serveWebview);

    // Settings API — GET (link code + WS status)
    app.get("/api/settings", async (req: any, res: any) => {
      const session: AppSession | null = req.activeSession || null;
      if (!session) {
        return res.status(401).json({ error: "Not authenticated or no active session" });
      }

      const linkCode = await session.simpleStorage.get("openclaw_link_code") || "";
      const wsConnected = linkCode ? this.wsRelay.isPluginConnected(linkCode) : false;

      res.json({ linkCode, wsConnected });
    });

  }

  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    session.logger.info(`Session started for user ${userId}`);

    // Load or generate link code
    let linkCode = await session.simpleStorage.get("openclaw_link_code") || "";
    if (!linkCode) {
      linkCode = generateLinkCode();
      await session.simpleStorage.set("openclaw_link_code", linkCode);
      session.logger.info(`Generated new link code: ${linkCode}`);
    }

    // Register the link code with the WebSocket relay
    this.wsRelay.registerLinkCode(linkCode);
    session.logger.info(`Link code registered: ${linkCode} (WS connected: ${this.wsRelay.isPluginConnected(linkCode)})`);

    const state: SessionState = {
      linkCode,
      utteranceBuffer: "",
      utteranceTimer: null,
      processing: false,
      speaking: false,
      speakingEndedAt: 0,
      awake: false,
      wakeTimer: null,
      session,
      userId,
    };
    sessions.set(sessionId, state);

    // Listen for plugin connect/disconnect and announce on glasses
    this.wsRelay.onStatusChange(linkCode, (connected) => {
      session.logger.info(`OpenClaw plugin ${connected ? "connected" : "disconnected"} via WebSocket`);
      if (connected && !state.speaking) {
        this.speakAndTrack(session, state, 'OpenClaw connected. Say "Hey Edith" to talk to me.').catch(() => {});
      }
    });

    // Register transcription listener
    session.events.onTranscription((data) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (!data.text) return;

      session.logger.info(`[Transcription] ${data.isFinal ? "FINAL" : "interim"}: "${data.text}" | awake=${s.awake} speaking=${s.speaking}`);

      // While TTS is playing, only listen for stop commands
      if (s.speaking) {
        if (data.isFinal && isStopCommand(data.text)) {
          session.logger.info("Stop command — interrupting TTS");
          session.audio.stopAudio();
          s.speaking = false;
          s.speakingEndedAt = Date.now();
        }
        return;
      }

      // Cooldown after TTS
      if (Date.now() - s.speakingEndedAt < TTS_COOLDOWN_MS) return;

      if (!s.awake) {
        if (!data.isFinal) return;

        const afterWake = extractAfterWakeWord(data.text);
        if (afterWake !== null) {
          session.logger.info("Wake word detected!");
          s.awake = true;

          if (afterWake.length > 0) {
            s.utteranceBuffer = afterWake;
            this.processUtterance(session, sessionId);
          } else {
            this.resetIdleTimer(s, WAKE_TIMEOUT_MS);
          }
        }
        return;
      }

      s.utteranceBuffer = data.text;
      this.resetIdleTimer(s, WAKE_TIMEOUT_MS);

      if (s.utteranceTimer) clearTimeout(s.utteranceTimer);

      if (data.isFinal) {
        this.processUtterance(session, sessionId);
      } else {
        s.utteranceTimer = setTimeout(() => {
          this.processUtterance(session, sessionId);
        }, UTTERANCE_TIMEOUT_MS);
      }
    });

    // Listen for side tap to stop audio
    session.events.onTouchEvent((data) => {
      const s = sessions.get(sessionId);
      if (!s || !s.speaking) return;
      session.logger.info(`Touch event: ${data.gesture_name} — stopping TTS`);
      session.audio.stopAudio();
      s.speaking = false;
      s.speakingEndedAt = Date.now();
    });

    // Welcome audio
    const welcomeMsg = this.wsRelay.isPluginConnected(linkCode)
      ? 'Edith connected. Say "Hey Edith" to talk to me.'
      : 'Waiting for OpenClaw connection. Open the app settings to set up your plugin.';
    this.speakAndTrack(session, state, welcomeMsg).catch((err) => {
      session.logger.warn(`Welcome TTS failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private resetIdleTimer(state: SessionState, ms: number): void {
    if (state.wakeTimer) clearTimeout(state.wakeTimer);
    state.wakeTimer = setTimeout(() => {
      state.awake = false;
      state.utteranceBuffer = "";
      state.wakeTimer = null;
    }, ms);
  }

  private async speakAndTrack(session: AppSession, state: SessionState, text: string): Promise<void> {
    state.speaking = true;
    try {
      await session.audio.speak(text);
    } finally {
      state.speaking = false;
      state.speakingEndedAt = Date.now();
    }
  }

  private async processUtterance(
    session: AppSession,
    sessionId: string
  ): Promise<void> {
    const state = sessions.get(sessionId);
    if (!state) return;

    if (state.utteranceTimer) {
      clearTimeout(state.utteranceTimer);
      state.utteranceTimer = null;
    }
    if (state.wakeTimer) {
      clearTimeout(state.wakeTimer);
      state.wakeTimer = null;
    }

    const text = state.utteranceBuffer.trim();
    state.utteranceBuffer = "";

    if (!text) {
      state.awake = false;
      return;
    }

    if (!this.wsRelay.isPluginConnected(state.linkCode)) {
      await this.speakAndTrack(session, state,
        "OpenClaw is not connected. Please install the Edith glasses plugin and check your config."
      );
      state.awake = false;
      return;
    }

    if (state.processing) {
      session.logger.info("Still processing previous request, skipping");
      return;
    }

    state.processing = true;
    session.logger.info(`User said: "${text}"`);

    // Check if this is a vision query — take a photo first
    let imageUrl: string | null = null;
    if (isVisionQuery(text)) {
      session.logger.info("Vision query detected — capturing photo...");
      try {
        const photo = await Promise.race([
          session.camera.requestPhoto({ size: "medium" }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Photo capture timed out")), 5000)
          ),
        ]);
        session.logger.info(`Photo captured: ${photo.size} bytes, ${photo.mimeType}`);
        const base64 = photo.buffer.toString("base64");
        imageUrl = `data:${photo.mimeType};base64,${base64}`;
      } catch (photoErr) {
        session.logger.warn(`Photo capture failed (continuing without image): ${photoErr}`);
        // Continue without image — don't let photo failure crash the session
      }
    }

    try {
      session.logger.info(`Routing via WebSocket relay (linkCode=${state.linkCode})`);
      const response = await this.wsRelay.sendToPlugin(state.linkCode, text, imageUrl);

      session.logger.info(`Edith response: "${response}"`);

      state.utteranceBuffer = "";
      await this.speakAndTrack(session, state, response);

      // Stay awake for follow-up
      state.awake = true;
      session.logger.info(`Follow-up window open (${FOLLOWUP_WINDOW_MS / 1000}s)`);
      this.resetIdleTimer(state, FOLLOWUP_WINDOW_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      session.logger.error(`Backend error: ${msg}`);
      console.error("Full backend error:", err);
      state.utteranceBuffer = "";
      await this.speakAndTrack(session, state,
        "Sorry, I couldn't reach OpenClaw. Please check your plugin connection."
      );
    } finally {
      state.processing = false;
    }
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    const state = sessions.get(sessionId);
    if (state?.utteranceTimer) clearTimeout(state.utteranceTimer);
    if (state?.wakeTimer) clearTimeout(state.wakeTimer);
    sessions.delete(sessionId);
    console.log(`Session ${sessionId} ended: ${reason}`);
  }

  /** Override stop to also close the WebSocket relay */
  async stop(): Promise<void> {
    this.wsRelay.close();
    await super.stop();
  }
}

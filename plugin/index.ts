import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { edithGlassesPlugin } from "./src/channel.js";
import { setEdithGlassesRuntime } from "./src/runtime.js";

const plugin = {
  id: "openclaw-edith-glasses",
  name: "Edith Glasses",
  description: "Edith smart glasses channel plugin — connects to an Edith app via WebSocket",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setEdithGlassesRuntime(api.runtime);
    api.registerChannel({ plugin: edithGlassesPlugin });
  },
};

export default plugin;

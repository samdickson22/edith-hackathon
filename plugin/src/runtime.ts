import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setEdithGlassesRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getEdithGlassesRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Edith glasses runtime not initialized");
  }
  return runtime;
}

import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Mounts the Claude API (api.mjs) inside Vite's own server, for both `vite` and `vite preview`.
function claudeApi(): Plugin {
  let handler: Connect.NextHandleFunction | null = null;
  const mount = async (middlewares: Connect.Server) => {
    handler ??= (await import("./api.mjs")).default as unknown as Connect.NextHandleFunction;
    middlewares.use((req, res, next) => (req.url?.startsWith("/api/") ? handler!(req, res, next) : next()));
  };
  return {
    name: "claude-api",
    configureServer: (server) => mount(server.middlewares),
    configurePreviewServer: (server) => mount(server.middlewares),
  };
}

export default defineConfig(({ mode }) => {
  // Make .env values (PORT, ANTHROPIC_BASE_URL) visible to the API code, without overriding the real environment.
  // API keys are not read from here: each user enters their own in Settings.
  const env = loadEnv(mode, process.cwd(), "");
  for (const key of ["ANTHROPIC_BASE_URL", "PORT"]) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  const port = Number(process.env.PORT) || 3000;

  // public/ holds runtime.html, the sandboxed page that runs the generated animation code.
  return {
    plugins: [react(), claudeApi()],
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true },
  };
});

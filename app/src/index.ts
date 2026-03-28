import { EdithApp } from "./EdithApp";

const PACKAGE_NAME = process.env.PACKAGE_NAME;
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!PACKAGE_NAME) {
  console.error("PACKAGE_NAME environment variable is not set");
  process.exit(1);
}

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is not set");
  process.exit(1);
}

console.log("// Edith\n");
console.log(` Package: ${PACKAGE_NAME}`);
console.log(` Port:    ${PORT}`);
console.log(` Backend: configured per-user via app settings`);
console.log("");

const app = new EdithApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

app.start().catch((err) => {
  console.error("Failed to start Edith:", err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("\nShutting down Edith...");
  await app.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

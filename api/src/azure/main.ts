import { resolve } from "node:path";
import { createEntraAuth, readAzureAuthConfig } from "./auth";
import { createFederatedEntraClient } from "./federation";
import { createAzureState } from "./blob";
import { createAzureActivityServer } from "./server";

const config = readAzureAuthConfig(process.env);
const server = createAzureActivityServer({
  auth: createEntraAuth(config, createFederatedEntraClient(config)),
  origin: config.origin,
  ...createAzureState(process.env),
  staticDirectory: resolve(__dirname, "../../../../../dist"),
});
server.listen(8080, "0.0.0.0", () => console.log("Entra-protected dashboard listening on port 8080."));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000).unref();
  });
}

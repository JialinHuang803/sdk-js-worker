import { createAuth } from "./auth";
import { createGitHubClient } from "./client";
import { createGitHubState } from "./blob";
import { loadGitHubConfig } from "./config";
import { createActivityServer } from "./server";

const config = loadGitHubConfig();
const storage = createGitHubState(createGitHubClient(config.app), config.state);
const server = createActivityServer({
  auth: createAuth(config.auth), sdk: storage.blob("sdk"), emitter: storage.blob("emitter"),
  origin: config.origin, ingestKey: config.ingestKey,
});
server.listen(config.port, "127.0.0.1", () => {
  console.log(`GitHub activity API listening on http://127.0.0.1:${config.port}; local-only, no Azure changes.`);
});

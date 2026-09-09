import { createServer } from "node:http";
import { getDiscordBotStatus, startDiscordBot } from "./bot.js";

const port = Number(process.env.PORT ?? 8080);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT ?? ""}"`);
}

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(getDiscordBotStatus()));
}).listen(port, () => {
  console.log(`Health server listening on port ${port}`);
});

void startDiscordBot();
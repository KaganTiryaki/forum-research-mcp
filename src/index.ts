import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createForumResearchServer } from "./server.js";

const server = createForumResearchServer();
const transport = new StdioServerTransport();

await server.connect(transport);

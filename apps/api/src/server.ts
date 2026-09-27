import "dotenv/config";
import { createKnex } from "./db/knex.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4000);

const db = createKnex();
const app = createApp(db);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${PORT}`);
});

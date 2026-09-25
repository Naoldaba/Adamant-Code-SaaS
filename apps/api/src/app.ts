import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import type { Knex } from "knex";
import { attachDb } from "./middleware/auth.js";
import { toErrorResponse } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { entitiesRouter } from "./routes/entities.js";
import { activityRouter } from "./routes/activity.js";
import { adminUsersRouter } from "./routes/adminUsers.js";
import { settingsRouter } from "./routes/settings.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { exportsRouter } from "./routes/exports.js";
import { assistantRouter } from "./routes/assistant.js";

/**
 * Build the Express app against a given Knex instance. Extracted from server.ts
 * so tests (supertest) can drive the app with a test DB without opening a port.
 */
export function createApp(db: Knex): express.Express {
  const app = express();

  const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(attachDb(db));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/auth", authRouter);
  app.use("/projects", projectsRouter);
  app.use("/entities", entitiesRouter);
  app.use("/activity", activityRouter);
  app.use("/admin/users", adminUsersRouter);
  app.use("/settings", settingsRouter);
  app.use("/knowledge", knowledgeRouter);
  app.use("/exports", exportsRouter);
  app.use("/assistant", assistantRouter);

  // Error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  });

  return app;
}

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// When DASHBOARD_DIST is set (production/Railway), serve the built dashboard
// as static files and fall back to index.html for SPA routing.
const dashboardDist = process.env.DASHBOARD_DIST;
if (dashboardDist && fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.use((_req: Request, res: Response, _next: NextFunction) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);
router.use(chatRouter);

export default router;

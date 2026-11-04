import { database } from "../database";
import { runEngineWorker } from "../engine-worker-core";
import { selfHostedEngineWorkerPolicy } from "./engine-worker-policy";

await runEngineWorker(selfHostedEngineWorkerPolicy(database()));

import { database } from "../database";
import { runPullRequestWorker } from "../pull-request-worker-core";
import { workflowServices } from "../pull-request-workflow-core";
import { selfHostedReviewLifecycle } from "./review-lifecycle";
import { closeApplicationPool } from "@inkspect/core/lib/application-database";

await runPullRequestWorker(workflowServices(selfHostedReviewLifecycle(database())), closeApplicationPool);

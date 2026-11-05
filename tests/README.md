# Runtime regression checks

Use a disposable PostgreSQL database and build this API first. The normal test suite does not start external services.

```sh
SMOKE_TEST_DATABASE_URL=postgresql://... INKSPECT_SMOKE_INDEX=1 INKSPECT_SMOKE_UI=/absolute/path/to/built/ui npm run test:runtime
```

`INKSPECT_SMOKE_UI` is optional; when supplied, build the matching UI first. Keep local API port 3003 free and run editions sequentially. The index scenario starts the real API and worker against a disposable schema. GitHub responses, the engine executable and model response are synthetic; no external credentials or paid calls are used.

It verifies a repository without commits completes with an empty state, makes no engine/model request, and stays retryable; an access failure remains a failure; adding the first commit permits a successful index and description even when GitHub's size metadata still reports zero. Synthetic schemas and processes are cleaned up. This does not replace live provider or browser QA.

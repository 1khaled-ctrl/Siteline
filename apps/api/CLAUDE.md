# apps/api: the FastAPI physics service

Owner: Terrain and light.

- Endpoints: `POST /v1/stay`, `POST /v1/horizon`, `POST /v1/best` and `GET /v1/health`. The Pydantic models mirror `packages/contracts`. The TypeScript types are generated from the OpenAPI schema, never written by hand.
- This service uses the same maths and golden files as `packages/physics`, and the two must agree: identical stay-test results and a horizon RMS within 0.05°.
- Targets: a horizon for a new spot in under 1 s, and a full site report in under 2 s end to end.
- `/v1/health` must answer quickly. A Worker cron job pings it every 5 minutes to keep Cloud Run warm.

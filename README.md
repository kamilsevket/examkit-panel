# ExamKit Panel

Content panel for ExamKit apps — manage and serve exam question banks. Single
Node/Hono service, file-backed (persistent `/data` volume), no native deps.

## Endpoints
- `GET /health`
- Public (apps): `GET /public/exams`, `GET /public/exam/:id`, `GET /public/config/:id`
- Admin (Bearer `ADMIN_TOKEN`): `GET /api/exams`, `PUT /api/exam/:id` (upload pack, validated),
  `PATCH /api/meta/:id` (publish / paywall), `DELETE /api/exam/:id`
- `GET /` admin UI

## Env
- `ADMIN_TOKEN` — required for write/admin endpoints
- `DATA_DIR` — default `/data`
- `PORT` — default `3000`

## Run
```
npm install && ADMIN_TOKEN=secret DATA_DIR=./data npm start
```
Deploy: Dockerfile, expose 3000, mount a volume at `/data`, set `ADMIN_TOKEN`.

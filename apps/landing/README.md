# Landing page

Static site (Vite, vanilla TypeScript, no framework, no runtime requests). Design: [docs/DESIGN.md](../../docs/DESIGN.md) §4.

```sh
pnpm --filter @rocky/landing dev      # http://127.0.0.1:5174
pnpm build:landing                     # dist/; fetches stars and contributors from GitHub once, at build time
```

## Deploy to Vercel

`vercel.json` holds the build settings and the security headers (strict CSP, no third-party anything).

- **Dashboard:** New Project → import `dhrma-tech/Rocky` → Root Directory `apps/landing` → Deploy. Vercel detects pnpm and the workspace; nothing else to set.
- **CLI:** `npx vercel login`, then from the repo root `npx vercel deploy --prod --cwd apps/landing`, and answer the link prompts (root directory `apps/landing`).

Every push to `main` redeploys once the project is linked.

# Contributing to YouTube Monitor Clone

Thanks for helping out! 👀 Bug fixes, new features, docs and design tweaks are all welcome. This guide covers getting set up and what a good pull request looks like.

## Ground rules

- **Be kind.** Assume good intent, keep feedback about the code, and help newcomers.
- **It must stay free to run.** Everything has to fit on Cloudflare's free plan with no paid APIs. A paid-plan feature is fine if it's optional and turned off by default.
- **It must stay simple.** No frontend framework and no build step. Anyone should be able to open `public/app.js` and follow it.
- **Public data only.** Nothing that needs someone's YouTube login, and nothing that gets around YouTube's protections.

## Getting set up

You need Node.js 18+. You don't need a Cloudflare account to work locally.

```bash
git clone https://github.com/<you>/yt-monitor-clone.git
cd yt-monitor-clone
npm install
npm run db:migrate:local
npm run dev            # http://localhost:8787
```

- Add a few channels in the UI, then click **Refresh feed**. It runs the same code the cron runs (`refresh()` in `src/refresh.ts`).
- To look at the local database:
  `npx wrangler d1 execute yt-monitor-clone --local --command "SELECT type, created_at FROM events ORDER BY id DESC LIMIT 10"`
- Before opening a PR:
  ```bash
  npm run check        # typecheck + a dry-run bundle of the worker
  ```

To try your branch on real Cloudflare, `npm run setup` deploys it to your own account.

## Where things live

| Path | What's in it |
| --- | --- |
| `src/index.ts` | HTTP routes (`/api/*`) and the cron entry point |
| `src/refresh.ts` | The engine: which channels/videos are due, diffing feeds, the thumbnail A/B state machine, retention |
| `src/youtube.ts` | Everything that talks to YouTube (RSS parsing, channel pages, thumbnails, optional Data API) |
| `src/env.ts` | Bindings and config helpers |
| `public/` | The whole frontend: `index.html`, `app.js` (a tiny router + render functions), `styles.css` |
| `migrations/` | D1 schema as numbered SQL files |
| `scripts/setup.mjs` | One-command setup/deploy for new users |

## Conventions

- **Match the code around you.** TypeScript in the worker, plain ES modules in the browser, 2-space indent, double quotes. Comments explain *why*, not *what*.
- **Mind the per-run budget.** On the free plan, each cron run gets 50 outbound requests and 50 D1 queries. Read state with a few queries up front, then write everything at once through the `Writes` helper in `refresh.ts`. Don't run a query per video.
- **Schema changes go in a new migration** (`migrations/0002_<what>.sql`). Never edit a migration that has already shipped, because people's databases have already applied it.
- **Escape anything from YouTube** before it goes into HTML (`esc()` in `app.js`). Titles and channel names are untrusted input.
- **New event types** need four things: a name in `EVENT_TYPES` (`src/index.ts`), an entry in `ACTIVITY` (`public/app.js`), a `case` in `renderEvent`, and a line in the README's feed table.
- **New settings** go in `wrangler.jsonc` `vars` with a comment, get a default via `num(env.X, default)`, and get a row in the README's configuration table.

## Pull requests

1. Fork, create a branch (`feat/discord-alerts`, `fix/title-flapping`, …).
2. Keep each PR focused on one thing. Small PRs get merged faster.
3. Run `npm run check`.
4. For UI changes, add a before/after screenshot. Check desktop and phone width (~375px).
5. In the description, say what changed, why, and how you tested it.

If you're planning something big, open an issue first so we can agree on the approach before you put in the work.

## Ideas we'd love help with

Good first issues are labelled on GitHub. Bigger ideas:

- **Title A/B tests:** YouTube can now test titles too. Notice when a title flips back and forth, and show it like a thumbnail test.
- **Performance graphs:** record views/likes over time and draw them on a video's timeline, with swaps and tests marked.
- **Notifications:** an optional Discord/Slack webhook or email digest for new uploads and finished tests.
- **Feed export:** an RSS/Atom feed or CSV of the activity.
- **Optional password:** a simple built-in lock for people who don't want to set up Cloudflare Access.
- **Dark mode** for the cream-and-ink design.
- **Tests:** unit tests for `parseFeed`, `parseChannelInput` and the thumbnail state machine (e.g. with Vitest + `@cloudflare/vitest-pool-workers`).

## Reporting bugs

Open an issue with:

- what you expected and what happened instead
- the channel(s) involved, if it's about tracking
- any errors from the browser console, or from `npx wrangler tail` for the deployed worker

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).

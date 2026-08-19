## What & why

<!-- Briefly: what does this change and why. -->

## How it was verified

<!-- Tests added/updated, manual steps run, screenshots if UI. -->

## Randomness impact (required)

Anything touching sampling, the prefix space, the pool format, or the draw must say so:

- [ ] No effect on the sampling distribution
- [ ] Changes the distribution — `docs/RANDOMNESS.md` updated with the new bias/measurement
- [ ] Changes the prefix space or Feistel key — migration noted (this invalidates the
      without-replacement counter)

## Docs updated (required)

- [ ] `README.md` — if setup, commands, or features changed
- [ ] `docs/DESIGN.md` — if architecture or method changed
- [ ] `docs/RANDOMNESS.md` — if any bias, frame, or measurement changed
- [ ] `docs/OPERATIONS.md` — if workflows, harvesting, or the runbook changed
- [ ] N/A — this change touches no documented behavior

## Checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass locally
- [ ] No secrets committed (the API key lives in `.env.local` / Actions secrets)
- [ ] Branch will be deleted on merge

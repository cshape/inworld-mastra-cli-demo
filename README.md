# inworld-mastra-cli-demo

Minimum-viable CLI demo of [`@mastra/voice-inworld-realtime`](https://github.com/cshape/mastra/tree/feat/voice-inworld-realtime/voice/inworld-realtime-api) wired into a Mastra `Agent`. Full-duplex from the terminal: mic in, speakers out, semantic-VAD turn-taking, barge-in, tool calling — all in one ~70-line `src/main.ts`.

## Prereqs

- Node 22+
- `pnpm` (or npm — `pnpm` recommended; lockfile is pnpm's)
- `sox` (provides both `sox` and `play`): `brew install sox` on macOS
- An Inworld API key — get one at <https://platform.inworld.ai>

## Quickstart

```bash
cp .env.example .env   # then paste your INWORLD_API_KEY
pnpm install
pnpm run dev
```

You should see `Connected. Use headphones for best experience.` Then talk into the mic.

## What to try

- Just talk — the assistant replies in one or two sentences (semantic VAD ends your turn when you stop speaking).
- Ask **"what time is it?"** to exercise tool calling. You'll see `[tool] get-current-time` print, then hear the time read back.
- Start talking while the assistant is speaking — playback cuts within ~100ms (barge-in).
- `Ctrl+C` for a clean exit.

Headphones strongly recommended: without them, speaker audio bleeds into the mic and confuses VAD.

## How the package dependency resolves

`@mastra/voice-inworld-realtime` isn't on npm yet, so this repo ships a packed tarball (`mastra-voice-inworld-realtime-0.0.1.tgz`) and `package.json` points at it via a `file:` link. Once the package is published, swap that line in `package.json` for a normal version range.

To refresh the tarball from a local mastra checkout:

```bash
cd /path/to/mastra/voice/inworld-realtime-api
pnpm pack --pack-destination /path/to/inworld-mastra-cli-demo
cd /path/to/inworld-mastra-cli-demo
rm -rf node_modules/.pnpm/@mastra+voice-inworld-realtime*
pnpm install
```

## File map

- `src/main.ts` — the entire demo: Agent + voice + mic/speaker plumbing
- `package.json` — runtime deps: `@mastra/core` (from npm), `@mastra/voice-inworld-realtime` (local tarball), `dotenv`, `zod`
- `mastra-voice-inworld-realtime-0.0.1.tgz` — packed voice-package build
- `tsconfig.json` — strict ESM/NodeNext
- `.env.example` — copy to `.env` and fill in `INWORLD_API_KEY`

For background on the voice package itself, see [its README on GitHub](https://github.com/cshape/mastra/blob/feat/voice-inworld-realtime/voice/inworld-realtime-api/README.md).

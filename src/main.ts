import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { InworldRealtimeVoice } from '@mastra/voice-inworld';
import { z } from 'zod';

const getCurrentTime = createTool({
  id: 'get-current-time',
  description: 'Returns the current local time.',
  inputSchema: z.object({}),
  outputSchema: z.object({ time: z.string() }),
  execute: async () => ({ time: new Date().toLocaleTimeString() }),
});

const voice = new InworldRealtimeVoice({
  // Defaults: model 'inworld/models/gemma-4-26b-a4b-it', speaker 'Sarah',
  // STT 'inworld/inworld-stt-1', semantic-VAD turn detection.
  // Override any of these here (e.g. model: 'openai/gpt-5.4-nano', speaker: 'Jason').
  session: {
    audio: {
      input: {
        // 'low' makes semantic VAD wait for clearer end-of-turn pauses before
        // the bot responds — it was jumping in too quickly on 'medium'. This
        // also gives back-channels a clean window to play during your speech
        // without a competing main-response player fighting for the audio device.
        turn_detection: { type: 'semantic_vad', eagerness: 'low' },
      },
    },
  },
  providerData: {
    // Back-channels ("uh-huh", "I see") are short interjections the agent
    // emits WHILE you're still speaking. They're meant to overlap your speech,
    // so they are deliberately NOT cancelled by barge-in (see the `backchannel`
    // handler below). Gated by server prerequisites — ask your Inworld account team.
    //
    // Tuned aggressive for testing — fire early and often. Dial these back
    // toward the defaults (min_speech_ms 800, min_gap_ms 4000, max_per_turn 3,
    // eval_interval_ms 800) for production naturalness.
    backchannel: {
      enabled: true,
      min_speech_ms: 400, // start interjecting sooner after you begin speaking (default 800)
      min_gap_ms: 1200, // allow them closer together (default 4000)
      max_per_turn: 6, // more interjections per user turn (default 3)
      eval_interval_ms: 400, // evaluate eligibility more often (default 800)
    },
  },
});

new Agent({
  id: 'voice-demo',
  name: 'Voice Demo',
  instructions: 'You are a concise voice assistant. Reply in one or two short sentences. Use the get-current-time tool when asked the time.',
  model: 'n/a',
  tools: { getCurrentTime },
  // Cast: voice packages bundle their own copy of MastraVoice's base class
  // (extracted into the private @internal/voice package), whose ECMAScript
  // private brand differs from the @mastra/core copy the Agent's type expects.
  // The two are interchangeable at runtime; only the structural type check
  // trips on the private brand. This affects every current voice package.
  voice: voice as unknown as Agent['voice'],
});

const SOX = ['-t', 'raw', '-r', '24000', '-e', 'signed', '-b', '16', '-c', '1', '-q', '-'];
// Main assistant-response players, keyed by response_id. These ARE stopped on
// barge-in (`interrupted`) so the agent shuts up the instant you speak.
const players = new Map<string, ChildProcess>();
// Back-channel players, keyed by backchannel_id. Kept in a SEPARATE map that
// barge-in never touches, so interjections keep playing over your speech.
const bcPlayers = new Map<string, ChildProcess>();

voice.on('speaker', stream => {
  // Any new response supersedes the prior one — kill leftover players so
  // a missed barge-in can't leave two streams playing at once.
  for (const p of players.values()) p.kill('SIGTERM');
  players.clear();
  const id = (stream as unknown as { id: string }).id;
  const player = spawn('play', SOX, { stdio: ['pipe', 'ignore', 'ignore'] });
  players.set(id, player);
  // Swallow EPIPE when `play` exits (natural end, or kill on barge-in) while
  // the PassThrough is still flushing a few buffered audio frames.
  player.stdin!.on('error', () => {});
  stream.pipe(player.stdin!);
  player.on('exit', () => players.delete(id));
});

// Barge-in: stop ONLY the main response audio. `interrupted` carries a
// response_id that matches a `speaker` stream, never a back-channel — so
// back-channel players are untouched and keep playing over your speech.
voice.on('interrupted', ({ response_id }) => players.get(response_id)?.kill('SIGTERM'));

// Back-channel audio arrives on its own `backchannel` event (separate from
// `speaker`). Play it on the separate `bcPlayers` track; the stream ends
// itself on `backchannel.done`, so the player exits naturally. We never kill
// these on barge-in — that's the whole point of a back-channel.
voice.on('backchannel', stream => {
  const id = (stream as unknown as { id: string }).id;
  let bytes = 0;
  stream.on('data', (c: Buffer) => (bytes += c.length));
  const player = spawn('play', SOX, { stdio: ['pipe', 'ignore', 'ignore'] });
  bcPlayers.set(id, player);
  player.stdin!.on('error', () => {});
  stream.pipe(player.stdin!);
  // Diagnostics: signal !== null means something killed the player (it
  // shouldn't — back-channels are barge-in-exempt); bytes === 0 means no audio
  // ever arrived (server sent `done`/`skipped` without deltas).
  player.on('exit', (code, signal) => {
    bcPlayers.delete(id);
    console.log(`\n[backchannel ${id}] player exit code=${code} signal=${signal} bytes=${bytes}`);
  });
  console.log(`\n[backchannel ${id}] start`);
});
voice.on('backchannel.done', ({ backchannel_id, phrase }) =>
  console.log(`\n[backchannel ${backchannel_id}] done${phrase ? ` "${phrase}"` : ''}`),
);
voice.on('backchannel.skipped', ({ reason }) => console.log(`\n[backchannel skipped] ${reason}`));

let lastRole: 'user' | 'assistant' | null = null;
voice.on('writing', ({ text, role }) => {
  if (role !== lastRole) {
    process.stdout.write(role === 'user' ? '\n[you] ' : '\n[bot] ');
    lastRole = role;
  }
  process.stdout.write(text);
});

voice.on('tool-call-start', ({ toolName }) => console.log(`\n[tool] ${toolName}`));
voice.on('error', err => console.error('\n[error]', err));

await voice.connect();
console.log('Connected. Use headphones for best experience. Speak when ready. Ctrl+C to exit.');

const mic = spawn('sox', ['-d', ...SOX], { stdio: ['ignore', 'pipe', 'ignore'] });
await voice.send(mic.stdout);

process.on('SIGINT', () => {
  mic.kill('SIGTERM');
  for (const p of players.values()) p.kill('SIGTERM');
  for (const p of bcPlayers.values()) p.kill('SIGTERM');
  voice.close();
  process.exit(0);
});

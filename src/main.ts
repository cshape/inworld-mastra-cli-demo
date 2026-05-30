import 'dotenv/config';
import { spawn } from 'node:child_process';
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

// ONE persistent output process for the whole session. Spawning a fresh `play`
// per clip pays ~100-300ms of audio-device-open latency — longer than a short
// back-channel ("mhm"), so those clips finished before the device was ready and
// you'd only hear a blip. Keeping a single `play` open holds the device warm, so
// every clip — main response AND back-channel — is audible. Both write into this
// one stdin (we never close it, so it stays open across clips).
const out = spawn('play', SOX, { stdio: ['pipe', 'ignore', 'ignore'] });
out.stdin!.on('error', () => {}); // swallow EPIPE if `play` exits

// Main-response streams, keyed by response_id, so barge-in can stop just those.
const mainStreams = new Map<string, NodeJS.ReadableStream>();

voice.on('speaker', stream => {
  const id = (stream as unknown as { id: string }).id;
  mainStreams.set(id, stream);
  stream.pipe(out.stdin!, { end: false }); // { end: false } keeps the shared stdin open
  stream.on('end', () => mainStreams.delete(id));
});

// Barge-in: stop feeding the interrupted response's audio into the shared
// output. The SDK already sent `response.cancel` to stop the server; here we
// just unpipe + drain so the main voice goes quiet fast WITHOUT killing the
// process — back-channels share this output and must keep playing.
voice.on('interrupted', ({ response_id }) => {
  const stream = mainStreams.get(response_id);
  if (stream) {
    stream.unpipe(out.stdin!);
    stream.resume(); // discard any late/buffered audio for this response
    mainStreams.delete(response_id);
  }
});

// Back-channels write into the SAME shared output and are NEVER stopped on
// barge-in — that's the whole point of a back-channel (it overlaps your speech).
voice.on('backchannel', stream => {
  stream.pipe(out.stdin!, { end: false });
});
voice.on('backchannel.done', ({ phrase }) => phrase && process.stdout.write(`\n[backchannel] ${phrase}`));
voice.on('backchannel.skipped', () => {});

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
  out.kill('SIGTERM');
  voice.close();
  process.exit(0);
});

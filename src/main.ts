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
//
// `--buffer 1024`: sox processes audio in fixed-size blocks. At the default
// (~8 KB ≈ 170ms) the sub-block TAIL of each clip sits unplayed until the next
// clip's bytes fill the block — so the end of a response got clipped and replayed
// at the start of the next one. A small block (~1 KB ≈ 20ms) flushes the tail
// promptly; 20ms of latency is imperceptible.
const out = spawn('play', ['--buffer', '1024', ...SOX], { stdio: ['pipe', 'ignore', 'ignore'] });
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

// Single label-tracking printer so transcripts and back-channel lines never
// run together. A new label (you / bot / backchannel) starts a fresh line;
// same-label text appends. `endLine()` resets the label so the next write —
// even same role — starts a new line.
let lastLabel: string | null = null;
function print(label: string, text: string) {
  if (label !== lastLabel) {
    process.stdout.write(`\n[${label}] `);
    lastLabel = label;
  }
  process.stdout.write(text);
}
function endLine() {
  lastLabel = null;
}

// "Is the user speaking?" gate for back-channels. A back-channel is decided
// from your last partial transcript, so one can be synthesized just after you
// stop and land in the post-turn silence. We only play back-channels while
// you're speaking: mark speaking on the start signals (VAD speech-started, or
// barge-in) and stopped on the end signals (VAD speech-stopped, or your
// finalized transcript — the transcript is the reliable backstop because
// semantic-VAD edges don't always fire).
let speaking = false;
voice.on('speech-started', () => {
  speaking = true;
});
voice.on('interrupted', () => {
  speaking = true;
});
voice.on('speech-stopped', () => {
  speaking = false;
});

// Back-channels share the single output and are never stopped once playing.
// Track which actually played so only those print a line.
const playingBc = new Set<string>();
voice.on('backchannel', stream => {
  const id = (stream as unknown as { id: string }).id;
  if (!speaking) {
    stream.resume(); // arrived after you stopped — discard so it doesn't play late
    return;
  }
  playingBc.add(id);
  stream.pipe(out.stdin!, { end: false });
});
voice.on('backchannel.done', ({ backchannel_id, phrase }) => {
  if (playingBc.delete(backchannel_id) && phrase) {
    print('backchannel', phrase);
    endLine();
  }
});
voice.on('backchannel.skipped', () => {});

voice.on('writing', ({ text, role }) => {
  if (text === '\n') {
    if (role === 'user') speaking = false; // finalized transcript = your turn ended
    endLine(); // turn finished — next line gets a fresh label
    return;
  }
  print(role === 'user' ? 'you' : 'bot', text);
});

voice.on('tool-call-start', ({ toolName }) => {
  print('tool', toolName);
  endLine();
});
voice.on('error', err => {
  endLine();
  console.error('\n[error]', err);
});

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

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../store/paths';
import { probeDuration } from '../video/ffmpeg';
import { voice as lookupVoice } from '@/lib/catalog';
import { FRAME_HEIGHT, FRAME_WIDTH } from './types';
import type { ImageProvider, ImageRequest, VoiceProvider, VoiceRequest } from './types';

/**
 * OpenAI images and speech.
 *
 * Called over plain `fetch` rather than the SDK: two endpoints are needed and
 * both return binary, which is the one case where the SDK saves nothing and
 * costs a dependency.
 */

const API = 'https://api.openai.com/v1';

async function failure(response: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = await response.text().catch(() => '');
  }
  const suffix = detail ? ` — ${detail.slice(0, 300)}` : '';
  return new Error(`${what} failed (HTTP ${response.status})${suffix}`);
}

export class OpenAIVoiceProvider implements VoiceProvider {
  readonly name = 'openai';

  constructor(private readonly apiKey: string) {}

  async speak(request: VoiceRequest): Promise<number> {
    await ensureDir(path.dirname(request.outFile));

    const response = await fetch(`${API}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL?.trim() || 'tts-1-hd',
        voice: lookupVoice(request.voiceId)?.openai ?? 'alloy',
        input: request.text,
        response_format: 'mp3',
      }),
    });

    if (!response.ok) throw await failure(response, 'Text to speech');

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new Error('Text to speech returned an empty file');
    await fs.writeFile(request.outFile, audio);

    // Measured, not estimated: every downstream timing decision keys off the
    // real length of this file.
    return probeDuration(request.outFile);
  }
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = 'openai';

  constructor(private readonly apiKey: string) {}

  async draw(request: ImageRequest): Promise<void> {
    await ensureDir(path.dirname(request.outFile));

    const response = await fetch(`${API}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1',
        // The closest portrait size the model offers; the renderer scales and
        // crops to the exact frame anyway.
        size: '1024x1536',
        n: 1,
        prompt: [
          request.prompt,
          request.style,
          // Repeated here as well as in the script brief: the script model and
          // the image model are different models, and only this one is holding
          // the pencil.
          'Vertical composition. No text, letters, numbers, captions, logos or watermarks anywhere in the image.',
        ].join('. '),
      }),
    });

    if (!response.ok) throw await failure(response, 'Image generation');

    const body = (await response.json()) as {
      data?: { b64_json?: string; url?: string }[];
    };
    const first = body.data?.[0];
    if (!first) throw new Error('Image generation returned no image');

    if (first.b64_json) {
      await fs.writeFile(request.outFile, Buffer.from(first.b64_json, 'base64'));
      return;
    }

    if (first.url) {
      const image = await fetch(first.url);
      if (!image.ok) throw new Error(`Could not download the generated image (HTTP ${image.status})`);
      await fs.writeFile(request.outFile, Buffer.from(await image.arrayBuffer()));
      return;
    }

    throw new Error('Image generation returned neither image data nor a URL');
  }
}

export { FRAME_WIDTH, FRAME_HEIGHT };

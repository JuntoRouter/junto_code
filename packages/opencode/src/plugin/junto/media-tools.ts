import { z } from "zod"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs/promises"

const JUNTO_API_BASE = "https://us-central1-ms-junto.cloudfunctions.net/juntoRouter/api/v1"

async function getApiKey(ctx: ToolContext): Promise<string | undefined> {
  // Read the auth file to get the junto API key
  const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || "", ".local/share")
  const authFile = path.join(xdgData, "opencode", "auth.json")
  try {
    const data = JSON.parse(await fs.readFile(authFile, "utf-8"))
    if (data.junto?.type === "api" && data.junto?.key) return data.junto.key
  } catch {}
  return undefined
}

async function mediaFetch(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${JUNTO_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

async function saveBase64(dir: string, filename: string, base64: string): Promise<string> {
  const filepath = path.join(dir, filename)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await fs.writeFile(filepath, Buffer.from(base64, "base64"))
  return filepath
}

// ── Image Generation ──

export const junto_generate_image = tool({
  description:
    "Generate an image using Junto Router's image generation API. " +
    "Supports models like openai/gpt-image-1, openai/dall-e-3, google/gemini-2.0-flash. " +
    "The generated image is saved to the workspace directory.",
  args: {
    prompt: z.string().describe("Description of the image to generate"),
    model: z
      .string()
      .optional()
      .default("openai/gpt-image-1")
      .describe("Model to use (e.g. openai/gpt-image-1, openai/dall-e-3, google/gemini-2.0-flash)"),
    size: z
      .string()
      .optional()
      .default("1024x1024")
      .describe("Image size (e.g. 1024x1024, 1792x1024, 1024x1792)"),
    filename: z
      .string()
      .optional()
      .describe("Output filename (default: generated-image-{timestamp}.png)"),
  },
  async execute(args, ctx) {
    const apiKey = await getApiKey(ctx)
    if (!apiKey) return "Error: Not connected to Junto Router. Please login first via the Junto Dashboard."

    await ctx.ask({
      permission: "media",
      patterns: [`generate image: ${args.prompt.slice(0, 80)}`],
      always: ["junto_generate_image"],
      metadata: { model: args.model, prompt: args.prompt },
    })

    ctx.metadata({ title: `Generating image: ${args.prompt.slice(0, 50)}...` })

    const res = await mediaFetch("/images/generations", apiKey, {
      model: args.model,
      prompt: args.prompt,
      size: args.size,
      n: 1,
    })

    if (!res.ok) {
      const err = await res.text().catch(() => "")
      return `Error generating image: ${res.status} ${err}`
    }

    const data = (await res.json()) as {
      data: Array<{ b64_json?: string; url?: string; content_type: string }>
      cost: number
      model: string
    }

    const item = data.data[0]
    if (!item) return "Error: No image data returned"

    const filename = args.filename || `generated-image-${Date.now()}.png`
    let filepath: string

    if (item.b64_json) {
      filepath = await saveBase64(ctx.directory, filename, item.b64_json)
    } else if (item.url) {
      // Download from URL
      const imgRes = await fetch(item.url)
      const buf = Buffer.from(await imgRes.arrayBuffer())
      filepath = path.join(ctx.directory, filename)
      await fs.mkdir(path.dirname(filepath), { recursive: true })
      await fs.writeFile(filepath, buf)
    } else {
      return "Error: No image data in response"
    }

    const relPath = path.relative(ctx.worktree, filepath)
    return `Image generated and saved to ${relPath} (model: ${data.model}, cost: $${data.cost.toFixed(4)})`
  },
})

// ── Audio Generation (TTS) ──

export const junto_generate_audio = tool({
  description:
    "Generate speech audio from text using Junto Router's TTS API. " +
    "Supports models like openai/tts-1, google/gemini-2.0-flash. " +
    "The generated audio is saved to the workspace directory.",
  args: {
    input: z.string().describe("Text to convert to speech"),
    model: z
      .string()
      .optional()
      .default("openai/tts-1")
      .describe("Model to use (e.g. openai/tts-1, google/gemini-2.0-flash)"),
    voice: z
      .string()
      .optional()
      .default("alloy")
      .describe("Voice ID (OpenAI: alloy, echo, fable, onyx, nova, shimmer)"),
    filename: z
      .string()
      .optional()
      .describe("Output filename (default: generated-audio-{timestamp}.mp3)"),
  },
  async execute(args, ctx) {
    const apiKey = await getApiKey(ctx)
    if (!apiKey) return "Error: Not connected to Junto Router. Please login first via the Junto Dashboard."

    await ctx.ask({
      permission: "media",
      patterns: [`generate audio: ${args.input.slice(0, 80)}`],
      always: ["junto_generate_audio"],
      metadata: { model: args.model, input: args.input.slice(0, 100) },
    })

    ctx.metadata({ title: `Generating audio: ${args.input.slice(0, 50)}...` })

    const res = await mediaFetch("/audio/speech", apiKey, {
      model: args.model,
      input: args.input,
      voice: args.voice,
      response_format: "mp3",
    })

    if (!res.ok) {
      const err = await res.text().catch(() => "")
      return `Error generating audio: ${res.status} ${err}`
    }

    const filename = args.filename || `generated-audio-${Date.now()}.mp3`
    const filepath = path.join(ctx.directory, filename)
    await fs.mkdir(path.dirname(filepath), { recursive: true })

    const contentType = res.headers.get("content-type") || ""

    if (contentType.startsWith("audio/")) {
      // Binary audio response
      const buf = Buffer.from(await res.arrayBuffer())
      await fs.writeFile(filepath, buf)
      const relPath = path.relative(ctx.worktree, filepath)
      return `Audio generated and saved to ${relPath} (model: ${args.model})`
    }

    // JSON response with b64_json
    const data = (await res.json()) as {
      data: Array<{ b64_json: string; content_type: string }>
      cost: number
      model: string
    }

    const item = data.data[0]
    if (!item?.b64_json) return "Error: No audio data returned"

    await saveBase64(ctx.directory, filename, item.b64_json)
    const relPath = path.relative(ctx.worktree, filepath)
    return `Audio generated and saved to ${relPath} (model: ${data.model}, cost: $${data.cost.toFixed(4)})`
  },
})

// ── Video Generation ──

export const junto_generate_video = tool({
  description:
    "Generate a video using Junto Router's video generation API. " +
    "Supports models like google/gemini-2.0-flash. " +
    "Video generation may take 1-5 minutes. The generated video is saved to the workspace directory.",
  args: {
    prompt: z.string().describe("Description of the video to generate"),
    model: z
      .string()
      .optional()
      .default("google/gemini-2.0-flash")
      .describe("Model to use (e.g. google/gemini-2.0-flash)"),
    duration: z
      .number()
      .optional()
      .default(6)
      .describe("Duration in seconds (default: 6)"),
    filename: z
      .string()
      .optional()
      .describe("Output filename (default: generated-video-{timestamp}.mp4)"),
  },
  async execute(args, ctx) {
    const apiKey = await getApiKey(ctx)
    if (!apiKey) return "Error: Not connected to Junto Router. Please login first via the Junto Dashboard."

    await ctx.ask({
      permission: "media",
      patterns: [`generate video: ${args.prompt.slice(0, 80)}`],
      always: ["junto_generate_video"],
      metadata: { model: args.model, prompt: args.prompt, duration: args.duration },
    })

    ctx.metadata({ title: `Generating video: ${args.prompt.slice(0, 50)}... (may take a few minutes)` })

    const res = await mediaFetch("/video/generations", apiKey, {
      model: args.model,
      prompt: args.prompt,
      duration: args.duration,
    })

    if (!res.ok) {
      const err = await res.text().catch(() => "")
      return `Error generating video: ${res.status} ${err}`
    }

    const data = (await res.json()) as {
      data: Array<{ url: string; content_type: string }>
      cost: number
      model: string
    }

    const item = data.data[0]
    if (!item?.url) return "Error: No video data returned"

    const filename = args.filename || `generated-video-${Date.now()}.mp4`
    const filepath = path.join(ctx.directory, filename)
    await fs.mkdir(path.dirname(filepath), { recursive: true })

    // Download the video
    const videoRes = await fetch(item.url)
    const buf = Buffer.from(await videoRes.arrayBuffer())
    await fs.writeFile(filepath, buf)

    const relPath = path.relative(ctx.worktree, filepath)
    return `Video generated and saved to ${relPath} (model: ${data.model}, duration: ${args.duration}s, cost: $${data.cost.toFixed(4)})`
  },
})

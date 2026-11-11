/**
 * Minimal Gemini client: one generate() call with tool calling, a timeout, pacing for
 * free-tier rate limits, and fallback across models when one is overloaded.
 * The agents depend only on the Generate type, so tests can pass a scripted fake.
 */

export interface ToolDecl { name: string; description: string; parameters: Record<string, unknown> }

export interface Part {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [key: string]: unknown; // e.g. thought signatures, which must be sent back unchanged
}

export interface Content { role: 'user' | 'model'; parts: Part[] }
export interface LlmRequest { system: string; contents: Content[]; tools?: ToolDecl[]; temperature?: number }
export type Generate = (req: LlmRequest) => Promise<Content>;

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function geminiGenerate(
  apiKey = process.env.GEMINI_API_KEY,
  models = (process.env.GEMINI_MODELS ?? 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest').split(',').map((m) => m.trim()),
  minGapMs = Number(process.env.GEMINI_MIN_GAP_MS ?? 1200),
): Generate {
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;

  const callOnce = async (model: string, req: LlmRequest): Promise<Content> => {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey!, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.contents,
        tools: req.tools?.length ? [{ functionDeclarations: req.tools }] : undefined,
        generationConfig: { temperature: req.temperature ?? 0.6 },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const err = new Error(`${model}: ${res.status} ${json?.error?.message ?? ''}`.slice(0, 300)) as Error & { fatal?: boolean };
      err.fatal = [400, 401, 403].includes(res.status); // bad request or bad key: retrying will not help
      throw err;
    }
    const parts = json?.candidates?.[0]?.content?.parts as Part[] | undefined;
    if (!parts?.length) throw new Error(`${model}: empty response (${json?.candidates?.[0]?.finishReason ?? 'no candidate'})`);
    return { role: 'model', parts };
  };

  const generate = async (req: LlmRequest): Promise<Content> => {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    let last: Error = new Error('no model tried');
    for (let pass = 0; pass < 2; pass++) {
      for (const model of models) {
        const wait = lastCall + minGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        try {
          return await callOnce(model, req);
        } catch (e) {
          last = e as Error;
          if ((e as { fatal?: boolean }).fatal) throw e;
        }
      }
      await sleep(4000);
    }
    throw last;
  };

  // Serialise calls so two agents never burst past the per-minute limit together.
  return (req) => {
    const run = queue.then(() => generate(req));
    queue = run.catch(() => undefined);
    return run;
  };
}

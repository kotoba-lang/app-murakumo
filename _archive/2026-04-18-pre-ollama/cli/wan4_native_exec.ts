import { Tokenizer } from "npm:@huggingface/tokenizers";

type NativeGPUCapability = {
  available: boolean;
  adapter: string;
  features: string[];
  'maxStorageBufferBindingSize': number;
  'maxComputeWorkgroupStorageSize': number;
};

type NativeWorkerCapability = {
  'wasmSimd': boolean;
  'wasmThreads': boolean;
  gpu: NativeGPUCapability;
  'memClass': string;
  'netClass': string;
  'powerClass': string;
  gpuTier?: string;
  runtimeClass?: string;
  acceleratorClass?: string;
};

type NativeTaskInfo = {
  'taskId': string;
  'taskType': string;
  artifactKeys?: string[];
  shaderHash?: string;
  params: string;
  packageRef?: string;
  inputBlobRefs?: string[];
  checkpointBlobRef?: string;
  resultBlobRef?: string;
  runtimeClass?: string;
  acceleratorClass?: string;
};

type NativeLeaseInfo = {
  'leaseId': string;
  taskId?: string;
  workerId?: string;
  issuedAt?: string;
  expiresAt?: string;
  renewDeadline?: string;
  checkpointIntervalSec?: number;
  verificationMode?: string;
};

type NativeExecRequest = {
  'workerId': string;
  'sessionId': string;
  'userAgent': string;
  capability: NativeWorkerCapability;
  lease: NativeLeaseInfo;
  task: NativeTaskInfo;
  params: Record<string, unknown>;
};

type NativeCheckpointResult = {
  checkpointKey?: string;
  checkpointBlobRef?: string;
  checkpointSize?: number;
  checkpointDigest?: string;
  iteration?: number;
  stateMetadata?: string;
};

type NativeExecResult = {
  output?: string;
  resultKey?: string;
  resultBlobRef?: string;
  resultSize?: number;
  resultDigest?: string;
  totalGpuTimeMs?: number;
  totalUnits?: number;
  warmShaders?: string[];
  warmArtifacts?: string[];
  checkpoint?: NativeCheckpointResult;
};

type NativeLoadProgress = {
  'shardId': string;
  loaded: number;
  total: number;
  cached: boolean;
  phase: "download" | "parse" | "ready";
};

type NativeSegmentShardResult = {
  'shardId': string;
  'gpuTimeMs': number;
  checksum: number;
  'throughputGflops': number;
};

const stderrEncoder = new TextEncoder();

function writeStderr(...args: unknown[]): void {
  const line = args
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
  Deno.stderr.writeSync(stderrEncoder.encode(`${line}\n`));
}

console.log = (...args: unknown[]) => writeStderr(...args);
console.warn = (...args: unknown[]) => writeStderr(...args);
console.error = (...args: unknown[]) => writeStderr(...args);

const componentRoot = new URL(
  "../wasm/etzhayyim-wasm-murakumo-m9r4k8m0/",
  import.meta.url,
);

const runtimeModule = await import(
  new URL("./svelte/src/lib/runtime/murakumo-runtime.ts", componentRoot).href
);
const loaderModule = await import(
  new URL("./svelte/src/lib/gpu/wan4-loader.ts", componentRoot).href
);
const inferenceModule = await import(
  new URL("./svelte/src/lib/gpu/wan4-inference.ts", componentRoot).href
);

const { setMurakumoRuntime } = runtimeModule;
const { WAN4Loader, dequantizeTensorRows } = loaderModule;
const { WAN4InferenceEngine } = inferenceModule;

interface MurakumoBinaryCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  close?(): Promise<void>;
}

setMurakumoRuntime({
  openBinaryCache(
    name: string,
    version: number,
    store: string,
  ): Promise<MurakumoBinaryCache> {
    return Promise.resolve(
      new NativeFileBinaryCache(resolveCacheDir(), name, version, store),
    );
  },
  getUserAgent(): string {
    return `murakumo-deno-native/${Deno.version.deno}`;
  },
});

class NativeFileBinaryCache implements MurakumoBinaryCache {
  private readonly baseDir: string;

  constructor(rootDir: string, name: string, version: number, store: string) {
    this.baseDir = `${rootDir}/${sanitizeSegment(name)}/${version}/${
      sanitizeSegment(store)
    }`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.pathForKey(key));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return null;
      }
      throw err;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await Deno.mkdir(this.baseDir, { recursive: true });
    await Deno.writeFile(this.pathForKey(key), data);
  }

  private pathForKey(key: string): string {
    return `${this.baseDir}/${sanitizeSegment(key)}.bin`;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function resolveCacheDir(): string {
  const envDir = Deno.env.get("Etzhayyim_NATIVE_WAN4_CACHE_DIR");
  if (envDir && envDir.trim() !== "") {
    return envDir.replace(/\/$/, "");
  }
  const home = Deno.env.get("HOME");
  if (home && home.trim() !== "") {
    return `${home}/.cache/etzhayyim/murakumo/wan4`;
  }
  return ".murakumo-wan4-cache";
}

function resolveTokenizerCacheDir(): string {
  return `${resolveCacheDir()}/text`;
}

function defaultModelBaseUrl(): string {
  return Deno.env.get("Etzhayyim_NATIVE_WAN4_BASE_URL")?.trim() ||
    "https://cdn.etzhayyim.com/models/wan4";
}

const UMT5_TOKENIZER_JSON_URL =
  "https://huggingface.co/google/umt5-xxl/resolve/main/tokenizer.json";
const UMT5_TOKENIZER_CONFIG_URL =
  "https://huggingface.co/google/umt5-xxl/resolve/main/tokenizerConfig.json";
const T5_DIM = 4096;
const T5_SEQ_LEN = 64;

let tokenizerPromise: Promise<Tokenizer> | null = null;

async function loadCachedJson(url: string, cachePath: string): Promise<unknown> {
  try {
    const text = await Deno.readTextFile(cachePath);
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`failed to fetch ${url}: ${resp.status}`);
  }
  const text = await resp.text();
  await Deno.mkdir(resolveTokenizerCacheDir(), { recursive: true });
  await Deno.writeTextFile(cachePath, text);
  return JSON.parse(text);
}

async function loadUMT5Tokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const baseDir = resolveTokenizerCacheDir();
      const tokenizerJson = await loadCachedJson(
        UMT5_TOKENIZER_JSON_URL,
        `${baseDir}/umt5-tokenizer.json`,
      );
      const tokenizerConfig = await loadCachedJson(
        UMT5_TOKENIZER_CONFIG_URL,
        `${baseDir}/umt5-tokenizer-config.json`,
      ).catch((_err) => ({}));
      return new Tokenizer(
        tokenizerJson as Record<string, unknown>,
        tokenizerConfig as Record<string, unknown>,
      );
    })();
  }
  return tokenizerPromise;
}

async function encodePromptText(
  loader: InstanceType<typeof WAN4Loader>,
  prompt: string,
): Promise<Float32Array> {
  writeStderr("[native-wan4] text-embed:start tokenizer");
  const tokenizer = await loadUMT5Tokenizer();
  const encoded = tokenizer.encode(prompt, { 'addSpecialTokens': true });
  const tokenIds = encoded.ids.slice(0, T5_SEQ_LEN);
  if (tokenIds.length === 0) {
    tokenIds.push(0);
  }
  while (tokenIds.length < T5_SEQ_LEN) {
    tokenIds.push(0);
  }

  writeStderr(`[native-wan4] text-embed:tokens ${tokenIds.length}`);
  const embeddingShard = await loader.loadShard("t5_embedding");
  const tokenEmbedding = embeddingShard.tensors.get("tokenEmbedding.weight");
  if (!tokenEmbedding) {
    throw new Error("T5 embedding shard is missing tokenEmbedding.weight");
  }
  const textEmbeddings = dequantizeTensorRows(tokenEmbedding, tokenIds);
  if (textEmbeddings.length !== T5_SEQ_LEN * T5_DIM) {
    throw new Error(
      `unexpected T5 embedding length: ${textEmbeddings.length}`,
    );
  }
  writeStderr("[native-wan4] text-embed:done");
  return textEmbeddings;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function encodeFloat32Base64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    for (let j = 0; j < slice.length; j++) {
      binary += String.fromCharCode(slice[j]);
    }
  }
  return btoa(binary);
}

function decodeFloat32Base64(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`invalid float32 payload length: ${bytes.byteLength}`);
  }
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function imageDataToDataURI(imageData: ImageData): string {
  const w = imageData.width;
  const h = imageData.height;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelDataSize = rowSize * h;
  const fileSize = 54 + pixelDataSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, -h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelDataSize, true);

  const data = imageData.data;
  for (let y = 0; y < h; y++) {
    const rowOff = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4;
      const dstIdx = rowOff + x * 3;
      view.setUint8(dstIdx, data[srcIdx + 2]);
      view.setUint8(dstIdx + 1, data[srcIdx + 1]);
      view.setUint8(dstIdx + 2, data[srcIdx]);
    }
  }

  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:image/bmp;base64,${btoa(binary)}`;
}

function sampleProbeChecksum(sample: Float32Array, probeIndex: number): number {
  if (sample.length === 0) return 0;
  const idx = Math.min(sample.length - 1, (probeIndex * 7919) % sample.length);
  return Math.round(Math.abs(sample[idx]) * 1_000_000);
}

function makeWarmArtifacts(task: NativeTaskInfo, shardIds: string[]): string[] {
  const values = new Set<string>();
  for (const shardId of shardIds) values.add(shardId);
  for (const ref of task.inputBlobRefs ?? []) values.add(ref);
  if (task.packageRef) values.add(task.packageRef);
  for (const key of task.artifactKeys ?? []) values.add(key);
  return Array.from(values).filter(Boolean).sort();
}

function makeWarmShaders(task: NativeTaskInfo): string[] {
  return task.shaderHash ? [task.shaderHash] : [];
}

function defaultShardIds(): string[] {
  return [
    "embedding",
    ...Array.from({ length: 30 }, (_, i) => `block_${i}`),
    "head",
  ];
}

function normalizeShardId(value: string): string {
  const shardId = value.trim();
  if (shardId === "") return shardId;
  if (/^\d+$/.test(shardId)) {
    return `block_${shardId}`;
  }
  return shardId;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeShardId)
    .filter(Boolean);
}

function parseImageSize(
  value: unknown,
  fallbackWidth = 1024,
  fallbackHeight = 1024,
): { width: number; height: number } {
  if (typeof value !== "string" || value.trim() === "") {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  const parts = value.toLowerCase().split("x");
  if (parts.length !== 2) {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  const width = Number.parseInt(parts[0].trim(), 10);
  const height = Number.parseInt(parts[1].trim(), 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  return { width, height };
}

function imageStepsForQuality(value: unknown): number {
  if (typeof value !== "string") return 18;
  switch (value.trim().toLowerCase()) {
    case "hd":
    case "high":
      return 28;
    default:
      return 18;
  }
}

function ensureTaskParams(req: NativeExecRequest): Record<string, unknown> {
  if (req.params && typeof req.params === "object") {
    return req.params;
  }
  try {
    return req.task?.params
      ? (JSON.parse(req.task.params) as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function simpleTextEncode(
  prompt: string,
  textLen: number,
  dim: number,
): Float32Array {
  const emb = new Float32Array(textLen * dim);
  let hash = 5381;
  for (let i = 0; i < prompt.length; i++) {
    hash = ((hash << 5) + hash + prompt.charCodeAt(i)) | 0;
  }
  for (let t = 0; t < textLen; t++) {
    for (let d = 0; d < dim; d++) {
      const idx = t * dim + d;
      emb[idx] = Math.sin(hash * (idx + 1) * 0.000013) * 0.1;
    }
  }
  return emb;
}

async function executeDistributedSegment(
  req: NativeExecRequest,
): Promise<NativeExecResult> {
  const params = ensureTaskParams(req);
  const shardIds = asStringArray(params.shardIds).length > 0
    ? asStringArray(params.shardIds)
    : defaultShardIds();
  const prompt = typeof params.prompt === "string"
    ? params.prompt
    : "distributed verification";
  const groupIndex = typeof params.groupIndex === "number"
    ? params.'groupIndex': 0;
  const totalGroups = typeof params.totalGroups === "number"
    ? params.'totalGroups': 1;
  const generationId = typeof params.generationId === "string"
    ? params.'generationId': "";
  const seqLen = typeof params.seqLen === "number" ? params.'seqLen': 64;
  const textLen = typeof params.textLen === "number" ? params.'textLen': 64;
  const modelBaseUrl =
    typeof params.modelBaseUrl === "string" && params.modelBaseUrl
      ? params.'modelBaseUrl': defaultModelBaseUrl();

  const loader = new WAN4Loader(modelBaseUrl);
  await loader.init();
  await loader.loadManifest();
  const engine = new WAN4InferenceEngine();
  await engine.init();
  if (!engine.hasWebGPU) {
    throw new Error("distributedSegment requires native WebGPU");
  }

  const textEmb = simpleTextEncode(prompt, textLen, 3072);
  const hidden = new Float32Array(seqLen * 48);
  const seed = hashStr(prompt + generationId);
  for (let i = 0; i < hidden.length; i++) {
    hidden[i] = Math.sin(seed * (i + 1) * 0.00017) * 0.02;
  }

  writeStderr(`[native-wan4] loading ${shardIds.length} segment shards`);
  await loader.loadShards(shardIds, (progress: NativeLoadProgress) => {
    if (progress.phase === "ready") {
      writeStderr(`[native-wan4] shard ready ${progress.shardId}`);
    }
  });

  const started = performance.now();
  const segment = await engine.runSegment(
    hidden,
    textEmb,
    seqLen,
    textLen,
    shardIds,
    loader,
    (shardId: string, idx: number, total: number) => {
      writeStderr(`[native-wan4] segment ${idx + 1}/${total} ${shardId}`);
    },
  );
  const totalTime = Math.round(performance.now() - started);
  const results = segment.shardResults.map((
    shardResult: NativeSegmentShardResult,
  ) => ({
    'shardId': shardResult.shardId,
    index: shardResult.shardId === "embedding"
      ? 0
      : shardResult.shardId === "head"
      ? 31
      : Number.parseInt(shardResult.shardId.replace("block_", ""), 10) + 1,
    type: shardResult.shardId === "embedding"
      ? "embedding"
      : shardResult.shardId === "head"
      ? "head"
      : "block",
    'gpuTimeMs': shardResult.gpuTimeMs,
    checksum: shardResult.checksum,
    'throughputGflops': shardResult.throughputGflops,
    status: "ok",
  }));

  const output = {
    mode: "distributedSegment",
    'generationId': generationId,
    'groupIndex': groupIndex,
    'totalGroups': totalGroups,
    'shardIds': shardIds,
    'shardCount': shardIds.length,
    results,
    'totalGpuTimeMs': totalTime,
    'avgShardTimeMs': Math.round(totalTime / Math.max(shardIds.length, 1)),
    'okCount': results.length,
    'errorCount': 0,
    'totalGflops': Math.round(
      results.reduce(
        (sum: number, row: { 'throughputGflops': number }) =>
          sum + row.throughputGflops,
        0,
      ) * 100,
    ) / 100,
    'workerId': req.workerId,
    'gpuTier': req.capability.gpuTier ?? "g0",
    runtime: "wan4_native_webgpu_segment",
  };

  return {
    output: JSON.stringify(output),
    'totalGpuTimeMs': totalTime,
    'totalUnits': results.length,
    'warmArtifacts': makeWarmArtifacts(req.task, shardIds),
    'warmShaders': makeWarmShaders(req.task),
  };
}

async function executeDistributedDiffusionChunk(
  req: NativeExecRequest,
): Promise<NativeExecResult> {
  const params = ensureTaskParams(req);
  const prompt = typeof params.prompt === "string"
    ? params.prompt
    : "a ceramic coffee mug on a wooden table by a sunlit window";
  const width = typeof params.width === "number" ? params.width : 256;
  const height = typeof params.height === "number" ? params.height : 256;
  const generationId = typeof params.generationId === "string"
    ? params.'generationId': "";
  const shardIds = asStringArray(params.shardIds).length > 0
    ? asStringArray(params.shardIds)
    : defaultShardIds();
  const totalSteps = Math.max(
    1,
    typeof params.totalSteps === "number"
      ? params.'totalSteps': typeof params.steps === "number"
      ? params.steps
      : 15,
  );
  const stepStart = Math.max(
    0,
    typeof params.stepStart === "number" ? params.'stepStart': 0,
  );
  const remainingSteps = Math.max(1, totalSteps - stepStart);
  const stepCount = Math.min(
    remainingSteps,
    Math.max(
      1,
      typeof params.stepCount === "number"
        ? params.'stepCount': remainingSteps,
    ),
  );
  const decodeFinal = Boolean(params.decodeFinal);
  const seed = typeof params.seed === "number"
    ? params.seed
    : hashStr(prompt + generationId);
  const inputState =
    params.inputState && typeof params.inputState === "object"
      ? (params.inputState as Record<string, unknown>)
      : undefined;
  const modelBaseUrl =
    typeof params.modelBaseUrl === "string" && params.modelBaseUrl
      ? params.'modelBaseUrl': defaultModelBaseUrl();

  const loader = new WAN4Loader(modelBaseUrl);
  await loader.init();
  const manifest = await loader.loadManifest();
  const engine = new WAN4InferenceEngine();
  await engine.init();
  if (!engine.hasWebGPU) {
    throw new Error("distributedDiffusionChunk requires native WebGPU");
  }

  let initialSample: Float32Array | undefined;
  if (
    inputState && typeof inputState.sampleB64 === "string" &&
    inputState.sampleB64.length > 0
  ) {
    initialSample = decodeFloat32Base64(inputState.sampleB64);
  }

  const textShardIds = manifest.shards
    .filter((shard: { id: string }) =>
      shard.id === "t5_embedding" || shard.id.startsWith("t5_layers_")
    )
    .map((shard: { id: string }) => shard.id);
  writeStderr(
    `[native-wan4] loading ${textShardIds.length} text shards`,
  );
  await loader.loadShards(textShardIds, (progress: NativeLoadProgress) => {
    if (progress.phase === "ready") {
      writeStderr(`[native-wan4] shard ready ${progress.shardId}`);
    }
  });
  const textEmbeddings = await encodePromptText(loader, prompt);

  const started = performance.now();
  const result = await engine.runDiffusionChunk(
    loader,
    {
      prompt,
      seed,
      totalSteps,
      stepStart,
      stepCount,
      width,
      height,
      initialSample,
      textEmbeddings,
      decodeFinal,
    },
    (step: number, total: number, stage: string) => {
      writeStderr(`[native-wan4] diffusion ${step + 1}/${total} ${stage}`);
    },
  );
  const totalTime = Math.round(performance.now() - started);
  const image = result.imageData
    ? imageDataToDataURI(result.imageData)
    : undefined;
  const sampleB64 = encodeFloat32Base64(result.sample);
  const results = shardIds.map((shardId, index) => ({
    'shardId': shardId,
    index: shardId === "embedding"
      ? 0
      : shardId === "head"
      ? 31
      : Number.parseInt(shardId.replace("block_", ""), 10) + 1,
    type: shardId === "embedding"
      ? "embedding"
      : shardId === "head"
      ? "head"
      : "block",
    'gpuTimeMs': Math.max(
      1,
      Math.round(totalTime / Math.max(shardIds.length, 1)),
    ),
    checksum: sampleProbeChecksum(result.sample, index),
    'throughputGflops': 0,
    status: "ok",
  }));

  const state = {
    'sampleB64': sampleB64,
    'stepStart': result.startStep,
    'completedSteps': result.completedSteps,
    'totalSteps': result.totalSteps,
    width,
    height,
    seed,
  };
  const output = {
    mode: "distributedDiffusionChunk",
    'generationId': generationId,
    prompt,
    width,
    height,
    seed,
    'stepStart': result.startStep,
    'completedSteps': result.completedSteps,
    'totalSteps': result.totalSteps,
    'shardIds': shardIds,
    'shardCount': shardIds.length,
    results,
    'totalGpuTimeMs': totalTime,
    'avgShardTimeMs': Math.max(
      1,
      Math.round(totalTime / Math.max(shardIds.length, 1)),
    ),
    'okCount': results.length,
    'errorCount': 0,
    image,
    state,
    'workerId': req.workerId,
    'gpuTier': req.capability.gpuTier ?? "g0",
    runtime: "wan4_native_webgpu_distributed",
  };

  return {
    output: JSON.stringify(output),
    'totalGpuTimeMs': totalTime,
    'totalUnits': result.completedSteps,
    'warmArtifacts': makeWarmArtifacts(req.task, [
      ...shardIds,
      ...textShardIds,
    ]),
    'warmShaders': makeWarmShaders(req.task),
    checkpoint: {
      iteration: result.completedSteps,
      'stateMetadata': JSON.stringify(state),
    },
  };
}

function parseDataURI(dataURI: string): { mimeType: string; b64: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataURI);
  if (!match) {
    throw new Error("native diffusion output is not a base64 data URI");
  }
  return { mimeType: match[1], b64: match[2] };
}

async function executeImageGeneration(
  req: NativeExecRequest,
): Promise<NativeExecResult> {
  const params = ensureTaskParams(req);
  const { width, height } = parseImageSize(params.size);
  const imageCount = Math.min(
    4,
    Math.max(
      1,
      typeof params.n === "number"
        ? Math.trunc(params.n)
        : Number.parseInt(String(params.n ?? "1"), 10) || 1,
    ),
  );
  const totalSteps = Math.max(
    1,
    typeof params.totalSteps === "number"
      ? params.'totalSteps': imageStepsForQuality(params.quality),
  );
  const seedBase = typeof params.seed === "number"
    ? params.seed
    : hashStr(String(params.prompt ?? "") + String(params.model ?? "wan4"));

  const rows: Array<Record<string, unknown>> = [];
  let totalGPUTimeMS = 0;
  for (let i = 0; i < imageCount; i++) {
    const generationReq: NativeExecRequest = {
      ...req,
      params: {
        ...params,
        mode: "distributedDiffusionChunk",
        width,
        height,
        'totalSteps': totalSteps,
        'stepStart': 0,
        'stepCount': totalSteps,
        'decodeFinal': true,
        seed: seedBase + i,
        'generationId': imageCount > 1
          ? `${String(params.generationId ?? req.task.taskId)}-${i + 1}`
          : String(params.generationId ?? req.task.taskId),
      },
    };
    const generated = await executeDistributedDiffusionChunk(generationReq);
    totalGPUTimeMS += generated.totalGpuTimeMs ?? 0;

    if (!generated.output) {
      throw new Error("native diffusion returned empty output");
    }
    const payload = JSON.parse(generated.output) as Record<string, unknown>;
    if (typeof payload.image !== "string" || payload.image.length === 0) {
      throw new Error("native diffusion did not decode a final image");
    }
    const { mimeType, b64 } = parseDataURI(payload.image);
    rows.push({
      b64_json: b64,
      'mimeType': mimeType,
      runtime: payload.runtime,
      'generationId': payload.generationId,
      seed: payload.seed,
    });
  }

  return {
    output: JSON.stringify(rows),
    'totalGpuTimeMs': totalGPUTimeMS,
    'totalUnits': rows.length,
  };
}

async function run(): Promise<void> {
  const stdinText = await new Response(Deno.stdin.readable).text();
  if (!stdinText.trim()) {
    throw new Error("native exec stdin is empty");
  }
  const req = JSON.parse(stdinText) as NativeExecRequest;
  const params = ensureTaskParams(req);
  let mode = typeof params.mode === "string" ? params.mode : "";
  if (!mode && req.task?.taskType === "llmInference" && typeof params.type === "string") {
    mode = params.type;
  }

  let result: NativeExecResult;
  switch (mode) {
    case "distributedSegment":
      result = await executeDistributedSegment(req);
      break;
    case "distributedDiffusionChunk":
      result = await executeDistributedDiffusionChunk(req);
      break;
    case "imageGeneration":
      result = await executeImageGeneration(req);
      break;
    case "videoGeneration":
      throw new Error("videoGeneration is disabled in WebGPU-only mode");
    default:
      throw new Error(
        `unsupported native WAN4 mode: ${mode || req.task.taskType}`,
      );
  }

  await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(result)));
}

if (import.meta.main) {
  try {
    await run();
  } catch (err) {
    writeStderr(
      "[native-wan4] fatal",
      err instanceof Error ? err.stack ?? err.message : String(err),
    );
    Deno.exit(1);
  }
}

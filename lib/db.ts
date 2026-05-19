import fs from "fs";
import path from "path";

const DATA_DIR = process.env.KIE_WORKBENCH_DATA_DIR
  ? path.join(process.env.KIE_WORKBENCH_DATA_DIR, "data")
  : path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
export const FAILED_GENERATION_RETENTION_MS = 30 * 60 * 1000;

export type GenerationRow = {
  id: string;
  task_id: string;
  model: string;
  prompt: string;
  aspect_ratio: string | null;
  resolution: string | null;
  /** JSON：旧版 string[]，v2 产品/参考图，v3 产品/图案/参考图与修改模式 */
  input_urls: string;
  state: string;
  result_urls: string | null;
  fail_msg: string | null;
  fail_code: string | null;
  credits: number | null;
  created_at: number;
  updated_at: number;
  batch_id?: string | null;
  batch_index?: number | null;
  batch_size?: number | null;
};
export type ModelRow = {
  id: string;
  label: string;
  enabled: number;
  sort_order: number;
  is_default: number;
  kie_model: string;
  adapter: "gpt-image-2" | "nano-banana-pro";
  max_inputs: number;
  supports_pattern_images: number;
  supports_edit_mode: number;
};

type AppState = {
  settings: Record<string, string>;
  generations: GenerationRow[];
  models: ModelRow[];
};

function defaultState(): AppState {
  return {
    settings: {},
    generations: [],
    models: [
      {
        id: "gpt-image-2-image-to-image",
        label: "GPT Image 2 · Image to Image",
        enabled: 1,
        sort_order: 0,
        is_default: 1,
        kie_model: "gpt-image-2-image-to-image",
        adapter: "gpt-image-2",
        max_inputs: 16,
        supports_pattern_images: 1,
        supports_edit_mode: 1,
      },
      {
        id: "nano-banana-pro",
        label: "Nano Banana Pro · Concept Image",
        enabled: 1,
        sort_order: 10,
        is_default: 0,
        kie_model: "nano-banana-pro",
        adapter: "nano-banana-pro",
        max_inputs: 14,
        supports_pattern_images: 1,
        supports_edit_mode: 1,
      },
    ],
  };
}

function normalizeModel(model: Partial<ModelRow> & Pick<ModelRow, "id">): ModelRow {
  const seeded = defaultState().models.find((m) => m.id === model.id);
  const adapter =
    model.adapter === "nano-banana-pro" || model.adapter === "gpt-image-2"
      ? model.adapter
      : seeded?.adapter ?? "gpt-image-2";
  const maxInputs =
    typeof model.max_inputs === "number" && Number.isFinite(model.max_inputs)
      ? Math.max(1, Math.floor(model.max_inputs))
      : seeded?.max_inputs ?? 16;
  return {
    id: model.id,
    label: model.label ?? seeded?.label ?? model.id,
    enabled: model.enabled === 0 ? 0 : 1,
    sort_order:
      typeof model.sort_order === "number" && Number.isFinite(model.sort_order)
        ? model.sort_order
        : seeded?.sort_order ?? 0,
    is_default: model.is_default === 1 ? 1 : 0,
    kie_model: model.kie_model ?? seeded?.kie_model ?? model.id,
    adapter,
    max_inputs: maxInputs,
    supports_pattern_images: model.supports_pattern_images === 0 ? 0 : 1,
    supports_edit_mode: model.supports_edit_mode === 0 ? 0 : 1,
  };
}

function ensureSeedModels(s: AppState) {
  const seeds = defaultState().models;
  s.models = s.models.map((m) => normalizeModel(m));
  let changed = false;
  for (const seed of seeds) {
    if (!s.models.some((m) => m.id === seed.id)) {
      s.models.push(seed);
      changed = true;
    }
  }
  if (!s.models.some((m) => m.is_default === 1) && s.models.length > 0) {
    s.models[0].is_default = 1;
    changed = true;
  }
  return changed;
}

function readState(): AppState {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      const s = defaultState();
      writeState(s);
      return s;
    }
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as AppState;
    if (!Array.isArray(parsed.generations)) parsed.generations = [];
    if (!Array.isArray(parsed.models)) parsed.models = defaultState().models;
    if (!parsed.settings || typeof parsed.settings !== "object") {
      parsed.settings = {};
    }
    if (parsed.models.length === 0 || ensureSeedModels(parsed)) {
      writeState(parsed);
    }
    return parsed;
  } catch {
    const s = defaultState();
    writeState(s);
    return s;
  }
}

function writeState(s: AppState) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2), "utf-8");
}

function mutate(fn: (s: AppState) => void) {
  const s = readState();
  fn(s);
  writeState(s);
}

/* --- settings --- */

const KEY_KIE_API = "kie_api_key";

export function getSetting(key: string): string | null {
  return readState().settings[key] ?? null;
}

export function setSetting(key: string, value: string) {
  mutate((s) => {
    s.settings[key] = value;
  });
}

export function getStoredApiKey(): string | null {
  return getSetting(KEY_KIE_API);
}

export function setStoredApiKey(key: string) {
  setSetting(KEY_KIE_API, key);
}

/* --- generations --- */

export function listGenerations(limit = 200): GenerationRow[] {
  const s = readState();
  return [...s.generations]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

export function deleteExpiredFailedGenerations(
  now = Date.now(),
  retentionMs = FAILED_GENERATION_RETENTION_MS
): number {
  let deleted = 0;
  mutate((s) => {
    const before = s.generations.length;
    s.generations = s.generations.filter((g) => {
      if (g.state !== "fail") return true;
      const t = Number.isFinite(g.updated_at) ? g.updated_at : g.created_at;
      return now - t < retentionMs;
    });
    deleted = before - s.generations.length;
  });
  return deleted;
}

export function insertGeneration(row: GenerationRow) {
  mutate((s) => {
    s.generations.push(row);
  });
}

export function updateGenerationByTaskId(
  taskId: string,
  patch: Partial<
    Pick<
      GenerationRow,
      | "state"
      | "result_urls"
      | "fail_msg"
      | "fail_code"
      | "credits"
      | "updated_at"
    >
  >
) {
  mutate((s) => {
    const g = s.generations.find((x) => x.task_id === taskId);
    if (!g) return;
    if (patch.state !== undefined) g.state = patch.state;
    if (patch.result_urls !== undefined) g.result_urls = patch.result_urls;
    if (patch.fail_msg !== undefined) g.fail_msg = patch.fail_msg;
    if (patch.fail_code !== undefined) g.fail_code = patch.fail_code;
    if (patch.credits !== undefined) g.credits = patch.credits;
    if (patch.updated_at !== undefined) g.updated_at = patch.updated_at;
  });
}

/* --- models --- */

export function listModels(): ModelRow[] {
  const s = readState();
  return [...s.models].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.label.localeCompare(b.label);
  });
}

export function getDefaultModelId(): string | null {
  const rows = listModels().filter((m) => m.enabled === 1);
  const def = rows.find((m) => m.is_default === 1);
  if (def) return def.id;
  return rows[0]?.id ?? null;
}

export function getModelById(id: string): ModelRow | null {
  return readState().models.find((m) => m.id === id) ?? null;
}

export function setDefaultModel(id: string) {
  mutate((s) => {
    for (const m of s.models) {
      m.is_default = m.id === id ? 1 : 0;
    }
  });
}

export function upsertModel(row: {
  id: string;
  label: string;
  kie_model: string;
  adapter?: ModelRow["adapter"];
  max_inputs?: number;
  supports_pattern_images?: boolean;
  supports_edit_mode?: boolean;
  enabled: boolean;
  sort_order: number;
}) {
  mutate((s) => {
    const i = s.models.findIndex((m) => m.id === row.id);
    const prev = i >= 0 ? s.models[i] : undefined;
    const supportsPatternImages =
      row.supports_pattern_images ?? (prev?.supports_pattern_images !== 0);
    const supportsEditMode =
      row.supports_edit_mode ?? (prev?.supports_edit_mode !== 0);
    const next: ModelRow = {
      id: row.id,
      label: row.label,
      enabled: row.enabled ? 1 : 0,
      sort_order: row.sort_order,
      is_default: 0,
      kie_model: row.kie_model,
      adapter: row.adapter ?? prev?.adapter ?? "gpt-image-2",
      max_inputs: row.max_inputs ?? prev?.max_inputs ?? 16,
      supports_pattern_images: supportsPatternImages ? 1 : 0,
      supports_edit_mode: supportsEditMode ? 1 : 0,
    };
    if (i >= 0) {
      next.is_default = s.models[i].is_default;
      s.models[i] = next;
    } else {
      s.models.push(next);
    }
  });
}

export function deleteModel(id: string) {
  mutate((s) => {
    s.models = s.models.filter((m) => m.id !== id);
    if (!s.models.some((m) => m.is_default === 1) && s.models.length > 0) {
      s.models[0].is_default = 1;
    }
  });
}

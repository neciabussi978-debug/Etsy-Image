"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAllowedInputImageUrl } from "@/lib/input-url";
import { parseInputPayload } from "@/lib/input-payload";

type ModelRow = {
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

type Generation = {
  id: string;
  task_id: string;
  model: string;
  prompt: string;
  aspect_ratio: string | null;
  resolution: string | null;
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

type ImageSlot = {
  id: string;
  url: string;
};

type EditMode = "pattern_replace" | "full_redesign";

type BatchOutputItem = {
  taskId: string;
  submittedAt: number;
  state: string;
  resultUrls: string[];
  failMsg?: string;
  costTimeMs?: number | null;
  clientElapsedMs?: number | null;
};

type DownloadedFile = {
  filename: string;
  path: string;
};

type PrintFormat = "png" | "pdf";

type HistoryProject = {
  key: string;
  rows: Generation[];
  prompt: string;
  model: string;
  state: string;
  createdAt: number;
  resultUrls: string[];
};

const ASPECT_OPTIONS = ["auto", "1:1", "9:16", "16:9", "4:3", "3:4"] as const;
const RES_OPTIONS = ["1K", "2K", "4K"] as const;

const POLL_MS = 3000;
const TIMEOUT_MS = 15 * 60 * 1000;
const FAILED_HISTORY_REFRESH_MS = 60 * 1000;

function parseResultUrls(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { resultUrls?: unknown };
    if (!Array.isArray(v.resultUrls)) return [];
    return v.resultUrls.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function formatGenDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function sortProjectRows(rows: Generation[]): Generation[] {
  return [...rows].sort((a, b) => {
    const ai = a.batch_index ?? Number.MAX_SAFE_INTEGER;
    const bi = b.batch_index ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.created_at - b.created_at;
  });
}

function summarizeProjectState(rows: Generation[]): string {
  if (rows.every((g) => g.state === "success")) return "success";
  if (rows.some((g) => g.state === "success")) return "partial";
  return rows[0]?.state ?? "unknown";
}

function buildHistoryProjects(rows: Generation[]): HistoryProject[] {
  const groups = new Map<string, Generation[]>();
  for (const row of rows) {
    const key = row.batch_id ? `batch:${row.batch_id}` : `single:${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([key, groupedRows]) => {
      const sorted = sortProjectRows(groupedRows);
      const first = sorted[0];
      const resultUrls = sorted.flatMap((row) => parseResultUrls(row.result_urls));
      return {
        key,
        rows: sorted,
        prompt: first?.prompt ?? "",
        model: first?.model ?? "",
        state: summarizeProjectState(sorted),
        createdAt: Math.min(...sorted.map((row) => row.created_at)),
        resultUrls,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export default function Workbench() {
  const [uploadBackend, setUploadBackend] = useState<"kie-file-upload" | "blob" | "local">("local");
  const [kieKeyConfigured, setKieKeyConfigured] = useState(false);
  const [dragOverProduct, setDragOverProduct] = useState(false);
  const [dragOverRef, setDragOverRef] = useState(false);
  const [uploadHint, setUploadHint] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [editMode, setEditMode] = useState<EditMode>("pattern_replace");
  const [aspect, setAspect] = useState<string>("auto");
  const [resolution, setResolution] = useState<string>("1K");
  const [imageCount, setImageCount] = useState(1);
  const [productSlots, setProductSlots] = useState<ImageSlot[]>([]);
  const [refSlots, setRefSlots] = useState<ImageSlot[]>([]);
  const [pasteProduct, setPasteProduct] = useState("");
  const [pasteRef, setPasteRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadKeys, setDownloadKeys] = useState<Set<string>>(() => new Set());
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [batchOutputs, setBatchOutputs] = useState<BatchOutputItem[] | null>(null);
  const [printSourceUrl, setPrintSourceUrl] = useState<string | null>(null);
  const [printFormat, setPrintFormat] = useState<PrintFormat>("png");
  const [printJob, setPrintJob] = useState<BatchOutputItem | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [history, setHistory] = useState<Generation[]>([]);
  const pollStartRef = useRef<number | null>(null);
  const batchOutputsRef = useRef<BatchOutputItem[] | null>(null);
  const fileInputProductRef = useRef<HTMLInputElement>(null);
  const fileInputRefRef = useRef<HTMLInputElement>(null);
  const dragDepthProductRef = useRef(0);
  const dragDepthRefRef = useRef(0);
  const lastDropProductRef = useRef(0);
  const lastDropRefRef = useRef(0);

  batchOutputsRef.current = batchOutputs;
  const batchOutputCount = batchOutputs?.length ?? 0;

  const loadBootstrap = useCallback(async () => {
    const r = await fetch("/api/bootstrap");
    const j = (await r.json()) as {
      uploadBackend?: "kie-file-upload" | "blob" | "local";
      kieKeyConfigured?: boolean;
    };
    setUploadBackend(j.uploadBackend ?? "local");
    setKieKeyConfigured(Boolean(j.kieKeyConfigured));
  }, []);

  const loadModels = useCallback(async () => {
    const r = await fetch("/api/models");
    const j = (await r.json()) as { items: ModelRow[] };
    setModels(j.items.filter((m) => m.enabled));
    const def =
      j.items.find((m) => m.enabled && m.is_default)?.id ??
      j.items.find((m) => m.enabled)?.id ??
      "";
    setModelId((prev) => (prev && j.items.some((x) => x.id === prev) ? prev : def));
  }, []);

  const loadHistory = useCallback(async () => {
    const r = await fetch("/api/history");
    const j = (await r.json()) as { items: Generation[] };
    setHistory(j.items);
  }, []);

  useEffect(() => {
    void loadBootstrap();
    void loadModels();
    void loadHistory();
  }, [loadBootstrap, loadModels, loadHistory]);

  const selectedModel = models.find((m) => m.id === modelId);
  const maxInputs = selectedModel?.max_inputs ?? 16;
  const mergedCount = productSlots.length + refSlots.length;
  const currentResultUrls = useMemo(
    () => batchOutputs?.flatMap((item) => item.resultUrls) ?? [],
    [batchOutputs]
  );
  const historyProjects = useMemo(() => buildHistoryProjects(history), [history]);
  const historyHasPending = useMemo(
    () => history.some((row) => row.state !== "success" && row.state !== "fail"),
    [history]
  );
  const historyHasFailed = useMemo(
    () => history.some((row) => row.state === "fail"),
    [history]
  );
  const refreshPendingHistory = useCallback(async () => {
    const pending = history.filter(
      (row) => row.state !== "success" && row.state !== "fail"
    );
    if (pending.length === 0) return;
    await Promise.all(
      pending.slice(0, 20).map((row) =>
        fetch(`/api/jobs/${encodeURIComponent(row.task_id)}`).catch(() => undefined)
      )
    );
    await loadHistory();
  }, [history, loadHistory]);

  useEffect(() => {
    if (!historyHasPending) return;
    void refreshPendingHistory();
    const id = window.setInterval(() => void refreshPendingHistory(), POLL_MS);
    return () => window.clearInterval(id);
  }, [historyHasPending, refreshPendingHistory]);

  useEffect(() => {
    if (!historyHasFailed) return;
    const id = window.setInterval(() => void loadHistory(), FAILED_HISTORY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [historyHasFailed, loadHistory]);

  const setDownloadActive = (key: string, active: boolean) => {
    setDownloadKeys((prev) => {
      const next = new Set(prev);
      if (active) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const addUrl = (kind: "product" | "reference") => {
    const raw = kind === "product" ? pasteProduct.trim() : pasteRef.trim();
    if (!raw) return;
    if (!isAllowedInputImageUrl(raw)) {
      setError("请输入有效地址：公网 https，或本机 http://localhost / http://127.0.0.1 …");
      return;
    }
    const slot: ImageSlot = { id: crypto.randomUUID(), url: raw };
    if (kind === "product") {
      setProductSlots((s) => [...s, slot]);
      setPasteProduct("");
    } else {
      setRefSlots((s) => [...s, slot]);
      setPasteRef("");
    }
    setError(null);
  };

  const onFiles = async (files: FileList | null, kind: "product" | "reference") => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setUploadHint(null);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", file);
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        const j = (await r.json()) as {
          url?: string;
          error?: string;
          warning?: string;
          hint?: string;
        };
        if (!r.ok) throw new Error(j.error || "上传失败");
        if (!j.url) throw new Error("上传无返回 URL");
        const url = j.url;
        const slot: ImageSlot = { id: crypto.randomUUID(), url };
        if (kind === "product") {
          setProductSlots((s) => [...s, slot]);
        } else {
          setRefSlots((s) => [...s, slot]);
        }
        if (j.warning) setUploadHint(j.warning);
        else if (j.hint) setUploadHint(j.hint);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const removeSlot = (kind: "product" | "reference", id: string) => {
    if (kind === "product") {
      setProductSlots((s) => s.filter((x) => x.id !== id));
    } else {
      setRefSlots((s) => s.filter((x) => x.id !== id));
    }
  };

  const saveImages = async (
    urls: string[],
    key: string,
    format: "original" | PrintFormat = "original"
  ) => {
    if (urls.length === 0) return;
    setDownloadActive(key, true);
    setError(null);
    setDownloadMessage(null);
    try {
      const r = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, format }),
      });
      const j = (await r.json()) as {
        error?: string;
        outputDir?: string;
        files?: DownloadedFile[];
      };
      if (!r.ok) {
        throw new Error(j.error || "下载失败");
      }
      const files = j.files ?? [];
      const outputDir = j.outputDir ?? "下载目录";
      if (files.length === 1) {
        setDownloadMessage(`已保存到 ${outputDir}\\${files[0].filename}`);
      } else {
        setDownloadMessage(
          `已保存 ${files.length} 张到 ${outputDir}：${files
            .map((file) => file.filename)
            .join("、")}`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloadActive(key, false);
    }
  };

  const selectPrintSource = (url: string) => {
    setPrintSourceUrl(url);
    setPrintJob(null);
    setError(null);
    setDownloadMessage(null);
  };

  const startPrintAsset = async () => {
    setError(null);
    if (!printSourceUrl) {
      setError("请先从结果或历史中选择一张图片。");
      return;
    }
    if (!modelId) {
      setError("请选择模型（或到「模型」页启用一个默认模型）。");
      return;
    }

    setPrintBusy(true);
    try {
      const r = await fetch("/api/print-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_url: printSourceUrl,
          modelId,
        }),
      });
      const j = (await r.json()) as {
        job?: { id: string; taskId: string };
        error?: string;
      };
      if (!r.ok || !j.job) {
        throw new Error(j.error || "创建打印图案任务失败");
      }
      setPrintJob({
        taskId: j.job.taskId,
        submittedAt: Date.now(),
        state: "waiting",
        resultUrls: [],
      });
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建打印图案任务失败");
    } finally {
      setPrintBusy(false);
    }
  };

  const startJob = async () => {
    setError(null);
    if (!modelId) {
      setError("请选择模型（或到「模型」页启用一个默认模型）。");
      return;
    }
    if (!prompt.trim()) {
      setError("请填写修改要求。");
      return;
    }
    if (productSlots.length === 0) {
      setError("请至少添加一张产品参考图。");
      return;
    }
    if (mergedCount > maxInputs) {
      setError(`产品参考图与图案素材图合计最多 ${maxInputs} 张。`);
      return;
    }
    const n = Math.min(10, Math.max(1, Math.floor(imageCount)));
    setBusy(true);
    setBatchOutputs(null);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId,
          prompt: prompt.trim(),
          product_urls: productSlots.map((s) => s.url),
          pattern_urls: refSlots.map((s) => s.url),
          reference_urls: [],
          edit_mode: editMode,
          image_count: n,
          aspect_ratio: aspect,
          resolution,
        }),
      });
      const j = (await r.json()) as {
        jobs?: { id: string; taskId: string }[];
        error?: string;
        partial?: boolean;
      };
      if (!r.ok) {
        throw new Error(j.error || "创建任务失败");
      }
      if (!j.jobs?.length) {
        throw new Error(j.error || "未返回任务列表");
      }
      if (j.partial && j.error) {
        setError(j.error);
      }
      pollStartRef.current = Date.now();
      const now = Date.now();
      setBatchOutputs(
        j.jobs.map((job) => ({
          taskId: job.taskId,
          submittedAt: now,
          state: "waiting",
          resultUrls: [],
        }))
      );
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建任务失败");
    } finally {
      setBusy(false);
    }
  };

  const pollingKey =
    batchOutputs?.map((b) => `${b.taskId}:${b.state}`).join("|") ?? "";

  useEffect(() => {
    const currentBatch = batchOutputsRef.current;
    if (!currentBatch?.length) return;
    const allDone = currentBatch.every((b) => b.state === "success" || b.state === "fail");
    if (allDone) {
      void loadHistory();
      return;
    }

    let cancelled = false;

    const tick = async () => {
      if (pollStartRef.current && Date.now() - pollStartRef.current > TIMEOUT_MS) {
        setError("轮询超时（15 分钟），请稍后在历史记录中查看任务状态。");
        setBatchOutputs(null);
        return;
      }
      const snapshot = batchOutputsRef.current;
      if (!snapshot?.length) return;

      const next = await Promise.all(
        snapshot.map(async (b) => {
          if (b.state === "success" || b.state === "fail") return b;
          const r = await fetch(`/api/jobs/${encodeURIComponent(b.taskId)}`);
          const j = (await r.json()) as {
            state?: string;
            resultUrls?: string[];
            failMsg?: string;
            error?: string;
            costTime?: number;
          };
          if (!r.ok) {
            return {
              ...b,
              state: "fail",
              failMsg: j.error || "查询任务失败",
            };
          }
          const st = j.state ?? "unknown";
          const urls = j.resultUrls ?? [];
          const costRaw = j.costTime;
          const costTimeMs =
            typeof costRaw === "number" && Number.isFinite(costRaw) && costRaw > 0
              ? costRaw
              : null;
          let clientElapsedMs = b.clientElapsedMs;
          if (
            st === "success" &&
            clientElapsedMs == null &&
            (costTimeMs == null || costTimeMs <= 0)
          ) {
            clientElapsedMs = Date.now() - b.submittedAt;
          }
          return {
            ...b,
            state: st,
            resultUrls: urls,
            failMsg: j.failMsg,
            costTimeMs: costTimeMs ?? b.costTimeMs,
            clientElapsedMs,
          };
        })
      );

      if (!cancelled) {
        setBatchOutputs(next);
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollingKey, loadHistory, batchOutputCount]);

  const printPollingKey = printJob ? `${printJob.taskId}:${printJob.state}` : "";

  useEffect(() => {
    if (!printJob) return;
    if (printJob.state === "success" || printJob.state === "fail") {
      void loadHistory();
      return;
    }

    let cancelled = false;
    const tick = async () => {
      const current = printJob;
      if (Date.now() - current.submittedAt > TIMEOUT_MS) {
        setError("打印图案任务轮询超时，请稍后在历史记录中查看。");
        return;
      }
      const r = await fetch(`/api/jobs/${encodeURIComponent(current.taskId)}`);
      const j = (await r.json()) as {
        state?: string;
        resultUrls?: string[];
        failMsg?: string;
        error?: string;
        costTime?: number;
      };
      if (cancelled) return;
      if (!r.ok) {
        setPrintJob({
          ...current,
          state: "fail",
          failMsg: j.error || "查询打印图案任务失败",
        });
        return;
      }
      const st = j.state ?? "unknown";
      const costRaw = j.costTime;
      const costTimeMs =
        typeof costRaw === "number" && Number.isFinite(costRaw) && costRaw > 0
          ? costRaw
          : null;
      setPrintJob({
        ...current,
        state: st,
        resultUrls: j.resultUrls ?? [],
        failMsg: j.failMsg,
        costTimeMs,
        clientElapsedMs:
          st === "success" && costTimeMs == null
            ? Date.now() - current.submittedAt
            : current.clientElapsedMs,
      });
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [printPollingKey, printJob, loadHistory]);

  const applyHistoryProject = (project: HistoryProject) => {
    const rows = sortProjectRows(project.rows);
    const g = rows[0];
    if (!g) return;
    const parsed = parseInputPayload(g.input_urls);
    setPrompt(g.prompt);
    setEditMode(parsed.editMode);
    setAspect(g.aspect_ratio || "auto");
    setResolution(g.resolution || "1K");
    setModelId(models.some((m) => m.id === g.model) ? g.model : modelId);
    const { product, pattern, reference } = parsed;
    setProductSlots(product.map((url) => ({ id: crypto.randomUUID(), url })));
    const patternLikeUrls = pattern.length > 0 ? pattern : reference;
    setRefSlots(patternLikeUrls.map((url) => ({ id: crypto.randomUUID(), url })));
    setBatchOutputs(
      rows.map((row) => {
        const elapsed =
          row.state === "success" && row.updated_at > row.created_at
            ? row.updated_at - row.created_at
            : null;
        return {
          taskId: row.task_id,
          submittedAt: row.created_at,
          state: row.state,
          resultUrls: parseResultUrls(row.result_urls),
          failMsg: row.fail_msg || undefined,
          costTimeMs: null,
          clientElapsedMs: elapsed,
        };
      })
    );
    setError(null);
    setDownloadMessage(null);
  };

  const uploadIntro = useMemo(
    () =>
      uploadBackend === "kie-file-upload"
        ? "已配置 Kie Key：图片会先传到 Kie 文件服务，生图时可被云端拉取。"
        : uploadBackend === "blob"
          ? "当前使用 Vercel Blob（公网 HTTPS）。"
          : "当前写入本机 public/uploads。若未配置 Kie Key，Kie 无法拉取 localhost 图片，生图会失败。",
    [uploadBackend]
  );

  return (
    <div className="space-y-8">
      <div className="grid min-h-[560px] grid-cols-1 gap-4 lg:grid-cols-12">
        <section className="lg:col-span-4">
          <div className="flex h-full flex-col rounded-xl border border-canvas-border bg-white p-4 shadow-panel">
            <h2 className="text-sm font-semibold text-ink">输入素材</h2>
            <p className="mt-1 text-xs text-ink-muted">
              上传产品参考图与图案素材图，再填写修改要求，生成产品概念验证图。均支持多选文件与 URL。
              {uploadIntro}
              {!kieKeyConfigured && (
                <span className="mt-1 block text-amber-800">
                  请先到「设置」保存 Kie API Key，再上传素材（推荐）。
                </span>
              )}
            </p>
            {uploadHint && (
              <p className="mt-2 rounded-md bg-amber-50 px-2 py-2 text-[11px] leading-snug text-amber-900">
                {uploadHint}
              </p>
            )}
            <p className="mt-2 text-[11px] text-ink-faint">
              当前合计 {mergedCount} / {maxInputs} 张（产品 {productSlots.length} + 图案 {refSlots.length}）
            </p>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* 产品参考图 */}
              <div className="flex min-h-0 flex-col rounded-lg border border-canvas-border bg-canvas-muted/40 p-3">
                <h3 className="text-xs font-semibold text-ink">产品参考图</h3>
                <p className="mt-0.5 text-[10px] leading-snug text-ink-muted">
                  保持产品形状、材质、比例与关键结构。
                </p>
                <div
                  className={`mt-2 rounded-lg border border-dashed transition ${
                    dragOverProduct
                      ? "border-accent bg-accent/5 ring-2 ring-accent/40"
                      : "border-canvas-border bg-white/80"
                  } ${busy ? "pointer-events-none opacity-60" : "cursor-pointer"}`}
                  role="button"
                  tabIndex={0}
                  aria-label="上传产品参考图"
                  onClick={() => {
                    if (busy) return;
                    if (Date.now() - lastDropProductRef.current < 600) return;
                    fileInputProductRef.current?.click();
                  }}
                  onKeyDown={(e) => {
                    if (busy) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileInputProductRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    dragDepthProductRef.current += 1;
                    setDragOverProduct(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    dragDepthProductRef.current = Math.max(0, dragDepthProductRef.current - 1);
                    if (dragDepthProductRef.current === 0) {
                      setDragOverProduct(false);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragDepthProductRef.current = 0;
                    setDragOverProduct(false);
                    lastDropProductRef.current = Date.now();
                    void onFiles(e.dataTransfer.files, "product");
                  }}
                >
                  <input
                    ref={fileInputProductRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    tabIndex={-1}
                    disabled={busy}
                    onChange={(e) => {
                      void onFiles(e.target.files, "product");
                      e.target.value = "";
                    }}
                  />
                  <div className="pointer-events-none px-2 py-6 text-center text-[10px] text-ink-muted">
                    拖拽或点击上传产品参考图
                  </div>
                </div>
                <div className="mt-2 flex gap-1">
                  <input
                    value={pasteProduct}
                    onChange={(e) => setPasteProduct(e.target.value)}
                    placeholder="图片 URL"
                    className="min-w-0 flex-1 rounded-md border border-canvas-border px-2 py-1 text-xs outline-none ring-accent focus:ring-2"
                  />
                  <button
                    type="button"
                    onClick={() => addUrl("product")}
                    className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover"
                  >
                    添加
                  </button>
                </div>
                <ul className="mt-2 max-h-40 space-y-1.5 overflow-auto">
                  {productSlots.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 rounded-md border border-canvas-border bg-white p-1.5"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                      <p className="min-w-0 flex-1 truncate text-[10px] text-ink-muted" title={s.url}>
                        {s.url}
                      </p>
                      <button
                        type="button"
                        onClick={() => removeSlot("product", s.id)}
                        className="shrink-0 text-[10px] text-ink-faint hover:text-ink"
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 图案素材图 */}
              <div className="flex min-h-0 flex-col rounded-lg border border-canvas-border bg-canvas-muted/40 p-3">
                <h3 className="text-xs font-semibold text-ink">图案素材图</h3>
                <p className="mt-0.5 text-[10px] leading-snug text-ink-muted">
                  logo、花纹、印花、包装图案或纹理；可留空只用文字描述。
                </p>
                <div
                  className={`mt-2 rounded-lg border border-dashed transition ${
                    dragOverRef
                      ? "border-accent bg-accent/5 ring-2 ring-accent/40"
                      : "border-canvas-border bg-white/80"
                  } ${busy ? "pointer-events-none opacity-60" : "cursor-pointer"}`}
                  role="button"
                  tabIndex={0}
                  aria-label="上传图案素材图"
                  onClick={() => {
                    if (busy) return;
                    if (Date.now() - lastDropRefRef.current < 600) return;
                    fileInputRefRef.current?.click();
                  }}
                  onKeyDown={(e) => {
                    if (busy) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileInputRefRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    dragDepthRefRef.current += 1;
                    setDragOverRef(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    dragDepthRefRef.current = Math.max(0, dragDepthRefRef.current - 1);
                    if (dragDepthRefRef.current === 0) {
                      setDragOverRef(false);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragDepthRefRef.current = 0;
                    setDragOverRef(false);
                    lastDropRefRef.current = Date.now();
                    void onFiles(e.dataTransfer.files, "reference");
                  }}
                >
                  <input
                    ref={fileInputRefRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    tabIndex={-1}
                    disabled={busy}
                    onChange={(e) => {
                      void onFiles(e.target.files, "reference");
                      e.target.value = "";
                    }}
                  />
                  <div className="pointer-events-none px-2 py-6 text-center text-[10px] text-ink-muted">
                    拖拽或点击上传图案素材图
                  </div>
                </div>
                <div className="mt-2 flex gap-1">
                  <input
                    value={pasteRef}
                    onChange={(e) => setPasteRef(e.target.value)}
                    placeholder="图片 URL"
                    className="min-w-0 flex-1 rounded-md border border-canvas-border px-2 py-1 text-xs outline-none ring-accent focus:ring-2"
                  />
                  <button
                    type="button"
                    onClick={() => addUrl("reference")}
                    className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover"
                  >
                    添加
                  </button>
                </div>
                <ul className="mt-2 max-h-40 space-y-1.5 overflow-auto">
                  {refSlots.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 rounded-md border border-canvas-border bg-white p-1.5"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                      <p className="min-w-0 flex-1 truncate text-[10px] text-ink-muted" title={s.url}>
                        {s.url}
                      </p>
                      <button
                        type="button"
                        onClick={() => removeSlot("reference", s.id)}
                        className="shrink-0 text-[10px] text-ink-faint hover:text-ink"
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="lg:col-span-4">
          <div className="flex h-full flex-col rounded-xl border border-canvas-border bg-white p-4 shadow-panel">
            <h2 className="text-sm font-semibold text-ink">参数</h2>
            <label className="mt-3 text-xs font-medium text-ink-muted">模型</label>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="mt-1 rounded-md border border-canvas-border px-2 py-2 text-sm outline-none ring-accent focus:ring-2"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <label className="mt-4 text-xs font-medium text-ink-muted">修改要求</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={7}
              className="mt-1 resize-y rounded-md border border-canvas-border px-2 py-2 text-sm outline-none ring-accent focus:ring-2"
              placeholder="描述希望如何改变图案、颜色、位置、风格或整体概念……"
            />
            <label className="mt-3 text-xs font-medium text-ink-muted">修改模式</label>
            <select
              value={editMode}
              onChange={(e) => setEditMode(e.target.value as EditMode)}
              className="mt-1 rounded-md border border-canvas-border px-2 py-2 text-sm outline-none ring-accent focus:ring-2"
            >
              <option value="pattern_replace">仅替换/新增表面图案</option>
              <option value="full_redesign">整体重设产品概念</option>
            </select>
            <p className="mt-1 text-[11px] leading-snug text-ink-faint">
              保守模式会尽量保持产品结构；整体重设允许改变轮廓、材质和视觉方向。
            </p>
            <label className="mt-3 text-xs font-medium text-ink-muted">生成数量</label>
            <p className="mt-0.5 text-[10px] text-ink-faint">
              将按顺序创建多个独立 Kie 任务（每张 1 次调用），最多 10。
            </p>
            <input
              type="number"
              min={1}
              max={10}
              value={imageCount}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                setImageCount(Math.min(10, Math.max(1, Math.floor(v))));
              }}
              onBlur={() =>
                setImageCount((c) => Math.min(10, Math.max(1, Math.floor(c)) || 1))
              }
              className="mt-1 w-28 rounded-md border border-canvas-border px-2 py-2 text-sm outline-none ring-accent focus:ring-2"
            />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-ink-muted">宽高比</label>
                <select
                  value={aspect}
                  onChange={(e) => setAspect(e.target.value)}
                  className="mt-1 w-full rounded-md border border-canvas-border px-2 py-2 text-sm outline-none ring-accent focus:ring-2"
                >
                  {ASPECT_OPTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-snug text-ink-faint">
                  auto 或未指定时通常仅支持 1K；1:1 不可 4K（以 Kie 文档为准）。
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-ink-muted">分辨率</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="mt-1 w-full rounded-md border border-canvas-border px-2 py-2 text-sm outline-none ring-accent focus:ring-2"
                >
                  {RES_OPTIONS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {error && (
              <p className="mt-3 rounded-md bg-red-50 px-2 py-2 text-xs text-red-700">{error}</p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void startJob()}
              className="mt-auto w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "处理中…" : "生成"}
            </button>
          </div>
        </section>

        <section className="lg:col-span-4">
          <div className="flex h-full min-h-[320px] flex-col rounded-xl border border-canvas-border bg-white p-4 shadow-panel">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">结果</h2>
              {currentResultUrls.length > 1 && (
                <button
                  type="button"
                  disabled={downloadKeys.has("current-results")}
                  onClick={() => void saveImages(currentResultUrls, "current-results")}
                  className="rounded-md border border-canvas-border bg-white px-2 py-1 text-xs font-medium text-ink hover:bg-canvas-muted disabled:opacity-50"
                >
                  {downloadKeys.has("current-results") ? "保存中…" : "全部下载"}
                </button>
              )}
            </div>
            {downloadMessage && (
              <p className="mt-2 rounded-md bg-emerald-50 px-2 py-2 text-xs text-emerald-700">
                {downloadMessage}
              </p>
            )}
            <div className="mt-3 rounded-lg border border-canvas-border bg-canvas-muted/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-ink">打印图案</h3>
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    从结果图中提取平面图案；多图案会整理成可打印排版。
                  </p>
                </div>
                <select
                  value={printFormat}
                  onChange={(e) => setPrintFormat(e.target.value as PrintFormat)}
                  className="rounded-md border border-canvas-border bg-white px-2 py-1 text-xs outline-none ring-accent focus:ring-2"
                >
                  <option value="png">PNG</option>
                  <option value="pdf">PDF</option>
                </select>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {printSourceUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={printSourceUrl}
                      alt=""
                      className="h-12 w-12 rounded-md border border-canvas-border object-cover"
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                      已选择图片
                    </span>
                  </>
                ) : (
                  <span className="text-[11px] text-ink-faint">
                    先在下方结果或历史中点“选择打印图案”，再生成可打印排版。
                  </span>
                )}
                <button
                  type="button"
                  disabled={!printSourceUrl || printBusy}
                  onClick={() => void startPrintAsset()}
                  className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {printBusy ? "提交中…" : "生成打印版"}
                </button>
                {printJob?.state === "success" && printJob.resultUrls.length > 0 && (
                  <button
                    type="button"
                    disabled={downloadKeys.has("print-asset")}
                    onClick={() =>
                      void saveImages(printJob.resultUrls, "print-asset", printFormat)
                    }
                    className="rounded-md border border-canvas-border bg-white px-2 py-1 text-xs font-medium text-ink hover:bg-canvas-muted disabled:opacity-50"
                  >
                    {downloadKeys.has("print-asset")
                      ? "保存中…"
                      : `下载 ${printFormat.toUpperCase()}`}
                  </button>
                )}
              </div>
              {printJob && (
                <div className="mt-2 flex flex-wrap items-start gap-2 text-[11px] text-ink-muted">
                  <span className="rounded bg-white px-1.5 py-0.5">{printJob.state}</span>
                  {printJob.failMsg && <span className="text-red-600">{printJob.failMsg}</span>}
                  {printJob.state === "success" &&
                    printJob.resultUrls.map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={u}
                        src={u}
                        alt=""
                        className="max-h-28 rounded-md border border-canvas-border bg-white object-contain"
                      />
                    ))}
                </div>
              )}
            </div>
            {!batchOutputs && (
              <p className="mt-4 text-sm text-ink-muted">提交任务后将在此显示状态与预览。</p>
            )}
            {batchOutputs && (
              <div className="mt-3 flex flex-1 flex-col gap-4 overflow-hidden">
                {batchOutputs.map((item, idx) => (
                  <div
                    key={item.taskId}
                    className="rounded-lg border border-canvas-border bg-canvas p-3"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-ink">第 {idx + 1} 张</span>
                      <span className="rounded-full bg-canvas-muted px-2 py-0.5 font-medium text-ink">
                        {item.state}
                      </span>
                      {item.failMsg && <span className="text-red-600">{item.failMsg}</span>}
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {item.resultUrls.length === 0 && item.state !== "success" && (
                        <p className="text-xs text-ink-muted">生成中…</p>
                      )}
                      {item.resultUrls.map((u) => {
                        const showMs = item.costTimeMs ?? item.clientElapsedMs;
                        const downloadKey = `image:${u}`;
                        return (
                          <figure
                            key={u}
                            className="flex max-w-full flex-col gap-2 rounded-md border border-canvas-border bg-white p-2"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u} alt="" className="max-h-[360px] rounded-md object-contain" />
                            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                              <span>生成耗时 {formatGenDuration(showMs)}</span>
                              <button
                                type="button"
                                disabled={downloadKeys.has(downloadKey)}
                                onClick={() => void saveImages([u], downloadKey)}
                                className="inline-flex items-center justify-center rounded-md border border-canvas-border bg-white px-2 py-1 font-medium text-ink hover:bg-canvas-muted"
                              >
                                {downloadKeys.has(downloadKey) ? "保存中…" : "一键下载"}
                              </button>
                              <button
                                type="button"
                                onClick={() => selectPrintSource(u)}
                                className="inline-flex items-center justify-center rounded-md border border-canvas-border bg-white px-2 py-1 font-medium text-ink hover:bg-canvas-muted"
                              >
                                选择打印图案
                              </button>
                            </div>
                          </figure>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">团队历史</h2>
          <button
            type="button"
            onClick={() => void loadHistory()}
            className="text-xs text-accent hover:underline"
          >
            刷新
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {historyProjects.map((project) => {
            const thumb = project.resultUrls[0];
            const imageTotal = project.resultUrls.length || project.rows.length;
            return (
              <article
                key={project.key}
                className="group flex flex-col overflow-hidden rounded-xl border border-canvas-border bg-white text-left shadow-panel transition hover:border-accent/40"
              >
                <button
                  type="button"
                  onClick={() => applyHistoryProject(project)}
                  className="flex flex-1 flex-col text-left"
                >
                  <div className="relative aspect-video bg-canvas-muted">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-ink-faint">
                        {project.state}
                      </div>
                    )}
                    <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                      {project.state}
                    </span>
                    {imageTotal > 1 && (
                      <span className="absolute right-2 top-2 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-ink">
                        共 {imageTotal} 张
                      </span>
                    )}
                  </div>
                  <div className="space-y-1 p-3 pb-2">
                    <p className="line-clamp-2 text-xs text-ink-muted">{project.prompt}</p>
                    <p className="text-[11px] text-ink-faint">
                      {new Date(project.createdAt).toLocaleString()} · {project.model}
                    </p>
                  </div>
                </button>
                {project.resultUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-3 pb-3">
                    <button
                      type="button"
                      disabled={downloadKeys.has(`history:${project.key}`)}
                      onClick={() =>
                        void saveImages(project.resultUrls, `history:${project.key}`)
                      }
                      className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                    >
                      {downloadKeys.has(`history:${project.key}`)
                        ? "保存中…"
                        : project.resultUrls.length > 1
                          ? "下载全部"
                          : "下载"}
                    </button>
                    <button
                      type="button"
                      onClick={() => selectPrintSource(project.resultUrls[0])}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      选择打印图案
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getModelById, insertGeneration } from "@/lib/db";
import {
  buildInputUrlsStorage,
  buildPatternDesignPrompt,
} from "@/lib/input-payload";
import { isAllowedInputImageUrl } from "@/lib/input-url";
import { buildKieCreateTaskBody } from "@/lib/kie/adapters";
import { kieCreateTask, kieErrorMessage } from "@/lib/kie/client";
import { getEffectiveKieApiKey } from "@/lib/settings";

export const dynamic = "force-dynamic";

const ASPECTS = new Set(["auto", "1:1", "9:16", "16:9", "4:3", "3:4"]);
const RESOLUTIONS = new Set(["1K", "2K", "4K"]);

type Body = {
  modelId?: string;
  prompt?: string;
  pattern_urls?: string[];
  image_count?: number;
  aspect_ratio?: string;
  resolution?: string;
};

function cleanUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  return urls.filter((u): u is string => typeof u === "string").map((u) => u.trim());
}

export async function POST(request: Request) {
  const apiKey = getEffectiveKieApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "未配置 Kie API Key。请在设置页保存，或设置环境变量 KIE_API_KEY。" },
      { status: 401 }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效的 JSON" }, { status: 400 });
  }

  if (!body.modelId) {
    return NextResponse.json({ error: "modelId 必填" }, { status: 400 });
  }
  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: "修改要求必填" }, { status: 400 });
  }

  const modelRow = getModelById(body.modelId);
  if (!modelRow || !modelRow.enabled) {
    return NextResponse.json({ error: "模型不可用或未找到" }, { status: 400 });
  }
  if (!modelRow.supports_pattern_images) {
    return NextResponse.json(
      { error: "当前模型未标记支持图案参考图，请到模型页切换或调整配置。" },
      { status: 400 }
    );
  }

  const patternUrls = cleanUrls(body.pattern_urls);
  if (patternUrls.length === 0) {
    return NextResponse.json({ error: "请至少添加一张设计图案参考图。" }, { status: 400 });
  }
  for (const url of patternUrls) {
    if (!isAllowedInputImageUrl(url)) {
      return NextResponse.json(
        { error: `设计图案参考图 URL 不合法：${url}` },
        { status: 400 }
      );
    }
  }
  if (patternUrls.length > modelRow.max_inputs) {
    return NextResponse.json(
      { error: `输入图最多 ${modelRow.max_inputs} 张。` },
      { status: 400 }
    );
  }

  const imageCount = Math.min(10, Math.max(1, Math.floor(body.image_count ?? 1)));
  const aspect = body.aspect_ratio ?? "1:1";
  if (!ASPECTS.has(aspect)) {
    return NextResponse.json({ error: "无效的 aspect_ratio" }, { status: 400 });
  }
  const resolution = body.resolution ?? "2K";
  if (!RESOLUTIONS.has(resolution)) {
    return NextResponse.json({ error: "无效的 resolution" }, { status: 400 });
  }

  const batchId = randomUUID();
  const inputUrlsJson = buildInputUrlsStorage(
    [],
    [],
    patternUrls,
    "pattern_replace",
    "pattern_design"
  );
  const jobs: { id: string; taskId: string }[] = [];

  for (let i = 0; i < imageCount; i++) {
    const fullPrompt = buildPatternDesignPrompt({
      userPrompt: body.prompt.trim(),
      patternCount: patternUrls.length,
      variantIndex: i,
      variantTotal: imageCount,
    });

    const kieBody = buildKieCreateTaskBody(modelRow, {
      prompt: fullPrompt,
      productUrls: [],
      patternUrls,
      referenceUrls: [],
      aspectRatio: aspect,
      resolution,
    });

    const created = await kieCreateTask(apiKey, kieBody);
    if (created.code !== 200 || !created.data?.taskId) {
      const msg = kieErrorMessage(created);
      if (jobs.length === 0) {
        return NextResponse.json(
          { error: msg, batchId, jobs: [] },
          { status: 502 }
        );
      }
      return NextResponse.json({
        error: `后续任务创建失败：${msg}`,
        batchId,
        jobs,
        partial: true,
      });
    }

    const id = randomUUID();
    const now = Date.now();
    insertGeneration({
      id,
      task_id: created.data.taskId,
      model: modelRow.id,
      prompt: body.prompt.trim(),
      aspect_ratio: aspect,
      resolution,
      input_urls: inputUrlsJson,
      state: "waiting",
      result_urls: null,
      fail_msg: null,
      fail_code: null,
      credits: null,
      created_at: now,
      updated_at: now,
      batch_id: imageCount > 1 ? batchId : null,
      batch_index: imageCount > 1 ? i : null,
      batch_size: imageCount > 1 ? imageCount : null,
    });
    jobs.push({ id, taskId: created.data.taskId });
  }

  return NextResponse.json({ batchId, jobs });
}

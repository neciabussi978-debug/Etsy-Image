import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getModelById, insertGeneration } from "@/lib/db";
import {
  buildImageEditPrompt,
  buildInputUrlsStorage,
} from "@/lib/input-payload";
import { isAllowedInputImageUrl } from "@/lib/input-url";
import { buildKieCreateTaskBody } from "@/lib/kie/adapters";
import { kieCreateTask, kieErrorMessage } from "@/lib/kie/client";
import { getEffectiveKieApiKey } from "@/lib/settings";

export const dynamic = "force-dynamic";

const ASPECTS = new Set(["auto", "1:1", "9:16", "16:9", "4:3", "3:4"]);
const RESOLUTIONS = new Set(["1K", "2K", "4K"]);

type Body = {
  source_url?: string;
  modelId?: string;
  prompt?: string;
  image_count?: number;
  aspect_ratio?: string;
  resolution?: string;
  printable_pattern?: boolean;
};

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

  const sourceUrl = body.source_url?.trim();
  if (!sourceUrl || !isAllowedInputImageUrl(sourceUrl)) {
    return NextResponse.json({ error: "请选择有效的已生成图片 URL" }, { status: 400 });
  }
  if (!body.modelId) {
    return NextResponse.json({ error: "modelId 必填" }, { status: 400 });
  }
  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: "请填写继续修改要求" }, { status: 400 });
  }

  const modelRow = getModelById(body.modelId);
  if (!modelRow || !modelRow.enabled) {
    return NextResponse.json({ error: "模型不可用或未找到" }, { status: 400 });
  }

  const imageCount = Math.min(10, Math.max(1, Math.floor(body.image_count ?? 1)));
  const aspect = body.aspect_ratio ?? "auto";
  if (!ASPECTS.has(aspect)) {
    return NextResponse.json({ error: "无效的 aspect_ratio" }, { status: 400 });
  }
  const resolution = body.resolution ?? "1K";
  if (!RESOLUTIONS.has(resolution)) {
    return NextResponse.json({ error: "无效的 resolution" }, { status: 400 });
  }

  const batchId = randomUUID();
  const inputUrlsJson = buildInputUrlsStorage(
    [sourceUrl],
    [],
    [],
    "pattern_replace",
    "image_edit"
  );
  const jobs: { id: string; taskId: string }[] = [];

  for (let i = 0; i < imageCount; i++) {
    const fullPrompt = buildImageEditPrompt({
      userPrompt: body.prompt.trim(),
      printablePattern: Boolean(body.printable_pattern),
      variantIndex: i,
      variantTotal: imageCount,
    });

    const kieBody = buildKieCreateTaskBody(modelRow, {
      prompt: fullPrompt,
      productUrls: [sourceUrl],
      patternUrls: [],
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
      prompt: `继续修改：${body.prompt.trim()}`,
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

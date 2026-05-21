import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getModelById, insertGeneration } from "@/lib/db";
import { isAllowedInputImageUrl } from "@/lib/input-url";
import { buildInputUrlsStorage } from "@/lib/input-payload";
import { buildKieCreateTaskBody } from "@/lib/kie/adapters";
import { kieCreateTask, kieErrorMessage } from "@/lib/kie/client";
import { getEffectiveKieApiKey } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Body = {
  source_url?: string;
  modelId?: string;
};

const PRINT_PROMPT = `Create a print-ready flat artwork sheet extracted from the supplied product concept image.

NON-NEGOTIABLE PROPORTION LOCK:
- Each extracted artwork must keep the same width-to-height ratio as it has on the product surface in the input image.
- Use uniform scaling only. The X scale and Y scale must be identical for every extracted design.
- Never stretch, squash, widen, narrow, compress, expand, normalize, or reshape any artwork to fit a grid cell or square canvas.
- If a design does not fill its grid cell, leave whitespace around it. Whitespace is correct; distortion is wrong.
- Flatten perspective by rectifying the surface, but after rectification preserve the artwork's original proportions, spacing, and subject scale.

Use the input image only as a reference for the decorative artwork, illustration, logo, motif, texture, or surface print. Remove the product mockup, product silhouette, perspective, shadows, background props, tags, hands, table surface, and any photography artifacts.

If the source image contains multiple distinct product patterns or motifs, extract each one as a separate printable design. For example, if there are four bookmark designs, create four separate flat artwork panels in one output image.

The final output must be a clean production layout, not a lifestyle mockup:
- Deskew and straighten every extracted design.
- Make every design perfectly front-facing, upright, and vertical.
- Do not preserve the original rotation, camera angle, or perspective tilt.
- If the printed artwork came from a planter, mug, tag, bookmark, sticker, label, or packaging face, keep the artwork's relative height, width, spacing, and subject scale while removing only the product surface and perspective.
- Arrange designs in a precise grid. For four designs, use a 2 by 2 grid.
- Keep the same orientation and even margins, but use whitespace instead of distorting individual designs to make boxes match.
- Align edges and baselines cleanly; no design should lean left or right.
- Keep every design fully visible and uncropped.

Reconstruct the designs on a clean plain white background, preserving the original subjects, colors, linework, and decorative style as faithfully as possible. Make the output suitable for direct printing or production proofing. Do not merge multiple designs into one combined illustration, and do not add extra text unless it is already part of the artwork.`;

export async function POST(request: Request) {
  const apiKey = getEffectiveKieApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "未配置 Kie API Key。请先在设置页保存。" },
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
    return NextResponse.json({ error: "请选择有效的图片 URL" }, { status: 400 });
  }

  const modelRow = body.modelId ? getModelById(body.modelId) : null;
  if (!modelRow || !modelRow.enabled) {
    return NextResponse.json({ error: "模型不可用或未找到" }, { status: 400 });
  }

  const kieBody = buildKieCreateTaskBody(modelRow, {
    prompt: PRINT_PROMPT,
    productUrls: [sourceUrl],
    patternUrls: [],
    referenceUrls: [],
    aspectRatio: "1:1",
    resolution: "2K",
  });

  const created = await kieCreateTask(apiKey, kieBody);
  if (created.code !== 200 || !created.data?.taskId) {
    return NextResponse.json({ error: kieErrorMessage(created) }, { status: 502 });
  }

  const id = randomUUID();
  const now = Date.now();
  insertGeneration({
    id,
    task_id: created.data.taskId,
    model: modelRow.id,
    prompt: "提取可打印图案版本",
    aspect_ratio: "1:1",
    resolution: "2K",
    input_urls: buildInputUrlsStorage(
      [sourceUrl],
      [],
      [],
      "pattern_replace",
      "print_asset"
    ),
    state: "waiting",
    result_urls: null,
    fail_msg: null,
    fail_code: null,
    credits: null,
    created_at: now,
    updated_at: now,
    batch_id: null,
    batch_index: null,
    batch_size: null,
  });

  return NextResponse.json({
    job: {
      id,
      taskId: created.data.taskId,
    },
  });
}

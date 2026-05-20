export type InputPayloadV2 = {
  v: 2;
  product_urls: string[];
  reference_urls: string[];
  merged_urls: string[];
};

export type EditMode = "pattern_replace" | "full_redesign";
export type Workflow =
  | "product_concept"
  | "pattern_design"
  | "print_asset"
  | "image_edit";

export type InputPayloadV3 = {
  v: 3;
  product_urls: string[];
  pattern_urls: string[];
  reference_urls: string[];
  merged_urls: string[];
  edit_mode: EditMode;
  workflow?: Workflow;
};

export function buildInputUrlsStorage(
  productUrls: string[],
  referenceUrls: string[],
  patternUrls: string[] = [],
  editMode: EditMode = "pattern_replace",
  workflow: Workflow = "product_concept"
): string {
  const merged = [...productUrls, ...patternUrls, ...referenceUrls];
  const payload: InputPayloadV3 = {
    v: 3,
    product_urls: productUrls,
    pattern_urls: patternUrls,
    reference_urls: referenceUrls,
    merged_urls: merged,
    edit_mode: editMode,
    workflow,
  };
  return JSON.stringify(payload);
}

export function parseInputPayload(raw: string): {
  product: string[];
  pattern: string[];
  reference: string[];
  merged: string[];
  editMode: EditMode;
  workflow: Workflow;
} {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === "string");
      return {
        product: arr,
        pattern: [],
        reference: [],
        merged: arr,
        editMode: "pattern_replace",
        workflow: "product_concept",
      };
    }
    if (v && typeof v === "object" && (v as InputPayloadV2).v === 2) {
      const p = v as InputPayloadV2;
      const product = Array.isArray(p.product_urls)
        ? p.product_urls.filter((x) => typeof x === "string")
        : [];
      const reference = Array.isArray(p.reference_urls)
        ? p.reference_urls.filter((x) => typeof x === "string")
        : [];
      const merged = Array.isArray(p.merged_urls)
        ? p.merged_urls.filter((x) => typeof x === "string")
        : [...product, ...reference];
      return {
        product,
        pattern: [],
        reference,
        merged,
        editMode: "pattern_replace",
        workflow: "product_concept",
      };
    }
    if (v && typeof v === "object" && (v as InputPayloadV3).v === 3) {
      const p = v as InputPayloadV3;
      const product = Array.isArray(p.product_urls)
        ? p.product_urls.filter((x) => typeof x === "string")
        : [];
      const pattern = Array.isArray(p.pattern_urls)
        ? p.pattern_urls.filter((x) => typeof x === "string")
        : [];
      const reference = Array.isArray(p.reference_urls)
        ? p.reference_urls.filter((x) => typeof x === "string")
        : [];
      const merged = Array.isArray(p.merged_urls)
        ? p.merged_urls.filter((x) => typeof x === "string")
        : [...product, ...pattern, ...reference];
      const editMode: EditMode =
        p.edit_mode === "full_redesign" ? "full_redesign" : "pattern_replace";
      const workflow: Workflow =
        p.workflow === "pattern_design" ||
        p.workflow === "print_asset" ||
        p.workflow === "image_edit"
          ? p.workflow
          : "product_concept";
      return { product, pattern, reference, merged, editMode, workflow };
    }
  } catch {
    /* fallthrough */
  }
  return {
    product: [],
    pattern: [],
    reference: [],
    merged: [],
    editMode: "pattern_replace",
    workflow: "product_concept",
  };
}

export function buildConceptPrompt(params: {
  userPrompt: string;
  productCount: number;
  patternCount: number;
  referenceCount: number;
  editMode: EditMode;
  variantIndex: number;
  variantTotal: number;
}): string {
  const {
    userPrompt,
    productCount,
    patternCount,
    referenceCount,
    editMode,
    variantIndex,
    variantTotal,
  } = params;
  const pc = Math.max(0, productCount);
  const tc = Math.max(0, patternCount);
  const rc = Math.max(0, referenceCount);
  const patternStart = pc + 1;
  const refStart = pc + tc + 1;
  const roleBlock =
    `[Image roles - order matches the model image input exactly]\n` +
    `- Images 1..${pc}: PRODUCT reference photos. Preserve the product's core form, scale, material cues, and recognizable details.\n` +
    (tc > 0
      ? `- Images ${patternStart}..${patternStart + tc - 1}: PATTERN assets. Apply these graphics, prints, logos, textures, or motifs to the product concept.\n`
      : `- No pattern asset images were provided. Follow the written pattern/change request carefully.\n`) +
    (rc > 0
      ? `- Images ${refStart}..${refStart + rc - 1}: STYLE references for mood, lighting, composition, and visual language only.\n`
      : "");

  const modeBlock =
    editMode === "full_redesign"
      ? `[Edit mode]\nFull product concept redesign is allowed. You may reinterpret silhouette, materials, and styling, but keep the user's product category and any critical product identity from the reference images.\n`
      : `[Edit mode]\nPattern replacement only. Keep the product structure, silhouette, material, proportions, and camera logic consistent; change only the requested surface graphic, print, logo, colorway, or decorative treatment.\n`;

  const placementBlock =
    editMode === "pattern_replace"
      ? `[Surface artwork placement rules]\n` +
        `- Treat each visible product face as a real printing area, not as a loose sticker.\n` +
        `- Place the artwork centered on the intended front-facing surface panel.\n` +
        `- Keep text, logos, flowers, illustrations, and baselines visually upright and level.\n` +
        `- Align the artwork with the product's top rim, bottom edge, label area, or natural horizontal axis.\n` +
        `- If the surface is curved or slightly angled, conform subtly to the product perspective while keeping the design itself straight and readable.\n` +
        `- Do not rotate, skew, slant, or randomly tilt the artwork unless the user explicitly asks for a tilted design.\n`
      : `[Surface artwork placement rules]\n` +
        `When applying any graphic or label to the redesigned product, keep the artwork intentional, readable, centered, and aligned to the product's natural front face.\n`;

  const varBlock =
    variantTotal > 1
      ? `\n[Variation]\nThis is concept ${variantIndex + 1} of ${variantTotal}. Make it meaningfully different while respecting the same product concept request.\n`
      : "";

  return `${roleBlock}\n${modeBlock}${placementBlock}${varBlock}\n[Concept change request]\n${userPrompt.trim()}`;
}

export const buildAugmentedPrompt = buildConceptPrompt;

export function buildPatternDesignPrompt(params: {
  userPrompt: string;
  patternCount: number;
  variantIndex: number;
  variantTotal: number;
  separateOutputs?: boolean;
}): string {
  const {
    userPrompt,
    patternCount,
    variantIndex,
    variantTotal,
    separateOutputs = false,
  } = params;
  const pc = Math.max(0, patternCount);
  const roleBlock =
    `[Image roles - order matches the model image input exactly]\n` +
    (pc > 0
      ? `- Images 1..${pc}: DESIGN PATTERN reference images. Use these as source artwork, motifs, composition, color direction, typography, linework, and style references.\n`
      : `- No design reference image was provided. Follow the written request carefully.\n`);

  const productionBlock =
    `[Printable pattern output]\n` +
    `Create a modified print-ready design pattern, not a product mockup or lifestyle photo.\n` +
    `- Output flat 2D artwork on a clean plain white or transparent-looking white background.\n` +
    `- Preserve the important subjects, linework, typography, colors, and decorative style from the reference unless the user asks to change them.\n` +
    `- Apply the user's requested edits directly to the design artwork.\n` +
    `- Keep all text readable, upright, and level.\n` +
    `- Keep logos, flowers, illustrations, icons, and borders centered, aligned, and evenly spaced.\n` +
    `- Remove product mockups, shadows, paper texture, perspective, hands, table surfaces, frames, watermarks, and camera artifacts.\n` +
    `- Do not place the design on cups, shirts, packaging, signs, posters in rooms, or any physical object.\n` +
    `- Make the result suitable for direct printing, cutting, sublimation, sticker production, or proofing.\n`;

  const separationBlock =
    separateOutputs && variantTotal > 1
      ? `[Separate single-design output]\n` +
        `Create exactly one standalone printable design in this image: item ${variantIndex + 1} of ${variantTotal}.\n` +
        `If the reference or request contains multiple motifs, months, names, flowers, characters, or options, do not combine them into a grid or sheet. Focus only on the ${variantIndex + 1} item and leave generous clean margins.\n`
      : "";

  const varBlock =
    variantTotal > 1
      ? `\n[Variation]\nThis is printable design ${variantIndex + 1} of ${variantTotal}. ${
          separateOutputs
            ? "It should be a separate standalone file-style artwork, not a combined sheet."
            : "Make it meaningfully different while respecting the same request."
        }\n`
      : "";

  return `${roleBlock}\n${productionBlock}${separationBlock}${varBlock}\n[Design modification request]\n${userPrompt.trim()}`;
}

export function buildImageEditPrompt(params: {
  userPrompt: string;
  printablePattern: boolean;
  separateOutputs: boolean;
  variantIndex: number;
  variantTotal: number;
}): string {
  const {
    userPrompt,
    printablePattern,
    separateOutputs,
    variantIndex,
    variantTotal,
  } = params;
  const baseBlock =
    `[Image edit source]\n` +
    `Image 1 is the current generated image to continue editing. Apply the user's requested change to this image while preserving all unrelated details, composition, subject identity, layout, and visual style.\n`;

  const outputBlock = printablePattern
    ? `[Printable pattern constraints]\n` +
      `Keep the result as flat 2D print-ready artwork. Use a clean white or transparent-looking background, keep text upright and readable, preserve crisp linework, and do not turn the design into a product mockup or lifestyle scene.\n`
    : `[Edit constraints]\n` +
      `Make only the requested modification. Do not unexpectedly change product shape, camera angle, lighting, background, text, or decorative elements that the user did not ask to change.\n`;

  const separationBlock =
    separateOutputs && variantTotal > 1
      ? `[Separate single-design output]\n` +
        `Create exactly one standalone output image: item ${variantIndex + 1} of ${variantTotal}.\n` +
        `If the source image or request contains multiple motifs, months, names, flowers, labels, panels, or options, do not combine them into one grid or sheet. Focus only on the ${variantIndex + 1} item, keep it centered, and leave clean margins.\n`
      : "";

  const varBlock =
    variantTotal > 1
      ? `\n[Variation]\nThis is edited version ${variantIndex + 1} of ${variantTotal}. ${
          separateOutputs
            ? "It should be a separate standalone image, not a combined sheet."
            : "Keep the same requested edit but provide a meaningfully distinct option."
        }\n`
      : "";

  return `${baseBlock}\n${outputBlock}${separationBlock}${varBlock}\n[Continue editing request]\n${userPrompt.trim()}`;
}

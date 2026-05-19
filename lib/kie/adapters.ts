import type { ModelRow } from "@/lib/db";
import type { CreateImageTaskInput } from "@/lib/kie/client";

export type EditMode = "pattern_replace" | "full_redesign";

export type ConceptImageInput = {
  prompt: string;
  productUrls: string[];
  patternUrls: string[];
  referenceUrls: string[];
  aspectRatio: string;
  resolution: string;
};

export function buildKieCreateTaskBody(
  model: ModelRow,
  input: ConceptImageInput
): CreateImageTaskInput {
  const merged = [
    ...input.productUrls,
    ...input.patternUrls,
    ...input.referenceUrls,
  ];

  if (model.adapter === "nano-banana-pro") {
    return {
      model: model.kie_model,
      input: {
        prompt: input.prompt,
        image_input: merged,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution,
        output_format: "png",
      },
    };
  }

  return {
    model: model.kie_model,
    input: {
      prompt: input.prompt,
      input_urls: merged,
      aspect_ratio: input.aspectRatio,
      resolution: input.resolution,
    },
  };
}

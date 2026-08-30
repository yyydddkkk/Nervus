import { Service, type Context } from "cordis";

import { KernelError } from "../kernel/error.js";
import type {
  ModelCallOptions,
  ModelRequest,
  ModelResponse,
} from "../models/model.js";

export class HistoryCompactorModule extends Service {
  constructor(ctx: Context) {
    super(ctx, "historyCompactor");
  }

  async compact(
    adapterId: string,
    request: ModelRequest,
    options: ModelCallOptions,
  ): Promise<ModelResponse> {
    const response = await this.ctx.models.generate(
      adapterId,
      request,
      options,
    );
    if (response.toolCalls.length > 0) {
      throw new KernelError(
        "COMPACTION_FAILED",
        "History Compaction returned ToolCalls",
      );
    }
    if (response.content.length === 0) {
      throw new KernelError(
        "COMPACTION_FAILED",
        "History Compaction returned an empty summary",
      );
    }
    return response;
  }
}

declare module "cordis" {
  interface Context {
    historyCompactor: HistoryCompactorModule;
  }
}

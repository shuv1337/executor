import { type ExecuteRunInput } from "@executor-v2/sdk";

import { executeRunImpl } from "./executor";

export const executeRun = (input: ExecuteRunInput) => executeRunImpl(input);

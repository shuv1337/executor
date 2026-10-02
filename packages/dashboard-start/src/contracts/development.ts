import { Schema } from "effect";

export class DevelopmentDashboardFailed extends Schema.TaggedError<DevelopmentDashboardFailed>()(
  "DevelopmentDashboardFailed",
  {
    stage: Schema.Literals(["vite"]),
  },
) {}

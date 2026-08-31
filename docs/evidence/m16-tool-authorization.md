# M16 Tool authorization performance evidence

Measured on 2026-08-31 with Node.js v22.22.1 on Linux x64 using:

```sh
pnpm bench:authorization
```

The non-blocking benchmark ran 1,000,000 synchronous decisions after 100,000 warmup calls:

| Path | Nanoseconds per call |
| --- | ---: |
| Inline allow constant | 1.51 |
| YOLO Adapter | 8.34 |
| Existing ToolsModule seam | 12,183.67 |
| ToolAuthorizationModule seam | 11,569.22 |

The YOLO Adapter returns the same frozen allow decision synchronously and does not allocate a Promise. The complete authorization Module has the same order of overhead as an existing Cordis Module call; Tool authorization adds no model-visible schema, ModelCall, Step, ToolCall, or SessionJournal append. Timing is diagnostic evidence only and is deliberately not an environment-sensitive CI threshold.

# Run same-Step ToolCalls in parallel

ToolCalls emitted by one model response are treated as independent and run concurrently with collect-all failure handling; ToolResults are presented in original call order. A model expresses a dependency by issuing the dependent ToolCall in a later Step, which avoids inventing or inferring a separate dependency graph.

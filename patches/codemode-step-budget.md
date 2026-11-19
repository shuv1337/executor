# Codemode step budget

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` adds `maxSteps` to `ExecutionLimits`: the number
of statements and expressions one program may evaluate, across all of its functions, promise jobs
and generators. Executor passes `McpLimits.maxSteps` (5,000,000 by default; self-host and local
read `EXECUTOR_MCP_MAX_STEPS`).

The interpreter runs on the product's own thread, about a thousand times slower than native code.
Its only budgets were wall time (`timeoutMs`, five minutes) and tool calls. On Nov 18 2026 one
production program spent about 203 s in the interpreter with no tool calls, inside its five
minutes, and the product isolate stayed near 100% CPU throughout. Effect preempts the program's
fiber every 2,048 operations, so other requests still ran, but slowly, and clients gave up.

`StepBudget` (`interpreter/model.js`) is shared by every `Interpreter` of one execution, as
`invokeFunction` creates one per call. `evaluateStatement` and `evaluateExpression` count one step
each before they dispatch. A tool call, an approval or a timer evaluates nothing while it waits,
so only interpreter work counts. Steps, not CPU time: workerd's clock does not advance while code
runs, and a count gives the same answer on every host and under any load.

Past the limit, every step throws `StepBudgetExceeded`, an `InterpreterRuntimeError` of kind
`TimeoutExceeded` whose message names the budget and asks for heavy computation to move out of
the program. `try` hands it on without running `catch`, and because each later step throws again,
a `catch`, `finally` or promise reaction cannot keep the program running. Execute reports it with
the line it stopped at, and keeps that message instead of its wall-time timeout message.

Counting adds no measurable time: a 300,000-iteration loop took a median of 1,356-1,372 ms patched
against 1,331-1,363 ms unpatched in Node (7 runs each).

The default comes from the incident. Measured on one host, the interpreter runs about 550,000
steps a second in workerd (the runtime of the self-host image and Cloud), about 2 million in Node
and about 0.9 million in the Bun self-host e2e server. Ordinary programs spend 0.1-0.5 s before
their first tool call; the runaway spent 203 s, about 110 million steps in workerd. 5,000,000 steps
is about 9 s in workerd, near the geometric middle: 18 times the slowest ordinary program and 22
times less than the runaway. Counted programs: a 100,000-iteration `for` loop is 800,000 steps,
filtering and mapping 10,000 records 177,000, the `mcp-execute-concurrency` reporter program
about 400,000 and its 1,001 x 300 loop reference about 1.5 million.

A step can still call a native method that does much more work, such as `split` on a large
string. Those run at native speed, so they are not where the time went; weighting them is not
done.

Remove the hunks when a codemode release has a step or CPU budget.

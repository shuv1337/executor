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

## Native calls

A native method can do far more work than the step that calls it: `s.split("")` on a 1 MB string
is one step, but returns a million-element array that codemode then copies. Before native calls
were charged, a loop of them ran 83 s inside a 5,000,000-step budget. `invokeCallable` is the
one place every call goes through, so it charges there. Calls that run program code or wait on the
host (tools, program functions, promise and generator methods, `tools.search`) count their own
steps and are not charged. Every other call is charged with `StepBudget.charge`:

- before it runs, for its input: the receiver of a method and the string arguments of a method;
  every argument of a global function (`JSON`, `Object`, `Array`, `Math` and the like). This stops
  a call whose input is already too large before it starts.
- after it returns, for its result.
- spread arguments, array spread and object spread, and the arguments and result of `new`, at the
  same rate.

Data costs one step per 2 array elements, object keys or `Map` and `Set` entries, and one per 256
string characters. An array of records or arrays counts each element as wide as its first one, up
to 32, because copying a result walks every field. Other values (numbers, functions, class
instances) cost nothing. Two kinds of method are charged less, so loops that call them stay
linear: methods whose work is bounded by their result (`slice`, `substring`, `at`, `push`, `pop`,
`concat` and similar) charge only their result, and `indexOf`, `includes` and `lastIndexOf` charge
one step per 4,096 elements or characters they can scan from their start position. A method that
returns its own receiver, such as `Map.set`, is not charged again for it.

One native call still runs to its end before its result is charged; codemode cannot interrupt it.
Its input is charged before it runs, so the largest single call a program can make is bounded by
data it already paid to build, and the next step after an overrun stops the program.

Charging adds about 4% to a loop that makes three native calls per iteration (100,000 iterations of
`Math.max`, `slice` and `push`: medians of 2,083-2,098 ms against 2,003-2,004 ms without native
charging, Node 24, 7 runs each).

The rates were measured with each workload looped under the default 5,000,000-step budget until it
stopped (CPU seconds in Node 24 and Bun; wall seconds of one request in workerd, where it was the
only work):

| Workload                            | Node s | Bun s | workerd s |
| ----------------------------------- | -----: | ----: | --------: |
| pure interpreter loop               |   2.35 |  1.02 |      8.52 |
| `split("")` of 1 MB (review PoC)    |   2.05 |  3.83 |      1.07 |
| `JSON.stringify` 20k records + scan |   4.87 |  1.24 |      2.79 |
| `JSON.parse` of 1.3 MB              |   3.73 |  1.34 |      1.53 |
| `join` of 1M elements               |   1.89 |  3.17 |      0.87 |
| `Object.keys` of 100k keys          |   3.15 |  2.27 |      2.89 |
| spread of 1M elements               |   0.77 |  0.82 |      4.93 |
| `replaceAll` on 1 MB                |   5.40 |  3.62 |      9.43 |

Native costs differ by engine, so no one rate matches all three, but every workload stops within
about 10 s on each runtime. In workerd, where the budget is about 9 s of interpreted work, each
native-heavy loop stops at or before the interpreted one. Ordinary programs fit: filtering and
mapping 20,000 records needs under 2,000,000 steps, grouping 50,000 records under 5,000,000, and a
comparator `sort` of 50,000 objects passes. A comparator `sort` of 100,000 objects needs about
20,000,000 steps, as every comparison is interpreted, so the default stops it; self-host and local
raise the budget with `EXECUTOR_MCP_MAX_STEPS`.

Remove the hunks when a codemode release has a step or CPU budget.

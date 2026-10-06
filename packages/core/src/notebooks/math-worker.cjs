// Evaluates expressions in a restricted mathjs instance (mathjs.org/docs/expressions/security,
// checked 2026-10-06). Plain CommonJS on purpose: a .ts worker loads mathjs through the ESM
// loader in about 10 s on Windows, this file in about 0.5 s. The parent kills the worker if one
// expression runs past 1 s. simplify and derivative stay available (the spec needs them);
// `parse` and `resolve` stay too, since they use them internally; all are bounded by the same 1 s
// limit. The functions the mathjs docs call critical (import, createUnit, reviver) are disabled.
// Everything that could reach outside the sandbox or re-enter `evaluate` is disabled.
const { parentPort } = require("node:worker_threads");
const { all, create } = require("mathjs");

const math = create(all);
const evaluate = math.evaluate;
const disabled = (name) => () => {
  throw new Error(`${name} is disabled`);
};
math.import(
  {
    import: disabled("import"),
    createUnit: disabled("createUnit"),
    reviver: disabled("reviver"),
    evaluate: disabled("evaluate"),
  },
  { override: true },
);

parentPort.on("message", ({ n, expr }) => {
  try {
    const value = evaluate(expr);
    const text = typeof value === "function" ? null : math.format(value, { precision: 12 });
    parentPort.postMessage(
      text === null
        ? { n, error: "the expression is a function, not a value" }
        : { n, value: text },
    );
  } catch (err) {
    parentPort.postMessage({ n, error: err instanceof Error ? err.message : String(err) });
  }
});
parentPort.postMessage({ ready: true });

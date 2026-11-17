import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { datasetTasks, importDataset, listDatasets, previewDataset, readDataset } from "../../src/eval/datasets.ts";
import { encodeCsv, parseCsv } from "../../src/eval/csv.ts";
import { compareEvalTrials, exportEvalRun, listEvalRuns, readEvalRun } from "../../src/eval/view.ts";
import { saveRun } from "../../src/eval/store.ts";
import { runEval } from "../../src/eval/runner.ts";
import { loadTasks } from "../../src/eval/tasks.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { saveEvalExport } from "../../desktop/main/eval-export.ts";
import { CLI } from "../e2e/helpers.ts";

test("CSV and JSONL datasets stay inert, validate boundaries, retain quoted data and bind confirmation to content and mapping", () => {
  const env = tmpEnv(), source = join(env.root, "dataset.csv");
  try {
    writeFileSync(source, 'prompt,expectedOutput,rubric,grader\r\n"A quoted, \"\"input\"\"\nline",expected,Concrete answer,never-run\r\n');
    const preview = previewDataset(source, "csv"); expect(preview.rows[0]?.prompt).toBe('A quoted, "input"\nline'); expect(preview.discarded).toEqual(["grader"]); expect(listDatasets()).toEqual([]);
    expect(() => importDataset({ source, format: "csv", name: "Example", previewHash: preview.previewHash, confirmed: false })).toThrow("Confirm");
    const dataset = importDataset({ source, format: "csv", name: "Example", previewHash: preview.previewHash, confirmed: true }); expect(readDataset(dataset.id).rows).toEqual(preview.rows); expect(listDatasets()[0]?.count).toBe(1);
    const tasks = datasetTasks(dataset.id); try { expect(tasks.tasks[0]?.grader).toBe(""); expect(tasks.tasks[0]?.expectedOutput).toBe("expected"); expect(existsSync(join(tasks.tasks[0]!.fixtureDir, "README.md"))).toBe(true); } finally { tasks.cleanup(); }
    expect(() => importDataset({ source, format: "csv", columns: { prompt: "expectedOutput" }, name: "Changed mapping", previewHash: preview.previewHash, confirmed: true })).toThrow("mapping changed");
    writeFileSync(source, "prompt\nchanged\n"); expect(() => importDataset({ source, format: "csv", name: "Changed", previewHash: preview.previewHash, confirmed: true })).toThrow("changed");
    const jsonl = join(env.root, "dataset.jsonl"); writeFileSync(jsonl, JSON.stringify({ id: "one", prompt: "Input", expectedOutput: "Output", command: "never-run" }) + "\n"); expect(previewDataset(jsonl, "jsonl").discarded).toEqual(["command"]);
    writeFileSync(jsonl, '{"prompt":"x","id":"dup"}\n{"prompt":"y","id":"dup"}\n'); expect(() => previewDataset(jsonl, "jsonl")).toThrow("unique id");
    expect(() => parseCsv('prompt\n"unterminated')).toThrow("quote"); expect(() => parseCsv('prompt\n"x"tail')).toThrow("quoting");
    const link = join(env.root, "linked.csv"); symlinkSync(source, link, "file"); expect(() => previewDataset(link, "csv")).toThrow(); expect(() => readDataset("../escape")).toThrow("Invalid dataset");
    writeFileSync(source, 'Input,Expected Output\nquestion,answer\n'); expect(() => previewDataset(source, "stax")).toThrow("explicitly"); const mapped = previewDataset(source, "stax", { prompt: "Input", expectedOutput: "Expected Output" }); expect(mapped.rows[0]).toMatchObject({ prompt: "question", expectedOutput: "answer" }); expect(mapped.staxVerified).toBe(false); expect(mapped.warning).toContain("unverified");
  } finally { env.cleanup(); }
});

test("real trial keeps its redacted transcript, selected rubric judge, separate check and history/export evidence", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Read", input: { path: "greet.js" } }] },
    { toolCalls: [{ name: "Edit", input: { path: "greet.js", old_text: '"Helo, "', new_text: '"Hello, "' } }] },
    { text: "Fixed the greeting. private-fixture-key" },
    { text: '{"score":0.9,"reason":"The patch satisfies the rubric."}' },
  ]);
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: ["Candidate", "Judge"].map((displayName) => ({ model: "fixture", displayName, provider: "anthropic", baseUrl: fake.url, apiKey: "private-fixture-key" })) });
    const task = { ...loadTasks(undefined, ["fix-greeting-typo"])[0]!, rubric: "Greeting must use the correctly spelled salutation." };
    const run = await runEval({ config: { models: [{ id: "custom:Candidate-0" }], judgeModel: "custom:Judge-1", autonomy: "low" }, tasks: [task], buildId: "viewer-one" });
    expect(run.results[0]).toMatchObject({ passed: true, checkPassed: true, judge: { score: .9, status: "complete", model: "custom:Judge-1", costUsd: null } });
    expect(run.results[0]?.transcript?.messages.some((m) => m.text.includes("Hello, "))).toBe(true); expect(run.results[0]?.output).not.toContain("private-fixture-key"); expect(run.results[0]?.output).toContain("redacted");
    expect(JSON.stringify(fake.requests[3])).toContain("Helo"); expect(JSON.stringify(fake.requests[3])).toContain("Greeting must"); expect(fake.requests[3].tools).toBeUndefined();
    const file = saveRun(run); expect(existsSync(file)).toBe(true); const second = { ...run, buildId: "viewer-two", results: run.results.map((r) => ({ ...r, model: "second-profile", output: "Second output" })) }; saveRun(second);
    const history = listEvalRuns(); expect(history.runs).toHaveLength(2); const one = history.runs.find((r) => r.buildId === "viewer-one")!, two = history.runs.find((r) => r.buildId === "viewer-two")!;
    expect(readEvalRun(one.id).run.results[0]?.judge?.score).toBe(.9); expect(compareEvalTrials(one.id, 0, two.id, 0)).toMatchObject({ task: "fix-greeting-typo", right: { output: "Second output" } });
    expect(() => readEvalRun("../escape")).toThrow("Invalid"); expect(() => compareEvalTrials(one.id, -1, two.id, 0)).toThrow("valid trial");
    const csv = exportEvalRun(one.id, "csv").content, jsonl = exportEvalRun(one.id, "jsonl").content; expect(parseCsv(csv)[1]?.[2]).toBe("fix-greeting-typo"); expect(JSON.parse(jsonl.trim()).judge.score).toBe(.9); expect(csv + jsonl).not.toContain("private-fixture-key");
    const saved = join(env.root, "results.csv"); expect(await saveEvalExport("csv", csv, async () => null)).toBeNull(); expect(existsSync(saved)).toBe(false); expect(await saveEvalExport("csv", csv, async () => saved)).toBe(saved); expect(readFileSync(saved, "utf8")).toBe(csv);
    const formula = parseCsv(csv); formula[1]![20] = "=formula"; const unsafe = encodeCsv(formula).replace("'=formula", "=formula"); await saveEvalExport("csv", unsafe, async () => saved); expect(readFileSync(saved, "utf8")).toContain("'=formula");
    let rejected = false; try { await saveEvalExport("jsonl", '{"schema":1}', async () => saved); } catch { rejected = true; } expect(rejected).toBe(true);
    writeFileSync(file, JSON.stringify({ ...run, results: [{ ...run.results[0], output: { invalid: true } }] }));
    expect(listEvalRuns().runs).toHaveLength(1); expect(listEvalRuns().warnings.join(" ")).toContain("invalid");
    writeFileSync(file, JSON.stringify({ ...run, results: [{ ...run.results[0], transcript: { messages: [] } }] }));
    expect(listEvalRuns().runs).toHaveLength(1);
  } finally { fake.stop(); env.cleanup(); }
}, 20_000);

test("rubrics refuse implicit judges before execution and preserve malformed judge outcomes as errors", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "answer" }, { text: "unparseable score" }]);
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ model: "fixture", displayName: "Fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }] });
    const source = join(env.root, "tasks.jsonl"); writeFileSync(source, JSON.stringify({ prompt: "Answer briefly", expectedOutput: "answer", rubric: "Must be correct" }) + "\n"); const p = previewDataset(source, "jsonl"), d = importDataset({ source, format: "jsonl", name: "Judge fixture", previewHash: p.previewHash, confirmed: true }), tasks = datasetTasks(d.id);
    try {
      const config = { models: [{ id: "custom:Fixture-0" }], autonomy: "low" as const };
      const error = await runEval({ config, tasks: tasks.tasks, buildId: "refuse" }).then(() => null, (e) => e); expect(error.message).toContain("judgeModel"); expect(fake.requests.length).toBe(0);
      const run = await runEval({ config: { ...config, judgeModel: "custom:Fixture-0" }, tasks: tasks.tasks, buildId: "malformed" }); expect(run.results[0]).toMatchObject({ passed: false, checkPassed: true, failKind: "judge", judge: { score: null, status: "error" } });
    } finally { tasks.cleanup(); }
  } finally { fake.stop(); env.cleanup(); }
});

test("the real dataset CLI previews, confirms, lists and runs inert imported rows", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "expected" }]);
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ model: "fixture", displayName: "Fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }] });
    const source = join(env.root, "dataset.jsonl"); writeFileSync(source, JSON.stringify({ prompt: "Return expected", expectedOutput: "expected" }) + "\n");
    const cli = async (args: string[]) => { const p = Bun.spawn([process.execPath, CLI, "eval", ...args], { cwd: env.root, env: { ...process.env, RIGWELL_HOME: env.rigwellHome }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code !== 0) throw new Error(err); return out; };
    const preview = JSON.parse(await cli(["import", "--source", source, "--format", "jsonl"])); const saved = JSON.parse(await cli(["import", "--source", source, "--format", "jsonl", "--confirm", preview.previewHash, "--name", "CLI fixture"]));
    const listed = JSON.parse(await cli(["datasets"])); expect(listed).toHaveLength(1); expect(listed[0].id).toBe(saved.id); expect(readDataset(saved.id).name).toBe("CLI fixture"); expect(fake.requests.length).toBe(0);
    await cli(["run", "--dataset", saved.id, "--model", "custom:Fixture-0", "--build", "dataset-cli"]); const history = JSON.parse(await cli(["history"])); expect(history.runs[0].passed).toBe(1);
    const out = await cli(["export", "--run", history.runs[0].id, "--format", "jsonl"]); expect(JSON.parse(out.trim()).output).toBe("expected"); expect(fake.requests.length).toBe(1);
  } finally { fake.stop(); env.cleanup(); }
}, 20_000);

// Tools that talk to the session itself: TaskOutput, TaskStop (background jobs), TodoWrite, AskUser, StructuredOutput.
import type { AskQuestion, Tool, TodoItem } from "../core/types.ts";
import { fail, intArg, strArg } from "./util.ts";

function jobIdOf(input: Record<string, unknown>): string {
  return strArg(input, "task_id") ?? strArg(input, "job_id") ?? "";
}

const knownJobs = (list: { id: string }[]) => list.map((j) => j.id).join(", ") || "none";

export function createTaskOutputTool(): Tool {
  return {
    name: "TaskOutput",
    description:
      "Collects the result of a background job: a subagent started with Task (background: true), a command started with Execute (background: true), or a background Script.\n" +
      "- task_id: the job id the start call returned.\n" +
      "- block: wait for the job to finish (default true), up to timeoutMs (default 30000, at most 300000). With block false it returns the status and output so far at once.\n" +
      "A finished job's result is delivered once to you; asking again returns it again. Use TaskStop to cancel a job.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Job id." },
        block: { type: "boolean", default: true },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    category: "other",
    async run(input, ctx) {
      const jobs = ctx.session?.jobs;
      if (!jobs) return fail("Background jobs are not available here.");
      const id = jobIdOf(input);
      const job = jobs.get(id);
      if (!job) return fail(`No job with id "${id}". Known jobs: ${knownJobs(jobs.list())}.`);
      if (job.status === "running" && input.block !== false) {
        await jobs.wait(id, Math.min(300_000, Math.max(1, intArg(input, "timeoutMs") ?? 30_000)), ctx.signal);
      }
      if (job.status !== "running") job.reported = true;
      return { content: JSON.stringify(job.report()), data: job.report() };
    },
  };
}

export function createTaskStopTool(): Tool {
  return {
    name: "TaskStop",
    description:
      "Stops a running background job (subagent, background command or background Script) and returns what it had produced.\n" +
      "- task_id: the job id the start call returned. Effects the job already had stay.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "Job id." } },
      required: ["task_id"],
      additionalProperties: false,
    },
    category: "other",
    async run(input, ctx) {
      const jobs = ctx.session?.jobs;
      if (!jobs) return fail("Background jobs are not available here.");
      const id = jobIdOf(input);
      const job = jobs.get(id);
      if (!job) return fail(`No job with id "${id}". Known jobs: ${knownJobs(jobs.list())}.`);
      if (job.status === "running") {
        job.stop();
        await Promise.race([job.done, new Promise((r) => setTimeout(r, 10_000))]);
      }
      job.reported = true;
      return { content: JSON.stringify(job.report()), data: job.report() };
    },
  };
}

const STATUSES = ["pending", "in_progress", "completed"] as const;

export function renderTodoList(todos: TodoItem[]): string {
  return todos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
}

export function createTodoWriteTool(): Tool {
  return {
    name: "TodoWrite",
    description:
      "Keeps your task list for this session. Use it for work with three or more steps, and skip it for small jobs.\n" +
      "- todos: the whole list every time (it replaces the previous list). Each item has content, status (pending, in_progress, completed) and optionally priority (low, medium, high) and id.\n" +
      "Keep one item in_progress at a time. Mark an item completed as soon as it is done, and finish or remove open items before you end your turn.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: [...STATUSES] },
              priority: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    category: "other",
    async run(input, ctx) {
      if (!ctx.session) return fail("The todo list is not available here.");
      if (!Array.isArray(input.todos)) return fail("todos must be a list.");
      const todos: TodoItem[] = [];
      for (const [i, raw] of (input.todos as unknown[]).entries()) {
        const t = raw as Record<string, unknown>;
        if (!t || typeof t.content !== "string" || !t.content.trim()) return fail(`todos[${i}].content is required.`);
        if (!STATUSES.includes(t.status as never)) return fail(`todos[${i}].status must be pending, in_progress or completed.`);
        todos.push({
          id: typeof t.id === "string" && t.id ? t.id : String(i + 1), content: t.content.trim(), status: t.status as TodoItem["status"],
          ...(t.priority === "low" || t.priority === "medium" || t.priority === "high" ? { priority: t.priority } : {}),
        });
      }
      await ctx.session.todos.set(todos);
      const open = todos.filter((t) => t.status !== "completed").length;
      return { content: `Todo list updated (${todos.length} items, ${open} open).\n${renderTodoList(todos)}`, data: { todos } };
    },
  };
}

export function createAskUserTool(): Tool {
  return {
    name: "AskUser",
    description:
      "Asks the user one to four multiple-choice questions and waits for the answers. Use it when you need a decision that you cannot make from the code or the request.\n" +
      "- questions: each has topic (a short label), question, options (two or more short choices) and optionally multiSelect. The user can also type their own answer.\n" +
      "If the user dismisses the questions, carry on with your best assumption and say so.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array", minItems: 1, maxItems: 4,
          items: {
            type: "object",
            properties: {
              topic: { type: "string" }, question: { type: "string" },
              options: { type: "array", items: { type: "string" }, minItems: 2 },
              multiSelect: { type: "boolean" },
            },
            required: ["topic", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    category: "other",
    async run(input, ctx) {
      if (!ctx.session) return fail("AskUser is not available here.");
      if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return fail("questions must hold one to four questions.");
      const questions: AskQuestion[] = [];
      for (const [i, raw] of (input.questions as unknown[]).entries()) {
        const q = raw as Record<string, unknown>;
        if (!q || typeof q.question !== "string" || !q.question.trim()) return fail(`questions[${i}].question is required.`);
        const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [];
        questions.push({
          index: i + 1, topic: typeof q.topic === "string" && q.topic ? q.topic : `Question ${i + 1}`, question: q.question, options,
          ...(q.multiSelect === true ? { multiSelect: true } : {}),
        });
      }
      const r = await ctx.session.askUser({ questions }, ctx.toolUseId ?? "");
      if (r.cancelled || !r.answers.length) {
        return { content: "The user did not answer (the questions were dismissed or no one could be asked). Continue with your best assumption and say what you assumed.", data: { cancelled: true, answers: [] } };
      }
      return { content: `The user answered:\n${r.answers.map((a) => `${a.index}. ${a.question}\n   ${a.answer}`).join("\n")}`, data: r };
    },
  };
}

/** The tool a session offers when a structured answer is required; its input schema is the caller's schema. */
export function createStructuredOutputTool(schema: Record<string, unknown>): Tool {
  return {
    name: "StructuredOutput",
    description:
      "Gives your final answer in the structured form the caller asked for. Call it once, when your work is done, with the answer as the arguments. " +
      "If the arguments do not fit the schema you get the problems back; fix them and call again. Do not write the answer as plain text instead.",
    inputSchema: schema,
    category: "other",
    async run(input, ctx) {
      if (!ctx.session) return fail("StructuredOutput is not available here.");
      const r = ctx.session.setStructured(input);
      if (!r.ok) return fail(r.error);
      return { content: "Structured answer recorded. Your turn can end now.", data: input };
    },
  };
}

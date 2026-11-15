# Stax and Rigwell evaluations: source comparison

Inspected 2026-11-15 at the owner's request. Rigwell source: `750c41c8d4719a8bf51963641c32e1a3de7fa4e2`. Stax source: `4faa444b0672464eea21b82280b26e226a67a165`, cloned read-only to `../stax-reference-review`. No Stax dependencies were installed, no Stax service was started, and no model calls were made for this comparison. The existing Rigwell quality run continued independently. This is a source comparison, not a Stax runtime qualification or approval to expand Rigwell's scope.

## Finding

Rigwell implements a smaller custom evaluation subsystem, built on its existing coding-agent eval runner. It overlaps functionality already present in open-source Stax. The recorded implementation decision did not evaluate adopting Stax. There is no evidence supporting a claim that the custom implementation was the best reuse, cost or usability choice.

Stax has substantially broader evaluation authoring and analysis features. Rigwell's implementation is useful for inspecting and grading its coding-agent trials, but does not reproduce Stax's complete workflow. The Stax-labeled import option is explicitly mapped CSV conversion, not complete Stax project or evaluation import.

## Capability comparison

| Capability | Stax source | Rigwell source |
| --- | --- | --- |
| Start experiments in the UI | Project playground, system instructions, model selection, multi-message inputs, variables, output generation and bulk inference controls. | Evaluations page inspects saved trials and imports datasets. It instructs users to launch trials through `rigwell eval run`; it has no trial-launch form. |
| Dataset authoring | Dataset controller and pages expose creation, row updates/deletion and chat-based data. | Import, preview, list and read. Five canonical row fields: id, prompt, expectedOutput, output and rubric. No dataset row editor in the inspected Evaluations page. |
| Reusable model judges | Evaluator gallery and backend support named evaluators, prompt variables, output categories, score mappings and model configuration. | A task rubric plus an explicitly selected judge profile. The judge returns a numeric score and explanation; a score of at least 0.7 passes. No equivalent evaluator gallery. |
| Pairwise judging | Separate pairwise evaluator model, controller and editing UI. | Two saved outputs can be displayed side by side for the same task. This display does not perform pairwise judging or record a preference. |
| Human assessment | Human evaluator definitions, feedback/score endpoints and editable side-by-side ratings and notes. | Displays retained command and judge outcomes. No corresponding human-rating workflow in the inspected eval schema/page. |
| Deterministic checks | Managed heuristic evaluators include text/regex criteria. | Coding-task shell graders and imported-data exact trimmed expected-output checks. Coding graders can run repository tests. There is no equivalent managed heuristic gallery. |
| Analysis | Project metrics, evaluator score/rate charts, inference charts, filters and tags. | History pass-rate meters, run table, trial metrics, output/transcript drill-down; report engine adds regressions, failure clusters and variant comparisons. UI analysis is substantially simpler. |
| Import/export fidelity | Export DTO includes system instruction, input, expected output, output, tags, turns, human ratings/notes, inference analytics, evaluator scores, variables and chat history. | CSV/JSONL result exports and five-field dataset import. Explicitly unmapped fields are discarded and reported. Rich Stax context and evaluations are not preserved. |
| Background execution | Bulk inference/evaluation APIs and job-status/stop controls. | Eval CLI controls trial execution and budgets. The Evaluations page does not expose an equivalent evaluation job queue. |
| Coding-agent acceptance | Inspected Stax inference/evaluation paths generate and score model conversations. A replacement for Rigwell's repository-task executor was not established. | Fresh repository fixtures, real agent sessions, shell graders, task budgets, repeated trials and external-harness comparison are implemented. These remain necessary for Rigwell's coding acceptance. |

The missing Stax features above are comparison findings. They are not automatically added requirements. The approved specification section 20.19 asks for history, transcripts, same-task comparisons, rubric judges and dataset import/export; it does not specify complete Stax application parity.

## Export compatibility finding

Stax's `ChatExportDTO` names fields including `input`, `expected_output`, `system_instruction`, `chat`, `variables` and `llm_evaluations`. Its CSV utility serializes object-valued cells as JSON text. Rigwell can explicitly map flat CSV columns such as input and expected output, but its dataset schema cannot represent the complete exported record. Stax's exported system instructions and conversation history would be discarded, not replayed. A JSON-array project export is not the current Stax import path, which parses CSV.

The source was available for investigating this structure without an owner-supplied export. A real export would still be useful for end-to-end compatibility evidence. The owner explicitly waived that real-file verification on 2026-11-15; the waiver is not evidence of compatibility.

## Information to know about Stax

Owner-provided information, recorded 2026-11-15 for the next-version evaluation:

- **Hosted platform access:** Google Stax is free to use during beta, with no current platform subscription fees or paid tiers. Access uses a standard Google account. [Official hosted landing page](https://stax.withgoogle.com/landing), [additional overview supplied by the owner](https://aitools.flocci.in/tool/google-stax).
- **Bring your own key:** Free platform access does not include unrestricted model inference. Stax uses the user's API keys; the model providers bill for tokens used to generate outputs and run automated model judges. Provider charges are separate from Stax platform access.
- **Free API options:** A free-tier Google AI Studio Gemini API key can provide generation and evaluation within the applicable free rate limits. Availability and limits belong to the provider; this is not a promise of unlimited free evaluation.
- **Future pricing:** Google's landing page says Stax is free during beta and may introduce pricing in the future. The current free platform offering should not be assumed permanent.

These notes do not select API keys, authorize paid runs or change Rigwell's existing subscription settings. The owner deferred hosted Stax evaluation to the next version; see [NV-001](next-version.md#nv-001-optional-hosted-stax-workflow).

## Open-source reuse assessment

Stax is Apache-2.0 licensed. Its repository contains a Next.js frontend and Java/Spring Boot backend. The documented local setup adds Java, Maven, MySQL and a Pub/Sub emulator; the hosted setup provisions GCP resources. Rigwell currently ships Bun/TypeScript and Electron with local file stores and its own model adapters, including signed-in subscription clients.

Stax provides existing implementations worth evaluating before duplicating evaluation authoring, evaluator management, human assessment or richer analytics. Adopting the complete application would require integrating its storage, jobs, authentication and model execution with Rigwell, plus packaging the additional services. That work has not been tested or estimated. Source availability alone does not establish that dropping the complete app into Rigwell would preserve local deployment or subscription execution.

Recommendation: preserve the working coding-task executor and current acceptance receipts. If the owner chooses richer evaluation functionality, evaluate reuse from Stax against those particular outcomes before extending the custom subsystem. Do not silently turn the comparison into a full-platform rewrite or a new release gate.

## Inspected sources

- Rigwell: `desktop/renderer/components/Evaluations.tsx`; `src/eval/{datasets,judge,view,runner,comparison,report,types,cli}.ts`; `test/eval/datasets-view.test.ts`; spec section 20.19; decision 458.
- [Stax README and license](https://github.com/google-labs-code/stax/tree/4faa444b0672464eea21b82280b26e226a67a165).
- [Stax dataset controller](https://github.com/google-labs-code/stax/blob/4faa444b0672464eea21b82280b26e226a67a165/server/src/main/java/com/planck/planck/domain/dataset/DataSetController.java).
- [Stax evaluator implementation tree](https://github.com/google-labs-code/stax/tree/4faa444b0672464eea21b82280b26e226a67a165/server/src/main/java/com/planck/planck/domain/evaluator).
- [Stax export DTO](https://github.com/google-labs-code/stax/blob/4faa444b0672464eea21b82280b26e226a67a165/server/src/main/java/com/planck/planck/domain/importexport/dto/ChatExportDTO.java) and [CSV exporter](https://github.com/google-labs-code/stax/blob/4faa444b0672464eea21b82280b26e226a67a165/frontend/utils/jsonToCsvExport.ts).
- Frontend source: project playground, Evaluator Gallery editing page, analytics evaluation/inference chart components and human side-by-side table columns. Backend source: inference, dataset evaluation, evaluator and job-status controllers, evaluator entity and chat export service.

The Stax service traces include actual contains/regex scoring and provider-strategy calls, beyond controller declarations. They also contain unfinished branches: the generic human-evaluator creation path leaves RANGE option assignment commented out under a TODO. This is not evidence that all human-rating paths fail; separate category/thumbs and range endpoints exist. It is a concrete reason to qualify runtime coverage rather than call every open-source feature production-ready from inspection alone.

Google's hosted product landing page and documentation were read. The signed-in hosted application was not used or tested; hosted/open-source feature equivalence is not established by this comparison.

No claim is made here that every Stax source path works when deployed. No Stax live tests, performance comparisons or migration tests were run.

# Local Evaluations

Open Evaluations from the desktop sidebar or palette. It reads the existing
`$RIGWELL_HOME/eval/runs` store: pass-rate history, trial metrics, separate check
and rubric outcomes, retained assistant output and redacted public transcripts.
Select a left trial, open another run and select a right trial to compare outputs
for the same task. Viewing does not run a model, grader or imported command.
Historical runs remain readable; missing evidence is labeled unavailable.

## Run and judge

The existing task folders and check commands continue to work:

```powershell
rigwell eval run --task fix-greeting-typo --model <profile>
rigwell eval run --config <private-config.json> --judge-model <judge-profile>
rigwell eval history
rigwell eval export --run <history-id> --format jsonl --out <results.jsonl>
```

A task's `task.json` may add a `rubric` string beside its normal grader. Choose
`judgeModel` in the private eval config or pass `--judge-model`. Rubric tasks
refuse to start without that explicit choice, including head-to-head comparisons.
The judge receives the rubric, prompt, final output and tracked Git diff through
the selected profile's existing adapter, with no Rigwell tools, read-only native
execution and a text-only synthesis request. Native clients retain their own
read-only behavior; this does not claim an independent OS sandbox on Windows.
Evidence is untrusted text, redacted and capped per field with a truncation marker.
The judge has a two-minute request cap and no retries or profile fallback.

A valid score is between zero and one; 0.7 or higher passes the rubric. A failed
command still fails overall. Invalid judge JSON or a provider failure records an
error with an unknown score, never an invented success. Candidate time, tokens and
estimated cost exclude the separately reported judge. Judge cost is unknown unless
that profile has explicit prices in the eval config's model list. Subscription
access is not represented as a measured cash charge.

## Datasets

Import CSV or JSONL from the page, or use a preview followed by its confirmation:

```powershell
rigwell eval import --source <dataset.csv> --format csv
rigwell eval import --source <dataset.csv> --format csv --name <name> --confirm <preview-hash>
rigwell eval datasets
rigwell eval run --dataset <dataset-id> --model <profile> --judge-model <judge-profile>
```

Canonical columns/JSON keys are `id`, `prompt`, `expectedOutput`, `output` and
`rubric`. Missing IDs are generated per row. Prompts and IDs must be valid and IDs
unique. Unknown fields, including commands, are discarded. Confirmation binds the
source contents, format and normalized mapping; changed data needs another preview.
Files are regular, unlinked, at most 16 MiB, with at most 10,000 rows; each text
field is at most 64 KiB. CSV handles quoted commas, newlines, BOM and CRLF.

Import only stores private data. A separate explicit CLI run creates disposable
empty repositories, with no imported shell grader. Runnable rows require an exact
trimmed `expectedOutput` comparison or a rubric with an explicit judge. `output`
is retained source data, not silently treated as an expected answer. Use ordinary
task folders when a trial needs coding fixtures or command checks.

The Stax option currently performs **explicitly mapped CSV conversion only**:
`--format stax --columns '{"prompt":"Input","expectedOutput":"Expected Output"}'`.
Those column names are an example, not a claim about the export schema. Compatibility
with a real Google Stax export is **unverified**. On 2026-11-15 the owner directed
skipping real-export verification, so an owner file is no longer awaited. The
preview, saved record and desktop option preserve that limitation.

## Export and limits

Desktop exports use a user-chosen local CSV or JSONL file; cancel writes nothing.
CSV text is quoted and spreadsheet formulas are protected again in the main
process. JSONL retains the result and separate judge evidence. No upload occurs.
Saved runs have opaque lookup IDs rather than caller-supplied paths. The viewer
rejects linked, oversized or malformed run files and reports skipped entries.
The run reader is capped at 64 MiB per file; desktop exports at 16 MiB. Public
transcripts omit attachments and hidden reasoning and have the existing 10 MiB
sharing limit. Failed, historical and external-harness trials can lack transcripts;
that absence is recorded rather than reconstructed as observed evidence.

Acceptance uses fake providers/clients, temporary stores, the actual CLI and
headless production page/daemon. Real judge quality, actual Stax format and the
installed native save dialog are separate from that evidence.

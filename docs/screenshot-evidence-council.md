# Screenshot-grounded Council evidence

This change introduces one shared problem-evidence contract for the desktop Council
and cloud worker. It does not modify the database schema, the native overlay
geometry, the model roster, or the `PY`, `RR`, `CP`, `SL`, `SR` key bindings.

## Execution order

1. The original screenshot remains available to the existing image readers
   and the four independent solvers. The selected Settings `Code in` language
   governs first-stage code; explicit problem signatures override that default.
2. Independently vision-qualified judge seats are asked in parallel to copy
   literal example input/output pairs from the same original screenshot.
   This step NEVER asks a judge to invent or calculate an expected output.
3. Before constructing E2B assertions, the two independent readings must
   agree on an exact pair. Unsupported, contested and single-reader pairs are
   removed from the **authoritative** sample set. Known requirements remain
   available to independent, generated test harnesses. For text-only questions,
   typed examples keep their prior behavior.
4. A candidate may only win after the normal E2B execution gate, per-candidate
   adapter checks, and final Council selection. Judges also receive the original
   screenshots if their specific routes have verified vision.
5. The winning code is published before optional code upgrades or translated
   language ports. An improvement must pass E2B again and receive approval
   from ALL participating independent audit models, with consistent no-worse
   time and space bounds. No approval or no sandbox evidence means keep the
   original verified solution and its history.
6. Secondary languages still use independent E2B runs, and no background
   language result automatically changes the visible language or overlay dock.

## Safety and known limits

- Agreement by two readers is not proof that a screenshot was read correctly.
  It prevents single-model OCR from silently becoming an authoritative oracle.
- The source example parser accepts labelled input/output pairs only. Non-unique
  outputs, in-place mutations, linked lists and ambiguous interfaces still
  require separately verified, generated or property-based harnesses.
- Models without confirmed image capability are not sent screenshot bytes.
- No AI-authored expected output becomes a "supplied" test by consensus.
- Passing visible or generated E2B cases does not guarantee unknown hidden cases.
- CI runs offline regression suites. A live E2B smoke run requires the configured
  E2B credentials and real screenshots, and must be recorded separately.

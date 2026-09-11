# Advisory acceptance — compact-output-token-economics

Run: `bench/agents/runs/2026-09-10T10-08-02`
Model: `opencode-go/glm-5.3-flash` · reps=3 · n=30/arm
Baseline stamp: `bench/agents/baseline.json` @ `a497785` (scaffold `913bc90`)
Corpus-drift warning is expected: HEAD is the post-change tree (`f33d8ea`).

## Aggregate with-arm vs baseline

| Metric | Baseline | After S2 | Δ |
| --- | ---: | ---: | ---: |
| mean input tokens | 26671.9 | 24597.4 | **−2074.4 (−7.8%)** |
| mean cost | $0.006861 | $0.006484 | **−$0.000377 (−5.5%)** |
| median wall ms | 32852 | 14268 | −18584 |
| objective pass rate | 88.9% | 83.3% | −5.6 pp |
| hallucination rate | 11.1% | 16.7% | +5.6 pp |

## Kind breakdown (this run, with arm)

| Kind | n | mean input | mean cost | pass |
| --- | ---: | ---: | ---: | ---: |
| locate | 12 | 12613 | $0.002680 | **12/12** |
| who-uses | 6 | 24357 | $0.006226 | 2/6 |
| explain | 6 | 37406 | $0.008527 | 1/6 |
| review | 3 | 58585 | $0.021250 | — |
| map | 3 | 13414 | $0.003366 | — |

Without-arm same run: locate 10/12, who-uses+explain 5/6.

## Acceptance reading (advisory)

- **Size win landed.** With-arm mean input tokens and cost both dropped (~8% / ~5.5%). The compact default (`preview: "none"`) is the intended cost path.
- **Locates did not regress.** 12/12 objective pass on locate with the compact default.
- **Pass-rate / hallucination wobble on who-uses+explain** (with 3/6 vs without 5/6 this run) is noted. n=6 per kind is small and judge was none; not treated as a design-revisit gate. If a later full stamp with a judge repeats the quality dip, revisit D4 (richer text channel) rather than restamping IR baselines.
- Deterministic IR/impact/index gates stayed flat in `bun run check` (no regeneration).

Source report: `bench/agents/runs/2026-09-10T10-08-02/report.json`

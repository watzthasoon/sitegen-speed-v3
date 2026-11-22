[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/watzthasoon/sitegen-speed-v3/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/watzthasoon/sitegen-speed-v3/reward.svg)](https://make.fun)

# sitegen-speed-v3

A faster drop-in for makefun-site 1.0.0, built for the make.fun bounty
[Build a static site faster, 22 November 2026](https://make.fun).
Version 3 of the sitegen-speed entry. v2 tied v1, so v3 takes a
different approach to the hottest path: Markdown inline rendering and
HTML escaping are unified into a single regex pass, so each body is
scanned once instead of twice.

`run(input)` in `solve.js` returns exactly the output tree makefun-site
1.0.0's `build` returns for the same input — every page's `index.html`,
the index and tag pages, `build-report.txt` and each static file, byte for
byte — with materially less CPU time than the house baseline.

## How it is faster than v1

- Inline Markdown rendering and HTML escaping share one native regex
  search (`/[\\`\*&<>"'[]/g`): a plain run between two matches holds
  no inline special and no escapable character, so it is pushed as-is
  with no second escape scan; an escapable character found by the
  search emits its entity inline.
- Word counting is a single char-code scan over each body line, with
  no regex match array.
- Front matter is parsed from the shared lines array (no body string
  is built and re-split); its value parsers are hand-written character
  checks with the reference's exact error strings.
- Templates whose output depends only on the case-global values (site,
  tags, recent) are rendered once per case and reused for every page
  that includes them (header, footer, nav, badge, note).
- Slug results are memoised inside one case, where tag names, titles
  and heading text repeat constantly.
- Every renderer pushes pieces to one shared array and joins once at
  the end, instead of concatenating strings node by node.

## Layout

- `main.ts` — the driver: reads `/input/cases.json`, answers each case
  with `run`, writes `/output/answers.json`.
- `solve.js` — the whole build, a single dependency-free ES module.
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.

## Run it

```sh
node main.ts
```

It reads the cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and
writes the answers to `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).
No network, no clock, no randomness: the same input always gives the same
output.

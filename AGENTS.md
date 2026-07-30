# AGENTS.md — car-bg-compositor

Thumbnail-synthesizer voor auto-listings: per map dealerfoto's één
gegenereerde catalogus-thumbnail (Gemini 3 Pro image), bewaakt door
dimensie-, identiteits-, lak- en proportie-poorten. De oude deterministische
compositing-pipeline staat onder de git-tag `composiet-pipeline-v1`.

## Git workflow (REQUIRED)

- Branch per task. Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `refactor/<slug>`, `docs/<slug>`. One branch = one discrete thing.
- Atomic commits, Conventional Commits format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Push to origin.
- Merge into `main` (PR if there's a CI / review gate, otherwise direct fast-forward).
- Delete the branch locally and on origin after merge.

Hard rules:
- Never commit directly to `main`.
- Never `--no-verify` to skip hooks unless explicitly asked.
- Never force-push to `main` or any shared branch.
- Never work in a dirty tree across unrelated tasks — stash or split first.

## Verification (REQUIRED before commit)

Dit is een CLI-beeldpipeline, geen frontend — browser-verify is hier niet
van toepassing. In plaats daarvan:

1. `pnpm typecheck` — moet clean zijn.
2. `pnpm test` — alle unit tests groen (geen API-calls nodig).
3. Bij wijzigingen aan de synthese, prompts of poorten: draai
   `pnpm start --synth <map>` op een echte auto-map en bekijk
   `out/<map>/thumbnail.jpg` vóór commit. Cache in `./cache/` maakt
   herhaald draaien goedkoop; een kopie van een bestaande map onder een
   nieuwe naam is een gratis-tot-goedkope rooktest.

Hard rules:
- Claim nooit "tests groen, ship it" voor een wijziging aan prompts of
  poorten zonder één echt gegenereerd beeld bekeken te hebben.
- **Een bestaande `out/<map>/thumbnail.jpg` is een goedgekeurd beeld en
  wordt nooit verwijderd of vervangen zonder expliciete opdracht van
  Yentl.** Hergenereren is non-deterministisch; de code weigert het al,
  omzeil dat niet.
- Versoepel de poorten (lakdrempels, proportie-check, dimensie-assert)
  nooit om "een run te laten slagen" — een afkeuring is informatie, geen
  bug. Drempels herijken mag alleen op gemeten data, met de meting in de
  config-comment.

## Secrets

Keys horen in `.env` (gitignored), nooit committen, nooit loggen:

- `GEMINI_NANO_BANANA_API_KEY` — verplicht voor de hele flow.
- `FAL_KEY` — alleen voor de lakmeting (fal-rmbg matte). Zonder key:
  `--matte rembg` draait lokaal en gratis.

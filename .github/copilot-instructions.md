# AGENTS.md — car-bg-compositor

Lokale test-tool voor achtergrondvervanging bij auto-verkoopfoto's (fal.ai
BiRefNet-masking + puur mathematische compositing met sharp). Doel: bewijzen
dat dit beter is dan generatieve modellen die velgen/badges hertekenen.

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

Dit is een CLI-beeldpipeline, geen frontend — browser-verify is hier niet van
toepassing. In plaats daarvan:

1. `pnpm typecheck` — moet clean zijn.
2. `pnpm test` — alle unit tests groen (geen API-calls nodig).
3. Bij wijzigingen aan masking/compositing/plaatsing: draai de pipeline op
   minstens één echt beeld (`pnpm start --file <foo>.jpg`) en bekijk
   `./out/` én `./debug/` (masker, bbox-overlay, `run.jsonl`) vóór commit.
   Cache in `./cache/` maakt herhaald draaien gratis.

Hard rules:
- Claim nooit "tests groen, ship it" voor een wijziging aan de beeldpipeline
  zonder één echte before/after in `./out/` bekeken te hebben.
- Geen generatieve stappen toevoegen aan de compositing-pad — de kernbelofte
  van deze tool is dat originele pixels (velgen, badges, koplampen) nooit
  hertekend worden. Masking/AI mag alleen selecteren, nooit genereren.

## Secrets

`FAL_KEY` hoort in `.env` (gitignored). Nooit committen, nooit loggen.

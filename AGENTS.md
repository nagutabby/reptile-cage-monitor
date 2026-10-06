# AGENTS.md

## デプロイ

- GitHub Actions（`.github/workflows/deploy.yml`）で自動デプロイされる。`main` に push すると、`validate`（サイトの check/build、インフラの build/test）通過後に `cdk deploy --all` で AWS へデプロイされる
- PR では `validate` のみ実行され、デプロイはされない
- 手動での `cdk deploy` は不要

## Git 運用

- `main` に直接 push してよい（PR は必須ではない）
- push はそのまま本番デプロイになるため、push 前にローカルで `pnpm run build` と `pnpm test`（サイトは `pnpm --dir frontend/site run check`）を通すこと

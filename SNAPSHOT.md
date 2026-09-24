# Standalone snapshot provenance

- Snapshot date: 2026-09-11
- Source folder: `/Users/venkatrayudu/Workspace/XAI workspace/wt-dias`
- Source branch: `feature/dias-dynamic-access-policy`
- Source commit before working-tree changes: `b81470dff07fe21cac837b956e8a2d381f5ab56e`
- Destination: `/Users/venkatrayudu/Workspace/XAI workspace/DIAS`

The source worktree contained the completed DIAS implementation as uncommitted
changes. The complete filesystem snapshot was copied, but its worktree `.git`
pointer was deliberately excluded. This folder was initialized as an independent
Git repository so edits here cannot change the source worktree.

The active adapter bytes were copied from the main checkout because model weight
files are intentionally excluded from Git. The retained adapter SHA-256 is:

```text
5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe
```

The `.venv-qwen-policy` environment was rebuilt inside this folder from the
pinned requirements rather than copied with stale absolute launch paths.

Local `.env`, Fabric identities, wallet state, synthetic agency-vault files,
installed Node dependencies, adapter bytes, and the MLX environment are present
for local operation but remain excluded from Git by `.gitignore`.

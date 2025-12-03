# ether-converter-review

This repository packages the current subgraph code and diagnostics for review by The Graph team.

**Contents**

- `src/` mapping and helper code
- `schema.graphql` GraphQL schema
- `subgraph.yaml` data source and mapping manifest
- `generated/` generated ABIs and types (optional)
- CI workflow to run `graph codegen` and `graph build`

## Purpose

This repo is intended for debugging and triage of a non-deterministic runtime error occurring at block `39207997`. It contains logs and deploy metadata in `diagnostics/` (if present).

## How to reproduce locally

1. Install dependencies:

```bash
npm ci
# or
yarn install
```

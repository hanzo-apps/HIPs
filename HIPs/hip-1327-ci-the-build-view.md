---
hip: 1327
title: CI — The Build View
author: Hanzo AI
type: Standards Track
category: Infrastructure
status: Draft
created: 2026-09-01
requires: HIP-0106, HIP-0139
capability: ci
---

# HIP-1327: CI — The Build View

## Abstract

`ci` answers one question per service — is what we wrote what is running? — and
answers it along one causal line rather than four opinions:

```
head ──build──▶ built ──pin──▶ declared ──reconcile──▶ running
```

It mounts the `/v1/ci` surface of the cloud binary. The surface itself lives in
`hanzo.ai/ci`, which is also deployed standalone as the dashboard at
ci.hanzo.ai; `apps/ci` in `hanzoai/cloud` mounts it and holds nothing but the
composition and the scope.

## Motivation

The delivery plane has three surfaces and had three answers to the same caller.
Measured with one identity — a valid `hanzo.id` bearer whose `orgs` claim
carries the reserved `admin` org:

| surface | before |
|---|---|
| `api.hanzo.ai/v1/deploy` | 200 |
| `api.hanzo.ai/v1/git` | 200 |
| `ci.hanzo.ai` | 401 |
| `cd.hanzo.ai/v1/applications` | 401 |

`ci` sat behind a gate that reads an `X-Org-Id` header written by admin-guard
and returns a bare 401 to a bearer — no `WWW-Authenticate`, no redirect, the
same answer a caller with no credential gets. So the one surface that models the
whole causal line was the one surface an operator holding the estate's own
identity could not read, and a broken line had to be reconstructed by hand from
registry listings and asset hashes.

A capability is also how a surface reaches the CLI: `hanzo <name>` is a
projection of the document this binary emits (HIP-0139 §1), so a surface that is
not a capability has no verbs, and every generated SDK has an empty class for it.

## Specification

### §1 The surface

Two operations, both reads, both scoped to the caller:

| operation | answers |
|---|---|
| `GET /v1/ci/runs` | recent builds — repo, branch, commit, and how each run ended |
| `GET /v1/ci/fleet` | one row per service: head, built, declared, running |

They are TYPED ops. An untyped route, or a wildcard subtree, publishes an
address and a tag and nothing a client can dispatch — what the composition test
calls the undispatchable remainder — so `hanzo ci` would have no verbs.

### §2 Scope: this binary decides, the surface filters

`hanzo.ai/ci` decides what a viewer may see from `X-Org-Id`, and treats its
absence as fatal. That is correct and is not weakened here: absence means the
request did not arrive through a gate.

`apps/ci` IS that gate. It writes the header from the attested caller and never
from anything the caller sent:

- `c.IsAdmin()` ⇒ the reserved `admin` org, which the surface reads as
  "sees everything";
- otherwise a validated principal's `namespace.Sanitize(c.Org())`, the same
  injective sanitizer the rest of the fleet keys tenants through, so two owners
  cannot collide onto one;
- anything else is refused.

A wrong answer here is not a wrong page: it is one org reading another's repo
names, branches and commits. `apps/ci/ci_test.go` holds the boundary.

### §3 Absence is loud, not fatal

Without `CI_GIT_TOKEN` the capability still mounts and every operation answers
503 with the reason — the rule `deploy` states for a missing kubeconfig.
Refusing to mount would take `make describe` down with it, and that has to emit
this app's document on a machine holding no secrets.

### §4 Schema names

The composed document's schema namespace is flat and global. `Service` appears
in fifty-three other app documents; two names differing only in case are worse
still, because every generator PascalCases them into one class. `hanzo.ai/ci`
therefore publishes `Artifact`, `Tip`, `Pipeline`, `Execution` and `Check` —
three of which are better names for what they hold than what they replaced.

## Limitations

The dashboard's own pages (`/`, `/runs`) stay on the standalone deployment.
Only the two API operations are mounted here, because only they have a shape a
client can generate against.

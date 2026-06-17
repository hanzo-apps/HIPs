---
hip: 0113
title: Multi-Tenant Security Core Standard
author: Hanzo AI Team
type: Standards Track
category: Infrastructure
status: Draft
created: 2026-06-16
requires: HIP-0026, HIP-0027, HIP-0044, HIP-0068, HIP-0111, HIP-0112, HIP-0413, HIP-0497
---

# HIP-113: Multi-Tenant Security Core Standard

## Abstract

Hanzo's security core is one architecture — **IAM → KMS → MPC/HSM** — that is *multi-tenant-aware*. Identity (who you are), key-management (what you may touch), and custody (the key itself, threshold-split and never whole) compose into one tenant-aware spine. Because the core is multi-tenant-aware it can be operated **either way**: as a single shared instance serving many tenants, or self-hosted per deployment. Both are first-class — multi-tenancy is a property of the core; the deployment topology is an orthogonal operator choice.

This HIP names the spine, the tenant-isolation contract, and **Hanzo Cloud HSM** as the product surface over the custody layer. HIP-0026/0027 specify the IAM and KMS servers; HIP-0111 the IAM client contract; HIP-0497/0413 the MPC service and CRD.

## Motivation

Identity, secrets, and key custody are one concern braided across three layers; specifying them separately has let them drift — which issuer signed a token, where a key actually lives, who counts as a global admin. This HIP states the one spine and one isolation contract so each layer sits in exactly one place and does one job.

A security core must serve more than one tenant without leaking across them, and it must do so whether one operator runs it for many tenants or a deployment runs its own. The custody primitive is **MPC, not a single-tenant key store**, for one reason: with threshold custody no single node or party ever reconstructs a whole key — so a *shared* instance need not mean *centralized trust*. That property is what makes "either way" real: a tenant that needs custody it does not have to trust to a single operator is served by the same core, under the same contract, as one that is happy to be hosted.

## Specification

### The custody spine — three layers, one job each

```
            ┌─────────────────────────────────────────────┐
  WHO       │  IAM   (HIP-0026 / HIP-0111)                 │  multi-tenant OIDC provider
  are you?  │  one issuer per instance · orgs = tenants    │  e.g. iam.hanzo.ai
            └───────────────────┬─────────────────────────┘
                                │  validated identity  (org, sub, scopes — HIP-0112)
                                ▼
            ┌─────────────────────────────────────────────┐
  MAY you   │  KMS   (HIP-0027)                            │  multi-tenant secret/policy plane
  touch it? │  per-tenant namespaces · IAM-gated           │  e.g. kms.hanzo.ai
            └───────────────────┬─────────────────────────┘
                                │  key op by reference  (Sign/Derive/Wrap — never raw material)
                                ▼
            ┌─────────────────────────────────────────────┐
  the KEY   │  MPC + HSM   (HIP-0497 / HIP-0413)           │  custody plane
  itself    │  t-of-n threshold shares · optional HSM root │  mpcd + threshold library
            └─────────────────────────────────────────────┘
```

IAM says *who*. KMS says *may-they*. MPC/HSM *holds the key* — as shares that are never assembled. An app or backend service holds a token, a policy decision, and a key *reference* — never raw key material.

### Multi-tenancy is a property of the core; deployment is orthogonal

A **tenant** is expressed identically regardless of topology:

- an **organization** in IAM (HIP-0111),
- a **secret namespace** in KMS,
- a **key-set** in the MPC quorum.

A tenant is *qualified by org*, not *baked into a separate build* — values, not places. The same core software serves any number of tenants.

**Two operating topologies, both first-class:**

1. **Shared instance** — one operator runs one core; many tenants are organizations within it. Login UX may be white-labeled per host while the issuer, JWKS, and token contract are shared.
2. **Self-hosted instance** — a deployment runs its own core (its own issuer, KMS, quorum). Same software, same contract; it simply serves its own tenant(s).

Nothing in the contract changes between the two — only how many tenants an instance serves and who operates it. Because tenancy is org-scoped (not build-scoped), a deployment can start self-hosted and consolidate into a shared instance, or split back out, without an identity or key-format migration.

### `admin` organization — the control plane

The **`admin` organization is the sole global-admin scope** of an instance (`conf.AdminOrg`; `IsGlobalAdmin == user.Owner == admin`). It is the internal control plane and is never an end-customer surface; tenant orgs may administer only their own apps. A tenant-org session that reaches a raw admin surface is redirected to its own console.

### Layer 1 — Identity (IAM) — HIP-0026 / HIP-0111

One multi-tenant OIDC provider per instance, multi-tenant by organization, issuing a single `iss` for that instance. Tenancy travels downstream as the gateway-injected org claim (HIP-0112); backends trust it only from the gateway hop. Login UX is white-labeled per host; the issuer, JWKS, and token contract are single and shared within the instance.

### Layer 2 — Authorization & secrets (KMS) — HIP-0027

One multi-tenant KMS per instance. Every secret lives in a per-tenant namespace; access is authorized from the validated token's org, never a client-supplied header. For **managed keys**, KMS holds *policy and a key reference only* — it does not hold, cache, or proxy raw private-key material.

### Layer 3 — Custody (MPC + HSM) — HIP-0497 / HIP-0413

One MPC quorum per instance (`mpcd` orchestrating the threshold library: CGGMP21/`cmp`, FROST, DOERNER, the PQ lanes, BLS/ML-DSA/SLH-DSA). A managed key exists only as `t`-of-`n` shares, optionally HSM-rooted (`pkg/hsm`). `Sign`/`Derive`/`Wrap` execute inside the quorum; the whole key is never materialized. Tenants get isolated key-sets and, when required, isolated HSM partitions.

### The KMS → MPC contract (control plane vs. custody plane)

KMS is the *control* plane; MPC is the *custody* plane. They compose over one internal contract:

```
KMS                                            mpcd
 │  CreateKey(tenant, type, policy)  ─────────▶ │  generates t-of-n shares; returns keyRef ONLY
 │  Sign(tenant, keyRef, digest)     ─────────▶ │  quorum signs; returns signature
 │  Derive(tenant, keyRef, path)     ─────────▶ │  derives child pubkey/ref
 │  Wrap/Unwrap(tenant, keyRef, blob)─────────▶ │  envelope op inside the quorum
 │                                              │
 └── stores: keyRef + policy + audit            └── holds: the shares (never returns material)
```

No interface returns raw private-key bytes. KMS can be fully compromised without yielding a managed key — the shares are not there to steal.

### Hanzo Cloud HSM — the product surface

The custody plane is exposed as **Hanzo Cloud HSM**: one API surface at `api.<host>/v1/kms`, gateway-fronted (HIP-0044), tenant-scoped from the validated token. Software-MPC custody by default (no single point of custody); optional FIPS-140-3 HSM root for regulated tenants. The same surface serves any tenant — first-party or external customer. This is the productization of Layer 3.

### Deployment topology — HIP-0112

A shared core runs on a cluster (e.g. `hanzo-k8s`) and serves its tenants; a self-hosted core runs on the deploying operator's own cluster. Either way the source repositories stay separate and independently versioned (`hanzoai/iam`, the KMS repo, `mpcd`, the threshold library) and are *composed* by the platform — not collapsed into a monorepo.

## Tenancy isolation rules (normative)

- A managed key **MUST** exist only as MPC shares; no layer above the quorum may hold whole key material.
- Every secret and key **MUST** carry a tenant (org) and be isolated per tenant in KMS namespaces and MPC key-sets.
- Tenant identity **MUST** derive from the validated token's org at the gateway; downstream client-supplied tenant headers **MUST NOT** be trusted.
- The `admin` organization **MUST** be the only global-admin scope of an instance; raw IAM/KMS admin surfaces **MUST** be gated to it.
- Tenants with a hardware-custody or jurisdiction requirement **SHOULD** be assigned an isolated HSM partition and/or a quorum whose node placement satisfies that requirement.

## Backwards Compatibility

No token, app-registration, or `@hanzo/iam` integration changes. HIP-0111 and HIP-0112 describe an instance's client contract and request path; this HIP adds the tenancy and custody model and states that an instance **MAY serve one tenant (self-hosted) or many (shared)** with no contract change. It deprecates neither topology.

## Open Questions

1. **Per-tenant key-sets vs. shared-with-scoping** in the MPC quorum (default: per-tenant key-sets).
2. **HSM rooting**: software-MPC only vs. hardware-anchored; cloud-HSM vendor vs. operator-run HSM.
3. **Threshold-node placement** for tenants that carry a jurisdiction guarantee — the concrete meaning of "no single jurisdiction reconstructs a key."
4. **Revocation & rotation** across a live quorum (re-share vs. re-key).
5. **The KMS→MPC wire protocol** — ZAP-native vs. gRPC.

## References

- HIP-0026 — Hanzo IAM (server)
- HIP-0027 — Hanzo KMS
- HIP-0044 — Hanzo Gateway
- HIP-0068 — Hanzo Ingress
- HIP-0111 — Hanzo IAM Authentication Standard
- HIP-0112 — Cloud Infrastructure Topology Standard
- HIP-0413 — MPC CRD
- HIP-0497 — hanzo-mpc

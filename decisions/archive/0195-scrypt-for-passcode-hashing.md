---
number: 195
title: Use crypto.scrypt for Passcode Hashing
status: draft
created: 2026-03-24
spec: remote-passcode
superseded-by: null
---

# 195. Use crypto.scrypt for Passcode Hashing

## Status

Draft (auto-extracted from spec: remote-passcode)

## Context

The Remote Access Passcode feature needs to hash 6-digit numeric PINs before storing them in `~/.dork/config.json`. Three OWASP-recognized algorithms were evaluated: argon2id (gold standard), bcrypt (legacy), and scrypt (acceptable). The PIN has inherently low entropy (10^6 combinations), so the hash algorithm's primary role is preventing trivial offline recovery if the config file is ever exposed — the real brute-force defense is rate limiting at the API layer.

## Decision

Use Node.js built-in `crypto.scrypt` with a 32-byte random salt and 64-byte key length. Store both hash and salt as hex strings. Always compare using `crypto.timingSafeEqual()`.

## Consequences

### Positive

- Zero additional dependencies — `crypto` is a Node.js built-in
- OWASP-acceptable, memory-hard algorithm that resists GPU attacks
- No native binary compilation needed (unlike argon2 which requires platform-specific builds)
- Timing-safe comparison prevents side-channel attacks

### Negative

- Less studied than argon2id in academic literature
- Cannot tune memory cost as precisely as argon2id (though this is irrelevant for a 6-digit PIN)

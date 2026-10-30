# Frozen pre-registration registry reader

`security-registry-v1.original.ts.txt` is public source code copied from
`packages/server/src/security/security-registry.ts` at Git commit
`fd40ade27acdec54c4e5ba4dd8ddc5ac4e061a0f`, normalized to LF with a final newline.
It is not an instance, database, configuration or security material.

SHA-256: `ca5c64f8b3c5559cefffc0e11dfa2aa3240f96775b90f4f2a4e6f532fb3bdf0c`.

Storage compatibility tests copy this exact reader into a new temporary module,
alongside the unchanged local key-provider, Windows-protector, network-policy and
error modules. They use freshly generated synthetic directories/keys, first
confirm the reader can open V1, then confirm it rejects V2 and journaled V2
recovery without altering protected state. Do not update the fixture to make an
old reader accept new fields. This checks the previous registry decoder; it is
not a packaged old-release installation or a downgrade qualification.

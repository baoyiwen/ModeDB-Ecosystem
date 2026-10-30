# Synthetic registration TLS fixture

These certificate and private-key files are public test material for isolated tests only.
Never use them for an installed ModelDB instance or put them into an OS/browser trust store.

The self-signed certificate covers only `modeldb-a.example.test`, is valid from
2026-10-20 through 2036-10-20, and was generated using .NET CertificateRequest and
an in-memory RSA key. Generation did not open or modify a certificate store.

Tests bind a random port on `127.0.0.1` and use a request-local DNS lookup for
the `.test` name. Trust is supplied explicitly to that request; normal TLS chain,
hostname and validity checks remain enabled. No real configuration, certificate,
key, Vault, business database, external DNS or 9091 service is accessed.

The trusted self-signed fixture tests trust enforcement, not a real public-CA deployment.

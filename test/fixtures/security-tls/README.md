# Local TLS test fixture

The certificate and private key in this directory are public test material, generated only for isolated loopback tests. They must never be used by an installed ModelDB instance. The self-signed certificate covers `localhost`, `127.0.0.1` and `::1`, and is valid from 2026-10-20 to 2036-10-17.

Tests use a child process with `NODE_EXTRA_CA_CERTS` pointing at this certificate. They do not install a system root or disable certificate verification. Untrusted roots and incorrect certificate names are tested separately. No OpenSSL installation is required to run the tests.

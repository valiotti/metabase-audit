# Security

The kit runs on your machine and talks only to the Metabase URL you give it. The API key is read from the environment, sent as a request header, never written to disk, and masked in error messages. The one write path is `archive --apply`, which is off by default and records an undo file before touching anything.

If you find a way for the key or basic-auth credentials to reach a file, a log line, stdout or stderr, or a way to archive without `--apply`, please do not open a public issue. Email nick@valiotti.com with the steps to reproduce. You will get an answer within two business days, and a fix or a mitigation before any public disclosure.

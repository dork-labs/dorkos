### Security

- On macOS, DorkOS keeps the key that protects your saved secrets in a file (`~/.dork/host.key`) that any program running as you can read, including your agents' shell commands. Moving it into the Keychain is planned, after two hardening steps. The Permissions, Securing your instance and Threat model guides now say so (DOR-3053).
